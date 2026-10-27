# 第 03 章：服務間通訊

> **上一章**：[第 02 章](02-splitting-the-database.md)讓資料庫真的分開了 —— 庫存服務的庫只有庫存的表，`ServiceDatabaseTest` 守著；跨庫的 JOIN 換成對帳；建立商品改成一個事件。但兩個服務之間的那條線還是臨時的：`RemoteInventory` 把 13 個 Java 方法原封不動搬到 HTTP 上（`POST /lab/d02/inventory/{op}`），沒有版本、沒有認證、沒有冪等鍵；事件在兩個服務之間，是實驗程式自己讀 outbox、自己交給另一個服務的消費者（2.13）。
>
> **這一章**：處理那條線。先把它放到三種真的會發生的情況裡看它怎麼壞（事件真的走 broker、回應在回程上丟了、有人直接打它）；然後一條一條決定哪些呼叫該同步、哪些該是事件；重新設計介面（16 個操作 → 12 支端點，`@HttpExchange` 宣告的客戶端）；讓每一個寫入都可以安全地再送一次；加上服務之間的認證；讓「同一個 jar、兩個角色」各自只做自己的事；最後用 Pact 守住它，並且示範一次「改了一個欄位的名字，全部的測試都綠」是怎麼被抓到的。
>
> **你手上會有**：從 `d02` 開出來的分支 `d03`。正式程式碼：`shop.deployment.role`（`monolith` / `order-service` / `inventory-service`）與兩個 profile；庫存服務的 `/internal/inventory/v1/**`（`InventoryServiceController` → `InventoryService`）；訂單服務的 `RemoteInventoryApi`（`@HttpExchange` 的 `InventoryClient`，沒有回應時用同一個冪等鍵再送一次）；服務之間的 token（`ServiceTokens`、`InternalApiSecurity`）；`Inbox`（`processed_messages` 給 HTTP 命令用）；熱點閘門的「同一個鍵只減一次」；`InventoryApi` 拿掉 `initialize`、`holdHot` 併進 `reserve`；消費者只收自己擁有的模組。`src/test` 多一個 `dist03` 套件（四個實驗）、五個預設的測試類別（含 Pact 的呼叫端），以及 failsafe 那一段的兩個 Pact 提供端驗證。265 個測試，加上 30 個契約驗證。

---

## 3.1 學習目標

完成本章後，你應該可以：

- 說出第 02 章那條線在三種情況下各怎麼壞：兩個服務都收同一個佇列、回應在回程上丟了、有人直接打它 —— 而且用實驗量出來（3.2）。
- 用四個問題，一條一條決定跨服務的互動該同步還是非同步；說出 gRPC 在什麼情況下值得（3.3）。
- 把一組「搬到 HTTP 上的 Java 方法」重新設計成服務的介面：哪些合併、哪些消失、哪些空呼叫要在呼叫端擋掉；用 `@HttpExchange` 宣告客戶端；把對方的錯誤翻譯回自己的例外 —— 而且知道對方的 401 不是使用者的 401（3.4）。
- 讓每一個遠端的寫入都可以安全地再送一次：哪些本來就冪等、哪些用 `processed_messages`、哪些用 Redis 的標記；呼叫端只在「沒有回應」時再送（3.5）。
- 加上服務之間的認證：另一把金鑰、`aud`、`sub`、誰可以呼叫誰（3.6）。
- 讓同一個 jar 部署成兩個角色時，每一個服務只收自己的佇列、只提供自己的 API；說出為什麼佇列的宣告與 relay 不該跟著濾（3.7）。
- 用 Pact 寫呼叫端的契約、在提供端驗證；說出同一個 repo 為什麼還需要它，以及「線上那一版的契約」守的是什麼（3.8）。

---

## 3.2 先看見痛：第 02 章的那條線，放到三種真的會發生的情況 ★★★

第 02 章的實驗都在「理想的線」上跑：事件由實驗程式自己交付、回應一定會回來、只有實驗程式會打那條線。這一節把三個假設各拿掉一個。程式碼是第 02 章的 —— 這個實驗是 `d03` 的第一個 commit，`src/main` 還沒有動。

### 3.2.0 開分支

```bash
git switch -c d03            # 從 d02
```

### 3.2.1 實驗怎麼做（D1）

還是第 02 章的支架：兩個服務、一個 JVM、誠實的兩個庫（`Split`，2.4.6）。多四個小工具，都在 `src/test/java/com/example/shop/dist03/`：

| 工具 | 做什麼 |
|---|---|
| `Broker` | compose 的那一台 RabbitMQ 另開一個 vhost（`shop_d03`），每次實驗刪掉重建 —— 佇列、交換器都在 vhost 裡，跟第 12 站的 `shop.*`（預設的 `/`）互不相干 |
| `Flow` | 事件真的走 broker 的時候，「做完了沒」只能從外面看：兩個服務的 outbox 都送完、每一個佇列（含重試佇列）都沒有 ready 的訊息、兩個服務的消費者計數 1 秒內沒有再變 |
| `LostResponse` | 庫存服務照常處理、commit，回應卻晚 N 毫秒才送出 —— 呼叫端的 read timeout 比 N 短，它看到的是逾時 |
| `Shop` | 使用者的動作，全部走 HTTP、打訂單服務 |

`LostResponse` 的關鍵是「先做完、再延後」：

```java
                Arm arm = ARMED.stream().filter(a -> (a.method() == null || a.method().equals(req.getMethod()))
                        && req.getRequestURI().contains(a.path()) && a.times().getAndDecrement() > 0).findFirst().orElse(null);
                if (arm == null) { chain.doFilter(req, res); return; }
                ContentCachingResponseWrapper held = new ContentCachingResponseWrapper(res);
                chain.doFilter(req, held);                                   // controller 執行完、交易 commit 了
                HITS.add(new Hit(req.getMethod(), req.getRequestURI(), held.getStatus()));
                try { Thread.sleep(arm.delayMs()); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                try { held.copyBodyToResponse(); } catch (IOException gone) { /* 呼叫端早就斷了 */ }
```

`ContentCachingResponseWrapper` 不是裝飾：Spring 的 Jackson 轉換器寫完 JSON 之後會 `flush()`（`AbstractGenericHttpMessageConverter.write()` 的最後一步），不包起來的話，回應在 controller 回傳的那一刻就送出去了，後面的 `sleep` 什麼都延後不了。（`method` 那個條件是 3.5.6 才加的：D1 只看路徑。）

`Flow` 的計數用第 12 站本來就有的指標（第 07 章的重試、死信計數器，9.10 的消費者延遲）—— 每一個服務有自己的 `MeterRegistry`，所以「哪一個服務處理了幾次」直接讀得到：

```java
    public static Map<String, Tally> tally(ConfigurableApplicationContext ctx) {
        MeterRegistry r = ctx.getBean(MeterRegistry.class);
        Map<String, Tally> m = new TreeMap<>();
        for (EventHandler h : ctx.getBeansOfType(EventHandler.class).values()) {
            Timer t = r.find("shop.events.lag").tag("consumer", h.consumer()).timer();
            m.put(h.consumer(), new Tally(t == null ? 0 : t.count(), count(r, "shop.events.retried", h.consumer()), count(r, "shop.events.dead_lettered", h.consumer())));
        }
        return m;
    }
```

（`shop.events.lag` 是 Timer，只在處理成功時記一筆；重試與死信是兩個計數器。）

```bash
mvn test -Pexperiments -Dtest=D1TheLineTest
```

### 3.2.2 ① 同一個 jar 部署兩次：兩個服務搶同一個佇列

第 12 站的 `RabbitConsumers` 替**每一個** `EventHandler` 開一個 container，`shop.messaging.consumers-enabled` 預設是 `true`。同一個 jar 部署成兩個服務，兩個服務各自替 6 個消費者開 container —— 第 02 章的實驗把兩邊的消費者都關掉了，所以沒看到。這一個實驗把它們打開，兩個服務都照第 12 站的預設：relay 與消費者都開著，連到同一個 vhost。

工作負載：賣家建立 20 個商品（`product.created`），把其中一個標成熱點，40 位買家各買 1 件（`order.placed` → 通知、熱點落帳），前 20 位取消（`order.cancelled` → 通知；庫存服務釋放預留 → `inventory.stock-returned` → 熱點閘門加回去）。

```
═══ 3.2 ① 同一個 jar 部署兩次，兩個服務都打開 relay 與消費者（load { 3.23 3.06 3.00 }）═══
  兩個服務各有 6 個消費者（EventHandler）；每一個佇列的消費者數：{shop.inventory.hot-settlement=4, shop.inventory.hot-stock-return=4, shop.inventory.product-created=4, shop.notification.order-events=4, shop.ordering.stock-shortage=4, shop.payment.refunds=4}
  建立 20 個商品（期初 100 件）→ 1,566 ms 後安靜下來；庫存服務的庫裡有庫存列的：20／20
  熱點商品 1：40 位買家各買 1 件，前 20 位取消 → 1,642 ms 後安靜下來
  消費者                         │ 訂單服務：成功 / 失敗後重試 / 送進死信 │ 庫存服務：成功 / 失敗後重試 / 送進死信 │ 死信佇列
  inventory.hot-settlement       │        0 /         38 /        0 │       40 /          0 /        0 │     0
  inventory.hot-stock-return     │       10 /          0 /        0 │       10 /          0 /        0 │     0
  inventory.product-created      │        0 /         18 /        0 │       20 /          0 /        0 │     0
  notification.order-events      │       59 /          0 /        0 │        0 /         59 /        1 │     1
  ordering.stock-shortage        │        0 /          0 /        0 │        0 /          0 /        0 │     0
  payment.refunds                │        0 /          0 /        0 │        0 /          0 /        0 │     0
  熱點落帳：沒有取消的 20 張，計入 reserved 的 20 張、還沒計入的 0 張
  熱點閘門（庫存服務的 Redis）stock:1 = 70；MySQL 算出來應該是 80
  訂單服務自己的 Redis 裡有沒有 stock:1：沒有
  通知（訂單服務的庫）：應該 60 封（成立 40、取消 20），SENT 59 封、FAILED 0 封
  （結束時 load { 3.85 3.22 3.06 }）
```

逐行讀：

- **每一個佇列 4 個消費者**：兩個服務各兩個（`concurrency()` 預設 2，第 12 站 7.5.1）。RabbitMQ 把一個佇列的訊息**輪流**交給它的消費者 —— 大約一半到訂單服務、一半到庫存服務。
- **`inventory.product-created`：訂單服務失敗 18 次，庫存服務成功 20 次**。訂單服務收到 `product.created`，呼叫它自己的 `JdbcInventoryService.initialize()`，對著它自己的庫 —— 那裡沒有 `inventory` 這張表（第 02 章的誠實的庫）。失敗、送進重試佇列（第 12 站 7.5.3），幾百毫秒後回到同一個佇列，再輪一次。20 個商品最後都有庫存列，代價是 18 次失敗與延遲。
- **`inventory.hot-settlement`：38 次失敗**，同一個道理。
- **`notification.order-events`：庫存服務失敗 59 次，1 則重試用完、進了死信**。通知的表在訂單服務的庫裡。一則訊息連續 6 次（第一次加 5 次重試）都輪到錯的那一邊，就進死信 —— 在死信之前，`NotificationHandler.onDeadLetter()` 要把那一封標成 `FAILED`，它**也在庫存服務裡執行**，也找不到表：

```
2026-10-15T11:24:17.435+08:00 ERROR 48543 --- [shop] [a.Spring.bean-2] [6ad0475ec39e6d1ac86432ab03bf7b71-edb4fa3ea1ec2587] c.e.s.s.m.internal.RabbitConsumers       : onDeadLetter 失敗：org.springframework.jdbc.BadSqlGrammarException: PreparedStatementCallback; bad SQL grammar [UPDATE notifications SET status = 'FAILED' WHERE dedup_key = ? AND status = 'PENDING']
```

  所以訂單服務的庫裡「SENT 59 封、FAILED 0 封」—— 第 60 封不是失敗，是**不存在**。它只在死信佇列裡。
- **`inventory.hot-stock-return`：兩邊各成功 10 次，0 次失敗**。這是最糟的一行。「把熱點閘門加回去」是對 Redis 的 `INCRBY`（第 12 站 7.6.5），訂單服務收到之後，加到**它自己的** Redis（實驗裡是 10 號 database）—— 那裡沒有 `stock:1` 這個 key，`RETURN` 腳本只加「存在的」key（6.5.3），什麼都沒做，回傳成功、ack。**沒有錯誤、沒有重試、沒有死信**。熱點閘門少了 10 件：Redis 70、MySQL 算出來 80。這 10 件要等熱點對帳（第 12 站 6.6，每分鐘、連續兩輪看到才修）才回來；在那之前，賣不出去。

測試設定的重試間隔是 100 ms 起跳（第 12 站 7.12.1：5 級，100、200、400、800、1,600 ms），正式環境是 1、2、4、8、16 秒 —— 每一次重試要等的時間是這裡的十倍，「多久之後才安靜下來」也跟著拉長。

**同樣的實驗跑了三次**（每次都重建兩個庫與 vhost）：

| | 第一次 | 第二次 | 第三次 |
|---|---|---|---|
| `product-created`：訂單服務失敗 / 庫存服務成功 | 18 / 20 | 18 / 20 | 18 / 20 |
| `hot-settlement`：訂單服務失敗 / 庫存服務成功 | 38 / 40 | 38 / 40 | 38 / 40 |
| `hot-stock-return`：訂單服務「成功」/ 庫存服務成功 | 10 / 10 | 10 / 10 | 10 / 10 |
| `notification`：庫存服務失敗 / 死信 | 59 / 1 | 60 / 0 | 60 / 0 |
| 熱點閘門：Redis / MySQL | 70 / 80 | 70 / 80 | 70 / 80 |

⚠️ 這不是丟銅板。如果每一次投遞是丟銅板，`hot-stock-return` 的 20 則會是 10 左右、每次不一樣。三次都剛好 10／10，失敗次數也一樣：**RabbitMQ 是輪流分（round-robin），不是隨機分**。只有「哪一則剛好連續 6 次輪到錯的那一邊」會因為時間的細微差別而不同（第一次 1 則，後兩次 0 則）。所以這不是一個「偶爾會出事」的問題：**每一次部署都會出事，而且出事的比例是固定的一半**。

### 3.2.3 ② 回應遺失：使用者再按一次

第 00 章 0.2.2 ② 量過一次：庫存服務 commit 之後慢 1.5 秒才回應、訂單服務只等 1 秒 —— 同一個鍵重送，20 張訂單成立，`reserved` 卻多了 120 件，其中 60 件是孤兒。這一次把四種寫入都試一遍：庫存服務照常處理、commit，回應延後 11 秒才送出；訂單服務照第 02 章的設定等 10 秒（`RemoteInventory` 的 read timeout）。使用者看到失敗之後，做一個真的使用者會做的事 —— 再按一次。

```
═══ 3.2 ② 回應遺失：庫存服務 commit 之後 11 秒才回應，訂單服務等 10 秒（load { 3.76 3.24 3.06 }）═══
  補貨 10 件       │ 第一次 500（10,164 ms）│ 賣家再按一次 200 │ on_hand +20（應該 +10）│ RESTOCK 帳 2 筆
  下單（一般）     │ 第一次 500（10,144 ms）│ 同一個鍵再送一次 201 │ 這位買家的訂單 1 張 │ reserved +2（應該 +1）│ 沒有訂單的預留 1 筆
  下單（熱點）     │ 第一次 500（10,017 ms）│ 同一個鍵再送一次 201 │ 這位買家的訂單 1 張 │ 閘門 -2（應該 −1）│ MySQL 算出來的閘門 9999999、Redis 9999998
  取消（未付款）   │ 第一次 500（10,040 ms）│ 那之後：訂單 PENDING_PAYMENT／預留 RELEASED │ 買家再按一次 200 │ 最後：訂單 CANCELLED／預留 RELEASED
  庫存服務延後送出的回應：[Hit[method=POST, path=/lab/d02/inventory/restock, status=200], Hit[method=POST, path=/lab/d02/inventory/reserve, status=200], Hit[method=POST, path=/lab/d02/inventory/gate-hot, status=200], Hit[method=POST, path=/lab/d02/inventory/release, status=200]]
```

四種寫入，四種結果：

| | 第一次發生了什麼 | 再按一次 | 結果 |
|---|---|---|---|
| 補貨 | 庫存服務補了 10 件、commit；訂單服務（catalog 的賣家 API）等不到回應 → 500 | 賣家看到失敗，再補一次 10 件 → 又補了 10 件 | **+20**：帳上兩筆 RESTOCK |
| 下單 | 庫存服務預留了、commit；訂單服務的下單交易逾時、rollback（訂單不存在）→ 500，冪等鍵也放掉了（US-ORD-1a AC-4：失敗的結果不快取） | 同一個 `Idempotency-Key` 再送 → 新的訂單、新的 orderId → 再預留一次 | 1 張訂單、**2 筆預留**；第一筆的 orderId 不存在 —— 第 02 章的對帳（X-1）在 5 分鐘後才會放掉它 |
| 熱點下單 | 庫存服務的 Redis 閘門減了 1；`gateHot` 在 `try` 之前丟例外 → 不會 `returnHot` → 500 | 同一個鍵再送 → 閘門再減 1 → 這一次成立 | 閘門 **−2**，MySQL 只少 1：少賣 1 件，直到熱點對帳 |
| 取消 | 庫存服務釋放了、commit；訂單的交易 rollback → 500，訂單還是待付款、預留已經釋放 | 再按一次取消 → `release()` 什麼都不做（已經是 `RELEASED`）→ 訂單取消 | **收斂** |

最後一列是第 02 章 2.5.3 的「重做同一件事會收斂」—— `release()` 本來就只處理 `HELD`、`CONFIRMED`。前三列不會：同一個動作做第二次，效果就是兩次。

呼叫端唯一知道的是「我沒有拿到回應」。它不知道對方做了沒有 —— 做了、回應丟了，跟沒做、請求丟了，從這一邊看起來一模一樣。**能做的只有再送一次，而再送一次安不安全，決定在另一邊。**

### 3.2.4 ③ 沒有認證：直接打那條線

第 02 章的兩條 `/lab/**` 都是 `permitAll`（2.4.6）。誰連得到庫存服務，誰就能呼叫它的每一個操作：

```
═══ 3.2 ③ 沒有認證：直接打庫存服務的那條線（load { 3.16 3.17 3.05 }）═══
  買家 7200001 下單 20261015-815002（orderId 1）：預留 HELD；商品 9000011 可售 9999999
  沒有任何 token，POST /lab/d02/inventory/release {"orderId":1} → 200
    之後：預留 RELEASED；可售 10000000（+1）；訂單 PENDING_PAYMENT
    買家付款 → 200；賣家撿貨 → 200；出貨 → 409 {"type":"/problems/invalid-state","title":"目前的狀態不允許這個動作","status":409,"detail":"這張訂單有商品庫存不足，即將取消，不能出貨","instance":"/api/seller/orders/20261015-815002/ship","tra…
    最後：訂單 PICKING；預留 RELEASED；可售 10000000
  沒有任何 token，POST /lab/d02/inventory/restock 100 萬件 → 200；on_hand 10000000 → 11000000
  沒有任何 token，POST /lab/d02/inventory/reservations-of（orderId 1～50）→ 200：200 {"rows":[{"id":1,"orderId":1,"productId":9000011,"quantity":1,"status":"RELEASED"}]}
  帶買家的 JWT 打同一支 → 200（這條鏈 permitAll：token 有沒有、是誰的，都一樣）
  （結束時 load { 2.99 3.13 3.04 }）
```

一個沒有任何 token 的請求，釋放了一張別人的訂單的預留。之後：

- 那 1 件回到可售量裡（9,999,999 → 10,000,000）—— 可以再賣給別人。
- 買家付款：`confirm()` 只改 `HELD` 的預留，一列都沒改到，**也沒有錯誤** → 200。
- 賣家出貨：`consume()` 看到有一筆 `RELEASED` 的預留 → 409「即將取消」（第 12 站 7.6.4 的那個檢查，本來是給熱點落帳失敗用的）。**但不會有人取消它** —— 那個取消在等一個 `inventory.hot-settlement-failed` 事件，而這次沒有人發它。訂單停在撿貨中，跟第 02 章 2.5.3 的 S3' 同一個下場。
- 補貨 100 萬件、查任意 orderId 的預留（誰買了什麼），都是 200。帶一個買家的 JWT 也一樣：那條鏈不看 token。

「庫存服務只在叢集裡面，外面連不到」是一層保護，不是這一層的替代品：同一個網路裡的任何一個行程、一個被打穿的服務、一個設錯的 ingress，都在「裡面」。

### 3.2.5 三件事的共同點

| | 第 02 章的線假設了什麼 | 這一章 |
|---|---|---|
| ① | 只有一個行程在收訊息（第 12 站的單體） | 3.7：每一個服務只收自己擁有的模組 |
| ② | 每一次呼叫都會拿到回應 | 3.5：每一個寫入都可以安全地再送一次；呼叫端沒有回應才再送 |
| ③ | 只有自己人會打它 | 3.6：服務之間的 token |

三個假設在一個行程裡都是真的：方法呼叫一定會回來（或丟例外）、Spring 的 bean 只有一份、別人摸不到你的方法。**把方法搬到網路上，這三件事沒有一件會自己跟過去。**

另外兩件事，D1 沒有量，但這一章也要處理：介面的形狀（3.4）、以及兩邊的版本不一樣的時候（3.8）。

---

## 3.3 同步還是非同步：一條一條決定

### 3.3.1 四個問題

第 02 章 2.7.2 用過一個問題：「另一邊會不會拒絕」。決定一條線要同步還是非同步，再加三個：

1. **呼叫端回應使用者之前，需不需要這個答案？** 需要 → 同步（或者改需求：先回「處理中」）。
2. **另一邊會不會拒絕？** 不會 → 事件就夠了（最終一致）。會 → 同步問，或者先做、被拒絕就補償（Saga，第 04 章）。
3. **它是讀，還是寫？** 讀可以晚一點（第 12 站 US-PRD-3 AC-4：可售量允許 5 秒的延遲）—— 晚到一個程度，就可以不問對方、讀自己的副本（第 05 章的讀模型）。
4. **對方掛了，這邊要不要跟著掛？** 同步 = 對方不能用，這個功能也不能用。這一條在一個行程裡不存在。

### 3.3.2 跨過這一刀的線

把第 02 章 B1（2.9.3）列出來的、跨過「庫存」這一刀的同步呼叫與事件，逐一套上去：

| 線 | 呼叫端要什麼 | 另一邊會拒絕嗎 | 這一章 | 之後 |
|---|---|---|---|---|
| cart、catalog → 可售量（`available`） | 一個數字，給人看 | 不會（讀） | 同步 | 第 05 章：讀模型；對方掛了的時候怎麼辦，第 06 章 |
| catalog → 商品頁的可售量（`availableForDisplay`） | 同上；5 秒內的舊值也可以 | 不會 | 同步 | 同上 |
| catalog → 補貨（`restock`） | 賣家要知道補進去了 | 幾乎不會（數量已經驗證過是正的） | 同步，**可以安全地再送**（3.5） | 可以改成事件，但賣家畫面上的「補貨後可售量」要換一種做法 |
| catalog → 標熱點（`setHot`） | 閘門要在搶購開始前建好 | 不會 | 同步，在 catalog 的交易裡（3.4.7） | 熱點旗標搬回庫存模組（第 01 章 1.3.3），還沒做 |
| ordering → 熱點閘門（`gateHot`） | 搶不搶得到：409 要在建立訂單之前回 | **會** | 同步（第 12 站 6.5 的前提：搶不到的人不碰 MySQL） | 不會變 |
| ordering → 預留（`reserve`） | 201 還是 409 | **會** | 同步、在下單交易裡 | 第 04 章：Saga |
| ordering → `confirm`、`release` | 預留的狀態跟著訂單走 | 不會 | 同步、在交易裡 | 第 04 章：可以變成事件（`order.paid` → 確認） |
| ordering → `consume`（出貨） | 同上 | **會**（還在落帳 503、即將取消 409） | 同步、在交易裡 | 第 04 章 |
| ordering → 對帳的三個操作 | 批次讀、釋放 | 不會 | 同步（排程） | —— |
| catalog → `product.created` | 不用等 | 不會 | 事件（2.7） | —— |
| ordering → `order.placed`（熱點落帳） | 不用等 | 幾乎不會（第 12 站 7.6.3） | 事件 | —— |
| inventory → `inventory.hot-settlement-failed` | 取消那張訂單 | 不會 | 事件 | —— |

這一章**一條都沒有換邊**。表上「之後」那一欄的每一條，換邊都牽動別的東西：讀模型要處理過時（第 05 章）、把 `confirm` 變成事件就是 Saga 的一半（第 04 章）。這一章做的是另一件事：**讓同步的那些，在網路上的行為跟在一個行程裡一樣可以預期**（3.4～3.6），讓非同步的那些，真的走 broker 而且送到對的服務（3.7）。

一個要記下來的新耦合：第 4 個問題。第 02 章的實驗裡，商品頁的可售量是一次同步呼叫 —— 這一章之後，它是正式的。庫存服務掛了，商品頁會怎樣，這一章沒有量（第 06 章）。

### 3.3.3 gRPC 的時機

gRPC（HTTP/2 + Protocol Buffers）常被拿來跟 REST 比。它真正的好處是這幾個：

| 好處 | 什麼時候值得 |
|---|---|
| 一份 `.proto` 產生兩邊的程式碼，型別在編譯時就對得上 | 呼叫端與提供端是不同的語言、不同的團隊 |
| 二進位、HTTP/2 多工 | 服務之間每秒上萬次的呼叫、payload 大，序列化與連線數真的出現在 profile 裡 |
| 串流（server / client / bidirectional） | 推送、長時間的資料流 |
| 生態系的 deadline、狀態碼 | 整個組織都用它 |

代價：瀏覽器不能直接呼叫（要 gRPC-Web 或閘道）、除錯工具要換（`curl` 看不到內容）、負載平衡要懂 HTTP/2（第 08 章）、錯誤模型是 gRPC 的狀態碼，不是第 12 站的 Problem Details。

這個系統：**一個呼叫端、兩邊都是 Java、同一個團隊**。使用者的一天裡，訂單服務打庫存服務 38 次（3.4.6）；第 02 章 2.9.2 重跑的 K1 裡，1 個品項的下單 p50：一個行程 10.19 ms、切開 13.07 ms —— 那 3 毫秒裡有網路、有另一邊的交易，JSON 是其中一小段。換成 gRPC 省下的是序列化的那一小段 —— 這一章**沒有量**。這裡選 HTTP + JSON，換 gRPC 的時機是表上那幾種情況真的出現，而且量得到。

---

## 3.4 介面的形狀：16 個操作，12 支端點

### 3.4.1 第 02 章的線少了什麼

第 02 章 2.4.6 說得很清楚，`RemoteInventory` 不是服務之間該有的介面 —— 它只是讓那一章可以專心看資料。把它當成正式的介面看，少了這些：

- **每一個操作都是 `POST /lab/d02/inventory/{op}`**。HTTP 的語意一個都沒用上：讀的是 POST（不能快取、看不出「安全」）、「一張訂單的預留」不是一個資源（沒有「再放一次」的位置）。伺服端是一個 16 個分支的 `switch`，`op` 打錯字要到執行時才知道（「沒有這個操作」）。
- **沒有版本**。改了就是改了，線上的呼叫端沒有任何辦法知道。
- **錯誤一律原樣交給使用者**。`RemoteInventory.decode()` 把對方的每一種 Problem Details（除了 500）都還原成同一個例外：

```java
            for (ProblemType pt : ProblemType.values()) {
                if (!pt.type().toString().equals(type) || pt == ProblemType.INTERNAL) continue;
```

  對方回 401（服務的 token 設錯了）、404（呼叫了一支對方還沒有的端點），使用者就會收到 401「需要登入」、404「找不到資源」—— 那不是使用者的錯，也不是使用者能修的。
- **空的呼叫照送**（3.4.3）。
- **再送一次不安全**（3.2.3，3.5）、**誰都能打**（3.2.4，3.6）。

### 3.4.2 哪些合併、哪些消失

`InventoryApi` 在第 02 章結束時有 16 個方法（第 12 站的 13 個、對帳的 3 個）。逐一問：**切開之後，它在線上是什麼？**

| `InventoryApi` 的方法 | 第 02 章的線 | 這一章 | 為什麼 |
|---|---|---|---|
| `initialize` | `initialize` | **拿掉** | 2.7 之後，唯一的呼叫者是庫存模組自己的 `product.created` 消費者。留在公開介面上，就是一支「沒有人該打、卻打得到」的端點 |
| `reserve`、`holdHot` | `reserve`、`hold-hot` | **合成一個**：`PUT /reservations/{orderId}` | 同一張訂單有一般與熱點的品項時是兩次呼叫：兩次往返、庫存服務那一側兩個交易 —— 第一個 commit 了、第二個失敗，就留下沒有訂單的預留。合成一個，庫存那一側全有或全無 |
| `release`、`releaseAbandoned` | `release`、`release-abandoned` | **合成一個**：`POST /reservations/{orderId}/release` | 兩個方法只差在交易的傳播屬性（`MANDATORY` vs 自己開交易）。傳播屬性過不了網路：在服務之間，每一次呼叫本來就是庫存服務自己的交易 |
| `available(id)`、`available(ids)` | `available-one`、`available` | **合成一個**：`GET /stock?productIds=…` | 一個是另一個的特例 |
| `confirm`、`consume` | 同名 | `POST /reservations/{orderId}/confirm`、`…/consume` | 狀態轉移，不是資源的建立 —— 跟第 12 站的 `POST /api/orders/{orderNo}/cancel` 同一種寫法 |
| `restock` | `restock` | `POST /products/{productId}/restocks` | 每一次補貨是一個新的「補貨」（帶冪等鍵，3.5） |
| `setHot` | `set-hot` | `PUT /products/{productId}/hot` | 「這個商品是不是熱點」是一個狀態：PUT，本來就冪等 |
| `gateHot`、`returnHot` | `gate-hot`、`return-hot` | `POST /hot-gate`、`POST /hot-gate/returns` | 帶冪等鍵（3.5）；**空的清單不送**（3.4.3） |
| `availableForDisplay` | `available-for-display` | `GET /stock/{productId}/display?hot=…` | `hot` 這個參數為什麼還在：3.4.7 |
| `activeReservations` | `active-reservations` | `GET /reservations?createdBefore=…` | 唯讀、keyset 分頁 |
| `reservationsOf` | `reservations-of` | `POST /reservations/query` | 唯讀，但用 POST：對帳一批 500 個 orderId（2.6.4），放在 URL 上會碰到 Tomcat 預設 8 KB 的上限 |

16 個操作，12 支端點；`InventoryApi` 從 16 個方法變成 14 個。前兩列改的是 Java 的介面，**單體也跟著改** —— 介面的形狀在一個行程裡改錯很便宜，切開之後改錯很貴。現在改它還是便宜的：第 02 章的線從來沒有「上線」過，沒有任何一個線上的呼叫端在用它。等這一章的 v1 上線之後（3.8.5），同樣的改動要走「新增、並存、遷移、確認沒人用、刪除」。

**`InventoryApi`**：

```diff
  */
 public interface InventoryApi {
 
-    /**
-     * 建立一個商品的庫存列（US-PRD-1 AC-1），並記一筆 INITIAL。MANDATORY。
-     * 13 站 2.7：呼叫的人從 catalog（建立商品的交易裡）變成 product.created 的消費者；庫存列已經在（補貨比事件先到）就加上去
-     */
-    void initialize(long productId, int onHand, String note);
+    // 13 站 3.4：initialize(productId, onHand, note) 從這個介面拿掉了。第 02 章 2.7 之後，唯一的呼叫者是庫存模組自己的
+    // product.created 消費者 —— 一個沒有別的模組在用的公開方法，切開之後就是一支沒有人該打、卻打得到的端點
 
     /**
      * 為一張訂單預留庫存（每個品項一筆 HELD 預留）。全有或全無：任何一個品項不足就丟例外，呼叫端的交易應該 rollback。
      * 內部會依 productId 排序後才加鎖（4.2.3：避免兩張訂單以相反的順序鎖同樣兩個商品而死鎖）。
      * 必須在呼叫端既有的交易內呼叫（Propagation.MANDATORY）。
+     *
+     * hotLines：7.6 熱點商品的品項（已經過了 Redis 的閘門 gateHot）—— 只寫預留列（HELD、counted = FALSE），**不碰 inventory 那一列**，
+     * 數量由 inventory.hot-settlement 消費者在 commit 之後計入 reserved（最終一致，0.6.4：60 秒）。
+     * 13 站 3.4：第 12 站這是另一個方法 holdHot()。一張訂單同時有一般與熱點的品項時是兩次呼叫 —— 在一個行程裡無所謂；
+     * 切開之後是兩次往返、兩個交易：第一個 commit 了、第二個失敗，第一個就留下沒有訂單的預留。合成一個：一張訂單的預留，一次、全有或全無
      */
-    void reserve(long orderId, List<ReserveLine> lines);
-
-    /**
-     * 7.6 熱點商品的預留：只寫預留列（HELD、counted = FALSE），**不碰 inventory 那一列**。
-     * 數量由 inventory.hot-settlement 消費者在 commit 之後計入 reserved、記一筆 RESERVE（最終一致，0.6.4：60 秒）。
-     * 呼叫之前一定已經過了 Redis 的閘門（gateHot）。MANDATORY。
-     */
-    void holdHot(long orderId, List<ReserveLine> lines);
+    void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines);
 
     /** 付款成功：這張訂單的預留 HELD → CONFIRMED（不再能被逾時釋放）。數量不變，不記帳。MANDATORY。 */
     void confirm(long orderId);
```

**`JdbcInventoryService`**：`holdHot` 變成 `reserve` 裡的一個私有步驟，順序跟第 12 站 `PlaceOrderService` 的兩行一樣（先一般品項、再熱點品項），所以鎖的順序沒變（第 12 站 4.2.3）：

```java
    public void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        reserveCounted(orderId, lines);
        if (!hotLines.isEmpty()) holdHot(orderId, hotLines);
    }

    private void reserveCounted(long orderId, List<ReserveLine> lines) {
```

`initialize` 留在 `JdbcInventoryService` 上，只是不再 `@Override` —— 它的呼叫者 `InventoryEventHandlers` 本來就注入 `JdbcInventoryService`，不用改。

**`PlaceOrderService`**：

```diff
         Set<Long> hotIds = new HashSet<>();
         hot.forEach(h -> hotIds.add(h.productId()));
         List<ReserveLine> normal = lines.stream().filter(l -> !hotIds.contains(l.productId())).map(l -> new ReserveLine(l.productId(), l.quantity())).toList();
-        if (!normal.isEmpty()) inventory.reserve(order.getId(), normal);
-        if (!hot.isEmpty()) inventory.holdHot(order.getId(), hot);
+        inventory.reserve(order.getId(), normal, hot);                      // 13 站 3.4：第 12 站是 reserve() 與 holdHot() 兩次呼叫
         history.record(order.getId(), null, order.getStatus(), "PLACE_ORDER", OrderHistory.Actor.buyer(buyerId), now);
         keys.complete(buyerId, key, order.getId());
         cart.removeItems(buyerId, ids);                                     // AC-4
```

全部品項都是熱點的訂單，`normal` 是空的 —— 在一個行程裡，`reserveCounted` 的迴圈什麼都不做；在線上，它還是一次呼叫（帶著一個空的 `lines`），不會多一次。

**`CrossModuleCallInTxTest`**（第 01 章 1.6.6）的清單少一行，11 → 10 種：

```diff
     /**
      * 第 01 章結束時，還在交易裡的跨模組呼叫：全部是「寫」，全部要等 Saga（第 04 章）才拿得出來。
      * 13 站 2.7：「catalog → InventoryApi.initialize」拿掉了 —— 建立商品改成寫一個 product.created，期初庫存由庫存模組的消費者建立（12 → 11 種）
+     * 13 站 3.4：「ordering → InventoryApi.holdHot」拿掉了 —— 熱點品項併進 reserve() 的第三個參數，一張訂單的預留是一次呼叫（11 → 10 種）
      */
     static final Map<String, String> ALLOWED = Map.ofEntries(
             entry("catalog → InventoryApi.setHot", "標熱點：MANDATORY，commit 之後建立 Redis 閘門（第 04 章）"),
             entry("ordering → CartApi.removeItems", "下單：清購物車跟訂單同一個交易（第 04 章）"),
-            entry("ordering → InventoryApi.reserve", "下單：預留跟訂單同一個交易（第 04 章）"),
-            entry("ordering → InventoryApi.holdHot", "下單：熱點預留列跟訂單同一個交易（第 04 章）"),
+            entry("ordering → InventoryApi.reserve", "下單：預留（含熱點品項的預留列）跟訂單同一個交易（第 04 章）"),
             entry("ordering → InventoryApi.confirm", "付款成功：預留確認跟訂單狀態同一個交易（第 04 章）"),
             entry("ordering → InventoryApi.consume", "出貨：扣庫存跟訂單狀態同一個交易（第 04 章）"),
             entry("ordering → InventoryApi.release", "取消：釋放預留跟訂單狀態同一個交易（第 04 章）"),
```

第 00 章、第 02 章的實驗支架也實作 `InventoryApi`，跟著改：`dist00.RemoteInventoryApi`（一般品項照舊走 HTTP、熱點品項照舊在本地）、`dist02.RemoteInventory`（照舊送兩支：`reserve`、`hold-hot` —— 那是第 02 章的線，3.2 與 3.4.6 要拿它對照）、`dist02.InventoryEndpoints`、`dist00.LabInventoryService`，以及第 12 站 lab 的 `FriendlyPlaceOrder`。

⚠️ **改了介面，`mvn test-compile` 說 BUILD SUCCESS。** 改完 `InventoryApi` 之後跑 `mvn -o test-compile`，沒有任何錯誤 —— 輸出裡寫的是（摘錄）：

```
[INFO] --- compiler:3.11.0:testCompile (default-testCompile) @ shop ---
[INFO] Nothing to compile - all classes are up to date
[INFO] BUILD SUCCESS
```

maven-compiler-plugin 判斷「要不要重新編譯」看的是**原始碼的時間戳**：測試的原始碼一個字都沒改，它就不編譯，`target/test-classes` 裡的舊 class 還在。`mvn clean test-compile` 之後，5 個實作或呼叫 `InventoryApi` 的測試檔編譯不過。第 12 站 2.9.5、第 02 章 2.4.1 是同一類的坑（`target/` 裡的舊東西），這一次是 class 不是 migration：**改了公開介面，一定 `clean`。**

### 3.4.3 空的清單：一次什麼都不做的往返

第 12 站的 `PlaceOrderService` 每一張訂單都呼叫 `inventory.gateHot(hot)` —— `hot` 常常是空的：

```java
    @Override
    public void gateHot(List<ReserveLine> hotLines) {
        if (!hotLines.isEmpty()) hot.gate(hotLines);
    }
```

在一個行程裡，那是一個立刻返回的方法呼叫。在第 02 章的線上，`RemoteInventory.gateHot()` 照送：一次網路往返、庫存服務的一個 Tomcat 執行緒，什麼都不做。「是不是空的」這個判斷在網路的另一邊。使用者的一天裡 6 張訂單、2 張有熱點品項，**4 次 `gate-hot` 是空的**（3.4.6 的表）。

新的呼叫端在送之前判斷：

```java
    public void gateHot(List<ReserveLine> hotLines) {
        if (hotLines.isEmpty()) return;
        String key = UUID.randomUUID().toString();
        call("gate-hot", () -> client.gate(key, new LinesRequest(hotLines)));
    }
```

`returnHot`、`available(空集合)`、`reservationsOf(空集合)` 也一樣。

### 3.4.4 伺服端：`InventoryServiceController` 與 `InventoryService`

伺服端分兩層。controller 只管 HTTP：路徑、參數、狀態碼。下面那一層 `InventoryService` 管兩件 `InventoryApi` 不管的事 —— **每一個操作自己開交易**（第 12 站有 7 個方法是 `MANDATORY`，第 02 章 `InventoryEndpoints` 的那 7 行 `tx.executeWithoutResult`），以及**每一個寫入都可以安全地再送**（3.5）：

**`src/main/java/com/example/shop/inventory/internal/InventoryService.java`**

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.ReservationRef;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.shared.config.ConditionalOnServiceRole;
import com.example.shop.shared.config.ServiceRole;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.events.Inbox;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 13 站 3.4、3.5：庫存服務給「別的服務」用的那一層（web/InventoryServiceController 呼叫它）。跟 InventoryApi 差在兩件事：
 *
 *   ① 每一個操作自己開交易、自己 commit。InventoryApi 有 7 個方法是 MANDATORY —— 它們本來要跟呼叫端的交易一起 commit；
 *      呼叫端在另一個行程裡，那個交易過不來（第 02 章 InventoryEndpoints 的那 7 行 tx.executeWithoutResult）。
 *   ② 每一個寫入都可以安全地重送。回應在回程上丟了，呼叫端不知道做了沒有，只能再送一次（3.2 ②）：
 *        reserve           ：鍵是 orderId（一張訂單只預留一次）。processed_messages 的那一列是交易的第一句（Inbox）
 *        restock           ：鍵是 Idempotency-Key（呼叫端每一次補貨產生一個，重送用同一個）
 *        gate / return     ：鍵是 Idempotency-Key，標記在 Redis 裡（HotStock 的 GATE_ONCE、RETURN_ONCE）
 *        confirm / release / consume / setHot：本來就冪等（狀態轉移的 UPDATE 帶著 WHERE status = …；已經是那個狀態就什麼都不改）
 *
 * 只在庫存服務裡存在（role = inventory-service）。
 */
@Component
@ConditionalOnServiceRole(ServiceRole.INVENTORY_SERVICE)
public class InventoryService {

    static final String RESERVE = "inventory.http.reserve", RESTOCK = "inventory.http.restock";

    private final JdbcInventoryService inventory;
    private final Inbox inbox;
    private final TransactionTemplate tx;

    InventoryService(JdbcInventoryService inventory, Inbox inbox, PlatformTransactionManager tm) {
        this.inventory = inventory;
        this.inbox = inbox;
        this.tx = new TransactionTemplate(tm);
    }

    /**
     * 一張訂單的預留。@return true = 重送：這張訂單已經預留過、內容一樣，這一次什麼都沒做。
     * 內容不一樣（同一個 orderId、不同的品項或數量）→ 422：那不是重送，是呼叫端的 bug。
     * 第一次失敗了（庫存不足 → 交易 rollback，processed_messages 那一列也不在）→ 再送一次會重新判斷，不是「已經處理過」
     */
    public boolean reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        boolean first = Boolean.TRUE.equals(tx.execute(s -> {
            if (!inbox.claim(RESERVE, Long.toString(orderId))) return false;
            inventory.reserve(orderId, lines, hotLines);
            return true;
        }));
        if (first) return false;
        Map<Long, Integer> asked = new TreeMap<>(), have = new TreeMap<>();
        lines.forEach(l -> asked.merge(l.productId(), l.quantity(), Integer::sum));
        hotLines.forEach(l -> asked.merge(l.productId(), l.quantity(), Integer::sum));
        inventory.reservationsOf(List.of(orderId)).getOrDefault(orderId, List.of()).forEach(r -> have.merge(r.productId(), r.quantity(), Integer::sum));
        if (!asked.equals(have))
            throw new ShopException(ProblemType.IDEMPOTENCY_KEY_REUSED, "訂單 " + orderId + " 已經用不同的內容預留過").with("orderId", orderId);
        return true;
    }

    public void confirm(long orderId) { tx.executeWithoutResult(s -> inventory.confirm(orderId)); }

    /** 也是對帳的 releaseAbandoned()：在服務之間，兩個是同一件事（每一次呼叫本來就是自己的交易） */
    public void release(long orderId) { tx.executeWithoutResult(s -> inventory.release(orderId)); }

    public void consume(long orderId) { tx.executeWithoutResult(s -> inventory.consume(orderId)); }

    /** @return true = 重送（這個鍵已經補過了） */
    public boolean restock(String key, long productId, int quantity, String note) {
        boolean first = Boolean.TRUE.equals(tx.execute(s -> {
            if (!inbox.claim(RESTOCK, key)) return false;
            inventory.restock(productId, quantity, note);
            return true;
        }));
        return !first;
    }

    public void setHot(long productId, boolean hot) { tx.executeWithoutResult(s -> inventory.setHot(productId, hot)); }

    public boolean gateHot(String key, List<ReserveLine> lines) { return inventory.gateHotOnce(lines, key); }

    public boolean returnHot(String key, List<ReserveLine> lines) { return inventory.returnHotOnce(lines, key); }

    public Map<Long, Integer> available(Collection<Long> productIds) { return inventory.available(productIds); }

    public int availableForDisplay(long productId, boolean hot) { return inventory.availableForDisplay(productId, hot); }

    public List<ReservationRef> activeReservations(long afterId, Instant createdBefore, int limit) {
        return inventory.activeReservations(afterId, createdBefore, limit);
    }

    public Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds) { return inventory.reservationsOf(orderIds); }
}
```

**`src/main/java/com/example/shop/inventory/internal/web/InventoryServiceController.java`**

```java
package com.example.shop.inventory.internal.web;

import com.example.shop.inventory.ReservationRef;
import com.example.shop.inventory.internal.InventoryService;
import com.example.shop.inventory.internal.web.InventoryWire.*;
import com.example.shop.shared.config.ConditionalOnServiceRole;
import com.example.shop.shared.config.ServiceRole;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * 13 站 3.4：庫存服務給其他服務的 API（第 02 章是 POST /lab/d02/inventory/{op}，13 個 Java 方法原封不動搬上去）。
 *
 *   GET  /stock?productIds=…                 可售量（一個或多個；沒有庫存列的商品不在結果裡）
 *   GET  /stock/{productId}/display?hot=…     商品頁顯示用
 *   PUT  /reservations/{orderId}              一張訂單的預留（URL 就是冪等鍵）
 *   POST /reservations/{orderId}/confirm|release|consume
 *   GET  /reservations?createdBefore=…        對帳：還佔著庫存的預留（keyset 分頁）
 *   POST /reservations/query                  對帳：這些訂單的預留
 *   POST /products/{productId}/restocks       補貨（Idempotency-Key）
 *   PUT  /products/{productId}/hot            標成（或取消）熱點
 *   POST /hot-gate、/hot-gate/returns         熱點閘門（Idempotency-Key）
 *
 * 路徑帶版本（v1）：不相容的改變走 v2、兩版並存（3.8.5）。寫入一律 204；重送（之前做過了）多一個 Idempotent-Replayed: true。
 * 認證在 InternalApiSecurity；錯誤照第 12 站的 Problem Details（GlobalExceptionHandler）。只在 role = inventory-service 時存在。
 */
@RestController
@RequestMapping("/internal/inventory/v1")
@ConditionalOnServiceRole(ServiceRole.INVENTORY_SERVICE)
class InventoryServiceController {

    static final String REPLAYED = "Idempotent-Replayed";

    private final InventoryService inventory;

    InventoryServiceController(InventoryService inventory) { this.inventory = inventory; }

    @GetMapping("/stock")
    StockLevels stock(@RequestParam List<Long> productIds) {
        Map<Long, Integer> m = inventory.available(productIds);
        return new StockLevels(productIds.stream().distinct().filter(m::containsKey).map(id -> new StockLevel(id, m.get(id))).toList());
    }

    @GetMapping("/stock/{productId}/display")
    StockLevel display(@PathVariable long productId, @RequestParam boolean hot) {
        return new StockLevel(productId, inventory.availableForDisplay(productId, hot));
    }

    @PutMapping("/reservations/{orderId}")
    ResponseEntity<Void> reserve(@PathVariable long orderId, @RequestBody ReserveRequest body) {
        return done(inventory.reserve(orderId, orEmpty(body.lines()), orEmpty(body.hotLines())));
    }

    @PostMapping("/reservations/{orderId}/confirm")
    ResponseEntity<Void> confirm(@PathVariable long orderId) { inventory.confirm(orderId); return done(false); }

    @PostMapping("/reservations/{orderId}/release")
    ResponseEntity<Void> release(@PathVariable long orderId) { inventory.release(orderId); return done(false); }

    @PostMapping("/reservations/{orderId}/consume")
    ResponseEntity<Void> consume(@PathVariable long orderId) { inventory.consume(orderId); return done(false); }

    @GetMapping(value = "/reservations", params = "createdBefore")
    Reservations active(@RequestParam(defaultValue = "0") long afterId, @RequestParam Instant createdBefore, @RequestParam int limit) {
        return new Reservations(inventory.activeReservations(afterId, createdBefore, Math.min(limit, 1000)));
    }

    @PostMapping("/reservations/query")
    Reservations of(@RequestBody ReservationsQuery q) {
        return new Reservations(inventory.reservationsOf(q.orderIds()).values().stream().flatMap(List::stream)
                .sorted(java.util.Comparator.comparingLong(ReservationRef::id)).toList());
    }

    @PostMapping("/products/{productId}/restocks")
    ResponseEntity<Void> restock(@PathVariable long productId, @RequestHeader("Idempotency-Key") String key, @RequestBody RestockRequest body) {
        if (body.quantity() <= 0) throw new ShopException(ProblemType.VALIDATION, "quantity 必須大於 0");
        return done(inventory.restock(checked(key), productId, body.quantity(), body.note()));
    }

    @PutMapping("/products/{productId}/hot")
    ResponseEntity<Void> hot(@PathVariable long productId, @RequestBody HotRequest body) {
        inventory.setHot(productId, body.hot());
        return done(false);
    }

    @PostMapping("/hot-gate")
    ResponseEntity<Void> gate(@RequestHeader("Idempotency-Key") String key, @RequestBody LinesRequest body) {
        return done(inventory.gateHot(checked(key), orEmpty(body.lines())));
    }

    @PostMapping("/hot-gate/returns")
    ResponseEntity<Void> giveBack(@RequestHeader("Idempotency-Key") String key, @RequestBody LinesRequest body) {
        return done(inventory.returnHot(checked(key), orEmpty(body.lines())));
    }

    static ResponseEntity<Void> done(boolean replayed) {
        return replayed ? ResponseEntity.noContent().header(REPLAYED, "true").build() : ResponseEntity.noContent().build();
    }

    static <T> List<T> orEmpty(List<T> l) { return l == null ? List.of() : l; }

    /** processed_messages.message_id 是 VARCHAR(36)：一個 UUID */
    static String checked(String key) {
        if (key.isBlank() || key.length() > 36) throw new ShopException(ProblemType.VALIDATION, "Idempotency-Key 必須是 1～36 個字元");
        return key;
    }
}
```

幾個決定：

- **路徑帶版本**：`/internal/inventory/v1`。相容的改變（加一支端點、回應多一個欄位）留在 v1；不相容的（拿掉、改名、改型別）開 v2、兩版並存（3.8.5）。`/internal/` 這個前綴讓安全的設定只要一條規則（3.6）。
- **寫入一律 204**。重送（之前做過了）多一個 `Idempotent-Replayed: true` —— 呼叫端不需要它，但在日誌與測試裡看得到「這一次是重送」。
- **`@ConditionalOnServiceRole(INVENTORY_SERVICE)`**：只有庫存服務有這支 controller（3.7）。單體裡沒有它 —— 第 12 站的 `SecurityRouteCoverageTest` 與 `OpenApiContractTest`（第 12 站 3.8.2 的 API 快照）掃的都是單體的 context，這一章沒有改到它們。
- **請求與回應的 record** 放在 `InventoryWire`，伺服端與呼叫端共用；`ReserveLine`、`ReservationRef` 是 `InventoryApi` 本來就有的型別，直接上線路：

```java
package com.example.shop.inventory.internal.web;

import com.example.shop.inventory.ReservationRef;
import com.example.shop.inventory.ReserveLine;

import java.util.List;

/**
 * 13 站 3.4：/internal/inventory/v1 的請求與回應。伺服端（InventoryServiceController）與呼叫端（remote.InventoryClient）用同一組 record ——
 * 同一個團隊、同一個 repo，省掉兩份一樣的定義；代價是改一個欄位的名字，兩邊在同一個 commit 裡一起變，
 * 而線上那個「還沒升級的呼叫端」不會跟著變（3.8 的契約測試守的就是這一件事）。
 * ReserveLine、ReservationRef 是 InventoryApi 本來就有的型別，直接上線路。
 */
public final class InventoryWire {

    private InventoryWire() {}

    /** PUT /reservations/{orderId}：一張訂單的全部預留。hotLines 是已經過了閘門的熱點品項（InventoryApi.reserve 的第三個參數） */
    public record ReserveRequest(List<ReserveLine> lines, List<ReserveLine> hotLines) {}

    /** POST /hot-gate、/hot-gate/returns */
    public record LinesRequest(List<ReserveLine> lines) {}

    /** POST /products/{productId}/restocks */
    public record RestockRequest(int quantity, String note) {}

    /** PUT /products/{productId}/hot */
    public record HotRequest(boolean hot) {}

    /** GET /stock、/stock/{productId}/display。available = on_hand − reserved（display：可能是 5 秒前的值，US-PRD-3 AC-4） */
    public record StockLevel(long productId, int available) {}

    public record StockLevels(List<StockLevel> items) {}

    /** POST /reservations/query：500 個 orderId 放在 URL 上會超過 8 KB（Tomcat 的預設上限）—— 查詢用 POST，它還是唯讀、可以重送 */
    public record ReservationsQuery(List<Long> orderIds) {}

    public record Reservations(List<ReservationRef> items) {}
}
```

  共用省掉兩份一樣的定義，代價寫在註解裡：改一個欄位的名字，兩邊在同一個 commit 裡一起變 —— 3.8.5 就是這件事。

### 3.4.5 呼叫端：`@HttpExchange` 與 `RemoteInventoryApi`

Spring 6 的 HTTP interface：把對方的 API 寫成一個 Java 介面，實作由 `HttpServiceProxyFactory` 產生。它不是 Feign —— 沒有另一套註解、另一個依賴，底下就是 `RestClient`：

```java
package com.example.shop.inventory.internal.remote;

import com.example.shop.inventory.internal.web.InventoryWire.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.annotation.HttpExchange;
import org.springframework.web.service.annotation.PostExchange;
import org.springframework.web.service.annotation.PutExchange;

import java.util.List;

/**
 * 13 站 3.4：庫存服務的 API，宣告成一個 Java 介面（Spring 6 的 HTTP interface）。實作由 HttpServiceProxyFactory 產生 ——
 * 第 02 章的 RemoteInventory 是手寫的 http.post().uri(...).body(...).retrieve()，13 個方法擠在一個 call(op, body) 裡。
 * 這不是 Feign：沒有另一套註解、另一個依賴，底下就是 RestClient（逾時、攔截器、觀測都是同一套設定）。
 */
@HttpExchange("/internal/inventory/v1")
interface InventoryClient {

    @GetExchange("/stock")
    StockLevels stock(@RequestParam List<Long> productIds);

    @GetExchange("/stock/{productId}/display")
    StockLevel display(@PathVariable long productId, @RequestParam boolean hot);

    @PutExchange("/reservations/{orderId}")
    ResponseEntity<Void> reserve(@PathVariable long orderId, @RequestBody ReserveRequest body);

    @PostExchange("/reservations/{orderId}/confirm")
    void confirm(@PathVariable long orderId);

    @PostExchange("/reservations/{orderId}/release")
    void release(@PathVariable long orderId);

    @PostExchange("/reservations/{orderId}/consume")
    void consume(@PathVariable long orderId);

    @GetExchange("/reservations")
    Reservations active(@RequestParam long afterId, @RequestParam String createdBefore, @RequestParam int limit);

    @PostExchange("/reservations/query")
    Reservations reservationsOf(@RequestBody ReservationsQuery query);

    @PostExchange("/products/{productId}/restocks")
    ResponseEntity<Void> restock(@PathVariable long productId, @RequestHeader("Idempotency-Key") String key, @RequestBody RestockRequest body);

    @PutExchange("/products/{productId}/hot")
    void hot(@PathVariable long productId, @RequestBody HotRequest body);

    @PostExchange("/hot-gate")
    ResponseEntity<Void> gate(@RequestHeader("Idempotency-Key") String key, @RequestBody LinesRequest body);

    @PostExchange("/hot-gate/returns")
    ResponseEntity<Void> giveBack(@RequestHeader("Idempotency-Key") String key, @RequestBody LinesRequest body);
}
```

`RemoteInventoryApi` 是訂單服務裡的 `InventoryApi`：把每一個方法翻成一次呼叫，把錯誤翻回同一個例外。建構的部分：

```java
    RemoteInventoryApi(RestClient.Builder builder, ShopProperties props, ServiceTokens tokens, ObjectMapper json, MeterRegistry meters) {
        ShopProperties.Remote r = props.deployment().inventory();
        JdkClientHttpRequestFactory f = new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(r.connectTimeout()).build());
        f.setReadTimeout(r.readTimeout());
        RestClient rest = builder.baseUrl(r.url()).requestFactory(f)
                .requestInterceptor((req, body, exec) -> {
                    req.getHeaders().setBearerAuth(tokens.tokenFor(ServiceRole.INVENTORY_SERVICE));
                    return exec.execute(req, body);
                })
                .build();
        this.client = HttpServiceProxyFactory.builderFor(RestClientAdapter.create(rest)).build().createClient(InventoryClient.class);
        this.json = json;
        this.meters = meters;
    }
```

- `RestClient.Builder` 是 Spring Boot 給的那一個（不是 `RestClient.builder()`）：Boot 的 `RestClientCustomizer`、觀測（`http.client.requests`）都會套上去。3.4.6 的實驗就是用一個 customizer 數往返次數。
- 逾時是設定（`shop.deployment.inventory.connect-timeout` 1 秒、`read-timeout` 3 秒）。這兩個數字怎麼跟上游的逾時對齊，是第 06 章的「逾時預算」。
- 每一個請求帶一個服務的 token（3.6）。

錯誤的翻譯：

```java
    /** 庫存服務的 Problem Details → 呼叫端在一個行程裡會拿到的同一個例外 */
    RuntimeException decode(String op, int status, String body) {
        try {
            JsonNode p = json.readTree(body);
            String type = p.path("type").asText();
            for (ProblemType pt : PASS_THROUGH) {
                if (!pt.type().toString().equals(type)) continue;
                if (pt == ProblemType.INSUFFICIENT_STOCK) return new InsufficientStockException(p.get("productId").asLong());
                ShopException e = new ShopException(pt, p.path("detail").asText());
                for (Iterator<Map.Entry<String, JsonNode>> it = p.fields(); it.hasNext(); ) {
                    var f = it.next();
                    if (!STANDARD.contains(f.getKey())) e.with(f.getKey(), f.getValue().isNumber() ? f.getValue().numberValue() : f.getValue().asText());
                }
                return e;
            }
        } catch (Exception notJson) { /* 落到下面 */ }
        log.error("INVENTORY_ERROR op={} status={}：{}", op, status, body);
        return new IllegalStateException("庫存服務 " + op + " 回應 " + status + "：" + body);
    }
```

**只有三種業務錯誤原樣交給使用者**（`PASS_THROUGH`）：庫存不足（409）、狀態不對（409）、暫時不能用（503）。其他的 —— 401、403、404、400、422 —— 都是**訂單服務自己的錯**：token 設錯了、呼叫了一支對方沒有的端點、送了對方看不懂的內容。對使用者來說，那是 500，而且要在日誌裡大聲說（`INVENTORY_ERROR`）。第 02 章的 `decode()` 把它們全部原樣交出去，使用者會收到一個「需要登入」—— 他明明登入了。

整個類別在 3.10.1。呼叫端的程式碼（`PlaceOrderService`、`ProductService`、`CartService`、`ReservationReconciliation`）一行都沒改：它們注入的是 `InventoryApi`。

### 3.4.6 跑起來：使用者的一天走新的線（D2）

兩個服務用正式的設定起來 —— `application-inventory-service.yml`、`application-order-service.yml`（3.7.2），再疊上第 02 章 `Split` 的實驗參數（誠實的兩個庫、Redis 的 database、隨機的埠）。這個支架是 `dist03.Roles`：

```java
    public static ConfigurableApplicationContext inventoryService(List<String> extra) throws Exception {
        List<String> a = Split.args(Split.INV_DB, Split.INV_REDIS, Split.Schema.HONEST, true, false);
        a = Split.override(a, List.of("--spring.profiles.active=local,inventory-service", "--shop.deployment.service-token.secret=" + SECRET));
        return flushed(new SpringApplicationBuilder(ShopApplication.class).run(Split.override(a, extra).toArray(String[]::new)));
```

一個 `lab.*` 都沒有：線是 `src/main` 裡的那一條。往返次數在呼叫端數 —— 一個測試用的 `RestClientCustomizer`（`dist03.CallTap`）在每一個真的送出去的請求上記一筆，標上「這是哪一個使用者動作」（第 01 章 1.4 的 `OpTag`）。第 02 章的 `RemoteInventory` 自己 new 一個 builder，攔截器直接掛在它上面。

```bash
mvn test -Pexperiments -Dtest=D2InterfaceTest
```

```
═══ 3.4 ① 第 02 章的線：使用者的一天（load { 5.99 5.59 5.09 }）═══
  使用者的一天：61 個 HTTP 請求全部是預期的回應
  訂單服務 → 庫存服務：42 次 HTTP、12 種端點
    DELETE /api/cart/items/{productId} → POST /lab/d02/inventory/available                               × 1
    GET /api/cart → POST /lab/d02/inventory/available                                                    × 1
    GET /api/products/{id} → POST /lab/d02/inventory/available-for-display                               × 2
    GET /api/seller/products → POST /lab/d02/inventory/available                                         × 1
    PATCH /api/cart/items/{productId} → POST /lab/d02/inventory/available                                × 1
    PATCH /api/seller/products/{id} → POST /lab/d02/inventory/available-one                              × 1
    POST /api/cart/items → POST /lab/d02/inventory/available                                             × 3
    POST /api/orders → POST /lab/d02/inventory/gate-hot                                                  × 6
    POST /api/orders → POST /lab/d02/inventory/hold-hot                                                  × 2
    POST /api/orders → POST /lab/d02/inventory/reserve                                                   × 4
    POST /api/orders/{orderNo}/cancel → POST /lab/d02/inventory/release                                  × 1
    POST /api/payments/callback → POST /lab/d02/inventory/confirm                                        × 4
    POST /api/seller/orders/{orderNo}/cancel → POST /lab/d02/inventory/release                           × 1
    POST /api/seller/orders/{orderNo}/ship → POST /lab/d02/inventory/consume                             × 2
    POST /api/seller/products/{id}/hot → POST /lab/d02/inventory/available-one                           × 1
    POST /api/seller/products/{id}/hot → POST /lab/d02/inventory/set-hot                                 × 1
    POST /api/seller/products/{id}/publish → POST /lab/d02/inventory/available-one                       × 4
    POST /api/seller/products/{id}/restock → POST /lab/d02/inventory/available-one                       × 1
    POST /api/seller/products/{id}/restock → POST /lab/d02/inventory/restock                             × 1
    POST /api/seller/products/{id}/unpublish → POST /lab/d02/inventory/available-one                     × 1
    事件 inventory.hot-settlement-failed → ordering.stock-shortage → POST /lab/d02/inventory/release       × 1
    排程 OrderJobs.cancelExpired → POST /lab/d02/inventory/release                                         × 1
    排程 ReservationReconciliation.run → POST /lab/d02/inventory/active-reservations                       × 1
═══ 3.4 ② 這一章的線：/internal/inventory/v1，兩個服務用正式的 profile（load { 5.90 5.59 5.10 }）═══
  訂單服務的 InventoryApi：com.example.shop.inventory.internal.remote.RemoteInventoryApi
  使用者的一天：61 個 HTTP 請求全部是預期的回應
  訂單服務 → 庫存服務：38 次 HTTP、10 種端點
    DELETE /api/cart/items/{productId} → GET /internal/inventory/v1/stock                                × 1
    GET /api/cart → GET /internal/inventory/v1/stock                                                     × 1
    GET /api/products/{id} → GET /internal/inventory/v1/stock/{n}/display                                × 2
    GET /api/seller/products → GET /internal/inventory/v1/stock                                          × 1
    PATCH /api/cart/items/{productId} → GET /internal/inventory/v1/stock                                 × 1
    PATCH /api/seller/products/{id} → GET /internal/inventory/v1/stock                                   × 1
    POST /api/cart/items → GET /internal/inventory/v1/stock                                              × 3
    POST /api/orders → POST /internal/inventory/v1/hot-gate                                              × 2
    POST /api/orders → PUT /internal/inventory/v1/reservations/{n}                                       × 6
    POST /api/orders/{orderNo}/cancel → POST /internal/inventory/v1/reservations/{n}/release             × 1
    POST /api/payments/callback → POST /internal/inventory/v1/reservations/{n}/confirm                   × 4
    POST /api/seller/orders/{orderNo}/cancel → POST /internal/inventory/v1/reservations/{n}/release      × 1
    POST /api/seller/orders/{orderNo}/ship → POST /internal/inventory/v1/reservations/{n}/consume        × 2
    POST /api/seller/products/{id}/hot → GET /internal/inventory/v1/stock                                × 1
    POST /api/seller/products/{id}/hot → PUT /internal/inventory/v1/products/{n}/hot                     × 1
    POST /api/seller/products/{id}/publish → GET /internal/inventory/v1/stock                            × 4
    POST /api/seller/products/{id}/restock → GET /internal/inventory/v1/stock                            × 1
    POST /api/seller/products/{id}/restock → POST /internal/inventory/v1/products/{n}/restocks           × 1
    POST /api/seller/products/{id}/unpublish → GET /internal/inventory/v1/stock                          × 1
    事件 inventory.hot-settlement-failed → ordering.stock-shortage → POST /internal/inventory/v1/reservations/{n}/release × 1
    排程 OrderJobs.cancelExpired → POST /internal/inventory/v1/reservations/{n}/release                    × 1
    排程 ReservationReconciliation.run → GET /internal/inventory/v1/reservations                           × 1
═══ 3.4 每一個動作打了庫存服務幾次（第 02 章 → 這一章）═══
  DELETE /api/cart/items/{productId}                             │   1 →   1
  GET /api/cart                                                  │   1 →   1
  GET /api/products/{id}                                         │   2 →   2
  GET /api/seller/products                                       │   1 →   1
  PATCH /api/cart/items/{productId}                              │   1 →   1
  PATCH /api/seller/products/{id}                                │   1 →   1
  POST /api/cart/items                                           │   3 →   3
  POST /api/orders                                               │  12 →   8
  POST /api/orders/{orderNo}/cancel                              │   1 →   1
  POST /api/payments/callback                                    │   4 →   4
  POST /api/seller/orders/{orderNo}/cancel                       │   1 →   1
  POST /api/seller/orders/{orderNo}/ship                         │   2 →   2
  POST /api/seller/products/{id}/hot                             │   2 →   2
  POST /api/seller/products/{id}/publish                         │   4 →   4
  POST /api/seller/products/{id}/restock                         │   2 →   2
  POST /api/seller/products/{id}/unpublish                       │   1 →   1
  事件 inventory.hot-settlement-failed → ordering.stock-shortage   │   1 →   1
  排程 OrderJobs.cancelExpired                                     │   1 →   1
  排程 ReservationReconciliation.run                               │   1 →   1
  合計 42 → 38 次
  （結束時 load { 5.29 5.47 5.06 }）
```

- **兩條線都走完了 61 個請求**，結果一樣。
- **下單 12 → 8 次**：第 02 章的線，6 張訂單送了 6 次 `gate-hot`（4 次是空的）、4 次 `reserve`、2 次 `hold-hot`；新的線，2 次 `hot-gate`（只有兩張有熱點品項）、6 次 `PUT /reservations`（每一張一次）。其他動作的次數都沒變。
- 新的線只用到 10 支端點：`POST /reservations/query`（對帳的第二個方向 —— 使用者的一天沒有一張超過 5 分鐘還沒結束的訂單，2.9.3）與 `POST /hot-gate/returns`（沒有一張下單失敗）沒有走到。它們有測試（3.5.5）與契約（3.8.3）。

### 3.4.7 沒有搬的：熱點旗標

`GET /stock/{productId}/display?hot=…` 的 `hot` 參數是一個症狀：**「這個商品是不是熱點」是庫存的事，旗標卻存在商品的表上，由呼叫端轉手**（第 01 章 1.3.3）。同一個症狀在下單的路徑上：ordering 問 catalog「哪些是熱點」，再決定要不要打庫存的閘門。

把旗標搬回庫存模組會讓這些消失：`hot` 參數、`CatalogApi.hotProducts`、ordering 裡分「一般」與「熱點」的那幾行。這一章沒有做，因為它不是一次介面的整理：

- 庫存模組要有自己的一份熱點旗標，而且下單時讀它不能碰 MySQL（第 12 站 6.5 的前提）—— 等於在庫存模組裡再做一次第 12 站 6.4 的快取。
- 現有的熱點商品要把旗標搬過去 —— 拆開之後，那是一次跨服務的資料搬遷（第 02 章 2.8）。
- 搬完之後，「下單時先過閘門」要不要也搬到庫存服務的 `PUT /reservations` 裡？那會改變下單的步驟順序：閘門在訂單的交易「之前」，是為了讓搶不到的人不碰訂單服務的 MySQL —— 這是第 04 章 Saga 重新安排下單步驟時要一起決定的。

`setHot` 也還在 catalog 的交易裡呼叫（`CrossModuleCallInTxTest` 的清單上還有它）。在線上，它在庫存服務自己的交易裡、回應之前就把閘門建好了；catalog 的交易之後 rollback，就多一個沒人用的閘門，反過來就在下一次下單時從 MySQL 重建（第 12 站 6.5.3）—— 兩邊都會自己收斂，所以這一章沒有動它。

---

## 3.5 冪等：讓「再送一次」安全

3.2.3 的結論：呼叫端拿不到回應的時候，能做的只有再送一次。這一節讓「再送一次」變成安全的 —— 從伺服端開始，因為呼叫端能做的事情，取決於伺服端保證了什麼。

### 3.5.1 哪些本來就冪等

| 端點 | 再送一次會怎樣 | 做法 |
|---|---|---|
| `GET /stock`、`/stock/{id}/display`、`/reservations`；`POST /reservations/query` | 唯讀 | —— |
| `POST …/confirm` | `UPDATE … SET status = 'CONFIRMED' WHERE order_id = ? AND status = 'HELD'`：第二次改到 0 列 | 本來就冪等 |
| `POST …/release` | 只處理 `HELD`、`CONFIRMED` 的預留（第 12 站的 `release()` 註解：「已釋放的不重複釋放」） | 本來就冪等 |
| `POST …/consume` | 只處理 `CONFIRMED`；第二次找不到、什麼都不做 | 本來就冪等 |
| `PUT /products/{id}/hot` | 建閘門是 `SET NX`、取消是 `DEL` | 本來就冪等 |
| `PUT /reservations/{orderId}` | 第 02 章：第二次在 `INSERT inventory_reservations` 撞 `uk_reservations_order_product`，整個交易 rollback —— 不會預留兩次，但回的是錯誤，不是「已經預留了」（讀程式碼得到的，沒有量） | **`Inbox`**，鍵是 orderId（3.5.2） |
| `POST /products/{id}/restocks` | `on_hand += q`：再送一次就再加一次（3.2.3 的 +20） | **`Inbox`**，鍵是 `Idempotency-Key` |
| `POST /hot-gate` | Redis `DECRBY`：再減一次（3.2.3 的 −2） | **Redis 的標記**（3.5.3） |
| `POST /hot-gate/returns` | Redis `INCRBY`：再加一次（偏高，第 12 站 6.5.3 說的「安全的方向」，但還是錯的） | **Redis 的標記** |

需要做事的只有四支。

### 3.5.2 `Inbox`：一個帶著冪等鍵的 HTTP 命令，就是一則訊息

第 12 站 7.5.2 已經解過同一個問題：同一則訊息（同一個 eventId）會來不只一次，`processed_messages` 那一列跟消費者的業務寫入在**同一個交易**裡，第一句就 INSERT。一個帶著冪等鍵的 HTTP 命令，是同一件事 —— 只是送它來的是 HTTP，不是 RabbitMQ。

模組不能直接寫 `processed_messages`（它屬於 `shared`，第 12 站 `TableOwnershipTest`），所以 `shared.events` 多一個介面，跟 `Outbox` 擺在一起：

```java
package com.example.shop.shared.events;

/**
 * 13 站 3.5：outbox 的另一半 —— 「這一則我處理過了沒有」。
 *
 * 跟事件的消費者（EventDispatcher，第 12 站 7.5.2）用同一張表、同一句 INSERT：一個帶著冪等鍵的 HTTP 命令，就是一則訊息。
 * 呼叫端在自己的交易裡、業務寫入之前呼叫它：
 *   true  → 第一次：照常做，跟這一列一起 commit
 *   false → 已經做過了：什麼都不寫，回「已經處理過」
 * 同一個鍵同時來兩次：第二個在這一句等第一個 commit，然後拿到 false；第一個 rollback 了，第二個拿到 true —— 不會兩個都做、也不會兩個都不做。
 */
public interface Inbox {

    /** 必須在呼叫端既有的交易內呼叫（MANDATORY）。consumer 最長 50 字、messageId 最長 36 字（processed_messages 的欄位） */
    boolean claim(String consumer, String messageId);
}
```

```java
package com.example.shop.shared.events.internal;

import com.example.shop.shared.events.Inbox;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** 13 站 3.5：processed_messages 的那一句 INSERT（EventDispatcher 用的是同一句） */
@Component
class JdbcInbox implements Inbox {

    private final JdbcTemplate jdbc;

    JdbcInbox(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public boolean claim(String consumer, String messageId) {
        try {
            jdbc.update("INSERT INTO processed_messages (consumer, message_id) VALUES (?, ?)", consumer, messageId);
            return true;
        } catch (DuplicateKeyException seen) {
            // 在這個方法「裡面」接住：例外不穿過 @Transactional 的代理，呼叫端的交易就不會被標成 rollback-only。
            // MySQL 的主鍵衝突只撤銷這一句，交易本身還能用
            return false;
        }
    }
}
```

`InventoryService`（3.4.4）怎麼用它：

```java
    public boolean reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        boolean first = Boolean.TRUE.equals(tx.execute(s -> {
            if (!inbox.claim(RESERVE, Long.toString(orderId))) return false;
            inventory.reserve(orderId, lines, hotLines);
            return true;
        }));
        if (first) return false;
        Map<Long, Integer> asked = new TreeMap<>(), have = new TreeMap<>();
        lines.forEach(l -> asked.merge(l.productId(), l.quantity(), Integer::sum));
        hotLines.forEach(l -> asked.merge(l.productId(), l.quantity(), Integer::sum));
        inventory.reservationsOf(List.of(orderId)).getOrDefault(orderId, List.of()).forEach(r -> have.merge(r.productId(), r.quantity(), Integer::sum));
        if (!asked.equals(have))
            throw new ShopException(ProblemType.IDEMPOTENCY_KEY_REUSED, "訂單 " + orderId + " 已經用不同的內容預留過").with("orderId", orderId);
        return true;
    }
```

三個細節：

- **`claim` 是交易的第一句**。同一個鍵「同時」來兩次（第一次還沒 commit，呼叫端就逾時、再送了），第二個請求在這一句等第一個的鎖。第一個 commit → 第二個撞主鍵、拿到 `false`、回「重送」；第一個 rollback（例如庫存不足）→ 第二個拿到 `true`、自己再判斷一次。不會兩個都做，也不會兩個都不做。如果 `claim` 放在業務寫入之後，第二個請求會先做一遍 `UPDATE inventory SET reserved = reserved + ?`（等鎖、做完），才發現撞號 —— 在庫存剛好不夠的時候，它會回 409，而第一個其實成功了（這一句是從鎖的順序推出來的，沒有寫測試釘住）。
- **重送要比對內容**。同一個 orderId、不同的品項，不是重送，是呼叫端的 bug：422（第 12 站的 `IDEMPOTENCY_KEY_REUSED`，跟下單的 US-ORD-1a AC-2 同一個型別）。比對的是「這張訂單現在的預留」，所以要在交易**之後**讀（`reservationsOf` 是一句獨立的查詢）—— 在 claim 的那個交易裡讀，讀到的是交易開始時的快照。
- **鍵會被清掉**。第 12 站的 `OutboxMaintenance` 把 7 天前的 `processed_messages` 刪掉（0.6.7）。7 天之後同一個 orderId 再來一次，會被當成新的 —— 呼叫端的重送在幾秒之內，7 天綽綽有餘。

`restock` 的鍵是呼叫端產生的：`RemoteInventoryApi` 每一次 `restock()` 產生一個 UUID，重送時用同一個（3.5.4）。這個鍵只保護「同一次呼叫的重送」：賣家在畫面上按兩次補貨，是兩次呼叫、兩個鍵、補兩次 —— 那要靠使用者那一層的冪等鍵（第 12 站只有下單有，US-ORD-1a）。這一章讓賣家**不需要按第二次**：第一次就拿到 200（3.5.6）。

### 3.5.3 Redis 裡的標記：熱點閘門

閘門的數字在 Redis 裡，不在 MySQL 的交易裡 —— `processed_messages` 保護不了它（第 12 站 7.7、7.8 的寄信、退款是同一個理由）。標記要跟 `DECRBY` 在**同一個原子操作**裡，所以放進第 12 站的 Lua 腳本：

```java
    static final RedisScript<List> GATE_ONCE = RedisScript.of("""
            local n = #KEYS - 1
            if redis.call('EXISTS', KEYS[#KEYS]) == 1 then return {1, 0} end
            for i = 1, n do
              local v = redis.call('GET', KEYS[i])
              if not v then return {-1, i} end
              if tonumber(v) < tonumber(ARGV[i]) then return {-2, i} end
            end
            for i = 1, n do redis.call('DECRBY', KEYS[i], ARGV[i]) end
            redis.call('SET', KEYS[#KEYS], '1', 'EX', ARGV[#ARGV])
            return {0, 0}""", List.class);

    /** 13 站 3.5：跟 RETURN 一樣，多一個標記。標記在 → 0：加過了 */
    static final RedisScript<Long> RETURN_ONCE = RedisScript.of("""
            if redis.call('EXISTS', KEYS[#KEYS]) == 1 then return 0 end
            for i = 1, #KEYS - 1 do
              if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('INCRBY', KEYS[i], ARGV[i]) end
            end
            redis.call('SET', KEYS[#KEYS], '1', 'EX', ARGV[#ARGV])
            return 1""", Long.class);

    /** 標記留多久：比任何一次重送的間隔都長得多（呼叫端的重試在幾秒之內） */
    static final long ONCE_TTL_SECONDS = 600;
```

- **減成功才放標記。** 不夠（`-2`）的那一次沒有減，標記不放：同一個鍵再送一次，應該重新判斷（可能有人取消了）。
- **10 分鐘**：比任何一次重送的間隔都長得多。標記的 key 是 `gate-once:*`、`return-once:*`，熱點對帳掃的是 `stock:*`（第 12 站 6.6），互不干擾。
- 沒有鍵的呼叫（單體裡的 `gateHot`）照舊用原本的 `GATE`：

```java
    boolean gate(List<ReserveLine> lines, String requestKey) {
        List<ReserveLine> sorted = lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList();
        List<String> keys = new ArrayList<>(sorted.stream().map(l -> key(l.productId())).toList());
        List<Object> args = new ArrayList<>(sorted.stream().map(l -> (Object) String.valueOf(l.quantity())).toList());
        if (requestKey != null) {
            keys.add("gate-once:" + requestKey);
            args.add(String.valueOf(ONCE_TTL_SECONDS));
        }
        Object[] qty = args.toArray();
        for (int attempt = 0; attempt < 3; attempt++) {
            List<?> r = guard.call("hot-stock.gate", () -> redis.execute(requestKey == null ? GATE : GATE_ONCE, keys, qty)).orElseThrow(HotStock::unavailable);
            int code = ((Number) r.get(0)).intValue(), i = ((Number) r.get(1)).intValue();
            if (code == 1) return true;
            if (code == 0) return false;
            long productId = sorted.get(i - 1).productId();
            if (code == -2) throw new InsufficientStockException(productId);
            initialize(productId);                                          // -1：key 不存在 → 從 MySQL 建，再試一次
        }
        throw unavailable();
```

### 3.5.4 呼叫端：沒有回應才再送、只送一次

伺服端保證了「同一個鍵、再送一次，效果只有一次」，呼叫端才可以再送。`RemoteInventoryApi` 的 `call()`：

```java
    private <T> T call(String op, Supplier<T> c) {
        for (int attempt = 1; ; attempt++) {
            try {
                return c.get();
            } catch (RestClientResponseException e) {                       // 對方回應了：照它說的
                throw decode(op, e.getStatusCode().value(), e.getResponseBodyAsString());
            } catch (ResourceAccessException e) {                           // 沒有回應：不知道它做了沒有 —— 每一支端點都可以重送（3.5）
                Counter.builder("shop.remote.no_response").tag("service", "inventory").tag("op", op)
                        .description("呼叫其他服務沒有得到回應（連不上、逾時）的次數（13 站 3.5）").register(meters).increment();
                if (attempt < 2) {
                    log.warn("INVENTORY_NO_RESPONSE op={} attempt={}，用同一個冪等鍵再送一次：{}", op, attempt, e.getMessage());
                    continue;
                }
                log.error("INVENTORY_UNAVAILABLE op={}：送了 {} 次都沒有回應：{}", op, attempt, e.getMessage());
                throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", 1);
            }
        }
    }
```

- **只在「沒有回應」時再送**（`ResourceAccessException`：連不上、等不到）。對方回了 4xx、5xx，代表它看過這個請求、有一個答案 —— 照它說的。
- **用同一個鍵**：鍵在 `restock()`、`gateHot()`、`returnHot()` 裡產生一次，`call()` 的兩次嘗試共用。`reserve` 的鍵在 URL 上（orderId）。
- **只再送一次，不等待**。兩次都沒有回應 → 503「庫存服務暫時無法使用」，請使用者稍後再試（第 12 站 6.9 的同一種回應）。重試幾次、間隔多久、跟熔斷怎麼配合（不然庫存服務一慢，每一個請求都變兩倍）—— 第 06 章。
- **代價**：下單交易裡的那一次 `reserve`，最壞的情況大約是兩個 read timeout（6 秒）—— 這段時間訂單服務的交易開著、佔著一條連線。第 00 章 0.2.3 量過「庫存服務變慢，訂單服務的其他 API 跟著慢」，這一行讓那個窗口變長了。這是這一章換來安全重送的代價，第 04 章把 `reserve` 移出下單交易、第 06 章的逾時預算，會把它收回來。
- 每一次沒有回應記一筆 `shop.remote.no_response{service, op}`。

### 3.5.5 測試

**伺服端**：`InventoryServiceApiTest` —— 庫存服務用它正式的角色起來，跑在它**自己的庫**上（跟第 02 章的 `ServiceDatabaseTest` 一樣，從空資料庫只跑 `inventory` 與 `shared` 兩個資料夾）：

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "shop.deployment.role=inventory-service", "shop.deployment.service-token.secret=" + InventoryServiceApiTest.SECRET,
        "shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false", "shop.security.bootstrap-admin.enabled=false",
        "spring.jpa.hibernate.ddl-auto=none", "spring.flyway.locations=classpath:db/migration/inventory,classpath:db/migration/shared",
        "spring.data.redis.database=5"})
class InventoryServiceApiTest {

    static final String SECRET = "inventory-service-api-test-secret-0123456789";
    static final String DB = "shop_svc_inventory_api";

    static volatile String url;

    /**
     * ⚠️ 第一版在 supplier 裡 DROP、CREATE：Spring 每讀一次這個屬性就呼叫一次 supplier —— Flyway 建好的表，下一次讀就被刪了
     *（7 個測試全部 Table 'inventory' doesn't exist）。建庫只做一次
     */
    @DynamicPropertySource
    static void ownDatabase(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> {
            if (url == null) {
                JdbcTemplate admin = TestInfra.adminJdbc();
                admin.execute("DROP DATABASE IF EXISTS " + DB);
                admin.execute("CREATE DATABASE " + DB);
                admin.execute("GRANT ALL PRIVILEGES ON `" + DB + "`.* TO 'shop_migrator'@'%' WITH GRANT OPTION");
                url = TestInfra.jdbcUrl(DB);
            }
            return url;
```

⚠️ 註解裡的那個坑：supplier 裡每一次都 `DROP DATABASE`、`CREATE DATABASE` 的話，7 個測試全紅，每一個都是 `Table 'shop_svc_inventory_api.inventory' doesn't exist`。`@DynamicPropertySource` 註冊的是一個 supplier，Spring 每一次需要這個屬性的值就呼叫一次 —— Flyway 用它建完表之後，下一次讀屬性，庫就被刪掉重建了。所以建庫只做一次（`url == null` 那一個判斷）。

「同時」送兩次的那一個：

```java
    @Test @DisplayName("3.5：同一張訂單的預留「同時」送兩次 → 第二個等第一個 commit，然後當作重送；只預留一次")
    void concurrentDuplicatesReserveOnce() throws Exception {
        long product = 9_930_021, order = 9_930_121;
        stock(product, 10);
        String body = "{\"lines\":[{\"productId\":" + product + ",\"quantity\":1}],\"hotLines\":[]}";
        String auth = service();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<HttpResponse<String>>> f = new ArrayList<>();
        for (int i = 0; i < 2; i++) f.add(pool.submit(() -> { go.await(); return send("PUT", "/internal/inventory/v1/reservations/" + order, auth, body, null); }));
        go.countDown();
        List<HttpResponse<String>> rs = new ArrayList<>();
        for (var x : f) rs.add(x.get());
        pool.shutdown();
        long replayed = rs.stream().filter(r -> r.headers().firstValue("Idempotent-Replayed").isPresent()).count();
        System.out.printf("13 站 3.5：同時兩個 PUT → %s，其中標成重送的 %d 個；reserved = %d%n", rs.stream().map(HttpResponse::statusCode).toList(), replayed, reserved(product));
        assertThat(rs).allMatch(r -> r.statusCode() == 204);
        assertThat(replayed).isEqualTo(1);
        assertThat(reserved(product)).isEqualTo(1);
    }
```

```bash
mvn test -Dtest=InventoryServiceApiTest
```

```
13 站 3.5：confirm、confirm、consume、consume、release → [204, 204, 204, 204, 204]；on_hand 9、reserved 0、SHIP 帳 1 筆
13 站 3.5：同時兩個 PUT → [204, 204]，其中標成重送的 1 個；reserved = 1
13 站 3.5：補貨 10 → 204；同一個鍵再一次 → 204（on_hand 110）；新的鍵 → 204（on_hand 120）；沒有鍵 → 400
13 站 3.5：PUT 預留 9930111 → 204；再一次 → 204 true；內容不一樣 → 422；reserved = 2、RESERVE 帳 1 筆
13 站 3.5：閘門 50 → 同一個鍵減兩次 → 47（第二次 true）→ 同一個鍵加回兩次 → 50
```

「同時兩個 PUT」：兩個都 204，剛好一個標成重送，`reserved = 1`。另外五個測試在 3.6.3 與 3.10.1。

**呼叫端**：`RemoteInventoryApiTest` —— 對面是一個假的庫存服務（JDK 內建的 `HttpServer`，真的 HTTP、真的逾時），每一個請求照劇本回應：

```java
    @Test @DisplayName("回應遺失一次：用同一個 Idempotency-Key 再送一次，成功；記一筆 shop.remote.no_response")
    void retriesOnceWithTheSameKey() {
        script.add(new Object[]{204, 600L, null});                             // 處理了，但 600 ms 才回（呼叫端只等 300 ms）
        script.add(new Object[]{204, 0L, null});
        inventory.restock(9_001L, 10, "unit");
        List<Seen> calls = List.copyOf(seen);
        assertThat(calls).hasSize(2);
        assertThat(calls.get(0).path()).isEqualTo("/internal/inventory/v1/products/9001/restocks");
        assertThat(calls.get(1).idempotencyKey()).isNotBlank().isEqualTo(calls.get(0).idempotencyKey());
        assertThat(meters.get("shop.remote.no_response").tag("op", "restock").counter().count()).isEqualTo(1.0);
    }
```

五個測試：回應遺失一次 → 同一個鍵再送、成功；兩次 → 503；對方的 409、503 → 同一個例外，401、404 → 系統錯誤；空的清單不送、每一個請求帶著服務的 token；token 快取起來。

### 3.5.6 回應遺失，再跑一次（D3 ②）

D1 ② 的四種情況，換成這一章的線：庫存服務 commit 之後 4 秒才回應，訂單服務等 3 秒（`read-timeout` 的預設值）。最後多一種：同一張訂單的預留，**兩次**都沒有回應。

```bash
mvn test -Pexperiments -Dtest=D3TheLineAgainTest
```

```
═══ 3.5 ② 回應遺失：庫存服務 commit 之後 4 秒才回應，訂單服務等 3 秒（load { 4.38 3.88 4.26 }）═══
  補貨 10 件       │ 賣家看到 200（3,292 ms）│ on_hand +10（應該 +10）│ RESTOCK 帳 1 筆
  下單（一般）     │ 買家看到 201（3,171 ms）│ 這位買家的訂單 1 張 │ reserved +1（應該 +1）│ 沒有訂單的預留 0 筆
  下單（熱點）     │ 買家看到 201（3,109 ms）│ 這位買家的訂單 1 張 │ 閘門 -1（應該 −1）│ MySQL 算出來的閘門 9999999、Redis 9999999
  取消（未付款）   │ 買家看到 200（3,075 ms）│ 訂單 CANCELLED／預留 RELEASED
  下單（兩次都沒有回應）│ 買家看到 503 {"type":"/problems/temporarily-unavailable","title":"服務暫時無法使用","status":503,"detail":"庫存服務暫時無法使用，請稍後再試","instance":"/api/orders","traceId":"6ad056c50d43f6da17e6…（6,073 ms）│ 同一個鍵再送一次 201 │ 這位買家的訂單 1 張 │ reserved +2（應該 +1）│ 沒有訂單的預留 1 筆
  庫存服務延後送出的回應：[Hit[method=POST, path=/internal/inventory/v1/products/9000001/restocks, status=204], Hit[method=PUT, path=/internal/inventory/v1/reservations/1, status=204], Hit[method=POST, path=/internal/inventory/v1/hot-gate, status=204], Hit[method=POST, path=/internal/inventory/v1/reservations/3/release, status=204], Hit[method=PUT, path=/internal/inventory/v1/reservations/4, status=204], Hit[method=PUT, path=/internal/inventory/v1/reservations/4, status=204]]
  訂單服務記到的「沒有回應」：{gate-hot=1.0, release=1.0, reserve=3.0, restock=1.0}
```

| | 第 02 章的線（D1 ②） | 這一章的線（D3 ②） |
|---|---|---|
| 補貨 10 件 | 賣家看到 500（10 秒）、再按一次 → **+20** | 賣家看到 200（3.29 秒）→ +10 |
| 下單（一般） | 500、同一個鍵再送 → 1 張訂單、**2 筆預留** | 201（3.17 秒）→ 1 張訂單、1 筆預留 |
| 下單（熱點） | 500、再送 → 閘門 **−2** | 201（3.11 秒）→ 閘門 −1，跟 MySQL 一樣 |
| 取消 | 500、再按一次 → 收斂 | 200（3.08 秒） |
| 下單（兩次都沒有回應） | —— | 503（6.07 秒）、同一個鍵再送 → 1 張訂單、**2 筆預留** |

前四種，庫存服務都收到兩個請求（第一個的回應被延後了），第二個被當成重送 —— 使用者只感覺到慢了 3 秒。

**最後一列是這一章修不好的那一種。** 兩次都等不到：呼叫端回 503（6.07 秒 = 兩個 3 秒），下單的交易 rollback、冪等鍵放掉（US-ORD-1a AC-4）。庫存服務那邊，第一次的預留已經 commit 了（第二次是重送，同一個 orderId）。使用者用同一個鍵重送，是一張**新的**訂單、一個**新的** orderId —— `Inbox` 認不出它們是同一件事，於是又預留一次：`reserved` +2，其中 1 筆的訂單不存在。`shop.remote.no_response` 的 `reserve` 是 3：一般下單的 1 次，加上這一張的 2 次。

這就是第 00 章 0.2.2 ② 的孤兒。那一節的 📌 說得很清楚：冪等鍵擋得住重複的訂單，擋不住這種重複的預留；真正的答案是讓「預留」與「訂單」不再分屬兩個沒有人負責收尾的交易（第 04 章）。這一章讓「一次」回應遺失不再留下痕跡，第 02 章的對帳（X-1）在 5 分鐘後收拾「兩次」的那一筆。

---

## 3.6 服務之間的認證

### 3.6.1 四種做法

| 做法 | 擋得住 | 擋不住 | 代價 |
|---|---|---|---|
| 只靠網路（只有叢集裡連得到） | 外面的人 | 裡面的任何一個行程：被打穿的服務、設錯的 ingress、SSRF | 0 |
| 共用的 API key（一個 header） | 沒有 key 的 | key 外洩之後的任何人；分不出「是哪一個服務」 | 低；換 key 要兩邊一起換 |
| **服務的 JWT**（這一章） | 沒有 token、使用者的 token、發給別的服務的 token、過期的 token；分得出是誰 | 拿到簽章金鑰的人 | 中：金鑰的管理、時鐘 |
| mTLS（或交給服務網格） | 沒有憑證的連線；身分在傳輸層 | 應用層的「誰可以做什麼」還是要自己做 | 高：CA、憑證的發放與輪換（第 08 章） |

這一章選第三種，因為第 12 站已經有一整套 JWT（`AccessTokens`、`SecurityConfig`，第 12 站 5.5）：多一把金鑰、多一條鏈，就是服務之間的認證。

**使用者是誰，庫存服務要不要知道？** 現在不用：庫存服務的每一個操作都是「訂單服務決定之後，請我做」，它信任的是訂單服務（`sub`），不是使用者。另一種做法是把使用者的 JWT 一路往下傳（token relay）—— 庫存服務就要懂使用者的角色、要認使用者的金鑰，兩個服務在「使用者」這件事上又綁在一起了。等真的有「庫存服務要依使用者決定」的需求再說。

### 3.6.2 `ServiceTokens` 與 `InternalApiSecurity`

```java
package com.example.shop.shared.security;

import com.example.shop.shared.config.ConditionalOnServiceRole;
import com.example.shop.shared.config.ServiceRole;
import com.example.shop.shared.config.ShopProperties;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 13 站 3.6：服務之間的 token。跟使用者的 access token（AccessTokens）一樣是 HS256 的 JWT，但是：
 *
 *   另一把金鑰（shop.deployment.service-token.secret）：使用者的 token 在 /internal/** 上驗不過簽章，服務的 token 在 /api/** 上也一樣
 *   iss = shop-services                ：不是 shop（使用者的 token）
 *   sub = 呼叫端的服務（order-service） ：被呼叫的服務據此決定「誰可以呼叫我」（ServiceRole.callers）
 *   aud = 被呼叫的服務（inventory-service）：發給庫存服務的 token，拿去打別的服務是 401
 *   5 分鐘；呼叫端快取起來，到期前 1 分鐘換新的
 *
 * HS256 的代價：驗證的一方也拿著簽發用的金鑰 —— 庫存服務也做得出「訂單服務的 token」。兩個服務、同一個團隊時可以接受；
 * 呼叫端一多，換成非對稱的（RS256：只有簽發的一方有私鑰，其他人拿公鑰驗證），或交給服務網格的 mTLS（第 08 章）。
 */
@Component
@ConditionalOnServiceRole({ServiceRole.ORDER_SERVICE, ServiceRole.INVENTORY_SERVICE})
public class ServiceTokens {

    static final String ISSUER = "shop-services";
    static final Duration RENEW_BEFORE = Duration.ofMinutes(1);

    private record Cached(String token, Instant expiresAt) {}

    private final ServiceRole me;
    private final JwtEncoder encoder;
    private final JwtDecoder decoder;
    private final Duration ttl;
    private final Clock clock;
    private final Map<ServiceRole, Cached> cache = new ConcurrentHashMap<>();

    public ServiceTokens(ShopProperties props, Clock clock) {
        this.me = props.deployment().role();
        this.ttl = props.deployment().serviceToken().ttl();
        this.clock = clock;
        SecretKey key = new SecretKeySpec(props.deployment().serviceToken().secret().getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        this.encoder = new NimbusJwtEncoder(new ImmutableSecret<>(key));
        NimbusJwtDecoder d = NimbusJwtDecoder.withSecretKey(key).macAlgorithm(MacAlgorithm.HS256).build();
        JwtTimestampValidator expiry = new JwtTimestampValidator(SecurityConfig.CLOCK_SKEW);
        expiry.setClock(clock);
        OAuth2TokenValidator<Jwt> forMe = jwt -> jwt.getAudience() != null && jwt.getAudience().contains(me.serviceName())
                ? OAuth2TokenValidatorResult.success()
                : OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "這個 token 不是發給 " + me.serviceName() + " 的", null));
        d.setJwtValidator(new DelegatingOAuth2TokenValidator<>(expiry, new JwtIssuerValidator(ISSUER), forMe));
        this.decoder = d;
    }

    /** 呼叫 audience 用的 token（快取；到期前 1 分鐘才換） */
    public String tokenFor(ServiceRole audience) {
        Instant now = clock.instant();
        Cached c = cache.get(audience);
        if (c != null && now.isBefore(c.expiresAt().minus(RENEW_BEFORE))) return c.token();
        Instant exp = now.plus(ttl);
        JwtClaimsSet claims = JwtClaimsSet.builder().issuer(ISSUER).subject(me.serviceName()).audience(List.of(audience.serviceName()))
                .issuedAt(now).expiresAt(exp).id(UUID.randomUUID().toString()).build();
        String token = encoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
        cache.put(audience, new Cached(token, exp));
        return token;
    }

    /** 驗證「發給我的」服務 token：簽章（服務的金鑰）、到期、iss、aud */
    public JwtDecoder decoder() { return decoder; }

    /** sub → 一個權限 SERVICE_<呼叫端>（InternalApiSecurity 依 ServiceRole.callers 檢查） */
    static JwtAuthenticationConverter authorities() {
        JwtAuthenticationConverter c = new JwtAuthenticationConverter();
        c.setJwtGrantedAuthoritiesConverter(jwt -> List.of(new SimpleGrantedAuthority(authority(jwt.getSubject()))));
        return c;
    }

    static String authority(String serviceName) { return "SERVICE_" + serviceName; }
}
```

跟使用者的 token 比：

| | 使用者的 access token（第 12 站 5.5.1） | 服務的 token |
|---|---|---|
| 金鑰 | `shop.security.jwt-secret` | `shop.deployment.service-token.secret`（**另一把**） |
| `iss` | `shop` | `shop-services` |
| `sub` | 使用者 id | 呼叫端的服務（`order-service`） |
| `aud` | —— | 被呼叫的服務（`inventory-service`） |
| 有效期 | 15 分鐘 | 5 分鐘；呼叫端快取，到期前 1 分鐘換新的 |
| 權限 | `roles` → `ROLE_BUYER` … | `sub` → `SERVICE_order-service` |

兩把金鑰是分開的，所以使用者的 token 在 `/internal/**` 上驗不過簽章，服務的 token 在 `/api/**` 上也一樣。`aud` 讓一個發給庫存服務的 token 拿去打別的服務（之後如果有）是 401。

```java
package com.example.shop.shared.security;

import com.example.shop.shared.config.ConditionalOnServiceRole;
import com.example.shop.shared.config.ServiceRole;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.web.ProblemWriter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 13 站 3.6：庫存服務的 /internal/**。第 12 站 SecurityConfig 那一條鏈管 /api/**（使用者的 token）；這一條排在它前面（@Order(0)），
 * 只管 /internal/**，只認服務的 token（ServiceTokens），而且只讓 ServiceRole.callers() 裡的服務進來（庫存服務：order-service）。
 *
 * 第 02 章的那條線是 permitAll（3.2 ③：沒有 token 就能釋放別人的預留）。網路隔離（只有叢集裡連得到）是另一層，不是這一層的替代品：
 * 同一個網路裡的任何一個行程、一個被打穿的服務、一個設錯的 ingress，都在「裡面」。
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@ConditionalOnServiceRole(ServiceRole.INVENTORY_SERVICE)
class InternalApiSecurity {

    @Bean
    @Order(0)
    SecurityFilterChain internalApi(HttpSecurity http, ServiceTokens tokens, ProblemWriter problems, ShopProperties props) throws Exception {
        ServiceRole me = props.deployment().role();
        String[] allowed = me.callers().stream().map(r -> ServiceTokens.authority(r.serviceName())).toArray(String[]::new);
        AuthenticationEntryPoint unauthenticated = (req, res, ex) -> {
            res.setHeader("WWW-Authenticate", ex instanceof InvalidBearerTokenException ? "Bearer error=\"invalid_token\"" : "Bearer");
            problems.write(req, res, ProblemType.UNAUTHENTICATED, ex instanceof InvalidBearerTokenException ? "服務的 token 無效或已過期" : "需要服務之間的 token");
        };
        AccessDeniedHandler forbidden = (req, res, ex) -> problems.write(req, res, ProblemType.FORBIDDEN, "這個服務不能呼叫 " + me.serviceName());
        return http.securityMatcher("/internal/**")
                .csrf(AbstractHttpConfigurer::disable)
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .httpBasic(AbstractHttpConfigurer::disable)
                .formLogin(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable)
                .requestCache(AbstractHttpConfigurer::disable)
                .authorizeHttpRequests(a -> a.anyRequest().hasAnyAuthority(allowed))
                .oauth2ResourceServer(o -> o
                        .jwt(j -> j.decoder(tokens.decoder()).jwtAuthenticationConverter(ServiceTokens.authorities()))
                        .authenticationEntryPoint(unauthenticated)
                        .accessDeniedHandler(forbidden))
                .exceptionHandling(e -> e.authenticationEntryPoint(unauthenticated).accessDeniedHandler(forbidden))
                .build();
    }

    /**
     * 3.7：庫存服務上沒有使用者的 API。那些 controller 還在 jar 裡、也還是 bean —— 但它們的表不在這個服務的庫裡，
     * 一個走錯的請求（gateway 設錯）會變成 500 Table doesn't exist。在 Spring Security 之前就回 404。
     */
    @Bean
    FilterRegistrationBean<OncePerRequestFilter> userApiNotServedHere(ProblemWriter problems) {
        FilterRegistrationBean<OncePerRequestFilter> r = new FilterRegistrationBean<>(new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                if (req.getRequestURI().startsWith("/api/")) problems.write(req, res, ProblemType.NOT_FOUND, "庫存服務沒有使用者的 API");
                else chain.doFilter(req, res);
            }
        });
        r.setOrder(Ordered.HIGHEST_PRECEDENCE + 50);
        return r;
    }
}
```

- 第 12 站 `SecurityConfig` 的那一條鏈沒有 `securityMatcher`，什麼都管；這一條排在它前面（`@Order(0)`），只管 `/internal/**`。
- **誰可以呼叫**寫在 `ServiceRole.callers()`：庫存服務只收 `order-service`。另一個服務拿著一個簽章正確、`aud` 正確的 token 來，是 403。
- 401 與 403 照第 12 站 5.5.3 的做法，在 filter 裡就寫成 Problem Details。
- 第二個 bean（`/api/**` 一律 404）是 3.7.3 的事。

**HS256 的代價**：驗證的一方也拿著簽發用的金鑰 —— 庫存服務也做得出「訂單服務的 token」。兩個服務、同一個團隊，這可以接受；呼叫端一多，就換成非對稱的（RS256：只有簽發的一方有私鑰，其他人拿公鑰驗證），或者交給服務網格的 mTLS（第 08 章）。

`ServiceRole`、`@ConditionalOnServiceRole` 在 3.7.2：`ServiceTokens` 只在兩個切開的角色裡存在，單體裡沒有它，也不需要那把金鑰。

### 3.6.3 測試：誰進得來

`InventoryServiceApiTest` 的第一個測試，用同一支端點、七種身分各打一次：

```java
        Map<String, String> cases = new LinkedHashMap<>();
        cases.put("沒有 token", null);
        cases.put("買家的 JWT（使用者的金鑰）", TestTokens.bearer(userTokens, 990_999, Role.BUYER, Role.SELLER, Role.ADMIN));
        cases.put("服務 token、簽錯金鑰", "Bearer " + token("order-service", "inventory-service", Duration.ofMinutes(5), "some-other-secret-0123456789abcdef0123"));
        cases.put("服務 token、aud = payment-service", "Bearer " + token("order-service", "payment-service", Duration.ofMinutes(5), SECRET));
        cases.put("服務 token、過期 1 分鐘", "Bearer " + token("order-service", "inventory-service", Duration.ofMinutes(-1), SECRET));
        cases.put("服務 token、sub = notification-service", "Bearer " + token("notification-service", "inventory-service", Duration.ofMinutes(5), SECRET));
        cases.put("服務 token、sub = order-service", "Bearer " + token("order-service", "inventory-service", Duration.ofMinutes(5), SECRET));
        Map<String, Integer> got = new LinkedHashMap<>();
        for (var c : cases.entrySet())
            got.put(c.getKey(), send("POST", "/internal/inventory/v1/reservations/" + order + "/release", c.getValue(), null, null).statusCode());
        got.forEach((k, v) -> System.out.printf("13 站 3.6：%-36s → %d%n", k, v));
        assertThat(got.values()).containsExactly(401, 401, 401, 401, 401, 403, 204);
        HttpResponse<String> user = send("GET", "/api/products", null, null, null);
        System.out.printf("13 站 3.7：庫存服務上的 GET /api/products → %d %s%n", user.statusCode(), user.body());
        assertThat(user.statusCode()).isEqualTo(404);
```

```
13 站 3.6：沒有 token                             → 401
13 站 3.6：買家的 JWT（使用者的金鑰）                      → 401
13 站 3.6：服務 token、簽錯金鑰                        → 401
13 站 3.6：服務 token、aud = payment-service       → 401
13 站 3.6：服務 token、過期 1 分鐘                     → 401
13 站 3.6：服務 token、sub = notification-service  → 403
13 站 3.6：服務 token、sub = order-service         → 204
13 站 3.7：庫存服務上的 GET /api/products → 404 {"type":"/problems/not-found","title":"找不到資源","status":404,"detail":"庫存服務沒有使用者的 API","instance":"/api/products","traceId":"6ad04bcc86d53049f49a0ae636c5d6d1"}
```

「過期 1 分鐘」：服務那一邊的 `JwtTimestampValidator` 容許 5 秒的時鐘誤差（第 12 站 5.5.4），1 分鐘一定過不了。

### 3.6.4 直接打那條線，再跑一次（D3 ③）

D1 ③ 的攻擊，換成這一章的部署：

```
═══ 3.6 ③ 直接打庫存服務：沒有服務的 token（load { 3.85 4.41 4.31 }）═══
  買家 7200001 下單 20261015-480687（orderId 1）：預留 HELD；商品 9000011 可售 9999999
  沒有任何 token，POST /internal/inventory/v1/reservations/1/release → 401 {"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"需要服務之間的 token","instance":"/internal/inventory/v1/reservations/1/release","traceId":"6…
  帶買家的 JWT → 401 {"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"服務的 token 無效或已過期","instance":"/internal/inventory/v1/reservations/1/release","traceId"…
  沒有任何 token，補貨 100 萬件 → 401
    之後：預留 HELD；可售 9999999（+0）；on_hand 10000000
  第 02 章那條線（POST /lab/d02/inventory/release）→ 401（這個部署沒有打開 lab.d02.*）
  買家付款 → 200；賣家撿貨 → 200；出貨 → 200；最後：訂單 SHIPPED／預留 CONSUMED
  （結束時 load { 3.70 4.37 4.30 }）
```

| | 第 02 章的線（D1 ③） | 這一章的線（D3 ③） |
|---|---|---|
| 沒有 token，釋放別人的預留 | 200：預留 `RELEASED`、可售量 +1 | **401**：預留還是 `HELD` |
| 帶買家的 JWT | 200 | **401**（簽章是另一把金鑰） |
| 沒有 token，補貨 100 萬件 | 200 | **401** |
| 那張訂單 | 付款 200、出貨 409，卡在撿貨中 | 付款、撿貨、出貨都 200：`SHIPPED` / `CONSUMED` |

第 02 章的 `/lab/d02/**` 在這個部署上是 401：它是 `lab.d02.*` 打開才有的實驗端點，這裡沒有打開；請求落到第 12 站那一條鏈的 `anyRequest().denyAll()`。

---

## 3.7 同一個 jar、兩個角色

### 3.7.1 為什麼兩個服務會搶同一個佇列

第 12 站的拓撲是**一個消費者一個佇列**（`shop.{consumer}`，第 12 站 7.3.2）：`order.placed` 進來，通知的佇列一份、熱點落帳的佇列一份。同一個佇列有好幾個消費者的時候，RabbitMQ 把訊息**輪流**交給它們 —— 這叫 competing consumers，**它本來是好事**：訂單服務部署三台，三台一起消化通知的佇列，就是水平擴充。

壞的是另一種「好幾個消費者」：**不擁有那個模組的服務**也在收。3.2.2 的庫存服務收到 `order.placed` 要寄通知 —— 它的程式碼一模一樣（同一個 jar），但它的庫裡沒有通知的表；反過來，訂單服務收到「熱點閘門加回去」，它的 Redis 不是庫存服務的那一個。程式碼對、資料不在。

所以要的不是「每個佇列只有一個消費者」，是「**只有擁有那個模組的服務**才收」—— 三台訂單服務照樣一起收通知，庫存服務一則都不收。

### 3.7.2 `ServiceRole` 與兩個 profile

「這個行程擁有哪些模組」寫成一個設定：

```java
package com.example.shop.shared.config;

import java.util.Locale;
import java.util.Set;

/**
 * 13 站 3.7：同一個 jar 的三種部署（shop.deployment.role）。它決定這個行程「擁有」哪些模組：
 * 只有擁有的模組，它的事件消費者才在這個行程裡收訊息（RabbitConsumers）、它的服務之間的 API 才在這個行程裡提供。
 *
 *   monolith          ：第 12 站的單體，九個模組都在這裡
 *   order-service     ：庫存以外的八個模組；InventoryApi 換成走 HTTP 的那一個（inventory.internal.remote）
 *   inventory-service ：只有庫存；提供 /internal/inventory/v1/**，只收 order-service 的呼叫
 */
public enum ServiceRole {
    MONOLITH, ORDER_SERVICE, INVENTORY_SERVICE;

    public boolean owns(String module) {
        return switch (this) {
            case MONOLITH -> true;
            case ORDER_SERVICE -> !module.equals("inventory");
            case INVENTORY_SERVICE -> module.equals("inventory");
        };
    }

    /** 服務的名字：服務之間的 token 用它當 sub（我是誰）與 aud（給誰的） */
    public String serviceName() {
        return name().toLowerCase(Locale.ROOT).replace('_', '-');
    }

    /** 哪些服務可以呼叫我的 internal API（3.6） */
    public Set<ServiceRole> callers() {
        return this == INVENTORY_SERVICE ? Set.of(ORDER_SERVICE) : Set.of();
    }

    /** com.example.shop.<模組>.… → 模組；不在任何模組裡 → "shared" */
    public static String moduleOf(Class<?> type) {
        String n = type.getName();
        if (!n.startsWith("com.example.shop.")) return "shared";
        String rest = n.substring("com.example.shop.".length());
        return rest.contains(".") ? rest.substring(0, rest.indexOf('.')) : "shared";
    }
}
```

`ShopProperties` 多一組 `shop.deployment`：

```java
    public record Deployment(
            @NotNull @DefaultValue("monolith") ServiceRole role,
            @Valid @NotNull @DefaultValue Remote inventory,
            @Valid @NotNull @DefaultValue ServiceToken serviceToken) {

        @jakarta.validation.constraints.AssertTrue(message = "shop.deployment.role=order-service 必須設定 shop.deployment.inventory.url")
        public boolean isInventoryReachable() {
            return role != ServiceRole.ORDER_SERVICE || (inventory.url() != null && !inventory.url().isBlank());
        }

        @jakarta.validation.constraints.AssertTrue(message = "切開的部署必須設定 shop.deployment.service-token.secret（至少 32 bytes，跟 shop.security.jwt-secret 不同）")
        public boolean isServiceTokenConfigured() {
            return role == ServiceRole.MONOLITH || (serviceToken.secret() != null
                    && serviceToken.secret().getBytes(java.nio.charset.StandardCharsets.UTF_8).length >= 32);
        }
    }

    /** 另一個服務：在哪裡、等多久（3.4）。逾時預算（由外而內遞減）是第 06 章的事，這裡先給每一次呼叫一個上限 */
    public record Remote(
            String url,
            @NotNull @DefaultValue("1s") @DurationMin(millis = 100) Duration connectTimeout,
            @NotNull @DefaultValue("3s") @DurationMin(millis = 100) Duration readTimeout) {}

    /** 3.6：服務之間的 token（HS256）。ttl：一個 token 用多久；呼叫端在到期前 1 分鐘換新的 */
    public record ServiceToken(
            String secret,
            @NotNull @DefaultValue("5m") @DurationMin(minutes = 2) @DurationMax(minutes = 60) Duration ttl) {}
```

`@AssertTrue` 讓「切開了，卻少了位址或金鑰」在啟動時就失敗，訊息說得出是哪一個設定（`DeploymentPropertiesTest`，3.7.4）。

只在某幾種角色裡存在的 bean，用一個自己的條件註解：

```java
/**
 * 13 站 3.7：只在這幾種部署裡存在的 bean。
 * 不用 @ConditionalOnProperty(havingValue = "order-service")：它比的是字串，設定寫成 ORDER_SERVICE 時 enum 綁得上、條件卻不成立 ——
 * 這裡用跟 ShopProperties 同一套規則（Binder）把設定綁成 ServiceRole 再比。
 */
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.TYPE, ElementType.METHOD})
@Conditional(ConditionalOnServiceRole.OnServiceRole.class)
public @interface ConditionalOnServiceRole {

    ServiceRole[] value();

    class OnServiceRole implements Condition {
        @Override
        public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
            ServiceRole[] wanted = (ServiceRole[]) metadata.getAnnotationAttributes(ConditionalOnServiceRole.class.getName()).get("value");
            return Arrays.asList(wanted).contains(current(context));
        }

        static ServiceRole current(ConditionContext context) {
            return Binder.get(context.getEnvironment()).bind("shop.deployment.role", ServiceRole.class).orElse(ServiceRole.MONOLITH);
        }
    }
}
```

為什麼不用 `@ConditionalOnProperty(name = "shop.deployment.role", havingValue = "order-service")`：它比的是字串。設定寫成 `ORDER_SERVICE`，`ShopProperties` 照樣綁得上（Spring Boot 的寬鬆綁定），條件卻不成立 —— 那個角色的 bean 不見了，而設定看起來是對的。

兩個角色各一個 profile，跟 `local` 或 `prod` 疊在一起用：

**`src/main/resources/application-order-service.yml`**

```yaml
# 13 站 3.7：同一個 jar 的「訂單服務」—— 庫存以外的八個模組。跟另一個 profile 疊在一起用：
#   本機：--spring.profiles.active=local,order-service      正式：SPRING_PROFILES_ACTIVE=prod,order-service
shop:
  deployment:
    role: order-service
    inventory:
      url: ${SHOP_INVENTORY_URL:http://localhost:8082}
    service-token:
      secret: ${SHOP_SERVICE_TOKEN_SECRET}     # 跟庫存服務同一把；跟 shop.security.jwt-secret 不同
  inventory:
    jobs-enabled: false            # 熱點對帳、INV-2/INV-3 的對帳讀的是庫存的表 —— 那是庫存服務的排程

spring:
  jpa:
    hibernate:
      ddl-auto: none               # 庫存的兩個實體還在 jar 裡、表不在這個庫裡：validate 會讓服務起不來（第 02 章 2.4.6）。
                                   # schema 跟實體對不對得上，改由建置時的 EntitySchemaDriftTest、ServiceDatabaseTest 守
  flyway:                          # 本機（local）才會在啟動時跑；正式環境的 migration 是部署的一個步驟（第 12 站 9.4）
    locations: classpath:db/migration/account,classpath:db/migration/cart,classpath:db/migration/catalog,classpath:db/migration/notification,classpath:db/migration/ordering,classpath:db/migration/payment,classpath:db/migration/shared
```

**`src/main/resources/application-inventory-service.yml`**

```yaml
# 13 站 3.7：同一個 jar 的「庫存服務」—— 只有庫存模組；/internal/inventory/v1/** 只收 order-service 的呼叫。
#   本機：--spring.profiles.active=local,inventory-service   正式：SPRING_PROFILES_ACTIVE=prod,inventory-service
shop:
  deployment:
    role: inventory-service
    service-token:
      secret: ${SHOP_SERVICE_TOKEN_SECRET}
  order:
    jobs-enabled: false            # 逾時取消、自動完成、預留對帳、稽核保存期限：訂單服務的排程
  security:
    bootstrap-admin:
      enabled: false               # 這個庫沒有 users

spring:
  jpa:
    hibernate:
      ddl-auto: none               # 商品、訂單的實體還在 jar 裡、表不在這個庫裡
  flyway:
    locations: classpath:db/migration/inventory,classpath:db/migration/shared
```

- **排程**用第 12 站本來就有的開關：庫存服務不跑逾時取消、對帳；訂單服務不跑熱點對帳。
- **`ddl-auto: none`**：jar 裡有每一個模組的實體，`validate` 會檢查全部（第 02 章 2.4.6 的小坑）。這是一個失去的安全網 —— 「實體對得上表」改由建置時的 `EntitySchemaDriftTest`（第 12 站）與 `ServiceDatabaseTest`（第 02 章）守。
- **Flyway 的資料夾**：本機（`local`）會在啟動時跑；正式環境的 migration 是部署的一個步驟（第 12 站 9.4），那個步驟也要照角色只跑自己的資料夾 —— 部署的設定是第 08 章的事。
- ⚠️ 小坑：**庫存服務起來，還是要有 `shop.security.jwt-secret` 與 `shop.payment.callback-secret`**。`ShopProperties` 的 `@NotBlank` 不知道角色；庫存服務用不到它們，卻非得拿到不可 —— 金鑰散得比需要的廣。這一章沒有改（要改的是第 12 站的驗證規則）。

### 3.7.3 消費者只收自己的模組；拓撲與 relay 不濾

`RabbitConsumers` 只替「擁有的模組」的 handler 開 container：

```diff
 
     RabbitConsumers(List<EventHandler> handlers, ConnectionFactory cf, RabbitTemplate rabbit, EventDispatcher dispatcher,
                     ObjectMapper json, ShopProperties props, Clock clock, MeterRegistry meters, com.example.shop.shared.observability.Traces traces) {
-        this.handlers = handlers;
+        // 13 站 3.7：同一個 jar 部署成兩個服務時，每一個服務只收「自己擁有的模組」的訊息。
+        // 第 12 站是每一個 EventHandler 都開一個 container —— 兩個服務各開一份，同一個佇列就有兩個服務在搶（3.2 ①）：
+        // 輪到訂單服務的那一半，商品的庫存列建不起來、熱點的閘門加回到它自己的 Redis 去了（成功、什麼都沒做）。
+        // 拓撲（RabbitTopology）與 relay 不濾：佇列照樣由每一個服務宣告（誰先起來都一樣），relay 也照樣知道「有沒有人訂閱」——
+        // 那一份清單來自 EventHandler 這些 bean，它們在每一個角色裡都還在
+        com.example.shop.shared.config.ServiceRole role = props.deployment().role();
+        this.handlers = owned(handlers, role);
+        if (this.handlers.size() < handlers.size())
+            log.info("CONSUMERS role={} 收 {}；不收 {}", role.serviceName(), this.handlers.stream().map(EventHandler::consumer).sorted().toList(),
+                    handlers.stream().filter(h -> !this.handlers.contains(h)).map(EventHandler::consumer).sorted().toList());
         this.cf = cf;
         this.rabbit = rabbit;
         this.dispatcher = dispatcher;
…
         this.meters = meters;
         this.traces = traces;
         // 9.10：每一個消費者的延遲在啟動時就有一條序列（ShopConsumerLag）—— 不然在第一則訊息之前，「這個消費者」在 Prometheus 裡不存在
-        for (EventHandler h : handlers) lag(h);
+        for (EventHandler h : this.handlers) lag(h);
+    }
+
+    /** 13 站 3.7：這個角色擁有的模組的消費者（handler 的類別在哪一個模組的套件裡） */
+    static List<EventHandler> owned(List<EventHandler> handlers, com.example.shop.shared.config.ServiceRole role) {
+        return handlers.stream().filter(h -> role.owns(com.example.shop.shared.config.ServiceRole.moduleOf(
+                org.springframework.aop.support.AopUtils.getTargetClass(h)))).toList();
     }
 
     private Timer lag(EventHandler h) {
```

handler 屬於哪一個模組，看它的類別在哪一個套件 —— `InventoryEventHandlers` 用 `@Bean` 回傳的匿名類別，名字是 `…inventory.internal.InventoryEventHandlers$1`，一樣在 `inventory` 底下。

**只濾這一個地方**，另外兩個刻意不濾：

- **拓撲**（`RabbitTopology`）：每一個服務照樣宣告全部的佇列與綁定。宣告是冪等的（同樣的參數，宣告幾次都一樣）。好處：訂單服務先部署、庫存服務還沒起來的時候，`product.created` 照樣有佇列收著，等庫存服務起來再消化 —— 不會因為「還沒有人宣告那個佇列」而被退回。
- **relay**：第 12 站 9.2.1 的 relay 不送「沒有人訂閱的類型」—— `subscribed` 是**這個應用程式裡**每一個 `EventHandler` 的 `eventTypes()`。這一章的做法是 handler 這些 bean 在每一個角色裡都還在，只是不開 container，所以 `subscribed` 還是全部。

  一個看起來更徹底的做法 —— 依角色排除別的模組的 bean（例如自訂 Spring 的元件掃描）—— 會踩到它：訂單服務裡沒有 `inventory.product-created` 這個 handler，它的 relay 會把 `product.created` 當成「沒有人訂閱」，標成已送出、**不送**。商品永遠沒有庫存列，而且沒有任何錯誤（只有一行 `OUTBOX_UNSUBSCRIBED` 的 WARN）。這一段是讀第 12 站的 relay 推出來的，沒有實驗。

另一個要擋的：庫存服務上，第 12 站的使用者 API 還在 —— controller 都是 bean，只是它們的表不在這個服務的庫裡。一個走錯的請求（gateway 設錯）會變成 500 `Table doesn't exist`。`InternalApiSecurity` 的第二個 bean 在 Spring Security 之前就回 404：

```java
    FilterRegistrationBean<OncePerRequestFilter> userApiNotServedHere(ProblemWriter problems) {
        FilterRegistrationBean<OncePerRequestFilter> r = new FilterRegistrationBean<>(new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                if (req.getRequestURI().startsWith("/api/")) problems.write(req, res, ProblemType.NOT_FOUND, "庫存服務沒有使用者的 API");
                else chain.doFilter(req, res);
            }
        });
        r.setOrder(Ordered.HIGHEST_PRECEDENCE + 50);
        return r;
    }
```

### 3.7.4 測試，以及再跑一次 D1 ①

**`ServiceRoleConsumersTest`**：用 jar 裡真的那 6 個 `EventHandler`，看每一個角色會替哪幾個開 container：

```java
    @Test @DisplayName("13 站 3.7：monolith 收 6 個；order-service、inventory-service 各收自己的 3 個，合起來剛好 6 個、沒有重複")
    void eachRoleConsumesOnlyItsOwnModules() {
        Map<ServiceRole, List<String>> got = new TreeMap<>();
        for (ServiceRole role : ServiceRole.values())
            got.put(role, RabbitConsumers.owned(handlers, role).stream().map(EventHandler::consumer).sorted().toList());
        got.forEach((role, consumers) -> System.out.printf("13 站 3.7：%-17s 收 %s%n", role.serviceName(), consumers));

        assertThat(got.get(ServiceRole.MONOLITH)).hasSize(6);
        assertThat(got.get(ServiceRole.ORDER_SERVICE)).containsExactly("notification.order-events", "ordering.stock-shortage", "payment.refunds");
        assertThat(got.get(ServiceRole.INVENTORY_SERVICE)).containsExactly("inventory.hot-settlement", "inventory.hot-stock-return", "inventory.product-created");
        List<String> both = new ArrayList<>(got.get(ServiceRole.ORDER_SERVICE));
        both.addAll(got.get(ServiceRole.INVENTORY_SERVICE));
        assertThat(both).as("切開之後，每一個消費者剛好在一個服務裡").containsExactlyInAnyOrderElementsOf(got.get(ServiceRole.MONOLITH));
    }
```

```
13 站 3.7：monolith          收 [inventory.hot-settlement, inventory.hot-stock-return, inventory.product-created, notification.order-events, ordering.stock-shortage, payment.refunds]
13 站 3.7：order-service     收 [notification.order-events, ordering.stock-shortage, payment.refunds]
13 站 3.7：inventory-service 收 [inventory.hot-settlement, inventory.hot-stock-return, inventory.product-created]
```

新增一個消費者，它自動落在它的類別所在的模組；這個測試的清單要跟著改 —— 改的時候順便想一下：它該在哪一個服務裡收。

**`DeploymentPropertiesTest`**：只綁定 `ShopProperties`（加上 Bean Validation），不起整個應用程式：

```
13 站 3.7：role=order-service、什麼都沒設 → Error creating bean with … yReachable,inventoryReachable]; arguments []; default message [inventoryReachable]]; default message [shop.deployment.role=order-service 必須設定 shop.deployment.inventory.url] | 
13 站 3.7：role=inventory-service、金鑰 9 bytes → Error creating  … gured]; arguments []; default message [serviceTokenConfigured]]; default message [切開的部署必須設定 shop.deployment.service-token.secret（至少 32 bytes，跟 shop.security.jwt-secret 不同）] | 
```

（兩行各 1,473 與 970 個字元，中間用 … 省略。第一行列了兩個錯：`shop.deployment.role=order-service 必須設定 shop.deployment.inventory.url` 在省略的那一段裡，`service-token.secret` 的那一個在最後；第二行只有金鑰那一個。）同一個測試也確認 `role=INVENTORY_SERVICE`（大寫底線）綁得上 —— 3.7.2 那個 `@ConditionalOnProperty` 會失手的寫法。

**D1 ① 的工作負載，換成兩個角色**（D3 ①）：

```
═══ 3.7 ① 同一個 jar 部署兩次，兩個服務都打開 relay 與消費者 —— 這一章的角色（load { 3.22 4.35 4.29 }）═══
  每一個佇列的消費者數：{shop.inventory.hot-settlement=2, shop.inventory.hot-stock-return=2, shop.inventory.product-created=2, shop.notification.order-events=2, shop.ordering.stock-shortage=2, shop.payment.refunds=2}
  建立 20 個商品（期初 100 件）→ 125 ms 後安靜下來；庫存服務的庫裡有庫存列的：20／20
  熱點商品 1：40 位買家各買 1 件，前 20 位取消 → 116 ms 後安靜下來
  消費者                         │ 訂單服務：成功 / 失敗後重試 / 送進死信 │ 庫存服務：成功 / 失敗後重試 / 送進死信 │ 死信佇列
  inventory.hot-settlement       │        0 /          0 /        0 │       40 /          0 /        0 │     0
  inventory.hot-stock-return     │        0 /          0 /        0 │       20 /          0 /        0 │     0
  inventory.product-created      │        0 /          0 /        0 │       20 /          0 /        0 │     0
  notification.order-events      │       60 /          0 /        0 │        0 /          0 /        0 │     0
  ordering.stock-shortage        │        0 /          0 /        0 │        0 /          0 /        0 │     0
  payment.refunds                │        0 /          0 /        0 │        0 /          0 /        0 │     0
  熱點落帳：沒有取消的 20 張，計入 reserved 的 20 張、還沒計入的 0 張
  熱點閘門（庫存服務的 Redis）stock:1 = 80；MySQL 算出來應該是 80
  通知（訂單服務的庫）：應該 60 封（成立 40、取消 20），SENT 60 封、FAILED 0 封
  （結束時 load { 4.03 4.48 4.33 }）
```

| | 第 02 章的程式碼（D1 ①） | 兩個角色（D3 ①） |
|---|---|---|
| 每一個佇列的消費者 | 4 個（兩個服務各 2） | 2 個 |
| 失敗後重試 | `product-created` 18、`hot-settlement` 38、通知 59 | 0 |
| 死信 | 通知 1 則（三次裡的一次） | 0 |
| 熱點閘門：Redis / MySQL | 70 / 80 | **80 / 80** |
| 通知 | 59 封（第 60 封只在死信佇列裡） | 60 封 |
| 安靜下來 | 1,566 ms、1,642 ms | 125 ms、116 ms |

### 3.7.5 使用者的一天，事件走 broker（D4）

第 02 章的實驗與 D2，事件都是工作負載自己讀 outbox、交給另一個服務的消費者。D4 換成真的：兩個服務各自的 relay 把自己的 outbox 送到 RabbitMQ，各自的消費者只收自己的模組。工作負載裡原本「交付事件」的地方，改成等 broker 安靜下來（`D01Workload` 多一個 `broker` 欄位，3.10.1）。

```bash
mvn test -Pexperiments -Dtest=D4BrokerDayTest
```

```
═══ 3.7.5 使用者的一天，事件走 RabbitMQ：兩個服務、正式的角色（load { 3.70 4.37 4.30 }）═══
  每一個佇列的消費者數：{shop.inventory.hot-settlement=2, shop.inventory.hot-stock-return=2, shop.inventory.product-created=2, shop.notification.order-events=2, shop.ordering.stock-shortage=2, shop.payment.refunds=2}
  使用者的一天：61 個 HTTP 請求全部是預期的回應；等事件 21 次、一共 2,980 ms；整天 27,514 ms
  消費者                         │ 訂單服務：成功 / 失敗後重試 / 送進死信 │ 庫存服務：成功 / 失敗後重試 / 送進死信 │ 死信佇列
  inventory.hot-settlement       │        0 /          0 /        0 │        6 /          0 /        0 │     0
  inventory.hot-stock-return     │        0 /          0 /        0 │        4 /          0 /        0 │     0
  inventory.product-created      │        0 /          0 /        0 │        4 /          0 /        0 │     0
  notification.order-events      │       18 /          0 /        0 │        0 /          0 /        0 │     0
  ordering.stock-shortage        │        1 /          0 /        0 │        0 /          0 /        0 │     0
  payment.refunds                │        2 /          0 /        0 │        0 /          0 /        0 │     0
  shop_d02_order  outbox：送出 26 筆、還沒送 0 筆；processed_messages 1 列
  shop_d02_inv    outbox：送出 5 筆、還沒送 0 筆；processed_messages 21 列
  通知（訂單服務的庫）：SENT 22 封、FAILED 0 封；訂單 6 張的狀態：COMPLETED,CANCELLED,CANCELLED,CANCELLED,COMPLETED,CANCELLED
  （結束時 load { 3.75 4.31 4.28 }）
```

- **61 個請求全部是預期的回應**，6 張訂單的最後狀態跟第 01 章的劇本一樣（2 張完成、4 張取消：買家取消、賣家取消、逾時、熱點落帳不足）。
- **每一個消費者都在對的服務裡**，0 次重試、0 則死信。
- **兩個 outbox 都送完了**：訂單服務 26 筆、庫存服務 5 筆（4 個「熱點閘門加回去」、1 個「熱點落帳不足」）。
- **`processed_messages`**：庫存服務 21 列 = 事件 14 個（熱點落帳 6、`product.created` 4、閘門加回去 4）+ HTTP 命令 7 個（`inventory.http.reserve` 6、`inventory.http.restock` 1）—— 3.5.2 的 `Inbox` 跟事件的消費者用的是同一張表。訂單服務 1 列（`ordering.stock-shortage`）：通知與退款的消費者自己負責冪等（第 12 站 7.7、7.8），不寫這張表。
- 「等事件 21 次、一共 2,980 ms」是每一次「最後一個變化」之前的時間；確認安靜的那 1 秒不算（`Flow.quiet`）—— 21 次就是 21 秒，所以整天要 27.5 秒。

### 3.7.6 用 jar 起兩個行程

實驗都是兩個 Spring context 在同一個 JVM 裡。最後用打包好的 jar，起兩個真的行程，從外面打。兩個庫、一個 vhost 先用 root 建好（給 `shop_migrator` 權限，跟第 02 章一樣），然後：

```bash
mvn -q -DskipTests package
export SHOP_SERVICE_TOKEN_SECRET=local-dev-only-service-token-secret-0123456789
URL='?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true'

# 庫存服務：8082
java -jar target/shop-0.0.1-SNAPSHOT.jar --spring.profiles.active=local,inventory-service --server.port=8082 \
  --spring.datasource.url="jdbc:mysql://localhost:3306/shop_d03_inv$URL" \
  --spring.data.redis.database=7 --spring.rabbitmq.virtual-host=shop_d03 &

# 訂單服務：8080
SHOP_INVENTORY_URL=http://localhost:8082 java -jar target/shop-0.0.1-SNAPSHOT.jar --spring.profiles.active=local,order-service --server.port=8080 \
  --spring.datasource.url="jdbc:mysql://localhost:3306/shop_d03_order$URL" \
  --spring.data.redis.database=6 --spring.rabbitmq.virtual-host=shop_d03 &
```

接著用 `curl` 走一遍：管理員登入（`local` 的第一個管理員）、註冊賣家並給他 SELLER、建立商品、上架、註冊買家、下單；然後用 root 看兩個庫。每一步的輸出：

```
  :8082 readiness → 200
  :8080 readiness → 200
$ 兩個服務的啟動日誌裡，Flyway 跑了幾個 migration、收哪些佇列
Successfully applied 9 migrations to schema `shop_d03_inv`, now at version v25 (execution time 00:00.261s)
CONSUMERS role=inventory-service 收 [inventory.hot-settlement, inventory.hot-stock-return, inventory.product-created]；不收 [notification.order-events, ordering.stock-shortage, payment.refunds]
Successfully applied 20 migrations to schema `shop_d03_order`, now at version v23 (execution time 00:00.537s)
CONSUMERS role=order-service 收 [notification.order-events, ordering.stock-shortage, payment.refunds]；不收 [inventory.hot-settlement, inventory.hot-stock-return, inventory.product-created]
$ 庫存服務的庫裡有哪些表
audit_logs,inventory,inventory_ledger,inventory_ledger_checkpoints,inventory_ledger_watermark,inventory_reservations,outbox_events,processed_messages
$ curl -s localhost:8082/api/products
{"type":"/problems/not-found","title":"找不到資源","status":404,"detail":"庫存服務沒有使用者的 API","instance":"/api/products","traceId":"6ad051ca388c6e7643d3dc7021f32dc0"} → 404
$ curl -s -X POST localhost:8082/internal/inventory/v1/reservations/1/release
{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"需要服務之間的 token","instance":"/internal/inventory/v1/reservations/1/release","traceId":"6ad051ca379ddc4920cd1b4216862018"} → 401
$ curl -s localhost:8080/internal/inventory/v1/stock?productIds=1
{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"需要登入","instance":"/internal/inventory/v1/stock","traceId":"6ad051ca4216bbcf43d8c150ae1c532c"} → 401
$ 賣家建立商品（期初 100 件）
  商品 1
$ 1 秒後：賣家的商品列表（可售量從庫存服務來）
{'id': 1, 'name': 'd03 兩個行程', 'price': 100.0, 'status': 'DRAFT', 'categoryId': 11, 'available': 100, 'updatedAt': '2026-10-15T04:08:42.908Z'}
  上架 → 200
$ 買家下單 1 件
{"orderNo":"20261015-060297","status":"PENDING_PAYMENT","totalAmount":100.00,"createdAt":"2026-10-15T04:08:44.712Z","paymentDeadline":"2026-10-15T04:23:44.712Z","items":[{"productId":1,"productName":"d03 兩個行程","unitPrice":100.00,"quantity":1,"lineAmount":100.00}]} → 201
$ 庫存服務的庫
+------------+---------+----------+
| product_id | on_hand | reserved |
+------------+---------+----------+
|          1 |     100 |        1 |
+------------+---------+----------+
+----------+------------+----------+--------+
| order_id | product_id | quantity | status |
+----------+------------+----------+--------+
|        1 |          1 |        1 | HELD   |
+----------+------------+----------+--------+
+---------------------------+--------------------------------------+
| consumer                  | message_id                           |
+---------------------------+--------------------------------------+
| inventory.hot-settlement  | 4de06446-4643-4e36-8728-dfc28f175c0d |
| inventory.http.reserve    | 1                                    |
| inventory.product-created | 38fbb2f5-a405-42da-9aa6-12c5176a9d6a |
+---------------------------+--------------------------------------+
$ 訂單服務的庫
+----+-----------------+-----------------+
| id | order_no        | status          |
+----+-----------------+-----------------+
|  1 | 20261015-060297 | PENDING_PAYMENT |
+----+-----------------+-----------------+
+--------------+--------+
| type         | status |
+--------------+--------+
| ORDER_PLACED | SENT   |
+--------------+--------+
$ 關掉兩個行程
  :8080 已經放掉
```

- 兩個服務各自只跑了自己的 migration（庫存 9 個、訂單 20 個），各自只收自己的 3 個佇列。
- 庫存服務的庫：庫存的 5 張表，加上 `shared` 的 3 張。
- `/api/**` 在庫存服務上 404；`/internal/**` 在庫存服務上沒有服務的 token 是 401；在訂單服務上也是 401 —— 那裡沒有這支 controller，請求落到第 12 站那一條鏈的 `denyAll()`。
- 建立商品 1 秒之後，賣家的商品列表裡可售量是 100：`product.created` 經過 RabbitMQ 到了庫存服務，賣家的列表再經過 `GET /internal/inventory/v1/stock` 讀回來。
- 下單之後，庫存服務的庫：預留 `HELD`、`reserved = 1`；`processed_messages` 裡同時有事件的消費者（`inventory.product-created`、`inventory.hot-settlement`）與 HTTP 命令（`inventory.http.reserve`，鍵是 orderId `1`）。訂單服務的庫：訂單待付款、通知已寄出。

> ⚠️ 這兩個行程的全域限流（第 12 站 0.6.5 的「每個 IP 每秒 50 次」）是開著的，只是這一節的請求太少，看不到它。庫存服務也跑同一個 filter，而訂單服務的每一個呼叫都從同一個 IP 來：每秒呼叫超過 50 次，預留就被 429，買家拿到 500。第 08 章之前的實驗都用 `shop.rate-limit.enabled=false` 起服務，看不到它；第 08 章搬到 K8s、用正式的設定量到它（8.6.3）。修法也在那一節：帶著發給庫存服務的服務 token 的 `/internal/**`，不算進每個 IP 的額度。

---

## 3.8 契約測試：Pact

### 3.8.1 同一個 repo，為什麼還需要

伺服端與呼叫端在同一個 repo、同一個 jar 裡。改了伺服端的回應，呼叫端編譯不過或測試紅，**同一個 commit 裡**就會一起改好 —— 這正是問題：測試永遠是「第 N 版的呼叫端」對「第 N 版的伺服端」。

線上不是這樣。部署是一個服務一個服務來的：

- **滾動部署的那幾分鐘**：庫存服務一台一台換成新版，訂單服務還是舊版。
- **訂單服務還沒升級的那幾天**：兩個服務各自決定什麼時候部署（第 00 章說這是拆分的好處之一）。
- **回滾**：新版的訂單服務出事，退回上一版 —— 庫存服務已經是新的。

這些時候，跑在線上的是「第 N−1 版的呼叫端」對「第 N 版的伺服端」，**而 repo 裡的任何一個測試都沒有跑過這個組合**。

契約測試把「呼叫端怎麼用對方」寫成一份檔案（契約），讓提供端拿去驗證：

- **呼叫端寫契約**（consumer-driven）：只寫它真的用到的請求與回應欄位。提供端可以自由加欄位、加端點；不能拿掉、改掉契約上寫了的。
- **提供端驗證**：照契約把請求送給真的提供端，檢查回應。
- **「線上那一版」的契約**單獨留一份。提供端每一次建置都驗證它 —— 這一份綠，才能部署。

第 12 站 3.8.2 的 API 快照（`OpenApiContractTest`）守的是使用者的 API：任何改動都要人看一眼。它從提供端看，不知道哪一個改動會弄壞哪一個呼叫端。Pact 從呼叫端看。

### 3.8.2 加依賴；failsafe

```diff
     <test.infra>testcontainers</test.infra>
     <!-- 8.4.1：Boot 3.2.5 管理的是 1.19.7。它跟 Docker Engine 29（最低 API 1.44）講不上話，錯誤訊息卻是「找不到 Docker」；1.21.3 也一樣，1.21.4 才可以 -->
     <testcontainers.version>1.21.4</testcontainers.version>
+    <!-- 13 站 3.8：契約測試 -->
+    <pact.version>4.6.17</pact.version>
   </properties>
   <dependencies>
     <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
…
     <dependency><groupId>org.testcontainers</groupId><artifactId>mysql</artifactId><scope>test</scope></dependency>
     <dependency><groupId>org.testcontainers</groupId><artifactId>rabbitmq</artifactId><scope>test</scope></dependency>
     <dependency><groupId>org.junit.platform</groupId><artifactId>junit-platform-launcher</artifactId><scope>test</scope></dependency>
+    <!-- 13 站 3.8：Pact。呼叫端的測試（surefire）產生契約 target/pacts；提供端在 failsafe 那一段驗證它 -->
+    <dependency><groupId>au.com.dius.pact.consumer</groupId><artifactId>junit5</artifactId><version>${pact.version}</version><scope>test</scope></dependency>
+    <dependency><groupId>au.com.dius.pact.provider</groupId><artifactId>junit5</artifactId><version>${pact.version}</version><scope>test</scope></dependency>
   </dependencies>
   <build>
     <plugins>
…
           <systemPropertyVariables><shop.test.infra>${test.infra}</shop.test.infra></systemPropertyVariables>
         </configuration>
       </plugin>
+      <!-- 13 站 3.8：提供端的契約驗證（*PactIT）在 surefire 之後才跑：呼叫端的測試先把這一次的契約寫進 target/pacts。
+           同一個 surefire 裡，測試類別的順序不保證 —— 驗證可能跑在產生之前。Boot 的 parent 已經把 classesDirectory 設成 target/classes -->
+      <plugin>
+        <groupId>org.apache.maven.plugins</groupId>
+        <artifactId>maven-failsafe-plugin</artifactId>
+        <executions><execution><goals><goal>integration-test</goal><goal>verify</goal></goals></execution></executions>
+        <configuration>
+          <includes><include>**/*PactIT.java</include></includes>
+          <systemPropertyVariables><shop.test.infra>${test.infra}</shop.test.infra></systemPropertyVariables>
+        </configuration>
+      </plugin>
       <!-- 第 08 章（8.7）：覆蓋率。prepare-agent 把 JaCoCo 的 agent 掛到 surefire 的 JVM 上（argLine）；report 在 verify 產生 target/site/jacoco -->
       <plugin>
         <groupId>org.jacoco</groupId>
```

**為什麼提供端的驗證放在 failsafe**：呼叫端的測試產生契約（寫進 `target/pacts`），提供端的驗證讀它 —— 順序很重要。同一個 surefire 裡，測試類別的順序不保證；放進 failsafe（`mvn verify` 的 `integration-test` 階段，在 surefire 之後），順序就是確定的。名字以 `PactIT` 結尾的才給 failsafe 跑，其他的照舊是 surefire。failsafe 是另一個 JVM，`TestInfra` 會替它再起一組容器（3.10 的輸出裡第二個「testcontainers 啟動」）。

### 3.8.3 呼叫端的契約

`InventoryClientPactTest`：一個互動一個 `@Pact` 方法、一個 `@Test`。跑的是**真的** `RemoteInventoryApi`（→ `InventoryClient` → `RestClient`），對面是 Pact 的 mock server —— 它只回應寫好的請求；送出去的請求跟契約不一樣（路徑、欄位、標頭），這個測試就紅。

```java
@ExtendWith(PactConsumerTestExt.class)
@PactTestFor(providerName = "inventory-service", pactVersion = PactSpecVersion.V3)   // ⚠️ 4.6 預設 V4：RequestResponsePact 的寫法要指定 V3（3.8.3）
class InventoryClientPactTest {

    static final String BEARER = "Bearer [A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+";
    static final String EXAMPLE_TOKEN = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcmRlci1zZXJ2aWNlIn0.c2lnbmF0dXJl";
    /**
     * ⚠️ 錯誤的回應是 Problem Details（RFC 9457）：application/problem+json。第一版沒寫，PactDslJsonBody 自動當成 application/json ——
     * 呼叫端的測試照樣綠（mock server 照我寫的回），提供端的驗證三個錯誤互動全紅（3.8.4）
     */
    static final Map<String, String> PROBLEM = Map.of("Content-Type", "application/problem+json");
    static final String UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
```

預留，以及預留失敗：

```java
    @Pact(consumer = "order-service")
    RequestResponsePact reserve(PactDslWithProvider b) {
        return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
                .uponReceiving("一張訂單的預留").method("PUT").path("/internal/inventory/v1/reservations/7001")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .body("{\"lines\":[{\"productId\":9001,\"quantity\":2}],\"hotLines\":[]}", "application/json")
                .willRespondWith().status(204)
                .toPact();
    }

    @Test @PactTestFor(pactMethod = "reserve")
    void reserve(MockServer server) {
        api(server).reserve(7001L, List.of(new ReserveLine(9001, 2)), List.of());
    }

    @Pact(consumer = "order-service")
    RequestResponsePact reserveInsufficient(PactDslWithProvider b) {
        return b.given("商品 9001 只有 1 件可售")
                .uponReceiving("預留超過可售量").method("PUT").path("/internal/inventory/v1/reservations/7002")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .body("{\"lines\":[{\"productId\":9001,\"quantity\":2}],\"hotLines\":[]}", "application/json")
                .willRespondWith().headers(PROBLEM).status(409)
                .body(new PactDslJsonBody().stringValue("type", "/problems/insufficient-stock").integerType("productId", 9001))
                .toPact();
    }

    @Test @PactTestFor(pactMethod = "reserveInsufficient")
    void reserveInsufficient(MockServer server) {
        assertThatThrownBy(() -> api(server).reserve(7002L, List.of(new ReserveLine(9001, 2)), List.of()))
                .isInstanceOfSatisfying(InsufficientStockException.class, e -> assertThat(e.productId()).isEqualTo(9001L));
    }
```

- **請求寫死、回應寫型別**：訂單服務送什麼是它自己決定的，寫成確切的 JSON；回應只寫「這個欄位要在、是整數」（`integerType`），值是範例。
- **`given(...)` 是前提**：提供端驗證時，Pact 先叫提供端把資料擺成這個樣子（3.8.4 的 `@State`）。
- **`Authorization` 用正規表示式**：契約裡只存範例值，提供端驗證時換成真的 token。
- ⚠️ 小坑：Pact JVM 4.6 預設是 V4 的契約，`RequestResponsePact` 這種寫法要在 `@PactTestFor` 指定 `PactSpecVersion.V3`。沒指定的時候，15 個方法全部錯在同一句：

```
Method reserve does not conform required method signature 'public au.com.dius.pact.core.model.V4Pact xxx(PactBuilder builder)'
```

15 個互動，涵蓋訂單服務用到的每一支端點（含使用者的一天沒走到的 `reservations/query`、`hot-gate/returns`）與三種業務錯誤。跑完之後，Pact 寫出 `target/pacts/order-service-inventory-service.json`。其中一個互動長這樣（檔案裡的中文是 `\uXXXX` 跳脫的，這裡解開來印）：

```json
{
  "description": "一張訂單的預留",
  "providerStates": [
    {
      "name": "商品 9001 有 10 件可售，商品 9002 沒有庫存列"
    }
  ],
  "request": {
    "body": {
      "hotLines": [],
      "lines": [
        {
          "productId": 9001,
          "quantity": 2
        }
      ]
    },
    "headers": {
      "Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcmRlci1zZXJ2aWNlIn0.c2lnbmF0dXJl",
      "Content-Type": "application/json"
    },
    "matchingRules": {
      "header": {
        "Authorization": {
          "combine": "AND",
          "matchers": [
            {
              "match": "regex",
              "regex": "Bearer [A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+"
            }
          ]
        }
      }
    },
    "method": "PUT",
    "path": "/internal/inventory/v1/reservations/7001"
  },
  "response": {
    "status": 204
  }
}
```

### 3.8.4 提供端的驗證

`InventoryProviderContract`：庫存服務用它正式的角色起來（自己的庫，跟 `InventoryServiceApiTest` 一樣的做法），Pact 把契約裡的每一個互動照原樣送過來：

```java
package com.example.shop.inventory.internal.web;

import au.com.dius.pact.provider.junit5.HttpTestTarget;
import au.com.dius.pact.provider.junit5.PactVerificationContext;
import au.com.dius.pact.provider.junit5.PactVerificationInvocationContextProvider;
import au.com.dius.pact.provider.junitsupport.State;
import com.example.shop.support.TestInfra;
import org.apache.hc.core5.http.HttpRequest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.TestTemplate;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.time.Duration;

/**
 * 13 站 3.8：提供端的驗證。庫存服務用它正式的角色起來（跟 InventoryServiceApiTest 一樣：自己的庫、只有 inventory 與 shared 兩個資料夾），
 * Pact 把契約裡的每一個互動照原樣送過來（路徑、查詢參數、內容），檢查回應是不是契約寫的那樣（狀態碼、寫了的欄位、型別）。
 *
 * 契約裡的 Authorization 是呼叫端測試時的範例值（一個假的 token）：送出之前換成一個真的、發給 inventory-service 的服務 token。
 * 每一個互動之前，Pact 先呼叫它的「前提」（@State）：這裡用 SQL 與 Redis 把資料擺成那個樣子。
 *
 * 兩個子類別，驗證兩份契約：
 *   InventoryProviderPactIT         —— 這一次建置、呼叫端的測試剛產生的（target/pacts）
 *   InventoryProviderReleasedPactIT —— 線上那一版訂單服務的（src/test/resources/pacts/released，3.8.5）
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "shop.deployment.role=inventory-service", "shop.deployment.service-token.secret=" + InventoryProviderContract.SECRET,
        "shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false", "shop.security.bootstrap-admin.enabled=false",
        "spring.jpa.hibernate.ddl-auto=none", "spring.flyway.locations=classpath:db/migration/inventory,classpath:db/migration/shared",
        "spring.data.redis.database=6"})
abstract class InventoryProviderContract {

    static final String SECRET = "inventory-provider-pact-secret-0123456789";
    static final String DB = "shop_svc_inventory_pact";
    static volatile String url;

    @DynamicPropertySource
    static void ownDatabase(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> {
            if (url == null) {                                              // 只建一次（InventoryServiceApiTest 的 ⚠️）
                JdbcTemplate admin = TestInfra.adminJdbc();
                admin.execute("DROP DATABASE IF EXISTS " + DB);
                admin.execute("CREATE DATABASE " + DB);
                admin.execute("GRANT ALL PRIVILEGES ON `" + DB + "`.* TO 'shop_migrator'@'%' WITH GRANT OPTION");
                url = TestInfra.jdbcUrl(DB);
            }
            return url;
        });
    }

    @LocalServerPort int port;
    @Autowired StringRedisTemplate redis;

    @BeforeEach
    void target(PactVerificationContext context) {
        context.setTarget(new HttpTestTarget("127.0.0.1", port));
    }

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider.class)
    void verify(PactVerificationContext context, HttpRequest request) {
        request.setHeader("Authorization", "Bearer " + InventoryServiceApiTest.token("order-service", "inventory-service", Duration.ofMinutes(5), SECRET));
        context.verifyInteraction();
    }

    // ───────── 前提：每一個都從乾淨的資料開始 ─────────

    @State("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
    void stock10() { clean(); stock(9001, 10, 0); }

    @State("商品 9001 只有 1 件可售")
    void stock1() { clean(); stock(9001, 1, 0); }

    @State("訂單 7001 有一筆 HELD 的預留")
    void held7001() { clean(); stock(9001, 10, 1); reservation(7001, 9001, "HELD", true, null); }

    @State("訂單 7001 有一筆 HELD 的預留，建立在 2026-01-01")
    void oldHeld7001() { clean(); stock(9001, 10, 1); reservation(7001, 9001, "HELD", true, "2026-01-01 00:00:00"); }

    @State("訂單 7003 的預留已確認")
    void confirmed7003() { clean(); stock(9001, 10, 1); reservation(7003, 9001, "CONFIRMED", true, null); }

    @State("訂單 7004 的熱點預留已確認、還沒落帳")
    void unsettled7004() { clean(); stock(9005, 10, 0); reservation(7004, 9005, "CONFIRMED", false, null); }

    @State("商品 9005 是熱點，閘門有 10 件")
    void gate10() { clean(); stock(9005, 10, 0); redis.opsForValue().set("stock:9005", "10"); }

    @State("商品 9005 是熱點，閘門有 0 件")
    void gate0() { clean(); stock(9005, 10, 0); redis.opsForValue().set("stock:9005", "0"); }

    @Autowired JdbcTemplate jdbc;

    /** 帳（inventory_ledger）只能新增（INV-5）：清理用 root；帳的外鍵讓庫存列刪不掉，所以庫存列用「改」的 */
    void clean() {
        JdbcTemplate admin = TestInfra.adminJdbc();
        admin.update("DELETE FROM " + DB + ".inventory_reservations");
        admin.update("DELETE FROM " + DB + ".processed_messages");
        admin.update("UPDATE " + DB + ".inventory SET on_hand = 0, reserved = 0");
        var keys = redis.keys("*");                                          // 這個 context 的 Redis 是 6 號 database，只有這個測試在用
        if (keys != null && !keys.isEmpty()) redis.delete(keys);
    }

    void stock(long product, int onHand, int reserved) {
        jdbc.update("""
                INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, ?) AS n
                ON DUPLICATE KEY UPDATE on_hand = n.on_hand, reserved = n.reserved""", product, onHand, reserved);
    }

    void reservation(long order, long product, String status, boolean counted, String createdAt) {
        jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status, counted, created_at) VALUES (?, ?, 1, ?, ?, "
                + (createdAt == null ? "CURRENT_TIMESTAMP(3)" : "'" + createdAt + "'") + ")", order, product, status, counted);
    }
}
```

```java
package com.example.shop.inventory.internal.web;

import au.com.dius.pact.provider.junitsupport.Provider;
import au.com.dius.pact.provider.junitsupport.loader.PactFolder;

/** 13 站 3.8.4：驗證這一次建置的契約 —— 呼叫端的測試（InventoryClientPactTest）剛寫出來的 target/pacts */
@Provider("inventory-service")
@PactFolder("target/pacts")
class InventoryProviderPactIT extends InventoryProviderContract {
}
```

```bash
mvn verify -Dtest=InventoryClientPactTest -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=InventoryProviderPactIT
```

⚠️ **錯誤的回應沒有標 `application/problem+json`，15 個互動紅 3 個**：

```
1) Verifying a pact between order-service and inventory-service - 預留超過可售量 includes headers "Content-Type" with value "[application/json; charset=UTF-8]"
1) Verifying a pact between order-service and inventory-service - 熱點閘門：搶不到 includes headers "Content-Type" with value "[application/json; charset=UTF-8]"
1) Verifying a pact between order-service and inventory-service - 出貨：熱點還在落帳 includes headers "Content-Type" with value "[application/json; charset=UTF-8]"
[ERROR] Tests run: 15, Failures: 3, Errors: 0, Skipped: 0, Time elapsed: 20.45 s <<< FAILURE! -- in com.example.shop.inventory.internal.web.InventoryProviderPactIT
[ERROR] Tests run: 15, Failures: 3, Errors: 0, Skipped: 0
```

三個都是錯誤的回應（庫存不足、閘門搶不到、還在落帳），都錯在 `Content-Type`。在契約裡用 `PactDslJsonBody` 寫錯誤的內容，它自動把回應標成 `application/json`；庫存服務回的是 `application/problem+json`（第 12 站的 Problem Details，RFC 9457）。**呼叫端的測試是綠的**：mock server 照契約寫的回，`RemoteInventoryApi` 又不看 Content-Type。

這不是庫存服務的 bug，是契約寫錯了：它說的不是提供端真的會做的事。修的是契約：

```java
    /**
     * ⚠️ 錯誤的回應是 Problem Details（RFC 9457）：application/problem+json。第一版沒寫，PactDslJsonBody 自動當成 application/json ——
     * 呼叫端的測試照樣綠（mock server 照我寫的回），提供端的驗證三個錯誤互動全紅（3.8.4）
     */
    static final Map<String, String> PROBLEM = Map.of("Content-Type", "application/problem+json");
```

（三個錯誤的互動加上 `.headers(PROBLEM)`。）再跑一次：

```
[INFO] Tests run: 15, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.773 s -- in com.example.shop.inventory.internal.remote.InventoryClientPactTest
[INFO] Tests run: 15, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 20.02 s -- in com.example.shop.inventory.internal.web.InventoryProviderPactIT
```

小坑：「出貨：熱點還在落帳」那一個互動花了 5 秒。回應帶著 `Retry-After: 5`（第 12 站的 `GlobalExceptionHandler` 對有 `retryAfter` 的錯誤都加這個標頭），Pact 送請求用的 Apache HttpClient 5 是 `HttpClients.custom()` 建的、沒有關掉自動重試 —— 它的預設策略看到 503 加 `Retry-After`，會等那麼久再送一次。（從 Pact 的 jar 裡的類別看到的；伺服端收到幾次，沒有數。）

### 3.8.5 版本不相容：一次真的被抓到的改名

**「發布」這一份契約。** 部署訂單服務的時候，把那一次建置的 `target/pacts` 複製到 `src/test/resources/pacts/released/`（一個檔案、一個 commit），提供端多驗證這一份：

```java
package com.example.shop.inventory.internal.web;

import au.com.dius.pact.provider.junitsupport.Provider;
import au.com.dius.pact.provider.junitsupport.loader.PactFolder;

/**
 * 13 站 3.8.5：驗證「線上那一版訂單服務」的契約。部署訂單服務的時候，把那一次建置的 target/pacts 複製到這裡（一份檔案、一個 commit）。
 * 同一個 repo 裡，呼叫端與提供端在同一個 commit 裡一起改，InventoryProviderPactIT 永遠是綠的 —— 線上那一版的呼叫端不會跟著改。
 * 庫存服務要部署之前，這一份必須是綠的：滾動部署的那幾分鐘、以及訂單服務還沒升級的那幾天，庫存服務的新版要服務的是它。
 */
@Provider("inventory-service")
@PactFolder("src/test/resources/pacts/released")
class InventoryProviderReleasedPactIT extends InventoryProviderContract {
}
```

```
[INFO] Tests run: 15, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.863 s -- in com.example.shop.inventory.internal.remote.InventoryClientPactTest
[INFO] Tests run: 15, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 21.17 s -- in com.example.shop.inventory.internal.web.InventoryProviderReleasedPactIT
[INFO] Tests run: 15, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 5.455 s -- in com.example.shop.inventory.internal.web.InventoryProviderPactIT
```

**一次改名。** 假設庫存服務的團隊覺得 `available` 不夠清楚，把它改成 `availableQuantity`。在同一個 repo 裡，這是 IDE 的一次 rename —— 伺服端與呼叫端一起改：

```diff
--- a/src/main/java/com/example/shop/inventory/internal/web/InventoryWire.java
+++ b/src/main/java/com/example/shop/inventory/internal/web/InventoryWire.java
-    public record StockLevel(long productId, int available) {}
+    public record StockLevel(long productId, int availableQuantity) {}
--- a/src/main/java/com/example/shop/inventory/internal/remote/RemoteInventoryApi.java
+++ b/src/main/java/com/example/shop/inventory/internal/remote/RemoteInventoryApi.java
-        return call("display", () -> client.display(productId, hot)).available();
+        return call("display", () -> client.display(productId, hot)).availableQuantity();
…
-        call("stock", () -> client.stock(List.copyOf(productIds))).items().forEach(s -> out.put(s.productId(), s.available()));
+        call("stock", () -> client.stock(List.copyOf(productIds))).items().forEach(s -> out.put(s.productId(), s.availableQuantity()));
```

（在一個分支上做，看完就丟掉 —— 下面兩次 `mvn clean verify` 的輸出是那個分支上的。）

第一次 `mvn clean verify`：

```
[ERROR] com.example.shop.inventory.internal.remote.InventoryClientPactTest.stock(MockServer) -- Time elapsed: 0.134 s <<< FAILURE!
[ERROR] com.example.shop.inventory.internal.remote.InventoryClientPactTest.display(MockServer) -- Time elapsed: 0.127 s <<< FAILURE!
expected: 10
 but was: 0
expected: 10
 but was: 0
[ERROR] Tests run: 262, Failures: 2, Errors: 0, Skipped: 0
```

262 個測試，紅了 2 個 —— 都是呼叫端的契約：契約說回應有 `available`，改名之後的 `RemoteInventoryApi` 讀 `availableQuantity`，讀到 0。**其他 260 個全綠**，包括 `InventoryServiceApiTest`（它沒有測 `/stock` 的欄位名稱）。

在同一個 repo 裡，開發者接下來會做的事：**把契約也改了**（兩個 `integerType("available", 10)` → `integerType("availableQuantity", 10)`）。第二次 `mvn clean verify`：

```
[INFO] Tests run: 262, Failures: 0, Errors: 0, Skipped: 0
[ERROR] Tests run: 15, Failures: 2, Errors: 0, Skipped: 0, Time elapsed: 25.91 s <<< FAILURE! -- in com.example.shop.inventory.internal.web.InventoryProviderReleasedPactIT
[ERROR] Tests run: 30, Failures: 2, Errors: 0, Skipped: 0
```

surefire 的 262 個全綠；failsafe 裡，**這一次建置的契約全綠，線上那一版的契約紅了 2 個**：

```
1) Verifying a pact between order-service and inventory-service - 商品頁顯示用的可售量 has a matching body

    1.1) body: $ Actual map is missing the following keys: available

        {
        -  "available": 10,
        +  "availableQuantity": 10,
          "productId": 9001
        }
```

如果沒有這一份，這次改名會被部署出去。線上那一版的訂單服務收到新的回應，會讀到什麼 —— 用同樣的 Jackson 設定試一次（Spring 的 `Jackson2ObjectMapperBuilder` 預設關掉 `FAIL_ON_UNKNOWN_PROPERTIES`，不認得的欄位直接略過）：

```java
    /** 線上那一版訂單服務的 StockLevel（改名之前） */
    record StockLevel(long productId, int available) {}
    …
        ObjectMapper spring = new ObjectMapper().disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
        System.out.println("新版庫存服務的回應：" + fromNewInventory);
        System.out.println("舊版訂單服務讀到的：" + spring.readValue(fromNewInventory, StockLevel.class));
```

```
新版庫存服務的回應：{"productId":9001,"availableQuantity":10}
舊版訂單服務讀到的：StockLevel[productId=9001, available=0]
```

**不是錯誤，是 0。** 購物車、賣家的商品列表、商品頁，每一個商品的可售量都是 0 —— 沒有 500、沒有告警，直到有人發現「怎麼全部都賣完了」。「略過不認得的欄位」（tolerant reader）讓**加**欄位很安全，同時讓**拿掉**欄位變得無聲無息。

**正確的做法：先擴充、再收縮。**

1. **擴充**：庫存服務兩個名字都送，舊的照舊：

```diff
-    public record StockLevel(long productId, int available) {}
+    /** 擴充：新的名字先「加」上去，舊的照送 —— 線上的呼叫端讀 available，升級之後的讀 availableQuantity */
+    public record StockLevel(long productId, int available, int availableQuantity) {
+        public StockLevel(long productId, int available) { this(productId, available, available); }
+    }
```

   ```
   [INFO] Tests run: 30, Failures: 0, Errors: 0, Skipped: 0
   ```

   兩份契約都綠 —— 這一版的庫存服務可以先部署，不管訂單服務是哪一版。
2. **遷移**：訂單服務改讀 `availableQuantity`、部署；它的契約變成新的「線上那一版」。
3. **收縮**：等線上已經沒有任何一版的訂單服務在讀 `available`（「線上那一版」的契約裡不再有它），庫存服務才拿掉它。

舊端點什麼時候能刪？要先確定所有呼叫它的服務都升級了 —— 編譯器幫不上忙，要靠契約測試與呼叫紀錄。契約是第一半：線上每一版呼叫端的契約裡都不再有它。呼叫紀錄是第二半：庫存服務的 `http.server.requests`（第 12 站 9.9 的指標，帶著 `uri`）這幾天還有沒有人打那一支。

| 改動 | 相容嗎 | 順序 |
|---|---|---|
| 回應多一個欄位 | 相容（呼叫端略過不認得的） | 隨便 |
| 多一支端點，舊的呼叫端用不到 | 相容 | 隨便 |
| 新的呼叫端要用一支新端點 | 相容，但有順序 | **提供端先**部署；呼叫端的契約在舊的提供端上會紅 |
| 請求多一個**選填**的欄位 | 相容 | 隨便 |
| 請求多一個**必填**的欄位 | 不相容（舊的呼叫端不會送） | 先擴充成選填 |
| 拿掉、改名、改型別（回應或請求） | 不相容 | 擴充 → 遷移 → 收縮；或者開 v2、兩版並存 |
| 改變意思（欄位名字一樣、單位或定義變了） | **契約抓不到** | 開一個新的名字 |

最後一列要記住：Pact 驗證的是形狀與範例的型別，不是意思。`available` 從「`on_hand − reserved`」改成「`on_hand`」，契約照樣綠。

### 3.8.6 這一章沒有做的

- **Pact Broker、can-i-deploy**。這一章的「線上那一版」是一個手動複製的檔案，只有一份。真的流程：呼叫端每一次建置把契約發布到 Pact Broker（帶著版本與分支）；部署到某個環境時記下「這一版在 production」；提供端驗證「每一個環境上的每一版呼叫端」的契約，結果也發布回去；部署之前問 `can-i-deploy`：「我這一版跟 production 上的每一個對方都驗證過了嗎？」
- **事件的契約**（Pact 的 message pact）。`order.placed`、`product.created` 的 payload 也是兩個服務之間的契約（第 12 站 7.3.1 的 `EventTypes` 註解：「改欄位的名字或意思 = 破壞契約」）。這一章只靠 D4 跑過一遍、`ServiceRoleConsumersTest` 守住「誰收」，沒有守「長什麼樣」。
- **提供端的前提（`@State`）知道庫存的表**：契約一多，這些 SQL 會變成另一份要維護的東西。這是 Pact 的已知代價。

頭兩項的做法在下面幾小節，要先讀完第 04 章：程式碼在 `d04` 分支上、第 04 章結束（`4512f05`）之後的 commit 裡，完整的檔案在第 04 章 4.11.2。跨過這一刀的事件，到了第 04 章才多起來：訂單服務送 6 種給庫存服務、庫存服務送 1 種回來（4.10.4 的 B1）。第三項（`@State` 知道庫存的表）沒有變，下面會再看到它一次。

#### 事件的契約：呼叫端

跟 HTTP 的契約同一個做法，只是「呼叫端」換成**消費者**：庫存服務寫下它讀哪幾則事件、每一則讀哪幾個欄位，把契約裡的範例交給**真的**消費者（`InventoryEventHandlers` 的那幾個 `EventHandler`），看它拿那幾個欄位做了什麼（`JdbcInventoryService` 換成 mock）：

```java
@ExtendWith(PactConsumerTestExt.class)
@PactTestFor(providerName = "order-service", providerType = ProviderType.ASYNCH, pactVersion = PactSpecVersion.V4)
class OrderEventsPactTest {

    static final ObjectMapper JSON = new ObjectMapper();

    final JdbcInventoryService inventory = mock(JdbcInventoryService.class);

    @Pact(consumer = "inventory-service")
    V4Pact placed(MessagePactBuilder b) {
        return b.expectsToReceive("order.placed：有熱點品項的訂單成立")
                .withContent(new PactDslJsonBody().integerType("orderId", 7001).minArrayLike("hotProductIds", 1, au.com.dius.pact.consumer.dsl.PactDslJsonRootValue.integerType(9005), 1))
                .toPact(V4Pact.class);
    }
```
…
```java
    @Pact(consumer = "inventory-service")
    V4Pact rejected(MessagePactBuilder b) {
        return b.expectsToReceive("order.rejected：熱點品項過了閘門、預留失敗")
                .withContent(new PactDslJsonBody().integerType("orderId", 7001)
                        .minArrayLike("hotLines", 1).integerType("productId", 9005).integerType("quantity", 1).closeObject().closeArray())
                .toPact(V4Pact.class);
    }
```

```java
    @Test @PactTestFor(pactMethod = "rejected")
    void rejected(V4Interaction.AsynchronousMessage m) throws Exception {
        handle(new InventoryEventHandlers().orderEvents(inventory), "order.rejected", m);
        verify(inventory).releaseRejected(7001L, List.of(new ReserveLine(9005, 1)));
    }
```
…
```java
    /** 契約裡的那一則，包成 EventDispatcher 交給消費者的那個樣子 */
    static void handle(EventHandler h, String type, V4Interaction.AsynchronousMessage m) throws Exception {
        h.handle(new Event("pact-" + type, type, "ORDER", 1, Instant.now(), JSON.readTree(m.getContents().getContents().valueAsString()), 1));
    }
```

`order.paid`、`order.cancelled`、`order.shipped` 的契約只有一個欄位：`orderId`。payload 裡其實還有 `orderNo`、`buyerId`、`totalAmount`……（`OrderTransitionService.publish`）—— 那些是通知、報表在讀的，**不是庫存服務**。契約只寫自己讀的：訂單服務可以加欄位，不能拿掉這裡寫了的、不能改型別。六則的完整內容在第 04 章 4.11.2。

反方向只有一則：熱點落帳發現不夠，庫存服務送 `inventory.hot-settlement-failed`，訂單服務取消那張訂單（第 12 站 7.6.3）。寫法一樣，消費者是 `StockShortageHandler`：

```java
@ExtendWith(PactConsumerTestExt.class)
@PactTestFor(providerName = "inventory-service", providerType = ProviderType.ASYNCH, pactVersion = PactSpecVersion.V4)
class InventoryEventsPactTest {

    @Pact(consumer = "order-service")
    V4Pact shortage(MessagePactBuilder b) {
        return b.expectsToReceive("inventory.hot-settlement-failed：熱點落帳時庫存不夠")
                .withContent(new PactDslJsonBody().integerType("orderId", 7006)).toPact(V4Pact.class);
    }

    @Test @PactTestFor(pactMethod = "shortage")
    void shortage(V4Interaction.AsynchronousMessage m) throws Exception {
        OrderTransitionService transitions = mock(OrderTransitionService.class);
        new StockShortageHandler(transitions).handle(new Event("pact-shortage", "inventory.hot-settlement-failed", "ORDER", 7006, Instant.now(),
                new ObjectMapper().readTree(m.getContents().getContents().valueAsString()), 1));
        verify(transitions).apply(eq(7006L), eq(OrderEvent.STOCK_SHORTAGE), any(), any());
    }
}
```

⚠️ **加了這一則，HTTP 的契約會紅。** 這一則的呼叫端是 order-service、提供端是 inventory-service —— 跟 3.8.3 的 HTTP 契約是**同一對**，寫進同一個檔（`order-service-inventory-service.json`）。HTTP 的那一份是 V3（3.8.3 的小坑），事件的這一份是 V4：

```
[ERROR] Tests run: 17, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 2.699 s <<< FAILURE! -- in com.example.shop.inventory.internal.remote.InventoryClientPactTest
[ERROR] com.example.shop.inventory.internal.remote.InventoryClientPactTest -- Time elapsed: 2.699 s <<< ERROR!
au.com.dius.pact.core.model.InvalidPactException: Cannot merge pacts as they are not compatible - Pact types different: 'V4Pact' can not be assigned to 'RequestResponsePact'
```

V3 的 HTTP 契約與事件的契約是兩種不同的檔（`RequestResponsePact`、`MessagePact`），合不進同一個檔；V4 的一份契約可以同時放兩種互動。把 HTTP 的那一份也改成 V4：16 個方法的回傳型別、`toPact()` 加一個參數，`@PactTestFor` 換版本：

```diff
 import au.com.dius.pact.consumer.junit5.PactConsumerTestExt;
 import au.com.dius.pact.consumer.junit5.PactTestFor;
 import au.com.dius.pact.core.model.PactSpecVersion;
-import au.com.dius.pact.core.model.RequestResponsePact;
+import au.com.dius.pact.core.model.V4Pact;
 import au.com.dius.pact.core.model.annotations.Pact;
 import com.example.shop.inventory.InsufficientStockException;
 import com.example.shop.inventory.ReservationRef;
…
  * 只寫「訂單服務用到的」：回應裡多出來的欄位不寫（Pact 不檢查沒寫的）—— 庫存服務可以自由加欄位，不能拿掉這裡寫了的。
  */
 @ExtendWith(PactConsumerTestExt.class)
-@PactTestFor(providerName = "inventory-service", pactVersion = PactSpecVersion.V3)   // ⚠️ 4.6 預設 V4：RequestResponsePact 的寫法要指定 V3（3.8.3）
+// 3.8.3：第一版是 V3（RequestResponsePact 的寫法要指定 V3）。3.8.6 的追記：改成 V4 —— 同一對服務還有一則事件的契約（InventoryEventsPactTest），
+// V3 的 HTTP 契約與事件的契約不能寫進同一個檔（Cannot merge pacts as they are not compatible），V4 的可以
+@PactTestFor(providerName = "inventory-service", pactVersion = PactSpecVersion.V4)
 class InventoryClientPactTest {
 
     static final String BEARER = "Bearer [A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+";
…
     // ───────── 可售量 ─────────
 
     @Pact(consumer = "order-service")
-    RequestResponsePact stock(PactDslWithProvider b) {
+    V4Pact stock(PactDslWithProvider b) {
         return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
                 .uponReceiving("查兩個商品的可售量").method("GET").path("/internal/inventory/v1/stock")
                 .query("productIds=9001&productIds=9002").matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                 .willRespondWith().status(200)
                 .body(new PactDslJsonBody().minArrayLike("items", 1).integerType("productId", 9001).integerType("available", 10).closeObject().closeArray())
-                .toPact();
+                .toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "stock")
…
```

（`…` 之後是其餘 15 個方法，每一個都是同樣的兩行。）之後兩份契約都是 V4：`order-service-inventory-service.json` 裡 16 個 HTTP 互動加 1 則事件，`inventory-service-order-service.json` 裡 6 則事件。

#### 事件的契約：提供端

提供端要證明「我真的會送出長這樣的事件」。**不能手寫一份 JSON 給它比** —— 手寫的那一份會跟著契約改，真的程式碼不會。每一則都走一次真的流程（真的下單、付款、取消、出貨、被拒絕、建立商品），再從 outbox 讀出那一列的 payload（relay 送到 RabbitMQ 的就是這幾個位元組）：

```java
/**
 * 13 站 3.8.6 的追記：訂單服務的每一則事件，用**真的程式碼**產生 —— 真的下單、付款、取消、出貨、被拒絕、建立商品，
 * 再從 outbox 讀出那一列的 payload 交給 Pact 比。不是手寫一份 JSON：手寫的那一份會跟著契約改，真的程式碼不會。
 *
 * ⚠️ 為什麼是一個獨立的 public 類別：Pact 在測試的套件裡「掃」標了 @PactVerifyProvider 的方法，同一個描述只能有一個 ——
 *   第一版標在兩個 IT 上（資料夾一個、broker 一個），它挑到另一個類別的那一個，用反射呼叫：cannot access a member … with package access；
 *   標在抽象的父類別上，它自己 new 那個父類別：InstantiationException。
 * 所以每一則只標一次，標在這裡；Pact 用 public 的無參數建構子 new 它，需要的 bean 從正在跑的那個測試的 context 拿（OrderEventsProviderContract 設定）
 */
public class OrderEventMessages {
```
…
```java
    @PactVerifyProvider("order.rejected：熱點品項過了閘門、預留失敗")
    public MessageAndMetadata rejected() {
        long hot = product(true, 5), scarce = product(false, 1), buyer = BUYERS.incrementAndGet();
        try {
            ordering.placeOrder(buyer, UUID.randomUUID().toString(), List.of(
                    new OrderingApi.OrderLine(hot, 1, new BigDecimal("100")), new OrderingApi.OrderLine(scarce, 2, new BigDecimal("100"))));
            throw new IllegalStateException("應該庫存不足");
        } catch (InsufficientStockException expected) {
            long id = jdbc.queryForObject("SELECT MAX(id) FROM orders WHERE buyer_id = ?", Long.class, buyer);
            return payload(id, "order.rejected");
        }
    }
```
…
```java
    /** outbox 裡那一列的 payload —— relay 送到 RabbitMQ 的就是這幾個位元組 */
    MessageAndMetadata payload(String aggregateType, long aggregateId, String type) {
        String json = jdbc.queryForObject("SELECT payload FROM outbox_events WHERE aggregate_type = ? AND aggregate_id = ? AND event_type = ? ORDER BY id DESC LIMIT 1",
                String.class, aggregateType, aggregateId, type);
        return new MessageAndMetadata(json.getBytes(StandardCharsets.UTF_8), Map.of("contentType", "application/json"));
    }
```

訂單服務的驗證跑在**單體**裡（一個行程、一個庫）：產生事件的程式碼在哪一種部署都一樣（`OrderTransitionService.publish`、`ProductService.create`），單體不需要另一個服務就能把一張訂單走完。庫存服務那一則（`InventoryEventMessages`）用它自己的角色、自己的庫：熱點預留還沒落帳、庫存是 0，把一則 `order.placed` 交給真的落帳消費者（`EventDispatcher`：跟 RabbitMQ 送來的時候同一條路）。庫存服務的驗證本來只有 HTTP 的 target，現在多一個事件的：

```diff
 package com.example.shop.inventory.internal.web;
 
+import org.springframework.context.ApplicationContext;
 import au.com.dius.pact.provider.junit5.HttpTestTarget;
+import au.com.dius.pact.provider.junit5.MessageTestTarget;
 import au.com.dius.pact.provider.junit5.PactVerificationContext;
 import au.com.dius.pact.provider.junit5.PactVerificationInvocationContextProvider;
 import au.com.dius.pact.provider.junitsupport.State;
…
     @LocalServerPort int port;
     @Autowired StringRedisTemplate redis;
 
+    /** 3.8.6 的追記：同一份契約裡還有一則事件（inventory.hot-settlement-failed）—— 每一個互動，Pact 挑支援它的那一個 target */
     @BeforeEach
     void target(PactVerificationContext context) {
+        InventoryEventMessages.contract = this;
         context.setTarget(new HttpTestTarget("127.0.0.1", port));
+        context.addAdditionalTarget(new MessageTestTarget());
     }
 
     @TestTemplate
     @ExtendWith(PactVerificationInvocationContextProvider.class)
     void verify(PactVerificationContext context, HttpRequest request) {
-        request.setHeader("Authorization", "Bearer " + InventoryServiceApiTest.token("order-service", "inventory-service", Duration.ofMinutes(5), SECRET));
+        if (request != null)                                                // 事件的互動沒有 HTTP 請求
+            request.setHeader("Authorization", "Bearer " + InventoryServiceApiTest.token("order-service", "inventory-service", Duration.ofMinutes(5), SECRET));
         context.verifyInteraction();
     }
 
…
 
     @Autowired JdbcTemplate jdbc;
 
+    @Autowired ApplicationContext ctx;
+
     /** 帳（inventory_ledger）只能新增（INV-5）：清理用 root；帳的外鍵讓庫存列刪不掉，所以庫存列用「改」的 */
     void clean() {
         JdbcTemplate admin = TestInfra.adminJdbc();
```

⚠️ **標在哪裡有差。** `@PactVerifyProvider` 是 Pact 在測試的套件裡**掃**出來的：

| 標在哪裡 | 結果 |
|---|---|
| 驗證這份契約的 IT 自己身上（只有一個 IT 驗資料夾裡的契約時） | 綠 |
| 共用的抽象父類別（要多一個驗 broker 的 IT，想共用） | `cannot access a member of class …InventoryProviderContract with package access`；改成 public 之後 `InstantiationException` —— 方法不在測試類別本身，Pact 自己 `new` 那個類別，而它是抽象的 |
| 兩個 IT 各標一次，轉呼叫父類別 | 驗 broker 的那一個 6 則全紅：同一個描述有兩個方法，Pact 挑到**另一個** IT 的那一個（`cannot access a member of class …OrderEventsProviderPactIT`） |

所以每一則**只標一次**，標在一個 public 的類別上（`OrderEventMessages`、`InventoryEventMessages`），Pact 用它 public 的無參數建構子 `new` 它；要用的 bean 從**正在跑的那個測試**拿（測試的 `@BeforeEach` 把自己的 context 交給它）。

六則加一則全綠之後，**它抓得到東西嗎？** 在訂單服務暫時把 `order.rejected` 的 `hotLines[].quantity` 改名成 `qty`，只跑提供端的驗證：

```
1) order.rejected：熱點品項過了閘門、預留失敗: generates a message which has a matching body

    1.1) body: $.hotLines[0] Actual map is missing the following keys: quantity

        {
        -  "productId": 9005,
        -  "quantity": 1
        +  "productId": 9970004,
        +  "qty": 1
        }
```

（改回來了。）同一個改名，單體裡的測試應該也抓得到 —— `PlaceOrderSagaTest` 的庫存不足那一個會把 `order.rejected` 交給庫存模組，`l.get("quantity")` 是 null（推論，這一點沒有跑）。**契約要守的是另一種情況：兩個服務各自部署的時候**，那時候沒有一個測試同時跑兩邊的程式碼。

#### Pact Broker

3.8.5 的「線上那一版」是一份手動複製進 repo 的檔案：只有一份、只有一個方向（訂單服務的契約），沒有人記得它對應哪一個版本，也沒有地方記「庫存服務的哪一版驗證過它」。Pact Broker 是放這些東西的地方：

- **呼叫端**每一次建置把契約**發布**上去，帶著版本（commit）與分支；
- **提供端**從 broker 拿「要驗證哪些契約」—— 線上（production）那一版呼叫端的，加上同一個分支最新的 —— 驗完把結果**發布回去**；
- 部署完成時記一筆「這一版現在在 production」；部署之前問 **`can-i-deploy`**：「我這一版，跟 production 上的每一個對方，都驗證過了嗎？」

在 compose 裡加一個 broker，只在 `--profile contracts` 時起：

```diff
     depends_on:
       mysql: {condition: service_healthy}
 
+  # 13 站 3.8.6 的追記：契約的「中央倉庫」—— 呼叫端每一次建置把契約發布上來，提供端從這裡拿要驗證的契約、把結果發布回來，
+  # 部署之前問它 can-i-deploy。只在 --profile contracts 時起；sqlite 只適合本機（資料在容器裡，容器刪了就沒了）
+  pact-broker:
+    image: pactfoundation/pact-broker:2.143.0-pactbroker2.121.0
+    profiles: [contracts]
+    environment:
+      PACT_BROKER_DATABASE_URL: "sqlite:////tmp/pact_broker.sqlite3"
+      PACT_BROKER_PORT: "9292"
+    ports: ["${SHOP_PACT_BROKER_PORT:-9292}:9292"]
+
 volumes:
   mysql-data:
   redis-data:
```

提供端多兩個 IT，契約的來源換成 broker（`@PactBroker`），選哪幾版的規則寫在 `@PactBrokerConsumerVersionSelectors`：

```java
package com.example.shop.inventory.internal.web;

import au.com.dius.pact.provider.junitsupport.Provider;
import au.com.dius.pact.provider.junitsupport.loader.PactBroker;
import au.com.dius.pact.provider.junitsupport.loader.PactBrokerConsumerVersionSelectors;
import au.com.dius.pact.provider.junitsupport.loader.SelectorBuilder;

/**
 * 13 站 3.8.6 的追記：驗證 Pact Broker 上的契約，取代「手動複製的那一份」（InventoryProviderReleasedPactIT，3.8.5）：
 * 線上（production）那一版訂單服務的契約 + 同一個分支最新的那一版。結果發布回 broker（-Dpact.verifier.publishResults=true）。
 * 不在預設的建置裡（failsafe 只收 *PactIT）：scripts/d04-contracts.sh 帶著 -Dpactbroker.url 跑它
 */
@Provider("inventory-service")
@PactBroker(url = "${pactbroker.url}")
class InventoryProviderBrokerIT extends InventoryProviderContract {

    @PactBrokerConsumerVersionSelectors                                    // ⚠️ 要 public static，不然 IllegalAccessException
    public static SelectorBuilder selectors() {
        return new SelectorBuilder().deployedOrReleased().branch(System.getProperty("pact.consumer.branch", "d04"));
    }
}
```

`OrderEventsProviderBrokerIT` 一樣（`@Provider("order-service")`，繼承 `OrderEventsProviderContract`）。⚠️ 那個方法要 `public static`：只寫 `static` 的話，兩個 IT 都在 0.36 秒內 `IllegalAccessException: Consumer version selector methods must be public and static`。它們的名字是 `*BrokerIT`，failsafe 只收 `*PactIT`（3.8.2）—— **預設的建置不需要 broker**；`InventoryProviderReleasedPactIT`（3.8.5 那一份檔案）照舊留在預設的建置裡。

發布、驗證、問、記錄，包成一支腳本：

```bash
#!/usr/bin/env bash
# 13 站 3.8.6 的追記：Pact Broker 與 can-i-deploy。第 03 章的「線上那一版」是手動複製進 repo 的一份檔案（3.8.5）；這裡換成一個 broker：
#   publish        呼叫端的測試產生契約（target/pacts），發布到 broker（帶著版本與分支）
#   verify <服務>  提供端從 broker 拿契約來驗證（線上那一版的呼叫端 + 同一個分支最新的那一版），結果發布回 broker
#   can-i-deploy <服務>   部署之前問：這一版跟 production 上的每一個對方，都驗證過了嗎？
#   record <服務>  部署完成：告訴 broker「這一版現在在 production」
#   broker         起 broker（compose 的 contracts profile）、建 production 這個環境
#   baseline <版本> 線上那一版：第 03 章手動複製的那一份契約（3.8.5）發布成那個版本，兩個服務都記成「在 production」
# 版本預設是目前的 commit（git rev-parse --short HEAD），分支預設是目前的分支；VERSION=… BRANCH=… 可以蓋掉（實驗「還沒 commit 的改動」時用）。
# 用法：scripts/d04-contracts.sh broker | baseline <版本> | publish | verify order-service|inventory-service | can-i-deploy <服務> | record <服務>
set -euo pipefail
cd "$(dirname "$0")/.."

BROKER_HOST=http://localhost:${SHOP_PACT_BROKER_PORT:-9292}     # 給 Maven（在這台機器上跑）
BROKER_NET=http://pact-broker:9292                              # 給 pact-cli（在 compose 的網路裡跑）
VERSION=${VERSION:-$(git rev-parse --short HEAD)}
BRANCH=${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}

cli() {                                                         # 顏色碼拿掉：輸出要能貼進文件
  docker run --rm --network shop_default -v "$PWD/target/pacts:/pacts" -v "$PWD/src/test/resources/pacts/released:/released" \
    -e PACT_BROKER_BASE_URL="$BROKER_NET" pactfoundation/pact-cli:1.4.0.0 pact-broker "$@" 2>&1 | sed $'s/\x1b\\[[0-9;]*m//g'
  return "${PIPESTATUS[0]}"
}

case "${1:-}" in
  broker)
    docker compose --profile contracts up -d pact-broker
    until curl -sf "$BROKER_HOST/diagnostic/status/heartbeat" > /dev/null; do sleep 1; done
    cli list-environments | grep -q production || cli create-environment --name production --production
    ;;
  baseline)
    cli publish /released --consumer-app-version "$2" --branch "${3:-d03}"
    cli create-or-update-version --pacticipant inventory-service --version "$2" --branch "${3:-d03}"
    cli record-deployment --pacticipant order-service --version "$2" --environment production
    cli record-deployment --pacticipant inventory-service --version "$2" --environment production
    ;;
  publish)
    rm -rf target/pacts
    mvn -q test -Djacoco.skip=true -Dtest='InventoryClientPactTest,InventoryEventsPactTest,OrderEventsPactTest' -Dsurefire.failIfNoSpecifiedTests=false
    cli publish /pacts --consumer-app-version "$VERSION" --branch "$BRANCH"
    ;;
  verify)
    case "${2:-}" in
      order-service)     it=OrderEventsProviderBrokerIT ;;
      inventory-service) it=InventoryProviderBrokerIT ;;
      *) echo "verify order-service|inventory-service" >&2; exit 2 ;;
    esac
    # 驗證失敗也要把結果發布回 broker（can-i-deploy 要看到「失敗」），所以 Maven 的結束碼不讓腳本停下來
    mvn verify -Djacoco.skip=true -Dtest=NONE -Dsurefire.failIfNoSpecifiedTests=false -Dit.test="$it" \
      -Dpactbroker.url="$BROKER_HOST" -Dpact.verifier.publishResults=true -Dpact.provider.version="$VERSION" -Dpact.provider.branch="$BRANCH" \
      | grep -E "Verifying a pact between|\[from Pact Broker|has a matching|includes headers|has status code|Tests run:.*BrokerIT|FAILED" || true
    ;;
  can-i-deploy)
    cli can-i-deploy --pacticipant "$2" --version "$VERSION" --to-environment production || true
    ;;
  record)
    cli record-deployment --pacticipant "$2" --version "$VERSION" --environment production
    ;;
  *)
    sed -n '2,10p' "$0" >&2; exit 2 ;;
esac
```

#### 從「線上是第 03 章那一版」開始

broker 是空的。可是線上不是空的 —— 正在跑的是第 03 章那一版（`3dc04d0`）的兩個服務。所以第一步是把它放進去：它的契約就是 3.8.5 手動複製的那一份，兩個服務都記成「在 production」：

```bash
scripts/d04-contracts.sh broker
scripts/d04-contracts.sh baseline 3dc04d0
```

```
Created order-service version 3dc04d0 with branch d03
Pact successfully published for order-service version 3dc04d0 and provider inventory-service.
Created/updated pacticipant version 3dc04d0 with branch d03 in the Pact Broker
Recorded deployment of order-service version 3dc04d0 to production environment in the Pact Broker.
Recorded deployment of inventory-service version 3dc04d0 to production environment in the Pact Broker.
```

然後是 `d04` 的版本（`9933bd9`）：發布兩個服務的契約、兩個提供端各驗證一次：

```bash
scripts/d04-contracts.sh publish
scripts/d04-contracts.sh verify inventory-service
scripts/d04-contracts.sh verify order-service
```

```
Created inventory-service version 9933bd9 with branch d04
Pact successfully published for inventory-service version 9933bd9 and provider order-service.
Created order-service version 9933bd9 with branch d04
Pact successfully published for order-service version 9933bd9 and provider inventory-service.
[INFO] Tests run: 32, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 29.64 s -- in com.example.shop.inventory.internal.web.InventoryProviderBrokerIT
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 27.83 s -- in com.example.shop.ordering.internal.OrderEventsProviderBrokerIT
```

庫存服務驗了 32 個互動：線上那一版訂單服務的 15 個（就是 3.8.5 那一份）、`d04` 的 17 個 —— 第 04 章的庫存服務**接得住**第 03 章的訂單服務。訂單服務驗了庫存服務要讀的 6 則事件。

還差一半：**線上那一版的兩個提供端，從來沒有驗證過 `d04` 的契約。** broker 只知道「它們在 production」，不知道它們接不接得住新的呼叫端。正式的做法是讓提供端的管線，拿 production 上那一版的程式碼，驗證新發布的契約（broker 的 webhook 會在「有一份需要驗證的新契約」時觸發它）。這裡手動做一次：在第 03 章的程式碼上，只放進驗證用的四個測試類別（`OrderEventMessages`、`OrderEventsProviderContract`、`OrderEventsProviderBrokerIT`、`InventoryProviderBrokerIT`，跟 `d04` 的同一份），正式程式碼一行都不動，以 `3dc04d0` 的身分把結果發布回 broker。四個檔案只有一處不一樣 —— 第 03 章的程式碼在庫存不足時不寫訂單，`rejected()` 找不到那一張，要說清楚：

```diff
                     new OrderingApi.OrderLine(hot, 1, new BigDecimal("100")), new OrderingApi.OrderLine(scarce, 2, new BigDecimal("100"))));
             throw new IllegalStateException("應該庫存不足");
         } catch (InsufficientStockException expected) {
-            long id = jdbc.queryForObject("SELECT MAX(id) FROM orders WHERE buyer_id = ?", Long.class, buyer);
+            Long id = jdbc.queryForObject("SELECT MAX(id) FROM orders WHERE buyer_id = ?", Long.class, buyer);
+            if (id == null) throw new IllegalStateException("這一版庫存不足時沒有寫下訂單，也沒有 order.rejected 這一則事件");
             return payload(id, "order.rejected");
         }
     }
```

```bash
# 第 03 章的程式碼（3dc04d0）＋ 上面四個測試類別
mvn verify -Djacoco.skip=true -Dtest=NONE -Dsurefire.failIfNoSpecifiedTests=false -Dit.test='InventoryProviderBrokerIT,OrderEventsProviderBrokerIT' \
  -Dpactbroker.url=http://localhost:9292 -Dpact.verifier.publishResults=true -Dpact.provider.version=3dc04d0 -Dpact.provider.branch=d03
```

```
[ERROR] Failures: 
[ERROR]   InventoryProviderBrokerIT>InventoryProviderContract.verify:70 Pact between order-service (9933bd9) and inventory-service - Upon 出貨之前：可以出貨 
[ERROR]   InventoryProviderBrokerIT>InventoryProviderContract.verify:70 Pact between order-service (9933bd9) and inventory-service - Upon 出貨之前：熱點還在落帳 
[ERROR]   InventoryProviderBrokerIT.verify(PactVerificationContext, HttpRequest)[31] Provider state change callback failed
[ERROR]   InventoryProviderBrokerIT.verify(PactVerificationContext, HttpRequest)[32] Provider state change callback failed
[ERROR]   OrderEventsProviderBrokerIT>OrderEventsProviderContract.verify:36 Pact between inventory-service (9933bd9) and order-service - Generates message 'order.rejected：熱點品項過了閘門、預留失敗'  
[ERROR] Errors: 
[ERROR]   InventoryProviderBrokerIT.verify(PactVerificationContext, HttpRequest)[16] » UnsupportedOperation No test target has been configured for AsynchronousMessage interactions
[ERROR] Tests run: 38, Failures: 5, Errors: 1, Skipped: 0
```

六個紅的，每一個都是真的差別：

| 第 03 章的提供端 | `d04` 的契約要的 | 差在哪裡 |
|---|---|---|
| 庫存服務 | `GET …/reservations/{id}/shippable`：204、503（4.6.3） | 這一版沒有這一支端點：404 |
| 庫存服務 | 「訂單 7005 的預留已經被補償」「訂單 7006 的熱點預留落帳時不夠」兩個前提（4.7.2、4.6.3） | 這一版的驗證沒有這兩個 `@State` —— 3.8.6 第三項的代價：前提是提供端的測試寫的，新的前提只有新的版本有 |
| 庫存服務 | 一則事件（`inventory.hot-settlement-failed`） | 這一版的驗證只有 HTTP 的 target —— 它送的那一則從來沒有人寫過契約 |
| 訂單服務 | `order.rejected` | 這一版沒有這一則：庫存不足時，訂單根本不會寫下（第 04 章之前的下單是一個交易） |

現在問：

```bash
scripts/d04-contracts.sh can-i-deploy inventory-service
scripts/d04-contracts.sh can-i-deploy order-service
```

```
Computer says no ¯\_(ツ)_/¯

CONSUMER          | C.VERSION | PROVIDER          | P.VERSION | SUCCESS? | RESULT#
------------------|-----------|-------------------|-----------|----------|--------
inventory-service | 9933bd9   | order-service     | 3dc04d0   | false    | 1      
order-service     | 3dc04d0   | inventory-service | 9933bd9   | true     | 2      

VERIFICATION RESULTS
--------------------
1. http://pact-broker:9292/pacts/provider/order-service/consumer/inventory-service/pact-version/fcd1e863e0d581def1edea1986dc8bcd3428b7a3/metadata/Y3ZuPTk5MzNiZDk/verification-results/104 (failure)
2. http://pact-broker:9292/pacts/provider/inventory-service/consumer/order-service/pact-version/f6cecaf22c9601ea2a700ff9cc5d260af5bcba52/metadata/Y3ZuPTNkYzA0ZDA/verification-results/101 (success)

The verification for the pact between version 9933bd9 of inventory-service and the version of order-service currently in production (3dc04d0) failed
Computer says no ¯\_(ツ)_/¯

CONSUMER      | C.VERSION | PROVIDER          | P.VERSION | SUCCESS? | RESULT#
--------------|-----------|-------------------|-----------|----------|--------
order-service | 9933bd9   | inventory-service | 3dc04d0   | false    | 1      

VERIFICATION RESULTS
--------------------
1. http://pact-broker:9292/pacts/provider/inventory-service/consumer/order-service/pact-version/d98d09ef7cbdde94d0b0d64713861d43f4f6a888/metadata/Y3ZuPTk5MzNiZDk/verification-results/106 (failure)

The verification for the pact between version 9933bd9 of order-service and the version of inventory-service currently in production (3dc04d0) failed
```

**兩個都不能先上。**

- **庫存服務先上？** 它當提供端沒問題（第 03 章的訂單服務，它驗過了：`true`）；但它也是**消費者** —— 它的契約裡有 `order.rejected`，而 production 上那一版的訂單服務送不出來。
- **訂單服務先上？** 它要的 `/shippable`，production 上那一版的庫存服務沒有。這是 3.8.5 表上的那一列：「新的呼叫端要用一支新端點 —— 提供端先部署」。

一個說「提供端先」，另一個也說「提供端先」—— 而兩個服務互為對方的提供端（一個方向是 HTTP、另一個方向是事件）。**這不是 broker 的問題，是第 04 章這一版本身的形狀**：它同時改了兩個方向的契約。3.8.5 那一份手動複製的檔案只守一個方向，所以從來沒看到這件事。

要解開它，部署要拆成幾步：先上一版只**擴充**、不要求對方新東西的庫存服務（`/shippable` 有了，但契約裡還不要求 `order.rejected`），再上訂單服務，最後讓庫存服務的契約要求 `order.rejected` —— 擴充、遷移、收縮（3.8.5 的表），這一次是跨兩個服務、兩個方向。那是第 09 章「新舊版本並存、灰度、回滾」的題目；這一節做到的是：**部署的順序第一次有了一個會說「不行」、而且說得出為什麼的工具。**

---

## 3.9 流程測試與追溯表

### 3.9.1 這一章新增的測試與實驗

| 名稱 | 種類 | 跑在哪裡 | 量／守什麼 |
|---|---|---|---|
| `InventoryServiceApiTest` | **測試**（預設） | Testcontainers；庫存服務的角色、自己的庫 | 認證的七種身分；預留、補貨、熱點閘門的重送（含「同時」兩個）；本來就冪等的轉移；業務錯誤的 Problem Details；`/api/**` 404（3.5.5、3.6.3） |
| `RemoteInventoryApiTest` | **測試** | JDK 的 `HttpServer` | 沒有回應 → 同一個鍵再送一次；兩次 → 503；錯誤的翻譯；空清單不送；服務的 token（3.5.5） |
| `ServiceRoleConsumersTest` | **測試** | 單體的 context | 三個角色各收哪幾個消費者（3.7.4） |
| `DeploymentPropertiesTest` | **測試** | 只綁定 `ShopProperties` | 少了位址、金鑰太短 → 起不來；`INVENTORY_SERVICE` 綁得上（3.7.4） |
| `InventoryClientPactTest` | **測試**（呼叫端的契約） | Pact 的 mock server | 15 個互動；產生 `target/pacts`（3.8.3） |
| `InventoryProviderPactIT` | **契約驗證**（failsafe） | Testcontainers；庫存服務的角色 | 這一次建置的契約（3.8.4） |
| `InventoryProviderReleasedPactIT` | **契約驗證**（failsafe） | 同上 | 線上那一版訂單服務的契約（3.8.5） |
| `CrossModuleCallInTxTest` | 測試（改） | Testcontainers | 清單 11 → 10 種（3.4.2） |
| `D1TheLineTest` | 實驗 | 兩個服務、一個 JVM；第 02 章的線 | ① 兩個服務都收 ② 回應遺失 ③ 沒有認證（3.2） |
| `D2InterfaceTest` | 實驗 | 同上；兩條線各一次 | 使用者的一天，每個動作打了庫存服務幾次（3.4.6） |
| `D3TheLineAgainTest` | 實驗 | 兩個服務、正式的角色 | D1 的三種情況，換成這一章的線（3.5.6、3.6.4、3.7.4） |
| `D4BrokerDayTest` | 實驗 | 同上；事件走 RabbitMQ | 使用者的一天（3.7.5） |

預設的測試組從第 02 章的 234 個，變成 265 個；`mvn verify` 另外多 30 個契約驗證（3.10）。

### 3.9.2 B1 重跑

第 01 章的 B1 量的是**模組之間**的線（在一個行程裡量），`InventoryApi` 的介面改了，它的數字跟著變：

```bash
mvn test -Pexperiments -Dtest=B1BoundaryMapTest -Dd01.range=ch09
```

```
═══ 1.5 127 種切法（ordering 留在原地，S 切出去）；變更耦合：ch09，36 個改到正式程式碼的 commit ═══
  名次 │ 切出去的 S                          │ 切斷的交易 │ 交易內呼叫 │ 同步呼叫 │ 直接讀表 │ 事件 │ 變更耦合
     1 │ notification                        │          0 │          0 │        0 │        0 │    5 │   8.3%（3）
     2 │ account                             │          0 │          0 │        0 │        1 │    0 │  11.1%（4）
     3 │ account+notification                │          0 │          0 │        0 │        1 │    5 │  13.9%（5）
     4 │ account+reporting                   │          0 │          0 │        0 │        4 │    0 │  19.4%（7）
     5 │ account+notification+reporting      │          0 │          0 │        0 │        4 │    5 │  22.2%（8）
     6 │ reporting                           │          0 │          0 │        0 │        5 │    0 │  11.1%（4）
     7 │ notification+reporting              │          0 │          0 │        0 │        5 │    5 │  16.7%（6）
     8 │ catalog                             │          0 │          1 │        7 │        1 │    1 │  25.0%（9）
     9 │ catalog+notification                │          0 │          1 │        7 │        1 │    6 │  27.8%（10）
    10 │ account+catalog                     │          0 │          1 │        7 │        2 │    1 │  27.8%（10）
    11 │ account+catalog+notification        │          0 │          1 │        7 │        2 │    6 │  30.6%（11）
    12 │ account+catalog+reporting           │          0 │          1 │        7 │        3 │    1 │  27.8%（10）
    16 │ cart                                │          1 │          1 │        3 │        0 │    0 │  11.1%（4）
    32 │ payment                             │          3 │          4 │        4 │        1 │    1 │  19.4%（7）
    64 │ catalog+inventory                   │          6 │          4 │       10 │        1 │    2 │  25.0%（9）
    80 │ inventory                           │          6 │          5 │       11 │        0 │    3 │  22.2%（8）
  （127 種全部：target/d01-cuts.txt）
  包含 inventory 的 64 種切法：切斷的交易最少 6 種；前三名：
    第  64 名 catalog+inventory                   交易 6、交易內呼叫 4、同步呼叫 10
    第  65 名 catalog+inventory+notification      交易 6、交易內呼叫 4、同步呼叫 10
    第  66 名 account+catalog+inventory           交易 6、交易內呼叫 4、同步呼叫 10
═══ 1.5 切出 inventory：切斷了什麼 ═══
  切斷的交易：
    POST /api/orders  寫 [cart, inventory, ordering]
    POST /api/orders/{orderNo}/cancel  寫 [inventory, ordering, payment]
    POST /api/payments/callback  寫 [inventory, ordering, payment]
    POST /api/seller/orders/{orderNo}/cancel  寫 [inventory, ordering, payment]
    POST /api/seller/orders/{orderNo}/ship  寫 [inventory, ordering]
    排程 OrderJobs.cancelExpired  寫 [inventory, ordering]
  交易內的同步呼叫：
    catalog → InventoryApi.setHot
    ordering → InventoryApi.confirm
    ordering → InventoryApi.consume
    ordering → InventoryApi.release
    ordering → InventoryApi.reserve
  所有同步呼叫：
    cart → InventoryApi.available
    catalog → InventoryApi.available
    catalog → InventoryApi.availableForDisplay
    catalog → InventoryApi.restock
    catalog → InventoryApi.setHot
    ordering → InventoryApi.activeReservations
    ordering → InventoryApi.confirm
    ordering → InventoryApi.consume
    ordering → InventoryApi.gateHot
    ordering → InventoryApi.release
    ordering → InventoryApi.reserve
  直接讀表：
  跨過去的事件：
    inventory.hot-settlement-failed → ordering.stock-shortage
    order.placed → inventory.hot-settlement
    product.created → inventory.product-created
  變更耦合：8／36 個 commit（22.2%）
```

| | 第 02 章之後 | 第 03 章之後 |
|---|---|---|
| inventory 這一刀的名次 | 第 80 | 第 80 |
| 切斷的交易 / 交易內呼叫 / 同步呼叫 / 直接讀表 / 事件 | 6 / 6 / 12 / 0 / 3 | 6 / **5** / **11** / 0 / 3 |
| catalog+inventory | 第 64；6 / 5 / 11 | 第 64；6 / **4** / **10** |

少的那一種是 `ordering → InventoryApi.holdHot`。名次沒變：排名先比「切斷的交易」（第 01 章 1.5.1），那一欄還是 6 —— **這一章讓線變得可以安全地重送，但沒有讓任何一個交易不再被切斷**。

一個要說明的數字：`ordering → InventoryApi.reserve` 從 4 次變成 6 次（B1 的 1.4.1 那一段）。第 12 站的 `PlaceOrderService` 只在有一般品項時才呼叫 `reserve`，現在每一張訂單都呼叫一次（全部是熱點的訂單，`lines` 是空的）—— 在線上，它是「每一張訂單一次往返」（3.4.6 的 6 次 `PUT`），在一個行程裡，是一次什麼都不做的迴圈。

### 3.9.3 追溯表：這一站的產出

| README 的產出 | 第 00 章 | 第 01 章 | 第 02 章 | 第 03 章加上的 |
|---|---|---|---|---|
| 1. 拆分決策文件 | 不該拆；四個代價 | 第一刀切 notification；庫存第 96 名 | 資料的三個階段；搬家三種做法的代價 | 每一條線同步還是非同步（3.3）；gRPC 不選的理由 |
| 2. 庫存拆成獨立服務、下單改成 Saga | 兩種部署 | 7 種交易、12 種呼叫 | 獨立的資料庫；對帳；建立商品改成事件 | **正式的服務**：角色與 profile、`/internal/inventory/v1`、服務的 token、可以安全重送的寫入、契約測試；兩個真的行程跑起來（3.7.6）。Saga 仍在第 04 章 |
| 3. 跨服務報表 | 商品頁的可售量 | reporting 讀的 5 張表 | 庫存這一刀不切斷報表 | （沒有變）—— 商品頁的可售量成了一條正式的同步線（3.3.2） |
| 4. 一條完整的 trace | K5 | （沒有變） | （沒有變） | （沒有量；第 07 章） |
| 5. 基礎設施選型 | 維運清單 | （沒有變） | `ddl-auto`、`bootstrap-admin` 這種開關 | 一個 jar、三種角色；金鑰散得比需要的廣（3.7.2）；部署的 migration 要照角色分資料夾（第 08 章） |

---

## 3.10 本章完成後的專案

```
shop/                                                              ← 分支 d03（從 d02 開出來）
├── pom.xml                                                        ← 3.8.2：Pact、failsafe
├── src/main/java/com/example/shop/
│   ├── inventory/InventoryApi.java                                ← 3.4.2：拿掉 initialize；holdHot 併進 reserve
│   ├── inventory/internal/JdbcInventoryService.java               ← 3.4.2；3.5.3：gateHotOnce、returnHotOnce
│   ├── inventory/internal/HotStock.java                           ← 3.5.3：GATE_ONCE、RETURN_ONCE
│   ├── inventory/internal/InventoryService.java                   ← + 3.4.4、3.5.2
│   ├── inventory/internal/web/InventoryServiceController.java     ← + 3.4.4
│   ├── inventory/internal/web/InventoryWire.java                  ← + 3.4.4
│   ├── inventory/internal/remote/InventoryClient.java             ← + 3.4.5
│   ├── inventory/internal/remote/RemoteInventoryApi.java          ← + 3.4.5、3.5.4
│   ├── ordering/internal/PlaceOrderService.java                   ← 3.4.2：一次 reserve
│   ├── shared/config/ServiceRole.java                             ← + 3.7.2
│   ├── shared/config/ConditionalOnServiceRole.java                ← + 3.7.2
│   ├── shared/config/ShopProperties.java                          ← 3.7.2：shop.deployment
│   ├── shared/events/Inbox.java、internal/JdbcInbox.java          ← + 3.5.2
│   ├── shared/messaging/internal/RabbitConsumers.java             ← 3.7.3：只收擁有的模組
│   ├── shared/security/ServiceTokens.java                         ← + 3.6.2
│   └── shared/security/InternalApiSecurity.java                   ← + 3.6.2、3.7.3
├── src/main/resources/
│   ├── application-order-service.yml                              ← + 3.7.2
│   └── application-inventory-service.yml                          ← + 3.7.2
└── src/test/
    ├── java/com/example/shop/
    │   ├── dist03/                                                ← + 這一章的支架與實驗
    │   │   ├── Broker.java、Flow.java、LostResponse.java、Shop.java ← 3.2.1
    │   │   ├── Roles.java、CallTap.java                            ← 3.4.6
    │   │   ├── D1TheLineTest.java                                 ← 3.2（實驗）
    │   │   ├── D2InterfaceTest.java                               ← 3.4.6（實驗）
    │   │   ├── D3TheLineAgainTest.java                            ← 3.5.6、3.6.4、3.7.4（實驗）
    │   │   └── D4BrokerDayTest.java                               ← 3.7.5（實驗）
    │   ├── dist02/Split.java                                      ← 3.2.1：可以多給幾個參數
    │   ├── dist02/RemoteInventory.java、InventoryEndpoints.java    ← 3.4.2、3.4.6
    │   ├── dist01/D01Workload.java                                ← 3.7.5：事件走 broker 時等安靜
    │   ├── dist01/CrossModuleCallInTxTest.java                    ← 3.4.2：11 → 10 種
    │   ├── dist00/RemoteInventoryApi.java、LabInventoryService.java ← 3.4.2
    │   ├── inventory/internal/web/InventoryServiceApiTest.java     ← + 3.5.5、3.6.3
    │   ├── inventory/internal/web/InventoryProviderContract.java   ← + 3.8.4
    │   ├── inventory/internal/web/InventoryProviderPactIT.java     ← + 3.8.4（failsafe）
    │   ├── inventory/internal/web/InventoryProviderReleasedPactIT.java ← + 3.8.5（failsafe）
    │   ├── inventory/internal/remote/RemoteInventoryApiTest.java   ← + 3.5.5
    │   ├── inventory/internal/remote/InventoryClientPactTest.java  ← + 3.8.3
    │   ├── shared/messaging/internal/ServiceRoleConsumersTest.java ← + 3.7.4
    │   └── shared/config/DeploymentPropertiesTest.java             ← + 3.7.4
    ├── java/com/example/lab/ch04/FriendlyPlaceOrder.java           ← 3.4.2
    └── resources/pacts/released/order-service-inventory-service.json ← + 3.8.5
```

**沒有新的 migration**；`processed_messages` 多了 HTTP 命令的列（3.5.2），表沒有變。**沒有改任何一支使用者的 API**（`OpenApiContractTest` 照樣綠）。單體的行為只有兩處不一樣：`PlaceOrderService` 每一張訂單呼叫一次 `reserve`（3.9.2）、`RabbitConsumers` 多一行判斷（單體擁有全部的模組，結果一樣）。

完整跑一次（預設的 Testcontainers；D1～D4 標了 `experiment`，不在裡面）：

```bash
mvn clean verify
```

```
TEST_INFRA testcontainers 啟動 12,285 ms：mysql jdbc:mysql://localhost:60387/shop、redis localhost:60373、rabbitmq localhost:60386
TEST_INFRA MySQL 最多同時 25 條連線（max_connections 151）
[INFO] Tests run: 265, Failures: 0, Errors: 0, Skipped: 0
TEST_INFRA testcontainers 啟動 11,201 ms：mysql jdbc:mysql://localhost:61882/shop、redis localhost:61872、rabbitmq localhost:61881
TEST_INFRA MySQL 最多同時 3 條連線（max_connections 151）
[INFO] Tests run: 30, Failures: 0, Errors: 0, Skipped: 0
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  05:31 min
```

**265 個測試**：第 02 章的 234 個，加上 `InventoryServiceApiTest` 7 個、`RemoteInventoryApiTest` 5 個、`ServiceRoleConsumersTest` 1 個、`DeploymentPropertiesTest` 3 個、`InventoryClientPactTest` 15 個。**failsafe 那一段另外 30 個**：兩份契約各 15 個互動。第二個「testcontainers 啟動」是 failsafe 的 JVM 自己起的容器（3.8.2）。

### 3.10.1 本章其餘檔案的完整內容

正文已經完整列出的：`InventoryService`、`InventoryServiceController`、`InventoryWire`（3.4.4）、`InventoryClient`（3.4.5）、`Inbox`、`JdbcInbox`（3.5.2）、`ServiceTokens`、`InternalApiSecurity`（3.6.2）、`ServiceRole`、兩個 profile（3.7.2）、`InventoryProviderContract`、`InventoryProviderPactIT`（3.8.4）、`InventoryProviderReleasedPactIT`（3.8.5）。只改了幾行、正文已經列出 diff 的：`PlaceOrderService`、`CrossModuleCallInTxTest`（3.4.2）、`RabbitConsumers`（3.7.3）、`pom.xml`（3.8.2）。

下面是其餘每一個新增或改過的檔案（`d03` 分支上的版本）：

**`src/main/java/com/example/shop/inventory/InventoryApi.java`**（3.4.2）

```java
package com.example.shop.inventory;

import java.util.Collection;
import java.util.List;
import java.util.Map;

/**
 * 庫存模組唯一的對外入口。其他模組只能透過這個介面改變庫存。
 * 每一個會改變數量的方法，都會在同一個交易裡寫一筆 inventory_ledger（INV-3）。
 */
public interface InventoryApi {

    // 13 站 3.4：initialize(productId, onHand, note) 從這個介面拿掉了。第 02 章 2.7 之後，唯一的呼叫者是庫存模組自己的
    // product.created 消費者 —— 一個沒有別的模組在用的公開方法，切開之後就是一支沒有人該打、卻打得到的端點

    /**
     * 為一張訂單預留庫存（每個品項一筆 HELD 預留）。全有或全無：任何一個品項不足就丟例外，呼叫端的交易應該 rollback。
     * 內部會依 productId 排序後才加鎖（4.2.3：避免兩張訂單以相反的順序鎖同樣兩個商品而死鎖）。
     * 必須在呼叫端既有的交易內呼叫（Propagation.MANDATORY）。
     *
     * hotLines：7.6 熱點商品的品項（已經過了 Redis 的閘門 gateHot）—— 只寫預留列（HELD、counted = FALSE），**不碰 inventory 那一列**，
     * 數量由 inventory.hot-settlement 消費者在 commit 之後計入 reserved（最終一致，0.6.4：60 秒）。
     * 13 站 3.4：第 12 站這是另一個方法 holdHot()。一張訂單同時有一般與熱點的品項時是兩次呼叫 —— 在一個行程裡無所謂；
     * 切開之後是兩次往返、兩個交易：第一個 commit 了、第二個失敗，第一個就留下沒有訂單的預留。合成一個：一張訂單的預留，一次、全有或全無
     */
    void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines);

    /** 付款成功：這張訂單的預留 HELD → CONFIRMED（不再能被逾時釋放）。數量不變，不記帳。MANDATORY。 */
    void confirm(long orderId);

    /** 取消：這張訂單的預留 → RELEASED，reserved 減回，每個品項一筆 RELEASE。已釋放的不重複釋放（冪等）。MANDATORY。 */
    void release(long orderId);

    /**
     * 出貨：CONFIRMED → CONSUMED，onHand 與 reserved 同時減少，每個品項一筆 SHIP。MANDATORY。
     * 7.6.4：還沒計入 reserved 的熱點預留（落帳還沒完成）→ 503，稍後再出貨。
     */
    void consume(long orderId);

    /** 補貨：onHand 增加，並記一筆 RESTOCK。自己開交易。13 站 2.7：庫存列還沒建立（product.created 還沒送到）也可以補，先建一列 */
    void restock(long productId, int quantity, String note);

    // 8.7：第 01 章的 restockBatch(List<RestockLine>)（「給匯入功能用」）拿掉了 —— 覆蓋率報表說它從來沒被執行過，
    // 而且整個 main 裡沒有任何人呼叫它：專題沒有匯入功能（0.7 也沒有列）。沒有人用的公開 API，不寫測試，刪掉

    // ───────── 第 06 章：熱點商品（6.5）─────────

    /**
     * 熱點商品的閘門：在下單交易「之前」、交易「之外」呼叫，先在 Redis 減掉這些品項。
     * 不夠 → InsufficientStockException（409，連 MySQL 都不碰）；Redis 不能用 → 503（0.6.3 的艙壁）。
     * 之後的下單交易仍然會做 reserve() 的條件式 UPDATE —— MySQL 才是最後一道防線。
     */
    void gateHot(List<ReserveLine> hotLines);

    /** 閘門過了、下單卻失敗了（價格變了、資料庫錯誤……）：把減掉的加回去（6.2.4） */
    void returnHot(List<ReserveLine> hotLines);

    /** 商品被標成（或取消）熱點：commit 之後建立（或刪除）Redis 的庫存副本。MANDATORY */
    void setHot(long productId, boolean hot);

    /** 商品頁顯示用的可售量（US-PRD-3 AC-4：最多 5 秒的延遲）。熱點商品讀 Redis 的副本；其他商品快取 5 秒 */
    int availableForDisplay(long productId, boolean hot);

    /** 可售庫存 = onHand - reserved。13 站 2.7：沒有庫存列（product.created 還沒送到）= 0 */
    int available(long productId);

    /** 一次查多個商品的可售庫存（一句 SQL）。沒有庫存列的商品不會出現在結果裡。 */
    Map<Long, Integer> available(Collection<Long> productIds);

    // ───────── 13 站 2.6：跨模組的對帳（ordering 的 ReservationReconciliation）─────────
    // 「預留」與「訂單」在同一個資料庫裡時，一句 JOIN 就能對；拆開之後，兩邊各問各的、在程式裡比。這三個方法是庫存那一邊

    /** 還佔著庫存（HELD、CONFIRMED）、建立早於 createdBefore 的預留，依 id 由小到大（keyset 分頁：id > afterId）。不開交易：一句 SELECT */
    List<ReservationRef> activeReservations(long afterId, java.time.Instant createdBefore, int limit);

    /** 這些訂單的預留，各是什麼狀態（一張訂單有幾個品項就有幾筆）。沒有任何預留的訂單不會出現在結果裡 */
    Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds);

    /**
     * 釋放一張「不存在、或已經取消」的訂單還佔著的預留：跟 release() 做一樣的事，但自己開交易 —— release() 是 MANDATORY，
     * 因為它本來要跟訂單的狀態一起 commit；對帳找到的這種預留，訂單那邊沒有東西要一起 commit。冪等：已經釋放的不會再釋放。
     * 「這張訂單不存在或已取消」由呼叫端（ordering）判斷：庫存模組不知道訂單
     */
    void releaseAbandoned(long orderId);
}
```

**`src/main/java/com/example/shop/inventory/internal/JdbcInventoryService.java`**（3.4.2、3.5.3）

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.inventory.ReservationRef;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.events.EventTypes;
import com.example.shop.shared.events.Outbox;
import com.example.shop.shared.redis.RedisGuard;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Optional;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
class JdbcInventoryService implements InventoryApi {

    /** US-PRD-3 AC-4：一般商品的可售量顯示，允許 5 秒的延遲 */
    static final Duration DISPLAY_TTL = Duration.ofSeconds(5);

    private static final Logger log = LoggerFactory.getLogger(JdbcInventoryService.class);

    private final JdbcTemplate jdbc;
    private final HotStock hot;
    private final StringRedisTemplate redis;
    private final RedisGuard guard;
    private final Outbox outbox;
    private final Counter shortages;
    /** 6.9.2 Redis 不能用的時候，可售量在本機記憶體裡放 5 秒（AC-4 允許的延遲）：不然每一次看商品頁都是一句 MySQL */
    private final java.util.concurrent.ConcurrentHashMap<Long, long[]> degradedAvailable = new java.util.concurrent.ConcurrentHashMap<>();

    JdbcInventoryService(JdbcTemplate jdbc, HotStock hot, StringRedisTemplate redis, RedisGuard guard, Outbox outbox, MeterRegistry meters) {
        this.jdbc = jdbc;
        this.hot = hot;
        this.redis = redis;
        this.guard = guard;
        this.outbox = outbox;
        this.shortages = Counter.builder("shop.inventory.hot.shortage")
                .description("熱點落帳時 MySQL 不夠（Redis 的閘門放進了不存在的庫存）→ 訂單會被取消。正常應該永遠是 0").register(meters);
    }

    @Override
    public void gateHot(List<ReserveLine> hotLines) {
        if (!hotLines.isEmpty()) hot.gate(hotLines);
    }

    @Override
    public void returnHot(List<ReserveLine> hotLines) {
        hot.giveBack(hotLines);
    }

    /**
     * 13 站 3.5：庫存服務的 POST /hot-gate。同一個 requestKey 只減一次 —— 回應在回程上丟了、呼叫端用同一個鍵再送一次，
     * Redis 的腳本看到這個鍵的標記就直接回「成功」，不會再減（3.2 ② 的熱點下單：閘門 −2）。
     * @return true = 這個鍵之前已經減過了（這一次什麼都沒做）
     */
    public boolean gateHotOnce(List<ReserveLine> hotLines, String requestKey) {
        return !hotLines.isEmpty() && hot.gate(hotLines, requestKey);
    }

    /** 13 站 3.5：POST /hot-gate/returns。同一個 requestKey 只加回一次 */
    public boolean returnHotOnce(List<ReserveLine> hotLines, String requestKey) {
        return hot.giveBack(hotLines, requestKey);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void setHot(long productId, boolean isHot) {
        if (isHot) {
            if (!TransactionSynchronizationManager.isSynchronizationActive()) { hot.initialize(productId); return; }
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() { hot.initialize(productId); }       // commit 之後才讀 MySQL：讀到的是這次之後的可售量
            });
        } else {
            hot.removeAfterCommit(productId);
        }
    }

    @Override
    public int availableForDisplay(long productId, boolean isHot) {
        if (isHot) {
            Optional<Integer> v = hot.display(productId);
            if (v.isPresent()) return Math.max(0, v.get());
        }
        String key = "available:" + productId;
        Optional<String> cached = guard.call("available.get", () -> redis.opsForValue().get(key));
        if (cached.isPresent()) return Integer.parseInt(cached.get());
        long now = System.currentTimeMillis();
        if (!guard.available()) {
            long[] l = degradedAvailable.get(productId);                    // {值, 到期時間}
            if (l != null && l[1] > now) return (int) l[0];
        }
        int v = available(productId);
        if (guard.available()) guard.run("available.put", () -> redis.opsForValue().set(key, String.valueOf(v), DISPLAY_TTL));
        else degradedAvailable.put(productId, new long[]{v, now + DISPLAY_TTL.toMillis()});
        return v;
    }

    /** 13 站 3.4：不在 InventoryApi 上了 —— 只有 product.created 的消費者（InventoryEventHandlers）呼叫它 */
    @Transactional(propagation = Propagation.MANDATORY)
    public void initialize(long productId, int onHand, String note) {
        if (onHand < 0) throw new IllegalArgumentException("onHand must not be negative");
        // 13 站 2.7：補貨可能比 product.created 先到（restock 會先建一列）—— 已經有就加上去，帳照記（INV-3 照樣成立）
        jdbc.update("""
                INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0) AS new
                ON DUPLICATE KEY UPDATE on_hand = inventory.on_hand + new.on_hand, updated_at = CURRENT_TIMESTAMP(3)""", productId, onHand);
        if (onHand > 0) ledger(productId, onHand, 0, "INITIAL", note);     // ck_ledger_delta：數量為 0 就不記帳
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        reserveCounted(orderId, lines);
        if (!hotLines.isEmpty()) holdHot(orderId, hotLines);
    }

    private void reserveCounted(long orderId, List<ReserveLine> lines) {
        List<ReserveLine> sorted = lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList();
        for (ReserveLine l : sorted) {
            int n = jdbc.update("""
                    UPDATE inventory SET reserved = reserved + ?, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE product_id = ? AND on_hand - reserved >= ?""",
                    l.quantity(), l.productId(), l.quantity());
            if (n == 0) throw new InsufficientStockException(l.productId());
            // 先 UPDATE 父表（拿 X 鎖）、再 INSERT 子表（2.6.2）
            jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (?, ?, ?, 'HELD')",
                    orderId, l.productId(), l.quantity());
            ledger(l.productId(), 0, l.quantity(), "RESERVE", "order:" + orderId);
        }
    }

    /** 7.6 熱點品項：13 站 3.4 之前是 InventoryApi 上的另一個方法，現在是 reserve() 的一部分 */
    private void holdHot(long orderId, List<ReserveLine> lines) {
        // 只有預留列。inventory 那一列一個字都不碰 —— 搶購時 500 個交易排的就是那一列的鎖（6.5.4）
        for (ReserveLine l : lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList())
            jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status, counted) VALUES (?, ?, ?, 'HELD', FALSE)",
                    orderId, l.productId(), l.quantity());
    }

    /**
     * 7.6.2 熱點落帳：把這張訂單還沒計入的預留，加到 inventory.reserved。由 inventory.hot-settlement 消費者呼叫（交易由 EventDispatcher 開）。
     *
     *   ① 鎖住這張訂單還沒計入的預留列（跟 release() 同一個順序：先預留列、再 inventory 列 —— 取消與落帳不會死鎖）
     *   ② 鎖住每一個商品的 inventory 列，先全部檢查夠不夠（全有或全無：US-ORD-1 AC-5）
     *   ③ 夠 → reserved += 、counted = TRUE、記一筆 RESERVE
     *      不夠 → Redis 的閘門放進了 MySQL 沒有的庫存（7.6.3）：那一列 RELEASED，發一個 inventory.hot-settlement-failed，訂單模組會取消訂單；
     *             閘門減掉的數量裡「真的存在」的那一部分加回 Redis（6.5.3 的 ⚠️、練習九，見下面）
     * 預留列已經 RELEASED（訂單先被取消了）或已經 counted（重複的訊息）→ ① 什麼都找不到，直接結束。
     * @return 計入了幾列；-1 = 庫存不足
     */
    int settleHot(long orderId) {
        List<Held> lines = jdbc.query("""
                SELECT id, product_id, quantity, counted FROM inventory_reservations
                 WHERE order_id = ? AND status IN ('HELD', 'CONFIRMED') AND counted = FALSE ORDER BY product_id FOR UPDATE""",
                (rs, i) -> new Held(rs.getLong(1), rs.getLong(2), rs.getInt(3), rs.getBoolean(4)), orderId);
        for (Held h : lines) {
            Integer available = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ? FOR UPDATE", Integer.class, h.productId());
            if (available == null || available < h.quantity()) {
                jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
                outbox.add("ORDER", orderId, EventTypes.HOT_SETTLEMENT_FAILED, Map.of("orderId", orderId, "productId", h.productId(),
                        "requested", h.quantity(), "available", available == null ? 0 : available));
                // 6.5.3 的 ⚠️、練習九：閘門放行代表 Redis 有 R ≥ q，減完剩 R − q。這一列 RELEASED 之後，取消時的 release() 看不到它，
                // 第 06 章的「那一個品項不加回去」在這裡原封不動：q = 1 時 R − 1 ≥ 0 = MySQL，是修正了一次偏高；
                // q > 1 時不一定 —— Redis 3、MySQL 可售 2、買 3 件：Redis 變成 0，MySQL 還有 2 件（偏低，少賣 2 件，要等對帳）。
                // 修法：只加回「真的存在」的那一部分 —— 閘門該有的值（GATE_BASE_SQL，已經不含這一列）。不是一律加回 q：
                // 7.6.3 之後偏高的代價是「回了 201 之後取消」，能不放出去的就不放。不需要多讀 Redis：R ≥ q，所以 R − q + base ≥ base，不會偏低。
                // 這一句的 SUM 是一致性讀：讀到的快照比 FOR UPDATE 舊的話，在那之間 commit 的取消、補貨各有自己的 stock-returned 會加回；
                // 在那之間成立、還沒計入的新訂單沒被扣到 → 偏高（安全的方向）。加回走 7.6.5 的事件，跟這個交易一起 commit。
                Integer base = jdbc.queryForObject(HotStock.GATE_BASE_SQL, Integer.class, h.productId());
                int giveBack = base == null ? 0 : Math.max(0, Math.min(h.quantity(), base));
                if (giveBack > 0) returnToHotStock(orderId, List.of(new ReserveLine(h.productId(), giveBack)));
                shortages.increment();
                log.warn("HOT_SETTLEMENT_SHORTAGE orderId={} productId={} requested={} available={} giveBack={}（訂單會被取消）",
                        orderId, h.productId(), h.quantity(), available, giveBack);
                return -1;
            }
        }
        for (Held h : lines) {
            int n = jdbc.update("""
                    UPDATE inventory SET reserved = reserved + ?, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE product_id = ? AND on_hand - reserved >= ?""", h.quantity(), h.productId(), h.quantity());
            if (n != 1) throw new IllegalStateException("inventory " + h.productId() + " 已經鎖住而且檢查過了，UPDATE 卻沒有成功");
            jdbc.update("UPDATE inventory_reservations SET counted = TRUE, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
            ledger(h.productId(), 0, h.quantity(), "RESERVE", "order:" + orderId);
        }
        return lines.size();
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void confirm(long orderId) {
        jdbc.update("""
                UPDATE inventory_reservations SET status = 'CONFIRMED', updated_at = CURRENT_TIMESTAMP(3)
                 WHERE order_id = ? AND status = 'HELD'""", orderId);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void release(long orderId) {
        List<ReserveLine> released = new ArrayList<>();
        for (Held h : held(orderId, "'HELD', 'CONFIRMED'")) {
            released.add(new ReserveLine(h.productId(), h.quantity()));
            if (h.counted()) {
                jdbc.update("UPDATE inventory SET reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = ?",
                        h.quantity(), h.productId());
                ledger(h.productId(), 0, -h.quantity(), "RELEASE", "order:" + orderId);
            }                                                               // 7.6：還沒計入的熱點預留 —— reserved 本來就沒有加，只改狀態
            jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
        }
        returnToHotStock(orderId, released);                                // 熱點商品：Redis 的閘門要加回去（7.6.5）
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void consume(long orderId) {
        List<Held> rows = held(orderId, "'CONFIRMED'");
        if (rows.stream().anyMatch(h -> !h.counted()))                      // 7.6.4：落帳還沒完成。幾秒後就會好 —— 出貨不差這幾秒
            throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "這張訂單的庫存還在落帳，請稍後再出貨").with("retryAfter", 5);
        // 7.6.4：落帳發現不夠、那一列已經 RELEASED，取消的事件還在路上。這時候出貨 = 出一件不存在的貨（onHand 不會減）
        Integer released = jdbc.queryForObject("SELECT COUNT(*) FROM inventory_reservations WHERE order_id = ? AND status = 'RELEASED'", Integer.class, orderId);
        if (released != null && released > 0)
            throw new ShopException(ProblemType.INVALID_STATE, "這張訂單有商品庫存不足，即將取消，不能出貨");
        for (Held h : rows) {
            jdbc.update("""
                    UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE product_id = ?""", h.quantity(), h.quantity(), h.productId());
            jdbc.update("UPDATE inventory_reservations SET status = 'CONSUMED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
            ledger(h.productId(), -h.quantity(), -h.quantity(), "SHIP", "order:" + orderId);
        }
    }

    record Held(long id, long productId, int quantity, boolean counted) {}

    /**
     * 這張訂單還佔著庫存的預留，依 productId 排序。先鎖預留列（FOR UPDATE），再依序改 inventory：
     * 同一張訂單的兩個釋放（例如兩個排程實例）會在第一句就排隊，第二個進來時看到的已經是 RELEASED —— 不會重複減。
     * 註：這裡的 statuses 只會是程式裡的常數，不是使用者輸入。
     */
    private List<Held> held(long orderId, String statuses) {
        return jdbc.query("""
                SELECT id, product_id, quantity, counted FROM inventory_reservations
                 WHERE order_id = ? AND status IN (%s) ORDER BY product_id FOR UPDATE""".formatted(statuses),
                (rs, i) -> new Held(rs.getLong(1), rs.getLong(2), rs.getInt(3), rs.getBoolean(4)), orderId);
    }

    @Override
    @Transactional
    public void restock(long productId, int quantity, String note) {
        if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
        // 13 站 2.7：庫存列還沒建立（product.created 還沒送到）也要補得進去 —— 不然下一句帳撞外鍵（fk_ledger_inventory）
        jdbc.update("""
                INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0) AS new
                ON DUPLICATE KEY UPDATE on_hand = inventory.on_hand + new.on_hand, updated_at = CURRENT_TIMESTAMP(3)""", productId, quantity);
        ledger(productId, quantity, 0, "RESTOCK", note);
        returnToHotStock(productId, List.of(new ReserveLine(productId, quantity)));
    }

    /**
     * 7.6.5 熱點商品的閘門要加回去（取消、補貨）。第 06 章是 afterCommit 直接加：commit 之後、加之前行程死掉，Redis 就少了這幾件（6.5.3）。
     * 改成跟這個交易一起寫一個事件：一定會被加回去；重複送到時會多加 —— 偏高，是 6.5.3 說的安全方向。
     * 不是熱點的商品，Redis 裡沒有 key，消費者什麼都不做。
     */
    private void returnToHotStock(long aggregateId, List<ReserveLine> lines) {
        if (lines.isEmpty()) return;
        outbox.add("INVENTORY", aggregateId, EventTypes.STOCK_RETURNED,
                Map.of("lines", lines.stream().map(l -> Map.of("productId", l.productId(), "quantity", l.quantity())).toList()));
    }

    @Override
    @Transactional(readOnly = true)
    public int available(long productId) {
        // 13 站 2.7：沒有庫存列 = 0（queryForObject 在這裡會丟 EmptyResultDataAccessException —— 第 00 章那個商品頁的 500）
        List<Integer> v = jdbc.queryForList("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, productId);
        return v.isEmpty() || v.get(0) == null ? 0 : v.get(0);
    }

    @Override
    @Transactional(readOnly = true)
    public Map<Long, Integer> available(Collection<Long> productIds) {
        Map<Long, Integer> result = new HashMap<>();
        if (productIds.isEmpty()) return result;
        String in = String.join(",", productIds.stream().map(id -> "?").toList());
        jdbc.query("SELECT product_id, on_hand - reserved FROM inventory WHERE product_id IN (" + in + ")",
                rs -> { result.put(rs.getLong(1), rs.getInt(2)); }, productIds.toArray());
        return result;
    }

    // ───────── 13 站 2.6：對帳用 ─────────

    @Override
    public List<ReservationRef> activeReservations(long afterId, java.time.Instant createdBefore, int limit) {
        return jdbc.query("""
                SELECT id, order_id, product_id, quantity, status FROM inventory_reservations
                 WHERE id > ? AND status IN ('HELD', 'CONFIRMED') AND created_at < ? ORDER BY id LIMIT ?""",
                (rs, i) -> new ReservationRef(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getInt(4), rs.getString(5)),
                afterId, java.sql.Timestamp.from(createdBefore), limit);
    }

    @Override
    public Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds) {
        Map<Long, List<ReservationRef>> result = new HashMap<>();
        if (orderIds.isEmpty()) return result;
        String in = String.join(",", orderIds.stream().map(id -> "?").toList());
        jdbc.query("SELECT id, order_id, product_id, quantity, status FROM inventory_reservations WHERE order_id IN (" + in + ") ORDER BY id",
                rs -> { result.computeIfAbsent(rs.getLong(2), k -> new ArrayList<>())
                        .add(new ReservationRef(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getInt(4), rs.getString(5))); },
                orderIds.toArray());                                         // uk_reservations_order_product 的最左欄
        return result;
    }

    @Override
    @Transactional
    public void releaseAbandoned(long orderId) {
        release(orderId);                                                   // 同一個物件裡呼叫：不經過代理，MANDATORY 不檢查 —— 這個交易就是它的交易
    }

    private void ledger(long productId, int deltaOnHand, int deltaReserved, String reason, String ref) {
        jdbc.update("""
                INSERT INTO inventory_ledger(product_id, delta_on_hand, delta_reserved, reason, ref)
                VALUES (?, ?, ?, ?, ?)""", productId, deltaOnHand, deltaReserved, reason, ref);
    }
}
```

**`src/main/java/com/example/shop/inventory/internal/HotStock.java`**（3.5.3）

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.redis.DistributedLock;
import com.example.shop.shared.redis.RedisGuard;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.Cursor;
import org.springframework.data.redis.core.ScanOptions;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * 6.5 熱點商品的閘門（0.6.1 第 3 條）：Redis 的 stock:{id} 是 MySQL 可售量的「快速副本」（0.3.3）。
 *
 * 一條原則決定了這個類別的每一個方法：**MySQL 的條件式 UPDATE 仍然是最後一道防線（4.2.1 ⑥），Redis 只是擋在前面的閘門。**
 *  - Redis 的數字「偏高」：多放一些請求進 MySQL，MySQL 會擋下（409）—— 浪費，但不會超賣。
 *  - Redis 的數字「偏低」：該賣的沒賣出去（少賣）—— 這才是要避免、而且要被對帳抓到的方向。
 *
 * 所以：
 *  - 減（下單）在 MySQL 之前：Redis 先減，MySQL 失敗再加回來（6.2.4：漏了加回來 = 少賣）。
 *  - 加（取消、補貨）在 MySQL commit 之後：commit 失敗就不加。
 *  - 修正（對帳）只在「Redis 的值從頭到尾沒變」時才寫入（CAS，6.6）：只可能多算，不可能少算。
 *
 * ⚠️ 第 07 章改變了「偏高」的代價（7.6.3）：熱點商品的 MySQL 預留移到了交易之外，MySQL 不再「當場」擋下 ——
 * 偏高 = 下單回了 201，幾秒後落帳發現不夠，訂單被取消（MySQL 仍然不會超賣）。偏高從「浪費」變成「失信」，仍然好過少賣，但要被看見：
 * shop.inventory.hot.shortage。
 */
@Component
class HotStock {

    private static final Logger log = LoggerFactory.getLogger(HotStock.class);

    /** 全有或全無：每一個品項都夠才一起減。回傳 {0,0} = 成功；{-1,i} = 第 i 個 key 不存在；{-2,i} = 第 i 個不夠 */
    static final RedisScript<List> GATE = RedisScript.of("""
            for i, k in ipairs(KEYS) do
              local v = redis.call('GET', k)
              if not v then return {-1, i} end
              if tonumber(v) < tonumber(ARGV[i]) then return {-2, i} end
            end
            for i, k in ipairs(KEYS) do redis.call('DECRBY', k, ARGV[i]) end
            return {0, 0}""", List.class);

    /** 加回去，但只加「存在的」key：不存在代表 Redis 的資料丟了，下一次用到時會從 MySQL 重建（6.5.3） */
    static final RedisScript<Long> RETURN = RedisScript.of("""
            for i, k in ipairs(KEYS) do
              if redis.call('EXISTS', k) == 1 then redis.call('INCRBY', k, ARGV[i]) end
            end
            return 1""", Long.class);

    /**
     * 13 站 3.5：跟 GATE 一樣，多一個「這一次請求」的標記（最後一個 KEY；最後一個 ARGV 是它的存活秒數）。
     * 標記在 → {1,0}：這個請求之前已經減過了，這一次不減。減成功才放標記 —— 不夠的那一次沒有減，再送一次應該重新判斷
     */
    static final RedisScript<List> GATE_ONCE = RedisScript.of("""
            local n = #KEYS - 1
            if redis.call('EXISTS', KEYS[#KEYS]) == 1 then return {1, 0} end
            for i = 1, n do
              local v = redis.call('GET', KEYS[i])
              if not v then return {-1, i} end
              if tonumber(v) < tonumber(ARGV[i]) then return {-2, i} end
            end
            for i = 1, n do redis.call('DECRBY', KEYS[i], ARGV[i]) end
            redis.call('SET', KEYS[#KEYS], '1', 'EX', ARGV[#ARGV])
            return {0, 0}""", List.class);

    /** 13 站 3.5：跟 RETURN 一樣，多一個標記。標記在 → 0：加過了 */
    static final RedisScript<Long> RETURN_ONCE = RedisScript.of("""
            if redis.call('EXISTS', KEYS[#KEYS]) == 1 then return 0 end
            for i = 1, #KEYS - 1 do
              if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('INCRBY', KEYS[i], ARGV[i]) end
            end
            redis.call('SET', KEYS[#KEYS], '1', 'EX', ARGV[#ARGV])
            return 1""", Long.class);

    /** 標記留多久：比任何一次重送的間隔都長得多（呼叫端的重試在幾秒之內） */
    static final long ONCE_TTL_SECONDS = 600;

    /** 對帳的寫入：只有在值還是 ARGV[1]（讀的時候看到的那個）才改成 ARGV[2] */
    static final RedisScript<Long> CAS = RedisScript.of("""
            if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end
            return 0""", Long.class);

    private final StringRedisTemplate redis;
    private final RedisGuard guard;
    private final DistributedLock locks;
    private final JdbcTemplate jdbc;
    private final Counter drift;
    private final java.util.concurrent.ConcurrentHashMap<Long, String> lastMismatch = new java.util.concurrent.ConcurrentHashMap<>();

    HotStock(StringRedisTemplate redis, RedisGuard guard, DistributedLock locks, JdbcTemplate jdbc, MeterRegistry meters) {
        this.redis = redis;
        this.guard = guard;
        this.locks = locks;
        this.jdbc = jdbc;
        this.drift = Counter.builder("shop.inventory.hot.drift").description("對帳發現 Redis 與 MySQL 不一致、並修正的次數").register(meters);
    }

    static String key(long productId) { return "stock:" + productId; }

    /**
     * 下單前（交易外）：在 Redis 減掉這些熱點品項。不夠 → 409；Redis 不能用 → 503（0.6.3：熱點商品 × Redis 掛了 = 503，艙壁）。
     */
    void gate(List<ReserveLine> lines) {
        gate(lines, null);
    }

    /**
     * 13 站 3.5：requestKey 不是 null → 同一個鍵只減一次（GATE_ONCE）。
     * @return true = 這個鍵之前已經減過了
     */
    boolean gate(List<ReserveLine> lines, String requestKey) {
        List<ReserveLine> sorted = lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList();
        List<String> keys = new ArrayList<>(sorted.stream().map(l -> key(l.productId())).toList());
        List<Object> args = new ArrayList<>(sorted.stream().map(l -> (Object) String.valueOf(l.quantity())).toList());
        if (requestKey != null) {
            keys.add("gate-once:" + requestKey);
            args.add(String.valueOf(ONCE_TTL_SECONDS));
        }
        Object[] qty = args.toArray();
        for (int attempt = 0; attempt < 3; attempt++) {
            List<?> r = guard.call("hot-stock.gate", () -> redis.execute(requestKey == null ? GATE : GATE_ONCE, keys, qty)).orElseThrow(HotStock::unavailable);
            int code = ((Number) r.get(0)).intValue(), i = ((Number) r.get(1)).intValue();
            if (code == 1) return true;
            if (code == 0) return false;
            long productId = sorted.get(i - 1).productId();
            if (code == -2) throw new InsufficientStockException(productId);
            initialize(productId);                                          // -1：key 不存在 → 從 MySQL 建，再試一次
        }
        throw unavailable();
    }

    /**
     * 13 站 3.5：同一個 requestKey 只加回一次（RETURN_ONCE）。Redis 不能用 → 跟 giveBack 一樣記一行日誌、等對帳。
     * @return true = 這個鍵之前已經加回過了
     */
    boolean giveBack(List<ReserveLine> lines, String requestKey) {
        if (lines.isEmpty()) return false;
        List<String> keys = new ArrayList<>(lines.stream().map(l -> key(l.productId())).toList());
        keys.add("return-once:" + requestKey);
        List<Object> args = new ArrayList<>(lines.stream().map(l -> (Object) String.valueOf(l.quantity())).toList());
        args.add(String.valueOf(ONCE_TTL_SECONDS));
        Optional<Long> r = guard.call("hot-stock.give-back", () -> redis.execute(RETURN_ONCE, keys, args.toArray()));
        if (r.isEmpty()) log.warn("HOT_STOCK_GIVE_BACK_FAILED {}（等對帳修正：在那之前這些數量賣不出去）", lines);
        return r.isPresent() && r.get() == 0L;
    }

    /** 下單失敗（價格變了、商品下架、資料庫錯誤……）：把減掉的加回去。失敗就只能等對帳（少賣，6.2.4） */
    void giveBack(List<ReserveLine> lines) {
        if (lines.isEmpty()) return;
        List<String> keys = lines.stream().map(l -> key(l.productId())).toList();
        Object[] qty = lines.stream().map(l -> String.valueOf(l.quantity())).toArray();
        if (!guard.run("hot-stock.give-back", () -> redis.execute(RETURN, keys, qty)))
            log.warn("HOT_STOCK_GIVE_BACK_FAILED {}（等對帳修正：在那之前這些數量賣不出去）", lines);
    }

    /**
     * 7.6.5 取消、補貨之後加回去（inventory.stock-returned 的消費者）。第 06 章的 giveBackAfterCommit 換成了事件：
     * 失敗就丟例外 —— 讓訊息走重試階梯，而不是像 giveBack() 一樣記一行日誌、等對帳。
     */
    void giveBackOrFail(List<ReserveLine> lines) {
        if (lines.isEmpty()) return;
        List<String> keys = lines.stream().map(l -> key(l.productId())).toList();
        Object[] qty = lines.stream().map(l -> String.valueOf(l.quantity())).toArray();
        if (!guard.run("hot-stock.give-back", () -> redis.execute(RETURN, keys, qty)))
            throw new IllegalStateException("Redis 不能用，熱點庫存加不回去：" + lines);
    }

    /**
     * Redis 的 stock:{id} 應該是多少（6.5.1 建立、6.6 對帳）。7.6 之後要再減掉「已經過了閘門、預留列寫了、還沒計入 reserved」的那些 ——
     * 否則對帳會把它們再放出去一次，閘門就放進了 MySQL 沒有的庫存（7.6.3）。
     * 一句 SQL：預留列的 counted 從 FALSE 變成 TRUE、reserved 加上同一個數，是在同一個交易裡發生的 —— 這句讀到的永遠是其中一邊。
     */
    static final String GATE_BASE_SQL = """
            SELECT i.on_hand - i.reserved - COALESCE((SELECT SUM(r.quantity) FROM inventory_reservations r
                                                       WHERE r.product_id = i.product_id AND r.status IN ('HELD', 'CONFIRMED')
                                                         AND r.counted = FALSE), 0)
              FROM inventory i WHERE i.product_id = ?""";

    /**
     * key 不存在（剛標成熱點、或 Redis 的資料丟了）：從 MySQL 的可售量建立。
     * 鎖不是為了正確性（SET NX 只會有一個人成功），是為了「100 個請求同時發現 key 不存在」時，只有一個去讀 MySQL。
     */
    void initialize(long productId) {
        Optional<DistributedLock.Handle> lock = guard.call("hot-stock.lock", () -> locks.tryLock("lock:" + key(productId), Duration.ofSeconds(2)).orElse(null));
        if (lock.isEmpty()) { sleep(20); return; }                          // 別人在建：等一下再試
        try {
            // 13 站 2.7：庫存列還沒建立（product.created 還沒送到）—— 不建 key：用 0 建，事件送到之後 Redis 會一直少那些庫存，直到對帳
            List<Integer> rows = jdbc.queryForList(GATE_BASE_SQL, Integer.class, productId);
            if (rows.isEmpty()) { log.warn("HOT_STOCK_NO_ROW productId={}：還沒有庫存列，先不建閘門", productId); return; }
            Integer available = rows.get(0);
            guard.run("hot-stock.init", () -> redis.opsForValue().setIfAbsent(key(productId), String.valueOf(available)));
        } finally {
            guard.run("hot-stock.unlock", () -> locks.unlock(lock.get()));
        }
    }

    /** 不再是熱點：刪掉 key（commit 之後） */
    void removeAfterCommit(long productId) {
        Runnable del = () -> guard.run("hot-stock.remove", () -> redis.delete(key(productId)));
        if (!TransactionSynchronizationManager.isSynchronizationActive()) { del.run(); return; }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() { del.run(); }
        });
    }

    /** 商品頁顯示用（US-PRD-3 AC-4：允許約略值）。Redis 沒有或不能用 → empty */
    Optional<Integer> display(long productId) {
        return guard.call("hot-stock.display", () -> redis.opsForValue().get(key(productId))).map(Integer::valueOf);
    }

    /**
     * 6.6 對帳（0.6.4：Redis 預扣 ⇄ MySQL，差異必須為 0）：每一個 stock:* 讀一次 Redis、讀一次 MySQL，不一樣就用 CAS 改成 MySQL 的值。
     * CAS 失敗 = 這段期間有人動過它（下單、取消、補貨）—— 不改，下一輪再看。
     * 同一組不一致要「連續兩輪」都看到才改：搶購進行中，一張訂單在「Redis 已減、MySQL 還沒 commit」的那幾毫秒裡，兩邊本來就不一樣。
     * @return 這一輪修正了幾個
     */
    int reconcile() {
        List<Long> ids = new ArrayList<>();
        guard.run("hot-stock.scan", () -> {
            try (Cursor<String> c = redis.scan(ScanOptions.scanOptions().match("stock:*").count(500).build())) {
                c.forEachRemaining(k -> ids.add(Long.parseLong(k.substring("stock:".length()))));
            }
        });
        int fixed = 0;
        for (long id : ids) {
            Optional<String> before = guard.call("hot-stock.read", () -> redis.opsForValue().get(key(id)));
            if (before.isEmpty()) continue;
            Integer db = jdbc.queryForObject(GATE_BASE_SQL, Integer.class, id);
            String seen = before.get() + "/" + db;
            if (db == null || before.get().equals(String.valueOf(db))) { lastMismatch.remove(id); continue; }
            if (!seen.equals(lastMismatch.put(id, seen))) continue;            // 第一次看到：先記下來
            lastMismatch.remove(id);
            boolean swapped = guard.call("hot-stock.cas", () -> redis.execute(CAS, List.of(key(id)), before.get(), String.valueOf(db))).orElse(0L) == 1L;
            if (swapped) {
                fixed++;
                drift.increment();
                log.warn("HOT_STOCK_DRIFT productId={} redis={} mysql={}（已修正成 MySQL 的值）", id, before.get(), db);
            }
        }
        return fixed;
    }

    static ShopException unavailable() {
        return new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "熱門商品暫時無法下單，請稍後再試").with("retryAfter", 5);
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
```

**`src/main/java/com/example/shop/inventory/internal/remote/RemoteInventoryApi.java`**（3.4.5、3.5.4）

```java
package com.example.shop.inventory.internal.remote;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReservationRef;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.inventory.internal.web.InventoryWire.*;
import com.example.shop.shared.config.ConditionalOnServiceRole;
import com.example.shop.shared.config.ServiceRole;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.security.ServiceTokens;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Primary;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.support.RestClientAdapter;
import org.springframework.web.service.invoker.HttpServiceProxyFactory;

import java.net.http.HttpClient;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * 13 站 3.4、3.5、3.6：訂單服務裡的 InventoryApi —— 每一個方法是一次（或兩次）HTTP 呼叫。只在 role = order-service 時存在，
 * 而且是 @Primary：同一個 jar 裡的 JdbcInventoryService 還是一個 bean，但沒有人會注入它（它的表不在這個服務的庫裡）。
 *
 * 呼叫端的程式碼（PlaceOrderService、ProductService、CartService、ReservationReconciliation）一行都不用改：
 *
 *   ① 錯誤翻譯回同一個例外。只有三種業務錯誤原樣交給使用者：庫存不足（409）、狀態不對（409）、暫時不能用（503）。
 *      其他的 —— 401、403（服務的 token 設錯了）、404（呼叫了一支對方還沒有的端點）、400、422 —— 是「我們」的錯，不是使用者的：500。
 *   ② 沒有回應（連不上、等不到）→ 再送一次，用同一個冪等鍵。只送一次：重試的次數與間隔、跟熔斷怎麼配，是第 06 章的事。
 *      兩次都沒有回應 → 503，請使用者稍後再試。
 *   ③ 空的清單不送。在一個行程裡，gateHot(空清單) 是一個什麼都不做的方法呼叫；在這裡，它是一次網路往返（3.4.3：第 02 章每一張訂單都送了）。
 *   ④ 每一次請求帶一個服務的 token（ServiceTokens，3.6）。
 */
@Component
@Primary
@ConditionalOnServiceRole(ServiceRole.ORDER_SERVICE)
class RemoteInventoryApi implements InventoryApi {

    private static final Logger log = LoggerFactory.getLogger(RemoteInventoryApi.class);

    /** 照原樣交給使用者的錯誤（其他的都是系統錯誤） */
    static final Set<ProblemType> PASS_THROUGH = Set.of(ProblemType.INSUFFICIENT_STOCK, ProblemType.INVALID_STATE, ProblemType.TEMPORARILY_UNAVAILABLE);
    private static final Set<String> STANDARD = Set.of("type", "title", "status", "detail", "instance", "traceId");

    private final InventoryClient client;
    private final ObjectMapper json;
    private final MeterRegistry meters;

    RemoteInventoryApi(RestClient.Builder builder, ShopProperties props, ServiceTokens tokens, ObjectMapper json, MeterRegistry meters) {
        ShopProperties.Remote r = props.deployment().inventory();
        JdkClientHttpRequestFactory f = new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(r.connectTimeout()).build());
        f.setReadTimeout(r.readTimeout());
        RestClient rest = builder.baseUrl(r.url()).requestFactory(f)
                .requestInterceptor((req, body, exec) -> {
                    req.getHeaders().setBearerAuth(tokens.tokenFor(ServiceRole.INVENTORY_SERVICE));
                    return exec.execute(req, body);
                })
                .build();
        this.client = HttpServiceProxyFactory.builderFor(RestClientAdapter.create(rest)).build().createClient(InventoryClient.class);
        this.json = json;
        this.meters = meters;
    }

    // ───────── 寫 ─────────

    @Override
    public void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        call("reserve", () -> client.reserve(orderId, new ReserveRequest(lines, hotLines)));
    }

    @Override public void confirm(long orderId) { run("confirm", () -> client.confirm(orderId)); }
    @Override public void release(long orderId) { run("release", () -> client.release(orderId)); }
    @Override public void consume(long orderId) { run("consume", () -> client.consume(orderId)); }

    /** 對帳的釋放：在服務之間跟 release 是同一支端點（每一次呼叫本來就是庫存服務自己的交易） */
    @Override public void releaseAbandoned(long orderId) { run("release", () -> client.release(orderId)); }

    @Override
    public void restock(long productId, int quantity, String note) {
        String key = UUID.randomUUID().toString();                          // 這一次補貨的鍵：重送用同一個
        call("restock", () -> client.restock(productId, key, new RestockRequest(quantity, note)));
    }

    @Override
    public void setHot(long productId, boolean hot) {
        // 在一個行程裡是 MANDATORY、commit 之後才建閘門；這裡是庫存服務自己的交易，回應之前就建好了。
        // 呼叫端的交易之後 rollback（商品沒有標成熱點）→ 多一個沒人用的閘門；反過來 → 下一次下單時閘門從 MySQL 重建（6.5.3）：兩邊都會自己收斂
        run("set-hot", () -> client.hot(productId, new HotRequest(hot)));
    }

    @Override
    public void gateHot(List<ReserveLine> hotLines) {
        if (hotLines.isEmpty()) return;
        String key = UUID.randomUUID().toString();
        call("gate-hot", () -> client.gate(key, new LinesRequest(hotLines)));
    }

    @Override
    public void returnHot(List<ReserveLine> hotLines) {
        if (hotLines.isEmpty()) return;
        String key = UUID.randomUUID().toString();
        call("return-hot", () -> client.giveBack(key, new LinesRequest(hotLines)));
    }

    // ───────── 讀 ─────────

    @Override
    public int availableForDisplay(long productId, boolean hot) {
        return call("display", () -> client.display(productId, hot)).available();
    }

    @Override
    public int available(long productId) {
        return available(List.of(productId)).getOrDefault(productId, 0);  // 2.7：沒有庫存列 = 0
    }

    @Override
    public Map<Long, Integer> available(Collection<Long> productIds) {
        Map<Long, Integer> out = new HashMap<>();
        if (productIds.isEmpty()) return out;
        call("stock", () -> client.stock(List.copyOf(productIds))).items().forEach(s -> out.put(s.productId(), s.available()));
        return out;
    }

    @Override
    public List<ReservationRef> activeReservations(long afterId, Instant createdBefore, int limit) {
        return call("active-reservations", () -> client.active(afterId, createdBefore.toString(), limit)).items();
    }

    @Override
    public Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds) {
        Map<Long, List<ReservationRef>> out = new HashMap<>();
        if (orderIds.isEmpty()) return out;
        call("reservations-of", () -> client.reservationsOf(new ReservationsQuery(List.copyOf(orderIds))))
                .items().forEach(r -> out.computeIfAbsent(r.orderId(), k -> new ArrayList<>()).add(r));
        return out;
    }

    // ───────── 呼叫：重送一次、翻譯錯誤 ─────────

    private void run(String op, Runnable r) {
        call(op, () -> { r.run(); return null; });
    }

    private <T> T call(String op, Supplier<T> c) {
        for (int attempt = 1; ; attempt++) {
            try {
                return c.get();
            } catch (RestClientResponseException e) {                       // 對方回應了：照它說的
                throw decode(op, e.getStatusCode().value(), e.getResponseBodyAsString());
            } catch (ResourceAccessException e) {                           // 沒有回應：不知道它做了沒有 —— 每一支端點都可以重送（3.5）
                Counter.builder("shop.remote.no_response").tag("service", "inventory").tag("op", op)
                        .description("呼叫其他服務沒有得到回應（連不上、逾時）的次數（13 站 3.5）").register(meters).increment();
                if (attempt < 2) {
                    log.warn("INVENTORY_NO_RESPONSE op={} attempt={}，用同一個冪等鍵再送一次：{}", op, attempt, e.getMessage());
                    continue;
                }
                log.error("INVENTORY_UNAVAILABLE op={}：送了 {} 次都沒有回應：{}", op, attempt, e.getMessage());
                throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", 1);
            }
        }
    }

    /** 庫存服務的 Problem Details → 呼叫端在一個行程裡會拿到的同一個例外 */
    RuntimeException decode(String op, int status, String body) {
        try {
            JsonNode p = json.readTree(body);
            String type = p.path("type").asText();
            for (ProblemType pt : PASS_THROUGH) {
                if (!pt.type().toString().equals(type)) continue;
                if (pt == ProblemType.INSUFFICIENT_STOCK) return new InsufficientStockException(p.get("productId").asLong());
                ShopException e = new ShopException(pt, p.path("detail").asText());
                for (Iterator<Map.Entry<String, JsonNode>> it = p.fields(); it.hasNext(); ) {
                    var f = it.next();
                    if (!STANDARD.contains(f.getKey())) e.with(f.getKey(), f.getValue().isNumber() ? f.getValue().numberValue() : f.getValue().asText());
                }
                return e;
            }
        } catch (Exception notJson) { /* 落到下面 */ }
        log.error("INVENTORY_ERROR op={} status={}：{}", op, status, body);
        return new IllegalStateException("庫存服務 " + op + " 回應 " + status + "：" + body);
    }
}
```

**`src/main/java/com/example/shop/shared/config/ConditionalOnServiceRole.java`**（3.7.2）

```java
package com.example.shop.shared.config;

import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.context.annotation.Conditional;
import org.springframework.core.type.AnnotatedTypeMetadata;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.util.Arrays;

/**
 * 13 站 3.7：只在這幾種部署裡存在的 bean。
 * 不用 @ConditionalOnProperty(havingValue = "order-service")：它比的是字串，設定寫成 ORDER_SERVICE 時 enum 綁得上、條件卻不成立 ——
 * 這裡用跟 ShopProperties 同一套規則（Binder）把設定綁成 ServiceRole 再比。
 */
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.TYPE, ElementType.METHOD})
@Conditional(ConditionalOnServiceRole.OnServiceRole.class)
public @interface ConditionalOnServiceRole {

    ServiceRole[] value();

    class OnServiceRole implements Condition {
        @Override
        public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
            ServiceRole[] wanted = (ServiceRole[]) metadata.getAnnotationAttributes(ConditionalOnServiceRole.class.getName()).get("value");
            return Arrays.asList(wanted).contains(current(context));
        }

        static ServiceRole current(ConditionContext context) {
            return Binder.get(context.getEnvironment()).bind("shop.deployment.role", ServiceRole.class).orElse(ServiceRole.MONOLITH);
        }
    }
}
```

**`src/main/java/com/example/shop/shared/config/ShopProperties.java`**（3.7.2）

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
                             @Valid @NotNull @DefaultValue Messaging messaging, @Valid @NotNull @DefaultValue Deployment deployment) {

    /**
     * 13 站第 03 章：同一個 jar，哪一種部署（3.7）；切開的時候，訂單服務去哪裡找庫存服務（3.4），服務之間怎麼證明自己是誰（3.6）。
     * 預設 monolith —— 第 12 站的單體，下面其他的設定都用不到。
     */
    public record Deployment(
            @NotNull @DefaultValue("monolith") ServiceRole role,
            @Valid @NotNull @DefaultValue Remote inventory,
            @Valid @NotNull @DefaultValue ServiceToken serviceToken) {

        @jakarta.validation.constraints.AssertTrue(message = "shop.deployment.role=order-service 必須設定 shop.deployment.inventory.url")
        public boolean isInventoryReachable() {
            return role != ServiceRole.ORDER_SERVICE || (inventory.url() != null && !inventory.url().isBlank());
        }

        @jakarta.validation.constraints.AssertTrue(message = "切開的部署必須設定 shop.deployment.service-token.secret（至少 32 bytes，跟 shop.security.jwt-secret 不同）")
        public boolean isServiceTokenConfigured() {
            return role == ServiceRole.MONOLITH || (serviceToken.secret() != null
                    && serviceToken.secret().getBytes(java.nio.charset.StandardCharsets.UTF_8).length >= 32);
        }
    }

    /** 另一個服務：在哪裡、等多久（3.4）。逾時預算（由外而內遞減）是第 06 章的事，這裡先給每一次呼叫一個上限 */
    public record Remote(
            String url,
            @NotNull @DefaultValue("1s") @DurationMin(millis = 100) Duration connectTimeout,
            @NotNull @DefaultValue("3s") @DurationMin(millis = 100) Duration readTimeout) {}

    /** 3.6：服務之間的 token（HS256）。ttl：一個 token 用多久；呼叫端在到期前 1 分鐘換新的 */
    public record ServiceToken(
            String secret,
            @NotNull @DefaultValue("5m") @DurationMin(minutes = 2) @DurationMax(minutes = 60) Duration ttl) {}

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
            @DefaultValue("true") boolean jobsEnabled,
            /** 13 站 2.6：預留 ⇄ 訂單的跨模組對帳（ReservationReconciliation）多久跑一次 */
            @NotNull @DefaultValue("5m") @DurationMin(seconds = 10) Duration reservationCheckInterval,
            /** 13 站 2.6：比這個新的不一致不算 —— 下單的交易可能還沒 commit、熱點落帳的事件可能還在路上 */
            @NotNull @DefaultValue("5m") @DurationMin(seconds = 1) Duration reservationGrace) {}

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

**`src/test/java/com/example/shop/inventory/internal/web/InventoryServiceApiTest.java`**（3.5.5、3.6.3）

```java
package com.example.shop.inventory.internal.web;

import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestInfra;
import com.example.shop.support.TestTokens;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 3.5、3.6：庫存服務的 /internal/inventory/v1，用它正式的角色（role = inventory-service）跑在它自己的庫上
 * （只有 db/migration/inventory 與 shared 兩個資料夾，跟 ServiceDatabaseTest 一樣從空資料庫建起來）。
 *
 *   認證：沒有 token、使用者的 token、簽錯的、給別人的、過期的 → 401；不在名單上的服務 → 403；order-service → 通過
 *   冪等：同一張訂單的預留再送一次（包括「同時」送兩次）、同一個鍵的補貨、同一個鍵的熱點閘門 → 只做一次
 *   錯誤：庫存不足 409、還在落帳 503、少了 Idempotency-Key 400；/api/** 在這個服務上是 404
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "shop.deployment.role=inventory-service", "shop.deployment.service-token.secret=" + InventoryServiceApiTest.SECRET,
        "shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false", "shop.security.bootstrap-admin.enabled=false",
        "spring.jpa.hibernate.ddl-auto=none", "spring.flyway.locations=classpath:db/migration/inventory,classpath:db/migration/shared",
        "spring.data.redis.database=5"})
class InventoryServiceApiTest {

    static final String SECRET = "inventory-service-api-test-secret-0123456789";
    static final String DB = "shop_svc_inventory_api";

    static volatile String url;

    /**
     * ⚠️ 第一版在 supplier 裡 DROP、CREATE：Spring 每讀一次這個屬性就呼叫一次 supplier —— Flyway 建好的表，下一次讀就被刪了
     *（7 個測試全部 Table 'inventory' doesn't exist）。建庫只做一次
     */
    @DynamicPropertySource
    static void ownDatabase(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> {
            if (url == null) {
                JdbcTemplate admin = TestInfra.adminJdbc();
                admin.execute("DROP DATABASE IF EXISTS " + DB);
                admin.execute("CREATE DATABASE " + DB);
                admin.execute("GRANT ALL PRIVILEGES ON `" + DB + "`.* TO 'shop_migrator'@'%' WITH GRANT OPTION");
                url = TestInfra.jdbcUrl(DB);
            }
            return url;
        });
    }

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired AccessTokens userTokens;

    final HttpClient http = HttpClient.newHttpClient();

    // ───────── 認證 ─────────

    @Test @DisplayName("3.6：只有 order-service 的服務 token 進得來；使用者的 token、簽錯的、給別人的、過期的都是 401")
    void onlyTheOrderServiceGetsIn() throws Exception {
        long product = 9_930_001, order = 9_930_101;
        stock(product, 100);
        Map<String, String> cases = new LinkedHashMap<>();
        cases.put("沒有 token", null);
        cases.put("買家的 JWT（使用者的金鑰）", TestTokens.bearer(userTokens, 990_999, Role.BUYER, Role.SELLER, Role.ADMIN));
        cases.put("服務 token、簽錯金鑰", "Bearer " + token("order-service", "inventory-service", Duration.ofMinutes(5), "some-other-secret-0123456789abcdef0123"));
        cases.put("服務 token、aud = payment-service", "Bearer " + token("order-service", "payment-service", Duration.ofMinutes(5), SECRET));
        cases.put("服務 token、過期 1 分鐘", "Bearer " + token("order-service", "inventory-service", Duration.ofMinutes(-1), SECRET));
        cases.put("服務 token、sub = notification-service", "Bearer " + token("notification-service", "inventory-service", Duration.ofMinutes(5), SECRET));
        cases.put("服務 token、sub = order-service", "Bearer " + token("order-service", "inventory-service", Duration.ofMinutes(5), SECRET));
        Map<String, Integer> got = new LinkedHashMap<>();
        for (var c : cases.entrySet())
            got.put(c.getKey(), send("POST", "/internal/inventory/v1/reservations/" + order + "/release", c.getValue(), null, null).statusCode());
        got.forEach((k, v) -> System.out.printf("13 站 3.6：%-36s → %d%n", k, v));
        assertThat(got.values()).containsExactly(401, 401, 401, 401, 401, 403, 204);
        HttpResponse<String> user = send("GET", "/api/products", null, null, null);
        System.out.printf("13 站 3.7：庫存服務上的 GET /api/products → %d %s%n", user.statusCode(), user.body());
        assertThat(user.statusCode()).isEqualTo(404);
    }

    // ───────── 冪等 ─────────

    @Test @DisplayName("3.5：同一張訂單的預留送兩次 → 只預留一次，第二次標 Idempotent-Replayed；內容不一樣 → 422")
    void reserveIsIdempotentPerOrder() throws Exception {
        long product = 9_930_011, order = 9_930_111;
        stock(product, 10);
        String body = "{\"lines\":[{\"productId\":" + product + ",\"quantity\":2}],\"hotLines\":[]}";
        HttpResponse<String> first = send("PUT", "/internal/inventory/v1/reservations/" + order, service(), body, null);
        HttpResponse<String> again = send("PUT", "/internal/inventory/v1/reservations/" + order, service(), body, null);
        String other = "{\"lines\":[{\"productId\":" + product + ",\"quantity\":3}],\"hotLines\":[]}";
        HttpResponse<String> different = send("PUT", "/internal/inventory/v1/reservations/" + order, service(), other, null);
        System.out.printf("13 站 3.5：PUT 預留 %d → %d；再一次 → %d %s；內容不一樣 → %d；reserved = %d、RESERVE 帳 %d 筆%n", order,
                first.statusCode(), again.statusCode(), again.headers().firstValue("Idempotent-Replayed").orElse("-"), different.statusCode(),
                reserved(product), ledger(product, "RESERVE"));
        assertThat(first.statusCode()).isEqualTo(204);
        assertThat(first.headers().firstValue("Idempotent-Replayed")).isEmpty();
        assertThat(again.statusCode()).isEqualTo(204);
        assertThat(again.headers().firstValue("Idempotent-Replayed")).contains("true");
        assertThat(different.statusCode()).isEqualTo(422);
        assertThat(reserved(product)).isEqualTo(2);
        assertThat(ledger(product, "RESERVE")).isEqualTo(1);
    }

    @Test @DisplayName("3.5：同一張訂單的預留「同時」送兩次 → 第二個等第一個 commit，然後當作重送；只預留一次")
    void concurrentDuplicatesReserveOnce() throws Exception {
        long product = 9_930_021, order = 9_930_121;
        stock(product, 10);
        String body = "{\"lines\":[{\"productId\":" + product + ",\"quantity\":1}],\"hotLines\":[]}";
        String auth = service();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<HttpResponse<String>>> f = new ArrayList<>();
        for (int i = 0; i < 2; i++) f.add(pool.submit(() -> { go.await(); return send("PUT", "/internal/inventory/v1/reservations/" + order, auth, body, null); }));
        go.countDown();
        List<HttpResponse<String>> rs = new ArrayList<>();
        for (var x : f) rs.add(x.get());
        pool.shutdown();
        long replayed = rs.stream().filter(r -> r.headers().firstValue("Idempotent-Replayed").isPresent()).count();
        System.out.printf("13 站 3.5：同時兩個 PUT → %s，其中標成重送的 %d 個；reserved = %d%n", rs.stream().map(HttpResponse::statusCode).toList(), replayed, reserved(product));
        assertThat(rs).allMatch(r -> r.statusCode() == 204);
        assertThat(replayed).isEqualTo(1);
        assertThat(reserved(product)).isEqualTo(1);
    }

    @Test @DisplayName("3.5：補貨 —— 同一個 Idempotency-Key 只補一次，新的鍵再補一次；沒有鍵 → 400")
    void restockOncePerKey() throws Exception {
        long product = 9_930_031;
        stock(product, 100);
        String key = UUID.randomUUID().toString(), body = "{\"quantity\":10,\"note\":\"api-test\"}";
        int a = send("POST", "/internal/inventory/v1/products/" + product + "/restocks", service(), body, key).statusCode();
        int b = send("POST", "/internal/inventory/v1/products/" + product + "/restocks", service(), body, key).statusCode();
        long afterSameKey = onHand(product);
        int c = send("POST", "/internal/inventory/v1/products/" + product + "/restocks", service(), body, UUID.randomUUID().toString()).statusCode();
        int none = send("POST", "/internal/inventory/v1/products/" + product + "/restocks", service(), body, null).statusCode();
        System.out.printf("13 站 3.5：補貨 10 → %d；同一個鍵再一次 → %d（on_hand %d）；新的鍵 → %d（on_hand %d）；沒有鍵 → %d%n",
                a, b, afterSameKey, c, onHand(product), none);
        assertThat(List.of(a, b, c, none)).containsExactly(204, 204, 204, 400);
        assertThat(afterSameKey).isEqualTo(110);
        assertThat(onHand(product)).isEqualTo(120);
        assertThat(ledger(product, "RESTOCK")).isEqualTo(2);
    }

    @Test @DisplayName("3.5：熱點閘門 —— 同一個鍵只減一次、只加回一次")
    void hotGateOncePerKey() throws Exception {
        long product = 9_930_041;
        stock(product, 50);
        assertThat(send("PUT", "/internal/inventory/v1/products/" + product + "/hot", service(), "{\"hot\":true}", null).statusCode()).isEqualTo(204);
        String gate = UUID.randomUUID().toString(), back = UUID.randomUUID().toString(), lines = "{\"lines\":[{\"productId\":" + product + ",\"quantity\":3}]}";
        long g0 = gateValue(product);
        send("POST", "/internal/inventory/v1/hot-gate", service(), lines, gate);
        HttpResponse<String> replay = send("POST", "/internal/inventory/v1/hot-gate", service(), lines, gate);
        long g1 = gateValue(product);
        send("POST", "/internal/inventory/v1/hot-gate/returns", service(), lines, back);
        send("POST", "/internal/inventory/v1/hot-gate/returns", service(), lines, back);
        long g2 = gateValue(product);
        System.out.printf("13 站 3.5：閘門 %d → 同一個鍵減兩次 → %d（第二次 %s）→ 同一個鍵加回兩次 → %d%n", g0, g1,
                replay.headers().firstValue("Idempotent-Replayed").orElse("-"), g2);
        assertThat(g1).isEqualTo(g0 - 3);
        assertThat(replay.headers().firstValue("Idempotent-Replayed")).contains("true");
        assertThat(g2).isEqualTo(g0);
    }

    @Test @DisplayName("3.5：確認、出貨、釋放 —— 本來就冪等：第二次什麼都不改")
    void transitionsAreNaturallyIdempotent() throws Exception {
        long product = 9_930_051, order = 9_930_151;
        stock(product, 10);
        send("PUT", "/internal/inventory/v1/reservations/" + order, service(), "{\"lines\":[{\"productId\":" + product + ",\"quantity\":1}],\"hotLines\":[]}", null);
        List<Integer> s = new ArrayList<>();
        for (String op : List.of("confirm", "confirm", "consume", "consume", "release"))
            s.add(send("POST", "/internal/inventory/v1/reservations/" + order + "/" + op, service(), null, null).statusCode());
        System.out.printf("13 站 3.5：confirm、confirm、consume、consume、release → %s；on_hand %d、reserved %d、SHIP 帳 %d 筆%n",
                s, onHand(product), reserved(product), ledger(product, "SHIP"));
        assertThat(s).containsOnly(204);
        assertThat(onHand(product)).isEqualTo(9);
        assertThat(reserved(product)).isZero();
        assertThat(ledger(product, "SHIP")).isEqualTo(1);
    }

    @Test @DisplayName("3.4：業務錯誤照第 12 站的 Problem Details —— 庫存不足 409（帶 productId）、熱點還在落帳 503（帶 retryAfter）")
    void businessErrors() throws Exception {
        long product = 9_930_061, hot = 9_930_062;
        stock(product, 1);
        stock(hot, 5);
        HttpResponse<String> shortage = send("PUT", "/internal/inventory/v1/reservations/9930161", service(),
                "{\"lines\":[{\"productId\":" + product + ",\"quantity\":2}],\"hotLines\":[]}", null);
        send("PUT", "/internal/inventory/v1/reservations/9930162", service(), "{\"lines\":[],\"hotLines\":[{\"productId\":" + hot + ",\"quantity\":1}]}", null);
        send("POST", "/internal/inventory/v1/reservations/9930162/confirm", service(), null, null);
        HttpResponse<String> settling = send("POST", "/internal/inventory/v1/reservations/9930162/consume", service(), null, null);
        System.out.printf("13 站 3.4：庫存不足 → %d %s%n          還在落帳 → %d %s%n", shortage.statusCode(), shortage.body(), settling.statusCode(), settling.body());
        assertThat(shortage.statusCode()).isEqualTo(409);
        assertThat(shortage.body()).contains("/problems/insufficient-stock").contains("\"productId\":" + product);
        assertThat(settling.statusCode()).isEqualTo(503);
        assertThat(settling.body()).contains("/problems/temporarily-unavailable").contains("\"retryAfter\":5");
        assertThat(reserved(product)).isZero();
    }

    // ───────── 工具 ─────────

    void stock(long product, int onHand) {
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", product, onHand);
    }

    long onHand(long p) { return jdbc.queryForObject("SELECT on_hand FROM inventory WHERE product_id = ?", Long.class, p); }
    long reserved(long p) { return jdbc.queryForObject("SELECT reserved FROM inventory WHERE product_id = ?", Long.class, p); }
    long ledger(long p, String reason) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM inventory_ledger WHERE product_id = ? AND reason = ?", Long.class, p, reason);
    }
    long gateValue(long p) { return Long.parseLong(redis.opsForValue().get("stock:" + p)); }

    String service() { return "Bearer " + token("order-service", "inventory-service", Duration.ofMinutes(5), SECRET); }

    static String token(String sub, String aud, Duration ttl, String secret) {
        var encoder = new NimbusJwtEncoder(new ImmutableSecret<>(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256")));
        Instant now = Instant.now();
        JwtClaimsSet claims = JwtClaimsSet.builder().issuer("shop-services").subject(sub).audience(List.of(aud))
                .issuedAt(now.minus(Duration.ofMinutes(10))).expiresAt(now.plus(ttl)).id(UUID.randomUUID().toString()).build();
        return encoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
    }

    HttpResponse<String> send(String method, String path, String auth, String body, String key) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        if (auth != null) b.header("Authorization", auth);
        if (key != null) b.header("Idempotency-Key", key);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/remote/RemoteInventoryApiTest.java`**（3.5.5）

```java
package com.example.shop.inventory.internal.remote;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.shared.config.ServiceRole;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.security.ServiceTokens;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.web.client.RestClient;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 13 站 3.5：訂單服務那一側的 RemoteInventoryApi，對著一個假的庫存服務（JDK 內建的 HttpServer，真的 HTTP、真的逾時）：
 *   沒有回應 → 用同一個冪等鍵再送一次；兩次都沒有 → 503
 *   對方的 409 / 503 → 同一個例外；對方的 401 / 404 → 系統錯誤（不是使用者的 401 / 404）
 *   空的清單不送；每一個請求帶著發給 inventory-service 的服務 token
 * 契約（請求與回應長什麼樣）是 Pact 的事（3.8）；這裡測的是「線出問題的時候，呼叫端怎麼做」。
 */
class RemoteInventoryApiTest {

    record Seen(String method, String path, String idempotencyKey, String authorization) {}

    HttpServer server;
    final ConcurrentLinkedQueue<Seen> seen = new ConcurrentLinkedQueue<>();
    /** 每一個請求依序取一個：{狀態碼, 延遲毫秒, 回應內容} */
    final ConcurrentLinkedQueue<Object[]> script = new ConcurrentLinkedQueue<>();
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    RemoteInventoryApi inventory;
    ServiceTokens tokens;

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        server.createContext("/", ex -> {
            seen.add(new Seen(ex.getRequestMethod(), ex.getRequestURI().getPath(), ex.getRequestHeaders().getFirst("Idempotency-Key"),
                    ex.getRequestHeaders().getFirst("Authorization")));
            ex.getRequestBody().readAllBytes();
            Object[] next = script.poll();
            int status = next == null ? 204 : (int) next[0];
            long delay = next == null ? 0 : (long) next[1];
            byte[] body = next == null || next[2] == null ? new byte[0] : ((String) next[2]).getBytes(StandardCharsets.UTF_8);
            try { Thread.sleep(delay); } catch (InterruptedException ignored) { }
            if (body.length > 0) ex.getResponseHeaders().add("Content-Type", "application/problem+json");
            try {
                ex.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
                if (body.length > 0) ex.getResponseBody().write(body);
            } catch (java.io.IOException clientGone) { /* 呼叫端等不及、已經斷了 */ }
            ex.close();
        });
        server.start();
        ShopProperties props = new Binder(new MapConfigurationPropertySource(Map.of(
                "shop.order.payment-timeout", "15m", "shop.order.timeout-scan-interval", "30s",
                "shop.security.jwt-secret", "unit-test-user-jwt-secret-0123456789abcdef",
                "shop.payment.callback-secret", "unit-test-payment-callback-secret-0123",
                "shop.deployment.role", "order-service",
                "shop.deployment.inventory.url", "http://127.0.0.1:" + server.getAddress().getPort(),
                "shop.deployment.inventory.read-timeout", "300ms",
                "shop.deployment.service-token.secret", "unit-test-service-token-secret-0123456789"))).bind("shop", ShopProperties.class).get();
        tokens = new ServiceTokens(props, Clock.systemUTC());
        inventory = new RemoteInventoryApi(RestClient.builder(), props, tokens, new ObjectMapper(), meters);
    }

    @AfterEach
    void stop() { server.stop(0); }

    @Test @DisplayName("回應遺失一次：用同一個 Idempotency-Key 再送一次，成功；記一筆 shop.remote.no_response")
    void retriesOnceWithTheSameKey() {
        script.add(new Object[]{204, 600L, null});                             // 處理了，但 600 ms 才回（呼叫端只等 300 ms）
        script.add(new Object[]{204, 0L, null});
        inventory.restock(9_001L, 10, "unit");
        List<Seen> calls = List.copyOf(seen);
        assertThat(calls).hasSize(2);
        assertThat(calls.get(0).path()).isEqualTo("/internal/inventory/v1/products/9001/restocks");
        assertThat(calls.get(1).idempotencyKey()).isNotBlank().isEqualTo(calls.get(0).idempotencyKey());
        assertThat(meters.get("shop.remote.no_response").tag("op", "restock").counter().count()).isEqualTo(1.0);
    }

    @Test @DisplayName("兩次都沒有回應：503（請使用者稍後再試），不是 500")
    void twoLostResponsesAre503() {
        script.add(new Object[]{204, 600L, null});
        script.add(new Object[]{204, 600L, null});
        assertThatThrownBy(() -> inventory.confirm(42L)).isInstanceOfSatisfying(ShopException.class,
                e -> assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE));
        assertThat(seen).hasSize(2);
    }

    @Test @DisplayName("對方的 409 庫存不足、503 → 同一個例外；對方的 401、404 → 系統錯誤")
    void translatesProblems() {
        script.add(new Object[]{409, 0L, "{\"type\":\"/problems/insufficient-stock\",\"title\":\"庫存不足\",\"status\":409,\"detail\":\"商品 7 的可售庫存不足\",\"productId\":7}"});
        assertThatThrownBy(() -> inventory.reserve(1L, List.of(new ReserveLine(7, 1)), List.of()))
                .isInstanceOfSatisfying(InsufficientStockException.class, e -> assertThat(e.productId()).isEqualTo(7L));
        script.add(new Object[]{503, 0L, "{\"type\":\"/problems/temporarily-unavailable\",\"title\":\"服務暫時無法使用\",\"status\":503,\"detail\":\"還在落帳\",\"retryAfter\":5}"});
        assertThatThrownBy(() -> inventory.consume(1L)).isInstanceOfSatisfying(ShopException.class, e -> {
            assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE);
            assertThat(e.properties()).containsEntry("retryAfter", 5);
        });
        script.add(new Object[]{401, 0L, "{\"type\":\"/problems/unauthenticated\",\"title\":\"需要登入\",\"status\":401,\"detail\":\"服務的 token 無效或已過期\"}"});
        assertThatThrownBy(() -> inventory.release(1L)).isInstanceOf(IllegalStateException.class).hasMessageContaining("401");
        script.add(new Object[]{404, 0L, "{\"type\":\"/problems/not-found\",\"title\":\"找不到資源\",\"status\":404}"});
        assertThatThrownBy(() -> inventory.setHot(1L, true)).isInstanceOf(IllegalStateException.class).hasMessageContaining("404");
    }

    @Test @DisplayName("空的清單不送；每一個請求帶著 sub=order-service、aud=inventory-service 的服務 token")
    void skipsEmptyListsAndSendsAServiceToken() {
        inventory.gateHot(List.of());
        inventory.returnHot(List.of());
        assertThat(inventory.available(List.of())).isEmpty();
        assertThat(seen).isEmpty();
        inventory.gateHot(List.of(new ReserveLine(5, 1)));
        Seen s = seen.poll();
        assertThat(s.path()).isEqualTo("/internal/inventory/v1/hot-gate");
        assertThat(s.authorization()).startsWith("Bearer ");
        try {                                                               // 只解開來看，不驗簽（簽章是庫存服務的事，InventoryServiceApiTest）
            var claims = com.nimbusds.jwt.SignedJWT.parse(s.authorization().substring(7)).getJWTClaimsSet();
            assertThat(claims.getSubject()).isEqualTo(ServiceRole.ORDER_SERVICE.serviceName());
            assertThat(claims.getAudience()).containsExactly(ServiceRole.INVENTORY_SERVICE.serviceName());
            assertThat(claims.getIssuer()).isEqualTo("shop-services");
        } catch (java.text.ParseException e) {
            throw new AssertionError(e);
        }
    }

    @Test @DisplayName("token 快取起來：連續兩次呼叫用同一個")
    void cachesTheToken() {
        inventory.confirm(1L);
        inventory.confirm(2L);
        List<Seen> calls = List.copyOf(seen);
        assertThat(calls.get(0).authorization()).isEqualTo(calls.get(1).authorization());
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/remote/InventoryClientPactTest.java`**（3.8.3）

```java
package com.example.shop.inventory.internal.remote;

import au.com.dius.pact.consumer.MockServer;
import au.com.dius.pact.consumer.dsl.PactDslJsonBody;
import au.com.dius.pact.consumer.dsl.PactDslWithProvider;
import au.com.dius.pact.consumer.junit5.PactConsumerTestExt;
import au.com.dius.pact.consumer.junit5.PactTestFor;
import au.com.dius.pact.core.model.PactSpecVersion;
import au.com.dius.pact.core.model.RequestResponsePact;
import au.com.dius.pact.core.model.annotations.Pact;
import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.ReservationRef;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.security.ServiceTokens;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.web.client.RestClient;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 13 站 3.8：呼叫端的契約（consumer-driven）。訂單服務「怎麼用」庫存服務，一個互動一個方法：
 * 跑的是真的 RemoteInventoryApi（→ InventoryClient → RestClient），對面是 Pact 的 mock server ——
 * 它只回應這裡寫好的請求；送出去的請求跟寫的不一樣（路徑、欄位、標頭）→ 這個測試紅。
 * 全部通過之後，Pact 把這些互動寫成一份契約：target/pacts/order-service-inventory-service.json。
 * 庫存服務在 failsafe 那一段（InventoryProviderPactIT）拿這份契約去打真的 /internal/inventory/v1。
 *
 * 只寫「訂單服務用到的」：回應裡多出來的欄位不寫（Pact 不檢查沒寫的）—— 庫存服務可以自由加欄位，不能拿掉這裡寫了的。
 */
@ExtendWith(PactConsumerTestExt.class)
@PactTestFor(providerName = "inventory-service", pactVersion = PactSpecVersion.V3)   // ⚠️ 4.6 預設 V4：RequestResponsePact 的寫法要指定 V3（3.8.3）
class InventoryClientPactTest {

    static final String BEARER = "Bearer [A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+";
    static final String EXAMPLE_TOKEN = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcmRlci1zZXJ2aWNlIn0.c2lnbmF0dXJl";
    /**
     * ⚠️ 錯誤的回應是 Problem Details（RFC 9457）：application/problem+json。第一版沒寫，PactDslJsonBody 自動當成 application/json ——
     * 呼叫端的測試照樣綠（mock server 照我寫的回），提供端的驗證三個錯誤互動全紅（3.8.4）
     */
    static final Map<String, String> PROBLEM = Map.of("Content-Type", "application/problem+json");
    static final String UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

    // ───────── 可售量 ─────────

    @Pact(consumer = "order-service")
    RequestResponsePact stock(PactDslWithProvider b) {
        return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
                .uponReceiving("查兩個商品的可售量").method("GET").path("/internal/inventory/v1/stock")
                .query("productIds=9001&productIds=9002").matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .willRespondWith().status(200)
                .body(new PactDslJsonBody().minArrayLike("items", 1).integerType("productId", 9001).integerType("available", 10).closeObject().closeArray())
                .toPact();
    }

    @Test @PactTestFor(pactMethod = "stock")
    void stock(MockServer server) {
        Map<Long, Integer> m = api(server).available(List.of(9001L, 9002L));
        assertThat(m).containsEntry(9001L, 10).doesNotContainKey(9002L);
    }

    @Pact(consumer = "order-service")
    RequestResponsePact display(PactDslWithProvider b) {
        return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
                .uponReceiving("商品頁顯示用的可售量").method("GET").path("/internal/inventory/v1/stock/9001/display")
                .query("hot=false").matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .willRespondWith().status(200)
                .body(new PactDslJsonBody().integerType("productId", 9001).integerType("available", 10))
                .toPact();
    }

    @Test @PactTestFor(pactMethod = "display")
    void display(MockServer server) {
        assertThat(api(server).availableForDisplay(9001L, false)).isEqualTo(10);
    }

    // ───────── 預留 ─────────

    @Pact(consumer = "order-service")
    RequestResponsePact reserve(PactDslWithProvider b) {
        return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
                .uponReceiving("一張訂單的預留").method("PUT").path("/internal/inventory/v1/reservations/7001")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .body("{\"lines\":[{\"productId\":9001,\"quantity\":2}],\"hotLines\":[]}", "application/json")
                .willRespondWith().status(204)
                .toPact();
    }

    @Test @PactTestFor(pactMethod = "reserve")
    void reserve(MockServer server) {
        api(server).reserve(7001L, List.of(new ReserveLine(9001, 2)), List.of());
    }

    @Pact(consumer = "order-service")
    RequestResponsePact reserveInsufficient(PactDslWithProvider b) {
        return b.given("商品 9001 只有 1 件可售")
                .uponReceiving("預留超過可售量").method("PUT").path("/internal/inventory/v1/reservations/7002")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .body("{\"lines\":[{\"productId\":9001,\"quantity\":2}],\"hotLines\":[]}", "application/json")
                .willRespondWith().headers(PROBLEM).status(409)
                .body(new PactDslJsonBody().stringValue("type", "/problems/insufficient-stock").integerType("productId", 9001))
                .toPact();
    }

    @Test @PactTestFor(pactMethod = "reserveInsufficient")
    void reserveInsufficient(MockServer server) {
        assertThatThrownBy(() -> api(server).reserve(7002L, List.of(new ReserveLine(9001, 2)), List.of()))
                .isInstanceOfSatisfying(InsufficientStockException.class, e -> assertThat(e.productId()).isEqualTo(9001L));
    }

    @Pact(consumer = "order-service")
    RequestResponsePact confirm(PactDslWithProvider b) {
        return b.given("訂單 7001 有一筆 HELD 的預留")
                .uponReceiving("付款成功：確認預留").method("POST").path("/internal/inventory/v1/reservations/7001/confirm")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .willRespondWith().status(204).toPact();
    }

    @Test @PactTestFor(pactMethod = "confirm")
    void confirm(MockServer server) { api(server).confirm(7001L); }

    @Pact(consumer = "order-service")
    RequestResponsePact release(PactDslWithProvider b) {
        return b.given("訂單 7001 有一筆 HELD 的預留")
                .uponReceiving("取消：釋放預留").method("POST").path("/internal/inventory/v1/reservations/7001/release")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .willRespondWith().status(204).toPact();
    }

    @Test @PactTestFor(pactMethod = "release")
    void release(MockServer server) { api(server).release(7001L); }

    @Pact(consumer = "order-service")
    RequestResponsePact consume(PactDslWithProvider b) {
        return b.given("訂單 7003 的預留已確認")
                .uponReceiving("出貨：扣庫存").method("POST").path("/internal/inventory/v1/reservations/7003/consume")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .willRespondWith().status(204).toPact();
    }

    @Test @PactTestFor(pactMethod = "consume")
    void consume(MockServer server) { api(server).consume(7003L); }

    @Pact(consumer = "order-service")
    RequestResponsePact consumeWhileSettling(PactDslWithProvider b) {
        return b.given("訂單 7004 的熱點預留已確認、還沒落帳")
                .uponReceiving("出貨：熱點還在落帳").method("POST").path("/internal/inventory/v1/reservations/7004/consume")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .willRespondWith().headers(PROBLEM).status(503)
                .body(new PactDslJsonBody().stringValue("type", "/problems/temporarily-unavailable").integerType("retryAfter", 5))
                .toPact();
    }

    @Test @PactTestFor(pactMethod = "consumeWhileSettling")
    void consumeWhileSettling(MockServer server) {
        assertThatThrownBy(() -> api(server).consume(7004L)).isInstanceOfSatisfying(ShopException.class, e -> {
            assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE);
            assertThat(e.properties()).containsKey("retryAfter");
        });
    }

    // ───────── 對帳 ─────────

    @Pact(consumer = "order-service")
    RequestResponsePact activeReservations(PactDslWithProvider b) {
        return b.given("訂單 7001 有一筆 HELD 的預留，建立在 2026-01-01")
                .uponReceiving("對帳：還佔著庫存的預留").method("GET").path("/internal/inventory/v1/reservations")
                .matchQuery("afterId", "\\d+", "0").matchQuery("createdBefore", "\\d{4}-\\d{2}-\\d{2}T[0-9:.]+Z", "2026-10-15T00:00:00Z")
                .matchQuery("limit", "\\d+", "500").matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .willRespondWith().status(200)
                .body(new PactDslJsonBody().minArrayLike("items", 1).integerType("id", 1).integerType("orderId", 7001)
                        .integerType("productId", 9001).integerType("quantity", 1).stringMatcher("status", "HELD|CONFIRMED", "HELD").closeObject().closeArray())
                .toPact();
    }

    @Test @PactTestFor(pactMethod = "activeReservations")
    void activeReservations(MockServer server) {
        List<ReservationRef> rs = api(server).activeReservations(0, Instant.parse("2026-10-15T00:00:00Z"), 500);
        assertThat(rs).first().satisfies(r -> assertThat(r.status()).isIn("HELD", "CONFIRMED"));
    }

    @Pact(consumer = "order-service")
    RequestResponsePact reservationsOf(PactDslWithProvider b) {
        return b.given("訂單 7001 有一筆 HELD 的預留，建立在 2026-01-01")
                .uponReceiving("對帳：這些訂單的預留").method("POST").path("/internal/inventory/v1/reservations/query")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .body("{\"orderIds\":[7001]}", "application/json")
                .willRespondWith().status(200)
                .body(new PactDslJsonBody().minArrayLike("items", 1).integerType("id", 1).numberValue("orderId", 7001)
                        .integerType("productId", 9001).integerType("quantity", 1).stringType("status", "HELD").closeObject().closeArray())
                .toPact();
    }

    @Test @PactTestFor(pactMethod = "reservationsOf")
    void reservationsOf(MockServer server) {
        assertThat(api(server).reservationsOf(List.of(7001L))).containsKey(7001L);
    }

    // ───────── 商品：補貨、熱點 ─────────

    @Pact(consumer = "order-service")
    RequestResponsePact restock(PactDslWithProvider b) {
        return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
                .uponReceiving("補貨").method("POST").path("/internal/inventory/v1/products/9001/restocks")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN).matchHeader("Idempotency-Key", UUID_RE, "0b7e5f2a-1111-4c3d-9e8f-123456789abc")
                .body("{\"quantity\":10,\"note\":\"pact\"}", "application/json")
                .willRespondWith().status(204).toPact();
    }

    @Test @PactTestFor(pactMethod = "restock")
    void restock(MockServer server) { api(server).restock(9001L, 10, "pact"); }

    @Pact(consumer = "order-service")
    RequestResponsePact setHot(PactDslWithProvider b) {
        return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
                .uponReceiving("標成熱點").method("PUT").path("/internal/inventory/v1/products/9001/hot")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                .body("{\"hot\":true}", "application/json")
                .willRespondWith().status(204).toPact();
    }

    @Test @PactTestFor(pactMethod = "setHot")
    void setHot(MockServer server) { api(server).setHot(9001L, true); }

    @Pact(consumer = "order-service")
    RequestResponsePact gate(PactDslWithProvider b) {
        return b.given("商品 9005 是熱點，閘門有 10 件")
                .uponReceiving("熱點閘門：減").method("POST").path("/internal/inventory/v1/hot-gate")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN).matchHeader("Idempotency-Key", UUID_RE, "0b7e5f2a-2222-4c3d-9e8f-123456789abc")
                .body("{\"lines\":[{\"productId\":9005,\"quantity\":1}]}", "application/json")
                .willRespondWith().status(204).toPact();
    }

    @Test @PactTestFor(pactMethod = "gate")
    void gate(MockServer server) { api(server).gateHot(List.of(new ReserveLine(9005, 1))); }

    @Pact(consumer = "order-service")
    RequestResponsePact gateSoldOut(PactDslWithProvider b) {
        return b.given("商品 9005 是熱點，閘門有 0 件")
                .uponReceiving("熱點閘門：搶不到").method("POST").path("/internal/inventory/v1/hot-gate")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN).matchHeader("Idempotency-Key", UUID_RE, "0b7e5f2a-3333-4c3d-9e8f-123456789abc")
                .body("{\"lines\":[{\"productId\":9005,\"quantity\":1}]}", "application/json")
                .willRespondWith().headers(PROBLEM).status(409)
                .body(new PactDslJsonBody().stringValue("type", "/problems/insufficient-stock").integerType("productId", 9005))
                .toPact();
    }

    @Test @PactTestFor(pactMethod = "gateSoldOut")
    void gateSoldOut(MockServer server) {
        assertThatThrownBy(() -> api(server).gateHot(List.of(new ReserveLine(9005, 1)))).isInstanceOf(InsufficientStockException.class);
    }

    @Pact(consumer = "order-service")
    RequestResponsePact giveBack(PactDslWithProvider b) {
        return b.given("商品 9005 是熱點，閘門有 10 件")
                .uponReceiving("熱點閘門：加回去").method("POST").path("/internal/inventory/v1/hot-gate/returns")
                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN).matchHeader("Idempotency-Key", UUID_RE, "0b7e5f2a-4444-4c3d-9e8f-123456789abc")
                .body("{\"lines\":[{\"productId\":9005,\"quantity\":1}]}", "application/json")
                .willRespondWith().status(204).toPact();
    }

    @Test @PactTestFor(pactMethod = "giveBack")
    void giveBack(MockServer server) { api(server).returnHot(List.of(new ReserveLine(9005, 1))); }

    // ───────── 真的 RemoteInventoryApi，對著 mock server ─────────

    static RemoteInventoryApi api(MockServer server) {
        ShopProperties props = new Binder(new MapConfigurationPropertySource(Map.of(
                "shop.order.payment-timeout", "15m", "shop.order.timeout-scan-interval", "30s",
                "shop.security.jwt-secret", "pact-test-user-jwt-secret-0123456789abcdef",
                "shop.payment.callback-secret", "pact-test-payment-callback-secret-01234",
                "shop.deployment.role", "order-service", "shop.deployment.inventory.url", server.getUrl(),
                "shop.deployment.service-token.secret", "pact-test-service-token-secret-0123456789"))).bind("shop", ShopProperties.class).get();
        return new RemoteInventoryApi(RestClient.builder(), props, new ServiceTokens(props, Clock.systemUTC()), new ObjectMapper(), new SimpleMeterRegistry());
    }
}
```

**`src/test/java/com/example/shop/shared/messaging/internal/ServiceRoleConsumersTest.java`**（3.7.4）

```java
package com.example.shop.shared.messaging.internal;

import com.example.shop.shared.config.ServiceRole;
import com.example.shop.shared.events.EventHandler;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 3.7：同一個 jar 部署成兩個服務，每一個服務只收「自己擁有的模組」的佇列（3.2 ①：兩個服務都收，同一個佇列就有兩個服務在搶）。
 * 用的是 jar 裡真的那 6 個 EventHandler（單體的 context 裡六個都在），檢查每一個角色會替哪幾個開 container。
 * 新增一個消費者 → 它會自動落在它的類別所在的模組；這個測試的清單要跟著改 —— 改的時候順便想一下：它該在哪一個服務裡收？
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class ServiceRoleConsumersTest {

    @Autowired List<EventHandler> handlers;

    @Test @DisplayName("13 站 3.7：monolith 收 6 個；order-service、inventory-service 各收自己的 3 個，合起來剛好 6 個、沒有重複")
    void eachRoleConsumesOnlyItsOwnModules() {
        Map<ServiceRole, List<String>> got = new TreeMap<>();
        for (ServiceRole role : ServiceRole.values())
            got.put(role, RabbitConsumers.owned(handlers, role).stream().map(EventHandler::consumer).sorted().toList());
        got.forEach((role, consumers) -> System.out.printf("13 站 3.7：%-17s 收 %s%n", role.serviceName(), consumers));

        assertThat(got.get(ServiceRole.MONOLITH)).hasSize(6);
        assertThat(got.get(ServiceRole.ORDER_SERVICE)).containsExactly("notification.order-events", "ordering.stock-shortage", "payment.refunds");
        assertThat(got.get(ServiceRole.INVENTORY_SERVICE)).containsExactly("inventory.hot-settlement", "inventory.hot-stock-return", "inventory.product-created");
        List<String> both = new ArrayList<>(got.get(ServiceRole.ORDER_SERVICE));
        both.addAll(got.get(ServiceRole.INVENTORY_SERVICE));
        assertThat(both).as("切開之後，每一個消費者剛好在一個服務裡").containsExactlyInAnyOrderElementsOf(got.get(ServiceRole.MONOLITH));
    }
}
```

**`src/test/java/com/example/shop/shared/config/DeploymentPropertiesTest.java`**（3.7.4）

```java
package com.example.shop.shared.config;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.validation.ValidationAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 3.7：shop.deployment 設錯了，應用程式起不來 —— 而且錯誤訊息說得出少了什麼（不是等第一個請求才 NullPointerException）。
 * 只綁定 ShopProperties（加上 Bean Validation），不起整個應用程式。
 */
class DeploymentPropertiesTest {

    @Configuration
    @EnableConfigurationProperties(ShopProperties.class)
    static class Props {}

    final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(ValidationAutoConfiguration.class))
            .withUserConfiguration(Props.class)
            .withPropertyValues("shop.order.payment-timeout=15m", "shop.order.timeout-scan-interval=30s",
                    "shop.security.jwt-secret=deployment-test-user-jwt-secret-0123456789",
                    "shop.payment.callback-secret=deployment-test-payment-secret-0123456789");

    @Test @DisplayName("預設是 monolith：不需要任何 shop.deployment 的設定")
    void monolithByDefault() {
        runner.run(ctx -> assertThat(ctx.getBean(ShopProperties.class).deployment().role()).isEqualTo(ServiceRole.MONOLITH));
    }

    @Test @DisplayName("order-service 少了庫存服務的位址、少了服務 token 的金鑰 → 起不來，訊息說得出是哪一個")
    void orderServiceNeedsUrlAndSecret() {
        runner.withPropertyValues("shop.deployment.role=order-service").run(ctx -> {
            assertThat(ctx).hasFailed();
            String m = rootMessage(ctx.getStartupFailure());
            System.out.println("13 站 3.7：role=order-service、什麼都沒設 → " + m);
            assertThat(m).contains("shop.deployment.inventory.url").contains("shop.deployment.service-token.secret");
        });
    }

    @Test @DisplayName("inventory-service：金鑰太短（不到 32 bytes）也起不來；enum 寫成 INVENTORY_SERVICE 也綁得上")
    void inventoryServiceNeedsALongEnoughSecret() {
        runner.withPropertyValues("shop.deployment.role=inventory-service", "shop.deployment.service-token.secret=too-short").run(ctx -> {
            assertThat(ctx).hasFailed();
            System.out.println("13 站 3.7：role=inventory-service、金鑰 9 bytes → " + rootMessage(ctx.getStartupFailure()));
        });
        runner.withPropertyValues("shop.deployment.role=INVENTORY_SERVICE", "shop.deployment.service-token.secret=deployment-test-service-secret-0123456789")
                .run(ctx -> assertThat(ctx.getBean(ShopProperties.class).deployment().role()).isEqualTo(ServiceRole.INVENTORY_SERVICE));
    }

    static String rootMessage(Throwable t) {
        StringBuilder all = new StringBuilder();
        for (Throwable c = t; c != null; c = c.getCause()) all.append(c.getMessage()).append(" | ");
        return all.toString().replace('\n', ' ');
    }
}
```

**`src/test/java/com/example/shop/dist03/Broker.java`**（3.2.1）

```java
package com.example.shop.dist03;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.amqp.core.AmqpAdmin;
import org.springframework.amqp.core.QueueInformation;
import org.springframework.context.ConfigurableApplicationContext;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 13 站 3.2 ①、3.7：實驗用的 RabbitMQ。compose 的那一台（第 12 站第 07 章），另開一個 vhost（shop_d03）——
 * 佇列、交換器、繫結都在 vhost 裡面，跟第 12 站的 shop.* 佇列（預設的 / vhost）互不相干。每次實驗開始時整個刪掉重建。
 *
 * 管理 API（15672）只拿來建 vhost 與列出佇列的名字：它的訊息數每 5 秒才更新一次。
 * 佇列裡「現在」有幾則，用 AMQP 的 passive declare（AmqpAdmin.getQueueInfo）—— 只數 ready，不數已經交出去、還沒 ack 的。
 */
public final class Broker {

    public static final String VHOST = "shop_d03";

    private static final HttpClient HTTP = HttpClient.newHttpClient();
    private static final String AUTH = "Basic " + Base64.getEncoder().encodeToString("shop:shop".getBytes(StandardCharsets.UTF_8));
    private static final ObjectMapper JSON = new ObjectMapper();

    private Broker() {}

    public static void freshVhost() throws Exception {
        send("DELETE", "/api/vhosts/" + VHOST, null);
        send("PUT", "/api/vhosts/" + VHOST, "{}");
        send("PUT", "/api/permissions/" + VHOST + "/shop", "{\"configure\":\".*\",\"write\":\".*\",\"read\":\".*\"}");
    }

    /** 兩個服務都要加的參數：relay、消費者打開，連到這個 vhost */
    public static List<String> args() {
        return List.of("--shop.messaging.relay-enabled=true", "--shop.messaging.consumers-enabled=true",
                "--spring.rabbitmq.virtual-host=" + VHOST);
    }

    public static List<String> queueNames() throws Exception {
        JsonNode qs = JSON.readTree(send("GET", "/api/queues/" + VHOST + "?columns=name", null));
        List<String> names = new ArrayList<>();
        qs.forEach(q -> names.add(q.get("name").asText()));
        names.sort(null);
        return names;
    }

    /** 每一個佇列現在 ready 的訊息數（不含已經交給消費者、還沒 ack 的） */
    public static Map<String, Integer> ready(ConfigurableApplicationContext ctx, List<String> queues) {
        AmqpAdmin admin = ctx.getBean(AmqpAdmin.class);
        Map<String, Integer> m = new TreeMap<>();
        for (String q : queues) {
            QueueInformation info = admin.getQueueInfo(q);
            m.put(q, info == null ? -1 : info.getMessageCount());
        }
        return m;
    }

    /** 每一個佇列有幾個消費者 */
    public static Map<String, Integer> consumers(ConfigurableApplicationContext ctx, List<String> queues) {
        AmqpAdmin admin = ctx.getBean(AmqpAdmin.class);
        Map<String, Integer> m = new TreeMap<>();
        for (String q : queues) {
            QueueInformation info = admin.getQueueInfo(q);
            m.put(q, info == null ? -1 : info.getConsumerCount());
        }
        return m;
    }

    static String send(String method, String path, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:15672" + path)).header("Authorization", AUTH)
                .header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        HttpResponse<String> r = HTTP.send(b.build(), HttpResponse.BodyHandlers.ofString());
        if (r.statusCode() >= 400 && !(method.equals("DELETE") && r.statusCode() == 404))
            throw new IllegalStateException(method + " " + path + " → " + r.statusCode() + "：" + r.body());
        return r.body();
    }
}
```

**`src/test/java/com/example/shop/dist03/Flow.java`**（3.2.1）

```java
package com.example.shop.dist03;

import com.example.shop.dist00.SplitLab;
import com.example.shop.shared.events.EventHandler;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.context.ConfigurableApplicationContext;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 13 站 3.2 ①、3.7：事件真的走 broker 的時候，「做完了沒」只能從外面看：
 *   兩個服務的 outbox 都送完了、每一個佇列（含重試佇列）都沒有 ready 的訊息、兩個服務的消費者計數 1 秒內沒有再變。
 * 計數用第 12 站 9.10 的那幾個指標（每一個服務有自己的 MeterRegistry）：
 *   shop.events.lag（Timer，處理成功才記一筆）、shop.events.retried、shop.events.dead_lettered、shop.events.misrouted
 */
public final class Flow {

    private Flow() {}

    /** 一個消費者在一個服務裡：成功幾次、失敗後送去重試幾次、送進死信幾次 */
    public record Tally(long processed, long retried, long dead) {
        boolean zero() { return processed == 0 && retried == 0 && dead == 0; }
    }

    public static Map<String, Tally> tally(ConfigurableApplicationContext ctx) {
        MeterRegistry r = ctx.getBean(MeterRegistry.class);
        Map<String, Tally> m = new TreeMap<>();
        for (EventHandler h : ctx.getBeansOfType(EventHandler.class).values()) {
            Timer t = r.find("shop.events.lag").tag("consumer", h.consumer()).timer();
            m.put(h.consumer(), new Tally(t == null ? 0 : t.count(), count(r, "shop.events.retried", h.consumer()), count(r, "shop.events.dead_lettered", h.consumer())));
        }
        return m;
    }

    static long count(MeterRegistry r, String name, String consumer) {
        Counter c = r.find(name).tag("consumer", consumer).counter();
        return c == null ? 0 : (long) c.count();
    }

    /** 等到安靜下來；回傳花了幾毫秒。max 毫秒之內沒有安靜 → 丟例外 */
    public static long quiet(List<ConfigurableApplicationContext> services, List<String> dbs, long max) throws Exception {
        List<String> queues = Broker.queueNames().stream().filter(q -> !q.endsWith(".dlq")).toList();
        long t0 = System.nanoTime(), lastChange = t0;
        String last = "";
        while (true) {
            StringBuilder s = new StringBuilder();
            long pending = 0;
            for (String db : dbs) pending += SplitLab.count(db, "SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL");
            int ready = Broker.ready(services.get(0), queues).values().stream().mapToInt(Integer::intValue).sum();
            for (ConfigurableApplicationContext c : services) s.append(tally(c)).append('|');
            long now = System.nanoTime();
            if (!s.toString().equals(last)) { last = s.toString(); lastChange = now; }
            if (pending == 0 && ready == 0 && now - lastChange > 1_000_000_000L) return (lastChange - t0) / 1_000_000;
            if (now - t0 > max * 1_000_000L) throw new IllegalStateException("沒有安靜下來：outbox 還有 " + pending + " 筆、佇列 ready " + ready);
            Thread.sleep(100);
        }
    }

    /** 兩個服務、每一個消費者：一行 */
    public static void print(java.io.PrintStream out, ConfigurableApplicationContext order, ConfigurableApplicationContext inv) throws Exception {
        Map<String, Tally> o = tally(order), i = tally(inv);
        Map<String, Integer> dlq = new TreeMap<>();
        List<String> names = Broker.queueNames();
        Broker.ready(order, names.stream().filter(q -> q.endsWith(".dlq")).toList()).forEach(dlq::put);
        out.println("  消費者                         │ 訂單服務：成功 / 失敗後重試 / 送進死信 │ 庫存服務：成功 / 失敗後重試 / 送進死信 │ 死信佇列");
        for (String c : new TreeSet<>(o.keySet())) {
            Tally a = o.get(c), b = i.getOrDefault(c, new Tally(0, 0, 0));
            out.printf("  %-30s │ %8d / %10d / %8d │ %8d / %10d / %8d │ %5d%n", c, a.processed(), a.retried(), a.dead(),
                    b.processed(), b.retried(), b.dead(), dlq.getOrDefault("shop." + c + ".dlq", 0));
        }
    }
}
```

**`src/test/java/com/example/shop/dist03/LostResponse.java`**（3.2.1、3.5.6）

```java
package com.example.shop.dist03;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;

import java.io.IOException;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 13 站 3.2 ②、3.5：「回應遺失」。庫存服務照常處理、commit，回應卻晚到呼叫端已經放棄之後才送出 ——
 * 從呼叫端看，跟網路斷在回程上是同一件事：它不知道對方做了沒有。
 *
 * 做法：一個排在最前面的 servlet filter。被「布置」的那幾個請求，先照常交給後面（controller 執行、交易 commit），
 * 回應先收在記憶體裡（ContentCachingResponseWrapper：Jackson 寫完會 flush，不包起來的話回應當場就送出去了），
 * 等 delayMs 之後才真的送出。呼叫端的 read timeout 比 delayMs 短 → 它看到的是逾時。
 *
 * 狀態是 static 的：兩個服務在同一個 JVM（第 02 章 2.4.6），filter 只在庫存服務那一個 context 裡（lab.d03.lost-response=true）。
 */
@Configuration
@ConditionalOnProperty(name = "lab.d03.lost-response", havingValue = "true")
public class LostResponse {

    record Arm(String method, String path, long delayMs, AtomicInteger times) {}

    /** 一次被延後的回應：路徑、狀態碼 */
    public record Hit(String method, String path, int status) {}

    static final ConcurrentLinkedQueue<Arm> ARMED = new ConcurrentLinkedQueue<>();
    public static final ConcurrentLinkedQueue<Hit> HITS = new ConcurrentLinkedQueue<>();

    /** 接下來 times 個路徑含 path 的請求：處理完、等 delayMs 才回應 */
    public static void arm(String path, long delayMs, int times) {
        arm(null, path, delayMs, times);
    }

    /** 13 站 3.5：只算這個 HTTP 方法的（/internal/inventory/v1/reservations/… 的 PUT 是預留，POST …/release 是釋放） */
    public static void arm(String method, String path, long delayMs, int times) {
        ARMED.add(new Arm(method, path, delayMs, new AtomicInteger(times)));
    }

    public static void reset() {
        ARMED.clear();
        HITS.clear();
    }

    @Bean
    FilterRegistrationBean<OncePerRequestFilter> d03LostResponse() {
        FilterRegistrationBean<OncePerRequestFilter> r = new FilterRegistrationBean<>(new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                Arm arm = ARMED.stream().filter(a -> (a.method() == null || a.method().equals(req.getMethod()))
                        && req.getRequestURI().contains(a.path()) && a.times().getAndDecrement() > 0).findFirst().orElse(null);
                if (arm == null) { chain.doFilter(req, res); return; }
                ContentCachingResponseWrapper held = new ContentCachingResponseWrapper(res);
                chain.doFilter(req, held);                                   // controller 執行完、交易 commit 了
                HITS.add(new Hit(req.getMethod(), req.getRequestURI(), held.getStatus()));
                try { Thread.sleep(arm.delayMs()); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                try { held.copyBodyToResponse(); } catch (IOException gone) { /* 呼叫端早就斷了 */ }
            }
        });
        r.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return r;
    }
}
```

**`src/test/java/com/example/shop/dist03/Shop.java`**（3.2.1）

```java
package com.example.shop.dist03;

import com.example.shop.dist00.SplitLab;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.ConfigurableApplicationContext;

import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 13 站第 03 章的實驗：使用者的動作，全部走 HTTP、打訂單服務（gateway），跟真的客戶端一樣。
 * 回應（狀態碼、內容）照實回傳，由實驗自己判斷 —— 這一章要看的常常就是「不是預期的那一個」。
 */
public final class Shop {

    public static final long SELLER = SplitLab.SELLER;

    public record Res(int status, String body, long millis) {
        public JsonNode json() {
            try { return new ObjectMapper().readTree(body); } catch (Exception e) { throw new IllegalStateException(body, e); }
        }
        public String brief() {
            String b = body == null ? "" : body.replace('\n', ' ');
            return status + (b.isEmpty() ? "" : " " + (b.length() > 160 ? b.substring(0, 160) + "…" : b));
        }
    }

    final ConfigurableApplicationContext gateway;
    final ObjectMapper json = new ObjectMapper();

    public Shop(ConfigurableApplicationContext gateway) { this.gateway = gateway; }

    // ───────── 賣家 ─────────

    public long createProduct(String name, int initialStock) throws Exception {
        Res r = send("POST", "/api/seller/products", seller(), Map.of("name", name, "price", new BigDecimal("100.00"),
                "categoryId", 11, "initialStock", initialStock), Map.of());
        if (r.status() != 201) throw new IllegalStateException("建立商品 " + r.brief());
        return r.json().get("id").asLong();
    }

    public Res publish(long productId) throws Exception { return send("POST", "/api/seller/products/" + productId + "/publish", seller(), null, Map.of()); }

    public Res hot(long productId) throws Exception { return send("POST", "/api/seller/products/" + productId + "/hot", seller(), Map.of("hot", true), Map.of()); }

    public Res restock(long productId, int quantity) throws Exception {
        return send("POST", "/api/seller/products/" + productId + "/restock", seller(), Map.of("quantity", quantity, "note", "d03"), Map.of());
    }

    public Res startPicking(String orderNo) throws Exception { return send("POST", "/api/seller/orders/" + orderNo + "/start-picking", seller(), null, Map.of()); }

    public Res ship(String orderNo) throws Exception {
        return send("POST", "/api/seller/orders/" + orderNo + "/ship", seller(), Map.of("carrier", "黑貓", "trackingNo", "D03-" + orderNo), Map.of());
    }

    // ───────── 買家 ─────────

    /** 下單：每個商品 1 件，單價 100 */
    public Res place(long buyer, String idempotencyKey, long... products) throws Exception {
        List<Map<String, Object>> items = new ArrayList<>();
        for (long p : products) items.add(Map.of("productId", p, "quantity", 1, "unitPrice", new BigDecimal("100.00")));
        return send("POST", "/api/orders", bearer(buyer), Map.of("items", items), Map.of("Idempotency-Key", idempotencyKey));
    }

    public String placeOk(long buyer, long... products) throws Exception {
        Res r = place(buyer, UUID.randomUUID().toString(), products);
        if (r.status() != 201) throw new IllegalStateException("下單 " + r.brief());
        return r.json().get("orderNo").asText();
    }

    public Res cancel(long buyer, String orderNo) throws Exception { return send("POST", "/api/orders/" + orderNo + "/cancel", bearer(buyer), null, Map.of()); }

    /** 建立付款、送出簽好章的金流回呼（成功）。回傳回呼的回應 */
    public Res pay(long buyer, String orderNo) throws Exception {
        Res p = send("POST", "/api/orders/" + orderNo + "/payments", bearer(buyer), null, Map.of());
        if (p.status() != 201) throw new IllegalStateException("建立付款 " + p.brief());
        long paymentId = p.json().get("paymentId").asLong();
        BigDecimal amount = new BigDecimal(p.json().get("amount").asText());
        String txn = "d03-" + UUID.randomUUID();
        String secret = gateway.getBean(ShopProperties.class).payment().callbackSecret();
        return send("POST", "/api/payments/callback", null, Map.of("paymentId", paymentId, "providerTxnId", txn, "amount", amount,
                "result", "SUCCEEDED", "signature", CallbackSignature.sign(secret, CallbackSignature.canonical(paymentId, txn, amount, true))), Map.of());
    }

    // ───────── HTTP ─────────

    public String bearer(long buyer) { return TestTokens.bearer(gateway, buyer); }
    public String seller() { return TestTokens.bearer(gateway, SELLER, Role.SELLER); }

    public Res send(String method, String path, String token, Object body, Map<String, String> headers) throws Exception {
        return send(SplitLab.port(gateway), method, path, token, body, headers);
    }

    /** 直接打某一個服務（例如繞過訂單服務、直接打庫存服務） */
    public Res send(int port, String method, String path, String token, Object body, Map<String, String> headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(60)).header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        if (token != null) b.header("Authorization", token);
        headers.forEach(b::header);
        long t0 = System.nanoTime();
        HttpResponse<String> r = SplitLab.CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
        return new Res(r.statusCode(), r.body(), (System.nanoTime() - t0) / 1_000_000);
    }
}
```

**`src/test/java/com/example/shop/dist03/Roles.java`**（3.4.6）

```java
package com.example.shop.dist03;

import com.example.shop.ShopApplication;
import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import java.util.List;

/**
 * 13 站第 03 章的實驗支架：兩個服務用「正式的」設定起來 —— application-inventory-service.yml、application-order-service.yml（3.7），
 * 再疊上第 02 章 Split 的那幾個實驗用的參數（誠實的兩個庫 shop_d02_order / shop_d02_inv、Redis 10 / 9、隨機的埠、DbTap、ApiTap）。
 * 第 02 章的實驗是 lab.d02.*（RemoteInventory → InventoryEndpoints）；這裡一個 lab.* 都不用：線是 src/main 裡的那一條。
 */
public final class Roles {

    /** 實驗用的服務 token 金鑰（正式環境由 SHOP_SERVICE_TOKEN_SECRET 提供） */
    public static final String SECRET = "d03-lab-service-token-secret-0123456789";

    private Roles() {}

    public static ConfigurableApplicationContext inventoryService(List<String> extra) throws Exception {
        List<String> a = Split.args(Split.INV_DB, Split.INV_REDIS, Split.Schema.HONEST, true, false);
        a = Split.override(a, List.of("--spring.profiles.active=local,inventory-service", "--shop.deployment.service-token.secret=" + SECRET));
        return flushed(new SpringApplicationBuilder(ShopApplication.class).run(Split.override(a, extra).toArray(String[]::new)));
    }

    public static ConfigurableApplicationContext orderService(ConfigurableApplicationContext inventory, List<String> extra) throws Exception {
        List<String> a = Split.args(Split.ORDER_DB, Split.ORDER_REDIS, Split.Schema.HONEST, false, false);
        a = Split.override(a, List.of("--spring.profiles.active=local,order-service", "--shop.deployment.service-token.secret=" + SECRET,
                "--shop.deployment.inventory.url=http://127.0.0.1:" + SplitLab.port(inventory),
                // 使用者的一天直接呼叫 OrderJobs（第 01 章 1.4.4）：要有這個 bean；間隔拉長到不會自己再跑一次
                "--shop.order.jobs-enabled=true", "--shop.order.timeout-scan-interval=1h"));
        ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ShopApplication.class).run(Split.override(a, extra).toArray(String[]::new));
        Thread.sleep(1000);                                                  // 排程在啟動時各跑一次（空的資料庫）：等它跑完
        return flushed(ctx);
    }

    static ConfigurableApplicationContext flushed(ConfigurableApplicationContext ctx) {
        ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class).execute(
                (org.springframework.data.redis.core.RedisCallback<Void>) c -> { c.serverCommands().flushDb(); return null; });
        return ctx;
    }
}
```

**`src/test/java/com/example/shop/dist03/CallTap.java`**（3.4.6）

```java
package com.example.shop.dist03;

import com.example.shop.dist01.OpTag;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.client.RestClientCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.ClientHttpRequestInterceptor;

import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * 13 站 3.4：訂單服務打了庫存服務幾次 —— 在呼叫端數（HTTP 請求真的送出去的那一刻），標上「這是哪一個使用者動作」（OpTag，第 01 章 1.4）。
 * Java 的方法呼叫次數（Probe.CALLS）跟 HTTP 請求次數不一定一樣：空清單不送、沒有回應時再送一次。
 *
 *   v1（RemoteInventoryApi）：它用 Spring 的 RestClient.Builder，這裡用一個 RestClientCustomizer 掛上攔截器（lab.d03.call-tap=true）
 *   第 02 章的那條線（dist02.RemoteInventory）：自己 new 的 builder，在那裡直接掛 INTERCEPTOR
 */
@Configuration
@ConditionalOnProperty(name = "lab.d03.call-tap", havingValue = "true")
public class CallTap {

    public record Call(String op, String method, String path) {}

    public static final ConcurrentLinkedQueue<Call> CALLS = new ConcurrentLinkedQueue<>();

    /** 路徑裡的數字換成 {n}：/reservations/123/confirm → /reservations/{n}/confirm */
    public static final ClientHttpRequestInterceptor INTERCEPTOR = (req, body, exec) -> {
        CALLS.add(new Call(OpTag.current(), req.getMethod().name(), req.getURI().getPath().replaceAll("/\\d+", "/{n}")));
        return exec.execute(req, body);
    };

    @Bean
    RestClientCustomizer d03CallTap() {
        return b -> b.requestInterceptor(INTERCEPTOR);
    }
}
```

**`src/test/java/com/example/shop/dist03/D1TheLineTest.java`**（3.2（實驗））

```java
package com.example.shop.dist03;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 13 站 3.2：第 02 章留下來的那條線（POST /lab/d02/inventory/{op}，13 個方法原封不動搬到 HTTP 上），放到三種真的會發生的情況裡：
 *
 *   ① 事件真的走 broker：同一個 jar 部署兩次，兩個服務都照第 12 站的預設打開 relay 與消費者
 *   ② 回應遺失：庫存服務做完了、commit 了，回應晚到訂單服務已經放棄（read timeout 10 秒）之後 —— 使用者看到 500，再按一次
 *   ③ 沒有認證：任何連得到庫存服務的人，直接打那條線
 *
 * 程式碼是第 02 章的（這個實驗是 d03 的第一個 commit，src/main 還沒有動）。
 *
 *   mvn test -Pexperiments -Dtest=D1TheLineTest
 */
@Tag("experiment")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class D1TheLineTest {

    final PrintStream out = System.out;

    @Test @Order(1)
    void broker() throws Exception {
        out.printf("═══ 3.2 ① 同一個 jar 部署兩次，兩個服務都打開 relay 與消費者（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        Broker.freshVhost();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.HONEST, Split.Remote.FULL, false, Broker.args());
             ConfigurableApplicationContext order = Split.orderService(Split.Schema.HONEST, Split.Remote.FULL, inv, false, Broker.args())) {
            List<String> mains = Broker.queueNames().stream().filter(q -> !q.endsWith(".dlq") && !q.startsWith("shop.retry")).toList();
            for (int i = 0; i < 100 && Broker.consumers(order, mains).values().stream().anyMatch(n -> n < 4); i++) Thread.sleep(100);
            out.printf("  兩個服務各有 %d 個消費者（EventHandler）；每一個佇列的消費者數：%s%n",
                    order.getBeansOfType(com.example.shop.shared.events.EventHandler.class).size(), Broker.consumers(order, mains));
            Shop shop = new Shop(order);
            List<String> dbs = List.of(Split.ORDER_DB, Split.INV_DB);
            List<ConfigurableApplicationContext> both = List.of(order, inv);

            long[] products = new long[20];
            for (int i = 0; i < products.length; i++) products[i] = shop.createProduct("d03 商品 " + i, 100);
            long ms = Flow.quiet(both, dbs, 60_000);
            String ids = join(products);
            long withRow = SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory WHERE product_id IN (" + ids + ")");
            out.printf("  建立 20 個商品（期初 100 件）→ %,d ms 後安靜下來；庫存服務的庫裡有庫存列的：%d／20%n", ms, withRow);

            long hot = SplitLab.count(Split.INV_DB, "SELECT MIN(product_id) FROM inventory WHERE product_id IN (" + ids + ")");
            for (long p : products) shop.publish(p);
            shop.hot(hot);
            List<String> orders = new ArrayList<>();
            for (int b = 0; b < 40; b++) orders.add(shop.placeOk(7_000_001L + b, hot));
            for (int b = 0; b < 20; b++) {
                Shop.Res r = shop.cancel(7_000_001L + b, orders.get(b));
                if (r.status() != 200) out.println("  取消 " + orders.get(b) + " → " + r.brief());
            }
            ms = Flow.quiet(both, dbs, 60_000);
            out.printf("  熱點商品 %d：40 位買家各買 1 件，前 20 位取消 → %,d ms 後安靜下來%n", hot, ms);
            Flow.print(out, order, inv);

            long settled = SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory_reservations WHERE product_id = " + hot + " AND status = 'HELD' AND counted");
            long uncounted = SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory_reservations WHERE product_id = " + hot + " AND status = 'HELD' AND NOT counted");
            out.printf("  熱點落帳：沒有取消的 20 張，計入 reserved 的 %d 張、還沒計入的 %d 張%n", settled, uncounted);
            String redis = inv.getBean(StringRedisTemplate.class).opsForValue().get("stock:" + hot);
            long base = SplitLab.count(Split.INV_DB, gateBaseSql(hot));
            out.printf("  熱點閘門（庫存服務的 Redis）stock:%d = %s；MySQL 算出來應該是 %d%n", hot, redis, base);
            String orderRedis = order.getBean(StringRedisTemplate.class).opsForValue().get("stock:" + hot);
            out.printf("  訂單服務自己的 Redis 裡有沒有 stock:%d：%s%n", hot, orderRedis == null ? "沒有" : orderRedis);
            out.printf("  通知（訂單服務的庫）：應該 60 封（成立 40、取消 20），SENT %d 封、FAILED %d 封%n",
                    SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM notifications WHERE status = 'SENT'"),
                    SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM notifications WHERE status = 'FAILED'"));
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    @Test @Order(2)
    void lostResponses() throws Exception {
        out.printf("═══ 3.2 ② 回應遺失：庫存服務 commit 之後 11 秒才回應，訂單服務等 10 秒（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        LostResponse.reset();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.HONEST, Split.Remote.FULL, false, List.of("--lab.d03.lost-response=true"));
             ConfigurableApplicationContext order = Split.orderService(Split.Schema.HONEST, Split.Remote.FULL, inv, false)) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Shop shop = new Shop(order);
            long p1 = SplitLab.FIRST_PRODUCT, p2 = p1 + 1, hot = p1 + 2, p3 = p1 + 3;

            // (a) 補貨
            long before = onHand(p1);
            LostResponse.arm("/inventory/restock", 11_000, 1);
            Shop.Res first = shop.restock(p1, 10);
            Shop.Res again = shop.restock(p1, 10);
            out.printf("  補貨 10 件       │ 第一次 %s（%,d ms）│ 賣家再按一次 %d │ on_hand %+d（應該 +10）│ RESTOCK 帳 %d 筆%n",
                    status(first), first.millis(), again.status(), onHand(p1) - before,
                    SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory_ledger WHERE product_id = " + p1 + " AND reason = 'RESTOCK'"));

            // (b) 下單（一般商品）
            long buyer = 7_100_001L;
            String key = UUID.randomUUID().toString();
            long reservedBefore = reserved(p2);
            LostResponse.arm("/inventory/reserve", 11_000, 1);
            first = shop.place(buyer, key, p2);
            again = shop.place(buyer, key, p2);
            long orphans = orphanReservations(p2);
            out.printf("  下單（一般）     │ 第一次 %s（%,d ms）│ 同一個鍵再送一次 %d │ 這位買家的訂單 %d 張 │ reserved %+d（應該 +1）│ 沒有訂單的預留 %d 筆%n",
                    status(first), first.millis(), again.status(),
                    SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM orders WHERE buyer_id = " + buyer), reserved(p2) - reservedBefore, orphans);

            // (c) 下單（熱點商品）：閘門在下單交易之前
            shop.hot(hot);
            StringRedisTemplate invRedis = inv.getBean(StringRedisTemplate.class);
            long gateBefore = Long.parseLong(invRedis.opsForValue().get("stock:" + hot));
            buyer = 7_100_002L;
            key = UUID.randomUUID().toString();
            LostResponse.arm("/inventory/gate-hot", 11_000, 1);
            first = shop.place(buyer, key, hot);
            again = shop.place(buyer, key, hot);
            long gateAfter = Long.parseLong(invRedis.opsForValue().get("stock:" + hot));
            out.printf("  下單（熱點）     │ 第一次 %s（%,d ms）│ 同一個鍵再送一次 %d │ 這位買家的訂單 %d 張 │ 閘門 %+d（應該 −1）│ MySQL 算出來的閘門 %d、Redis %d%n",
                    status(first), first.millis(), again.status(),
                    SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM orders WHERE buyer_id = " + buyer), gateAfter - gateBefore,
                    SplitLab.count(Split.INV_DB, gateBaseSql(hot)), gateAfter);

            // (d) 取消
            buyer = 7_100_003L;
            String no = shop.placeOk(buyer, p3);
            LostResponse.arm("/inventory/release", 11_000, 1);
            first = shop.cancel(buyer, no);
            String between = orderStatus(no) + "／預留 " + reservationStatus(no);
            again = shop.cancel(buyer, no);
            out.printf("  取消（未付款）   │ 第一次 %s（%,d ms）│ 那之後：訂單 %s │ 買家再按一次 %d │ 最後：訂單 %s／預留 %s%n",
                    status(first), first.millis(), between, again.status(), orderStatus(no), reservationStatus(no));
            out.println("  庫存服務延後送出的回應：" + LostResponse.HITS);
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    @Test @Order(3)
    void noAuthentication() throws Exception {
        out.printf("═══ 3.2 ③ 沒有認證：直接打庫存服務的那條線（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.HONEST, Split.Remote.FULL, false);
             ConfigurableApplicationContext order = Split.orderService(Split.Schema.HONEST, Split.Remote.FULL, inv, false)) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Shop shop = new Shop(order);
            int invPort = SplitLab.port(inv);
            long p = SplitLab.FIRST_PRODUCT + 10, victim = 7_200_001L;

            String no = shop.placeOk(victim, p);
            long orderId = orderId(no);
            long available0 = available(p);
            out.printf("  買家 %d 下單 %s（orderId %d）：預留 %s；商品 %d 可售 %d%n", victim, no, orderId, reservationStatus(no), p, available0);

            Shop.Res r = shop.send(invPort, "POST", "/lab/d02/inventory/release", null, Map.of("orderId", orderId), Map.of());
            out.printf("  沒有任何 token，POST /lab/d02/inventory/release {\"orderId\":%d} → %d%n", orderId, r.status());
            out.printf("    之後：預留 %s；可售 %d（%+d）；訂單 %s%n", reservationStatus(no), available(p), available(p) - available0, orderStatus(no));
            Shop.Res paid = shop.pay(victim, no);
            Shop.Res picking = shop.startPicking(no);
            Shop.Res ship = shop.ship(no);
            out.printf("    買家付款 → %d；賣家撿貨 → %d；出貨 → %s%n", paid.status(), picking.status(), ship.brief());
            out.printf("    最後：訂單 %s；預留 %s；可售 %d%n", orderStatus(no), reservationStatus(no), available(p));

            long onHand0 = onHand(p);
            r = shop.send(invPort, "POST", "/lab/d02/inventory/restock", null, Map.of("productId", p, "quantity", 1_000_000, "note", "d03"), Map.of());
            out.printf("  沒有任何 token，POST /lab/d02/inventory/restock 100 萬件 → %d；on_hand %d → %d%n", r.status(), onHand0, onHand(p));

            List<Long> ids = new ArrayList<>();
            for (long i = 1; i <= 50; i++) ids.add(i);
            r = shop.send(invPort, "POST", "/lab/d02/inventory/reservations-of", null, Map.of("orderIds", ids), Map.of());
            out.printf("  沒有任何 token，POST /lab/d02/inventory/reservations-of（orderId 1～50）→ %d：%s%n", r.status(), r.brief());

            String userToken = shop.bearer(victim);
            r = shop.send(invPort, "POST", "/lab/d02/inventory/release", userToken, Map.of("orderId", orderId), Map.of());
            out.printf("  帶買家的 JWT 打同一支 → %d（這條鏈 permitAll：token 有沒有、是誰的，都一樣）%n", r.status());
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    // ───────── 讀資料（root，直接讀擁有那張表的庫）─────────

    static String join(long[] ids) {
        StringBuilder s = new StringBuilder();
        for (long id : ids) s.append(s.isEmpty() ? "" : ",").append(id);
        return s.toString();
    }

    static String status(Shop.Res r) { return String.valueOf(r.status()); }

    static long onHand(long p) throws Exception { return SplitLab.count(Split.INV_DB, "SELECT on_hand FROM inventory WHERE product_id = " + p); }
    static long reserved(long p) throws Exception { return SplitLab.count(Split.INV_DB, "SELECT reserved FROM inventory WHERE product_id = " + p); }
    static long available(long p) throws Exception { return SplitLab.count(Split.INV_DB, "SELECT on_hand - reserved FROM inventory WHERE product_id = " + p); }

    static long orderId(String orderNo) throws Exception {
        return SplitLab.count(Split.ORDER_DB, "SELECT id FROM orders WHERE order_no = '" + orderNo + "'");
    }

    static String orderStatus(String orderNo) throws Exception {
        try (var c = SplitLab.root(Split.ORDER_DB); var st = c.createStatement(); var rs = st.executeQuery("SELECT status FROM orders WHERE order_no = '" + orderNo + "'")) {
            return rs.next() ? rs.getString(1) : "（沒有這張）";
        }
    }

    static String reservationStatus(String orderNo) throws Exception {
        long id = orderId(orderNo);
        try (var c = SplitLab.root(Split.INV_DB); var st = c.createStatement(); var rs = st.executeQuery("SELECT GROUP_CONCAT(status) FROM inventory_reservations WHERE order_id = " + id)) {
            rs.next();
            return rs.getString(1);
        }
    }

    /** 這個商品的預留裡，order_id 在訂單服務的庫找不到的（兩個庫在同一台 MySQL：用跨庫的 JOIN 當標準答案，2.6.6） */
    static long orphanReservations(long p) throws Exception {
        return SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory_reservations r LEFT JOIN " + Split.ORDER_DB
                + ".orders o ON o.id = r.order_id WHERE r.product_id = " + p + " AND o.id IS NULL");
    }

    /** 第 12 站 HotStock.GATE_BASE_SQL：熱點閘門「應該」是多少 */
    static String gateBaseSql(long p) throws Exception {
        var f = Class.forName("com.example.shop.inventory.internal.HotStock").getDeclaredField("GATE_BASE_SQL");
        f.setAccessible(true);
        return ((String) f.get(null)).replace("?", String.valueOf(p));
    }
}
```

**`src/test/java/com/example/shop/dist03/D2InterfaceTest.java`**（3.4.6（實驗））

```java
package com.example.shop.dist03;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist01.D01Workload;
import com.example.shop.dist01.Probe;
import com.example.shop.dist02.Split;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 3.4：同一個「使用者的一天」（第 01 章 1.4.4），跑在兩條線上，數訂單服務打了庫存服務幾次（CallTap：真的送出去的 HTTP 請求）。
 *
 *   ① 第 02 章的線：POST /lab/d02/inventory/{op}（dist02.RemoteInventory → InventoryEndpoints）
 *   ② 這一章的線：/internal/inventory/v1/**（src/main 的 RemoteInventoryApi → InventoryServiceController），兩個服務用正式的 profile 起來
 *
 * 事件照第 02 章的做法由工作負載交給擁有那個消費者的服務（broker 是 3.7 / D5 的事）。
 *
 *   mvn test -Pexperiments -Dtest=D2InterfaceTest
 */
@Tag("experiment")
class D2InterfaceTest {

    final PrintStream out = System.out;

    @Test
    void userDayOnBothLines() throws Exception {
        out.printf("═══ 3.4 ① 第 02 章的線：使用者的一天（load %s）═══%n", SplitLab.load());
        Map<String, Integer> lab, v1;
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.HONEST, Split.Remote.FULL, false);
             ConfigurableApplicationContext order = Split.orderService(Split.Schema.HONEST, Split.Remote.FULL, inv, false)) {
            lab = day(order, inv);
        }
        out.printf("═══ 3.4 ② 這一章的線：/internal/inventory/v1，兩個服務用正式的 profile（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Roles.inventoryService(List.of());
             ConfigurableApplicationContext order = Roles.orderService(inv, List.of("--lab.d03.call-tap=true"))) {
            out.println("  訂單服務的 InventoryApi：" + org.springframework.aop.support.AopUtils.getTargetClass(
                    order.getBean(com.example.shop.inventory.InventoryApi.class)).getName());
            v1 = day(order, inv);
        }
        out.println("═══ 3.4 每一個動作打了庫存服務幾次（第 02 章 → 這一章）═══");
        Map<String, int[]> perAction = new TreeMap<>();                     // 鍵是「動作 → 端點」：動作本身也可能含 →（事件 X → 消費者）
        lab.forEach((k, n) -> perAction.computeIfAbsent(k.substring(0, k.lastIndexOf(" → ")), x -> new int[2])[0] += n);
        v1.forEach((k, n) -> perAction.computeIfAbsent(k.substring(0, k.lastIndexOf(" → ")), x -> new int[2])[1] += n);
        perAction.forEach((action, n) -> out.printf("  %-62s │ %3d → %3d%n", action, n[0], n[1]));
        out.printf("  合計 %d → %d 次%n", lab.values().stream().mapToInt(Integer::intValue).sum(), v1.values().stream().mapToInt(Integer::intValue).sum());
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    Map<String, Integer> day(ConfigurableApplicationContext order, ConfigurableApplicationContext inv) throws Exception {
        Probe.reset();
        CallTap.CALLS.clear();
        D01Workload w = new D01Workload(order, Split.owners(order, inv), Split.databases());
        w.run();
        long requests = w.steps.stream().filter(s -> s.status() > 0).count();
        out.printf("  使用者的一天：%d 個 HTTP 請求全部是預期的回應%n", requests);
        Map<String, Integer> byOpAndEndpoint = new TreeMap<>();
        for (CallTap.Call c : CallTap.CALLS) byOpAndEndpoint.merge(c.op() + " → " + c.method() + " " + c.path(), 1, Integer::sum);
        out.printf("  訂單服務 → 庫存服務：%d 次 HTTP、%d 種端點%n", CallTap.CALLS.size(),
                CallTap.CALLS.stream().map(c -> c.method() + " " + c.path()).distinct().count());
        byOpAndEndpoint.forEach((k, n) -> out.printf("    %-100s × %d%n", k, n));
        assertThat(requests).isEqualTo(61);
        return byOpAndEndpoint;
    }

}
```

**`src/test/java/com/example/shop/dist03/D3TheLineAgainTest.java`**（3.5.6、3.6.4、3.7.4（實驗））

```java
package com.example.shop.dist03;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 3.5、3.6、3.7：D1 的三種情況，換成這一章的線再跑一次 —— 同樣的工作負載、同樣的失敗注入，兩個服務用正式的 profile（Roles）。
 *
 *   ① 同一個 jar 部署兩次、兩個服務都打開 relay 與消費者（3.7：每一個服務只收自己的模組）
 *   ② 回應遺失：庫存服務 commit 之後 4 秒才回應，訂單服務等 3 秒（shop.deployment.inventory.read-timeout）（3.5：同一個鍵再送一次）；
 *      最後一個情況兩次都沒有回應（3.5.6：這一章修不好的那一種）
 *   ③ 直接打庫存服務（3.6：服務之間的 token）
 *
 *   mvn test -Pexperiments -Dtest=D3TheLineAgainTest
 */
@Tag("experiment")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class D3TheLineAgainTest {

    final PrintStream out = System.out;

    @Test @Order(1)
    void broker() throws Exception {
        out.printf("═══ 3.7 ① 同一個 jar 部署兩次，兩個服務都打開 relay 與消費者 —— 這一章的角色（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        Broker.freshVhost();
        try (ConfigurableApplicationContext inv = Roles.inventoryService(Broker.args());
             ConfigurableApplicationContext order = Roles.orderService(inv, Broker.args())) {
            List<String> mains = Broker.queueNames().stream().filter(q -> !q.endsWith(".dlq") && !q.startsWith("shop.retry")).toList();
            for (int i = 0; i < 100 && Broker.consumers(order, mains).values().stream().anyMatch(n -> n < 2); i++) Thread.sleep(100);
            out.printf("  每一個佇列的消費者數：%s%n", Broker.consumers(order, mains));
            Shop shop = new Shop(order);
            List<String> dbs = List.of(Split.ORDER_DB, Split.INV_DB);
            List<ConfigurableApplicationContext> both = List.of(order, inv);

            long[] products = new long[20];
            for (int i = 0; i < products.length; i++) products[i] = shop.createProduct("d03 商品 " + i, 100);
            long ms = Flow.quiet(both, dbs, 60_000);
            String ids = D1TheLineTest.join(products);
            long withRow = SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory WHERE product_id IN (" + ids + ")");
            out.printf("  建立 20 個商品（期初 100 件）→ %,d ms 後安靜下來；庫存服務的庫裡有庫存列的：%d／20%n", ms, withRow);

            long hot = SplitLab.count(Split.INV_DB, "SELECT MIN(product_id) FROM inventory WHERE product_id IN (" + ids + ")");
            for (long p : products) shop.publish(p);
            shop.hot(hot);
            List<String> orders = new ArrayList<>();
            for (int b = 0; b < 40; b++) orders.add(shop.placeOk(7_000_001L + b, hot));
            for (int b = 0; b < 20; b++) {
                Shop.Res r = shop.cancel(7_000_001L + b, orders.get(b));
                if (r.status() != 200) out.println("  取消 " + orders.get(b) + " → " + r.brief());
            }
            ms = Flow.quiet(both, dbs, 60_000);
            out.printf("  熱點商品 %d：40 位買家各買 1 件，前 20 位取消 → %,d ms 後安靜下來%n", hot, ms);
            Flow.print(out, order, inv);

            long settled = SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory_reservations WHERE product_id = " + hot + " AND status = 'HELD' AND counted");
            long uncounted = SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory_reservations WHERE product_id = " + hot + " AND status = 'HELD' AND NOT counted");
            out.printf("  熱點落帳：沒有取消的 20 張，計入 reserved 的 %d 張、還沒計入的 %d 張%n", settled, uncounted);
            String redis = inv.getBean(StringRedisTemplate.class).opsForValue().get("stock:" + hot);
            long base = SplitLab.count(Split.INV_DB, D1TheLineTest.gateBaseSql(hot));
            out.printf("  熱點閘門（庫存服務的 Redis）stock:%d = %s；MySQL 算出來應該是 %d%n", hot, redis, base);
            out.printf("  通知（訂單服務的庫）：應該 60 封（成立 40、取消 20），SENT %d 封、FAILED %d 封%n",
                    SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM notifications WHERE status = 'SENT'"),
                    SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM notifications WHERE status = 'FAILED'"));
            assertThat(withRow).isEqualTo(20);
            assertThat(redis).isEqualTo(String.valueOf(base));
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    @Test @Order(2)
    void lostResponses() throws Exception {
        out.printf("═══ 3.5 ② 回應遺失：庫存服務 commit 之後 4 秒才回應，訂單服務等 3 秒（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        LostResponse.reset();
        try (ConfigurableApplicationContext inv = Roles.inventoryService(List.of("--lab.d03.lost-response=true"));
             ConfigurableApplicationContext order = Roles.orderService(inv, List.of())) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Shop shop = new Shop(order);
            long p1 = SplitLab.FIRST_PRODUCT, p2 = p1 + 1, hot = p1 + 2, p3 = p1 + 3;

            long before = D1TheLineTest.onHand(p1);
            LostResponse.arm("POST", "/restocks", 4_000, 1);
            Shop.Res first = shop.restock(p1, 10);
            out.printf("  補貨 10 件       │ 賣家看到 %d（%,d ms）│ on_hand %+d（應該 +10）│ RESTOCK 帳 %d 筆%n", first.status(), first.millis(),
                    D1TheLineTest.onHand(p1) - before,
                    SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory_ledger WHERE product_id = " + p1 + " AND reason = 'RESTOCK'"));

            long buyer = 7_100_001L;
            long reservedBefore = D1TheLineTest.reserved(p2);
            LostResponse.arm("PUT", "/reservations/", 4_000, 1);
            first = shop.place(buyer, UUID.randomUUID().toString(), p2);
            out.printf("  下單（一般）     │ 買家看到 %d（%,d ms）│ 這位買家的訂單 %d 張 │ reserved %+d（應該 +1）│ 沒有訂單的預留 %d 筆%n",
                    first.status(), first.millis(), SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM orders WHERE buyer_id = " + buyer),
                    D1TheLineTest.reserved(p2) - reservedBefore, D1TheLineTest.orphanReservations(p2));

            shop.hot(hot);
            StringRedisTemplate invRedis = inv.getBean(StringRedisTemplate.class);
            long gateBefore = Long.parseLong(invRedis.opsForValue().get("stock:" + hot));
            buyer = 7_100_002L;
            LostResponse.arm("POST", "/hot-gate", 4_000, 1);
            first = shop.place(buyer, UUID.randomUUID().toString(), hot);
            long gateAfter = Long.parseLong(invRedis.opsForValue().get("stock:" + hot));
            out.printf("  下單（熱點）     │ 買家看到 %d（%,d ms）│ 這位買家的訂單 %d 張 │ 閘門 %+d（應該 −1）│ MySQL 算出來的閘門 %d、Redis %d%n",
                    first.status(), first.millis(), SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM orders WHERE buyer_id = " + buyer),
                    gateAfter - gateBefore, SplitLab.count(Split.INV_DB, D1TheLineTest.gateBaseSql(hot)), gateAfter);

            buyer = 7_100_003L;
            String no = shop.placeOk(buyer, p3);
            LostResponse.arm("POST", "/release", 4_000, 1);
            first = shop.cancel(buyer, no);
            out.printf("  取消（未付款）   │ 買家看到 %d（%,d ms）│ 訂單 %s／預留 %s%n", first.status(), first.millis(),
                    D1TheLineTest.orderStatus(no), D1TheLineTest.reservationStatus(no));
            // 兩次都沒有回應：呼叫端放棄（503）、下單交易 rollback、冪等鍵放掉 —— 使用者用同一個鍵重送，是一張新的訂單、一個新的 orderId
            buyer = 7_100_004L;
            long p4 = p1 + 4;
            String key = UUID.randomUUID().toString();
            reservedBefore = D1TheLineTest.reserved(p4);
            LostResponse.arm("PUT", "/reservations/", 4_000, 2);
            first = shop.place(buyer, key, p4);
            Shop.Res again = shop.place(buyer, key, p4);
            out.printf("  下單（兩次都沒有回應）│ 買家看到 %s（%,d ms）│ 同一個鍵再送一次 %d │ 這位買家的訂單 %d 張 │ reserved %+d（應該 +1）│ 沒有訂單的預留 %d 筆%n",
                    first.brief(), first.millis(), again.status(), SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM orders WHERE buyer_id = " + buyer),
                    D1TheLineTest.reserved(p4) - reservedBefore, D1TheLineTest.orphanReservations(p4));
            out.println("  庫存服務延後送出的回應：" + LostResponse.HITS);
            out.println("  訂單服務記到的「沒有回應」：" + noResponse(order));
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    @Test @Order(3)
    void noAuthentication() throws Exception {
        out.printf("═══ 3.6 ③ 直接打庫存服務：沒有服務的 token（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Roles.inventoryService(List.of());
             ConfigurableApplicationContext order = Roles.orderService(inv, List.of())) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Shop shop = new Shop(order);
            int invPort = SplitLab.port(inv);
            long p = SplitLab.FIRST_PRODUCT + 10, victim = 7_200_001L;

            String no = shop.placeOk(victim, p);
            long orderId = D1TheLineTest.orderId(no);
            long available0 = D1TheLineTest.available(p);
            out.printf("  買家 %d 下單 %s（orderId %d）：預留 %s；商品 %d 可售 %d%n", victim, no, orderId, D1TheLineTest.reservationStatus(no), p, available0);
            String path = "/internal/inventory/v1/reservations/" + orderId + "/release";
            Shop.Res r = shop.send(invPort, "POST", path, null, null, Map.of());
            out.printf("  沒有任何 token，POST %s → %s%n", path, r.brief());
            r = shop.send(invPort, "POST", path, shop.bearer(victim), null, Map.of());
            out.printf("  帶買家的 JWT → %s%n", r.brief());
            r = shop.send(invPort, "POST", "/internal/inventory/v1/products/" + p + "/restocks", null, Map.of("quantity", 1_000_000, "note", "d03"),
                    Map.of("Idempotency-Key", UUID.randomUUID().toString()));
            out.printf("  沒有任何 token，補貨 100 萬件 → %d%n", r.status());
            out.printf("    之後：預留 %s；可售 %d（%+d）；on_hand %d%n", D1TheLineTest.reservationStatus(no), D1TheLineTest.available(p),
                    D1TheLineTest.available(p) - available0, D1TheLineTest.onHand(p));
            r = shop.send(invPort, "POST", "/lab/d02/inventory/release", null, Map.of("orderId", orderId), Map.of());
            out.printf("  第 02 章那條線（POST /lab/d02/inventory/release）→ %d（這個部署沒有打開 lab.d02.*）%n", r.status());
            Shop.Res paid = shop.pay(victim, no);
            Shop.Res picking = shop.startPicking(no);
            Shop.Res ship = shop.ship(no);
            out.printf("  買家付款 → %d；賣家撿貨 → %d；出貨 → %d；最後：訂單 %s／預留 %s%n", paid.status(), picking.status(), ship.status(),
                    D1TheLineTest.orderStatus(no), D1TheLineTest.reservationStatus(no));
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    static Map<String, Double> noResponse(ConfigurableApplicationContext order) {
        Map<String, Double> m = new java.util.TreeMap<>();
        order.getBean(io.micrometer.core.instrument.MeterRegistry.class).find("shop.remote.no_response").counters()
                .forEach(c -> m.put(c.getId().getTag("op"), c.count()));
        return m;
    }
}
```

**`src/test/java/com/example/shop/dist03/D4BrokerDayTest.java`**（3.7.5（實驗））

```java
package com.example.shop.dist03;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist01.D01Workload;
import com.example.shop.dist02.Split;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 3.7.5：使用者的一天（第 01 章 1.4.4），事件真的走 broker —— 兩個服務各自的 relay 把自己的 outbox 送到 RabbitMQ（shop_d03 這個 vhost），
 * 各自的消費者只收自己擁有的模組。工作負載在「交付事件」的地方改成等 broker 安靜下來（Flow.quiet）。
 * 第 02 章的實驗（與 D2）都是工作負載自己讀 outbox、交給另一個服務的消費者。
 *
 *   mvn test -Pexperiments -Dtest=D4BrokerDayTest
 */
@Tag("experiment")
class D4BrokerDayTest {

    final PrintStream out = System.out;

    @Test
    void userDayOverTheBroker() throws Exception {
        out.printf("═══ 3.7.5 使用者的一天，事件走 RabbitMQ：兩個服務、正式的角色（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        Broker.freshVhost();
        try (ConfigurableApplicationContext inv = Roles.inventoryService(Broker.args());
             ConfigurableApplicationContext order = Roles.orderService(inv, Broker.args())) {
            List<String> mains = Broker.queueNames().stream().filter(q -> !q.endsWith(".dlq") && !q.startsWith("shop.retry")).toList();
            for (int i = 0; i < 100 && Broker.consumers(order, mains).values().stream().anyMatch(n -> n < 2); i++) Thread.sleep(100);
            out.printf("  每一個佇列的消費者數：%s%n", Broker.consumers(order, mains));
            List<String> dbs = List.of(Split.ORDER_DB, Split.INV_DB);
            List<ConfigurableApplicationContext> both = List.of(order, inv);
            D01Workload w = new D01Workload(order, Split.owners(order, inv), Split.databases());
            long[] waited = new long[2];
            w.broker = () -> { waited[0] += Flow.quiet(both, dbs, 60_000); waited[1]++; return null; };
            long t0 = System.nanoTime();
            w.run();
            long requests = w.steps.stream().filter(s -> s.status() > 0).count();
            out.printf("  使用者的一天：%d 個 HTTP 請求全部是預期的回應；等事件 %d 次、一共 %,d ms；整天 %,d ms%n",
                    requests, waited[1], waited[0], (System.nanoTime() - t0) / 1_000_000);
            Flow.print(out, order, inv);
            for (String db : dbs)
                out.printf("  %-15s outbox：送出 %d 筆、還沒送 %d 筆；processed_messages %d 列%n", db,
                        SplitLab.count(db, "SELECT COUNT(*) FROM outbox_events WHERE published_at IS NOT NULL"),
                        SplitLab.count(db, "SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL"),
                        SplitLab.count(db, "SELECT COUNT(*) FROM processed_messages"));
            out.printf("  通知（訂單服務的庫）：SENT %d 封、FAILED %d 封；訂單 6 張的狀態：%s%n",
                    SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM notifications WHERE status = 'SENT'"),
                    SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM notifications WHERE status = 'FAILED'"), statuses());
            assertThat(requests).isEqualTo(61);
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    static String statuses() throws Exception {
        try (var c = SplitLab.root(Split.ORDER_DB); var st = c.createStatement();
             var rs = st.executeQuery("SELECT GROUP_CONCAT(status ORDER BY id) FROM orders")) {
            rs.next();
            return rs.getString(1);
        }
    }
}
```

只改了幾行的實驗支架（第 00～02 章），列出 diff：

**`src/test/java/com/example/shop/dist01/D01Workload.java`**（3.7.5）

```diff
     private final Map<String, String> dbOf;                                   // 模組 → 那個服務的資料庫
     private final ObjectMapper json = new ObjectMapper();
     public final List<Step> steps = new ArrayList<>();
+    /**
+     * 13 站 3.7：事件真的走 broker（兩個服務的 relay 與消費者都開著）時，「交付事件」改成「等到 broker 那邊安靜下來」——
+     * 由實驗提供（dist03.Flow.quiet）。null = 照第 01 章的做法，從 outbox 讀出來自己交給消費者
+     */
+    public java.util.concurrent.Callable<?> broker;
 
     /** 一個行程、一個資料庫（第 01 章） */
     D01Workload(ConfigurableApplicationContext ctx, String db) {
…
      * 切開的部署：每一個服務的資料庫各有一個 outbox；消費者交給「擁有它所屬模組」的那個服務（用那個服務的 EventDispatcher：processed_messages 在它自己的庫）
      */
     void events() throws Exception {
+        if (broker != null) { broker.call(); return; }
         for (int round = 0; round < 10; round++) {
             boolean any = false;
             for (String db : new java.util.TreeSet<>(dbOf.values())) {
```

**`src/test/java/com/example/shop/dist02/Split.java`**（3.2.1）

```diff
 
     static final String INVENTORY_ONLY = "classpath:db/migration/inventory,classpath:db/migration/shared";
 
-    static List<String> args(String db, int redisDb, Schema schema, boolean inventoryService, boolean validate) throws Exception {
+    public static List<String> args(String db, int redisDb, Schema schema, boolean inventoryService, boolean validate) throws Exception {
         List<String> a = new ArrayList<>(SplitLab.common(db, redisDb));
         a.removeIf(x -> x.startsWith("--spring.datasource.url="));          // 同一個參數給兩次，Spring 會用逗號接起來（第 01 章 1.4.5）
         a.add("--spring.datasource.url=" + SplitLab.url(db) + "&queryInterceptors=" + DbTap.class.getName());
…
     }
 
     public static ConfigurableApplicationContext inventoryService(Schema schema, Remote remote, boolean validate) throws Exception {
+        return inventoryService(schema, remote, validate, List.of());
+    }
+
+    /** 13 站 3.2：extra 蓋過同名的參數（例如把 relay 與消費者打開） */
+    public static ConfigurableApplicationContext inventoryService(Schema schema, Remote remote, boolean validate, List<String> extra) throws Exception {
         List<String> a = args(INV_DB, INV_REDIS, schema, true, validate);
         a.add(remote == Remote.CH00 ? "--lab.d00.inventory-service=true" : "--lab.d02.inventory-service=true");
-        return flushed(new SpringApplicationBuilder(ShopApplication.class).run(a.toArray(String[]::new)));
+        return flushed(new SpringApplicationBuilder(ShopApplication.class).run(override(a, extra).toArray(String[]::new)));
     }
 
     public static ConfigurableApplicationContext orderService(Schema schema, Remote remote, ConfigurableApplicationContext inventory, boolean validate) throws Exception {
+        return orderService(schema, remote, inventory, validate, List.of());
+    }
+
+    public static ConfigurableApplicationContext orderService(Schema schema, Remote remote, ConfigurableApplicationContext inventory, boolean validate,
+                                                              List<String> extra) throws Exception {
         List<String> a = args(ORDER_DB, ORDER_REDIS, schema, false, validate);
         String url = "http://127.0.0.1:" + SplitLab.port(inventory);
         a.add(remote == Remote.CH00 ? "--lab.d00.remote-inventory-url=" + url : "--lab.d02.remote-inventory-url=" + url);
         a.removeIf(x -> x.startsWith("--shop.order.jobs-enabled="));         // 使用者的一天直接呼叫 OrderJobs（第 01 章 1.4.4 的小坑）：要有這個 bean，
         a.addAll(List.of("--shop.order.jobs-enabled=true", "--shop.order.timeout-scan-interval=1h"));   // 間隔拉長到不會自己跑第二次
-        ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ShopApplication.class).run(a.toArray(String[]::new));
+        ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ShopApplication.class).run(override(a, extra).toArray(String[]::new));
         Thread.sleep(1000);                                                  // 排程在啟動時各跑一次（空的資料庫）：等它跑完
         return flushed(ctx);
     }
 
+    /** 同一個參數給兩次，Spring 會用逗號接起來（第 01 章 1.4.5）—— 先拿掉同名的，再加上新的 */
+    public static List<String> override(List<String> args, List<String> extra) {
+        List<String> a = new ArrayList<>(args);
+        for (String e : extra) {
+            String key = e.substring(0, e.indexOf('=') + 1);
+            a.removeIf(x -> x.startsWith(key));
+            a.add(e);
+        }
+        return a;
+    }
+
     /** 資料庫每次重建，id 每次從同一個號碼開始 —— 上一次留在 Redis 的商品快取、熱點閘門會被讀到（第 01 章 1.4.5 的 ⚠️） */
     static ConfigurableApplicationContext flushed(ConfigurableApplicationContext ctx) {
         ctx.getBean(StringRedisTemplate.class).execute((RedisCallback<Void>) (RedisConnection c) -> {
```

**`src/test/java/com/example/shop/dist02/RemoteInventory.java`**（3.4.2、3.4.6）

```diff
     RemoteInventory(@Value("${lab.d02.remote-inventory-url}") String url) {
         JdkClientHttpRequestFactory f = new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build());
         f.setReadTimeout(Duration.ofSeconds(10));
-        this.http = RestClient.builder().baseUrl(url).requestFactory(f).build();
+        this.http = RestClient.builder().baseUrl(url).requestFactory(f).requestInterceptor(com.example.shop.dist03.CallTap.INTERCEPTOR).build();   // 13 站 3.4：數往返
     }
 
     private JsonNode call(String op, Map<String, ?> body) {
…
         return new IllegalStateException("庫存服務回應 " + status + "：" + body);
     }
 
-    @Override public void initialize(long productId, int onHand, String note) { call("initialize", Map.of("productId", productId, "onHand", onHand, "note", note)); }
-    @Override public void reserve(long orderId, List<ReserveLine> lines) { call("reserve", Map.of("orderId", orderId, "lines", lines)); }
-    @Override public void holdHot(long orderId, List<ReserveLine> lines) { call("hold-hot", Map.of("orderId", orderId, "lines", lines)); }
+    /** 13 站 3.4：InventoryApi 的 reserve 與 holdHot 合成一個方法；第 02 章的這條線照舊是兩支（第 12 站的 PlaceOrderService 各自在有品項時才呼叫） */
+    @Override
+    public void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
+        if (!lines.isEmpty()) call("reserve", Map.of("orderId", orderId, "lines", lines));
+        if (!hotLines.isEmpty()) call("hold-hot", Map.of("orderId", orderId, "lines", hotLines));
+    }
     @Override public void confirm(long orderId) { call("confirm", Map.of("orderId", orderId)); }
     @Override public void release(long orderId) { call("release", Map.of("orderId", orderId)); }
     @Override public void consume(long orderId) { call("consume", Map.of("orderId", orderId)); }
```

**`src/test/java/com/example/shop/dist02/InventoryEndpoints.java`**（3.4.2）

```diff
         @PostMapping("/lab/d02/inventory/{op}")
         Map<?, ?> call(@PathVariable String op, @RequestBody JsonNode b) {
             switch (op) {
-                case "initialize" -> tx.executeWithoutResult(s -> inventory.initialize(b.get("productId").asLong(), b.get("onHand").asInt(), b.get("note").asText()));
-                case "reserve" -> tx.executeWithoutResult(s -> inventory.reserve(b.get("orderId").asLong(), lines(b)));
-                case "hold-hot" -> tx.executeWithoutResult(s -> inventory.holdHot(b.get("orderId").asLong(), lines(b)));
+                // 13 站 3.4：initialize 不在 InventoryApi 上了（第 02 章 2.7 之後就沒有遠端的呼叫者）；holdHot 併進了 reserve 的第三個參數
+                case "reserve" -> tx.executeWithoutResult(s -> inventory.reserve(b.get("orderId").asLong(), lines(b), List.of()));
+                case "hold-hot" -> tx.executeWithoutResult(s -> inventory.reserve(b.get("orderId").asLong(), List.of(), lines(b)));
                 case "confirm" -> tx.executeWithoutResult(s -> inventory.confirm(b.get("orderId").asLong()));
                 case "release" -> tx.executeWithoutResult(s -> inventory.release(b.get("orderId").asLong()));
                 case "consume" -> tx.executeWithoutResult(s -> inventory.consume(b.get("orderId").asLong()));
```

**`src/test/java/com/example/shop/dist00/RemoteInventoryApi.java`**（3.4.2）

```diff
         this.http = b.baseUrl(url).requestFactory(f).build();
     }
 
+    /** 13 站 3.4：InventoryApi.reserve 多了熱點品項（第 12 站的 holdHot）。一般品項照第 00 章走 HTTP，熱點品項照舊在本地 */
     @Override
-    public void reserve(long orderId, List<ReserveLine> lines) {
-        if (perLine) for (ReserveLine l : lines) call(orderId, List.of(l));
-        else call(orderId, lines);
+    public void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
+        if (!lines.isEmpty()) {                                             // 第 12 站的 PlaceOrderService 只在有一般品項時才呼叫 reserve
+            if (perLine) for (ReserveLine l : lines) call(orderId, List.of(l));
+            else call(orderId, lines);
+        }
+        if (!hotLines.isEmpty()) local.reserve(orderId, List.of(), hotLines);
     }
 
     private void call(long orderId, List<ReserveLine> lines) {
…
     }
 
     // ── 下單流程不會走到的，照舊用本地的實作 ──
-    @Override public void initialize(long productId, int onHand, String note) { local.initialize(productId, onHand, note); }
-    @Override public void holdHot(long orderId, List<ReserveLine> lines) { local.holdHot(orderId, lines); }
     @Override public void confirm(long orderId) { local.confirm(orderId); }
     @Override public void release(long orderId) { local.release(orderId); }
     @Override public void consume(long orderId) { local.consume(orderId); }
```

**`src/test/java/com/example/shop/dist00/LabInventoryService.java`**（3.4.2）

```diff
             // 0.2.4：這一行日誌的 traceId（MDC，第 12 站 9.8）跟訂單服務那一張訂單的是不是同一個？
             org.slf4j.LoggerFactory.getLogger(LabInventoryService.class).info("D00_RESERVE orderId={} traceparent={}", req.orderId(), traceparent);
             try {
-                tx.executeWithoutResult(s -> inventory.reserve(req.orderId(), req.lines()));   // 自己的交易，在這裡就 commit 了
+                tx.executeWithoutResult(s -> inventory.reserve(req.orderId(), req.lines(), List.of()));   // 自己的交易，在這裡就 commit 了
             } catch (InsufficientStockException e) {
                 return ResponseEntity.status(409).body(Map.of("productId", e.productId()));
             }
```

**`src/test/java/com/example/lab/ch04/FriendlyPlaceOrder.java`**（3.4.2）

```diff
     @Transactional
     public Result place(long orderId, long productId) {
         try {
-            inventory.reserve(orderId, List.of(new ReserveLine(productId, 1)));
+            inventory.reserve(orderId, List.of(new ReserveLine(productId, 1)), List.of());
             return Result.PLACED;
         } catch (InsufficientStockException e) {
             return Result.OUT_OF_STOCK;                        // 接住了，交易「應該」可以正常結束
```

`src/test/resources/pacts/released/order-service-inventory-service.json` 是 Pact 產生的檔案（15 個互動、24 KB），3.8.3 列了其中一個；其他的照著 `InventoryClientPactTest` 的 15 個 `@Pact` 方法，一個方法一個互動。

---

## 3.11 常見誤區

- **「同一個 jar 部署兩次，改一下資料庫的位址就好。」** 3.2.2：兩個服務都照預設打開消費者，每一個佇列一半的訊息到了錯的服務 —— 大部分靠重試繞回來，一部分進死信，最糟的那一種成功、什麼都沒做。
- **「好幾個消費者收同一個佇列，就是負載平衡。」** 同一個服務的好幾台是（competing consumers）；不擁有那個模組的服務也在收，就是 3.2.2（3.7.1）。
- **「沒有錯誤，就沒有出錯。」** 3.2.2 的熱點閘門少了 10 件，0 次重試、0 則死信；3.8.5 的舊版訂單服務讀到可售量 0，沒有 500。網路上最貴的錯誤是安靜的。
- **「失敗了就重試。」** 只有伺服端保證了「再送一次、效果一次」，重試才安全（3.5）。順序是先改伺服端、再讓呼叫端重送。
- **「冪等鍵是呼叫端的事。」** 呼叫端產生鍵、重送時用同一個；記住「這個鍵做過了」的，一定是伺服端 —— 而且要跟業務寫入在同一個交易、或同一個原子操作裡（3.5.2、3.5.3）。
- **「4xx、5xx 也重試看看。」** 對方回應了，代表它看過這個請求、有一個答案；只有「沒有回應」才是「不知道它做了沒有」（3.5.4）。
- **「把 Java 介面原封不動搬到 HTTP 上，呼叫端一行都不用改，很好。」** 呼叫端不用改是好的；介面本身要重新看：空的呼叫、只差在交易傳播屬性的兩個方法、會留下部分成功的兩次呼叫（3.4）。
- **「對方回 401，就回使用者 401。」** 對方的 401 是「你的服務 token 錯了」，不是「你沒有登入」（3.4.5）。
- **「內部網路，不需要認證。」** 3.2.4：一個沒有 token 的請求，讓一張已付款的訂單永遠出不了貨（3.6.1）。
- **「服務之間就用使用者的 JWT。」** 兩把金鑰分開，使用者的 token 才進不了 `/internal/**`、服務的 token 才進不了 `/api/**`（3.6.2）。
- **「伺服端與呼叫端在同一個 commit 裡一起改，測試全綠，就可以部署。」** 3.8.5：262 個測試全綠，線上那一版的訂單服務會讀到 0。
- **「Pact 綠了，就是相容的。」** Pact 驗證形狀與型別，不驗證意思（3.8.5 那張表的最後一列）。
- **「Spring 的 HTTP 客戶端就是 Feign。」** Spring 6 的 `@HttpExchange` 不需要另一套註解與依賴，底下是 `RestClient`（3.4.5）。
- **「gRPC 比較快，服務之間就用 gRPC。」** 先量時間花在哪裡；這個系統一次往返的成本主要不在序列化（3.3.3）。

---

## 3.12 本章小結

第 02 章讓資料分開，這一章處理兩個服務之間的那條線：

1. **第 02 章的線在三種情況下壞掉**（3.2）：兩個服務都收同一個佇列（一半的訊息到錯的服務，其中一種安靜地什麼都沒做）、回應遺失（使用者再按一次：補貨兩次、預留兩筆、閘門減兩次）、沒有認證（一個沒有 token 的請求，讓一張已付款的訂單出不了貨）。三個假設在一個行程裡都是真的，搬到網路上沒有一個會自己跟過去。
2. **同步還是非同步，一條一條決定**（3.3）：回應之前要不要答案、另一邊會不會拒絕、讀還是寫、對方掛了要不要跟著掛。這一章沒有一條換邊 —— 換邊的都牽動 Saga 或讀模型。
3. **介面重新設計**（3.4）：16 個操作 → 12 支端點、`InventoryApi` 16 → 14 個方法；`holdHot` 併進 `reserve`，一張訂單的預留一次、全有或全無；空的清單不送；`@HttpExchange` 宣告客戶端；只有三種業務錯誤原樣交給使用者。使用者的一天：61 個請求，打庫存服務 42 → 38 次（下單 12 → 8）。
4. **每一個寫入都可以安全地再送**（3.5）：五支本來就冪等；預留與補貨用 `Inbox`（跟事件的消費者同一張 `processed_messages`）；熱點閘門用 Redis 腳本裡的標記。呼叫端只在沒有回應時、用同一個鍵、再送一次。四種回應遺失，使用者都在 3 秒多拿到成功，效果各一次。
5. **服務之間的認證**（3.6）：另一把金鑰、`iss`、`sub`、`aud`；只有 `order-service` 進得來。
6. **同一個 jar、三種角色**（3.7）：消費者只收擁有的模組；拓撲與 relay 刻意不濾；庫存服務上的使用者 API 是 404。事件真的走 RabbitMQ，使用者的一天全綠；用 jar 起兩個真的行程也一樣。
7. **契約測試**（3.8）：呼叫端寫 15 個互動，提供端在 failsafe 驗證這一次建置的、與線上那一版的兩份。提供端的驗證抓到寫錯的契約（`application/problem+json`）；一次「兩邊一起改」的改名，只有線上那一版的契約紅了。

**第 00 章的四個代價，這一章仍然沒有減少**：下單路徑上的 `reserve` 還在下單交易裡（甚至多了一次重送的窗口，3.5.4）、6 種切斷的交易還在、traceId 還是斷的。這一章換到的是：**那條線上的每一個操作，現在都可以安全地再做一次** —— 這正是第 04 章 Saga 的每一步需要的。

### 3.12.1 驗收清單

- [ ] 從 `d02` 開出 `d03`，`mvn test -Pexperiments -Dtest=D1TheLineTest` 印出三種情況：① 每一個佇列 4 個消費者、熱點閘門比 MySQL 少 10；② 四種寫入，前三種「再按一次」都多做了一次；③ 沒有 token 的請求 200（3.2）。
- [ ] **不看課文**，說出 3.2.2 裡「`hot-stock-return` 兩邊各成功 10 次」為什麼比「失敗 18 次」更糟。
- [ ] 用 3.3.1 的四個問題，說出 `reserve` 為什麼是同步的、`product.created` 為什麼是事件、`confirm` 之後可能變成什麼。
- [ ] 說出 `holdHot` 併進 `reserve`、`releaseAbandoned` 併進 `release` 各是為了什麼（3.4.2）。
- [ ] 改了 `InventoryApi` 之後先跑 `mvn test-compile`、再跑 `mvn clean test-compile`，看兩次的結果不一樣（3.4.2 的 ⚠️）。
- [ ] 跑 D2，說出下單從 12 次變成 8 次，少的是哪幾次（3.4.6）。
- [ ] 說出 `Inbox.claim()` 為什麼一定要是交易的第一句，以及為什麼重送要在交易**之後**比對內容（3.5.2）。
- [ ] 說出呼叫端為什麼只在「沒有回應」時重送，以及這一章的重送讓下單交易多了什麼代價（3.5.4）。
- [ ] 跑 `InventoryServiceApiTest`，七種身分的結果是 401 × 5、403、204（3.6.3）。
- [ ] 說出拓撲與 relay 為什麼**不**跟著角色濾；如果用「依角色排除 bean」的做法，哪一個事件會不見（3.7.3）。
- [ ] 跑 D3、D4：D1 的三種情況全部改善；使用者的一天走 RabbitMQ 全綠（3.5.6、3.6.4、3.7.4、3.7.5）。
- [ ] 照 3.7.6 用 jar 起兩個行程，從外面下一張單，在兩個庫裡找到它留下的東西。
- [ ] 在一個分支上把 `StockLevel.available` 改名、兩邊一起改，跑 `mvn clean verify`：看哪一份契約紅（3.8.5）。改用「先擴充」的做法，兩份都綠。
- [ ] `mvn clean verify` 全綠：265 個測試、30 個契約驗證（3.10）。

---

## 3.13 下一章預告

這一章讓那條線上的每一個操作都可以安全地再做一次，但沒有讓任何一個交易不再被切斷：下單、取消、付款、出貨、逾時取消 —— 6 種動作，每一種都還是「訂單服務的一個交易，裡面有一次遠端的寫入」（3.9.2）。遠端那一步 commit 了、訂單服務的交易接著失敗，留下的東西第 02 章 2.5.3 量過，這一章只是讓「重做同一件事」從碰巧變成保證。

第 04 章處理**交易本身**：

- **分散式交易為什麼沒有 `@Transactional`**：兩階段提交的代價，以及為什麼幾乎沒有人用。
- **Saga**：下單拆成幾步，每一步是一個服務自己的交易；失敗了，往回做補償。編排（一個協調者）與協同（各自聽事件）怎麼選。
- **補償怎麼寫**：釋放預留、退款 —— 以及**補償不回來的**：已經寄出的信、已經扣的款。
- **下單交易裡的那一次 `reserve`**：移出交易之後，訂單要先以什麼狀態存在？3.4.7 留下的「熱點閘門要不要搬進庫存服務」，在這裡一起決定。
- **卡在中間的訂單**：Saga 的可觀測性、人工介入，以及第 02 章的對帳在 Saga 裡的位置 —— 最後一道防線。

這一章的冪等端點就是 Saga 的每一步：協調者重送一步，不會做兩次。
