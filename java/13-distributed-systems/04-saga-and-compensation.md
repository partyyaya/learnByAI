# 第 04 章：Saga 與補償

> **上一章**：[第 03 章](03-inter-service-communication.md)讓兩個服務之間的那條線變成正式的：`/internal/inventory/v1`、服務的 token、Pact 契約，而且每一個寫入都可以安全地再送一次。但 6 種交易仍然被這一刀切斷 —— 下單、買家取消、金流回呼、賣家取消、出貨、逾時取消，每一種都是「訂單服務的一個交易，裡面有一次對庫存服務的寫入」（3.9.2）。
>
> **這一章**：處理交易本身。先在第 03 章的線上，讓訂單服務在最壞的時刻被 `kill -9`；再把兩階段提交真的做出來、量它的代價，說明為什麼不用它；然後把 6 種交易改成 Saga —— 下單是**編排**（訂單先以 `RESERVING` 寫下，預留是樞紐，失敗了補償），其他四種動作是**協同**（庫存模組聽訂單的事件）；處理補償比動作先到、補償不回來的操作；最後用同樣的 `kill -9` 再跑一次，並且量 Saga 自己的代價。
>
> **你手上會有**：從 `d03` 開出來的分支 `d04`。正式程式碼：兩個新的訂單狀態（`RESERVING`、`REJECTED`）與三個事件（E11～E13），狀態機 8 × 13；`PlaceOrderService` 變成協調者（T1 訂單、T2 預留、T3 待付款，或補償 `order.rejected`）；卡住的 `RESERVING` 由排程補償（`shop.order.placement-timeout`，60 秒）；`OrderTransitionService` 的交易裡不再呼叫庫存，庫存模組多一個消費者（`inventory.order-events`）；預留以 orderId 冪等（單體也一樣）、補償先佔位；出貨之前的唯讀檢查（`checkShippable`、`…/shippable`）；`InventoryApi` 少了 `confirm`、`release`、`consume`；給管理員的 `GET /api/admin/orders/{orderNo}/saga`；兩個 migration（V26 狀態的 CHECK 改成 `NOT ENFORCED`、V27 `order_items.hot`）。`src/test` 多一個 `dist04` 套件（六個實驗、兩台訂單服務的支架）、三個新的測試類別，第 12 站 8 個測試類別跟著改。
>
> **這一章的實測事故**：
>
> - **第 03 章的線，訂單服務在兩個 commit 之間被 `kill -9`**（4.2）：熱點閘門扣了之後當掉 → Redis 比 MySQL 少 1 件，沒有人會加回去。預留 commit 之後當掉 → 冪等鍵卡在 `PROCESSING`，買家重送 409 整整 30 秒，第 30.3 秒成立 —— 一筆孤兒預留。逾時排程釋放之後當掉，付款先到另一台 → 已付款、預留已釋放，出貨 409「即將取消」，不會有人取消它。catch 裡的補償，一行都沒有跑。
> - **兩階段提交**（4.3）：同一張訂單，XA 的 p50 5.36 ms、兩個本地交易 2.56 ms；16 條執行緒的吞吐剩三分之一（隨機商品 629～790 vs 1,807～1,938 張／秒）。協調者在 PREPARE 之後不見了：熱門商品那一列一直被鎖著，下一位買家等到 `Lock wait timeout`，連 `FOR SHARE` 讀可售量都要等；人工只收尾一半，留下一張沒有預留的訂單。
> - **新狀態的 migration**（4.5.6）：照第 12 站的寫法換一個會檢查的 CHECK，10 萬張訂單整表複製 1.4～2.0 秒，8 條下單的執行緒在那段時間裡幾乎全被擋住（最慢的一張等了整段）。改成 `NOT ENFORCED` + `INSTANT`：18～31 ms —— 代價是 `'BOGUS'` 寫得進去。報表的「訂單數」多一個狀態條件，覆蓋索引變成回表：一位賣家 0.93 → 1.71 ms、全站 26.76 → 35.41 ms。
> - **同樣的 `kill -9`，換成 Saga**（4.8.3）：重送 200、39 ms、同一張訂單、沒有孤兒；沒有人重送的那一張，A 重新起來的那一輪排程就補償了；預留的請求晚到（補償先做完）→ 409，什麼都沒留下；逾時取消之後當掉，另一台的 relay 送出它的事件，晚到的付款退款了。對帳 0 張。閘門那一件**還在** —— 它在 Saga 的第一步之前。
> - **Saga 的代價**（4.10.3）：單體的下單每張多 3.6～5.1 ms、16 條執行緒的吞吐少一到兩成（多兩次 commit）；切開的部署多 0.4～3.6 ms。B1：庫存這一刀切斷的交易 6 → **0**，127 種切法裡從第 80 名到第 24 名。
>
> **⚠️ 寫這一章途中被自己的實驗抓到的**：
>
> - **出貨的保護被我拿掉了**（4.6.3）：第一版把出貨改成純粹的事件，第 12 站 `HotSettlementTest` 紅了兩個 —— 「還在落帳 503」「即將取消 409」不見了，一件不存在的貨出得去。改成出貨之前先問一次（只讀）。
> - **v1 的 `…/consume` 不能共用新的方法**（4.6.4）：推論出來之後，暫時接上去跑線上那一版的契約：`expected status of 503 but was 204`。
> - **V26 的第一版會擋住下單**（4.5.6）：E6 量出來之後改成線上的寫法。接著**我以為沒有測試在乎那一道 CHECK** —— 用名字搜不到；整套跑下去，`SchemaConstraintTest` 的「訂單狀態只能是六個值」紅了。
> - **springdoc 把 `allowableValues` 跟 enum 接在一起**（4.5.6）：契約上的訂單狀態變成 14 個值（前六個重複一次），`OpenApiContractTest` 紅。
> - **給值班的人的 API，第一版直接讀 `outbox_events`**（4.9）：最後一次整套 verify 裡，第 12 站的 `TableOwnershipTest` 抓到 —— 那是 shared 模組的表。
> - **E5 的第一版，第 03 章的流程有 21 張 500**（4.10.3）：我抄它的時候漏了訂單編號撞號的重試迴圈。
> - **E3 的第一版，「A 重新起來 18 ms」**（4.8.3）：上一個 A 還活著，新的行程綁不到埠、自己死掉，readiness 卻由舊的那一個回 200 —— 後面兩段實驗跑在舊的行程上。`OrderNode` 改成先關掉舊的、等埠空出來。
> - **T3 把同一張訂單的明細讀了兩次**（4.5.4）：寫 E5 的時候看到。
>
> **小坑**：
>
> - `Process.destroyForcibly()` 在 Unix 上就是 SIGKILL；`context.close()` 不是當機 —— 它會等進行中的請求、跑完 finally（4.2.1）。
> - MySQL 8.0.29 起 `xa_detach_on_prepare` 預設打開：PREPARE 之後的分支跟連線脫鉤，連線斷了它還在、鎖也還在（4.3.3）。
> - `DROP CHECK` 與 `ADD … NOT ENFORCED` 寫在同一句、`ALGORITHM=INSTANT` 是可以的；之後 `ALTER CHECK … ENFORCED` 又是整表複製（4.5.6）。
> - 兩台訂單服務讀的是同一個 outbox：關掉一台的 relay，它的事件照樣被另一台送出（4.8.3）。
>
> **這一章沒有達成、或只達成一部分的目標**：
>
> - **熱點閘門的那一個洞沒有修**（4.2.2、4.5.2）：閘門扣了之後、訂單寫下之前當掉，那一件只有熱點對帳收得回來。（📌 追記：量了它多久被補回來 —— 安靜的時候一兩分鐘，搶購進行中一次都不修；仍然不修，理由在 4.2.2。）（📌 第 09 章寫完之後的再追記：告警補了，第 07 章 7.9.5。）
> - **訂單狀態的 CHECK 放掉了**（4.5.6）：狀態的值只靠程式守；改回 `ENFORCED` 是另一次停機維護。
> - **新舊版本並存沒有真的跑過**：線上那一版的訂單服務（v1）配這一章的庫存服務，只驗證了契約（Pact）與推論（4.6.4 的「做兩次也是一次」）。（📌 追記：can-i-deploy 現在說得出它為什麼不行 —— 第 03 章 3.8.6。）（📌 第 09 章寫完之後的再追記：部署的順序在第 09 章 9.5.8 走了一次 —— 仍然只有契約，兩版的程式沒有同時跑。）
> - **`checkShippable` 放在交易外是推論**（4.6.3）：靠兩個有測試的性質，沒有寫成交錯的測試。（📌 追記：寫成了交錯的測試，推論只對了一半 —— 4.6.3。）
> - **預留仍然是同步的**：庫存服務掛了，下單一樣不能用；預留在下單的路徑上最壞仍要等兩個 read timeout（6 秒）—— 只是不再佔著交易（第 06 章）。
> - **告警的門檻沒有設**：`shop.orders.rejected{reason=PLACEMENT_EXPIRED}`、`shop.inventory.consume.conflict` 只有指標（4.9）。（📌 第 09 章寫完之後的追記：設了，兩條都是 ticket —— 第 07 章 7.9.5。）
> - **熱點旗標仍然沒有搬**：`catalog → setHot` 是 B1 上剩下的那一個交易內呼叫（4.10.4）。（📌 追記：留給第 05 章 —— 旗標搬進庫存之後，「下單時哪些品項是熱點」就是一次跨服務的查詢，4.14。）（📌 再追記：第 05 章 5.7 搬了。）
> - **E5 的吞吐那幾格**：load 4.5～11，三次的範圍重疊得不少，只能說方向（4.10.3）。
> - **Seata 這類框架只有討論**（4.3.4）。
>
> **📌 第 04 章寫完之後的追記**（開始第 05 章之前補的；程式碼接在這一章的分支後面，4.11.2）：
>
> - **4.6.3 的推論只對了一半**：「問完之後，只有取消能讓答案變回去」是對的；但 `ship()` 只在讀到 `PICKING` 時才問 —— 讀到 `PAID`、轉移之前撿貨開始了，出貨就沒有問過庫存。交錯的測試重現了：一張熱點還沒落帳的訂單出貨成功，落帳時發現不夠，訂單已出貨、那一件的預留已釋放。改成「只有再也走不到 `SHIPPED` 的狀態才不問」（4.6.3 的追記）。
> - **熱點閘門的洞，量了**（4.2.2 的追記，E8）：熱點對帳打開之後，安靜的時候 107 秒補回來；搶購進行中一次都不修，停下來之後 79～80 秒。仍然不修，理由在那裡；要補的是告警。
> - **第 02 章的六個情境，在 Saga 上重跑**（4.10.6，E7）：全部收斂，S3'、S4' 不再卡住，對帳 0 張。
> - **第 00 章的四個代價，在真的線上重跑**（4.10.7，E9）：孤兒預留 0、庫存服務慢 3 秒時「我的訂單」不受影響；切開的延遲反而比第 00 章更貴；traceId 仍然斷在收的那一邊。
> - **事件的契約、Pact Broker、can-i-deploy**（第 03 章 3.8.6 的追記）：事件也有了契約；broker 補上「線上那一版」之後，can-i-deploy 說這一章的兩個服務**哪一個都不能先上** —— 一個要新的端點、另一個要新的事件，互為對方的提供端。部署的順序是第 09 章的事。（📌 第 09 章寫完之後的再追記：部署的順序，第 09 章 9.5.8。）
> - **trigger 的代價**（第 02 章 2.8.4 ④ 的追記）：多量幾輪之後是 0～4%，比輪與輪之間的雜訊小得多。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 說出第 03 章的線在「行程當掉」時留下什麼 —— 不是例外、不是逾時，是 `kill -9` —— 而且用兩台訂單服務的實驗量出來；說出為什麼 catch 裡的補償不是補償（4.2）。
- 說出兩階段提交怎麼運作、它的代價（延遲、吞吐、鎖握多久），以及協調者在 PREPARE 之後當掉時，誰來收尾；說出它為什麼在服務之間幾乎不成立（4.3）。
- 用「可補償、樞紐、可重試」三種步驟拆一個 Saga；說出編排與協同的差別，以及這個系統的 6 種切斷的交易各該用哪一種（4.4）。
- 把下單改成編排的 Saga：訂單先以什麼狀態存在（語意鎖）、樞紐在哪裡、同一個冪等鍵重送時接著做哪一張、卡在中間的由誰補償；說出新狀態的代價 —— 包括一個不能在線上跑的 migration（4.5）。
- 把付款、取消、出貨、逾時改成協同：庫存模組收訂單的事件；說出事件亂序時，每一步為什麼還能收斂；說出出貨為什麼要在之前先問一次（4.6）。
- 寫補償，並且處理「補償比動作先到」；列出這個系統裡補償不回來的操作（4.7）。
- 讓卡在中間的訂單被看見：一支給值班的人用的 API、一個指標、對帳在 Saga 裡的位置（4.9）。

---

## 4.2 先看見痛：訂單服務在最壞的時刻當掉 ★★★

第 02 章 2.5.3 量過「切斷的交易，第二半失敗了」：庫存服務已經 commit，訂單服務的交易接著 rollback。那裡的失敗是一個 trigger —— 寫訂單狀態歷史的那一句被拒絕，訂單服務**還活著**：例外往外丟、catch 一層一層執行、補償的程式碼照跑。

真的出事的時候，常常不是這樣。部署換版本、機器被回收、OOM killer、有人按了重開 —— 行程直接不見了。這一節用這一種失敗：訂單服務有兩台（A、B，就像正式環境一樣），A 在「庫存服務已經 commit、自己還沒 commit」的那一刻被 `kill -9`。程式碼是第 03 章的 —— 這個實驗是 `d04` 的第一個 commit，`src/main` 還沒有動。

### 4.2.0 開分支

```bash
git switch -c d04            # 從 d03
```

### 4.2.1 實驗怎麼做（E1）

第 03 章的支架（`Roles`：正式的角色、誠實的兩個庫），多兩樣東西，都在 `src/test/java/com/example/shop/dist04/`：

| 工具 | 做什麼 |
|---|---|
| `OrderNode` | 一台訂單服務，在**另一個 JVM** 裡（同一個 classpath、同一份 `Roles` 的參數，只多一個固定的埠）。`kill()` 是 `Process.destroyForcibly()` —— 在 Unix 上就是 SIGKILL |
| `CrashPoint` | 庫存服務上的一個 filter：被「布置」的請求照常處理、commit，**回應送出之前**先執行一個動作（kill -9 呼叫端的 JVM），再把回應寫到一條已經斷掉的連線上 |

為什麼要另一個 JVM：一個 Spring context 的 `close()` 不是當掉 —— 它會等進行中的請求做完、跑完 finally 與 catch。`kill -9` 之後什麼都不會再執行：

```java
    /** kill -9：Process.destroyForcibly() 在 Unix 上送的是 SIGKILL。等到行程真的不見 */
    public void kill() throws Exception {
        process.destroyForcibly();
        if (!process.waitFor(10, TimeUnit.SECONDS)) throw new IllegalStateException(name + " 殺不掉");
    }
```

`CrashPoint` 跟第 03 章的 `LostResponse` 是同一個做法（先做完、回應先收著），差在「之後做什麼」—— 那裡是等，這裡是殺：

```java
                ContentCachingResponseWrapper held = new ContentCachingResponseWrapper(res);
                chain.doFilter(req, held);                                   // controller 執行完、庫存服務的交易 commit 了
                HITS.add(new Hit(req.getMethod(), req.getRequestURI(), held.getStatus()));
                if (arm.hold() == null) {
                    try {
                        arm.action().run();                                  // kill -9 呼叫端
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                }
                try { held.copyBodyToResponse(); } catch (IOException gone) { /* 呼叫端已經不在了 */ }
```

（`hold` 那一段是 4.8.3 才用到的。）

從兩邊看，殺掉的那一刻：庫存服務做完了、commit 了；訂單服務在等回應，行程就不見了 —— 它的交易沒有 commit（MySQL 在連線斷掉時 rollback），catch 裡的程式一行都沒跑。

```bash
mvn test -Pexperiments -Dtest=E1CrashTest
```

```
═══ 4.2 訂單服務兩台（A、B）；A 在「庫存服務 commit 之後、自己 commit 之前」被 kill -9（load { 4.84 4.19 4.20 }）═══
  ⓪ 下單（熱點商品）：Redis 的閘門扣了 1 件之後，A 被 kill -9
     買家送到 A → 連線斷了：IOException（HTTP/1.1 header parser received no bytes）
     那一刻：這位買家的訂單 0 張；冪等鍵 （沒有）；這個商品的預留 0 筆；閘門 Redis 9999999、MySQL 算出來 10000000
     買家用同一個鍵重送，到了 B → 201 {"orderNo":"20261015-850860","status":"PENDING_PAYMENT","totalAmount":100.00,"createdAt":"2026-10-15T06:26:13.876Z","paymentDeadline":"2026-10-15T06:41:13.876Z"…
     之後：這位買家的訂單 1 張；預留 1 筆；閘門 Redis 9999998、MySQL 算出來 9999999
  ① 下單：庫存服務的預留 commit 之後，A 被 kill -9（A 重新起來花了 6,037 ms）
     買家送到 A → 連線斷了：IOException（HTTP/1.1 header parser received no bytes）
     那一刻：這位買家的訂單 0 張；冪等鍵 PROCESSING（租約還有 29.9 秒）；商品 9000002 的 reserved +1；沒有訂單的預留 1 筆
     買家用同一個鍵重送，到了 B → 409 {"type":"/problems/idempotency-in-progress","title":"相同的請求正在處理中","status":409,"detail":"相同的下單請求正在處理中","instance":"/api/orders","traceId":"6ad0720db51d8062164ac6…
     每 5 秒重送一次：0.0 秒 409、5.1 秒 409、10.1 秒 409、15.1 秒 409、20.2 秒 409、25.2 秒 409、30.3 秒 201
     之後：這位買家的訂單 1 張；reserved +2（應該 +1）；沒有訂單的預留 1 筆（order_id 2）
  ② 逾時排程：A 重新起來（5,705 ms，逾時排程每 10 秒一輪）；訂單 20261015-456931 的付款期限改到過去
     A 的排程取消它 → 庫存服務 POST /internal/inventory/v1/reservations/4/release → 204、commit → A 被 kill -9
     那一刻：訂單 PENDING_PAYMENT；預留 RELEASED
     金流回呼到了 B（B 的逾時排程還沒輪到）→ 200；訂單 PAID；預留 RELEASED
     賣家撿貨 → 200；出貨 → 409 {"type":"/problems/invalid-state","title":"目前的狀態不允許這個動作","status":409,"detail":"這張訂單有商品庫存不足，即將取消，不能出貨","instance":"/api/seller/orders/20261015-456931/ship","tra…
     最後：訂單 PICKING；預留 RELEASED；付款 SUCCEEDED；退款單 0
  A 重新起來（5,481 ms），對帳的 grace 1 秒、每 10 秒一輪；等第一輪
     CROSS_RECONCILIATION X-1 預留還佔著，訂單不存在：訂單 2（null）的預留 [HELD] —— 已釋放
     CROSS_RECONCILIATION X-3 訂單還沒結束，預留已釋放或不存在：訂單 4（PICKING）的預留 [RELEASED]
     CROSS_RECONCILIATION 掃了 3 筆預留、3 張訂單（2 批，200 ms）：找到 2 張，釋放 1 張
     對帳之後：① 沒有訂單的預留 0 筆；② 訂單 PICKING、預留 RELEASED；⓪ 閘門 Redis 9999998、MySQL 算出來 9999999
  （結束時 load { 4.33 4.23 4.21 }）
```

同樣的實驗跑了兩次，兩次的每一個數字都一樣（只有 load、訂單編號、花了幾毫秒不同）。

### 4.2.2 ⓪ 熱點閘門扣了之後

第 12 站 6.5 的熱點下單，第一步是在 Redis 的閘門減掉 1 件（`POST /hot-gate`），在冪等鍵與下單交易之前 —— 搶不到的人完全不碰 MySQL。A 在這一步之後被殺：

- 那一刻，資料庫裡什麼都沒有：沒有訂單、沒有冪等鍵、沒有預留。
- 閘門少了 1 件：Redis 9,999,999，MySQL 算出來 10,000,000。
- 買家用同一個鍵重送，到了 B → 201，一切正常。之後：Redis 9,999,998、MySQL 9,999,999 —— **差的那一件一直在**。

第 03 章 `PlaceOrderService` 的這幾行，就是要處理「閘門過了、下單卻失敗了」：

```java
        inventory.gateHot(hot);                                             // 不夠 → 409；Redis 不能用 → 503
        try {
            PlacedOrder placed = placeGated(buyerId, idempotencyKey, lines, hot);
            // 9.8：第一版成功的下單一行日誌都沒有 —— 出事的時候，「這張訂單是哪一個請求建的」只能從 traceId 往回找
            if (!placed.replayed()) this.placed.increment();
            if (!placed.replayed()) log.info("ORDER_PLACED orderNo={} buyerId={} lines={} hot={}", placed.orderNo(), buyerId, lines.size(), hot.size());
            return placed;
        } catch (RuntimeException e) {
            // 第 06 章這裡多一個 catch (InsufficientStockException)：「那一個品項不加回去」（6.5.3）。7.6 之後熱點品項在交易裡只寫預留列（holdHot），
            // 這裡的 InsufficientStockException 只可能來自一般品項 —— 熱點品項一律加回。MySQL 說熱點不夠，是落帳（settleHot）的事
            inventory.returnHot(hot);
            throw e;
        }
```

**它只在行程還活著的時候才會執行。** 例外是一種失敗，行程不見了是另一種 —— catch 只處理得了第一種。

這一件要等熱點對帳（第 12 站 6.6：每分鐘一輪、連續兩輪看到才修）。這個實驗把庫存的排程關了，所以最後一行它還在。

> 📌 **第 04 章寫完之後的追記：把熱點對帳打開，量它多久補回來（E8）。** 4.5.2 說這一件的最後一道防線是熱點對帳，這個實驗卻把它關了。E8 把它打開 —— 第 12 站 6.6 的預設：每分鐘一輪，同一組不一致（Redis 的值／MySQL 算出來的值）**連續兩輪**都看到才修（搶購進行中，一張訂單在「Redis 已減、MySQL 還沒寫」的那幾毫秒裡，兩邊本來就不一樣）。兩種情況：
>
> - **① 安靜的時候**：A 在閘門之後被 kill -9，之後沒有人買這個商品。
> - **② 搶購進行中**：B 每秒收 10 張這個商品的訂單（開放式負載），A 在閘門之後被 kill -9；3 分鐘之後搶購停下來。
>
> 每秒看一次「MySQL 算出來的值 − Redis」（差）。正常的時候，差是還在路上的訂單（閘門扣了、預留還沒寫）；當掉的那一件會讓差一直多 1。
>
> ```bash
> mvn test -Pexperiments -Dtest=E8HotGateHoleTest
> ```
>
> ```
> ═══ 4.2.2 的追記：熱點閘門的洞，熱點對帳（每分鐘一輪、連續兩輪才修）多久補回來（load { 7.92 11.08 10.37 }）═══
>   ① 安靜的時候：A 在閘門扣了 1 件之後被 kill -9，之後沒有人買這個商品
>      買家送到 A → 連線斷了：IOException（HTTP/1.1 header parser received no bytes）
>      差（MySQL 算出來 − Redis），每 10 秒：0s:1 10s:1 20s:1 30s:1 40s:1 50s:1 60s:1 70s:1 80s:1 90s:1 100s:1
>      補回來：107 秒；shop.inventory.hot.drift +1
>   ② 搶購進行中：B 每秒收 10 張這個商品的訂單；A 在閘門扣了 1 件之後被 kill -9
>      A 重新起來（5,973 ms）
>      搶購進行中、還沒當掉：差每秒 0 1 1 0 0 1 0 0 0 0（還在路上的訂單）
>      買家送到 A → 連線斷了：IOException（HTTP/1.1 header parser received no bytes）
>      當掉之後 3 分鐘，差每 10 秒：10s:1 20s:1 30s:1 40s:2 50s:1 60s:1 70s:1 80s:1 90s:1 100s:2 110s:1 120s:1 130s:1 140s:1 150s:1 160s:2 170s:2 180s:1
>      這 3 分鐘裡差最小 1；shop.inventory.hot.drift +0；B 收了 2,119 張（失敗 0）
>      搶購停下來之後，差每 10 秒：0s:1 10s:1 20s:1 30s:1 40s:1 50s:1 60s:1 70s:1
>      補回來：停下來之後 80 秒（當掉之後 263 秒）；shop.inventory.hot.drift +1
>   （結束時 load { 2.84 6.16 8.29 }）
> ```
>
> 跑了兩次：
>
> | | 第 1 次 | 第 2 次（上面那一份） |
> |---|---|---|
> | ① 安靜的時候，補回來 | 107 秒 | 107 秒 |
> | ② 搶購進行中的 3 分鐘，差最小 / 修正次數 | 1 / 0 次 | 1 / 0 次 |
> | ② 搶購停下來之後，補回來 | 79 秒 | 80 秒 |
>
> - **安靜的時候，一到兩分鐘補回來。** 第一輪看到、第二輪再看到、修 —— 跟每分鐘一輪的節奏對得上。
> - **搶購進行中，一次都不修。** 每一輪看到的那一組數字都不一樣（一直有人在買），「連續兩輪看到同一組」永遠不成立。**這不只是這一個洞的事**：搶購進行中，熱點對帳不會修**任何**一種不一致 —— 第 12 站 6.6 用「連續兩輪」避免誤修還在路上的訂單，代價是在最需要它的時候它不動。而 `shop.inventory.hot.drift` 只在**修了**的時候加 1：搶購進行中的不一致，指標上看不到（第 07 章的告警要補這一個）。
> - **它的方向是少賣，不是超賣。** Redis 比 MySQL 低 1：最後那一件，閘門說賣完了、MySQL 還有。搶購結束之後一兩分鐘，它才被放出來 —— 那時候買家多半已經走了。MySQL 那一邊一件都不會多賣（第 12 站 7.6.3：落帳才是最後一道防線）。
>
> **決定：不修。** 修它要讓「閘門扣的那幾件」在 Redis 裡有一張有期限的票，綁著那一次請求：訂單寫下時把票收走，過期沒被收走的由庫存服務加回去。難的是最後一步 ——「票沒被收走」不代表訂單不存在（T1 可能只是慢、或還在重試），加回去之前要問訂單服務「這個請求有沒有變成一張訂單」：一支新的內部 API、一個新的跨服務呼叫、一張新的契約（3.8），換的是**每一次當掉在那幾毫秒裡、最多少賣那一個請求的件數、一兩分鐘**。這個代價量過了，記在這一章開頭的清單裡；要改的是告警（上面第二點），不是閘門。

### 4.2.3 ① 預留 commit 之後：重送要等 30 秒，最後留下一筆孤兒

A 送出 `PUT /reservations/{orderId}`，庫存服務預留、commit，A 被殺。那一刻：

- 這位買家的訂單 0 張 —— 下單交易沒有 commit。
- **冪等鍵 `PROCESSING`，租約還有 29.9 秒**（第 12 站 4.5.1：`claim()` 是自己的短交易，早就 commit 了；把它刪掉的 `release()` 在 catch 裡，沒有跑）。
- 商品的 `reserved` +1，沒有訂單的預留 1 筆。

買家看到的是連線斷掉，再按一次。負載平衡器把它送到 B：**409「相同的下單請求正在處理中」**。B 說得沒錯 —— 從資料庫看，那個鍵確實還有人在處理；它不知道處理的人已經死了。每 5 秒再按一次：409、409、409……直到第 30.3 秒租約過期，B 接手（第 12 站 4.5.1 的「租約過期：前一個處理者死掉了」）→ 201。

之後：訂單 1 張，`reserved` **+2**，其中 1 筆的訂單（id 2）不存在 —— 第 00 章 0.2.2 ② 的孤兒，第 03 章 3.5.6 說「這一章修不好的那一種」。這一次它的來源不是兩次逾時，是一次 `kill -9`。

### 4.2.4 ② 逾時釋放之後，付款先到：一張永遠出不了貨的訂單

A 重新起來（逾時排程每 10 秒一輪）。一張待付款的訂單，付款期限改到過去：

1. A 的排程取消它 → `POST /reservations/4/release` → 庫存服務釋放、commit → A 被殺。
2. 那一刻：訂單 `PENDING_PAYMENT`、預留 `RELEASED`。
3. 金流回呼到了 B。B 的逾時排程還沒輪到這張訂單（正式的設定每 30 秒一輪，而且排程不知道 A 剛剛死在半路）→ **200**：訂單 `PAID`。`confirm()` 只改 `HELD` 的預留，一列都沒改到，**也沒有錯誤**。
4. 賣家撿貨 → 200；出貨 → 409「這張訂單有商品庫存不足，即將取消，不能出貨」。

最後：訂單 `PICKING`、預留 `RELEASED`、付款 `SUCCEEDED`、退款單 0。跟第 03 章 3.2.4（沒有認證的請求釋放了別人的預留）同一個下場：**已付款、庫存已經不在、出不了貨、也不會被取消。** 第 02 章 2.5.3 的 S5 說「排程的下一輪會收斂」—— 前提是下一輪比付款先到。有兩台訂單服務的時候，這個前提不成立。

### 4.2.5 對帳看到什麼；三件事的共同點

A 重新起來，對帳的 grace 縮到 1 秒：

- **X-1**：訂單 2 不存在、預留 `HELD` → 釋放。① 的孤兒收掉了。
- **X-3**：訂單 4 撿貨中、預留已釋放 → 只告警（第 02 章 2.6.4：要不要重新預留、要不要取消一張已付款的訂單，是人的決定）。
- ⓪ 的閘門，跨服務的對帳看不到：它只比預留與訂單。

| | 第 03 章的程式碼假設了什麼 | 行程不見了的時候 |
|---|---|---|
| ⓪ | catch 會把閘門加回去 | 沒有 catch：閘門少一件，等熱點對帳 |
| ① | `release()` 會放掉冪等鍵 | 沒有 release：重送 409 三十秒；之後的那一次是新的訂單、新的預留 |
| ② | 「釋放」與「取消」是同一件事 | 兩個服務、兩個交易：釋放成立、取消不成立；中間進來的付款讓它卡死 |

三件事都是同一個形狀：**一件事的兩半，分在兩個交易裡；第二半靠「同一個行程接下來會做的事」完成** —— catch、finally、下一行程式碼、同一台機器的下一輪排程。行程在中間不見了，就沒有人做第二半。

這一章要的是另一種保證：**任何時候行程不見了，資料庫裡都有足夠的狀態，讓別人（另一台、重新起來的自己、排程）接手做完 —— 或者往回做掉。** 先看最直接的那個答案：讓兩個交易變成一個（4.3）。

---

## 4.3 分散式交易為什麼沒有 `@Transactional`：兩階段提交

4.2 的三件事，根源都是「一件事分在兩個交易裡」。最直接的想法：讓它們變回一個交易。兩個資料庫的交易要「一起 commit 或一起 rollback」，教科書的答案是**兩階段提交**（two-phase commit，2PC）；MySQL 支援它的標準介面（XA）。這一節真的把它做出來、量它。

### 4.3.1 兩階段提交怎麼走

多一個角色：**協調者**（transaction manager）。每一個資料庫是一個**參與者**。

1. 協調者在每一個參與者開一個分支（`XA START`），照常做事（`INSERT`、`UPDATE`），結束（`XA END`）。
2. **第一階段**：協調者問每一個參與者「你 commit 得了嗎？」（`XA PREPARE`）。參與者把這個分支**寫到磁碟上**（之後就算機器重開，它也還在），而且**繼續握著它的鎖** —— 從這一刻起，它不能自己決定 rollback，只能等協調者。
3. **第二階段**：每一個參與者都說「可以」，協調者決定 commit（`XA COMMIT`）；有一個說「不行」，決定 rollback（`XA ROLLBACK`）。

E2 把它寫成一張訂單：訂單服務的庫 `INSERT orders`、庫存服務的庫 `UPDATE inventory` + `INSERT inventory_reservations`。兩條連線、兩個交易 —— 跟兩台機器的協定一模一樣，只是兩個庫剛好在同一台 MySQL 上：

```java
    /** 一張訂單、一個品項。LOCAL：庫存那一邊先 commit、訂單那一邊後 commit（第 03 章的順序）；XA：兩邊都 PREPARE 了才 COMMIT */
    static void place(Mode m, Connection o, Connection i, long product) throws SQLException {
        String gtrid = "e2-" + SEQ.incrementAndGet();
        if (m == Mode.XA) { exec(o, "XA START '" + gtrid + "','o'"); exec(i, "XA START '" + gtrid + "','i'"); }
        long orderId = insertOrder(o);
        reserve(i, orderId, product);
        if (m == Mode.XA) {
            exec(o, "XA END '" + gtrid + "','o'");
            exec(i, "XA END '" + gtrid + "','i'");
            exec(i, "XA PREPARE '" + gtrid + "','i'");                     // 第一階段：兩邊都說「我做得到」
            exec(o, "XA PREPARE '" + gtrid + "','o'");
            exec(i, "XA COMMIT '" + gtrid + "','i'");                      // 第二階段：協調者決定 commit
            exec(o, "XA COMMIT '" + gtrid + "','o'");
        } else {
            i.commit();
            o.commit();
        }
    }
```

（`LOCAL` 是第 03 章的下單：預留在庫存服務 commit、訂單在訂單服務 commit —— 兩個本地交易，各自 commit。）

**這裡的「協調者」就是這個測試自己：它直接連兩個庫。** 在拆開的部署裡，這件事本身就不成立：訂單服務連不到庫存服務的庫（第 02 章 2.4.4）。這一節先假裝它成立，量它的代價。

### 4.3.2 量：多花多少

```bash
mvn test -Pexperiments -Dtest=E2TwoPhaseCommitTest
```

```
═══ 4.3 ① 兩個本地交易 vs XA 兩階段提交：一張訂單（load { 3.74 5.86 6.55 }）═══
  單筆（3 輪 × 300 張、交錯）│ 兩個本地交易 p50   2.56 ms p99   9.39 ms │ XA p50   5.36 ms p99  19.76 ms
  16 條執行緒、每格 4 秒 × 3 輪（隨機的 1,000 個商品）│ 兩個本地交易 每秒 1,886 / 1,938 / 1,807 張 │ XA 每秒 790 / 629 / 764 張
  16 條執行緒、每格 4 秒 × 3 輪（全部買同一個商品）│ 兩個本地交易 每秒 634 / 612 / 586 張 │ XA 每秒 217 / 239 / 250 張
  （結束時 load { 6.31 6.28 6.67 }）
```

| | 兩個本地交易 | XA |
|---|---|---|
| 單筆 p50 | 2.56 ms | 5.36 ms（2.1 倍） |
| 16 條執行緒，隨機商品 | 每秒 1,807～1,938 張 | 每秒 629～790 張 |
| 16 條執行緒，同一個商品 | 每秒 586～634 張 | 每秒 217～250 張 |

這個實驗一共跑了三次（另外兩次：單筆 3.00 vs 6.81 ms、2.59 vs 6.01 ms；吞吐都是三分之一左右），方向一樣、大小差不多。

多出來的時間從哪裡來：

- **多四次往返**：`XA END` 兩次、`XA PREPARE` 兩次。
- **多兩次寫磁碟**：`PREPARE` 要把分支寫到磁碟上才能回答「可以」—— compose 的 MySQL 是 `innodb_flush_log_at_trx_commit = 1`、`sync_binlog = 1`（MySQL 8 的預設），每一次 PREPARE、每一次 COMMIT 都要 fsync。兩個本地交易只有兩次 COMMIT。
- **鎖握得更久**：`UPDATE inventory` 拿到那一列的鎖，一直握到第二階段的 `XA COMMIT` —— 中間隔著兩個 PREPARE 的 fsync。同一個商品的那一列，同一時間只有一個交易拿得到，握得越久，每秒能過的就越少。

### 4.3.3 量：協調者在 PREPARE 之後當掉

兩個分支都 PREPARE 了，協調者在決定之前不見了（兩條連線關掉 —— MySQL 8.0.29 起 `xa_detach_on_prepare` 預設打開，準備好的分支跟連線脫鉤，連線斷了它也還在）：

```
═══ 4.3 ② 協調者在 PREPARE 之後當掉（load { 6.31 6.28 6.67 }）═══
  協調者：兩個分支都 PREPARE 了（訂單 43623、商品 9000501 預留 1 件）；決定 commit 之前，協調者不見了（兩條連線關掉）
  XA RECOVER（任何一條連線都看得到，整台 MySQL 的）：[e2-crash,o, e2-crash,i]
  另一個 session 一般地讀：訂單 43623 不存在；商品 9000501 reserved = 30（還是準備之前的值）
  鎖（performance_schema.data_locks，這個商品那一列）：inventory X,REC_NOT_GAP GRANTED
  下一位買家預留同一個商品（innodb_lock_wait_timeout 改成 5 秒；預設是 50 秒）→ 5,016 ms 後：ERROR 1205 Lock wait timeout exceeded; try restarting transaction
  可售量的加鎖讀（FOR SHARE）→ 5,010 ms 後：ERROR 1205 Lock wait timeout exceeded; try restarting transaction
  協調者重新起來，照它記下的決定 commit 了訂單那一邊；還沒 commit 庫存那一邊，又當掉了。XA RECOVER：[e2-crash,i]
  值班的人只看到「一個卡住的交易，鎖著熱門商品」，XA ROLLBACK 它。XA RECOVER：（沒有）
  最後：訂單 43623 存在（PENDING_PAYMENT）；它的預留 0 筆；商品 9000501 reserved = 30 —— 兩階段提交保證的那一件事（全有或全無），被一個人工的決定打破了
  （結束時 load { 5.65 6.14 6.61 }）
```

逐行讀：

- **`XA RECOVER` 列出兩個分支**：它們在等。MySQL 重開也一樣在 —— PREPARE 就是「寫到磁碟上了」（這一個沒有量：compose 的 MySQL 是所有實驗共用的，不重開它）。
- **別的連線讀不到訂單、`reserved` 還是準備之前的值**：一般的讀（一致性讀）看的是已經 commit 的版本。
- **那一列的 X 鎖還在**（`performance_schema.data_locks`：`X,REC_NOT_GAP GRANTED`）：下一位買家預留同一個商品，等了 5 秒、`ERROR 1205`。這裡把 `innodb_lock_wait_timeout` 改成 5 秒，預設是 50 秒；而且等完不會有結果 —— 鎖要一直握到有人決定。**連可售量的加鎖讀（`FOR SHARE`）都要等。** 熱門商品被一個沒有人管的交易鎖住，整個搶購停在那裡。
- **收尾只做了一半**：協調者其實記下了「commit」，也 commit 了訂單那一邊，才又當掉；值班的人只看到「一個卡住的交易，鎖著熱門商品」，`XA ROLLBACK` 它。結果：**訂單存在、預留 0 筆** —— 兩階段提交唯一保證的那件事（全有或全無），被一個人工的決定打破了。

正式的交易管理器會把它的決定寫在自己的日誌裡，重新起來之後照著做完 —— 但在它重新起來之前，鎖就一直握著。**2PC 不是讓失敗消失，是把失敗變成「等」：每一個參與者，都要等那個最慢、最後一個恢復的協調者。**

### 4.3.4 為什麼幾乎沒有人在服務之間用它

| 前提 | 在這個系統裡 |
|---|---|
| 協調者要能對每一個參與者說 PREPARE、COMMIT | 訂單服務連不到庫存服務的庫（第 02 章 2.4.4）。要嘛違反「每個服務只連自己的庫」，要嘛每一個服務自己實作 prepare / commit 的 API —— HTTP 沒有這兩個動詞 |
| 參與者在 PREPARE 之後可以一直等 | 4.3.3：一直等 = 一直鎖著。參與者的可用性綁在協調者身上 —— 這正是拆服務想擺脫的 |
| 每一步都在資料庫裡 | 熱點閘門在 Redis、事件在 RabbitMQ、寄信、金流 —— 一個都不在 XA 裡 |
| 延遲與吞吐付得起 | 4.3.2：單筆 2 倍、吞吐三分之一，熱門商品更明顯 |

所以 2PC 留在它擅長的地方：**一個資料庫系統的內部**。MySQL 自己就用兩階段提交讓 binlog 與 InnoDB 的 redo log 一致 —— 同一個行程、同一台機器、毫秒等級、沒有別人要等。

框架呢？Seata 這類「分散式交易框架」的 AT 模式不是資料庫的 XA：它在每一個服務的本地交易旁邊記一份 undo log，失敗時由框架自動執行反向的 SQL，再加一把「全域鎖」擋住別人在中間改同一列。換句話說，**它是框架代你寫的補償**，加上一個中央的協調者與它自己的鎖。這一章沒有實作它；它的取捨跟 4.4 之後的手寫 Saga 是同一組問題，只是決定權在框架手上。

**這一章的答案是放棄「一個交易」**：每一步是一個服務自己的本地交易，失敗了不靠 rollback，靠往前做完、或往回做一件事把它抵銷。這就是 Saga。

---

## 4.4 Saga：編排與協同

### 4.4.1 一串本地交易，加上補償

Saga 把一個跨服務的動作拆成一串步驟，**每一步是一個服務自己的本地交易**，各自 commit。沒有一個交易從頭包到尾，所以也沒有「一起 rollback」—— 後面的步驟失敗了，前面已經 commit 的，用一個**補償**（compensating transaction）抵銷：預留過的，釋放；扣過的錢，退款。

這跟 4.2 的第 03 章程式碼差在哪裡？第 03 章也是兩個交易，問題是**第二半靠同一個行程接下來會做的事**。Saga 要求的是：

1. 每一步做完，**下一步要做什麼，已經寫在資料庫裡了** —— 跟這一步的 commit 在同一個交易（訂單的狀態、outbox 的一則事件）。行程在任何兩步之間不見了，別人讀資料庫就知道該接著做什麼。
2. 每一步都可以**安全地再做一次**（第 03 章 3.5 的冪等：協調者重送一步，不會做兩次；第 02 章 2.5.3：「重做同一件事會收斂」）。
3. 每一個「之後可能要往回走」的步驟，都有寫好的補償，而且補償本身也要能再做一次。

### 4.4.2 三種步驟：可補償、樞紐、可重試

不是每一步都要有補償。把一個 Saga 的步驟分成三種：

| 種類 | 意思 | 失敗了怎麼辦 |
|---|---|---|
| **可補償**（compensatable） | 後面還可能失敗；做了之後，可以用另一個動作抵銷 | 後面失敗 → 執行它的補償 |
| **樞紐**（pivot） | 做與不做的分界：它成功了，整件事就一定要做完 | 它自己失敗 → 往回補償前面的；它成功 → 只能往前 |
| **可重試**（retriable） | 樞紐之後的步驟：**不會被拒絕**，只會暫時失敗 | 重試到成功為止 |

設計的時候，**會被拒絕的步驟要放在樞紐之前或就是樞紐**；樞紐之後，只放不會被拒絕的。還有一種步驟兩邊都不能放：**補償不回來的**（4.7.3）—— 寄出去的信、出了門的貨。它們只能在最後，或者在一個「先問過、確定不會被拒絕」之後。

拿下單來看：訂單寫下（可補償：作廢它）→ **預留**（樞紐：庫存不足就是「不」）→ 待付款、清購物車、通知（可重試：都不會被拒絕）。

### 4.4.3 編排 vs 協同

步驟之間由誰串起來，有兩種做法：

| | 編排（orchestration） | 協同（choreography） |
|---|---|---|
| 誰決定下一步 | 一個協調者（某一個服務裡的一段程式）：呼叫這一步、看結果、決定下一步或補償 | 沒有協調者：每一個服務收到事件，做自己的那一步，再發自己的事件 |
| 一個 Saga 走到哪裡了 | 協調者那裡有答案（例如訂單的狀態） | 要去每一個服務看 |
| 需要另一邊的回答嗎 | 適合：協調者等回答、決定往哪走 | 不適合：發事件的人不等任何人 |
| 耦合 | 協調者知道每一步、每一個參與者 | 每一個服務只知道「我聽什麼、我發什麼」—— 但整個流程散在各處，沒有一個地方寫著 |
| 新增一步 | 改協調者 | 加一個消費者（別人不用改） |

第 03 章 3.3.1 的四個問題，正好可以拿來選：**呼叫端回應使用者之前，需不需要這個答案？另一邊會不會拒絕？** 需要、會 → 編排（同步問、拿到答案才往下走）；不需要、不會 → 協同（發一個事件就夠了）。

### 4.4.4 六種切斷的交易，各用哪一種

第 03 章 3.9.2 的 B1 列出庫存這一刀切斷的 6 種交易（建立商品在第 02 章 2.7 已經改成事件）。逐一套上去：

| 交易 | 庫存那一步 | 會被拒絕嗎 | 使用者要等這個答案嗎 | 這一章 |
|---|---|---|---|---|
| 下單 | 預留 | **會**（庫存不足） | **要**（201 還是 409） | **編排**：訂單服務是協調者（4.5） |
| 金流回呼 | 確認預留（HELD → CONFIRMED） | 不會 | 不要（金流只要 200） | **協同**：庫存模組收 `order.paid`（4.6） |
| 買家取消 | 釋放 | 不會 | 不要 | **協同**：`order.cancelled` |
| 賣家取消 | 釋放 | 不會 | 不要 | 同上 |
| 逾時取消 | 釋放 | 不會 | 沒有使用者 | 同上 |
| 出貨 | 出庫 | **會**（第 12 站 7.6.4：還在落帳 503、即將取消 409） | 賣家要知道能不能出 | **協同**，但出貨之前**先問一次**（只讀）—— 出貨補償不回來（4.6.3） |

三種事件 —— `order.paid`、`order.cancelled`、`order.shipped` —— 第 12 站第 07 章就已經在訂單的交易裡寫進 outbox 了（通知要用），這一章只是讓庫存模組也聽它們。下單多一種：`order.rejected`（補償，4.7）。

**一條規則貫穿這兩種做法：訂單服務的任何一個交易裡，都不再有對庫存服務的寫入。** 第 01 章 1.6.7 那張「還在交易裡的 12 種跨模組呼叫」，庫存的那幾種（`reserve`、`confirm`、`consume`、`release`）這一章全部拿出來。

---

## 4.5 下單：編排的 Saga

### 4.5.1 訂單先以什麼狀態存在：語意鎖

第 03 章的下單是一個交易：訂單 INSERT → 預留（遠端）→ 歷史、冪等鍵、購物車、outbox → commit。拆成本地交易，第一個問題是**先做哪一邊**：

| 做法 | 怎麼走 | 卡在中間時，誰知道 |
|---|---|---|
| ① 先預留、再寫訂單 | 先跟庫存服務要一個 orderId 的預留，成功了再 INSERT 訂單 | 只有庫存服務知道：「有一筆預留，訂單呢？」—— 就是 4.2.3 的孤兒，只是變成常態。而且 orderId 要在訂單存在之前就決定（現在是 MySQL 的自動遞增） |
| ② 先寫訂單（一個特別的狀態）、再預留 | 訂單以「預留中」寫下、commit；預留成功 → 待付款；失敗 → 作廢 | 訂單服務知道：資料庫裡有一張「預留中」的訂單，它就是這個 Saga 的狀態 |
| ③ 不讓使用者等 | 先回 202「處理中」，客戶端之後再問結果 | 同 ②，但 API 變了：US-ORD-1 的 201 / 409 沒有了 |

這一章選 ②。那個特別的狀態叫 **`RESERVING`**，作廢叫 **`REJECTED`**：

```java
/**
 * 0.5.1 的六個狀態，加上 13 站 4.5 下單 Saga 的兩個：
 *   RESERVING —— 訂單寫下了、庫存還沒預留（語意鎖：這個狀態的訂單，除了 Saga 自己，誰都不能動它）
 *   REJECTED  —— 預留失敗（庫存不足），或卡在 RESERVING 太久被收掉
 * 這兩個是訂單服務內部的狀態：買家從來沒有拿到這張訂單的 201（拿到的是 409 或 503），所以查詢、對外的 API、報表都看不到它們（NOT_PLACED）。
 */
public enum OrderStatus {
    PENDING_PAYMENT, PAID, PICKING, SHIPPED, COMPLETED, CANCELLED, RESERVING, REJECTED;

    /** 還沒成立、也不會成立的訂單 */
    public static final Set<OrderStatus> NOT_PLACED = EnumSet.of(RESERVING, REJECTED);
}
```

`RESERVING` 是一個**語意鎖**（semantic lock）：資料庫沒有替它鎖任何東西，是**狀態機**規定「這個狀態的訂單，除了下單的 Saga 自己，誰都不能動它」—— 不能付款、不能取消、不能出貨（4.5.3）。它擋住的是 Saga 最常見的一種錯：**別人看到了一個做到一半的東西，還拿它去做別的事**（隔離性，ACID 的 I，是 Saga 沒有的那一個字母）。

③ 不是錯的 —— 搶購、要排隊的下單常常就是這樣做。這裡不選它，是因為它改了使用者的 API；這一章想讓使用者看不出拆分（4.5.6 會看到：就算不改 API，新狀態一樣會漏到好幾個地方）。

### 4.5.2 熱點閘門要不要搬進 `PUT /reservations`

第 03 章 3.4.7 留下的問題：熱點的閘門（Redis 減 1）現在是下單的第一步、在任何交易之前；要不要搬進庫存服務的預留裡，讓訂單服務不用知道哪些品項是熱點？

**不搬。** 閘門在最前面，是為了第 12 站 6.5 的前提：搶不到的人不碰 MySQL。②的做法裡，預留之前訂單已經寫下了 —— 閘門搬進預留，代表 2,000 個搶的人每一個都先在訂單服務的庫 INSERT 一張 `RESERVING`，其中 1,500 張接著變成 `REJECTED`。閘門要守的就是那 1,500 次寫入。

代價是 4.2.2 那一件：閘門扣了之後、訂單寫下之前，行程不見了，那一件沒有人加回去。這一章**沒有修它** —— 它在 Saga 的第一步之前，沒有任何狀態可以讓別人接手；最後一道防線是熱點對帳（第 12 站 6.6）。4.8.3 的演練會再看到它一次（📌 追記：它多久被補回來，量了 —— 4.2.2）。

閘門之後的那一刻起，扣掉的件數就屬於那張訂單了：訂單寫下時，記下哪幾個品項過了閘門（V27，`order_items.hot`）。Saga 走不完時，補償要知道 Redis 該加回哪幾件 —— 那個決定只在當時的請求裡，要跟訂單一起寫下來：

```sql
-- 13 站 4.5：這一個品項有沒有過熱點閘門。Saga 的補償（REJECTED）要知道 Redis 要加回哪幾件 —— 閘門在 Saga 的第一步之前就扣了，
-- 那個決定只在當時的請求裡，要跟訂單一起記下來。只改資料字典（ALGORITHM=INSTANT），一句 DDL（第 12 站 2.2.2 規則二）
ALTER TABLE order_items ADD COLUMN hot BOOLEAN NOT NULL DEFAULT FALSE, ALGORITHM=INSTANT;
```

### 4.5.3 狀態機：8 × 13

第 12 站 0.5.3 的轉移表多兩列（`RESERVING`、`REJECTED`）、三欄（E11 `RESERVED` 預留成功、E12 `RESERVE_FAILED` 庫存不足、E13 `PLACEMENT_EXPIRED` 卡太久）：

```java
    STOCK_SHORTAGE,   // E10 系統：熱點商品落帳時發現庫存不足（7.6.3）。訂單已經回了 201，現在才知道沒有貨
    RESERVED,         // E11 13 站 4.5 下單的 Saga：庫存服務預留成功 —— RESERVING → PENDING_PAYMENT
    RESERVE_FAILED,   // E12 同上：庫存不足（補償）—— RESERVING → REJECTED
    PLACEMENT_EXPIRED // E13 同上：卡在 RESERVING 太久（排程，補償）—— RESERVING → REJECTED
}
```

```java
            // ── 13 站 4.5：下單的 Saga ──
            case RESERVING -> switch (event) {
                case RESERVED -> Decision.to(PENDING_PAYMENT);           // 樞紐（pivot）過了：往前走到底
                case RESERVE_FAILED, PLACEMENT_EXPIRED -> Decision.to(REJECTED);   // 補償
                case PAY_SUCCEEDED -> Decision.REJECT;                   // 不會發生：建立付款要 PENDING_PAYMENT（US-ORD-2 AC-1）
                case PAY_FAILED -> Decision.SAME;
                case BUYER_CANCEL, SELLER_CANCEL, START_PICKING, SHIP, CONFIRM_RECEIPT -> Decision.REJECT;   // 語意鎖
                case PAYMENT_TIMEOUT, AUTO_COMPLETE, STOCK_SHORTAGE -> Decision.IGNORE;
            };
            case REJECTED -> switch (event) {
                case RESERVED -> Decision.REJECT;                        // 太晚了：補償已經開始（呼叫端回 503，請買家重送）
                case RESERVE_FAILED, PLACEMENT_EXPIRED, PAY_FAILED -> Decision.SAME;
                case PAY_SUCCEEDED -> Decision.REFUND;                   // 不會發生；萬一發生，錢要退（跟 CANCELLED 一樣）
                case BUYER_CANCEL, SELLER_CANCEL, START_PICKING, SHIP, CONFIRM_RECEIPT -> Decision.REJECT;
                case PAYMENT_TIMEOUT, AUTO_COMPLETE, STOCK_SHORTAGE -> Decision.IGNORE;
            };
        };
```

舊的六列，新的三欄幾乎都一樣：`RESERVED` 一律 ＝（Saga 已經往前走了，再走一次什麼都不改）；兩個補償一律 ·（預留成功的那一次贏了）。`OrderStateMachineTest` 的表照抄過去，一格一個測試，從 60 + 5 個變成 104 + 5 個：

```java
    static final String TABLE = """
            #                 E1       E2  E3             E4  E5             E6         E7          E8           E9           E10            E11               E12         E13
            PENDING_PAYMENT   →PAID    ＝   →CANCELLED     →CANCELLED ✗     ✗          ✗           ✗            ·            →CANCELLED     ＝                 ·           ·
            PAID              ＝/↺     ＝   →CANCELLED+R   ·   →CANCELLED+R   →PICKING   ✗           ✗            ·            →CANCELLED+R   ＝                 ·           ·
            PICKING           ＝/↺     ＝   ✗              ·   →CANCELLED+R   ＝          →SHIPPED    ✗            ·            →CANCELLED+R   ＝                 ·           ·
            SHIPPED           ＝/↺     ＝   ✗              ·   ✗              ✗          ＝/✗        →COMPLETED   →COMPLETED   ·              ＝                 ·           ·
            COMPLETED         ＝/↺     ＝   ✗              ·   ✗              ✗          ✗           ＝            ·            ·              ＝                 ·           ·
            CANCELLED         ↺        ＝   ＝              ·   ＝              ✗          ✗           ✗            ·            ＝              ＝                 ·           ·
            RESERVING         ✗        ＝   ✗              ·   ✗              ✗          ✗           ✗            ·            ·              →PENDING_PAYMENT   →REJECTED   →REJECTED
            REJECTED          ↺        ＝   ✗              ·   ✗              ✗          ✗           ✗            ·            ·              ✗                 ＝           ＝
            """;
```

兩個值得停下來看的格子：

- **`REJECTED` + E11 = ✗**。排程已經把一張卡住的訂單補償掉了，原本的那個請求（或買家的重送）才把預留做完、要 `RESERVED` —— 太晚了。補償已經發出 `order.rejected`，庫存模組會把那一筆預留釋放掉；這張訂單不能復活。呼叫端回 503「請再送一次」—— 冪等鍵在補償時已經放掉了，再送一次是一張新的訂單（4.5.4）。
- **`RESERVING` + E1 = ✗**。建立付款要求 `PENDING_PAYMENT`（第 12 站 US-ORD-2 AC-1），所以付款不會比預留先到；萬一到了，拒絕，金流會重送。

### 4.5.4 `PlaceOrderService`：協調者

第 12 站的下單交易，拆成三步。協調者就是 `PlaceOrderService` 自己：

```java
 * 13 站 4.5：② 拆成一個 Saga（這個類別是它的協調者）。每一步是一個服務自己的交易：
 *   T1 訂單服務：訂單以 RESERVING 寫下、明細（記下哪幾個品項過了熱點閘門）、狀態歷史、冪等鍵綁到這張訂單 —— commit
 *   T2 庫存服務：預留（以 orderId 冪等）—— 會拒絕（庫存不足），所以是這個 Saga 的樞紐（pivot）
 *   T3 訂單服務：RESERVED → PENDING_PAYMENT、清購物車、order.placed（OrderTransitionService）
 * T2 拒絕 → 補償：RESERVE_FAILED → REJECTED、放掉冪等鍵、order.rejected（庫存模組收到之後把閘門加回去）→ 409。
 * T2 不知道結果（兩次都沒有回應）→ 503，訂單留在 RESERVING：買家用同一個鍵重送 → 接著做這一張（advance）；
 * 沒有人重送 → 排程在 placement-timeout 之後補償（OrderJobs.expirePlacements）。
 * 一個交易都不跨服務。行程在任何兩步之間不見了，資料庫裡都有足夠的狀態讓別人接手 —— catch 不是補償（4.2）。
 */
```

**閘門、冪等鍵、T1。** T1 commit 之前的任何失敗，跟第 03 章一樣：放掉冪等鍵、這一次扣的閘門同步加回去。T1 commit 之後，扣的那幾件屬於那張訂單，失敗了由 Saga 的補償處理：

```java
    private PlacedOrder placeOrderGated(long buyerId, String idempotencyKey, List<OrderLine> lines) {
        validate(lines);
        Set<Long> hotIds = catalog.hotProducts(lines.stream().map(OrderLine::productId).toList());
        List<ReserveLine> hot = lines.stream().filter(l -> hotIds.contains(l.productId()))
                .map(l -> new ReserveLine(l.productId(), l.quantity())).toList();
        inventory.gateHot(hot);                                             // 不夠 → 409；Redis 不能用 → 503
        IdempotencyKeys.Claim claim;
        long orderId;
        try {
            claim = keys.claim(buyerId, idempotencyKey, hash(lines));
            if (claim instanceof IdempotencyKeys.InProgress)
                throw new ShopException(ProblemType.IDEMPOTENCY_IN_PROGRESS, "相同的下單請求正在處理中").with("retryAfter", 1);
            orderId = claim instanceof IdempotencyKeys.Existing e ? e.orderId() : reserving(buyerId, idempotencyKey, lines, hotIds);
        } catch (RuntimeException e) {
            // T1 還沒 commit：這一次扣的閘門不屬於任何一張訂單，在這裡加回去
            inventory.returnHot(hot);
            throw e;
        }
        if (claim instanceof IdempotencyKeys.Existing) inventory.returnHot(hot);   // 重送：那張訂單扣的是它自己的那一次，這一次扣的要還回去
        PlacedOrder placed = advance(orderId, claim instanceof IdempotencyKeys.Existing);
        // 9.8：第一版成功的下單一行日誌都沒有 —— 出事的時候，「這張訂單是哪一個請求建的」只能從 traceId 往回找
        if (!placed.replayed()) this.placed.increment();
        if (!placed.replayed()) log.info("ORDER_PLACED orderNo={} buyerId={} lines={} hot={}", placed.orderNo(), buyerId, lines.size(), hot.size());
        return placed;
    }
```

```java
    private long insertReserving(long buyerId, String key, List<OrderLine> lines, Set<Long> hotIds, Map<Long, ProductSnapshot> products) {
        List<Long> ids = lines.stream().map(OrderLine::productId).toList();
        Instant now = clock.instant();
        Order order = Order.place(OrderNumbers.next(now), buyerId, products.get(ids.get(0)).sellerId(), now, now.plus(paymentTimeout));
        for (OrderLine l : lines) {
            ProductSnapshot p = products.get(l.productId());
            order.addItem(p.id(), p.name(), p.price(), l.quantity(), hotIds.contains(l.productId()));   // 快照：下單當下的名稱與價格（1.5.5）
        }
        orders.saveAndFlush(order);                                         // IDENTITY：這裡就 INSERT 了，撞號也在這裡炸
        history.record(order.getId(), null, order.getStatus(), "PLACE_ORDER", OrderHistory.Actor.buyer(buyerId), now);
        keys.complete(buyerId, key, order.getId());                         // 13 站 4.5：鍵綁到 RESERVING 的訂單 —— 重送接著做這一張
        return order.getId();
    }
```

`keys.complete()` 在 T1 裡 —— **冪等鍵在預留之前就綁到那張訂單上了**。這是讓 4.2.3 消失的那一行：第 03 章的鍵要等整個下單 commit 才綁，中間行程不見了，鍵停在 `PROCESSING`、訂單不存在；現在鍵指著一張 `RESERVING` 的訂單，同一個鍵再送，就是「接著做那一張」。

**T2、T3：讓一張訂單往前走。** 第一次下單、同一個鍵的重送，都走這裡：

```java
    private PlacedOrder advance(long orderId, boolean replayed) {
        var cur = transitions.current(orderId);
        if (cur.status() == OrderStatus.RESERVING) {
            List<OrderTransitionService.Item> items = transitions.items(orderId);
            List<ReserveLine> normal = items.stream().filter(i -> !i.hot()).map(i -> new ReserveLine(i.productId(), i.quantity())).toList();
            List<ReserveLine> hotLines = items.stream().filter(OrderTransitionService.Item::hot).map(i -> new ReserveLine(i.productId(), i.quantity())).toList();
            try {
                inventory.reserve(orderId, normal, hotLines);               // T2（樞紐）
            } catch (InsufficientStockException e) {
                transitions.apply(orderId, OrderEvent.RESERVE_FAILED, OrderHistory.Actor.system(), OrderTransitionService.EventData.NONE);   // 補償
                throw e;
            } catch (ShopException e) {
                // 409 狀態不對：這張訂單的預留已經被補償掉了（排程先一步收了它，4.7.2）—— 不是買家的錯；再送一次是一次新的下單
                if (e.type() != ProblemType.INVALID_STATE) throw e;
                throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "下單沒有完成，請再送一次").with("retryAfter", 1);
            }
            // 兩次都沒有回應（503）、或其他錯誤：例外照樣往外丟，訂單留在 RESERVING —— 重送或排程接手
            OrderStatus now = applyReserved(orderId);                       // T3
            if (now != OrderStatus.PENDING_PAYMENT)
                throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "下單沒有完成，請再送一次").with("retryAfter", 1);
        } else if (cur.status() == OrderStatus.REJECTED) {
            // 讀到鍵的那一刻，訂單還在；之後被補償了（鍵也放掉了）。再送一次就是一次新的下單
            throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "下單沒有完成，請再送一次").with("retryAfter", 1);
        }
        return new PlacedOrder(orderId, cur.orderNo(), replayed);
    }
```

```java
    /** RESERVED。補償已經先發生了（REJECTED）→ 狀態機說 REJECT：不是使用者的錯，回 null 讓呼叫端回 503 */
    private OrderStatus applyReserved(long orderId) {
        try {
            return transitions.apply(orderId, OrderEvent.RESERVED, OrderHistory.Actor.system(), OrderTransitionService.EventData.NONE);
        } catch (ShopException e) {
            if (e.type() != ProblemType.INVALID_STATE) throw e;
            return null;
        }
    }
```

每一種結果：

| T2（預留）的結果 | 這一步 | 回給買家 | 留在資料庫裡的 |
|---|---|---|---|
| 成功 | T3：`RESERVED` → `PENDING_PAYMENT` | 201（重送：200） | 待付款的訂單、HELD 的預留 |
| 庫存不足（409） | `RESERVE_FAILED` → `REJECTED`、放掉鍵、`order.rejected` | 409 | 作廢的訂單（買家看不到）；庫存那一邊什麼都沒有 |
| 兩次都沒有回應（503）、其他錯誤 | 什麼都不做 | 503 / 500 | **`RESERVING`** 的訂單、綁著它的鍵；預留不知道有沒有 —— 重送或排程接手（4.5.5） |
| 409 狀態不對 | —— | 503「請再送一次」 | 這張訂單已經被補償了（4.7.2） |

**T3 與補償的那一個交易**，在 `OrderTransitionService` 裡 —— 跟所有的轉移一樣：條件式 UPDATE、副作用、歷史、outbox，同一個交易。改動的地方：

```diff
 package com.example.shop.ordering.internal;
 
-import com.example.shop.inventory.InventoryApi;
+import com.example.shop.cart.CartApi;
 import com.example.shop.ordering.OrderStatus;
 import com.example.shop.ordering.internal.OrderStateMachine.Decision;
 import com.example.shop.ordering.internal.OrderStateMachine.Kind;
…
  *   UPDATE orders SET status = :to, ..., version = version + 1 WHERE id = :id AND status = :from
  * 影響 0 列 = 狀態已經被別人改了 → 重新讀取，再問一次狀態機（最多 3 次）。
  * 同一個交易裡完成 0.5.4 表格左欄的所有副作用（預留、歷史、退款單），以及右欄的「記下這件事」（Outbox，第 07 章）。
+ *
+ * 13 站 4.6：左欄少了庫存。確認、釋放、出庫不再在這個交易裡呼叫 InventoryApi —— 庫存模組聽 order.paid、order.cancelled、order.shipped，
+ * 在它自己的交易裡做（協同）。這個交易裡只剩訂單服務自己的庫：訂單、歷史、退款單、購物車、冪等鍵、outbox。
  */
 @Service
 class OrderTransitionService {
…
     record Current(OrderStatus status, String trackingNo, long buyerId, long sellerId, String orderNo, BigDecimal totalAmount) {}
 
     private final JdbcTemplate jdbc;
-    private final InventoryApi inventory;
+    private final CartApi cart;
+    private final IdempotencyKeys keys;
     private final PaymentApi payments;
     private final OrderHistory history;
     private final Outbox outbox;
     private final Clock clock;
     private final io.micrometer.core.instrument.MeterRegistry meters;
 
-    OrderTransitionService(JdbcTemplate jdbc, InventoryApi inventory, PaymentApi payments, OrderHistory history, Outbox outbox, Clock clock,
-                           io.micrometer.core.instrument.MeterRegistry meters) {
+    OrderTransitionService(JdbcTemplate jdbc, CartApi cart, IdempotencyKeys keys, PaymentApi payments, OrderHistory history, Outbox outbox,
+                           Clock clock, io.micrometer.core.instrument.MeterRegistry meters) {
         this.jdbc = jdbc;
-        this.inventory = inventory;
+        this.cart = cart;
+        this.keys = keys;
         this.payments = payments;
         this.history = history;
         this.outbox = outbox;
…
                 case TRANSITION -> {
                     Instant now = clock.instant();
                     if (update(orderId, cur.status(), d.to(), event, data, now) == 1) {
-                        boolean refunded = sideEffects(orderId, cur, d, event);
+                        // 13 站 4.5：下單的 Saga 的兩個出口要用到明細（清購物車、order.placed 的熱點品項、order.rejected 的閘門）—— 讀一次
+                        List<Item> items = d.to() == OrderStatus.PENDING_PAYMENT || d.to() == OrderStatus.REJECTED ? items(orderId) : List.of();
+                        boolean refunded = sideEffects(orderId, cur, d, event, items);
                         history.record(orderId, cur.status(), d.to(), event.name(), actor, now);
-                        publish(orderId, cur, d.to(), event, data, refunded);
+                        publish(orderId, cur, d.to(), event, data, refunded, items);
                         if (d.to() == OrderStatus.CANCELLED) afterCommit(() -> meters.counter("shop.orders.cancelled", "reason", cancelReason(event, data)).increment());
+                        // 13 站 4.9：被補償掉的下單。reason=PLACEMENT_EXPIRED 變多 = Saga 停在中間的訂單變多（協調者當掉、庫存服務沒有回應）
+                        if (d.to() == OrderStatus.REJECTED) afterCommit(() -> meters.counter("shop.orders.rejected", "reason", event.name()).increment());
                         return d.to();
                     }
                     // 0 列：在我們讀取之後、更新之前，別人改了狀態（排程 vs 回呼，4.2.5）。重讀、重新決定
…
                     to.name(), t, t, orderId, from.name());
             case CANCELLED -> jdbc.update("UPDATE orders SET " + common + ", cancel_reason = ?, cancelled_at = ? WHERE id = ? AND status = ?",
                     to.name(), t, cancelReason(event, data), t, orderId, from.name());
-            case PENDING_PAYMENT -> throw new IllegalStateException("沒有任何轉移會回到 PENDING_PAYMENT");
+            // 13 站 4.5：只有 RESERVING 會到這兩個狀態
+            case PENDING_PAYMENT, REJECTED -> jdbc.update("UPDATE orders SET " + common + " WHERE id = ? AND status = ?",
+                    to.name(), t, orderId, from.name());
+            case RESERVING -> throw new IllegalStateException("沒有任何轉移會回到 RESERVING");
         };
     }
 
-    /** 0.5.4 表格的左欄：必須跟狀態一起 commit 的事 */
-    /** @return 有沒有建立退款單 */
-    private boolean sideEffects(long orderId, Current cur, Decision d, OrderEvent event) {
+    /**
+     * 0.5.4 表格的左欄：必須跟狀態一起 commit 的事。
+     * 13 站 4.6：PAID（預留確認）、SHIPPED（出庫）、CANCELLED（釋放）的庫存那一半，改成庫存模組收到這個交易發出的事件之後自己做。
+     * 13 站 4.5：PENDING_PAYMENT（下單的 Saga 往前走完）清購物車；REJECTED（補償）放掉冪等鍵。
+     * @return 有沒有建立退款單
+     */
+    private boolean sideEffects(long orderId, Current cur, Decision d, OrderEvent event, List<Item> items) {
         switch (d.to()) {
-            case PAID -> inventory.confirm(orderId);                        // HELD → CONFIRMED：從此不能被逾時釋放（US-ORD-3 AC-4）
-            case SHIPPED -> inventory.consume(orderId);                     // onHand、reserved 同時減少（US-ORD-6 AC-2）
+            case PENDING_PAYMENT -> cart.removeItems(cur.buyerId(), items.stream().map(Item::productId).toList());   // US-ORD-1 AC-4
+            case REJECTED -> keys.forget(orderId);                          // US-ORD-1a AC-4：失敗的結果不快取 —— 同一個鍵再送，是一次新的下單
             case CANCELLED -> {
-                inventory.release(orderId);
                 if (d.refund()) {
                     var pid = payments.succeededPaymentOf(orderId);
                     pid.ifPresent(p -> payments.requestRefund(p,           // E5 賣家取消、E10 庫存不足：都是「賣方」的原因（V6 的 ck_refunds_reason）
…
     }
 
     /** 0.5.4 表格的右欄：這次轉移之後要發生的事，記成一個事件（跟轉移一起 commit）。PICKING 沒有右欄 */
-    private void publish(long orderId, Current cur, OrderStatus to, OrderEvent event, EventData data, boolean refunded) {
+    private void publish(long orderId, Current cur, OrderStatus to, OrderEvent event, EventData data, boolean refunded, List<Item> items) {
+        if (to == OrderStatus.PENDING_PAYMENT) {                           // 13 站 4.5：第 12 站在下單交易裡寫的那一則（通知「訂單成立」、熱點落帳 7.6）
+            outbox.add("ORDER", orderId, EventTypes.ORDER_PLACED, Map.of("orderId", orderId, "orderNo", cur.orderNo(),
+                    "buyerId", cur.buyerId(), "sellerId", cur.sellerId(), "totalAmount", cur.totalAmount(),
+                    "hotProductIds", items.stream().filter(Item::hot).map(Item::productId).sorted().toList()));
+            return;
+        }
+        if (to == OrderStatus.REJECTED) {                                  // 13 站 4.7：補償交給庫存模組 —— 釋放（如果有預留）、熱點閘門加回去
+            outbox.add("ORDER", orderId, EventTypes.ORDER_REJECTED, Map.of("orderId", orderId, "orderNo", cur.orderNo(),
+                    "buyerId", cur.buyerId(), "event", event.name(),
+                    "hotLines", items.stream().filter(Item::hot).map(i -> Map.of("productId", i.productId(), "quantity", i.quantity())).toList()));
+            return;
+        }
         String type = switch (to) {
             case PAID -> EventTypes.ORDER_PAID;
             case CANCELLED -> EventTypes.ORDER_CANCELLED;
…
         outbox.add("ORDER", orderId, type, p);
     }
 
+    record Item(long productId, int quantity, boolean hot) {}
+
+    /** 這張訂單的品項（13 站 4.5：hot = 這一個品項過了熱點閘門） */
+    List<Item> items(long orderId) {
+        return jdbc.query("SELECT product_id, quantity, hot FROM order_items WHERE order_id = ? ORDER BY product_id",
+                (rs, i) -> new Item(rs.getLong(1), rs.getInt(2), rs.getBoolean(3)), orderId);
+    }
+
     private static String cancelReason(OrderEvent event, EventData data) {
         return switch (event) {
             case BUYER_CANCEL -> "BUYER";
```

- **左欄少了庫存**：`PAID` 不再 `confirm`、`SHIPPED` 不再 `consume`、`CANCELLED` 不再 `release` —— 那是 4.6 的事。
- **兩個新的出口**：`PENDING_PAYMENT`（往前走完）清購物車、寫 `order.placed`（第 12 站在下單交易裡寫的那一則，原封不動搬過來）；`REJECTED`（補償）放掉冪等鍵、寫 `order.rejected`（帶著過了閘門的那幾件）。
- 這兩個出口都要讀訂單的明細。第一版在 `sideEffects()` 與 `publish()` 各讀一次 —— 同一個交易裡同一句 SELECT 兩次；寫 4.10.3 的實驗時看到，改成讀一次。

`IdempotencyKeys` 多一個 `forget()`，跟 `REJECTED` 同一個交易：

```java
    /**
     * 13 站 4.5：下單的 Saga 走不完（REJECTED）—— 這張訂單的鍵放掉，跟 REJECTED 同一個交易。
     * 同一個鍵再送，是一次新的下單（AC-4：失敗的結果不快取）；鍵在 RESERVING 的時候還在，所以重送會接著把那一張做完（4.5.4）
     */
    @Transactional(propagation = Propagation.MANDATORY)
    void forget(long orderId) {
        jdbc.update("DELETE FROM idempotency_keys WHERE order_id = ?", orderId);
    }
```

**庫存那一邊：預留以 orderId 冪等，單體也一樣。** 第 03 章 3.5.2 的 `Inbox`（`processed_messages` 那一列是交易的第一句）原本在 `InventoryService` —— 只有 HTTP 的那一條路有。現在單體裡也會重送同一個 orderId（同一個鍵的重送接著做 `RESERVING` 的那一張），所以搬進 `JdbcInventoryService`：

```java
    /** 13 站 4.5：自己的交易（下單 Saga 的一步）。冪等：見 reserveOnce */
    @Override
    @Transactional
    public void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        reserveIdempotently(orderId, lines, hotLines);
    }
…
    private boolean reserveIdempotently(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        if (inbox.claim(RESERVE_KEY, Long.toString(orderId))) {
            reserveCounted(orderId, lines);
            if (!hotLines.isEmpty()) holdHot(orderId, hotLines);
            return false;
        }
        List<ReservationRef> have = reservationsOf(List.of(orderId)).getOrDefault(orderId, List.of());
        if (have.isEmpty() || have.stream().anyMatch(r -> r.status().equals("RELEASED")))
            throw new ShopException(ProblemType.INVALID_STATE, "訂單 " + orderId + " 的預留已經取消，不能再預留").with("orderId", orderId);   // 4.7.2
        Map<Long, Integer> asked = new TreeMap<>(), had = new TreeMap<>();
        lines.forEach(l -> asked.merge(l.productId(), l.quantity(), Integer::sum));
        hotLines.forEach(l -> asked.merge(l.productId(), l.quantity(), Integer::sum));
        have.forEach(r -> had.merge(r.productId(), r.quantity(), Integer::sum));
        if (!asked.equals(had))
            throw new ShopException(ProblemType.IDEMPOTENCY_KEY_REUSED, "訂單 " + orderId + " 已經用不同的內容預留過").with("orderId", orderId);
        return true;
    }
```

`RESERVE_KEY` 的值是第 03 章取的 `inventory.http.reserve`，名字裡的 `http` 已經不對了 —— 但不能改：

```java
    /**
     * 13 站 3.5：一張訂單的預留在 processed_messages 裡的那一列（consumer 欄）。名字是第 03 章取的（那時只有 HTTP 用它）：
     * 13 站 4.5 之後單體也用 —— 名字不改，改了的話，上線之前就預留過的訂單，重送時認不出來（uk_reservations_order_product 會擋下，變成 500）
     */
    static final String RESERVE_KEY = "inventory.http.reserve";
```

`InventoryApi.reserve` 也不再是 `MANDATORY`（它本來要跟呼叫端的交易一起 commit）。它是 Saga 的一步，自己一個交易：

```diff
     // product.created 消費者 —— 一個沒有別的模組在用的公開方法，切開之後就是一支沒有人該打、卻打得到的端點
 
     /**
-     * 為一張訂單預留庫存（每個品項一筆 HELD 預留）。全有或全無：任何一個品項不足就丟例外，呼叫端的交易應該 rollback。
+     * 為一張訂單預留庫存（每個品項一筆 HELD 預留）。全有或全無：任何一個品項不足就丟例外，這一次什麼都沒留下。
      * 內部會依 productId 排序後才加鎖（4.2.3：避免兩張訂單以相反的順序鎖同樣兩個商品而死鎖）。
-     * 必須在呼叫端既有的交易內呼叫（Propagation.MANDATORY）。
      *
      * hotLines：7.6 熱點商品的品項（已經過了 Redis 的閘門 gateHot）—— 只寫預留列（HELD、counted = FALSE），**不碰 inventory 那一列**，
      * 數量由 inventory.hot-settlement 消費者在 commit 之後計入 reserved（最終一致，0.6.4：60 秒）。
      * 13 站 3.4：第 12 站這是另一個方法 holdHot()。一張訂單同時有一般與熱點的品項時是兩次呼叫 —— 在一個行程裡無所謂；
      * 切開之後是兩次往返、兩個交易：第一個 commit 了、第二個失敗，第一個就留下沒有訂單的預留。合成一個：一張訂單的預留，一次、全有或全無
+     *
+     * 13 站 4.5：不再是 MANDATORY。它是下單 Saga 的一步：自己的交易、在訂單的交易之外呼叫，而且以 orderId 冪等 ——
+     * 同一張訂單再呼叫一次（協調者不知道上一次成功了沒有），內容一樣就什麼都不做；這張訂單的預留已經被補償掉了 → 409（4.7）。
      */
     void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines);
 
-    /** 付款成功：這張訂單的預留 HELD → CONFIRMED（不再能被逾時釋放）。數量不變，不記帳。MANDATORY。 */
-    void confirm(long orderId);
-
-    /** 取消：這張訂單的預留 → RELEASED，reserved 減回，每個品項一筆 RELEASE。已釋放的不重複釋放（冪等）。MANDATORY。 */
-    void release(long orderId);
+    // 13 站 4.6：confirm、release、consume 從這個介面拿掉了。付款、取消、出貨之後，庫存模組收 order.paid、order.cancelled、order.shipped，
+    // 自己在自己的交易裡做（InventoryEventHandlers.orderEvents）—— 沒有別的模組會再呼叫它們
 
     /**
-     * 出貨：CONFIRMED → CONSUMED，onHand 與 reserved 同時減少，每個品項一筆 SHIP。MANDATORY。
-     * 7.6.4：還沒計入 reserved 的熱點預留（落帳還沒完成）→ 503，稍後再出貨。
+     * 13 站 4.6.3：出貨之前問一次（只讀）—— 出貨是補償不回來的：貨出了門就收不回來。第 12 站 7.6.4 的兩個「不」原樣保留：
+     * 熱點預留還沒落帳 → 503（幾秒後就好）；有預留已經釋放（落帳發現不夠、取消在路上）→ 409。
+     * 在出貨的交易之外呼叫：「已落帳、沒有釋放」一旦成立，只有取消能改變它，而取消與出貨由訂單的狀態機排隊（條件式 UPDATE）
      */
-    void consume(long orderId);
+    void checkShippable(long orderId);
 
     /** 補貨：onHand 增加，並記一筆 RESTOCK。自己開交易。13 站 2.7：庫存列還沒建立（product.created 還沒送到）也可以補，先建一列 */
     void restock(long productId, int quantity, String note);
…
      * 釋放一張「不存在、或已經取消」的訂單還佔著的預留：跟 release() 做一樣的事，但自己開交易 —— release() 是 MANDATORY，
      * 因為它本來要跟訂單的狀態一起 commit；對帳找到的這種預留，訂單那邊沒有東西要一起 commit。冪等：已經釋放的不會再釋放。
      * 「這張訂單不存在或已取消」由呼叫端（ordering）判斷：庫存模組不知道訂單
+     * 13 站 4.7：釋放之後，這個 orderId 再也預留不了 —— 一個晚到的 reserve（網路上卡住的那一次）不能把它變回來
      */
     void releaseAbandoned(long orderId);
 }
```

（`checkShippable` 是 4.6.3 的事。）

**跑一次。** `PlaceOrderSagaTest` 在單體裡把五條路各走一次。「預留沒有回應」在一個行程裡不會自然發生 —— 用一個包住真的 `InventoryApi` 的 `FlakyInventory`：預留做完之後丟 503（回應丟了），或者根本沒做就丟 503（請求沒到）：

```java
    record FlakyInventory(InventoryApi real) implements InventoryApi {
        @Override public void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
            Fault f = fault;
            if (f == Fault.BEFORE) throw unavailable();
            real.reserve(orderId, lines, hotLines);
            if (f == Fault.AFTER) throw unavailable();
        }
```

```bash
mvn test -Dtest=PlaceOrderSagaTest
```

```
4.5 庫存不足：REJECTED；歷史 [∅→RESERVING PLACE_ORDER, RESERVING→REJECTED RESERVE_FAILED]；預留 []；outbox [order.rejected]；閘門 4 → 3 → 補償之後 4；買家看得到 1 張
4.5 成功：PENDING_PAYMENT；歷史 [∅→RESERVING PLACE_ORDER, RESERVING→PENDING_PAYMENT RESERVED]；預留 [HELD]；outbox [order.placed]
4.5 回應丟了：503 之後 RESERVING，預留 [HELD]，鍵 1 個，買家看得到 0 張；重送 → replayed=true、同一張=true、PENDING_PAYMENT；預留 [HELD]；reserved 1；歷史 [∅→RESERVING PLACE_ORDER, RESERVING→PENDING_PAYMENT RESERVED]
4.7.2 補償先到：REJECTED；processed_messages 裡這張訂單的預留那一列 1 筆；晚到的預留 → INVALID_STATE「訂單 99087007 的預留已經取消，不能再預留」；預留 []；reserved 0
4.5 卡住的 RESERVING：排程第一次 0 張；改到 2 分鐘前之後 → REJECTED，預留 [HELD]，reserved 2，鍵 0 個；庫存模組收到 order.rejected → 預留 [RELEASED]，reserved 0；歷史 [∅→RESERVING PLACE_ORDER, RESERVING→REJECTED PLACEMENT_EXPIRED]
```

第三行就是 4.2.3 的那一個情況：預留做了、回應丟了。第 03 章的線上，那是 30 秒的 409、之後一筆孤兒；這裡是 503，買家用同一個鍵再送一次，200、同一張訂單、預留還是 1 筆。

### 4.5.5 卡住的 `RESERVING`：排程補償

買家拿到 503 之後不一定會再送；協調者的行程可能就在 T2 與 T3 之間不見了。沒有人接著做的 `RESERVING`，由排程補償：

```java
    /**
     * 13 站 4.5：下單的 Saga 停在中間 —— T1 commit 了（訂單 RESERVING），之後沒有人把它做完：協調者的行程不見了、預留兩次都沒有回應、
     * 買家沒有用同一個鍵重送。往回走（補償）：REJECTED、放掉冪等鍵、order.rejected（庫存模組釋放預留、把熱點閘門加回去）。
     * 不往前走：買家看到的是錯誤（或什麼都沒看到），不該在他不知道的時候多出一張待付款的訂單。
     * 走 idx_orders_status_deadline 的 status 前綴：RESERVING 的訂單只有幾張
     */
    int expirePlacements() {
        List<Long> ids = jdbc.queryForList("""
                SELECT id FROM orders WHERE status = 'RESERVING' AND created_at < ?
                 ORDER BY id LIMIT ?""", Long.class, Timestamp.from(clock.instant().minus(placementTimeout)), BATCH);
        return applyEach(ids, OrderEvent.PLACEMENT_EXPIRED);
    }
```

```java
            /**
             * 13 站 4.5：訂單停在 RESERVING（下單的 Saga 走到一半）超過這麼久，排程就補償它（REJECTED）。
             * 要比一次下單最久會花的時間長得多：兩次預留各等一個 read timeout（3.5.4），加上鎖等待
             */
            @NotNull @DefaultValue("60s") @DurationMin(seconds = 1) Duration placementTimeout) {}
```

**往回，不往前。** 排程也可以「接著做完」：再送一次預留，成功就 `PENDING_PAYMENT`。這裡選擇往回走，因為這張訂單的買家，最後拿到的是一個錯誤（503），或者連線斷了、什麼都沒拿到。往前走的話，他的「我的訂單」裡會多出一張他不知道的待付款訂單，佔著庫存 15 分鐘（付款期限），最後被逾時排程取消。往回走，資料庫的結果就跟他看到的一致：「沒有成立」。他自己用同一個鍵重送的話，走的是 4.5.4 的「往前」—— 那是他明確要的。

**60 秒夠不夠久？** 它要比一次下單最久會花的時間長得多：預留兩次各等一個 read timeout（第 03 章 3.5.4：3 秒），加上鎖等待。60 秒之後才補償，萬一那個預留其實還在路上呢？—— 那是 4.7.2。

### 4.5.6 新狀態的代價：一個不能在線上跑的 migration，以及每一句讀 `orders` 的 SQL

一個新的狀態，不只是 enum 多兩個值。它會漏到每一個讀 `orders` 的地方。E6 在一份 10 萬張訂單（100 位賣家、30 天）的複本上量了其中兩個：

```bash
mvn test -Pexperiments -Dtest=E6NewStatusCostTest
```

```
═══ 4.5.6 ① V26 的第一版（換一個會檢查的 CHECK）：10 萬張訂單，8 條執行緒同時在下單（load { 11.11 7.36 6.90 }）═══
  ALTER TABLE orders DROP CHECK ck_orders_status, ADD CONSTRAINT ck_orders_status CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'PICKING', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'RESERVING', 'REJECTED')), ALGORITHM=INPLACE
    → ERROR 1845 ALGORITHM=INPLACE is not supported for this operation. Try ALGORITHM=COPY.（6 ms）
  ALTER TABLE orders DROP CHECK ck_orders_status, ADD CONSTRAINT ck_orders_status CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'PICKING', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'RESERVING', 'REJECTED'))
    → 成功，1,527 ms；DDL 之前 1 秒內下單 3,463 張；DDL 期間完成 27 張；最慢的一張等了 1,524 ms
═══ 4.5.6 ② V26 現在的寫法（NOT ENFORCED、INSTANT），另一份同樣的複本，同樣的負載 ═══
  ALTER TABLE orders DROP CHECK ck_orders_status, ADD CONSTRAINT ck_orders_status CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'PICKING', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'RESERVING', 'REJECTED')) NOT ENFORCED, ALGORITHM=INSTANT
    → 成功，31 ms；DDL 之前 1 秒內下單 3,148 張；DDL 期間完成 17 張；最慢的一張等了 26 ms
  INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline) VALUES (999999, 'E6-BOGUS', 1, 1, 'BOGUS', 1, NOW(3))
    → 成功（2 ms）
  DELETE FROM orders WHERE id = 999999
    → 成功（2 ms）
  之後要讓 MySQL 再檢查：另一次停機維護
  ALTER TABLE orders ALTER CHECK ck_orders_status ENFORCED
    → 成功，1,293 ms；DDL 之前 1 秒內下單 3,219 張；DDL 期間完成 34 張；最慢的一張等了 1,288 ms
═══ 4.5.6 ③ V27：order_items 加一欄（10 萬列）═══
  ALTER TABLE order_items ADD COLUMN hot BOOLEAN NOT NULL DEFAULT FALSE, ALGORITHM=INSTANT
    → 成功（12 ms）
═══ 4.5.6 ④ 報表的「訂單數」：一位賣家 30 天（load { 10.54 7.30 6.89 }）═══
  一位賣家，第 03 章：
    -> Table scan on <temporary>  (actual time=0.461..0.463 rows=30 loops=1)
        -> Aggregate using temporary table  (actual time=0.46..0.46 rows=30 loops=1)
            -> Filter: ((o.seller_id = 900042) and (o.created_at >= <cache>((now(3) - interval 30 day))) and (o.created_at < <cache>(now(3))))  (cost=201 rows=1000) (actual time=0.0354..0.269 rows=1000 loops=1)
                -> Covering index range scan on o using idx_orders_seller_created over (seller_id = 900042 AND '2026-09-15 08:51:11.813' <= created_at < '2026-10-15 08:51:11.813')  (cost=201 rows=1000) (actual time=0.0287..0.173 rows=1000 loops=1)
  一位賣家，這一章：
    -> Table scan on <temporary>  (actual time=2.46..2.46 rows=30 loops=1)
        -> Aggregate using temporary table  (actual time=2.45..2.45 rows=30 loops=1)
            -> Filter: (o.`status` not in ('RESERVING','REJECTED'))  (cost=450 rows=500) (actual time=0.234..2.29 rows=1000 loops=1)
                -> Index range scan on o using idx_orders_seller_created over (seller_id = 900042 AND '2026-09-15 08:51:11.815' <= created_at < '2026-10-15 08:51:11.815'), with index condition: ((o.seller_id = 900042) and (o.created_at >= <cache>((now(3) - interval 30 day))) and (o.created_at < <cache>(now(3))))  (cost=450 rows=1000) (actual time=0.232..2.21 rows=1000 loops=1)
  全站，第 03 章：
    -> Table scan on <temporary>  (actual time=37.2..37.2 rows=30 loops=1)
        -> Aggregate using temporary table  (actual time=37.2..37.2 rows=30 loops=1)
            -> Filter: ((o.created_at >= <cache>((now(3) - interval 30 day))) and (o.created_at < <cache>(now(3))))  (cost=10475 rows=52253) (actual time=0.0395..21.9 rows=106090 loops=1)
                -> Covering index range scan on o using idx_orders_created over ('2026-09-15 08:51:11.818' <= created_at < '2026-10-15 08:51:11.818')  (cost=10475 rows=52253) (actual time=0.0386..13.9 rows=106090 loops=1)
  全站，這一章：
    -> Table scan on <temporary>  (actual time=44.5..44.6 rows=30 loops=1)
        -> Aggregate using temporary table  (actual time=44.5..44.5 rows=30 loops=1)
            -> Filter: ((o.created_at >= <cache>((now(3) - interval 30 day))) and (o.created_at < <cache>(now(3))) and (o.`status` not in ('RESERVING','REJECTED')))  (cost=10683 rows=26127) (actual time=0.0308..29.1 rows=106090 loops=1)
                -> Table scan on o  (cost=10683 rows=104506) (actual time=0.0289..17 rows=106090 loops=1)
  60 次、交錯，p50：一位賣家 0.93 → 1.71 ms；全站 26.76 → 35.41 ms
  （結束時 load { 10.09 7.26 6.88 }）
```

**① 換掉狀態的 CHECK。** V26 的第一版照第 12 站的寫法：拿掉舊的 `ck_orders_status`、加一個包含 `RESERVING`、`REJECTED` 的新 CHECK。MySQL 加一個 CHECK 要驗證既有的每一列 —— `ALGORITHM=INPLACE` 不支援，只能整張表複製一次。8 條執行緒一直在下單：DDL 之前每秒三千多張；DDL 跑的 1.5 秒裡完成了 27 張，**最慢的一張等了 1.5 秒** —— 等於整段 DDL。這一段跑了四次：1.4、1.6、2.0、1.5 秒，每一次都是整段擋住。這跟第 12 站 7.6.3 量到的是同一件事（取消原因的 CHECK，10 萬列 2.25～3.61 秒）—— 那一章因此沒有加那個取消原因，第 12 站 2.9.6 的規則是「migration 要能在線上跑」。

所以 V26 改成另一種寫法：新的 CHECK **先不檢查**（`NOT ENFORCED`），只改資料字典（`ALGORITHM=INSTANT`）—— 31 ms，最慢的一張下單等了 26 ms（另外兩次：18 ms／13 ms、20 ms／11 ms）：

```sql
-- 13 站 4.5：下單的 Saga。訂單先以 RESERVING 寫下（語意鎖），庫存預留成功才變成 PENDING_PAYMENT；預留失敗、或卡太久 → REJECTED。
-- 狀態的 CHECK 要換。第一版照第 12 站的寫法換一個「會檢查」的 CHECK：MySQL 要驗證既有的每一列 —— 整張表複製一次（ALGORITHM=COPY），
-- 10 萬張訂單 1.4 秒，期間下單全部被擋（4.5.6 量了；第 12 站 7.6.3 為了同一件事沒有加取消原因）。第 12 站的規則：migration 要能在線上跑。
-- 改成：新的 CHECK 先 NOT ENFORCED（只改資料字典，ALGORITHM=INSTANT，十幾毫秒）—— 狀態的值暫時只靠程式（OrderStatus、狀態機）守。
-- 要再讓 MySQL 檢查，是另一次停機維護：ALTER TABLE orders ALTER CHECK ck_orders_status ENFORCED（整表複製，4.5.6）
ALTER TABLE orders DROP CHECK ck_orders_status,
  ADD CONSTRAINT ck_orders_status CHECK (status IN
      ('PENDING_PAYMENT', 'PAID', 'PICKING', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'RESERVING', 'REJECTED')) NOT ENFORCED,
  ALGORITHM=INSTANT;
```

代價寫在 E6 的下一行：**`'BOGUS'` 寫得進去了。** 訂單狀態的值，從這一刻起只靠程式守（`OrderStatus` 的 enum、狀態機的條件式 UPDATE）。之後要讓 MySQL 再檢查，是另一次停機維護：`ALTER CHECK … ENFORCED` 一樣整表複製（1.3 秒，期間不能下單）。訂單表大到幾百萬列之後，常見的做法是 gh-ost、pt-online-schema-change 這類工具：在背景複製一份新的表、跟上變更、最後一瞬間換名字 —— 這一章沒有用它們。

⚠️ **我以為沒有任何測試在乎這一道 CHECK，錯了。** 寫 V26 的線上版之前，我用 `ck_orders_status` 這個名字搜測試，找不到，就以為「沒有人在守它」。整套測試跑下去，`SchemaConstraintTest` 紅了一格：「訂單狀態只能是 0.5 的六個值」—— 它不提 CHECK 的名字，直接寫一張 `'REFUNDED'` 的訂單，期待被拒絕。這一格守的正是這一道防線；它是刻意放掉的，所以那一格拿掉，換成一個把「不檢查」寫明白的測試：

```java
    /**
     * 13 站 4.5：訂單狀態的 CHECK 是刻意 NOT ENFORCED 的 —— 換一個會檢查的 CHECK 要整張 orders 複製一次、期間不能下單（4.5.6）。
     * 狀態的值暫時只靠 OrderStatus 與狀態機守。這個測試讓「資料庫不再擋」這件事寫在測試裡：要改回 ENFORCED（另一次停機維護），這裡跟著改
     */
    @Test
    void orderStatusCheckIsDeliberatelyNotEnforced() {
        String enforced = jdbc.queryForObject("""
                SELECT enforced FROM information_schema.table_constraints
                 WHERE table_schema = DATABASE() AND table_name = 'orders' AND constraint_name = 'ck_orders_status'""", String.class);
        String clause = jdbc.queryForObject("""
                SELECT check_clause FROM information_schema.check_constraints
                 WHERE constraint_schema = DATABASE() AND constraint_name = 'ck_orders_status'""", String.class);
        System.out.println("13 站 4.5：ck_orders_status ENFORCED = " + enforced + "；" + clause);
        assertThat(enforced).isEqualTo("NO");
        assertThat(clause).contains("RESERVING").contains("REJECTED");
    }
```

**② 報表的「訂單數」。** 第 12 站 US-RPT-1 的日報表數「當天成立的訂單」，一句 `COUNT(*)`，沒有看狀態 —— 現在 `REJECTED` 會被算進去。加上 `AND o.status NOT IN ('RESERVING', 'REJECTED')`：

```xml
            SELECT DATE(CONVERT_TZ(o.created_at, '+00:00', '+08:00')) AS day,
                   COUNT(*) AS order_count, 0 AS paid_amount, 0 AS refund_amount
              FROM orders o
             WHERE o.created_at &gt;= #{fromUtc} AND o.created_at &lt; #{toUtc}
               AND o.status NOT IN ('RESERVING', 'REJECTED')                 <!-- 13 站 4.5：還沒成立的訂單不是訂單 -->
               <if test="sellerId != null">AND o.seller_id = #{sellerId}</if>
             GROUP BY day
```

E6 ④ 的 `EXPLAIN ANALYZE`：一位賣家 30 天，原本是**覆蓋索引**（`idx_orders_seller_created` 裡就有需要的欄位，不用讀表），加了 `status` 之後每一列都要回表；全站的那一句從索引範圍掃描變成**全表掃描**。60 次交錯，p50：一位賣家 0.93 → 1.71 ms、全站 26.76 → 35.41 ms（另外兩次的方向與大小都一樣）。熱門排行（`TrendingMapper`）也加了同一個條件。

**③ 其他漏出去的地方**（這幾個沒有量，是讀程式碼找的）：

| 地方 | 不改會怎樣 | 改成 |
|---|---|---|
| 「我的訂單」、賣家的訂單列表 | 列出一張買家拿到 409 的訂單 | `OrderRepository.findBy…AndStatusNotIn(NOT_PLACED)` |
| 帶 `{orderNo}` 的每一支 API（`OrderAccess`） | 查得到、甚至取消得到一張 `RESERVING` | 一律當成不存在；連「存在嗎」那一句也是 —— 不然買家自己的 `RESERVING` 會被記成一筆 ACCESS_DENIED |
| 對外的 API 契約（`OrderView.status`） | 契約上多兩個 enum 值：對一個嚴格的客戶端，是一次不相容的改變 | `@Schema(allowableValues = …)` 只列六個值 |
| 跨服務的對帳（第 02 章 2.6） | `REJECTED` 的預留不會被收；`RESERVING` 被當成不一致 | `REJECTED` 跟 `CANCELLED` 一樣自動釋放（X-2）；`RESERVING` 不檢查 |
| 驗收 Q1（第 12 站） | 「下單失敗時，訂單、明細……三張表都沒有殘留」—— 紅 | 4.8.1 |

契約那一行有一個小坑：第一版的寫法是 `@Schema(allowableValues = {…六個…}) OrderStatus status`。`OpenApiContractTest` 紅了，產生出來的 enum 是 **14 個值** —— springdoc 把 `allowableValues` 跟 enum 本身的八個值接在一起，前六個還重複了一次。要再加 `type = "string"`，它才不去讀 enum：

```java
    public record OrderView(String orderNo,
                            @Schema(type = "string", allowableValues = {"PENDING_PAYMENT", "PAID", "PICKING", "SHIPPED", "COMPLETED", "CANCELLED"}) OrderStatus status,
                            BigDecimal totalAmount, Instant createdAt, Instant paymentDeadline, List<OrderLineView> items) {}
```

---

## 4.6 付款、取消、出貨、逾時：協同

### 4.6.1 庫存模組聽訂單的事件

付款、取消、出貨、逾時取消的那一個交易，第 12 站第 07 章就已經順便寫了一則事件（`order.paid`、`order.cancelled`、`order.shipped`），給通知用。庫存模組也聽它們，在自己的交易裡做自己的那一半：

```java
    /**
     * 13 站 4.6：訂單往前走了，庫存跟上 —— 協同（choreography）。第 12 站這四件事在訂單的交易裡（OrderTransitionService.sideEffects），
     * 切開之後那是一次交易裡的遠端呼叫（第 00 章的四個代價）；現在訂單的交易只寫自己的庫，順便寫一則事件，庫存模組收到之後在自己的交易裡做：
     *   order.paid      → confirm（HELD → CONFIRMED）
     *   order.cancelled → release（→ RELEASED，reserved 減回，熱點閘門加回去）
     *   order.shipped   → consume（→ CONSUMED，on_hand、reserved 減少）
     *   order.rejected  → releaseRejected（下單的 Saga 的補償，4.7）
     * 一個佇列、四種事件：同一張訂單的事件不保證順序（重試會讓後發的先到，第 12 站 7.5.4），每一個方法都只看「預留現在是什麼狀態」，
     * 所以任何順序都收斂到同一個結果（4.6.2）。交易與冪等由 EventDispatcher 負責（processed_messages 跟這幾句 UPDATE 一起 commit）
     */
    @Bean
    EventHandler orderEvents(JdbcInventoryService inventory) {
        return new EventHandler() {
            @Override public String consumer() { return "inventory.order-events"; }
            @Override public Set<String> eventTypes() {
                return Set.of(EventTypes.ORDER_PAID, EventTypes.ORDER_CANCELLED, EventTypes.ORDER_SHIPPED, EventTypes.ORDER_REJECTED);
            }
            @Override public void handle(Event e) {
                long orderId = e.getLong("orderId");
                switch (e.type()) {
                    case EventTypes.ORDER_PAID -> inventory.confirm(orderId);
                    case EventTypes.ORDER_CANCELLED -> inventory.release(orderId);
                    case EventTypes.ORDER_SHIPPED -> inventory.consume(orderId);
                    case EventTypes.ORDER_REJECTED -> {
                        List<ReserveLine> hotLines = new ArrayList<>();
                        e.payload().get("hotLines").forEach(l -> hotLines.add(new ReserveLine(l.get("productId").asLong(), l.get("quantity").asInt())));
                        inventory.releaseRejected(orderId, hotLines);
                    }
                    default -> throw new IllegalStateException("沒有訂閱 " + e.type());
                }
            }
        };
    }
```

一個消費者、四種事件、一個佇列（`shop.inventory.order-events`）。交易與冪等是第 12 站 7.5.2 的 `EventDispatcher`：`processed_messages` 那一列跟這幾句 UPDATE 一起 commit。佇列與繫結、relay 都不用改 —— 第 03 章 3.7.3 說過，拓撲替**每一個** `EventHandler` 宣告佇列，消費者只在擁有那個模組的服務裡開。`ServiceRoleConsumersTest` 跟著改（第 03 章的 6 個消費者變成 7 個，庫存服務收 4 個）。

訂單那一邊，`OrderTransitionService.sideEffects()` 拿掉了三行（4.5.4 的 diff）。訂單服務的交易裡只剩它自己的庫：訂單、歷史、退款單、購物車、冪等鍵、outbox。

**這改變了單體。** 這一章的改動在模組裡，不在部署裡 —— 跟第 02 章 2.7 的 `product.created` 一樣，單體也跟著變：付款之後預留什麼時候變成 `CONFIRMED`、取消之後庫存什麼時候回來，在單體裡也是「事件送到之後」。第 12 站有 8 個測試因此紅了（4.8.1）—— 每一個都是一句「commit 完就讀預留」。

### 4.6.2 事件會亂序：每一步都只看狀態

同一張訂單的兩個事件，送到的順序不一定是發出的順序：一則失敗了、走第 12 站 7.5.3 的重試佇列，後發的那一則就先到了（第 12 站 7.5.4）。協同的每一步都要能接受任何順序：

| 先到 | 後到 | 結果 |
|---|---|---|
| `order.shipped` | `order.paid` | 出庫接受 `HELD`（出貨就隱含了確認）；晚到的確認只改 `HELD` 的，一列都沒有 |
| `order.cancelled` | `order.paid` | 釋放之後是 `RELEASED`；晚到的確認一列都沒有 |
| `order.shipped` | `order.placed`（熱點落帳） | 出庫先把還沒落帳的落帳，再出庫；晚到的落帳找不到還沒計入的預留 |
| 同一則 `order.cancelled` 兩次 | | `processed_messages`：第二次 DUPLICATE |
| 另一則 `order.cancelled`（不同的 eventId） | | `processed_messages` 擋不住；預留已經 `RELEASED`，釋放什麼都不做 |

能這樣，是因為預留本身就是一個狀態機（`HELD → CONFIRMED → CONSUMED`、`HELD / CONFIRMED → RELEASED`），**每一個操作都只用「預留現在是什麼狀態」當條件** —— 第 02 章 2.5.3 說過的「重做同一件事會收斂」，這裡延伸成「換一個順序也會收斂」。唯一要改的是出庫：

```java
    /**
     * 出貨：預留 → CONSUMED，onHand 與 reserved 同時減少，每個品項一筆 SHIP。MANDATORY。
     *
     * 13 站 4.6：order.shipped 的消費者呼叫它（第 12 站是出貨的交易裡，在那裡它可以拒絕：還在落帳 503、即將取消 409）。
     * 那兩個「不」搬到出貨之前（checkShippable，4.6.3）；到了這裡，訂單已經是 SHIPPED —— 貨出去了，這裡不能說不：
     *   ① order.shipped 可能比 order.paid 先到（兩個事件、各自的重試，第 12 站 7.5.4：順序不保證）—— HELD 的也出庫（出貨就隱含了確認）
     *   ② 熱點預留還沒落帳 —— 出貨之前問過了，不應該發生；萬一發生（例如繞過了那一次檢查），先落帳、再出庫
     *   ③ 落帳發現不夠 —— 那一列 RELEASED、發 hot-settlement-failed（訂單已經出貨，ordering 會忽略它）；
     *      其他品項照樣出庫，這一件記一筆衝突（shop.inventory.consume.conflict）：要有人去看貨到底在不在
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void consume(long orderId) {
        while (settleHot(orderId) < 0) { /* 每一次 -1 釋放一列不夠的；剩下的再落帳一次 */ }
        for (Held h : held(orderId, "'HELD', 'CONFIRMED'")) {
            jdbc.update("""
                    UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE product_id = ?""", h.quantity(), h.quantity(), h.productId());
            jdbc.update("UPDATE inventory_reservations SET status = 'CONSUMED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
            ledger(h.productId(), -h.quantity(), -h.quantity(), "SHIP", "order:" + orderId);
        }
        List<Long> released = jdbc.queryForList("SELECT product_id FROM inventory_reservations WHERE order_id = ? AND status = 'RELEASED'",
                Long.class, orderId);
        if (!released.isEmpty()) {
            consumeConflicts.increment();
            log.error("INVENTORY_CONSUME_CONFLICT orderId={} productIds={}：訂單已經出貨，這幾個品項的預留已經釋放（4.6.3）", orderId, released);
        }
    }
```

`InventoryOrderEventsTest` 把會亂序的那幾對各釘一次，誰先到由測試決定：

```bash
mvn test -Dtest=InventoryOrderEventsTest
```

```
4.6.2 同一則取消兩次：PROCESSED、DUPLICATE；另一則取消 PROCESSED；{reservation=RELEASED, stock=10/0, ledger=RESERVE,RELEASE}
4.6.2 先出貨、後付款：出貨之後 {reservation=CONSUMED, stock=9/0, ledger=RESERVE,SHIP}；付款晚到之後 {reservation=CONSUMED, stock=9/0, ledger=RESERVE,SHIP}
4.6.2 先取消、後付款：取消之後 {reservation=RELEASED, stock=10/0, ledger=RESERVE,RELEASE}；付款晚到之後 {reservation=RELEASED, stock=10/0, ledger=RESERVE,RELEASE}
4.6.2 先出貨、後落帳：出貨之後 {reservation=CONSUMED, stock=9/0, ledger=RESERVE,SHIP}；落帳晚到之後 {reservation=CONSUMED, stock=9/0, ledger=RESERVE,SHIP}
```

### 4.6.3 出貨之前問一次：補償不回來的那一步

第一版的出貨，只有上面那一半：訂單變成 `SHIPPED`、寫 `order.shipped`，庫存模組收到之後出庫。整套測試跑下去，第 12 站的 `HotSettlementTest` 紅了三個，其中兩個是：

```
[ERROR] com.example.shop.ordering.internal.HotSettlementTest.shipWaitsForSettlement -- Time elapsed: 0.097 s <<< FAILURE!
Expecting code to raise a throwable.
[ERROR] com.example.shop.ordering.internal.HotSettlementTest.shortageBlocksShipThenCancels -- Time elapsed: 0.088 s <<< FAILURE!
Expecting code to raise a throwable.
```

「Expecting code to raise a throwable」—— 測試在等一個例外，沒等到。這兩個測試守的是第 12 站 7.6.4 的兩個「不」：熱點預留還沒落帳，出貨 503（幾秒後就好）；落帳發現不夠、取消在路上，出貨 409。第一版把它們一起拿掉了 —— 出貨不再問庫存，賣家就可以把一件不存在的貨出出去。

第 03 章 3.3.2 的表就寫著：`consume` **會**拒絕。4.4.2 的規則：會被拒絕的步驟，要在樞紐之前；而出貨本身**補償不回來** —— 貨出了門，系統再怎麼補償，箱子也不會自己回到倉庫。所以那兩個「不」要留在出貨**之前**。現在它是一次只讀的詢問：

```java
    /** 13 站 4.6.3：出貨之前問一次。一句加鎖的讀都沒有 —— 只讀、不改，跟出貨的交易無關 */
    @Override
    public void checkShippable(long orderId) {
        Integer unsettled = jdbc.queryForObject("""
                SELECT COUNT(*) FROM inventory_reservations WHERE order_id = ? AND status IN ('HELD', 'CONFIRMED') AND counted = FALSE""",
                Integer.class, orderId);
        refuseToShip(orderId, unsettled != null && unsettled > 0);
    }
…
    /** 第 12 站 7.6.4 的兩個「不」 */
    private void refuseToShip(long orderId, boolean unsettled) {
        if (unsettled)                                                      // 7.6.4：落帳還沒完成。幾秒後就會好 —— 出貨不差這幾秒
            throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "這張訂單的庫存還在落帳，請稍後再出貨").with("retryAfter", 5);
        // 7.6.4：落帳發現不夠、那一列已經 RELEASED，取消的事件還在路上。這時候出貨 = 出一件不存在的貨（onHand 不會減）
        Integer released = jdbc.queryForObject("SELECT COUNT(*) FROM inventory_reservations WHERE order_id = ? AND status = 'RELEASED'", Integer.class, orderId);
        if (released != null && released > 0)
            throw new ShopException(ProblemType.INVALID_STATE, "這張訂單有商品庫存不足，即將取消，不能出貨");
    }
```

```java
    /**
     * US-ORD-6 AC-2。13 站 4.6.3：不再是一個交易 —— 出庫是庫存模組收到 order.shipped 之後的事；出貨之前先問庫存一次（只讀），
     * 這一次讀在任何交易之外（第 01 章 1.6：交易裡不做跨模組的呼叫）。轉移本身是 OrderTransitionService 自己的交易
     */
    public OrderView ship(long sellerId, String orderNo, String carrier, String trackingNo) {
        long id = sellers(sellerId, orderNo);
        if (transitions.current(id).status() == OrderStatus.PICKING) inventory.checkShippable(id);   // 已經出貨的重送不用再問
        transitions.apply(id, OrderEvent.SHIP, OrderHistory.Actor.seller(sellerId), EventData.shipment(carrier, trackingNo));
        return queries.byId(id);
    }
```

切開的部署裡，它是一支新的端點：`GET /internal/inventory/v1/reservations/{orderId}/shippable`，204 可以、503 還在落帳、409 即將取消。

**這一次讀可以放在交易之外嗎？** 第 01 章 1.6.7 的 📌 才說過：「用來決定同一個交易裡要寫什麼的讀，不行」—— `succeededPaymentOf` 移出取消的交易，回呼就能插進那個窗口。差別在於讀到的東西**之後還會不會變**：

- `succeededPaymentOf`「沒有成功的付款」→ 下一刻就可能有（回呼隨時會到）。讀完、寫之前，它變了。
- `checkShippable`「每一筆預留都已經落帳、沒有一筆被釋放」→ 一旦成立，能讓它變回去的只有釋放；而釋放只會因為訂單被取消 —— 取消與出貨是同一張訂單的兩個轉移，由狀態機的條件式 UPDATE 排隊（第 12 站 0.5.5）：誰先 commit，另一個就拿到 409。落帳不會把已經計入的預留再拿出來。

所以這一次讀不用在交易裡。這個推論沒有寫成交錯的測試 —— 它靠的是兩個已經有測試的性質（條件式 UPDATE、落帳只處理 `counted = FALSE`）。

> ⚠️ **第 04 章寫完之後的追記：把這個推論寫成交錯的測試 —— 它只對了一半。**
>
> 上面那一段推的是「問完之後」：答案一旦成立，只有取消能改變它。用 latch 把兩個窗口釘住（`ShipCheckOutsideTxTest`，`ordering.internal`）：
>
> - **①** 問完、出貨的交易之前，賣家取消，庫存模組也收到 `order.cancelled`、釋放了。
> - **②** `ship()` 讀了狀態、決定「要不要問」之後，同一張訂單開始撿貨。
>
> ② 是推論的時候沒有想到的。`ship()` 只在讀到 `PICKING` 時才問（「已經出貨的重送不用再問」）：讀到 `PAID` 就不問 —— 那一次讀在交易之外，而轉移在它自己的交易裡**再讀一次**狀態。兩次讀之間撿貨開始了，轉移看到的是 `PICKING`，出貨就成立了，庫存從來沒被問過。
>
> 兩個掛勾。一個包住真的 `InventoryApi`，在 `checkShippable` 回來之後停；另一個是 `OrderTransitionService` 的子類別，在 `current()` 讀完之後停 —— 下一次觸發之後就拿掉，轉移自己那一次讀不受影響：
>
> ```java
>     static class PausingTransitions extends OrderTransitionService {
>         PausingTransitions(JdbcTemplate jdbc, CartApi cart, IdempotencyKeys keys, PaymentApi payments, OrderHistory history, Outbox outbox,
>                            Clock clock, MeterRegistry meters) {
>             super(jdbc, cart, keys, payments, history, outbox, clock, meters);
>         }
>
>         @Override
>         Current current(long orderId) {
>             Current c = super.current(orderId);
>             run(afterRead);
>             return c;
>         }
>     }
> ```
>
> ```java
>     @Test @DisplayName("4.6.3 ②：ship() 讀到 PAID（還沒撿貨）之後，撿貨開始 —— 熱點還沒落帳，出貨要被擋下（503），不能因為「讀到的不是 PICKING」就不問")
>     void pickingStartsBetweenReadAndShip() throws Exception {
>         var o = paidOrder();                                                 // 熱點的那一筆還沒落帳（order.placed 沒有交付）
>         CountDownLatch paused = new CountDownLatch(1), go = new CountDownLatch(1);
>         CompletableFuture<Object> ship = shipPausedAt(afterRead, o.orderNo(), paused, go);
>         assertThat(paused.await(10, TimeUnit.SECONDS)).as("出貨停在讀完狀態之後").isTrue();
>         commands.startPicking(SELLER, o.orderNo());
>         Map<String, Object> between = state(o.orderId());
>         go.countDown();
>         Object r = ship.get(10, TimeUnit.SECONDS);
>         Map<String, Object> after = state(o.orderId());
>         System.out.println("4.6.3 ② 讀完狀態之後撿貨：窗口裡 " + between + "；出貨 → " + outcome(r) + "；之後 " + after);
>         if (!(r instanceof RuntimeException)) {                               // 沒擋下：讓庫存模組照常收到 order.shipped，看它出了什麼
>             jdbc.update("UPDATE inventory SET on_hand = 0 WHERE product_id = ?", HOT);   // 而那一件熱點，其實不存在（Redis 放進了 MySQL 沒有的庫存）
>             inventoryFollows(o.orderId(), "order.placed", "order.paid", "order.shipped");
>             System.out.println("4.6.3 ② 沒擋下的話：庫存模組收到 order.shipped 之後 " + state(o.orderId()));
>         }
>         assertThat(r).isInstanceOfSatisfying(ShopException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE));
>         assertThat(after).containsEntry("status", "PICKING");
>     }
> ```
>
> 先放到**還沒修**的程式碼上跑：
>
> ```
> 4.6.3 ② 讀完狀態之後撿貨：窗口裡 {status=PICKING, reservations=HELD,HELD（未落帳）, on_hand=5,5, events=order.placed,order.paid}；出貨 → 出貨成功；之後 {status=SHIPPED, reservations=HELD,HELD（未落帳）, on_hand=5,5, events=order.placed,order.paid,order.shipped}
> 4.6.3 ② 沒擋下的話：庫存模組收到 order.shipped 之後 {status=SHIPPED, reservations=CONSUMED,RELEASED（未落帳）, on_hand=4,0, events=order.placed,order.paid,order.shipped,inventory.hot-settlement-failed}
> 4.6.3 ① 問完之後取消：窗口裡 {status=CANCELLED, reservations=RELEASED,RELEASED, on_hand=5,5, events=order.placed,order.paid,order.cancelled}；出貨 → INVALID_STATE「訂單目前的狀態（CANCELLED）不允許這個動作」；之後 {status=CANCELLED, reservations=RELEASED,RELEASED, on_hand=5,5, events=order.placed,order.paid,order.cancelled}
> [ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 17.60 s <<< FAILURE! -- in com.example.shop.ordering.internal.ShipCheckOutsideTxTest
> ```
>
> ① 是綠的：取消先 commit，出貨的轉移讀到 `CANCELLED`、狀態機拒絕（409），什麼都沒出庫 —— 推論的那一半成立。② 是紅的：熱點那一筆還沒落帳（`HELD（未落帳）`），出貨照樣成功。測試接著讓那一件「其實不存在」（庫存改成 0）再交付事件：庫存模組落帳時發現不夠、那一列 `RELEASED`、發 `inventory.hot-settlement-failed`，再出庫另一件 —— 日誌是一行 `INVENTORY_CONSUME_CONFLICT orderId=1 productIds=[9900872]`。**一張已經出貨的訂單，有一件貨不存在** —— 這正是第 12 站 7.6.4 那兩個「不」要擋的事，而 4.9 的 `shop.inventory.consume.conflict` 只是事後的告警。
>
> 修法是反過來問：**什麼時候可以不問？** 只有讀到的狀態再也走不到 `SHIPPED` 的時候 —— 已經出貨（重送）、已完成、已取消、被補償掉。其他狀態一律問：
>
> ```diff
>          return queries.byId(id);
>      }
>
> +    /**
> +     * 13 站 4.6.3 的追記：讀到這幾個狀態，就不用問庫存 —— 從它們再也走不到 SHIPPED（已經出貨的重送、已完成、已取消、被補償掉）。
> +     * 其他狀態一律要問：第一版只在讀到 PICKING 時問，讀完之後、轉移之前撿貨開始了，轉移看到的是 PICKING，出貨就沒問過庫存
> +     */
> +    static final java.util.Set<OrderStatus> PAST_SHIPPING = java.util.EnumSet.of(
> +            OrderStatus.SHIPPED, OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.REJECTED);
> +
>      /**
>       * US-ORD-6 AC-2。13 站 4.6.3：不再是一個交易 —— 出庫是庫存模組收到 order.shipped 之後的事；出貨之前先問庫存一次（只讀），
>       * 這一次讀在任何交易之外（第 01 章 1.6：交易裡不做跨模組的呼叫）。轉移本身是 OrderTransitionService 自己的交易
>       */
>      public OrderView ship(long sellerId, String orderNo, String carrier, String trackingNo) {
>          long id = sellers(sellerId, orderNo);
> -        if (transitions.current(id).status() == OrderStatus.PICKING) inventory.checkShippable(id);   // 已經出貨的重送不用再問
> +        if (!PAST_SHIPPING.contains(transitions.current(id).status())) inventory.checkShippable(id);   // 4.6.3 的追記：讀到的不是 PICKING 也要問
>          transitions.apply(id, OrderEvent.SHIP, OrderHistory.Actor.seller(sellerId), EventData.shipment(carrier, trackingNo));
>          return queries.byId(id);
>      }
> ```
>
> 代價：賣家對一張還沒撿貨的訂單按「出貨」，現在會先問庫存一次；熱點還在落帳的話，拿到的是 503「請稍後再出貨」，不是狀態機的 409。這種請求本來就會被拒絕 —— 多一次只讀的往返、錯誤訊息不那麼準，換一個不會漏的檢查。修了之後：
>
> ```
> 4.6.3 ② 讀完狀態之後撿貨：窗口裡 {status=PICKING, reservations=HELD,HELD（未落帳）, on_hand=5,5, events=order.placed,order.paid}；出貨 → TEMPORARILY_UNAVAILABLE「這張訂單的庫存還在落帳，請稍後再出貨」；之後 {status=PICKING, reservations=HELD,HELD（未落帳）, on_hand=5,5, events=order.placed,order.paid}
> 4.6.3 ① 問完之後取消：窗口裡 {status=CANCELLED, reservations=RELEASED,RELEASED, on_hand=5,5, events=order.placed,order.paid,order.cancelled}；出貨 → INVALID_STATE「訂單目前的狀態（CANCELLED）不允許這個動作」；之後 {status=CANCELLED, reservations=RELEASED,RELEASED, on_hand=5,5, events=order.placed,order.paid,order.cancelled}
> ```
>
> 這一次推論錯在哪裡：我只檢查了「讀到的東西，之後會不會變」，沒有檢查「**決定要不要讀**的那一次讀」。那一次讀一樣在交易之外，它看到的狀態一樣會在下一刻變 —— 跟 `succeededPaymentOf` 是同一類的錯（第 01 章 1.6.7 的 📌），只是藏在一個看起來只是「省一次呼叫」的 `if` 裡。

**換到了什麼**：出貨這一個動作，從「訂單服務的交易裡，一次對庫存服務的寫入」變成「交易之外的一次讀」。庫存服務掛了，賣家一樣出不了貨（第 06 章的事）；但它慢的時候，不再佔著訂單服務的一條資料庫連線。

### 4.6.4 `InventoryApi` 少三個方法；第 03 章的兩支端點還不能拿掉

`confirm`、`release`、`consume` 不再有別的模組呼叫 —— 跟第 03 章 3.4.2 的 `initialize` 一樣，從 `InventoryApi` 拿掉，留在 `JdbcInventoryService` 上給自己的消費者用。`InventoryClient` 跟著少了 `…/confirm`、`…/consume`（`…/release` 還在，對帳的 `releaseAbandoned` 用它）。呼叫端的 Pact 契約：

| 第 03 章（15 個互動） | 這一章（16 個） |
|---|---|
| 付款成功：確認預留 | （拿掉） |
| 出貨：扣庫存 | （拿掉） |
| 出貨：熱點還在落帳 | （拿掉） |
| 取消：釋放預留 | 對帳：釋放沒有人要的預留（同一支端點，改了描述） |
| | 出貨之前：可以出貨 ／ 熱點還在落帳 ／ 庫存不足、即將取消 |
| | 預留一張已經被補償的訂單 → 409（4.7.2） |

**但庫存服務那一邊，兩支端點都還要在。** 第 03 章 3.8.5 的「線上那一版的契約」裡有它們 —— 線上那一版的訂單服務還在出貨的交易裡同步呼叫 `…/consume`，而且靠它的 503、409 拒絕出貨。新的出庫（`consume`）不拒絕。如果 v1 的端點直接改用新的方法，舊的訂單服務會在熱點還沒落帳時出貨成功。

這件事我是在改呼叫端的契約時推出來的。推論要能重現才算數：暫時把 v1 的 `…/consume` 接到新的 `consume`，跑線上那一版的契約：

```
  Given 訂單 7004 的熱點預留已確認、還沒落帳
  出貨：熱點還在落帳
    returns a response which
      has status code 503 (FAILED)
      includes headers
        "Content-Type" with value "application/problem+json" (FAILED)
      has a matching body (FAILED)

Failures:

1) Verifying a pact between order-service and inventory-service - 出貨：熱點還在落帳: has status code 503

    1.1) status: expected status of 503 but was 204

    1.2) header: Expected a header 'Content-Type' but was missing

    1.3) body-content-type: Expected a body of 'application/problem+json' but the actual content type was 'null'
```

所以它們是兩個不一樣的操作，不共用一個方法：v1 的端點走 `consumeConfirmed`（第 12 站 7.6.4 的語意，原封不動），等那一版訂單服務下線、它的契約不在「線上」了，跟端點一起拿掉（第 03 章 3.8.5 的「收縮」）。

```java
    /**
     * 第 03 章 v1 的 POST /reservations/{orderId}/consume 的語意（第 12 站 7.6.4）：只出庫 CONFIRMED 的；熱點還沒落帳 → 503；
     * 有預留已經釋放（落帳發現不夠、取消在路上）→ 409。線上那一版訂單服務在出貨的交易裡同步呼叫它，靠的就是這兩個「不」（3.8.5 的契約）。
     * 13 站 4.6：新的出庫（consume）不拒絕 —— 兩個不一樣的操作，不共用一個方法。這一個等那一版訂單服務下線之後，跟端點一起拿掉
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void consumeConfirmed(long orderId) {
        List<Held> rows = held(orderId, "'CONFIRMED'");
        refuseToShip(orderId, rows.stream().anyMatch(h -> !h.counted()));
        for (Held h : rows) {
            jdbc.update("""
                    UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE product_id = ?""", h.quantity(), h.quantity(), h.productId());
            jdbc.update("UPDATE inventory_reservations SET status = 'CONSUMED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
            ledger(h.productId(), -h.quantity(), -h.quantity(), "SHIP", "order:" + orderId);
        }
    }
```

新舊並存的那幾天還有一件事：舊的訂單服務出貨時同步呼叫 `…/consume`，同時它的交易照樣寫了 `order.shipped` —— 新的庫存服務收到，又出庫一次。第二次什麼都不改：預留已經 `CONSUMED`，`held('HELD', 'CONFIRMED')` 一列都沒有。確認、釋放也是一樣。**所有的步驟都只看狀態，新舊兩條路做兩次也是一次。**

```bash
mvn verify -Djacoco.skip=true -Dtest=InventoryClientPactTest -Dsurefire.failIfNoSpecifiedTests=false -Dit.test='Inventory*PactIT'
```

```
[INFO] Tests run: 16, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.386 s -- in com.example.shop.inventory.internal.remote.InventoryClientPactTest
[INFO] Tests run: 15, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 20.78 s -- in com.example.shop.inventory.internal.web.InventoryProviderReleasedPactIT
[INFO] Tests run: 16, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 5.654 s -- in com.example.shop.inventory.internal.web.InventoryProviderPactIT
[INFO] Tests run: 31, Failures: 0, Errors: 0, Skipped: 0
```

📌 **第 09 章寫完之後的追記：README 說「Outbox 在單體裡是有點囉唆，在拆分之後變成唯一解」—— 這一節是它變成「唯一」的那一刻。** 第 12 站的單體用 outbox，是為了「訂單成立」與「寄信、落帳」不要一個成功一個失敗；但那時候，庫存的那一半其實可以直接寫在同一個交易裡（第 12 站就是那樣做的），outbox 只管寄信這一類的事 —— 有點囉唆。拆開之後，「訂單改成已付款」與「庫存要確認預留」在兩個庫裡，同一件事只剩三種做法：

- 交易裡直接呼叫庫存服務：呼叫成功、自己的交易失敗，就是第 00 章 0.2.2 的孤兒；呼叫失敗，就是一個卡在中間的訂單。
- 兩階段提交：4.3 量過的代價（單筆 2 倍、吞吐三分之一，協調者當掉時鎖住）。
- 狀態與「要通知對方」的那一則事件寫在**同一個交易**裡，之後至少送到一次，對方冪等地收（4.10.6 的 E7：「rollback 就兩個都沒有」；第 12 站 7.4、7.5）。

第三種就是 outbox。說「唯一」是對這個系統而言 —— 不用兩階段提交、又不會丟的做法還有兩種同一家族的：把資料表本身的變更當成事件（第 02 章 2.8.6 的 binlog 擷取），以及 event sourcing（狀態就是事件，沒有「另外寫一則」）。這一站兩種都沒有拿來做業務的事件。

---

## 4.7 補償

### 4.7.1 補償不是 rollback

rollback 讓一個交易**從來沒有發生過**：別的交易看不到它做了一半的樣子（隔離性），它寫過的東西不留痕跡。補償做不到這兩件事：

- **它是另一個交易**，在前一步 commit 之後才發生。中間那段時間，別人看得到做了一半的樣子 —— 一筆 `HELD` 的預留在那幾秒（最長 60 秒，4.5.5）裡佔著庫存，商品頁的可售量少了一件，另一位買家可能因此拿到 409。這是 Saga 用來換掉 2PC 的那個東西：**不鎖，所以別人看得到中間狀態。** 語意鎖（`RESERVING`）擋得住的只有「拿它去做別的事」，擋不住「看到它」。
- **它留下痕跡**：庫存帳多一筆 `RELEASE`、訂單歷史多一行 `RESERVE_FAILED` 或 `PLACEMENT_EXPIRED`、一張 `REJECTED` 的訂單留在表上（4.5.6 的那一串漏出去的地方）。這不全是壞事 —— 出事的時候，這些就是你知道發生了什麼的唯一來源。
- **它自己也會失敗、也會被送兩次**：補償是一則事件（`order.rejected`），走的是第 12 站第 07 章的 outbox、broker、`processed_messages`。它要能再做一次，也要能跟它要抵銷的那個動作**以任何順序**到達。

下單的補償，庫存那一半：

```java
    /**
     * 13 站 4.7：order.rejected 的補償。下單的 Saga 走不完 —— 這張訂單可能預留過（樞紐之後才當掉）、也可能從來沒有（庫存不足、或樞紐之前就當掉）。
     *   ① 先佔掉這張訂單在 processed_messages 的預留那一列（reserveIdempotently 的第一句）：
     *      佔到了 → 從來沒有預留過，以後也不會了 —— 一個還在網路上的 reserve 晚到，會看到這一列、拿到 409（補償比動作先到）。
     *               熱點閘門扣的那幾件沒有變成預留，照 hotLines 加回去
     *      佔不到 → 預留過（或另一個補償先佔了）→ 照一般的取消釋放；釋放的熱點品項，release() 自己會加回閘門
     *   ② 同一句 INSERT 也讓「補償」與「正在進行的那一次預留」排隊：預留還沒 commit 時，這裡等它；它 rollback 了，這裡才佔得到
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void releaseRejected(long orderId, List<ReserveLine> hotLines) {
        if (inbox.claim(RESERVE_KEY, Long.toString(orderId))) returnToHotStock(orderId, hotLines);
        else release(orderId);
    }
```

### 4.7.2 補償比動作先到

4.5.5 的排程在 60 秒之後補償一張 `RESERVING`。如果那一次預留其實還在路上呢？—— 協調者送出了 `PUT /reservations/{orderId}`，自己就不見了；請求卡在某個地方（一個滿了的連線池、一條等鎖的交易、一次長的 GC），補償做完之後它才到庫存服務。

沒有任何保護的話：補償看到「沒有預留」→ 什麼都不釋放；晚到的預留接著成功 → 一筆 `HELD`，屬於一張 `REJECTED` 的訂單。**孤兒又回來了**，而且這一次它是補償「之後」才出生的，補償不會再來一次。

保護靠的是第 03 章 3.5.2 的那一列：預留的冪等鍵（`processed_messages` 的 `inventory.http.reserve`、orderId）。**補償先去佔那一列：**

- 佔到了 → 這張訂單從來沒有預留過；之後晚到的那一次預留，`inbox.claim()` 會失敗、看到「預留一筆都沒有」，回 409「這張訂單的預留已經取消，不能再預留」（4.5.4 的 `reserveIdempotently`）。熱點閘門扣的那幾件，照 `order.rejected` 帶來的 `hotLines` 加回去。
- 佔不到 → 預留已經做過了（或另一個補償先佔了）→ 照一般的取消釋放；釋放的熱點品項，`release()` 自己會加回閘門。
- **兩件事同時發生**：佔那一列是一句 `INSERT`。預留的交易已經插入、還沒 commit 時，補償的這一句會等它；它 commit 了，補償佔不到 → 釋放它剛預留的；它 rollback 了（例如庫存不足），補償佔得到 → 這張訂單永遠預留不了。同一句 INSERT，讓「動作」與「補償」排隊。

這種「先佔位、讓晚到的動作失效」的做法，常被叫做墓碑（tombstone）。對帳的釋放（`releaseAbandoned`）也做同一件事：

```java
    public void releaseAbandoned(long orderId) {
        inbox.claim(RESERVE_KEY, Long.toString(orderId));                  // 13 站 4.7：釋放之後，這個 orderId 再也預留不了
        release(orderId);                                                   // 同一個物件裡呼叫：不經過代理，MANDATORY 不檢查 —— 這個交易就是它的交易
    }
```

`PlaceOrderSagaTest` 在單體裡把它釘住（預留的請求「沒有到」→ 排程補償 → 那一次預留才到），4.8.3 的 E3 在兩個真的行程上再做一次（請求扣在庫存服務門口，等補償做完才放行）。兩邊的結果都是 409、預留 0 筆。

### 4.7.3 補償不回來的操作

「補償」的前提是有一個動作能抵銷它。下面這些沒有：

| 操作 | 為什麼補償不回來 | 這個系統怎麼處理 |
|---|---|---|
| **出貨** | 貨出了門 | 出貨之前先問（4.6.3）：會被拒絕的事，在補償不回來的事之前問完 |
| **寄出去的信**（訂單成立、已付款……） | 收不回來 | 能延後的就延後：`order.placed` 在 Saga 往前走完（T3）才寫，被拒絕的下單一封信都不會寄。延後不了的，只能再寄一封：熱點落帳失敗（第 12 站 7.6.3）時，買家先收到「訂單成立」、再收到「訂單取消」 |
| **扣款** | 錢已經從卡上扣了 | 補償是**退款** —— 不是 rollback，是另一筆交易：它自己會失敗（第 12 站 7.8：重試用完 → `FAILED`、告警、人工處理），對帳單上買家看得到兩筆。E3 ② 的晚到付款就是走這條路 |
| **已經送給第三方的請求**（金流的退款 API） | 對方做了沒有，只有對方知道 | 冪等鍵交給對方（第 12 站 7.8 的 `refund-{id}`）：重送不會退兩次 |
| **閘門扣了、行程當掉**（4.2.2） | Saga 還沒開始，沒有任何狀態可以讓別人接手 | 熱點對帳（第 12 站 6.6）—— 這一章沒有修它 |
| **使用者看到的東西** | 201 已經回了、商品頁的可售量已經被看見了 | 只能說明：「訂單已取消，款項將退回」—— 跟補償一樣，是新的一則訊息 |
| **訂單狀態的 CHECK**（4.5.6） | 不是 Saga 的步驟，是 migration 的取捨：放掉之後，壞資料寫得進去，不會有人「補償」 | 寫成測試（`orderStatusCheckIsDeliberatelyNotEnforced`），改回來要停機維護 |

列這張表的時候，順序是一個設計工具：**補償不回來的放在最後，或放在一次「確定不會被拒絕」之後**（4.4.2）。下單的 Saga 裡，通知在 T3 之後；出貨在「問過了」之後。

---

## 4.8 測試，以及同樣的 kill -9

### 4.8.1 第 12 站的測試紅了 16 個

改完 4.5、4.6 之後的第一次整套 `mvn test`：

```
[ERROR]   CapstoneAcceptanceTest.q1_transactionBoundary:123 
[ERROR]   OpenApiContractTest.apiContractMatchesSnapshot:53 [API 契約跟快照不一致；若是刻意的，用 -Dopenapi.update=true 更新快照] 
[ERROR]   CrossModuleCallInTxTest.crossModuleCallsInsideTransactionsAreKnown:144 [清單上的每一種都有被走到（不然這個測試守不住它）] 
[ERROR]   HotSettlementTest.cancelBeforeSettlement:108 
[ERROR]   HotSettlementTest.shipWaitsForSettlement:131 
[ERROR]   HotSettlementTest.shortageBlocksShipThenCancels:181 
[ERROR]   OrderFlowTest.buyerCancel:231 
[ERROR]   OrderFlowTest.latePayment:199 
[ERROR]   OrderFlowTest.paymentSucceeded:175 
[ERROR]   OrderFlowTest.paymentTimeout:288 
[ERROR]   OrderFlowTest.shipping:246 
[ERROR]   OrderRaceRegressionTest.threeSchedulers:138 
[ERROR]   OrderRaceRegressionTest.timeoutVsPayment:110 
[ERROR]   ServiceRoleConsumersTest.eachRoleConsumesOnlyItsOwnModules:34 
[ERROR]   OrderStateMachineTest.cells:45 ArrayIndexOutOfBounds Index 11 out of bounds for length 11
[ERROR]   OrderStateMachineTest.theTableHas60CellsAnd5ContextDependentOnes:76->cells:45 ArrayIndexOutOfBounds Index 11 out of bounds for length 11
[ERROR] Tests run: 199, Failures: 14, Errors: 2, Skipped: 0
```

14 個失敗、2 個錯誤，8 個測試類別。`Tests run` 只有 199 個（第 03 章是 265 個）—— `OrderStateMachineTest` 的參數化來源在讀表的時候就丟了 `ArrayIndexOutOfBounds`，它的 65 格一格都沒有算進去。分成四類：

| 類別 | 測試 | 為什麼紅 | 改成 |
|---|---|---|---|
| **commit 完就讀預留**（8 個） | `OrderFlowTest` 的 5 個、`OrderRaceRegressionTest` 的 2 個、`HotSettlementTest.cancelBeforeSettlement` | 付款、取消、出貨之後，預留是庫存模組收到事件才改的（4.6.1） | 讀預留之前，先把這幾張訂單的事件交給庫存模組的消費者（下面） |
| **一個設計上的洞**（2 個） | `HotSettlementTest.shipWaitsForSettlement`、`shortageBlocksShipThenCancels` | 出貨不再問庫存，第 12 站 7.6.4 的兩個「不」不見了 | **測試沒有改，程式改了**：出貨之前問一次（4.6.3） |
| **需求的意思變了**（1 個） | 驗收 `q1_transactionBoundary` | 「下單失敗時，訂單、明細、庫存異動三張表都沒有殘留」—— 留下一張 `REJECTED` 與它的兩筆明細 | 「沒有一張成立的訂單、庫存那一邊什麼都沒留下」（下面） |
| **清單與快照**（4 個類別） | `OrderStateMachineTest`、`ServiceRoleConsumersTest`、`CrossModuleCallInTxTest`、`OpenApiContractTest` | 8 × 13 的表、多一個消費者、交易內的跨模組呼叫少了 4 種、契約上的 enum 多了值 | 照著改；契約那一個是程式錯了（4.5.6 的 14 個值） |

第二次整套跑，又紅了一個：`OrderFlowTest.shipping` 數訂單的狀態歷史，期待 5 筆（下單、付款、撿貨、出貨、收貨），實際 6 筆 —— 下單現在是兩筆（`RESERVING`、`RESERVED`）。之後 V26 改成線上的寫法，`SchemaConstraintTest` 也紅了一格（4.5.6 的 ⚠️）。

**第一類的改法**：`InlineEvents`（第 12 站 7.12.1：不經過 broker，直接把 outbox 裡的事件交給消費者）多一個只交給某幾個消費者的版本 —— 這幾個測試要的是預留，不需要順便寄通知信：

```java
    /**
     * 13 站 4.6：只交給這幾個消費者（例如 inventory.order-events —— 付款、取消、出貨之後的庫存）。
     * 第 12 站的測試在付款、取消、出貨之後直接讀預留的狀態；改成事件之後要先交付，但不需要順便寄通知信
     */
    public static int deliverTo(ApplicationContext ctx, Predicate<OutboxStore.Row> which, String... consumers) {
        List<String> only = List.of(consumers);
        return deliver(ctx, which, h -> only.contains(h.consumer()));
    }
```

```java
    /**
     * 13 站 4.6 的追記：付款、取消、出貨之後，庫存那一半是庫存模組收到 order.paid、order.cancelled、order.shipped 才做的。
     * 第 12 站在同一個交易裡，所以這裡的測試一 commit 就讀預留；現在要先把這幾張訂單的事件交給庫存模組的消費者
     */
    void stockFollows() {
        com.example.shop.support.InlineEvents.deliverTo(ctx, com.example.shop.support.InlineEvents.ofOrders(
                jdbc.queryForList("SELECT id FROM orders WHERE buyer_id IN (?, ?)", Long.class, BUYER, OTHER_BUYER)), "inventory.order-events");
    }
…
        callback(pid, "tx-ok", "100", true, true);                           // 金流重送
        assertThat(status(no)).isEqualTo("PAID");
        assertThat(reservation(no)).isEqualTo("HELD");                       // 13 站 4.6：庫存還沒跟上
        stockFollows();
        assertThat(reservation(no)).isEqualTo("CONFIRMED");
```

付款回呼之後，`HELD` —— 庫存還沒跟上；交付之後，`CONFIRMED`。這一行 `HELD` 是這一章刻意加進去的：它把「最終一致」寫成一個斷言。

**驗收 Q1 的意思**：第 12 站的 Q1 是「一筆訂單的交易邊界」—— 下單失敗時，三張表都沒有殘留。現在下單是一個 Saga，它的邊界不再是一個交易；不變的是「沒有成立的訂單、庫存那一邊什麼都沒留下、冪等鍵放掉了、購物車沒有被清」：

```java
                // 13 站 4.5 的追記：下單是一個 Saga 之後，「三張表都沒有殘留」不再成立 —— 訂單在預留之前就寫下了（RESERVING），
                // 預留失敗之後變成 REJECTED，連同它的明細留在表上，買家看不到它（OrderRepository）。不變的是：沒有一張「成立的」訂單、
                // 庫存那一邊什麼都沒留下、冪等鍵放掉了、購物車沒有被清
                Map<String, Object> residue = jdbc.queryForMap("""
                        SELECT (SELECT COUNT(*) FROM orders WHERE buyer_id = ? AND status NOT IN ('RESERVING', 'REJECTED')) AS orders,
                               (SELECT COUNT(*) FROM order_items i JOIN orders o ON o.id = i.order_id
                                 WHERE o.buyer_id = ? AND o.status NOT IN ('RESERVING', 'REJECTED'))                     AS items,
                               (SELECT GROUP_CONCAT(status) FROM orders WHERE buyer_id = ?)                       AS statuses,
                               (SELECT COUNT(*) FROM inventory_reservations WHERE product_id IN (?, ?))          AS reservations,
                               (SELECT reserved FROM inventory WHERE product_id = ?)                              AS reserved_a,
                               (SELECT CONCAT(COUNT(*), '/', SUM(delta_reserved)) FROM inventory_ledger WHERE product_id = ?) AS ledger_a,
                               (SELECT COUNT(*) FROM idempotency_keys WHERE buyer_id = ?)                         AS idem_keys,
                               (SELECT COUNT(*) FROM cart_items WHERE buyer_id = ?)                               AS cart""",
                        buyer, buyer, buyer, a, b, a, a, buyer, buyer);
```

這是一個需求的改變，不是一個測試的修正：同一個請求（A 有貨、B 沒貨），第 12 站的訂單表一列都沒有，這一章有一列 `REJECTED`。要不要接受它，是產品的決定 —— 這一章接受，因為那一列是 Saga 的紀錄（4.7.1），而且使用者看不到它。

### 4.8.2 新的測試

| 測試 | 守什麼 |
|---|---|
| `PlaceOrderSagaTest`（5 個） | 下單 Saga 的五條路：成功、庫存不足的補償（含熱點閘門加回去）、回應丟了之後同一個鍵接著做、卡住的被排程補償、補償比預留先到（4.5、4.7.2） |
| `InventoryOrderEventsTest`（4 個） | 協同的每一步在任何順序下都收斂（4.6.2） |
| `AdminOrderSagaApiTest`（2 個） | 給值班的人看的 Saga（4.9） |
| `SchemaConstraintTest.orderStatusCheckIsDeliberatelyNotEnforced` | 訂單狀態的 CHECK 是刻意不檢查的（4.5.6） |
| `InventoryClientPactTest`（15 → 16 個互動） | 4.6.4 的表；提供端那一邊多一個 `@State`（「訂單 7005 的預留已經被補償」、「訂單 7006 的熱點預留落帳時不夠」） |
| `RemoteInventoryApiTest` | 改了三處：`confirm` 換成 `releaseAbandoned`、多一個「409 狀態不對照原樣交給呼叫端」 |

### 4.8.3 同樣的 kill -9，換成 Saga（E3）

E1 的同一套演練，換成這一章的程式碼。多兩個情況：①' 沒有人重送；①'' 預留的請求一到庫存服務，A 就被殺，那個請求被扣在門口，等補償做完才放行（`CrashPoint.hold`）：

```java
                if (arm.hold() != null) {
                    try {
                        arm.action().run();                                  // kill -9 呼叫端：這個請求已經離開了它
                        if (!arm.hold().await(120, TimeUnit.SECONDS)) throw new IllegalStateException("沒有人放行");
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                }
```

```bash
mvn test -Pexperiments -Dtest=E3SagaDrillTest
```

```
═══ 4.8.3 同樣的 kill -9，換成 Saga：訂單服務兩台（A、B）（load { 5.52 6.11 6.60 }）═══
  ⓪ 下單（熱點商品）：Redis 的閘門扣了 1 件之後，A 被 kill -9
     買家送到 A → 連線斷了：IOException（HTTP/1.1 header parser received no bytes）
     買家用同一個鍵重送，到了 B → 201 {"orderNo":"20261015-970355","status":"PENDING_PAYMENT","totalAmount":100.00,"createdAt":"2026-10-15T08:46:39.996Z","paymentDeadline":"2026-10-15T09:01:39.996Z"…
     之後：這位買家的訂單 PENDING_PAYMENT；閘門 Redis 9999998、MySQL 算出來 9999999（閘門在 Saga 的第一步之前：這一件要等熱點對帳）
  ① 下單：庫存服務的預留 commit 之後，A 被 kill -9（A 重新起來 5,205 ms）
     買家送到 A → 連線斷了：IOException（HTTP/1.1 header parser received no bytes）
     那一刻：這位買家的訂單 RESERVING；冪等鍵 SUCCEEDED → 訂單 2；商品 9000002 的 reserved +1
     買家用同一個鍵重送，到了 B → 200 {"orderNo":"20261015-481905","status":"PENDING_PAYMENT","totalAmount":100.00,"createdAt":"2026-10-15T08:46:46.868Z","paymentDeadline":"2026-10-15T09:01:46.868Z"…（39 ms）
     之後：這位買家的訂單 PENDING_PAYMENT；reserved +1（應該 +1）；沒有訂單的預留 0 筆
  ①' 同上，但買家沒有重送：A 重新起來（5,282 ms；排程每 10 秒，RESERVING 超過 5 秒就補償）
     買家送到 A → 連線斷了：IOException（HTTP/1.1 header parser received no bytes）
     那一刻：訂單 3 RESERVING；預留 HELD；reserved +1
     A 重新起來（5,685 ms）
     5,690 ms 之後：訂單 REJECTED（歷史 PLACE_ORDER → PLACEMENT_EXPIRED）；預留 RELEASED；reserved +0；這位買家的冪等鍵 0 個
  ①'' 預留的請求還在路上：一到庫存服務，A 就被 kill -9；請求扣在門口
     買家送到 A（熱點商品 + 一般商品）→ 連線斷了：IOException（HTTP/1.1 header parser received no bytes）
     那一刻：訂單 4 RESERVING；預留 （沒有）；閘門 Redis 9999998 → 9999997；MySQL 算出來 9999999（差的那一件是 ⓪ 留下的）
     A 重新起來（5,198 ms）
     6,417 ms 之後補償：訂單 REJECTED；processed_messages 裡這張訂單的預留那一列 1 筆；預留 （沒有）；閘門 Redis 9999998、MySQL 算出來 9999999
     晚到的預留 PUT /internal/inventory/v1/reservations/4 → 409；之後：預留 （沒有）；閘門 Redis 9999998、MySQL 算出來 9999999
  ② 逾時排程：A 重新起來，它的 relay 關著（5,459 ms）；訂單 20261015-345172 的付款期限改到過去
     A 的排程取消它、commit；A 被 kill -9。那一刻：訂單 CANCELLED；outbox 裡的 order.cancelled：1 筆、還沒送出的 0 筆（A 的 relay 關著）
     B 的 relay 讀的是同一個 outbox：送出之後，預留 RELEASED
     金流回呼到了 B → 200；訂單 CANCELLED
     賣家撿貨 → 409 {"type":"/problems/invalid-state","title":"目前的狀態不允許這個動作","status":409,"detail":"訂單目前的狀態（CANCELLED）不允許這個動作","instance":"/api/seller/orders/20261015-345172/start-…
     最後（B 的 relay 送出了 A 留下的事件）：訂單 CANCELLED；預留 RELEASED；付款 SUCCEEDED；退款 SUCCEEDED
  A 重新起來（5,968 ms），對帳的 grace 1 秒、每 10 秒一輪；等第一輪
     CROSS_RECONCILIATION 掃了 2 筆預留、2 張訂單（2 批，165 ms）：找到 0 張，釋放 0 張
     全部的預留：1 HELD、2 HELD、3 RELEASED、5 RELEASED；全部的訂單：1 PENDING_PAYMENT、2 PENDING_PAYMENT、3 REJECTED、4 REJECTED、5 CANCELLED
  （結束時 load { 6.24 6.30 6.63 }）
```

| | E1（第 03 章的程式碼） | E3（這一章） |
|---|---|---|
| ⓪ 閘門扣了之後 | Redis 比 MySQL 少 1 件 | **一樣**：閘門在 Saga 的第一步之前（4.5.2） |
| ① 預留 commit 之後，買家重送 | 409 三十秒，之後一張新的訂單；`reserved` +2、孤兒 1 筆 | **200，39 ms**：同一張訂單；`reserved` +1、孤兒 0 筆 |
| ①' 沒有人重送 | （E1 沒有這一格：第 02 章的對帳 5 分鐘後收孤兒） | A 重新起來的那一輪排程就補償了：`REJECTED`、預留 `RELEASED`、鍵放掉 |
| ①'' 預留晚到 | （第 03 章沒有補償，晚到的預留就是一筆孤兒） | 補償先佔位；晚到的預留 409，什麼都沒留下；熱點閘門加回去了 |
| ② 逾時取消之後當掉，付款先到 | 已付款、預留已釋放、出不了貨、不會被取消 | 取消先 commit（連同 `order.cancelled`），B 的 relay 送出它；付款晚到 → 退款；賣家撿貨 409 |
| 對帳 | X-1 一張（自動釋放）、X-3 一張（要人看） | 0 張 |

②那一列要多說一句：A 的 relay 是關著的，`order.cancelled` 卻在殺掉的那一刻就已經送出了 —— **兩台訂單服務讀的是同一個 outbox**，B 的 relay 把它送出去。這就是 4.4.1 的第一條：下一步要做什麼，跟這一步一起 commit 在資料庫裡，誰活著誰就接著做。

---

## 4.9 卡在中間的訂單：可觀測性、人工介入、對帳

一個 Saga 可能停在哪裡、誰會發現：

| 停在 | 發現它的 | 自己會好嗎 |
|---|---|---|
| `RESERVING`（協調者不見了、預留沒有回應） | 排程（`expirePlacements`）；指標 `shop.orders.rejected{reason=PLACEMENT_EXPIRED}` | 會：60 秒後補償 |
| 事件還在 outbox（relay 停了、broker 不能用） | 第 12 站 9.10 的 outbox 積壓告警 | broker 回來就會 |
| 事件在佇列裡失敗（消費者丟例外） | 第 12 站 7.5.3 的重試階梯；`shop.events.dead_lettered` | 重試成功就會；進了死信，要有人重放（第 12 站 7.5.5 的 `POST /api/admin/dead-letters/{consumer}/replay`） |
| 出庫時發現預留已經釋放 | `shop.inventory.consume.conflict`、一行 ERROR | **不會**：貨出去了，帳對不上，要有人去看倉庫（4.6.3 的「不應該發生」） |
| 兩邊的狀態對不上，而且比 grace 舊 | 第 02 章的對帳（X-1～X-5） | X-1、X-2 會（自動釋放）；其他的要人 |

前四種，自己都有一個指標或一個排程。**缺的是值班的人被叫起來之後，看一張訂單要看哪裡**：訂單服務的庫（狀態、歷史、outbox）、庫存服務的庫（預留）—— 切開之後是兩個庫、兩個帳號。這一章加一支給管理員的唯讀 API，一個請求看完：

```java
/**
 * 13 站 4.9：一張訂單的 Saga 走到哪裡了 —— 值班的人一個請求看完，不用自己去兩個庫各查一次。
 *   訂單這一邊：狀態、歷史（誰、什麼時候、哪一個事件）、outbox（這張訂單發過哪些事件、送出去了沒有 —— 問 Outbox，那是 shared 的表）
 *   庫存那一邊：這張訂單的預留（InventoryApi.reservationsOf —— 切開的部署是一次 HTTP）
 *   對得上嗎：第 02 章 2.5.2 那張表（訂單的狀態 → 預留應該是什麼）。對不上不一定是錯：事件可能還在路上（4.6）
 * 只讀。要動手（重放死信、補償），是另外的事（4.9）。
 */
@Service
public class OrderSagaView {

    public record SagaStep(Instant at, String from, String to, String event, String actor) {}
    public record SagaEvent(Instant at, String type, Instant publishedAt) {}
    public record SagaReservation(long productId, int quantity, String status) {}
    public record SagaView(String orderNo, OrderStatus status, List<SagaStep> history, List<SagaEvent> events, List<SagaReservation> reservations,
                       Set<String> expectedReservation, boolean consistent) {}

    private final JdbcTemplate jdbc;
    private final Outbox outbox;
    private final InventoryApi inventory;

    OrderSagaView(JdbcTemplate jdbc, Outbox outbox, InventoryApi inventory) {
        this.jdbc = jdbc;
        this.outbox = outbox;
        this.inventory = inventory;
    }

    public SagaView of(String orderNo) {
        List<Map<String, Object>> rows = jdbc.queryForList("SELECT id, status FROM orders WHERE order_no = ?", orderNo);
        if (rows.isEmpty()) throw ShopException.notFound("訂單");
        long id = ((Number) rows.get(0).get("id")).longValue();
        OrderStatus status = OrderStatus.valueOf((String) rows.get(0).get("status"));
        List<SagaStep> history = jdbc.query("""
                SELECT created_at, from_status, to_status, event, CONCAT(actor_type, COALESCE(CONCAT(' ', actor_id), '')) FROM order_status_history
                 WHERE order_id = ? ORDER BY id""", (rs, i) -> new SagaStep(rs.getTimestamp(1).toInstant(), rs.getString(2), rs.getString(3),
                rs.getString(4), rs.getString(5)), id);
        List<SagaEvent> events = outbox.recorded("ORDER", id).stream().map(e -> new SagaEvent(e.at(), e.eventType(), e.publishedAt())).toList();
        List<SagaReservation> reservations = inventory.reservationsOf(List.of(id)).getOrDefault(id, List.of()).stream()
                .map((ReservationRef r) -> new SagaReservation(r.productId(), r.quantity(), r.status())).toList();
        Set<String> expected = expected(status) == null ? null : new java.util.TreeSet<>(expected(status));   // 排序過：回應裡的順序每一次都一樣
        boolean consistent = expected == null || reservations.stream().allMatch(r -> expected.contains(r.status()))
                && (!reservations.isEmpty() || expected.contains("（沒有）"));
        return new SagaView(orderNo, status, history, events, reservations, expected, consistent);
    }

    /** 第 02 章 2.5.2：訂單的狀態 → 它的每一筆預留應該是什麼。RESERVING：Saga 還在走，什麼都可能（null = 不判斷） */
    static Set<String> expected(OrderStatus s) {
        return switch (s) {
            case RESERVING -> null;
            case PENDING_PAYMENT -> Set.of("HELD");
            case PAID, PICKING -> Set.of("CONFIRMED");
            case SHIPPED, COMPLETED -> Set.of("CONSUMED");
            case CANCELLED, REJECTED -> Set.of("RELEASED", "（沒有）");
        };
    }
}
```

⚠️ **第一版直接讀 `outbox_events`**（一句 `SELECT … FROM outbox_events WHERE aggregate_type = 'ORDER' …`）。單獨跑它自己的測試是綠的；整套 `mvn clean verify` 的時候，第 12 站的 `TableOwnershipTest` 紅了：「ordering 模組讀取了 shared 模組的表 `outbox_events`（OrderSagaView.java:49）」。`outbox_events` 是 `shared.events` 的表 —— 要知道「我的事件送出去了沒有」，問 `Outbox`：

```java
    /** 一則記下的事件：什麼時候記的、哪一種、送出去了沒有（publishedAt = null：還在 outbox 裡） */
    record Recorded(java.time.Instant at, String eventType, java.time.Instant publishedAt) {}

    /**
     * 13 站 4.9：某一個 aggregate 記過哪些事件、送出去了沒有，依記下的順序（給人看的：OrderSagaView）。
     * outbox_events 是 shared 的表 —— 別的模組要知道「我的事件送出去了沒有」，問這裡，不直接讀表（第 12 站 TableOwnershipTest）
     */
    java.util.List<Recorded> recorded(String aggregateType, long aggregateId);
```

```bash
mvn test -Dtest=AdminOrderSagaApiTest
```

```
4.9 被拒絕的下單：買家查 → 404；管理員：REJECTED；歷史 PLACE_ORDER RESERVE_FAILED ；事件 order.rejected（還沒送） ；預留 ；應該是 ["RELEASED","（沒有）"]、對得上 true
4.9 取消之後：CANCELLED；歷史 PLACE_ORDER RESERVED BUYER_CANCEL ；事件 order.placed（還沒送） order.cancelled（還沒送） ；預留 HELD ；應該是 ["RELEASED","（沒有）"]、對得上 false
4.9 庫存跟上之後：CANCELLED；歷史 PLACE_ORDER RESERVED BUYER_CANCEL ；事件 order.placed（已送） order.cancelled（已送） ；預留 RELEASED ；應該是 ["RELEASED","（沒有）"]、對得上 true
```

「取消之後」那一行：買家取消了，訂單 `CANCELLED`、`order.cancelled` 還沒送出、預留還是 `HELD` —— 「對不上」。但這不一定是錯：事件還在路上。下一行，交付之後就對得上了。**「對不上」加上「事件還沒送出、或者送出了很久」，才是要人看的訊號**；這支 API 把兩樣都擺在一起，判斷留給人。

被補償掉的下單（`REJECTED`），買家查是 404，管理員看得到 —— 值班的人要的正是這些。API 契約的快照多了這一支路由與四個 `Saga*` 元件；管理員看到的 `status` 是全部八個值（買家看到的 `OrderView` 還是六個）。

`OrderTransitionService` 多一個計數器（4.5.4 的 diff 裡）：`shop.orders.rejected{reason}`。`RESERVE_FAILED`（庫存不足）是正常的業務；`PLACEMENT_EXPIRED` 變多，代表停在中間的 Saga 變多 —— 協調者當掉、或庫存服務沒有回應。這一章沒有替它設告警的門檻（第 07 章的事）。

**對帳在 Saga 裡的位置。** 第 02 章的對帳是「拆開之後，沒有交易保證兩邊一致，所以事後檢查」。Saga 之後，兩邊會一致 —— **最終**。那麼對帳在檢查什麼？它檢查的是**最終沒有發生**的那一些：事件卡住了、消費者有 bug、有人手動改了資料。所以它的 grace 有了另一個意思：比 grace 新的不一致是「還在路上」，比 grace 舊的是「卡住了」。對帳的分類多兩條：

```java
 * 訂單的狀態 → 它的預留應該是什麼（2.5.2）：
 *   不存在、CANCELLED    → 沒有，或 RELEASED
 *   REJECTED             → 沒有，或 RELEASED（13 站 4.5：下單的 Saga 被補償了）
 *   RESERVING            → 不檢查：下單的 Saga 還在走（卡太久的由 OrderJobs.expirePlacements 收）
 *   PENDING_PAYMENT      → HELD
 *   PAID、PICKING        → CONFIRMED
 *   SHIPPED、COMPLETED   → CONSUMED
 *
 * 兩個方向各掃一次（keyset 分頁，一批 500）：
 *   ① 庫存那一邊還佔著（HELD、CONFIRMED）的預留 → 它的訂單
 *   ② 訂單這一邊還沒結束（PENDING_PAYMENT、PAID、PICKING）的訂單 → 它的預留
 * 只有 X-1、X-2 自動修（釋放）：訂單不存在或已取消，沒有人會再用到那些庫存。其他的只告警 —— 要不要重新預留、要不要取消一張已付款的訂單，
 * 是人的決定（2.6.4）。
 * 比 grace 新的都不看：下單的交易可能還沒 commit（2.6.1）、熱點落帳的事件可能還在路上（第 12 站 7.6）。
 * 13 站 4.6 之後多一種「還在路上」：確認、釋放、出庫都是庫存模組收到訂單的事件之後才做 —— 取消之後的幾百毫秒，預留還是 HELD，那是正常的。
 * 比 grace 舊還是這樣，代表事件卡住了（broker、消費者、死信），這時候對帳才是最後一道防線。
```

E1 的最後，對帳找到兩張（X-1 一張、X-3 一張）；E3 的最後，0 張。**對帳變安靜，不代表它不用跑了**：它是最後一道防線，要在其他每一道都失效的那一天，還找得到東西。

---

## 4.10 流程測試與追溯表

### 4.10.1 這一章新增的測試與實驗

| 名稱 | 種類 | 跑在哪裡 | 量／守什麼 |
|---|---|---|---|
| `PlaceOrderSagaTest` | **測試**（預設） | Testcontainers；單體 | 下單 Saga 的五條路（4.5、4.7.2） |
| `InventoryOrderEventsTest` | **測試** | 同上 | 協同的每一步在任何順序下都收斂（4.6.2） |
| `AdminOrderSagaApiTest` | **測試** | 同上 | 給值班的人看的 Saga（4.9） |
| `SchemaConstraintTest` | 測試（改） | 同上 | 少一格、多一個：訂單狀態的 CHECK 刻意不檢查（4.5.6） |
| 第 12 站的 8 個類別 | 測試（改） | 同上 | 4.8.1 |
| `InventoryClientPactTest` | 測試（改） | Pact 的 mock server | 15 → 16 個互動（4.6.4） |
| `E1CrashTest` | 實驗 | 庫存服務在這個 JVM，訂單服務兩台在另外的 JVM | 第 03 章的程式碼，`kill -9` 在兩個 commit 之間（4.2）—— `d04` 的第一個 commit |
| `E2TwoPhaseCommitTest` | 實驗 | 兩個庫、JDBC | XA 的代價、協調者在 PREPARE 之後當掉（4.3） |
| `E3SagaDrillTest` | 實驗 | 同 E1 | 同樣的 `kill -9`，換成 Saga（4.8.3） |
| `E4SagaDayTest` | 實驗 | 兩個服務、正式的角色；事件走 RabbitMQ | 使用者的一天、打庫存服務幾次（4.10.2） |
| `E5SagaCostTest` | 實驗 | 單體、切開的訂單服務在這個 JVM，庫存服務在另一個 | Saga 的代價，與第 03 章的流程交錯量（4.10.3） |
| `E6NewStatusCostTest` | 實驗 | 兩份 10 萬張訂單的複本 | migration 與報表 SQL 的代價（4.5.6） |

E5 的「第 03 章的流程」在測試程式碼裡（`LegacyPlaceOrder`，`lab.d04.flow-switch=true` 才存在）：請求帶 `X-Lab-Flow: legacy` 就走第 03 章的那一個交易，其他的走 `src/main` 的 Saga。同一個行程、同一次執行裡交錯量 —— 不同的版本放在不同次的執行裡比，差的往往是機器那一刻的狀態（第 01 章 1.8.2）。

### 4.10.2 使用者的一天（E4）

第 01 章 1.4.4 的使用者的一天，跑在這一章的 Saga 上：兩個服務、正式的角色、事件走 RabbitMQ（第 03 章 D4 的做法），再數訂單服務打了庫存服務幾次（第 03 章 D2 的 `CallTap`）：

```bash
mvn test -Pexperiments -Dtest=E4SagaDayTest
```

```
═══ 4.10.2 使用者的一天，Saga、事件走 RabbitMQ：兩個服務、正式的角色（load { 6.38 6.33 6.64 }）═══
  每一個佇列的消費者數：{shop.inventory.hot-settlement=2, shop.inventory.hot-stock-return=2, shop.inventory.order-events=2, shop.inventory.product-created=2, shop.notification.order-events=2, shop.ordering.stock-shortage=2, shop.payment.refunds=2}
  使用者的一天：61 個 HTTP 請求全部是預期的回應；等事件 21 次、一共 2,883 ms；整天 27,667 ms
  訂單服務 → 庫存服務：30 次 HTTP、8 種端點（第 03 章：38 次、10 種）
    DELETE /api/cart/items/{productId} → GET /internal/inventory/v1/stock                                × 1
    GET /api/cart → GET /internal/inventory/v1/stock                                                     × 1
    GET /api/products/{id} → GET /internal/inventory/v1/stock/{n}/display                                × 2
    GET /api/seller/products → GET /internal/inventory/v1/stock                                          × 1
    PATCH /api/cart/items/{productId} → GET /internal/inventory/v1/stock                                 × 1
    PATCH /api/seller/products/{id} → GET /internal/inventory/v1/stock                                   × 1
    POST /api/cart/items → GET /internal/inventory/v1/stock                                              × 3
    POST /api/orders → POST /internal/inventory/v1/hot-gate                                              × 2
    POST /api/orders → PUT /internal/inventory/v1/reservations/{n}                                       × 6
    POST /api/seller/orders/{orderNo}/ship → GET /internal/inventory/v1/reservations/{n}/shippable       × 2
    POST /api/seller/products/{id}/hot → GET /internal/inventory/v1/stock                                × 1
    POST /api/seller/products/{id}/hot → PUT /internal/inventory/v1/products/{n}/hot                     × 1
    POST /api/seller/products/{id}/publish → GET /internal/inventory/v1/stock                            × 4
    POST /api/seller/products/{id}/restock → GET /internal/inventory/v1/stock                            × 1
    POST /api/seller/products/{id}/restock → POST /internal/inventory/v1/products/{n}/restocks           × 1
    POST /api/seller/products/{id}/unpublish → GET /internal/inventory/v1/stock                          × 1
    排程 ReservationReconciliation.run → GET /internal/inventory/v1/reservations                           × 1
  消費者                         │ 訂單服務：成功 / 失敗後重試 / 送進死信 │ 庫存服務：成功 / 失敗後重試 / 送進死信 │ 死信佇列
  inventory.hot-settlement       │        0 /          0 /        0 │        6 /          0 /        0 │     0
  inventory.hot-stock-return     │        0 /          0 /        0 │        4 /          0 /        0 │     0
  inventory.order-events         │        0 /          0 /        0 │       10 /          0 /        0 │     0
  inventory.product-created      │        0 /          0 /        0 │        4 /          0 /        0 │     0
  notification.order-events      │       18 /          0 /        0 │        0 /          0 /        0 │     0
  ordering.stock-shortage        │        1 /          0 /        0 │        0 /          0 /        0 │     0
  payment.refunds                │        2 /          0 /        0 │        0 /          0 /        0 │     0
  shop_d02_order  outbox：送出 26 筆、還沒送 0 筆；processed_messages 1 列 {ordering.stock-shortage=1}
  shop_d02_inv    outbox：送出 5 筆、還沒送 0 筆；processed_messages 31 列 {inventory.hot-settlement=6, inventory.hot-stock-return=4, inventory.http.reserve=6, inventory.http.restock=1, inventory.order-events=10, inventory.product-created=4}
  訂單：1 COMPLETED、2 CANCELLED、3 CANCELLED、4 CANCELLED、5 COMPLETED、6 CANCELLED；預留：1 CONSUMED、1 CONSUMED、2 RELEASED、3 RELEASED、4 RELEASED、5 CONSUMED、6 RELEASED
  （結束時 load { 4.51 5.84 6.44 }）
```

| | 第 03 章（D2、D4） | 這一章 |
|---|---|---|
| 61 個請求 | 全部是預期的回應 | 全部是預期的回應 |
| 訂單服務 → 庫存服務 | 38 次 HTTP、10 種端點 | **30 次、8 種** |
| 少掉的 | | `…/confirm` × 4（付款回呼）、`…/release` × 4（買家取消、賣家取消、熱點落帳失敗之後的取消、逾時取消） |
| 換掉的 | `…/consume` × 2（寫，在出貨的交易裡） | `…/shippable` × 2（讀，在任何交易之外） |
| 庫存服務收的事件 | 14 個 | **24 個**（多了 `inventory.order-events` 的 10 個：4 次付款、4 次取消、2 次出貨） |
| 庫存服務的 `processed_messages` | 21 列 | 31 列 |

**少的是寫，多的是事件。** 第 03 章的 38 次裡，16 次是下單、付款、取消、出貨、逾時這幾個交易**裡面**對庫存服務的寫（預留 6、確認 4、釋放 4、出庫 2）；這一章是 6 次預留，而且都不在任何一個交易裡。確認、釋放、出庫變成 10 個事件，訂單服務的交易一 commit 就結束，不等任何人。

### 4.10.3 Saga 的代價（E5）

下單從「一個交易」變成「三個交易，中間一次預留」。多兩次 commit，是要付錢的：

```bash
mvn test -Pexperiments -Dtest=E5SagaCostTest
```

```
═══ 4.10.3 Saga 的代價：一張一張送，每格 3 輪 × 100 張、交錯（load { 4.64 5.81 6.42 }）═══
   1 個品項 │ 單體 │ 第 03 章 p50  11.90 ms p99   87.48 ms │ Saga p50  16.96 ms p99   42.17 ms │ p50 差  +5.06 ms
   1 個品項 │ 切開 │ 第 03 章 p50  17.89 ms p99   45.44 ms │ Saga p50  20.16 ms p99   39.44 ms │ p50 差  +2.26 ms
  10 個品項 │ 單體 │ 第 03 章 p50  20.87 ms p99   89.63 ms │ Saga p50  24.51 ms p99   77.93 ms │ p50 差  +3.64 ms
  10 個品項 │ 切開 │ 第 03 章 p50  27.83 ms p99   67.91 ms │ Saga p50  28.68 ms p99   65.47 ms │ p50 差  +0.85 ms
═══ 4.10.3 16 條執行緒同時送 3 個品項的訂單：每格 3 輪 × 4 秒、交錯（load { 4.46 5.59 6.29 }）═══
  單體 │ 第 03 章 │ 每秒 272 / 318 / 351 張 │ p50  46.80 ms │ p99  117.54 ms │ 不是 201 的 0 張
  單體 │ Saga   │ 每秒 227 / 264 / 285 張 │ p50  57.18 ms │ p99  149.05 ms │ 不是 201 的 0 張
  切開 │ 第 03 章 │ 每秒 202 / 242 / 226 張 │ p50  65.99 ms │ p99  194.47 ms │ 不是 201 的 0 張
  切開 │ Saga   │ 每秒 191 / 206 / 220 張 │ p50  70.88 ms │ p99  171.36 ms │ 不是 201 的 0 張
  （結束時 load { 10.96 7.14 6.82 }）
```

這一段的 load 一直在 4.5～11（這台機器同時還有別的程式在跑），所以看三次執行的範圍，不看單一個數字：

| | 第 1 次 | 第 2 次 | 第 3 次（上面那一份） |
|---|---|---|---|
| 單體、1 個品項，p50 多了 | +4.16 ms | +4.70 ms | +5.06 ms |
| 切開、1 個品項 | +2.19 ms | +3.60 ms | +2.26 ms |
| 單體、10 個品項 | +4.53 ms | +4.76 ms | +3.64 ms |
| 切開、10 個品項 | +0.81 ms | +0.42 ms | +0.85 ms |
| 單體，16 條執行緒的吞吐 | 278～374 → 229～252 張／秒 | 281～319 → 232～257 | 272～351 → 227～285 |
| 切開，16 條執行緒的吞吐 | 191～248 → 188～234 | 205～259 → 178～201 | 202～242 → 191～220 |

（第 1 次的時候，T3 還把明細讀兩次（4.5.4）；第 2、3 次是改成讀一次之後。第 1 次之前還有一次，第 03 章的流程在撞號時直接 500 —— 下面的 ⚠️。）

- **單體：每張多 4～5 ms，吞吐少一到兩成。** 多出來的就是兩次 commit：T1 一次、預留自己一次（第 03 章的單體裡，預留在下單的交易裡、不用自己 commit）。這台 MySQL 每一次 commit 都要 fsync（4.3.2）。**如果系統不拆，這是白付的錢** —— 第 00 章的結論是這個系統不該拆；這一站是練習台。
- **切開：多得少，10 個品項時幾乎沒有差別。** 第 03 章的流程，預留本來就是一次 HTTP、庫存服務自己的交易；Saga 多的只是 T1 的那一次 commit。另一面是：遠端呼叫不再佔著訂單服務的交易（第 00 章 0.2.3 的級聯，第 06 章會量）。
- 吞吐那幾格，三次的範圍彼此重疊得不少，尤其是切開的部署。能說的只有方向：單體明顯變少，切開的少一點點或差不多。

⚠️ **E5 的第一版，第 03 章的流程有 21 張 500**：訂單編號撞號（`Duplicate entry … for key 'orders.uk_orders_order_no'`）。第 03 章的 `PlaceOrderService` 撞號會換一個號碼重來（第 12 站 2.4.4），我把它抄進 `LegacyPlaceOrder` 時漏了那個迴圈 —— 第 03 章的流程因此被少算了一些。補上之後 0 張；上面三次都是補上之後的。一次跑上萬張訂單，同一天的隨機 6 位數撞號的機會就不小（第 12 站估的「一天約 12 次」是正常的流量）。

### 4.10.4 B1 重跑

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
     8 │ catalog+inventory                   │          0 │          0 │        8 │        1 │    5 │  25.0%（9）
     9 │ catalog+inventory+notification      │          0 │          0 │        8 │        1 │   10 │  25.0%（9）
    10 │ account+catalog+inventory           │          0 │          0 │        8 │        2 │    5 │  27.8%（10）
    11 │ account+catalog+inventory+notification │          0 │          0 │        8 │        2 │   10 │  27.8%（10）
    12 │ account+catalog+inventory+reporting │          0 │          0 │        8 │        3 │    5 │  27.8%（10）
    16 │ catalog                             │          0 │          1 │        7 │        1 │    1 │  25.0%（9）
    24 │ inventory                           │          0 │          1 │        9 │        0 │    6 │  22.2%（8）
    32 │ cart                                │          1 │          1 │        3 │        0 │    0 │  11.1%（4）
    64 │ payment                             │          3 │          4 │        4 │        1 │    1 │  19.4%（7）
  （127 種全部：target/d01-cuts.txt）
```

```
═══ 1.5 切出 inventory：切斷了什麼 ═══
  切斷的交易：
  交易內的同步呼叫：
    catalog → InventoryApi.setHot
  所有同步呼叫：
    cart → InventoryApi.available
    catalog → InventoryApi.available
    catalog → InventoryApi.availableForDisplay
    catalog → InventoryApi.restock
    catalog → InventoryApi.setHot
    ordering → InventoryApi.activeReservations
    ordering → InventoryApi.checkShippable
    ordering → InventoryApi.gateHot
    ordering → InventoryApi.reserve
  直接讀表：
  跨過去的事件：
    inventory.hot-settlement-failed → ordering.stock-shortage
    order.cancelled → inventory.order-events
    order.paid → inventory.order-events
    order.placed → inventory.hot-settlement
    order.shipped → inventory.order-events
    product.created → inventory.product-created
  變更耦合：8／36 個 commit（22.2%）
```

| | 第 02 章之後 | 第 03 章之後 | 第 04 章之後 |
|---|---|---|---|
| inventory 這一刀的名次 | 第 80 | 第 80 | **第 24** |
| 切斷的交易 / 交易內呼叫 / 同步呼叫 / 直接讀表 / 事件 | 6 / 6 / 12 / 0 / 3 | 6 / 5 / 11 / 0 / 3 | **0** / **1** / **9** / 0 / **6** |
| catalog+inventory | 第 64 | 第 64 | **第 8** |

**切斷的交易：0。** 第 01 章用三把尺量出庫存這一刀切斷 7 種交易；第 02 章修了 1 種（建立商品），這一章修了其他 6 種。剩下的那一個交易內呼叫是 `catalog → InventoryApi.setHot` —— 熱點旗標（第 03 章 3.4.7），這一章也沒有動它。同步呼叫從 11 種變成 9 種：少了 `confirm`、`consume`、`release`，多了 `checkShippable`（讀）。事件從 3 種變成 6 種：多的就是庫存模組聽的那三種訂單事件。

第 01 章 1.5.4 說過：「練習台要選最難的那一個；決策要選最便宜的那一個。」庫存這一刀到了第 24 名，仍然在 notification（第 1 名）之後很遠 —— **它變便宜，是因為這四章付了錢**，不是因為它本來就便宜。

### 4.10.5 追溯表：這一站的產出

| README 的產出 | 第 00～02 章 | 第 03 章 | 第 04 章加上的 |
|---|---|---|---|
| 1. 拆分決策文件 | 不該拆；四個代價；第一刀切 notification；資料的三個階段 | 每一條線同步還是非同步 | 2PC 不選的理由（4.3）；6 種交易各用編排還是協同（4.4.4）；Saga 在單體裡的代價（4.10.3） |
| 2. 庫存拆成獨立服務、下單改成 Saga | 兩種部署、獨立的資料庫、對帳 | 正式的服務、可以安全重送的寫入、契約測試 | **Saga**：下單的編排、四種動作的協同；補償與「補償不回來的操作清單」（4.7.3）；**一次注入失敗的演練**（E1 → E3：`kill -9`，最終狀態怎麼收斂）；**拆分前後的下單延遲**（E5：p50 / p99） |
| 3. 跨服務報表 | 庫存這一刀不切斷報表 | （沒有變） | 新的狀態漏進報表：「訂單數」要排除它們，覆蓋索引變成回表（4.5.6） |
| 4. 一條完整的 trace | K5 | （沒有量） | （沒有量；第 07 章） |
| 5. 基礎設施選型 | 維運清單 | 一個 jar、三種角色 | 一個不能在線上跑的 migration 與它的線上版（4.5.6）；給值班的人的 API（4.9） |

📌 **第 04 章寫完之後的追記**：第 2 列的「拆分前後的下單延遲」與第 00 章的四個代價，在真的線上重跑了（4.10.7）；第 4 列的 trace 量了一半（4.10.7 的 K5：送的那一邊好了）。

### 4.10.6 追記：第 02 章的六個情境，換成 Saga（E7）

📌 **第 04 章寫完之後補的。** 第 02 章 2.5.3 的 C2 讓訂單服務的交易在遠端呼叫**之後**失敗，再看使用者的下一步會不會收斂：六個情境裡兩個不會 —— S3'（已付款的取消做了一半，賣家接著撿貨、出貨：409，訂單永遠卡在撿貨中）、S4'（出貨做了一半，賣家改成取消：帳上少 1 件，對帳也找不到）。那一章寫的修法是「第 04 章的 Saga」，這一章寫完的時候卻沒有回頭量。

E7 用**同一個**失敗的注入（`Ops` 的 trigger：寫訂單狀態歷史的那一句被拒絕）、同樣的六個情境、同樣的下一步。差別只在部署：兩個服務用正式的角色（第 03 章 3.7）、事件走 RabbitMQ，每一步之後等事件都送完（`Flow.quiet`）再看兩個庫。最後跑一輪對帳（grace 0：剛建立的預留也看）：

```bash
mvn test -Pexperiments -Dtest=E7BrokenTransactionsAgainTest
```

```
═══ 第 02 章 2.5.3 的六個情境，換成 Saga：訂單服務的交易在最後一句失敗，事件走 RabbitMQ（load { 11.31 11.97 10.64 }）═══
  情境                         │ 回應 │ 訂單            │ 預留       │ 庫存 on_hand / reserved │ 付款 / 退款單
  S1 下單                        │  500 │ RESERVING       │ HELD       │ 100 / 1                 │ — / 0
     同一個鍵重送                    │  200 │ PENDING_PAYMENT │ HELD       │ 100 / 1                 │ — / 0
  S2 付款回呼                      │  500 │ PENDING_PAYMENT │ HELD       │ 100 / 1                 │ PENDING / 0
     金流重送同一個回呼                 │  200 │ PAID            │ CONFIRMED  │ 100 / 1                 │ SUCCEEDED / 0
  S3 買家取消（已付款）                 │  500 │ PAID            │ CONFIRMED  │ 100 / 1                 │ SUCCEEDED / 0
     買家再按一次取消                  │  200 │ CANCELLED       │ RELEASED   │ 100 / 0                 │ SUCCEEDED / 1
  S3' 買家取消（已付款）                │  500 │ PAID            │ CONFIRMED  │ 100 / 1                 │ SUCCEEDED / 0
     賣家沒注意到，開始撿貨               │  200 │ PICKING         │ CONFIRMED  │ 100 / 1                 │ SUCCEEDED / 0
     出貨                        │  200 │ SHIPPED         │ CONSUMED   │ 99 / 0                  │ SUCCEEDED / 0
  S4 出貨                        │  500 │ PICKING         │ CONFIRMED  │ 100 / 1                 │ SUCCEEDED / 0
     賣家再按一次出貨                  │  200 │ SHIPPED         │ CONSUMED   │ 99 / 0                  │ SUCCEEDED / 0
  S4' 出貨                       │  500 │ PICKING         │ CONFIRMED  │ 100 / 1                 │ SUCCEEDED / 0
     賣家以為沒出成，改成取消              │  200 │ CANCELLED       │ RELEASED   │ 100 / 0                 │ SUCCEEDED / 1
  S5 逾時排程                      │    — │ PENDING_PAYMENT │ HELD       │ 100 / 1                 │ — / 0
     排程的下一輪                    │    — │ CANCELLED       │ RELEASED   │ 100 / 0                 │ — / 0
  S5' 逾時排程：第一張（失敗）             │    — │ PENDING_PAYMENT │ HELD       │ 100 / 1                 │ — / 0
      第二張（沒有注入失敗）              │    — │ CANCELLED       │ RELEASED   │ 100 / 0                 │ — / 0
  對帳（ReservationReconciliation）：Result[reservationsScanned=3, ordersScanned=3, batches=2, findings=[], released=0, millis=39, inventorySideMillis=28, orderSideMillis=6]
  （結束時 load { 8.82 11.36 10.46 }）
```

（跑了兩次，每一格都一樣。）

**每一個情境的第一行，回應仍然是 500** —— 失敗的注入還在，使用者看到的一樣。差別在看不到的地方：第 02 章的第一行，庫存那一邊已經變了（預留、確認、釋放、出庫都 commit 了），訂單沒變；這一章的第一行，**兩邊都沒變**（S1 除外）。付款、取消、出貨、逾時的交易裡已經沒有遠端呼叫（4.6）：訂單的狀態與「通知庫存的那一則事件」在同一個交易裡寫進 outbox，rollback 就兩個都沒有。

- **S1**：預留在 T3 之前就 commit 了（T2 是樞紐），T3 寫歷史失敗 → 訂單停在 `RESERVING`、預留 `HELD`。同一個鍵重送 → 接著做**同一張**（4.5.4 的 `advance`）→ `PENDING_PAYMENT`，`reserved` 只多 1。回應是 200 不是 201：同一個鍵、同一張訂單（第 12 站 4.5.1 的 AC-1）。第 02 章：一張新的訂單、一筆孤兒預留。
- **S3'**：取消的交易失敗 → 訂單仍是 `PAID`、預留 `CONFIRMED`；賣家撿貨、出貨都成功，庫存照常出庫。兩邊一致 —— 取消**沒有發生**，買家看到的是那一次的 500，要不要再按一次是買家的事。第 02 章：出貨 409、訂單永遠卡在撿貨中。
- **S4'**：出貨的交易失敗 → 什麼都沒出庫（`order.shipped` 沒有寫進 outbox，庫存模組什麼都沒收到）；賣家改成取消 → `CANCELLED`、`RELEASED`、退款單。第 02 章：`CONSUMED`、`on_hand` 少 1 件。

**第 02 章 2.6.4「對帳漏了一種」的那一種，不會再出現了** —— 不是因為對帳變聰明了，是因為步驟的順序變了：出庫只會在 `SHIPPED` commit **之後**、收到 `order.shipped` 才做。「出庫了、訂單卻沒出貨」需要先有一則 `order.shipped`，而它跟 `SHIPPED` 在同一個交易裡。

### 4.10.7 追記：回頭量 —— 第 00 章的四個代價，在真的線上（E9）

📌 **第 04 章寫完之後補的。** 第 00 章說「0.2 的實驗支架會一直留著：每一章改完，都回來量同樣的四個代價」。第 01、02 章照做了（1.8.2、2.9.2）；第 03、04 章沒有 —— 那時候 K1～K5 的支架（`LabInventoryService`：一支 `POST /lab/inventory/reserve`，只有預留與可售量走 HTTP）已經不是正式程式碼的那一條線了（第 03 章的限制清單：「K1～K5 沒有重跑」）。

E9 用正式的角色（第 03 章 3.7）、這一章的 Saga，重做 K1、K2、K3、K5（K4 是量變更耦合的腳本，跟部署無關），參數照第 00 章：

- **K1** 單體 vs 切開：一張一張送 1、3、10 個品項（每格 3 輪 × 100 張、交錯），16 條執行緒同時送 3 個品項（每格 3 輪 × 5 秒、交錯）。切開的庫存服務在另一個 JVM（第 00 章的做法）。
- **K2** ① 預留之後的那一步失敗 × 100 —— 第 00 章是「`reserve()` 之後、下單交易 commit 之前」，這一章之後同一個位置是 T3 寫歷史的那一句；② 庫存服務 commit 之後慢 1.5 秒才回應、訂單服務只等 1 秒，之後同一個鍵重送。
- **K3** 每秒 20 張下單（開放式負載），中間 20 秒庫存服務的預留慢 3 秒；訂單服務等 10 秒（照第 00 章）。看「我的訂單」與連線池。
- **K5** 同一張訂單：訂單服務的 traceId、庫存服務**收到的** `traceparent`、庫存服務日誌用的 traceId。

K2、K3、K5 的兩個服務都在測試的 JVM 裡（慢、收到什麼，是 static 的掛勾記的：第 03 章的 `LostResponse`、這一章的 `TraceTap`）；K2 的事件走 RabbitMQ（補償是 `order.rejected` → 庫存服務釋放）。

```bash
mvn test -Pexperiments -Dtest=E9FourCostsAgainTest
```

```
═══ K1（0.2.1）一張一張送：每格 3 輪 × 100 張、交錯（load { 2.90 6.00 8.20 }）═══
   1 個品項 │ 單體 p50  15.74 ms p99   51.72 ms │ 切開 p50  20.34 ms p99   38.70 ms │ p50 差  +4.60 ms
   3 個品項 │ 單體 p50  18.23 ms p99   64.78 ms │ 切開 p50  23.54 ms p99   41.08 ms │ p50 差  +5.31 ms
  10 個品項 │ 單體 p50  24.10 ms p99   57.08 ms │ 切開 p50  29.14 ms p99   73.84 ms │ p50 差  +5.04 ms
═══ K1（0.2.1）16 條執行緒同時送 3 個品項的訂單：每格 3 輪 × 5 秒、交錯（load { 3.52 5.70 7.96 }）═══
  單體 │ 每秒 237 / 260 / 270 張 │ p50  59.60 ms │ p99  110.28 ms │ 不是 201 的 0 張
  切開 │ 每秒 175 / 180 / 194 張 │ p50  80.04 ms │ p99  212.42 ms │ 不是 201 的 0 張
═══ K2（0.2.2）① 預留之後的那一步失敗（T3 寫歷史的那一句）：100 張（load { 7.10 6.38 8.12 }）═══
  失敗之後 │ 回應 {500=100} │ 這位買家的訂單 {RESERVING=100} │ 沒有訂單的預留 +0 列 │ reserved +300 件
           第一個回應：{"type":"/problems/internal","title":"系統發生錯誤","status":500,"detail":"系統發生錯誤，請稍後再試","instance":"/api/orders","traceId":"6ad1a1f670378ca0f1ad6207856d7fb9"}
  排程補償 │ 收了 100 張（8,374 ms 之後）│ 這位買家的訂單 {REJECTED=100} │ 沒有訂單的預留 +0 列 │ reserved +0 件
═══ K2（0.2.2）② 庫存服務 commit 之後慢 1.5 秒才回應，訂單服務只等 1 秒：20 張（load { 6.47 6.27 8.06 }）═══
  第一次送   │ 回應 {503=20} │ 訂單（買家看得到的）+0 張 │ 沒有訂單的預留 +0 列 │ reserved +60 件
             第一個回應：{"type":"/problems/temporarily-unavailable","title":"服務暫時無法使用","status":503,"detail":"庫存服務暫時無法使用，請稍後再試","instance":"/api/orders","traceId":"6ad1a20130bbcde7ba3aa2e39dc7b34b","retryAfter":1}
  同一個鍵重送 │ 回應 {200=20} │ 訂單（買家看得到的）+20 張 │ 沒有訂單的預留 +0 列 │ reserved +60 件
═══ K5（0.2.4）同一張訂單，兩個服務的 traceId（load { 5.38 6.06 7.90 }）═══
  訂單服務 │ 201，X-Trace-Id 6ad1a22aa1c62c6a6e7ab98a52b6b245
  庫存服務 │ PUT /internal/inventory/v1/reservations/121 │ 收到的 traceparent=00-6ad1a22aa1c62c6a6e7ab98a52b6b245-ba1c76a5a14a5068-00 │ 日誌的 traceId 6ad1a22ab71234311558cc37b306e8d0
═══ K3（0.2.3）庫存服務變慢：訂單服務的其他 API 怎麼了（每秒 20 張下單、訂單服務等 10 秒；load { 5.27 5.99 7.85 }）═══
  正常    │ 下單       │  400 次 │ p50     23.0 ms │ p99    104.2 ms │ max    224.9 ms │ {201=400}
  正常    │ 商品詳情     │   95 次 │ p50      2.5 ms │ p99     69.5 ms │ max     69.5 ms │ {200=95}
  正常    │ 我的訂單     │   95 次 │ p50      3.7 ms │ p99     25.6 ms │ max     25.6 ms │ {200=95}
  慢 3 秒 │ 下單       │  400 次 │ p50   3027.1 ms │ p99   3056.7 ms │ max   3110.7 ms │ {201=400}
  慢 3 秒 │ 商品詳情     │   95 次 │ p50      2.7 ms │ p99     12.7 ms │ max     12.7 ms │ {200=95}
  慢 3 秒 │ 我的訂單     │   95 次 │ p50      3.8 ms │ p99     13.4 ms │ max     13.4 ms │ {200=95}
  恢復    │ 下單       │  400 次 │ p50     23.1 ms │ p99    159.0 ms │ max   3025.4 ms │ {201=400}
  恢復    │ 商品詳情     │   94 次 │ p50      2.9 ms │ p99     53.7 ms │ max     53.7 ms │ {200=94}
  恢復    │ 我的訂單     │   94 次 │ p50      3.6 ms │ p99     35.1 ms │ max     35.1 ms │ {200=94}
  連線池、還沒回應的下單（每秒）：
     18 秒 正常    active  0 pending   0 │ 還沒回應的下單   1
     19 秒 正常    active  1 pending   0 │ 還沒回應的下單   1
     20 秒 正常    active  1 pending   0 │ 還沒回應的下單   1
     21 秒 慢 3 秒 active  1 pending   0 │ 還沒回應的下單  21
     22 秒 慢 3 秒 active  2 pending   0 │ 還沒回應的下單  41
     23 秒 慢 3 秒 active  1 pending   0 │ 還沒回應的下單  61
     24 秒 慢 3 秒 active  0 pending   0 │ 還沒回應的下單  61
     38 秒 慢 3 秒 active  1 pending   0 │ 還沒回應的下單  61
     39 秒 慢 3 秒 active  0 pending   0 │ 還沒回應的下單  61
     40 秒 慢 3 秒 active  0 pending   0 │ 還沒回應的下單  61
     41 秒 恢復    active  1 pending   0 │ 還沒回應的下單  42
     42 秒 恢復    active  1 pending   0 │ 還沒回應的下單  22
     43 秒 恢復    active  1 pending   0 │ 還沒回應的下單   2
  （結束時 load { 4.05 5.53 7.54 }）
```

（K3 每秒一行的連線池，這裡只留慢的那 20 秒前後；全部 60 行都是 active 0～2、pending 0。）

跑了三次（第一次的 K2 ② 是錯的，下面的 ⚠️）。跟第 00 章放在一起：

| | 第 00 章（實驗支架的線） | 第 04 章之後（真的線、Saga），三次的範圍 |
|---|---|---|
| K1 1 個品項 p50：單體 / 切開 | 10.42 / 13.26 ms | 15.21～17.01 / 20.19～21.84 ms（差 +4.6～+5.0） |
| K1 10 個品項 p50：單體 / 切開 | 15.19 / 17.76 ms | 22.65～26.31 / 28.11～30.63 ms（差 +4.3～+5.5） |
| K1 16 條執行緒：每秒，單體 / 切開 | 376 / 307 張 | 202～287 / 130～194 張（每一次都少 28%～36%） |
| K2 ① 沒有訂單的預留；`reserved` 多出來的 | 300 列；300 件 | 0 列；補償之前 +300 件（訂單都在：`RESERVING`），補償之後 +0 |
| K2 ② 同一個鍵重送之後，`reserved` 多出來的 | 60 件（`reserved` +120，其中 60 件是孤兒） | 0 件（`reserved` +60 = 20 張 × 3 件：重送接著做同一張） |
| K3 慢 3 秒：下單 503；「我的訂單」p50；連線池 | 192 張；1,862 ms；active 20、pending 最多 153 | 0 張；3.5～3.8 ms；active 0～2、pending 0 |
| K5 traceId | 兩邊都斷 | 送的那一邊好了，收的那一邊還斷 |

**K2、K3：Saga 修好了第 00 章最痛的兩個。**

- **K2 ①**：100 張都是 500 —— 使用者看到的跟第 00 章一樣。看不到的地方不一樣了：100 張訂單停在 `RESERVING`（買家看不到它們），預留都**有主人**；排程把它們補償成 `REJECTED`（這裡把 placement-timeout 縮成 5 秒、手動觸發一輪；預設是 60 秒、每 30 秒一輪），庫存服務收到 `order.rejected`、釋放 —— `reserved` 回到 +0。第 00 章那 300 列孤兒，是「沒有人知道它們存在」；這一章的 300 件是「有人負責收」。
- **K2 ②**：第一次送，20 張都是 503（第 03 章的重試：兩次都沒等到回應），訂單停在 `RESERVING`、預留 60 件；同一個鍵重送 → 接著做同一張，預留以 `orderId` 冪等 → `reserved` 還是 +60。第 00 章的 120 件，多出來的那 60 件來自「新的 orderId」—— 這一章之後，鍵綁著的是那張 `RESERVING` 的訂單（4.5.4）。
- **K3**：庫存服務慢 3 秒，下單也慢 3 秒（p50 約 3,030 ms），但**一張都沒有失敗**，「我的訂單」p50 3.5～3.8 ms，連線池 active 0～2、pending 0。預留不在交易裡了（4.5.4 的 T2），等庫存的那 3 秒不佔資料庫連線 —— 第 00 章 0.2.3 的 📌「B 在等 A 的時候佔著什麼」，佔的東西少了一樣。**還佔著的**：一條 Tomcat 的執行緒、一條 HTTP 連線 —— 慢的那 20 秒，同時有約 60 個下單在等（「還沒回應的下單」那一欄）。每秒 20 張、3 秒是 60 條（同時在等的請求數 = 每秒進來幾個 × 每個等幾秒）；每秒 20 張、每張等 10 秒，就是 Tomcat 預設的 200 條全滿。那是第 06 章的事。

  （追記，第 06 章：這一句原本寫成「每秒 200 張、30 秒就是 Tomcat 預設的 200 條全滿」—— 200 × 30 是 6,000，算錯了。第 06 章 6.2 用正式的逾時量到：每秒 40 張、每張 6 秒，200 條全滿，連不問庫存服務的商品頁也慢了。）

**K1：切開變得更貴了。** 第 00 章切開比單體每張多 2.5～3 ms、吞吐少 18%；這一章之後多 4.3～6.0 ms、吞吐少 28%～36%。單體本身也變慢了（1 個品項 10.4 → 約 17 ms）：Saga 多兩次 commit（4.10.3）、這台機器的 load 也比那時候高。切開多出來的那一段裡有：服務的 token（每一次請求帶一個 JWT，第 03 章 3.6）、庫存服務的 `processed_messages` 那一列（冪等，第 03 章 3.5 —— 一次多一句 INSERT）、兩次 HTTP 的逾時與重試的包裝。**各佔多少，這一節沒有拆開量** —— 跟第 00 章一樣，能說的是方向：這一條線上每加一個「讓它安全」的東西，都會付在每一張訂單上。

**K5：送的那一邊，第 03 章就好了**（`RemoteInventoryApi` 用的是 Spring 的 `RestClient.Builder`，`traceparent` 帶著訂單服務的 traceId）；**收的那一邊還斷**：庫存服務收到了，日誌卻是另一個 traceId —— 第 12 站 9.8.4 在邊緣把外面帶進來的 trace header 全部藏起來，分不出「外面的人」與「自己的訂單服務」。第 07 章。

⚠️ **E9 的第一版，K2 ② 的重送拿到 422 × 20。** 重送時又隨機挑了 3 個商品 —— 同一個鍵、不同的內容 → `IDEMPOTENCY_KEY_REUSED`。第 00 章的 K2 也是這樣寫的，那時候看不出來：鍵在第一次失敗時就被放掉了（第 12 站 4.5.1 AC-4），內容不同也只是另一張新訂單。這一章之後鍵綁著那張 `RESERVING` 的訂單，內容不同就是 422。真的客戶端重送的是**同一個請求**：改成記下每一張的商品、重送同樣的內容。上面三次的 K2 ② 只算修正之後的兩次。

---

## 4.11 本章完成後的專案

```
shop/                                                              ← 分支 d04（從 d03 開出來）
├── src/main/java/com/example/shop/
│   ├── ordering/OrderStatus.java                                  ← 4.5.1：RESERVING、REJECTED、NOT_PLACED
│   ├── ordering/OrderingApi.java                                  ← 4.5.4（只有註解）
│   ├── ordering/internal/PlaceOrderService.java                   ← 4.5.4：協調者
│   ├── ordering/internal/OrderTransitionService.java              ← 4.5.4、4.6.1：交易裡不再呼叫庫存；兩個新的出口
│   ├── ordering/internal/OrderStateMachine.java、OrderEvent.java   ← 4.5.3：8 × 13
│   ├── ordering/internal/OrderJobs.java                           ← 4.5.5：expirePlacements
│   ├── ordering/internal/IdempotencyKeys.java                     ← 4.5.4：forget
│   ├── ordering/internal/Order.java、OrderItem.java               ← 4.5.1、4.5.2：先以 RESERVING 寫下；hot
│   ├── ordering/internal/OrderRepository.java、OrderAccess.java、OrderQueryService.java ← 4.5.6：看不到還沒成立的
│   ├── ordering/internal/OrderDtos.java、web/OrderQueryController.java ← 4.5.6：契約只有六個值
│   ├── ordering/internal/OrderCommands.java                       ← 4.6.3：出貨之前問一次
│   ├── ordering/internal/ReservationReconciliation.java           ← 4.9：REJECTED、RESERVING
│   ├── ordering/internal/OrderSagaView.java、web/AdminOrderSagaController.java ← + 4.9
│   ├── inventory/InventoryApi.java                                ← 4.5.4、4.6.3、4.6.4
│   ├── inventory/internal/JdbcInventoryService.java               ← 4.5.4、4.6.2、4.6.3、4.6.4、4.7
│   ├── inventory/internal/InventoryEventHandlers.java             ← 4.6.1：inventory.order-events
│   ├── inventory/internal/InventoryService.java、web/InventoryServiceController.java ← 4.6.3、4.6.4
│   ├── inventory/internal/remote/InventoryClient.java、RemoteInventoryApi.java ← 4.6.3、4.6.4
│   ├── shared/config/ShopProperties.java                          ← 4.5.5：placementTimeout
│   ├── shared/events/EventTypes.java                              ← 4.5.4：order.rejected
│   └── shared/events/Outbox.java、internal/JdbcOutbox.java         ← 4.9：recorded
├── src/main/resources/
│   ├── db/migration/ordering/V26__ordering_placement_statuses.sql ← + 4.5.6
│   ├── db/migration/ordering/V27__ordering_item_hot.sql           ← + 4.5.2
│   └── mapper/reporting/SalesReportMapper.xml、TrendingMapper.xml  ← 4.5.6
└── src/test/
    ├── java/com/example/shop/
    │   ├── dist04/                                                ← + 這一章的支架與實驗
    │   │   ├── OrderNode.java、CrashPoint.java、Nodes.java          ← 4.2.1、4.8.3
    │   │   ├── E1CrashTest.java                                   ← 4.2（實驗；d04 的第一個 commit）
    │   │   ├── E2TwoPhaseCommitTest.java                          ← 4.3（實驗）
    │   │   ├── E3SagaDrillTest.java                               ← 4.8.3（實驗）
    │   │   ├── E4SagaDayTest.java、E5SagaCostTest.java             ← 4.10.2、4.10.3（實驗）
    │   │   └── E6NewStatusCostTest.java                           ← 4.5.6（實驗）
    │   ├── dist03/Roles.java、Shop.java                            ← 4.2.1、4.10.3：參數抽出來、Shop 可以打任何一個埠
    │   ├── dist00/RemoteInventoryApi.java、dist02/RemoteInventory.java、InventoryEndpoints.java ← 4.6.4
    │   ├── dist01/CrossModuleCallInTxTest.java                    ← 4.8.1：10 → 6 種
    │   ├── ordering/internal/PlaceOrderSagaTest.java              ← + 4.5、4.7.2
    │   ├── ordering/internal/LegacyPlaceOrder.java                ← + 4.10.3（E5 的第 03 章流程）
    │   ├── ordering/internal/OrderFlowTest.java、OrderRaceRegressionTest.java、HotSettlementTest.java、OrderStateMachineTest.java ← 4.8.1
    │   ├── inventory/internal/InventoryOrderEventsTest.java        ← + 4.6.2
    │   ├── inventory/internal/remote/InventoryClientPactTest.java、RemoteInventoryApiTest.java ← 4.6.4、4.8.2
    │   ├── inventory/internal/web/InventoryProviderContract.java   ← 4.6.4：兩個 @State
    │   ├── api/AdminOrderSagaApiTest.java                         ← + 4.9
    │   ├── api/IdorMatrixTest.java                                ← 4.9：一行豁免
    │   ├── acceptance/CapstoneAcceptanceTest.java                 ← 4.8.1：Q1
    │   ├── schema/SchemaConstraintTest.java                       ← 4.5.6
    │   ├── shared/messaging/internal/ServiceRoleConsumersTest.java ← 4.6.1
    │   ├── ordering/internal/CancelRefundSnapshotTest.java         ← 只有一行註解（4.11.1）
    │   └── support/InlineEvents.java                              ← 4.8.1：deliverTo
    └── resources/openapi/shop-api.json                            ← 4.9：一支管理員的路由
```

**兩個新的 migration**（V26、V27），都是 `ALGORITHM=INSTANT`。**對買家、賣家的 API 沒有任何改變**（`OpenApiContractTest` 的快照只多了一支管理員的路由與它的四個元件）。單體的行為改了三件事：下單多兩次 commit（4.10.3）、付款／取消／出貨之後的庫存等事件（4.6.1）、被拒絕的下單留下一張 `REJECTED`（4.8.1 的 Q1）。

完整跑一次（預設的 Testcontainers；E1～E6 標了 `experiment`，不在裡面）：

```bash
mvn clean verify
```

```
TEST_INFRA testcontainers 啟動 9,067 ms：mysql jdbc:mysql://localhost:55368/shop、redis localhost:55359、rabbitmq localhost:55367
TEST_INFRA MySQL 最多同時 27 條連線（max_connections 151）
[INFO] Tests run: 322, Failures: 0, Errors: 0, Skipped: 0
TEST_INFRA testcontainers 啟動 10,650 ms：mysql jdbc:mysql://localhost:56878/shop、redis localhost:56871、rabbitmq localhost:56874
TEST_INFRA MySQL 最多同時 3 條連線（max_connections 151）
[INFO] Tests run: 31, Failures: 0, Errors: 0, Skipped: 0
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  05:25 min
```

**322 個測試**：第 03 章的 265 個，`OrderStateMachineTest` 從 67 個變成 111 個（8 × 13 的表）、`InventoryClientPactTest` 15 → 16 個，加上 `PlaceOrderSagaTest` 5 個、`InventoryOrderEventsTest` 4 個、`AdminOrderSagaApiTest` 2 個、`SchemaConstraintTest` 多 1 個。**failsafe 那一段 31 個**：這一次建置的契約 16 個互動、線上那一版 15 個。

**這是第三次完整的 verify**。之前：

- 4.8.1 的第一次整套 `mvn test`：199 個，14 個失敗、2 個錯誤；第二次 `mvn clean test`：319 個，全綠（那時還沒有 4.9 的 API、還沒有改 V26）。那兩次是 `test`，不是 `verify`。
- **第一次 verify（322 個，紅 1 個，4:56）**：`TableOwnershipTest`（4.9 的 ⚠️）。
- **第二次 verify（322 + 31 個，全綠，5:36）**：改了 `OrderSagaView` 之後。
- 那之後改了 `CancelRefundSnapshotTest` 的一行註解（4.11.1 的最後），測試的程式碼變了，所以再跑這一次。
- E2～E6、B1 的最後一輪，跑在 `OrderSagaView` 修正**之前**的 commit 上；之後只動了 `OrderSagaView`、`Outbox` 與一行註解，六個實驗都沒有走到它們。

### 4.11.1 本章其餘檔案的完整內容

正文已經完整列出的：`OrderStatus`（4.5.1）、`OrderSagaView`（4.9）、V26（4.5.6）、V27（4.5.2）。正文列出了 diff 或相關段落、而且只改了幾行的，下面列 diff；其餘新增或改動較大的，列完整內容（`d04` 分支上、追記之前的版本：追記又改了 `OrderCommands`、`InventoryClientPactTest`、`InventoryProviderContract`，見 4.11.2）。

**`src/main/java/com/example/shop/ordering/internal/PlaceOrderService.java`**（4.5.4）

```java
package com.example.shop.ordering.internal;

import com.example.shop.catalog.CatalogApi;
import com.example.shop.catalog.ProductSnapshot;
import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.ordering.OrderStatus;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ConstraintViolations;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.*;

/**
 * 4.4 下單。交易邊界（第 12 站）：
 *   ① IdempotencyKeys.claim()   —— 短交易，取得這個鍵
 *   ② placeInTransaction()      —— 下單交易：訂單、明細、預留、庫存帳、狀態歷史、冪等鍵完成、清購物車、Outbox。全有或全無（Q1）
 *   ③ 失敗時 IdempotencyKeys.release() —— 短交易，讓重試可以重新執行
 * ② 裡「只有 SQL」：沒有外部呼叫、沒有 sleep、沒有遠端日誌（0.11.5 的第一條設計約束：持鎖 ≤ 2 ms）
 * 13 站 1.6：商品快照與檢查移到 ① 與 ② 之間（checkedSnapshots）—— ② 裡跨模組的呼叫只剩「寫」：預留、清購物車
 *
 * 13 站 4.5：② 拆成一個 Saga（這個類別是它的協調者）。每一步是一個服務自己的交易：
 *   T1 訂單服務：訂單以 RESERVING 寫下、明細（記下哪幾個品項過了熱點閘門）、狀態歷史、冪等鍵綁到這張訂單 —— commit
 *   T2 庫存服務：預留（以 orderId 冪等）—— 會拒絕（庫存不足），所以是這個 Saga 的樞紐（pivot）
 *   T3 訂單服務：RESERVED → PENDING_PAYMENT、清購物車、order.placed（OrderTransitionService）
 * T2 拒絕 → 補償：RESERVE_FAILED → REJECTED、放掉冪等鍵、order.rejected（庫存模組收到之後把閘門加回去）→ 409。
 * T2 不知道結果（兩次都沒有回應）→ 503，訂單留在 RESERVING：買家用同一個鍵重送 → 接著做這一張（advance）；
 * 沒有人重送 → 排程在 placement-timeout 之後補償（OrderJobs.expirePlacements）。
 * 一個交易都不跨服務。行程在任何兩步之間不見了，資料庫裡都有足夠的狀態讓別人接手 —— catch 不是補償（4.2）。
 */
@Service
class PlaceOrderService implements OrderingApi {

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(PlaceOrderService.class);

    static final int MAX_LINES = 50;
    static final int ORDER_NO_ATTEMPTS = 3;

    private final CatalogApi catalog;
    private final InventoryApi inventory;
    private final OrderRepository orders;
    private final OrderHistory history;
    private final IdempotencyKeys keys;
    private final OrderTransitionService transitions;
    private final TransactionTemplate tx;
    private final Clock clock;
    private final Duration paymentTimeout;

    PlaceOrderService(CatalogApi catalog, InventoryApi inventory, OrderRepository orders, OrderHistory history, IdempotencyKeys keys,
                      OrderTransitionService transitions, PlatformTransactionManager tm, Clock clock, ShopProperties props,
                      io.micrometer.core.instrument.MeterRegistry meters) {
        this.catalog = catalog;
        this.inventory = inventory;
        this.orders = orders;
        this.history = history;
        this.keys = keys;
        this.transitions = transitions;
        this.tx = new TransactionTemplate(tm);
        this.clock = clock;
        this.paymentTimeout = props.order().paymentTimeout();
        this.placed = meters.counter("shop.orders.placed");
        this.insufficient = meters.counter("shop.inventory.insufficient");
        this.collisions = meters.counter("shop.orders.number_collisions");
    }

    private final io.micrometer.core.instrument.Counter placed, insufficient, collisions;

    /**
     * 6.5.2 熱點商品的品項先過 Redis 的閘門 —— 在冪等鍵與下單交易「之前」：搶不到的人（2,000 人裡的 1,500 人）完全不碰 MySQL。
     * 閘門過了之後，任何一條失敗的路徑都要把減掉的加回去（6.2.4：漏了一條 = 少賣）。
     * 13 站 4.5：T1 commit 之前失敗 → 這一次扣的，在這裡同步加回去（跟第 12 站一樣）；T1 commit 之後 → 扣的那幾件屬於那張訂單，
     * 由 Saga 的補償（order.rejected）加回去 —— 行程當掉也不會漏。
     */
    @Override
    public PlacedOrder placeOrder(long buyerId, String idempotencyKey, List<OrderLine> lines) {
        try {
            return placeOrderGated(buyerId, idempotencyKey, lines);
        } catch (InsufficientStockException e) {
            // 9.9：0.6.6「依 productId 前 N 名」。productId 不當指標的 tag（J7：1 萬個商品 = 1 萬條序列、每次 scrape 600 KB），寫進日誌，前 N 名從日誌查
            insufficient.increment();
            log.info("INSUFFICIENT_STOCK productId={} buyerId={}", e.productId(), buyerId);
            throw e;
        }
    }

    private PlacedOrder placeOrderGated(long buyerId, String idempotencyKey, List<OrderLine> lines) {
        validate(lines);
        Set<Long> hotIds = catalog.hotProducts(lines.stream().map(OrderLine::productId).toList());
        List<ReserveLine> hot = lines.stream().filter(l -> hotIds.contains(l.productId()))
                .map(l -> new ReserveLine(l.productId(), l.quantity())).toList();
        inventory.gateHot(hot);                                             // 不夠 → 409；Redis 不能用 → 503
        IdempotencyKeys.Claim claim;
        long orderId;
        try {
            claim = keys.claim(buyerId, idempotencyKey, hash(lines));
            if (claim instanceof IdempotencyKeys.InProgress)
                throw new ShopException(ProblemType.IDEMPOTENCY_IN_PROGRESS, "相同的下單請求正在處理中").with("retryAfter", 1);
            orderId = claim instanceof IdempotencyKeys.Existing e ? e.orderId() : reserving(buyerId, idempotencyKey, lines, hotIds);
        } catch (RuntimeException e) {
            // T1 還沒 commit：這一次扣的閘門不屬於任何一張訂單，在這裡加回去
            inventory.returnHot(hot);
            throw e;
        }
        if (claim instanceof IdempotencyKeys.Existing) inventory.returnHot(hot);   // 重送：那張訂單扣的是它自己的那一次，這一次扣的要還回去
        PlacedOrder placed = advance(orderId, claim instanceof IdempotencyKeys.Existing);
        // 9.8：第一版成功的下單一行日誌都沒有 —— 出事的時候，「這張訂單是哪一個請求建的」只能從 traceId 往回找
        if (!placed.replayed()) this.placed.increment();
        if (!placed.replayed()) log.info("ORDER_PLACED orderNo={} buyerId={} lines={} hot={}", placed.orderNo(), buyerId, lines.size(), hot.size());
        return placed;
    }

    /** T1：訂單以 RESERVING 寫下，冪等鍵綁到它。失敗（價格變了、資料庫錯誤……）→ 放掉鍵，什麼都沒留下 */
    private long reserving(long buyerId, String key, List<OrderLine> lines, Set<Long> hotIds) {
        try {
            // 13 站 1.6：商品快照在下單交易「之前」讀 —— 第 12 站是在交易裡讀的。那是一句不加鎖的讀（一致性讀），
            // 放在交易裡也擋不住「讀完之後賣家改價」，只是讓交易多開一段；切開之後，這一段是一次遠端呼叫。
            // 放在冪等鍵之後：重送（Existing）不需要快照，也不該因為價格變了而失敗
            Map<Long, ProductSnapshot> products = checkedSnapshots(lines);
            for (int attempt = 1; ; attempt++) {
                try {
                    return tx.execute(s -> insertReserving(buyerId, key, lines, hotIds, products));
                } catch (DataIntegrityViolationException e) {
                    // 2.4.4：訂單編號撞號（一天約 12 次）。整個交易已經 rollback，換一個號碼重來
                    if (attempt >= ORDER_NO_ATTEMPTS || !ConstraintViolations.isViolationOf(e, "uk_orders_order_no")) throw e;
                    collisions.increment();                                 // 9.10：4.4.4「日誌照實記錄，另外用指標數撞號次數」—— 那一行 ERROR 不拿來告警
                }
            }
        } catch (RuntimeException e) {
            keys.release(buyerId, key);                                     // AC-4：失敗的結果不快取
            throw e;
        }
    }

    /**
     * T2、T3：讓一張訂單往前走。第一次下單、以及同一個鍵的重送，都走這裡 —— 重送時訂單可能還在 RESERVING（上一次在 T2 之後不見了）。
     * 庫存服務的預留以 orderId 冪等（3.5）：上一次其實預留了，這一次是重送；上一次沒有，這一次才真的預留。
     */
    private PlacedOrder advance(long orderId, boolean replayed) {
        var cur = transitions.current(orderId);
        if (cur.status() == OrderStatus.RESERVING) {
            List<OrderTransitionService.Item> items = transitions.items(orderId);
            List<ReserveLine> normal = items.stream().filter(i -> !i.hot()).map(i -> new ReserveLine(i.productId(), i.quantity())).toList();
            List<ReserveLine> hotLines = items.stream().filter(OrderTransitionService.Item::hot).map(i -> new ReserveLine(i.productId(), i.quantity())).toList();
            try {
                inventory.reserve(orderId, normal, hotLines);               // T2（樞紐）
            } catch (InsufficientStockException e) {
                transitions.apply(orderId, OrderEvent.RESERVE_FAILED, OrderHistory.Actor.system(), OrderTransitionService.EventData.NONE);   // 補償
                throw e;
            } catch (ShopException e) {
                // 409 狀態不對：這張訂單的預留已經被補償掉了（排程先一步收了它，4.7.2）—— 不是買家的錯；再送一次是一次新的下單
                if (e.type() != ProblemType.INVALID_STATE) throw e;
                throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "下單沒有完成，請再送一次").with("retryAfter", 1);
            }
            // 兩次都沒有回應（503）、或其他錯誤：例外照樣往外丟，訂單留在 RESERVING —— 重送或排程接手
            OrderStatus now = applyReserved(orderId);                       // T3
            if (now != OrderStatus.PENDING_PAYMENT)
                throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "下單沒有完成，請再送一次").with("retryAfter", 1);
        } else if (cur.status() == OrderStatus.REJECTED) {
            // 讀到鍵的那一刻，訂單還在；之後被補償了（鍵也放掉了）。再送一次就是一次新的下單
            throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "下單沒有完成，請再送一次").with("retryAfter", 1);
        }
        return new PlacedOrder(orderId, cur.orderNo(), replayed);
    }

    /** RESERVED。補償已經先發生了（REJECTED）→ 狀態機說 REJECT：不是使用者的錯，回 null 讓呼叫端回 503 */
    private OrderStatus applyReserved(long orderId) {
        try {
            return transitions.apply(orderId, OrderEvent.RESERVED, OrderHistory.Actor.system(), OrderTransitionService.EventData.NONE);
        } catch (ShopException e) {
            if (e.type() != ProblemType.INVALID_STATE) throw e;
            return null;
        }
    }

    /** 商品快照與三個檢查（可購買、同一位賣家、價格沒變）。全部在交易之外 */
    private Map<Long, ProductSnapshot> checkedSnapshots(List<OrderLine> lines) {
        List<Long> ids = lines.stream().map(OrderLine::productId).toList();
        Map<Long, ProductSnapshot> products = catalog.snapshots(ids);

        List<Long> unavailable = ids.stream().filter(id -> products.get(id) == null || !products.get(id).purchasable()).toList();
        if (!unavailable.isEmpty())
            throw new ShopException(ProblemType.PRODUCT_UNAVAILABLE, "有商品目前無法購買").with("productIds", unavailable);

        Set<Long> sellers = new HashSet<>();
        products.values().forEach(p -> sellers.add(p.sellerId()));
        if (sellers.size() != 1)
            throw new ShopException(ProblemType.VALIDATION, "一次只能結帳同一位賣家的商品（0.3.5）");

        // AC-6：使用者同意付的是他看到的價格。比較用 compareTo —— 299 與 299.00 是同一個價格（4.2.4）
        List<Map<String, Object>> changed = new ArrayList<>();
        for (OrderLine l : lines) {
            BigDecimal now = products.get(l.productId()).price();
            if (now.compareTo(l.clientUnitPrice()) != 0)
                changed.add(Map.of("productId", l.productId(), "yourPrice", l.clientUnitPrice(), "currentPrice", now));
        }
        if (!changed.isEmpty())
            throw new ShopException(ProblemType.PRICE_CHANGED, "價格已變動，請確認後重新下單").with("changes", changed);
        return products;
    }

    private long insertReserving(long buyerId, String key, List<OrderLine> lines, Set<Long> hotIds, Map<Long, ProductSnapshot> products) {
        List<Long> ids = lines.stream().map(OrderLine::productId).toList();
        Instant now = clock.instant();
        Order order = Order.place(OrderNumbers.next(now), buyerId, products.get(ids.get(0)).sellerId(), now, now.plus(paymentTimeout));
        for (OrderLine l : lines) {
            ProductSnapshot p = products.get(l.productId());
            order.addItem(p.id(), p.name(), p.price(), l.quantity(), hotIds.contains(l.productId()));   // 快照：下單當下的名稱與價格（1.5.5）
        }
        orders.saveAndFlush(order);                                         // IDENTITY：這裡就 INSERT 了，撞號也在這裡炸
        history.record(order.getId(), null, order.getStatus(), "PLACE_ORDER", OrderHistory.Actor.buyer(buyerId), now);
        keys.complete(buyerId, key, order.getId());                         // 13 站 4.5：鍵綁到 RESERVING 的訂單 —— 重送接著做這一張
        return order.getId();
    }

    static void validate(List<OrderLine> lines) {
        if (lines == null || lines.isEmpty() || lines.size() > MAX_LINES)
            throw new ShopException(ProblemType.VALIDATION, "品項數量必須是 1～" + MAX_LINES);
        if (lines.stream().map(OrderLine::productId).distinct().count() != lines.size())
            throw new ShopException(ProblemType.VALIDATION, "同一個商品只能出現一次");
    }

    /** AC-2：同一個鍵、不同的內容 → 422。內容的「指紋」與品項順序無關、與價格的 scale 無關 */
    static String hash(List<OrderLine> lines) {
        StringBuilder sb = new StringBuilder();
        lines.stream().sorted(Comparator.comparingLong(OrderLine::productId)).forEach(l ->
                sb.append(l.productId()).append(':').append(l.quantity()).append(':')
                  .append(l.clientUnitPrice().stripTrailingZeros().toPlainString()).append(';'));
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(sb.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/OrderTransitionService.java`**（4.5.4、4.6.1、4.9）

```java
package com.example.shop.ordering.internal;

import com.example.shop.cart.CartApi;
import com.example.shop.ordering.OrderStatus;
import com.example.shop.ordering.internal.OrderStateMachine.Decision;
import com.example.shop.ordering.internal.OrderStateMachine.Kind;
import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.RefundReason;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.events.EventTypes;
import com.example.shop.shared.events.Outbox;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 4.6 把一個事件套用到一張訂單上。0.5.5 的硬規則：
 *   UPDATE orders SET status = :to, ..., version = version + 1 WHERE id = :id AND status = :from
 * 影響 0 列 = 狀態已經被別人改了 → 重新讀取，再問一次狀態機（最多 3 次）。
 * 同一個交易裡完成 0.5.4 表格左欄的所有副作用（預留、歷史、退款單），以及右欄的「記下這件事」（Outbox，第 07 章）。
 *
 * 13 站 4.6：左欄少了庫存。確認、釋放、出庫不再在這個交易裡呼叫 InventoryApi —— 庫存模組聽 order.paid、order.cancelled、order.shipped，
 * 在它自己的交易裡做（協同）。這個交易裡只剩訂單服務自己的庫：訂單、歷史、退款單、購物車、冪等鍵、outbox。
 */
@Service
class OrderTransitionService {

    /** 事件帶的資料。paymentId：E1；carrier / trackingNo：E7；cancelReason：E3 / E4 / E5 */
    record EventData(Long paymentId, String carrier, String trackingNo, String cancelReason) {
        static final EventData NONE = new EventData(null, null, null, null);
        static EventData payment(long id) { return new EventData(id, null, null, null); }
        static EventData shipment(String carrier, String trackingNo) { return new EventData(null, carrier, trackingNo, null); }
        static EventData cancel(String reason) { return new EventData(null, null, null, reason); }
    }

    record Current(OrderStatus status, String trackingNo, long buyerId, long sellerId, String orderNo, BigDecimal totalAmount) {}

    private final JdbcTemplate jdbc;
    private final CartApi cart;
    private final IdempotencyKeys keys;
    private final PaymentApi payments;
    private final OrderHistory history;
    private final Outbox outbox;
    private final Clock clock;
    private final io.micrometer.core.instrument.MeterRegistry meters;

    OrderTransitionService(JdbcTemplate jdbc, CartApi cart, IdempotencyKeys keys, PaymentApi payments, OrderHistory history, Outbox outbox,
                           Clock clock, io.micrometer.core.instrument.MeterRegistry meters) {
        this.jdbc = jdbc;
        this.cart = cart;
        this.keys = keys;
        this.payments = payments;
        this.history = history;
        this.outbox = outbox;
        this.clock = clock;
        this.meters = meters;
    }

    @Transactional
    public OrderStatus apply(long orderId, OrderEvent event, OrderHistory.Actor actor, EventData data) {
        for (int attempt = 0; attempt < 3; attempt++) {
            // 第一次用一般的讀取；UPDATE 影響 0 列之後的「重讀」必須是 locking read（FOR UPDATE）：
            // REPEATABLE READ 底下，同一個交易裡的一般 SELECT 永遠讀到同一個快照 —— 看不到別人剛 commit 的狀態（4.6.2）
            Current cur = attempt == 0 ? current(orderId) : currentForUpdate(orderId);
            boolean same = switch (event) {
                case PAY_SUCCEEDED -> false;                // 同一筆的重送已經在 PaymentApi.record() 被擋掉了（DUPLICATE）
                case SHIP -> data.trackingNo() != null && data.trackingNo().equals(cur.trackingNo());
                default -> false;
            };
            Decision d = OrderStateMachine.decide(cur.status(), event, same);
            switch (d.kind()) {
                case REJECT -> throw new ShopException(ProblemType.INVALID_STATE, rejectMessage(cur.status(), event))
                        .with("orderStatus", cur.status()).with("event", event);   // 不能叫 status：那是 Problem Details 的標準欄位（4.6.5）
                case IDEMPOTENT, IGNORE -> { return cur.status(); }
                case REFUND_ONLY -> {                                        // ↺ 晚到的付款、重複的付款
                    payments.requestRefund(data.paymentId(),
                            cur.status() == OrderStatus.CANCELLED ? RefundReason.LATE_PAYMENT : RefundReason.DUPLICATE_PAYMENT, cur.buyerId());
                    return cur.status();
                }
                case TRANSITION -> {
                    Instant now = clock.instant();
                    if (update(orderId, cur.status(), d.to(), event, data, now) == 1) {
                        // 13 站 4.5：下單的 Saga 的兩個出口要用到明細（清購物車、order.placed 的熱點品項、order.rejected 的閘門）—— 讀一次
                        List<Item> items = d.to() == OrderStatus.PENDING_PAYMENT || d.to() == OrderStatus.REJECTED ? items(orderId) : List.of();
                        boolean refunded = sideEffects(orderId, cur, d, event, items);
                        history.record(orderId, cur.status(), d.to(), event.name(), actor, now);
                        publish(orderId, cur, d.to(), event, data, refunded, items);
                        if (d.to() == OrderStatus.CANCELLED) afterCommit(() -> meters.counter("shop.orders.cancelled", "reason", cancelReason(event, data)).increment());
                        // 13 站 4.9：被補償掉的下單。reason=PLACEMENT_EXPIRED 變多 = Saga 停在中間的訂單變多（協調者當掉、庫存服務沒有回應）
                        if (d.to() == OrderStatus.REJECTED) afterCommit(() -> meters.counter("shop.orders.rejected", "reason", event.name()).increment());
                        return d.to();
                    }
                    // 0 列：在我們讀取之後、更新之前，別人改了狀態（排程 vs 回呼，4.2.5）。重讀、重新決定
                    // 9.9：0.6.6 的 shop.orders.state_conflict（0.5.5 的條件式更新影響 0 列的次數）
                    meters.counter("shop.orders.state_conflict", "from", cur.status().name(), "event", event.name()).increment();
                }
            }
        }
        throw new ShopException(ProblemType.INVALID_STATE, "訂單狀態正在變動，請稍後再試");
    }

    /** 9.9：commit 之後才算（回滾的取消不算）。0.6.6：逾時取消率異常上升 = 金流出問題 */
    private static void afterCommit(Runnable r) {
        if (!org.springframework.transaction.support.TransactionSynchronizationManager.isSynchronizationActive()) { r.run(); return; }
        org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(
                new org.springframework.transaction.support.TransactionSynchronization() {
                    @Override public void afterCommit() { r.run(); }
                });
    }

    Current current(long orderId) { return read(orderId, ""); }

    private Current currentForUpdate(long orderId) { return read(orderId, " FOR UPDATE"); }

    private Current read(long orderId, String lock) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT status, tracking_no, buyer_id, seller_id, order_no, total_amount FROM orders WHERE id = ?" + lock, orderId);
        if (rows.isEmpty()) throw ShopException.notFound("訂單");
        Map<String, Object> r = rows.get(0);
        return new Current(OrderStatus.valueOf((String) r.get("status")), (String) r.get("tracking_no"), ((Number) r.get("buyer_id")).longValue(),
                ((Number) r.get("seller_id")).longValue(), (String) r.get("order_no"), (BigDecimal) r.get("total_amount"));
    }

    /** 條件式 UPDATE。每個目標狀態多寫哪些欄位，照 V5 的 CHECK（ck_orders_paid、ck_orders_shipment、ck_orders_cancel_reason） */
    private int update(long orderId, OrderStatus from, OrderStatus to, OrderEvent event, EventData data, Instant now) {
        Timestamp t = Timestamp.from(now);
        String common = "status = ?, updated_at = ?, version = version + 1";
        return switch (to) {
            case PAID -> jdbc.update("UPDATE orders SET " + common + ", paid_at = ? WHERE id = ? AND status = ?",
                    to.name(), t, t, orderId, from.name());
            case PICKING -> jdbc.update("UPDATE orders SET " + common + " WHERE id = ? AND status = ?",
                    to.name(), t, orderId, from.name());
            case SHIPPED -> jdbc.update("UPDATE orders SET " + common + ", carrier = ?, tracking_no = ?, shipped_at = ? WHERE id = ? AND status = ?",
                    to.name(), t, data.carrier(), data.trackingNo(), t, orderId, from.name());
            case COMPLETED -> jdbc.update("UPDATE orders SET " + common + ", completed_at = ? WHERE id = ? AND status = ?",
                    to.name(), t, t, orderId, from.name());
            case CANCELLED -> jdbc.update("UPDATE orders SET " + common + ", cancel_reason = ?, cancelled_at = ? WHERE id = ? AND status = ?",
                    to.name(), t, cancelReason(event, data), t, orderId, from.name());
            // 13 站 4.5：只有 RESERVING 會到這兩個狀態
            case PENDING_PAYMENT, REJECTED -> jdbc.update("UPDATE orders SET " + common + " WHERE id = ? AND status = ?",
                    to.name(), t, orderId, from.name());
            case RESERVING -> throw new IllegalStateException("沒有任何轉移會回到 RESERVING");
        };
    }

    /**
     * 0.5.4 表格的左欄：必須跟狀態一起 commit 的事。
     * 13 站 4.6：PAID（預留確認）、SHIPPED（出庫）、CANCELLED（釋放）的庫存那一半，改成庫存模組收到這個交易發出的事件之後自己做。
     * 13 站 4.5：PENDING_PAYMENT（下單的 Saga 往前走完）清購物車；REJECTED（補償）放掉冪等鍵。
     * @return 有沒有建立退款單
     */
    private boolean sideEffects(long orderId, Current cur, Decision d, OrderEvent event, List<Item> items) {
        switch (d.to()) {
            case PENDING_PAYMENT -> cart.removeItems(cur.buyerId(), items.stream().map(Item::productId).toList());   // US-ORD-1 AC-4
            case REJECTED -> keys.forget(orderId);                          // US-ORD-1a AC-4：失敗的結果不快取 —— 同一個鍵再送，是一次新的下單
            case CANCELLED -> {
                if (d.refund()) {
                    var pid = payments.succeededPaymentOf(orderId);
                    pid.ifPresent(p -> payments.requestRefund(p,           // E5 賣家取消、E10 庫存不足：都是「賣方」的原因（V6 的 ck_refunds_reason）
                            event == OrderEvent.BUYER_CANCEL ? RefundReason.BUYER_CANCEL : RefundReason.SELLER_CANCEL, cur.buyerId()));
                    return pid.isPresent();
                }
            }
            default -> { }
        }
        return false;
    }

    /** 0.5.4 表格的右欄：這次轉移之後要發生的事，記成一個事件（跟轉移一起 commit）。PICKING 沒有右欄 */
    private void publish(long orderId, Current cur, OrderStatus to, OrderEvent event, EventData data, boolean refunded, List<Item> items) {
        if (to == OrderStatus.PENDING_PAYMENT) {                           // 13 站 4.5：第 12 站在下單交易裡寫的那一則（通知「訂單成立」、熱點落帳 7.6）
            outbox.add("ORDER", orderId, EventTypes.ORDER_PLACED, Map.of("orderId", orderId, "orderNo", cur.orderNo(),
                    "buyerId", cur.buyerId(), "sellerId", cur.sellerId(), "totalAmount", cur.totalAmount(),
                    "hotProductIds", items.stream().filter(Item::hot).map(Item::productId).sorted().toList()));
            return;
        }
        if (to == OrderStatus.REJECTED) {                                  // 13 站 4.7：補償交給庫存模組 —— 釋放（如果有預留）、熱點閘門加回去
            outbox.add("ORDER", orderId, EventTypes.ORDER_REJECTED, Map.of("orderId", orderId, "orderNo", cur.orderNo(),
                    "buyerId", cur.buyerId(), "event", event.name(),
                    "hotLines", items.stream().filter(Item::hot).map(i -> Map.of("productId", i.productId(), "quantity", i.quantity())).toList()));
            return;
        }
        String type = switch (to) {
            case PAID -> EventTypes.ORDER_PAID;
            case CANCELLED -> EventTypes.ORDER_CANCELLED;
            case SHIPPED -> EventTypes.ORDER_SHIPPED;
            case COMPLETED -> EventTypes.ORDER_COMPLETED;
            default -> null;
        };
        if (type == null) return;
        Map<String, Object> p = new HashMap<>();
        p.put("orderId", orderId);
        p.put("orderNo", cur.orderNo());
        p.put("buyerId", cur.buyerId());
        p.put("sellerId", cur.sellerId());
        p.put("totalAmount", cur.totalAmount());
        p.put("event", event.name());
        if (to == OrderStatus.CANCELLED) {
            p.put("cancelReason", cancelReason(event, data));
            p.put("refund", refunded);
        }
        if (to == OrderStatus.SHIPPED) {
            p.put("carrier", data.carrier());
            p.put("trackingNo", data.trackingNo());
        }
        outbox.add("ORDER", orderId, type, p);
    }

    record Item(long productId, int quantity, boolean hot) {}

    /** 這張訂單的品項（13 站 4.5：hot = 這一個品項過了熱點閘門） */
    List<Item> items(long orderId) {
        return jdbc.query("SELECT product_id, quantity, hot FROM order_items WHERE order_id = ? ORDER BY product_id",
                (rs, i) -> new Item(rs.getLong(1), rs.getInt(2), rs.getBoolean(3)), orderId);
    }

    private static String cancelReason(OrderEvent event, EventData data) {
        return switch (event) {
            case BUYER_CANCEL -> "BUYER";
            case PAYMENT_TIMEOUT -> "PAYMENT_TIMEOUT";
            case SELLER_CANCEL -> data.cancelReason() == null ? "SELLER_OUT_OF_STOCK" : data.cancelReason();
            // 7.6.3：沒有新增一個取消原因 —— 改 ck_orders_cancel_reason_values 要整張 orders 表複製一次（10 萬列 2.25～3.61 秒、期間不能下單）。
            // 對買家來說它就是「缺貨」；真正的原因（E10、actor = SYSTEM）在 order_status_history
            case STOCK_SHORTAGE -> "SELLER_OUT_OF_STOCK";
            default -> throw new IllegalStateException(event + " 不會取消訂單");
        };
    }

    private static String rejectMessage(OrderStatus status, OrderEvent event) {
        if (status == OrderStatus.PICKING && event == OrderEvent.BUYER_CANCEL)
            return "訂單已進入出貨流程，無法取消；請於收貨後申請退貨";            // US-ORD-4 AC-3 的訊息
        return "訂單目前的狀態（" + status + "）不允許這個動作";
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/OrderStateMachine.java`**（4.5.3）

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;

import static com.example.shop.ordering.OrderStatus.*;
import static com.example.shop.ordering.internal.OrderEvent.*;

/**
 * 0.5.3 的 6 × 10 轉移表（E10 是第 07 章加的，7.6.3）。這個類別沒有任何依賴、不碰資料庫 —— 它只回答「在這個狀態收到這個事件，該怎麼辦」。
 * 真正的狀態改變（條件式 UPDATE、預留、退款）由 OrderTransitionService 照著它的答案去做。
 *
 * 13 站 4.5：8 × 13。多兩個狀態（RESERVING、REJECTED）、三個事件（E11 RESERVED、E12 RESERVE_FAILED、E13 PLACEMENT_EXPIRED）。
 * 新的那兩列，舊的十個事件幾乎都是 REJECT 或 IGNORE —— 語意鎖：RESERVING 的訂單只有下單的 Saga 能動它。
 * 舊的六列，新的三個事件：RESERVED 一律 SAME（Saga 已經往前走了，再走一次什麼都不改）；兩個補償一律 IGNORE（預留成功的那一次贏了）。
 */
final class OrderStateMachine {

    private OrderStateMachine() {}

    enum Kind {
        TRANSITION,   // → X
        IDEMPOTENT,   // ＝ 冪等成功，什麼都不改
        REFUND_ONLY,  // ↺ 不轉移，但這筆錢要退
        REJECT,       // ✗ 409 invalid-state
        IGNORE        // · 排程掃到不相干的單，靜默略過
    }

    record Decision(Kind kind, OrderStatus to, boolean refund) {
        static Decision to(OrderStatus s) { return new Decision(Kind.TRANSITION, s, false); }
        static Decision toWithRefund(OrderStatus s) { return new Decision(Kind.TRANSITION, s, true); }
        static final Decision SAME = new Decision(Kind.IDEMPOTENT, null, false);
        static final Decision REFUND = new Decision(Kind.REFUND_ONLY, null, true);
        static final Decision REJECT = new Decision(Kind.REJECT, null, false);
        static final Decision IGNORE = new Decision(Kind.IGNORE, null, false);
    }

    /**
     * @param same E1：這筆付款跟「讓訂單變成已付款」的是同一筆嗎？E7：物流單號跟已出貨的一樣嗎？其他事件不看它。
     */
    static Decision decide(OrderStatus from, OrderEvent event, boolean same) {
        return switch (from) {
            case PENDING_PAYMENT -> switch (event) {
                case PAY_SUCCEEDED -> Decision.to(PAID);
                case PAY_FAILED -> Decision.SAME;                      // 記錄失敗，買家可以在期限內重試（US-ORD-2 AC-7）
                case BUYER_CANCEL, PAYMENT_TIMEOUT -> Decision.to(CANCELLED);
                case SELLER_CANCEL, START_PICKING, SHIP, CONFIRM_RECEIPT -> Decision.REJECT;
                case AUTO_COMPLETE -> Decision.IGNORE;
                case STOCK_SHORTAGE -> Decision.to(CANCELLED);          // 還沒付錢：直接取消
                case RESERVED -> Decision.SAME;                          // 13 站 4.5：Saga 已經往前走了（另一個請求先完成了這一步）
                case RESERVE_FAILED, PLACEMENT_EXPIRED -> Decision.IGNORE;   // 預留成功的那一次贏了
            };
            case PAID -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;   // 同一筆重送 / 付了兩次錢
                case PAY_FAILED -> Decision.SAME;
                case BUYER_CANCEL, SELLER_CANCEL -> Decision.toWithRefund(CANCELLED);
                case PAYMENT_TIMEOUT, AUTO_COMPLETE -> Decision.IGNORE;
                case START_PICKING -> Decision.to(PICKING);
                case SHIP, CONFIRM_RECEIPT -> Decision.REJECT;
                case STOCK_SHORTAGE -> Decision.toWithRefund(CANCELLED);   // 付了錢、貨不存在：取消 + 退款
                case RESERVED -> Decision.SAME;                          // 13 站 4.5：Saga 已經往前走了
                case RESERVE_FAILED, PLACEMENT_EXPIRED -> Decision.IGNORE;   // 預留成功的那一次贏了
            };
            case PICKING -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;
                case PAY_FAILED, START_PICKING -> Decision.SAME;
                case BUYER_CANCEL, CONFIRM_RECEIPT -> Decision.REJECT; // 撿貨中買家不能取消（0.2.2 定案）
                case PAYMENT_TIMEOUT, AUTO_COMPLETE -> Decision.IGNORE;
                case SELLER_CANCEL -> Decision.toWithRefund(CANCELLED);
                case SHIP -> Decision.to(SHIPPED);
                case STOCK_SHORTAGE -> Decision.toWithRefund(CANCELLED);
                case RESERVED -> Decision.SAME;
                case RESERVE_FAILED, PLACEMENT_EXPIRED -> Decision.IGNORE;
            };
            case SHIPPED -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;
                case PAY_FAILED -> Decision.SAME;
                case BUYER_CANCEL, SELLER_CANCEL, START_PICKING -> Decision.REJECT;
                case PAYMENT_TIMEOUT -> Decision.IGNORE;
                case SHIP -> same ? Decision.SAME : Decision.REJECT;    // 同單號重送 / 換了單號（操作錯誤）
                case CONFIRM_RECEIPT, AUTO_COMPLETE -> Decision.to(COMPLETED);
                case STOCK_SHORTAGE -> Decision.IGNORE;                  // 不會發生：落帳沒完成的訂單出不了貨（7.6.4；13 站 4.6.3 之後是出貨之前的 checkShippable）
                case RESERVED -> Decision.SAME;
                case RESERVE_FAILED, PLACEMENT_EXPIRED -> Decision.IGNORE;
            };
            case COMPLETED -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;
                case PAY_FAILED, CONFIRM_RECEIPT -> Decision.SAME;
                case BUYER_CANCEL, SELLER_CANCEL, START_PICKING, SHIP -> Decision.REJECT;
                case PAYMENT_TIMEOUT, AUTO_COMPLETE, STOCK_SHORTAGE -> Decision.IGNORE;
                case RESERVED -> Decision.SAME;
                case RESERVE_FAILED, PLACEMENT_EXPIRED -> Decision.IGNORE;
            };
            case CANCELLED -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;   // 晚到的付款（0.2.2 的 2,042 筆）
                case PAY_FAILED, BUYER_CANCEL, SELLER_CANCEL, STOCK_SHORTAGE -> Decision.SAME;
                case PAYMENT_TIMEOUT, AUTO_COMPLETE -> Decision.IGNORE;
                case START_PICKING, SHIP, CONFIRM_RECEIPT -> Decision.REJECT;
                case RESERVED -> Decision.SAME;
                case RESERVE_FAILED, PLACEMENT_EXPIRED -> Decision.IGNORE;
            };
            // ── 13 站 4.5：下單的 Saga ──
            case RESERVING -> switch (event) {
                case RESERVED -> Decision.to(PENDING_PAYMENT);           // 樞紐（pivot）過了：往前走到底
                case RESERVE_FAILED, PLACEMENT_EXPIRED -> Decision.to(REJECTED);   // 補償
                case PAY_SUCCEEDED -> Decision.REJECT;                   // 不會發生：建立付款要 PENDING_PAYMENT（US-ORD-2 AC-1）
                case PAY_FAILED -> Decision.SAME;
                case BUYER_CANCEL, SELLER_CANCEL, START_PICKING, SHIP, CONFIRM_RECEIPT -> Decision.REJECT;   // 語意鎖
                case PAYMENT_TIMEOUT, AUTO_COMPLETE, STOCK_SHORTAGE -> Decision.IGNORE;
            };
            case REJECTED -> switch (event) {
                case RESERVED -> Decision.REJECT;                        // 太晚了：補償已經開始（呼叫端回 503，請買家重送）
                case RESERVE_FAILED, PLACEMENT_EXPIRED, PAY_FAILED -> Decision.SAME;
                case PAY_SUCCEEDED -> Decision.REFUND;                   // 不會發生；萬一發生，錢要退（跟 CANCELLED 一樣）
                case BUYER_CANCEL, SELLER_CANCEL, START_PICKING, SHIP, CONFIRM_RECEIPT -> Decision.REJECT;
                case PAYMENT_TIMEOUT, AUTO_COMPLETE, STOCK_SHORTAGE -> Decision.IGNORE;
            };
        };
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/OrderJobs.java`**（4.5.5）

```java
package com.example.shop.ordering.internal;

import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ShopException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.util.List;

/**
 * 4.7 兩個排程：付款逾時取消（US-ORD-3）、出貨 7 天自動完成（US-ORD-6 AC-4）。13 站 4.5 多一個：卡在 RESERVING 的訂單補償掉。
 * 每張訂單各自一個交易（OrderTransitionService.apply）：一張失敗不影響其他張。
 * 多台機器同時跑時不需要分散式鎖 —— 條件式 UPDATE 保證每張訂單只會被轉移一次（AC-3，4.7.2 實測）。
 */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
@ConditionalOnProperty(name = "shop.order.jobs-enabled", havingValue = "true", matchIfMissing = true)
class OrderJobs implements SchedulingConfigurer {

    private static final Logger log = LoggerFactory.getLogger(OrderJobs.class);
    static final int BATCH = 100;
    static final Duration AUTO_COMPLETE_AFTER = Duration.ofDays(7);

    private final JdbcTemplate jdbc;
    private final OrderTransitionService transitions;
    private final Clock clock;
    private final Duration interval;
    private final Duration placementTimeout;

    OrderJobs(JdbcTemplate jdbc, OrderTransitionService transitions, Clock clock, ShopProperties props) {
        this.jdbc = jdbc;
        this.transitions = transitions;
        this.clock = clock;
        this.interval = props.order().timeoutScanInterval();
        this.placementTimeout = props.order().placementTimeout();
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(this::cancelExpired, interval);
        registrar.addFixedDelayTask(this::autoComplete, interval);
        registrar.addFixedDelayTask(this::expirePlacements, interval);
        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(this::purgeIdempotencyKeys, Duration.ofHours(1), Duration.ofMinutes(10)));
    }

    /** 走 idx_orders_status_deadline（2.7.2：covering index range scan） */
    int cancelExpired() {
        List<Long> ids = jdbc.queryForList("""
                SELECT id FROM orders WHERE status = 'PENDING_PAYMENT' AND payment_deadline < ?
                 ORDER BY payment_deadline LIMIT ?""", Long.class, Timestamp.from(clock.instant()), BATCH);
        return applyEach(ids, OrderEvent.PAYMENT_TIMEOUT);
    }

    /** 9.11 0.6.7：冪等鍵保留 24 小時（expires_at，US-ORD-1a AC-6）。一次 1,000 列，刪到沒有為止（7.4.4） */
    int purgeIdempotencyKeys() {
        int total = 0, n;
        do {
            n = jdbc.update("DELETE FROM idempotency_keys WHERE expires_at < ? ORDER BY expires_at LIMIT 1000", Timestamp.from(clock.instant()));
            total += n;
        } while (n == 1000);
        if (total > 0) log.info("IDEMPOTENCY_KEYS_PURGED {} 列", total);
        return total;
    }

    /**
     * 13 站 4.5：下單的 Saga 停在中間 —— T1 commit 了（訂單 RESERVING），之後沒有人把它做完：協調者的行程不見了、預留兩次都沒有回應、
     * 買家沒有用同一個鍵重送。往回走（補償）：REJECTED、放掉冪等鍵、order.rejected（庫存模組釋放預留、把熱點閘門加回去）。
     * 不往前走：買家看到的是錯誤（或什麼都沒看到），不該在他不知道的時候多出一張待付款的訂單。
     * 走 idx_orders_status_deadline 的 status 前綴：RESERVING 的訂單只有幾張
     */
    int expirePlacements() {
        List<Long> ids = jdbc.queryForList("""
                SELECT id FROM orders WHERE status = 'RESERVING' AND created_at < ?
                 ORDER BY id LIMIT ?""", Long.class, Timestamp.from(clock.instant().minus(placementTimeout)), BATCH);
        return applyEach(ids, OrderEvent.PLACEMENT_EXPIRED);
    }

    int autoComplete() {
        List<Long> ids = jdbc.queryForList("""
                SELECT id FROM orders WHERE status = 'SHIPPED' AND shipped_at < ?
                 ORDER BY shipped_at LIMIT ?""", Long.class, Timestamp.from(clock.instant().minus(AUTO_COMPLETE_AFTER)), BATCH);
        return applyEach(ids, OrderEvent.AUTO_COMPLETE);
    }

    private int applyEach(List<Long> ids, OrderEvent event) {
        int changed = 0;
        for (long id : ids) {
            try {
                var before = transitions.current(id).status();
                if (transitions.apply(id, event, OrderHistory.Actor.system(), OrderTransitionService.EventData.NONE) != before) changed++;
            } catch (ShopException e) {
                log.warn("排程 {} 處理訂單 {} 失敗：{}", event, id, e.getMessage());
            } catch (RuntimeException e) {
                // 4.7.1 ① 的追記：資料庫錯誤（死鎖、鎖等待逾時）也只算這一張 —— 第一版只接 ShopException，
                // 這一種例外會跳出迴圈，同一批後面的訂單這一輪都不處理（OrderJobsIsolationTest）。下一輪會再撈到它
                log.error("排程 {} 處理訂單 {} 發生錯誤（下一輪再試）", event, id, e);
            }
        }
        if (!ids.isEmpty()) log.info("排程 {}：掃到 {} 張，轉移 {} 張", event, ids.size(), changed);   // 其他實例搶先處理的，算在「掃到」不算在「轉移」
        return changed;
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/web/AdminOrderSagaController.java`**（4.9）

```java
package com.example.shop.ordering.internal.web;

import com.example.shop.ordering.internal.OrderSagaView;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.Role;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * 13 站 4.9：管理員看一張訂單的 Saga（OrderSagaView）。任何一張訂單都看得到 —— 包括買家看不到的 RESERVING、REJECTED（值班的人要的就是這些）。
 * /api/admin/** 在 SecurityConfig 已經是 hasRole("ADMIN")；這裡再 require 一次，跟其他管理員的 API 一樣
 */
@RestController
class AdminOrderSagaController {

    private final OrderSagaView sagas;

    AdminOrderSagaController(OrderSagaView sagas) { this.sagas = sagas; }

    @GetMapping("/api/admin/orders/{orderNo}/saga")
    OrderSagaView.SagaView saga(CurrentUser user, @PathVariable String orderNo) {
        user.require(Role.ADMIN);
        return sagas.of(orderNo);
    }
}
```

**`src/main/java/com/example/shop/inventory/InventoryApi.java`**（4.5.4、4.6.3、4.6.4）

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
     * 為一張訂單預留庫存（每個品項一筆 HELD 預留）。全有或全無：任何一個品項不足就丟例外，這一次什麼都沒留下。
     * 內部會依 productId 排序後才加鎖（4.2.3：避免兩張訂單以相反的順序鎖同樣兩個商品而死鎖）。
     *
     * hotLines：7.6 熱點商品的品項（已經過了 Redis 的閘門 gateHot）—— 只寫預留列（HELD、counted = FALSE），**不碰 inventory 那一列**，
     * 數量由 inventory.hot-settlement 消費者在 commit 之後計入 reserved（最終一致，0.6.4：60 秒）。
     * 13 站 3.4：第 12 站這是另一個方法 holdHot()。一張訂單同時有一般與熱點的品項時是兩次呼叫 —— 在一個行程裡無所謂；
     * 切開之後是兩次往返、兩個交易：第一個 commit 了、第二個失敗，第一個就留下沒有訂單的預留。合成一個：一張訂單的預留，一次、全有或全無
     *
     * 13 站 4.5：不再是 MANDATORY。它是下單 Saga 的一步：自己的交易、在訂單的交易之外呼叫，而且以 orderId 冪等 ——
     * 同一張訂單再呼叫一次（協調者不知道上一次成功了沒有），內容一樣就什麼都不做；這張訂單的預留已經被補償掉了 → 409（4.7）。
     */
    void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines);

    // 13 站 4.6：confirm、release、consume 從這個介面拿掉了。付款、取消、出貨之後，庫存模組收 order.paid、order.cancelled、order.shipped，
    // 自己在自己的交易裡做（InventoryEventHandlers.orderEvents）—— 沒有別的模組會再呼叫它們

    /**
     * 13 站 4.6.3：出貨之前問一次（只讀）—— 出貨是補償不回來的：貨出了門就收不回來。第 12 站 7.6.4 的兩個「不」原樣保留：
     * 熱點預留還沒落帳 → 503（幾秒後就好）；有預留已經釋放（落帳發現不夠、取消在路上）→ 409。
     * 在出貨的交易之外呼叫：「已落帳、沒有釋放」一旦成立，只有取消能改變它，而取消與出貨由訂單的狀態機排隊（條件式 UPDATE）
     */
    void checkShippable(long orderId);

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
     * 13 站 4.7：釋放之後，這個 orderId 再也預留不了 —— 一個晚到的 reserve（網路上卡住的那一次）不能把它變回來
     */
    void releaseAbandoned(long orderId);
}
```

**`src/main/java/com/example/shop/inventory/internal/JdbcInventoryService.java`**（4.5.4、4.6.2、4.6.3、4.6.4、4.7）

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.inventory.ReservationRef;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.events.EventTypes;
import com.example.shop.shared.events.Inbox;
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
import java.util.TreeMap;

@Service
class JdbcInventoryService implements InventoryApi {

    /** US-PRD-3 AC-4：一般商品的可售量顯示，允許 5 秒的延遲 */
    static final Duration DISPLAY_TTL = Duration.ofSeconds(5);

    /**
     * 13 站 3.5：一張訂單的預留在 processed_messages 裡的那一列（consumer 欄）。名字是第 03 章取的（那時只有 HTTP 用它）：
     * 13 站 4.5 之後單體也用 —— 名字不改，改了的話，上線之前就預留過的訂單，重送時認不出來（uk_reservations_order_product 會擋下，變成 500）
     */
    static final String RESERVE_KEY = "inventory.http.reserve";

    private static final Logger log = LoggerFactory.getLogger(JdbcInventoryService.class);

    private final JdbcTemplate jdbc;
    private final HotStock hot;
    private final StringRedisTemplate redis;
    private final RedisGuard guard;
    private final Outbox outbox;
    private final Inbox inbox;
    private final Counter shortages, consumeConflicts;
    /** 6.9.2 Redis 不能用的時候，可售量在本機記憶體裡放 5 秒（AC-4 允許的延遲）：不然每一次看商品頁都是一句 MySQL */
    private final java.util.concurrent.ConcurrentHashMap<Long, long[]> degradedAvailable = new java.util.concurrent.ConcurrentHashMap<>();

    JdbcInventoryService(JdbcTemplate jdbc, HotStock hot, StringRedisTemplate redis, RedisGuard guard, Outbox outbox, Inbox inbox, MeterRegistry meters) {
        this.jdbc = jdbc;
        this.hot = hot;
        this.redis = redis;
        this.guard = guard;
        this.outbox = outbox;
        this.inbox = inbox;
        this.shortages = Counter.builder("shop.inventory.hot.shortage")
                .description("熱點落帳時 MySQL 不夠（Redis 的閘門放進了不存在的庫存）→ 訂單會被取消。正常應該永遠是 0").register(meters);
        this.consumeConflicts = Counter.builder("shop.inventory.consume.conflict")
                .description("13 站 4.6.3：訂單已經出貨，它的預留卻已經釋放（熱點落帳失敗比出貨晚到）。正常應該永遠是 0，發生了要有人看").register(meters);
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

    /** 13 站 4.5：自己的交易（下單 Saga 的一步）。冪等：見 reserveOnce */
    @Override
    @Transactional
    public void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        reserveIdempotently(orderId, lines, hotLines);
    }

    /** 同 reserve()，多回傳「這一次是不是重送」—— 庫存服務的 PUT /reservations 要用它回 Idempotent-Replayed（3.5.2） */
    @Transactional
    public boolean reserveOnce(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        return reserveIdempotently(orderId, lines, hotLines);
    }

    /**
     * 13 站 3.5 的那一套（第 03 章在 InventoryService 裡，只有 HTTP 用），4.5 搬到這裡：單體裡的 Saga 一樣會重送。
     *   processed_messages 那一列是交易的第一句：同一張訂單同時來兩次，第二個在這一句等第一個 commit
     *   已經有了 → 重送：內容一樣 → 什麼都不做（true）；內容不一樣 → 422；這張訂單的預留已經被補償掉（一筆都沒有，或已經 RELEASED）→ 409
     * 第一次失敗了（庫存不足 → 交易 rollback，那一列也不在）→ 再送一次會重新判斷，不是「已經處理過」
     */
    private boolean reserveIdempotently(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        if (inbox.claim(RESERVE_KEY, Long.toString(orderId))) {
            reserveCounted(orderId, lines);
            if (!hotLines.isEmpty()) holdHot(orderId, hotLines);
            return false;
        }
        List<ReservationRef> have = reservationsOf(List.of(orderId)).getOrDefault(orderId, List.of());
        if (have.isEmpty() || have.stream().anyMatch(r -> r.status().equals("RELEASED")))
            throw new ShopException(ProblemType.INVALID_STATE, "訂單 " + orderId + " 的預留已經取消，不能再預留").with("orderId", orderId);   // 4.7.2
        Map<Long, Integer> asked = new TreeMap<>(), had = new TreeMap<>();
        lines.forEach(l -> asked.merge(l.productId(), l.quantity(), Integer::sum));
        hotLines.forEach(l -> asked.merge(l.productId(), l.quantity(), Integer::sum));
        have.forEach(r -> had.merge(r.productId(), r.quantity(), Integer::sum));
        if (!asked.equals(had))
            throw new ShopException(ProblemType.IDEMPOTENCY_KEY_REUSED, "訂單 " + orderId + " 已經用不同的內容預留過").with("orderId", orderId);
        return true;
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

    /**
     * 付款成功：這張訂單的預留 HELD → CONFIRMED（不再能被逾時釋放）。數量不變，不記帳。MANDATORY。
     * 13 站 4.6：order.paid 的消費者呼叫它（第 12 站是付款回呼的交易裡）。只改 HELD 的：已經出庫、已經釋放的不動 —— 事件晚到、亂序都無妨
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void confirm(long orderId) {
        jdbc.update("""
                UPDATE inventory_reservations SET status = 'CONFIRMED', updated_at = CURRENT_TIMESTAMP(3)
                 WHERE order_id = ? AND status = 'HELD'""", orderId);
    }

    /**
     * 取消：這張訂單的預留 → RELEASED，reserved 減回，每個品項一筆 RELEASE。已釋放的不重複釋放（冪等）。MANDATORY。
     * 13 站 4.6：order.cancelled 的消費者呼叫它（第 12 站是取消的交易裡）
     */
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

    /**
     * 出貨：預留 → CONSUMED，onHand 與 reserved 同時減少，每個品項一筆 SHIP。MANDATORY。
     *
     * 13 站 4.6：order.shipped 的消費者呼叫它（第 12 站是出貨的交易裡，在那裡它可以拒絕：還在落帳 503、即將取消 409）。
     * 那兩個「不」搬到出貨之前（checkShippable，4.6.3）；到了這裡，訂單已經是 SHIPPED —— 貨出去了，這裡不能說不：
     *   ① order.shipped 可能比 order.paid 先到（兩個事件、各自的重試，第 12 站 7.5.4：順序不保證）—— HELD 的也出庫（出貨就隱含了確認）
     *   ② 熱點預留還沒落帳 —— 出貨之前問過了，不應該發生；萬一發生（例如繞過了那一次檢查），先落帳、再出庫
     *   ③ 落帳發現不夠 —— 那一列 RELEASED、發 hot-settlement-failed（訂單已經出貨，ordering 會忽略它）；
     *      其他品項照樣出庫，這一件記一筆衝突（shop.inventory.consume.conflict）：要有人去看貨到底在不在
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void consume(long orderId) {
        while (settleHot(orderId) < 0) { /* 每一次 -1 釋放一列不夠的；剩下的再落帳一次 */ }
        for (Held h : held(orderId, "'HELD', 'CONFIRMED'")) {
            jdbc.update("""
                    UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE product_id = ?""", h.quantity(), h.quantity(), h.productId());
            jdbc.update("UPDATE inventory_reservations SET status = 'CONSUMED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
            ledger(h.productId(), -h.quantity(), -h.quantity(), "SHIP", "order:" + orderId);
        }
        List<Long> released = jdbc.queryForList("SELECT product_id FROM inventory_reservations WHERE order_id = ? AND status = 'RELEASED'",
                Long.class, orderId);
        if (!released.isEmpty()) {
            consumeConflicts.increment();
            log.error("INVENTORY_CONSUME_CONFLICT orderId={} productIds={}：訂單已經出貨，這幾個品項的預留已經釋放（4.6.3）", orderId, released);
        }
    }

    /**
     * 第 03 章 v1 的 POST /reservations/{orderId}/consume 的語意（第 12 站 7.6.4）：只出庫 CONFIRMED 的；熱點還沒落帳 → 503；
     * 有預留已經釋放（落帳發現不夠、取消在路上）→ 409。線上那一版訂單服務在出貨的交易裡同步呼叫它，靠的就是這兩個「不」（3.8.5 的契約）。
     * 13 站 4.6：新的出庫（consume）不拒絕 —— 兩個不一樣的操作，不共用一個方法。這一個等那一版訂單服務下線之後，跟端點一起拿掉
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void consumeConfirmed(long orderId) {
        List<Held> rows = held(orderId, "'CONFIRMED'");
        refuseToShip(orderId, rows.stream().anyMatch(h -> !h.counted()));
        for (Held h : rows) {
            jdbc.update("""
                    UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE product_id = ?""", h.quantity(), h.quantity(), h.productId());
            jdbc.update("UPDATE inventory_reservations SET status = 'CONSUMED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
            ledger(h.productId(), -h.quantity(), -h.quantity(), "SHIP", "order:" + orderId);
        }
    }

    /** 13 站 4.6.3：出貨之前問一次。一句加鎖的讀都沒有 —— 只讀、不改，跟出貨的交易無關 */
    @Override
    public void checkShippable(long orderId) {
        Integer unsettled = jdbc.queryForObject("""
                SELECT COUNT(*) FROM inventory_reservations WHERE order_id = ? AND status IN ('HELD', 'CONFIRMED') AND counted = FALSE""",
                Integer.class, orderId);
        refuseToShip(orderId, unsettled != null && unsettled > 0);
    }

    /** 第 12 站 7.6.4 的兩個「不」 */
    private void refuseToShip(long orderId, boolean unsettled) {
        if (unsettled)                                                      // 7.6.4：落帳還沒完成。幾秒後就會好 —— 出貨不差這幾秒
            throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "這張訂單的庫存還在落帳，請稍後再出貨").with("retryAfter", 5);
        // 7.6.4：落帳發現不夠、那一列已經 RELEASED，取消的事件還在路上。這時候出貨 = 出一件不存在的貨（onHand 不會減）
        Integer released = jdbc.queryForObject("SELECT COUNT(*) FROM inventory_reservations WHERE order_id = ? AND status = 'RELEASED'", Integer.class, orderId);
        if (released != null && released > 0)
            throw new ShopException(ProblemType.INVALID_STATE, "這張訂單有商品庫存不足，即將取消，不能出貨");
    }

    /**
     * 13 站 4.7：order.rejected 的補償。下單的 Saga 走不完 —— 這張訂單可能預留過（樞紐之後才當掉）、也可能從來沒有（庫存不足、或樞紐之前就當掉）。
     *   ① 先佔掉這張訂單在 processed_messages 的預留那一列（reserveIdempotently 的第一句）：
     *      佔到了 → 從來沒有預留過，以後也不會了 —— 一個還在網路上的 reserve 晚到，會看到這一列、拿到 409（補償比動作先到）。
     *               熱點閘門扣的那幾件沒有變成預留，照 hotLines 加回去
     *      佔不到 → 預留過（或另一個補償先佔了）→ 照一般的取消釋放；釋放的熱點品項，release() 自己會加回閘門
     *   ② 同一句 INSERT 也讓「補償」與「正在進行的那一次預留」排隊：預留還沒 commit 時，這裡等它；它 rollback 了，這裡才佔得到
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void releaseRejected(long orderId, List<ReserveLine> hotLines) {
        if (inbox.claim(RESERVE_KEY, Long.toString(orderId))) returnToHotStock(orderId, hotLines);
        else release(orderId);
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
        inbox.claim(RESERVE_KEY, Long.toString(orderId));                  // 13 站 4.7：釋放之後，這個 orderId 再也預留不了
        release(orderId);                                                   // 同一個物件裡呼叫：不經過代理，MANDATORY 不檢查 —— 這個交易就是它的交易
    }

    private void ledger(long productId, int deltaOnHand, int deltaReserved, String reason, String ref) {
        jdbc.update("""
                INSERT INTO inventory_ledger(product_id, delta_on_hand, delta_reserved, reason, ref)
                VALUES (?, ?, ?, ?, ?)""", productId, deltaOnHand, deltaReserved, reason, ref);
    }
}
```

**`src/main/java/com/example/shop/inventory/internal/InventoryEventHandlers.java`**（4.6.1）

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.ReserveLine;
import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.EventTypes;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** 7.6 庫存模組的兩個消費者（13 站 2.7 多了 product.created，4.6 多了訂單的事件） */
@Configuration(proxyBeanMethods = false)
class InventoryEventHandlers {

    private static final Logger log = LoggerFactory.getLogger(InventoryEventHandlers.class);

    /**
     * 7.6.2 熱點落帳：order.placed 帶著 hotProductIds 的，把預留的數量計入 inventory.reserved。
     * 交易與冪等由 EventDispatcher 負責：processed_messages 那一列跟 reserved += 一起 commit（驗收 Q10）。
     */
    @Bean
    EventHandler hotSettlement(JdbcInventoryService inventory) {
        return new EventHandler() {
            @Override public String consumer() { return "inventory.hot-settlement"; }
            @Override public Set<String> eventTypes() { return Set.of(EventTypes.ORDER_PLACED); }
            @Override public void handle(Event e) {
                if (e.getLongs("hotProductIds").isEmpty()) return;          // 一般商品：下單交易裡就計入了（第 04 章的路徑）
                inventory.settleHot(e.getLong("orderId"));
            }
        };
    }

    /**
     * 13 站 2.7：建立商品的期初庫存。第 12 站是 catalog 在建立商品的交易裡呼叫 initialize()（MANDATORY）；
     * 庫存搬到自己的資料庫之後，那不再是同一個交易，改成收 product.created。冪等由 EventDispatcher 負責（processed_messages）
     */
    @Bean
    EventHandler productCreated(JdbcInventoryService inventory) {
        return new EventHandler() {
            @Override public String consumer() { return "inventory.product-created"; }
            @Override public Set<String> eventTypes() { return Set.of(EventTypes.PRODUCT_CREATED); }
            @Override public void handle(Event e) {
                inventory.initialize(e.getLong("productId"), e.payload().get("initialStock").asInt(), "product-created");
            }
        };
    }

    /**
     * 13 站 4.6：訂單往前走了，庫存跟上 —— 協同（choreography）。第 12 站這四件事在訂單的交易裡（OrderTransitionService.sideEffects），
     * 切開之後那是一次交易裡的遠端呼叫（第 00 章的四個代價）；現在訂單的交易只寫自己的庫，順便寫一則事件，庫存模組收到之後在自己的交易裡做：
     *   order.paid      → confirm（HELD → CONFIRMED）
     *   order.cancelled → release（→ RELEASED，reserved 減回，熱點閘門加回去）
     *   order.shipped   → consume（→ CONSUMED，on_hand、reserved 減少）
     *   order.rejected  → releaseRejected（下單的 Saga 的補償，4.7）
     * 一個佇列、四種事件：同一張訂單的事件不保證順序（重試會讓後發的先到，第 12 站 7.5.4），每一個方法都只看「預留現在是什麼狀態」，
     * 所以任何順序都收斂到同一個結果（4.6.2）。交易與冪等由 EventDispatcher 負責（processed_messages 跟這幾句 UPDATE 一起 commit）
     */
    @Bean
    EventHandler orderEvents(JdbcInventoryService inventory) {
        return new EventHandler() {
            @Override public String consumer() { return "inventory.order-events"; }
            @Override public Set<String> eventTypes() {
                return Set.of(EventTypes.ORDER_PAID, EventTypes.ORDER_CANCELLED, EventTypes.ORDER_SHIPPED, EventTypes.ORDER_REJECTED);
            }
            @Override public void handle(Event e) {
                long orderId = e.getLong("orderId");
                switch (e.type()) {
                    case EventTypes.ORDER_PAID -> inventory.confirm(orderId);
                    case EventTypes.ORDER_CANCELLED -> inventory.release(orderId);
                    case EventTypes.ORDER_SHIPPED -> inventory.consume(orderId);
                    case EventTypes.ORDER_REJECTED -> {
                        List<ReserveLine> hotLines = new ArrayList<>();
                        e.payload().get("hotLines").forEach(l -> hotLines.add(new ReserveLine(l.get("productId").asLong(), l.get("quantity").asInt())));
                        inventory.releaseRejected(orderId, hotLines);
                    }
                    default -> throw new IllegalStateException("沒有訂閱 " + e.type());
                }
            }
        };
    }

    /**
     * 7.6.5 取消、補貨之後，熱點商品的 Redis 閘門加回去。Redis 的 INCRBY 不在 MySQL 的交易裡：
     * INCRBY 成功、commit 之前行程死掉 → 重送時再加一次 → 偏高（6.5.3 的安全方向）；反過來的順序會偏低，所以 INCRBY 在交易「裡面」做。
     */
    @Bean
    EventHandler hotStockReturn(HotStock hot) {
        return new EventHandler() {
            @Override public String consumer() { return "inventory.hot-stock-return"; }
            @Override public Set<String> eventTypes() { return Set.of(EventTypes.STOCK_RETURNED); }
            @Override public void handle(Event e) {
                List<ReserveLine> lines = new ArrayList<>();
                e.payload().get("lines").forEach(l -> lines.add(new ReserveLine(l.get("productId").asLong(), l.get("quantity").asInt())));
                hot.giveBackOrFail(lines);
            }
            @Override public void onDeadLetter(Event e, Exception lastError) {
                log.error("HOT_STOCK_RETURN_DEAD 熱點庫存沒有加回去（Redis 掛太久）：{}；Redis 偏低，等對帳（6.6）修正", e.payload());
            }
        };
    }
}
```

**`src/main/java/com/example/shop/inventory/internal/InventoryService.java`**（4.6.3、4.6.4）

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.ReservationRef;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.shared.config.ConditionalOnServiceRole;
import com.example.shop.shared.config.ServiceRole;
import com.example.shop.shared.events.Inbox;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;

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
 * 13 站 4.5：reserve 的冪等搬進 JdbcInventoryService.reserveOnce（單體裡的 Saga 一樣會重送）。
 * 13 站 4.6：訂單服務不再呼叫 confirm、consume —— 庫存服務自己收 order.paid、order.shipped。兩支端點還在：
 * 線上那一版訂單服務的契約裡有它們（3.8.5），等那一版不在線上了才能拿掉。release 只剩對帳在用（releaseAbandoned）。
 *
 * 只在庫存服務裡存在（role = inventory-service）。
 */
@Component
@ConditionalOnServiceRole(ServiceRole.INVENTORY_SERVICE)
public class InventoryService {

    static final String RESTOCK = "inventory.http.restock";

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
     * 13 站 4.7：這張訂單已經被補償了（order.rejected、對帳的釋放）→ 409
     */
    public boolean reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        return inventory.reserveOnce(orderId, lines, hotLines);
    }

    public void confirm(long orderId) { tx.executeWithoutResult(s -> inventory.confirm(orderId)); }

    /** 也是對帳的 releaseAbandoned()：在服務之間，兩個是同一件事（每一次呼叫本來就是自己的交易）。13 站 4.7：釋放之後，這個 orderId 再也預留不了 */
    public void release(long orderId) { inventory.releaseAbandoned(orderId); }

    /** 13 站 4.6：v1 端點的語意不變（還在落帳 503、即將取消 409）—— 線上那一版訂單服務靠它拒絕出貨（JdbcInventoryService.consumeConfirmed） */
    public void consume(long orderId) { tx.executeWithoutResult(s -> inventory.consumeConfirmed(orderId)); }

    /** @return true = 重送（這個鍵已經補過了） */
    public boolean restock(String key, long productId, int quantity, String note) {
        boolean first = Boolean.TRUE.equals(tx.execute(s -> {
            if (!inbox.claim(RESTOCK, key)) return false;
            inventory.restock(productId, quantity, note);
            return true;
        }));
        return !first;
    }

    /** 13 站 4.6.3：出貨之前問一次（只讀） */
    public void checkShippable(long orderId) { inventory.checkShippable(orderId); }

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

只改了幾行的（`d03` → `d04` 的 diff）：

**`src/main/java/com/example/shop/ordering/OrderingApi.java`**

```diff
     /**
      * US-ORD-1 下單。寫訂單、明細、預留庫存、清購物車，同一個交易（4.4）。
      * 同一位買家、同一個 idempotencyKey、同樣的內容再送一次，回傳同一張訂單（replayed = true）。
+     * 13 站 4.5：不再是同一個交易，是一個 Saga（訂單 RESERVING → 預留 → PENDING_PAYMENT）。上一次停在中間（503、行程不見了）的話，
+     * 同一個鍵再送一次會接著把它做完，回傳的也是那一張（replayed = true）。
      */
     PlacedOrder placeOrder(long buyerId, String idempotencyKey, List<OrderLine> lines);
 
```

**`src/main/java/com/example/shop/ordering/internal/IdempotencyKeys.java`**

```diff
  *   claim()    —— 自己的短交易（REQUIRES_NEW）：插入一列 PROCESSING，帶 30 秒租約。插入成功 = 這個請求取得了這個鍵
  *   complete() —— 在「下單交易」裡：PROCESSING → SUCCEEDED 並記下訂單 id。跟訂單一起 commit，一起 rollback
  *   release()  —— 自己的短交易：下單失敗時刪掉 PROCESSING 的列，讓重試可以重新執行（AC-4：失敗不快取）
+ * 13 站 4.5：complete() 在 Saga 的第一個交易裡（訂單還是 RESERVING）就把鍵綁到訂單上 —— 同一個鍵重送，接著做那一張；
+ * 那一張被拒絕（REJECTED）時 forget() 放掉它。
  */
 @Component
 class IdempotencyKeys {
…
         if (n == 0) throw new ShopException(ProblemType.IDEMPOTENCY_IN_PROGRESS, "這個請求的處理權已被另一個請求接手").with("retryAfter", 1);
     }
 
+    /**
+     * 13 站 4.5：下單的 Saga 走不完（REJECTED）—— 這張訂單的鍵放掉，跟 REJECTED 同一個交易。
+     * 同一個鍵再送，是一次新的下單（AC-4：失敗的結果不快取）；鍵在 RESERVING 的時候還在，所以重送會接著把那一張做完（4.5.4）
+     */
+    @Transactional(propagation = Propagation.MANDATORY)
+    void forget(long orderId) {
+        jdbc.update("DELETE FROM idempotency_keys WHERE order_id = ?", orderId);
+    }
+
     void release(long buyerId, String key) {
         newTx.executeWithoutResult(s -> jdbc.update(
                 "DELETE FROM idempotency_keys WHERE buyer_id = ? AND idem_key = ? AND status = 'PROCESSING'", buyerId, key));
```

**`src/main/java/com/example/shop/ordering/internal/Order.java`**

```diff
 
     protected Order() {}
 
-    /** US-ORD-1：建立一張待付款的訂單。金額由伺服器用資料庫的價格算（AC-2），客戶端的價格只拿來比對（AC-6） */
+    /**
+     * US-ORD-1：建立一張訂單。金額由伺服器用資料庫的價格算（AC-2），客戶端的價格只拿來比對（AC-6）。
+     * 13 站 4.5：先以 RESERVING 寫下（語意鎖）—— 庫存預留成功之後，下單的 Saga 才把它變成 PENDING_PAYMENT
+     */
     static Order place(String orderNo, long buyerId, long sellerId, Instant now, Instant paymentDeadline) {
         Order o = new Order();
         o.orderNo = orderNo;
         o.buyerId = buyerId;
         o.sellerId = sellerId;
-        o.status = OrderStatus.PENDING_PAYMENT;
+        o.status = OrderStatus.RESERVING;
         o.totalAmount = BigDecimal.ZERO.setScale(2);
         o.paymentDeadline = paymentDeadline;
         o.createdAt = now;
…
         return o;
     }
 
-    void addItem(long productId, String productName, BigDecimal unitPrice, int quantity) {
-        items.add(new OrderItem(this, productId, productName, unitPrice, quantity));
+    void addItem(long productId, String productName, BigDecimal unitPrice, int quantity, boolean hot) {
+        items.add(new OrderItem(this, productId, productName, unitPrice, quantity, hot));
         totalAmount = totalAmount.add(unitPrice.multiply(BigDecimal.valueOf(quantity))).setScale(2, java.math.RoundingMode.HALF_UP);
     }
 
```

**`src/main/java/com/example/shop/ordering/internal/OrderItem.java`**

```diff
     @Column(precision = 12, scale = 2, insertable = false, updatable = false)
     private BigDecimal lineAmount;                 // 資料庫的產生欄位（unit_price * quantity），唯讀
 
+    @Column(nullable = false, updatable = false)
+    private boolean hot;                           // 13 站 4.5：這一個品項過了熱點閘門（補償時要加回 Redis 的那幾件）
+
     protected OrderItem() {}
 
-    OrderItem(Order order, long productId, String productName, BigDecimal unitPrice, int quantity) {
+    OrderItem(Order order, long productId, String productName, BigDecimal unitPrice, int quantity, boolean hot) {
         this.order = order;
         this.productId = productId;
         this.productName = productName;
         this.unitPrice = unitPrice;
         this.quantity = quantity;
+        this.hot = hot;
     }
 
     Long getId() { return id; }
```

**`src/main/java/com/example/shop/ordering/internal/OrderEvent.java`**

```diff
 package com.example.shop.ordering.internal;
 
-/** 0.5.2 的九個事件，加上第 07 章的 E10（7.6.3） */
+/** 0.5.2 的九個事件，加上第 07 章的 E10（7.6.3）、13 站第 04 章的 E11～E13（4.5） */
 enum OrderEvent {
     PAY_SUCCEEDED,    // E1 金流回呼
     PAY_FAILED,       // E2 金流回呼
…
     SHIP,             // E7 賣家
     CONFIRM_RECEIPT,  // E8 買家
     AUTO_COMPLETE,    // E9 排程
-    STOCK_SHORTAGE    // E10 系統：熱點商品落帳時發現庫存不足（7.6.3）。訂單已經回了 201，現在才知道沒有貨
+    STOCK_SHORTAGE,   // E10 系統：熱點商品落帳時發現庫存不足（7.6.3）。訂單已經回了 201，現在才知道沒有貨
+    RESERVED,         // E11 13 站 4.5 下單的 Saga：庫存服務預留成功 —— RESERVING → PENDING_PAYMENT
+    RESERVE_FAILED,   // E12 同上：庫存不足（補償）—— RESERVING → REJECTED
+    PLACEMENT_EXPIRED // E13 同上：卡在 RESERVING 太久（排程，補償）—— RESERVING → REJECTED
 }
```

**`src/main/java/com/example/shop/ordering/internal/OrderRepository.java`**

```diff
 import org.springframework.data.jpa.repository.Query;
 import org.springframework.data.repository.query.Param;
 
+import java.util.Collection;
 import java.util.Optional;
 
+/**
+ * 13 站 4.5：買家、賣家看得到的訂單，不含還沒成立的（OrderStatus.NOT_PLACED：RESERVING、REJECTED）。
+ * 對他們來說那張訂單不存在 —— 下單的那個請求拿到的是 409 或 503，不是一個訂單編號。
+ */
 interface OrderRepository extends JpaRepository<Order, Long> {
 
-    Page<Order> findByBuyerId(long buyerId, Pageable pageable);
+    Page<Order> findByBuyerIdAndStatusNotIn(long buyerId, Collection<OrderStatus> hidden, Pageable pageable);
 
     Page<Order> findByBuyerIdAndStatus(long buyerId, OrderStatus status, Pageable pageable);
 
-    Page<Order> findBySellerId(long sellerId, Pageable pageable);
+    Page<Order> findBySellerIdAndStatusNotIn(long sellerId, Collection<OrderStatus> hidden, Pageable pageable);
 
     Page<Order> findBySellerIdAndStatus(long sellerId, OrderStatus status, Pageable pageable);
 
     Optional<Order> findByOrderNo(String orderNo);
 
-    boolean existsByOrderNo(String orderNo);
+    @Query("select count(o) > 0 from Order o where o.orderNo = :orderNo and o.status not in :hidden")
+    boolean existsPlaced(@Param("orderNo") String orderNo, @Param("hidden") Collection<OrderStatus> hidden);
 
-    @Query("select o.id from Order o where o.orderNo = :orderNo and o.buyerId = :buyerId")
-    Optional<Long> findIdByOrderNoAndBuyerId(@Param("orderNo") String orderNo, @Param("buyerId") long buyerId);
+    @Query("select o.id from Order o where o.orderNo = :orderNo and o.buyerId = :buyerId and o.status not in :hidden")
+    Optional<Long> findIdByOrderNoAndBuyerId(@Param("orderNo") String orderNo, @Param("buyerId") long buyerId,
+                                             @Param("hidden") Collection<OrderStatus> hidden);
 
-    @Query("select o.id from Order o where o.orderNo = :orderNo and o.sellerId = :sellerId")
-    Optional<Long> findIdByOrderNoAndSellerId(@Param("orderNo") String orderNo, @Param("sellerId") long sellerId);
+    @Query("select o.id from Order o where o.orderNo = :orderNo and o.sellerId = :sellerId and o.status not in :hidden")
+    Optional<Long> findIdByOrderNoAndSellerId(@Param("orderNo") String orderNo, @Param("sellerId") long sellerId,
+                                              @Param("hidden") Collection<OrderStatus> hidden);
 }
```

**`src/main/java/com/example/shop/ordering/internal/OrderAccess.java`**

```diff
 package com.example.shop.ordering.internal;
 
+import com.example.shop.ordering.OrderStatus;
 import com.example.shop.shared.audit.AuditAction;
 import com.example.shop.shared.audit.AuditEntry;
 import com.example.shop.shared.audit.AuditLog;
…
         this.audit = audit;
     }
 
-    /** 只回傳 id，不載入 Entity（4.6.5：之後的 JDBC 狀態轉移不能被 persistence context 裡的舊 Entity 蓋掉） */
+    /**
+     * 只回傳 id，不載入 Entity（4.6.5：之後的 JDBC 狀態轉移不能被 persistence context 裡的舊 Entity 蓋掉）。
+     * 13 站 4.5：還沒成立的訂單（RESERVING、REJECTED）一律當成不存在 —— 包括「存在嗎」那一句：不然買家自己那張 RESERVING 會被記成 ACCESS_DENIED
+     */
     long buyers(long buyerId, String orderNo) {
-        return orders.findIdByOrderNoAndBuyerId(orderNo, buyerId)
-                .orElseThrow(() -> denied(buyerId, Role.BUYER, orderNo, orders.existsByOrderNo(orderNo)));
+        return orders.findIdByOrderNoAndBuyerId(orderNo, buyerId, OrderStatus.NOT_PLACED)
+                .orElseThrow(() -> denied(buyerId, Role.BUYER, orderNo, orders.existsPlaced(orderNo, OrderStatus.NOT_PLACED)));
     }
 
     long sellers(long sellerId, String orderNo) {
-        return orders.findIdByOrderNoAndSellerId(orderNo, sellerId)
-                .orElseThrow(() -> denied(sellerId, Role.SELLER, orderNo, orders.existsByOrderNo(orderNo)));
+        return orders.findIdByOrderNoAndSellerId(orderNo, sellerId, OrderStatus.NOT_PLACED)
+                .orElseThrow(() -> denied(sellerId, Role.SELLER, orderNo, orders.existsPlaced(orderNo, OrderStatus.NOT_PLACED)));
     }
 
     ShopException denied(long actorId, Role role, String orderNo, boolean exists) {
```

**`src/main/java/com/example/shop/ordering/internal/OrderQueryService.java`**

```diff
         this.access = access;
     }
 
+    /** 13 站 4.5：還沒成立的訂單不列出來；指定 status = RESERVING、REJECTED 也一樣（對外的契約上沒有這兩個值，OrderDtos） */
     @Transactional(readOnly = true)
     public PageResponse<OrderView> buyerOrders(long buyerId, OrderStatus status, int page, int size) {
         PageRequest pr = PageRequest.of(page, size, NEWEST_FIRST);
-        return withItems(status == null ? orders.findByBuyerId(buyerId, pr) : orders.findByBuyerIdAndStatus(buyerId, status, pr));
+        if (status != null && OrderStatus.NOT_PLACED.contains(status)) return PageResponse.of(Page.empty(pr), List.of());
+        return withItems(status == null ? orders.findByBuyerIdAndStatusNotIn(buyerId, OrderStatus.NOT_PLACED, pr) : orders.findByBuyerIdAndStatus(buyerId, status, pr));
     }
 
     @Transactional(readOnly = true)
     public PageResponse<OrderView> sellerOrders(long sellerId, OrderStatus status, int page, int size) {
         PageRequest pr = PageRequest.of(page, size, NEWEST_FIRST);
-        return withItems(status == null ? orders.findBySellerId(sellerId, pr) : orders.findBySellerIdAndStatus(sellerId, status, pr));
+        if (status != null && OrderStatus.NOT_PLACED.contains(status)) return PageResponse.of(Page.empty(pr), List.of());
+        return withItems(status == null ? orders.findBySellerIdAndStatusNotIn(sellerId, OrderStatus.NOT_PLACED, pr) : orders.findBySellerIdAndStatus(sellerId, status, pr));
     }
 
     /**
```

**`src/main/java/com/example/shop/ordering/internal/OrderDtos.java`**

```diff
 package com.example.shop.ordering.internal;
 
 import com.example.shop.ordering.OrderStatus;
+import io.swagger.v3.oas.annotations.media.Schema;
 import jakarta.validation.Valid;
 import jakarta.validation.constraints.*;
 
…
 
     private OrderDtos() {}
 
-    /** 訂單對外只用 orderNo 識別，不暴露內部 id（0.6.7） */
-    public record OrderView(String orderNo, OrderStatus status, BigDecimal totalAmount, Instant createdAt,
-                            Instant paymentDeadline, List<OrderLineView> items) {}
+    /**
+     * 訂單對外只用 orderNo 識別，不暴露內部 id（0.6.7）。
+     * 13 站 4.5：status 對外只有六個值 —— RESERVING、REJECTED 是下單 Saga 內部的狀態，不會出現在任何一個回應裡（OrderRepository），
+     * 也不寫進 API 契約（第 12 站 3.8.2 的快照）：契約上多一個 enum 值，對嚴格的客戶端就是一次不相容的改變
+     */
+    public record OrderView(String orderNo,
+                            @Schema(type = "string", allowableValues = {"PENDING_PAYMENT", "PAID", "PICKING", "SHIPPED", "COMPLETED", "CANCELLED"}) OrderStatus status,
+                            BigDecimal totalAmount, Instant createdAt, Instant paymentDeadline, List<OrderLineView> items) {}
 
     public record OrderLineView(long productId, String productName, BigDecimal unitPrice, int quantity, BigDecimal lineAmount) {}
 
```

**`src/main/java/com/example/shop/ordering/internal/web/OrderQueryController.java`**

```diff
 import com.example.shop.shared.web.CurrentUser;
 import com.example.shop.shared.web.PageResponse;
 import com.example.shop.shared.web.Role;
+import io.swagger.v3.oas.annotations.Parameter;
+import io.swagger.v3.oas.annotations.media.Schema;
 import jakarta.validation.constraints.Max;
 import jakarta.validation.constraints.Min;
 import org.springframework.web.bind.annotation.*;
 
-/** US-ORD-5：買家查自己的訂單、賣家查自己商品的訂單 */
+/** US-ORD-5：買家查自己的訂單、賣家查自己商品的訂單。13 站 4.5：status 的契約只有六個值（OrderDtos.OrderView） */
 @RestController
 class OrderQueryController {
 
…
 
     @GetMapping("/api/orders")
     PageResponse<OrderView> mine(CurrentUser user,
+                                 @Parameter(schema = @Schema(allowableValues = {"PENDING_PAYMENT", "PAID", "PICKING", "SHIPPED", "COMPLETED", "CANCELLED"}))
                                  @RequestParam(required = false) OrderStatus status,
                                  @RequestParam(defaultValue = "0") @Min(value = 0, message = "page 不可為負") int page,
                                  @RequestParam(defaultValue = "20") @Min(value = 1, message = "size 1～100") @Max(value = 100, message = "size 1～100") int size) {
…
 
     @GetMapping("/api/seller/orders")
     PageResponse<OrderView> sellerOrders(CurrentUser user,
+                                         @Parameter(schema = @Schema(allowableValues = {"PENDING_PAYMENT", "PAID", "PICKING", "SHIPPED", "COMPLETED", "CANCELLED"}))
                                          @RequestParam(required = false) OrderStatus status,
                                          @RequestParam(defaultValue = "0") @Min(value = 0, message = "page 不可為負") int page,
                                          @RequestParam(defaultValue = "20") @Min(value = 1, message = "size 1～100") @Max(value = 100, message = "size 1～100") int size) {
```

**`src/main/java/com/example/shop/ordering/internal/OrderCommands.java`**

```diff
 package com.example.shop.ordering.internal;
 
+import com.example.shop.inventory.InventoryApi;
 import com.example.shop.ordering.OrderStatus;
 import com.example.shop.ordering.internal.OrderDtos.OrderView;
 import com.example.shop.ordering.internal.OrderDtos.PaymentStarted;
…
     private final PaymentApi payments;
     private final OrderAccess access;
     private final AuditLog audit;
+    private final InventoryApi inventory;
 
     OrderCommands(OrderRepository orders, OrderTransitionService transitions, OrderQueryService queries, PaymentApi payments,
-                  OrderAccess access, AuditLog audit) {
+                  OrderAccess access, AuditLog audit, InventoryApi inventory) {
+        this.inventory = inventory;
         this.orders = orders;
         this.transitions = transitions;
         this.queries = queries;
…
         return queries.byId(id);
     }
 
-    @Transactional
-    public OrderView ship(long sellerId, String orderNo, String carrier, String trackingNo) {   // US-ORD-6 AC-2
+    /**
+     * US-ORD-6 AC-2。13 站 4.6.3：不再是一個交易 —— 出庫是庫存模組收到 order.shipped 之後的事；出貨之前先問庫存一次（只讀），
+     * 這一次讀在任何交易之外（第 01 章 1.6：交易裡不做跨模組的呼叫）。轉移本身是 OrderTransitionService 自己的交易
+     */
+    public OrderView ship(long sellerId, String orderNo, String carrier, String trackingNo) {
         long id = sellers(sellerId, orderNo);
+        if (transitions.current(id).status() == OrderStatus.PICKING) inventory.checkShippable(id);   // 已經出貨的重送不用再問
         transitions.apply(id, OrderEvent.SHIP, OrderHistory.Actor.seller(sellerId), EventData.shipment(carrier, trackingNo));
         return queries.byId(id);
     }
```

**`src/main/java/com/example/shop/ordering/internal/ReservationReconciliation.java`**

```diff
  *
  * 訂單的狀態 → 它的預留應該是什麼（2.5.2）：
  *   不存在、CANCELLED    → 沒有，或 RELEASED
+ *   REJECTED             → 沒有，或 RELEASED（13 站 4.5：下單的 Saga 被補償了）
+ *   RESERVING            → 不檢查：下單的 Saga 還在走（卡太久的由 OrderJobs.expirePlacements 收）
  *   PENDING_PAYMENT      → HELD
  *   PAID、PICKING        → CONFIRMED
  *   SHIPPED、COMPLETED   → CONSUMED
…
  *   ② 訂單這一邊還沒結束（PENDING_PAYMENT、PAID、PICKING）的訂單 → 它的預留
  * 只有 X-1、X-2 自動修（釋放）：訂單不存在或已取消，沒有人會再用到那些庫存。其他的只告警 —— 要不要重新預留、要不要取消一張已付款的訂單，
  * 是人的決定（2.6.4）。
- * 比 grace 新的都不看：下單的交易可能還沒 commit（第 00 章練習三）、熱點落帳的事件可能還在路上（第 12 站 7.6）。
+ * 比 grace 新的都不看：下單的交易可能還沒 commit（2.6.1）、熱點落帳的事件可能還在路上（第 12 站 7.6）。
+ * 13 站 4.6 之後多一種「還在路上」：確認、釋放、出庫都是庫存模組收到訂單的事件之後才做 —— 取消之後的幾百毫秒，預留還是 HELD，那是正常的。
+ * 比 grace 舊還是這樣，代表事件卡住了（broker、消費者、死信），這時候對帳才是最後一道防線。
  */
 @Component
 class ReservationReconciliation {
…
 
     enum Check {
         X1("預留還佔著，訂單不存在", true),
-        X2("預留還佔著，訂單已取消", true),
+        X2("預留還佔著，訂單已取消（或下單被拒絕）", true),
         X3("訂單還沒結束，預留已釋放或不存在", false),
         X4("訂單還沒出貨，預留已出庫", false),
         X5("訂單與預留的狀態對不上（其他）", false);
…
             byOrder.forEach((orderId, rs) -> {
                 String s = status.get(orderId);
                 Check c = s == null ? Check.X1
-                        : s.equals("CANCELLED") ? Check.X2
+                        : s.equals("CANCELLED") || s.equals("REJECTED") ? Check.X2
+                        : s.equals("RESERVING") ? null                                      // 13 站 4.5：Saga 還在走
                         : s.equals("PENDING_PAYMENT") && rs.stream().anyMatch(r -> r.status().equals("CONFIRMED")) ? Check.X5
                         : s.equals("SHIPPED") || s.equals("COMPLETED") ? Check.X5
                         : null;
```

（註解裡的「第 00 章練習三」改成 2.6.1：這一站不設練習，那一段內容搬進了第 02 章 2.6.1。照著第 02 章課文寫的程式碼，這一行本來就是 2.6.1。）

**`src/main/java/com/example/shop/inventory/internal/web/InventoryServiceController.java`**

```diff
  *   GET  /stock/{productId}/display?hot=…     商品頁顯示用
  *   PUT  /reservations/{orderId}              一張訂單的預留（URL 就是冪等鍵）
  *   POST /reservations/{orderId}/confirm|release|consume
+ *   GET  /reservations/{orderId}/shippable    出貨之前問一次：204 可以、503 還在落帳、409 即將取消（13 站 4.6.3）
  *   GET  /reservations?createdBefore=…        對帳：還佔著庫存的預留（keyset 分頁）
  *   POST /reservations/query                  對帳：這些訂單的預留
  *   POST /products/{productId}/restocks       補貨（Idempotency-Key）
…
     @PostMapping("/reservations/{orderId}/consume")
     ResponseEntity<Void> consume(@PathVariable long orderId) { inventory.consume(orderId); return done(false); }
 
+    @GetMapping("/reservations/{orderId}/shippable")
+    ResponseEntity<Void> shippable(@PathVariable long orderId) { inventory.checkShippable(orderId); return ResponseEntity.noContent().build(); }
+
     @GetMapping(value = "/reservations", params = "createdBefore")
     Reservations active(@RequestParam(defaultValue = "0") long afterId, @RequestParam Instant createdBefore, @RequestParam int limit) {
         return new Reservations(inventory.activeReservations(afterId, createdBefore, Math.min(limit, 1000)));
```

**`src/main/java/com/example/shop/inventory/internal/remote/InventoryClient.java`**

```diff
     @PutExchange("/reservations/{orderId}")
     ResponseEntity<Void> reserve(@PathVariable long orderId, @RequestBody ReserveRequest body);
 
-    @PostExchange("/reservations/{orderId}/confirm")
-    void confirm(@PathVariable long orderId);
+    // 13 站 4.6：…/confirm、…/consume 兩支不再呼叫（庫存服務自己收 order.paid、order.shipped）。庫存服務那一邊還留著它們：
+    // 線上那一版訂單服務的契約裡有（3.8.5 的「收縮」要等那一版下線）
 
     @PostExchange("/reservations/{orderId}/release")
     void release(@PathVariable long orderId);
 
-    @PostExchange("/reservations/{orderId}/consume")
-    void consume(@PathVariable long orderId);
+    @GetExchange("/reservations/{orderId}/shippable")
+    void shippable(@PathVariable long orderId);
 
     @GetExchange("/reservations")
     Reservations active(@RequestParam long afterId, @RequestParam String createdBefore, @RequestParam int limit);
```

**`src/main/java/com/example/shop/inventory/internal/remote/RemoteInventoryApi.java`**

```diff
         call("reserve", () -> client.reserve(orderId, new ReserveRequest(lines, hotLines)));
     }
 
-    @Override public void confirm(long orderId) { run("confirm", () -> client.confirm(orderId)); }
-    @Override public void release(long orderId) { run("release", () -> client.release(orderId)); }
-    @Override public void consume(long orderId) { run("consume", () -> client.consume(orderId)); }
+    // 13 站 4.6：confirm、release、consume 不在 InventoryApi 上了（庫存服務自己收 order.paid、order.cancelled、order.shipped）
+
+    /** 13 站 4.6.3：只讀。503（還在落帳）、409（即將取消）照原樣交給賣家 */
+    @Override public void checkShippable(long orderId) { run("shippable", () -> client.shippable(orderId)); }
 
     /** 對帳的釋放：在服務之間跟 release 是同一支端點（每一次呼叫本來就是庫存服務自己的交易） */
     @Override public void releaseAbandoned(long orderId) { run("release", () -> client.release(orderId)); }
```

**`src/main/java/com/example/shop/shared/config/ShopProperties.java`**

```diff
             /** 13 站 2.6：預留 ⇄ 訂單的跨模組對帳（ReservationReconciliation）多久跑一次 */
             @NotNull @DefaultValue("5m") @DurationMin(seconds = 10) Duration reservationCheckInterval,
             /** 13 站 2.6：比這個新的不一致不算 —— 下單的交易可能還沒 commit、熱點落帳的事件可能還在路上 */
-            @NotNull @DefaultValue("5m") @DurationMin(seconds = 1) Duration reservationGrace) {}
+            @NotNull @DefaultValue("5m") @DurationMin(seconds = 1) Duration reservationGrace,
+            /**
+             * 13 站 4.5：訂單停在 RESERVING（下單的 Saga 走到一半）超過這麼久，排程就補償它（REJECTED）。
+             * 要比一次下單最久會花的時間長得多：兩次預留各等一個 read timeout（3.5.4），加上鎖等待
+             */
+            @NotNull @DefaultValue("60s") @DurationMin(seconds = 1) Duration placementTimeout) {}
 
     /** US-ORD-2 AC-3：金流回呼的 HMAC-SHA256 金鑰 */
     public record Payment(
```

**`src/main/java/com/example/shop/shared/events/EventTypes.java`**

```diff
     public static final String ORDER_SHIPPED = "order.shipped";
     /** orderId, orderNo, buyerId, sellerId */
     public static final String ORDER_COMPLETED = "order.completed";
+    /**
+     * orderId, orderNo, buyerId, event, hotLines: [{productId, quantity}] —— 13 站 4.5：下單的 Saga 走不完（庫存不足、卡太久）。
+     * 庫存模組收到之後補償：釋放這張訂單的預留（如果有）、熱點閘門加回去，並且讓這個 orderId 以後再也預留不了
+     */
+    public static final String ORDER_REJECTED = "order.rejected";
 
     // ── payment：退款（0.5.4「呼叫金流退款 API：可重試，失敗進死信 + 告警」）──
     /** refundId, orderId, paymentId, amount, reason, buyerId */
```

**`src/main/java/com/example/shop/shared/events/Outbox.java`**

```diff
      * @return 這個事件的 eventId（UUID）：消費端的冪等鍵
      */
     String add(String aggregateType, long aggregateId, String eventType, Map<String, ?> payload);
+
+    /** 一則記下的事件：什麼時候記的、哪一種、送出去了沒有（publishedAt = null：還在 outbox 裡） */
+    record Recorded(java.time.Instant at, String eventType, java.time.Instant publishedAt) {}
+
+    /**
+     * 13 站 4.9：某一個 aggregate 記過哪些事件、送出去了沒有，依記下的順序（給人看的：OrderSagaView）。
+     * outbox_events 是 shared 的表 —— 別的模組要知道「我的事件送出去了沒有」，問這裡，不直接讀表（第 12 站 TableOwnershipTest）
+     */
+    java.util.List<Recorded> recorded(String aggregateType, long aggregateId);
 }
```

**`src/main/java/com/example/shop/shared/events/internal/JdbcOutbox.java`**

```diff
                 eventId, aggregateType, aggregateId, eventType, body, MDC.get("traceId"));   // traceId：第 09 章才有人放進 MDC
         return eventId;
     }
+
+    @Override
+    public java.util.List<Recorded> recorded(String aggregateType, long aggregateId) {
+        return jdbc.query("""
+                SELECT created_at, event_type, published_at FROM outbox_events WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY id""",
+                (rs, i) -> new Recorded(rs.getTimestamp(1).toInstant(), rs.getString(2),
+                        rs.getTimestamp(3) == null ? null : rs.getTimestamp(3).toInstant()), aggregateType, aggregateId);
+    }
 }
```

**`src/main/resources/mapper/reporting/SalesReportMapper.xml`**

```diff
     台灣沒有日光節約時間，所以分組時用固定的 '+08:00'；有日光節約的時區要改用具名時區（需要 MySQL 載入時區表）。
 
     US-RPT-3（專題寫完之後補的）：sellerId 是 null 就是全站。同一句 SQL，不另寫一份 —— 兩份 SQL 遲早會漂移（8.7.2）。
+    13 站 4.5：訂單數不算 RESERVING、REJECTED（下單的 Saga 還沒走完、走不完的）。代價：status 不在 (seller_id, created_at) 這個索引裡，
+    每一張訂單都要回表讀一次（4.5.6 量了）
       有 sellerId：(seller_id, created_at) → idx_orders_seller_created（跟原本一樣）
       全站      ：只剩 created_at 的範圍 → V12 的 idx_orders_created；退款那段 → idx_refunds_status (status, created_at)
   -->
…
                    COUNT(*) AS order_count, 0 AS paid_amount, 0 AS refund_amount
               FROM orders o
              WHERE o.created_at &gt;= #{fromUtc} AND o.created_at &lt; #{toUtc}
+               AND o.status NOT IN ('RESERVING', 'REJECTED')                 <!-- 13 站 4.5：還沒成立的訂單不是訂單 -->
                <if test="sellerId != null">AND o.seller_id = #{sellerId}</if>
              GROUP BY day
             UNION ALL
…
             SELECT o.seller_id, COUNT(*) AS order_count, 0 AS paid_amount, 0 AS refund_amount
               FROM orders o
              WHERE o.created_at &gt;= #{fromUtc} AND o.created_at &lt; #{toUtc}
+               AND o.status NOT IN ('RESERVING', 'REJECTED')                 <!-- 13 站 4.5 -->
                <if test="sellerId != null">AND o.seller_id = #{sellerId}</if>
              GROUP BY o.seller_id
             UNION ALL
```

**`src/main/resources/mapper/reporting/TrendingMapper.xml`**

```diff
 
   <!--
     US-RPT-2 AC-2：近 24 小時「下單」量（不是出貨量；取消的也算 —— 它代表的是熱度）。
+    13 站 4.5：RESERVING、REJECTED 不算 —— 那不是一張成立過的訂單（買家拿到的是 409 或 503）
     只列 ON_SALE 的商品：首頁不推一個已經下架的東西。
     o.created_at >= #{since}：V12 的 idx_orders_created（6.8.1）
   -->
…
       JOIN order_items i ON i.order_id = o.id
       JOIN products p ON p.id = i.product_id
      WHERE o.created_at >= #{since}
+       AND o.status NOT IN ('RESERVING', 'REJECTED')
        AND p.status = 'ON_SALE'
      GROUP BY i.product_id, p.name
      ORDER BY quantity DESC, i.product_id
```

測試與實驗，新增的：

**`src/test/java/com/example/shop/ordering/internal/PlaceOrderSagaTest.java`**（4.5、4.7.2）

```java
package com.example.shop.ordering.internal;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReservationRef;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.support.InlineEvents;
import com.example.shop.support.TestInfra;
import com.example.shop.support.TestRedis;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 13 站 4.5：下單的 Saga，在單體裡（一個行程、一個庫）把五條路各走一次。
 * 「預留沒有回應」在一個行程裡不會自然發生 —— 用 FlakyInventory 包住真的 InventoryApi：預留做完之後丟 503（回應丟了），
 * 或者根本沒做就丟 503（請求沒到）。其他的方法原封不動交給真的那一個。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
@Import(PlaceOrderSagaTest.Flaky.class)
class PlaceOrderSagaTest {

    static final long PRODUCT = 9_900_861, HOT = 9_900_862, SELLER = 2, BUYER = 990_861;

    /** 預留的那一次：NONE 正常；AFTER 做完之後丟 503；BEFORE 沒做就丟 503 */
    enum Fault { NONE, AFTER, BEFORE }

    static volatile Fault fault = Fault.NONE;

    @TestConfiguration
    static class Flaky {
        @Bean @Primary
        InventoryApi flakyInventory(@Qualifier("jdbcInventoryService") InventoryApi real) { return new FlakyInventory(real); }
    }

    record FlakyInventory(InventoryApi real) implements InventoryApi {
        @Override public void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
            Fault f = fault;
            if (f == Fault.BEFORE) throw unavailable();
            real.reserve(orderId, lines, hotLines);
            if (f == Fault.AFTER) throw unavailable();
        }
        static ShopException unavailable() { return new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", 1); }
        @Override public void checkShippable(long orderId) { real.checkShippable(orderId); }
        @Override public void restock(long productId, int quantity, String note) { real.restock(productId, quantity, note); }
        @Override public void gateHot(List<ReserveLine> hotLines) { real.gateHot(hotLines); }
        @Override public void returnHot(List<ReserveLine> hotLines) { real.returnHot(hotLines); }
        @Override public void setHot(long productId, boolean hot) { real.setHot(productId, hot); }
        @Override public int availableForDisplay(long productId, boolean hot) { return real.availableForDisplay(productId, hot); }
        @Override public int available(long productId) { return real.available(productId); }
        @Override public Map<Long, Integer> available(Collection<Long> productIds) { return real.available(productIds); }
        @Override public List<ReservationRef> activeReservations(long afterId, Instant createdBefore, int limit) { return real.activeReservations(afterId, createdBefore, limit); }
        @Override public Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds) { return real.reservationsOf(orderIds); }
        @Override public void releaseAbandoned(long orderId) { real.releaseAbandoned(orderId); }
    }

    @Autowired OrderingApi ordering;
    @Autowired OrderQueryService queries;
    @Autowired OrderTransitionService transitions;
    @Autowired @Qualifier("jdbcInventoryService") InventoryApi realInventory;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired Clock clock;
    @Autowired ShopProperties props;
    @Autowired ApplicationContext ctx;

    @BeforeEach
    void setUp() {
        cleanup();
        InlineEvents.skipBacklog(ctx);
        fault = Fault.NONE;
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, 'Saga 測試', 100.00, 'ON_SALE')", PRODUCT, SELLER);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, 'Saga 測試（熱點）', 100.00, 'ON_SALE', TRUE)", HOT, SELLER);
        for (long p : List.of(PRODUCT, HOT)) {
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 5, 0)", p);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 5, 0, 'INITIAL', 'saga-test')", p);
        }
    }

    @AfterEach
    void cleanup() {
        fault = Fault.NONE;
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id = ?", BUYER);
        List<Long> ids = jdbc.queryForList("SELECT id FROM orders WHERE buyer_id = ?", Long.class, BUYER);
        for (long id : ids) jdbc.update("DELETE FROM processed_messages WHERE consumer = 'inventory.http.reserve' AND message_id = ?", String.valueOf(id));
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM cart_items WHERE buyer_id = ?", BUYER);
        for (long p : List.of(PRODUCT, HOT)) {
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", p);
            TestInfra.adminJdbc().update("DELETE FROM inventory_ledger WHERE product_id = ?", p);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", p);
            jdbc.update("DELETE FROM products WHERE id = ?", p);
            TestRedis.forgetProducts(redis, p);
        }
    }

    OrderingApi.PlacedOrder place(String key, long product, int qty) {
        return ordering.placeOrder(BUYER, key, List.of(new OrderingApi.OrderLine(product, qty, new BigDecimal("100"))));
    }

    String status(long orderId) { return jdbc.queryForObject("SELECT status FROM orders WHERE id = ?", String.class, orderId); }

    long latestOrder() { return jdbc.queryForObject("SELECT MAX(id) FROM orders WHERE buyer_id = ?", Long.class, BUYER); }

    List<String> history(long orderId) {
        return jdbc.queryForList("SELECT CONCAT(COALESCE(from_status, '∅'), '→', to_status, ' ', event) FROM order_status_history WHERE order_id = ? ORDER BY id",
                String.class, orderId);
    }

    List<String> reservations(long orderId) {
        return jdbc.queryForList("SELECT status FROM inventory_reservations WHERE order_id = ? ORDER BY id", String.class, orderId);
    }

    int reserved(long product) { return jdbc.queryForObject("SELECT reserved FROM inventory WHERE product_id = ?", Integer.class, product); }

    long keys() { return jdbc.queryForObject("SELECT COUNT(*) FROM idempotency_keys WHERE buyer_id = ?", Long.class, BUYER); }

    List<String> outbox(long orderId) {
        return jdbc.queryForList("SELECT event_type FROM outbox_events WHERE aggregate_type = 'ORDER' AND aggregate_id = ? ORDER BY id", String.class, orderId);
    }

    long visible() { return queries.buyerOrders(BUYER, null, 0, 20).totalElements(); }

    /** 補償交給庫存模組：order.rejected → 釋放／墓碑；inventory.stock-returned → 熱點閘門加回去 */
    void inventoryFollows(long orderId) {
        InlineEvents.deliverTo(ctx, InlineEvents.ofOrders(List.of(orderId)), "inventory.order-events", "inventory.hot-stock-return");
    }

    @Test @DisplayName("13 站 4.5：成功 —— RESERVING 寫下、預留、RESERVED → PENDING_PAYMENT；order.placed 在最後一步才寫")
    void placesThroughTheSaga() {
        var placed = place("saga-ok", PRODUCT, 2);
        System.out.println("4.5 成功：" + status(placed.orderId()) + "；歷史 " + history(placed.orderId()) + "；預留 " + reservations(placed.orderId())
                + "；outbox " + outbox(placed.orderId()));
        assertThat(placed.replayed()).isFalse();
        assertThat(status(placed.orderId())).isEqualTo("PENDING_PAYMENT");
        assertThat(history(placed.orderId())).containsExactly("∅→RESERVING PLACE_ORDER", "RESERVING→PENDING_PAYMENT RESERVED");
        assertThat(reservations(placed.orderId())).containsExactly("HELD");
        assertThat(outbox(placed.orderId())).containsExactly("order.placed");
        assertThat(visible()).isEqualTo(1);
    }

    @Test @DisplayName("13 站 4.5：庫存不足 → 409；訂單 REJECTED（買家看不到）、鍵放掉、order.rejected；熱點閘門扣的那一件加回去；補貨之後同一個鍵是一張新的訂單")
    void insufficientStockIsCompensated() {
        var first = place("saga-warm", HOT, 1);                              // 先讓閘門建起來：5 → 4
        int gateBefore = Integer.parseInt(redis.opsForValue().get("stock:" + HOT));
        assertThatThrownBy(() -> ordering.placeOrder(BUYER, "saga-short",
                List.of(new OrderingApi.OrderLine(HOT, 1, new BigDecimal("100")), new OrderingApi.OrderLine(PRODUCT, 6, new BigDecimal("100")))))
                .isInstanceOf(InsufficientStockException.class);
        long rejected = latestOrder();
        String gateAfterRequest = redis.opsForValue().get("stock:" + HOT);
        inventoryFollows(rejected);
        String gateAfterCompensation = redis.opsForValue().get("stock:" + HOT);
        System.out.println("4.5 庫存不足：" + status(rejected) + "；歷史 " + history(rejected) + "；預留 " + reservations(rejected) + "；outbox " + outbox(rejected)
                + "；閘門 " + gateBefore + " → " + gateAfterRequest + " → 補償之後 " + gateAfterCompensation + "；買家看得到 " + visible() + " 張");
        assertThat(status(rejected)).isEqualTo("REJECTED");
        assertThat(history(rejected)).containsExactly("∅→RESERVING PLACE_ORDER", "RESERVING→REJECTED RESERVE_FAILED");
        assertThat(reservations(rejected)).isEmpty();
        assertThat(outbox(rejected)).containsExactly("order.rejected");
        assertThat(gateAfterRequest).isEqualTo(String.valueOf(gateBefore - 1));
        assertThat(gateAfterCompensation).isEqualTo(String.valueOf(gateBefore));
        assertThat(visible()).as("REJECTED 不出現在「我的訂單」").isEqualTo(1);
        jdbc.update("UPDATE inventory SET on_hand = 20 WHERE product_id = ?", PRODUCT);
        var again = ordering.placeOrder(BUYER, "saga-short",
                List.of(new OrderingApi.OrderLine(HOT, 1, new BigDecimal("100")), new OrderingApi.OrderLine(PRODUCT, 6, new BigDecimal("100"))));
        assertThat(again.replayed()).isFalse();
        assertThat(again.orderId()).isNotEqualTo(rejected).isNotEqualTo(first.orderId());
    }

    @Test @DisplayName("13 站 4.5：預留做了、回應丟了 → 503，訂單停在 RESERVING；同一個鍵重送 → 接著做同一張（第 03 章這裡會多一筆孤兒預留）")
    void aResendFinishesTheSameOrder() {
        fault = Fault.AFTER;
        assertThatThrownBy(() -> place("saga-lost", PRODUCT, 1))
                .isInstanceOfSatisfying(ShopException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE));
        long id = latestOrder();
        String middle = status(id) + "，預留 " + reservations(id) + "，鍵 " + keys() + " 個，買家看得到 " + visible() + " 張";
        fault = Fault.NONE;
        var resent = place("saga-lost", PRODUCT, 1);
        System.out.println("4.5 回應丟了：503 之後 " + middle + "；重送 → replayed=" + resent.replayed() + "、同一張=" + (resent.orderId() == id)
                + "、" + status(id) + "；預留 " + reservations(id) + "；reserved " + reserved(PRODUCT) + "；歷史 " + history(id));
        assertThat(middle).isEqualTo("RESERVING，預留 [HELD]，鍵 1 個，買家看得到 0 張");
        assertThat(resent.replayed()).isTrue();
        assertThat(resent.orderId()).isEqualTo(id);
        assertThat(status(id)).isEqualTo("PENDING_PAYMENT");
        assertThat(reservations(id)).containsExactly("HELD");
        assertThat(reserved(PRODUCT)).isEqualTo(1);
    }

    @Test @DisplayName("13 站 4.5：沒有人重送 → 排程在 placement-timeout 之後補償：REJECTED、鍵放掉；庫存模組收到 order.rejected → 釋放")
    void aStalePlacementIsCompensated() {
        fault = Fault.AFTER;
        assertThatThrownBy(() -> place("saga-stale", PRODUCT, 2)).isInstanceOf(ShopException.class);
        fault = Fault.NONE;
        long id = latestOrder();
        OrderJobs jobs = new OrderJobs(jdbc, transitions, clock, props);
        int early = jobs.expirePlacements();                                // 還沒到 placement-timeout：不動
        jdbc.update("UPDATE orders SET created_at = NOW(3) - INTERVAL 2 MINUTE WHERE id = ?", id);
        int expired = 0;
        while (jobs.expirePlacements() > 0) expired++;
        String afterJob = status(id) + "，預留 " + reservations(id) + "，reserved " + reserved(PRODUCT) + "，鍵 " + keys() + " 個";
        inventoryFollows(id);
        System.out.println("4.5 卡住的 RESERVING：排程第一次 " + early + " 張；改到 2 分鐘前之後 → " + afterJob + "；庫存模組收到 order.rejected → 預留 "
                + reservations(id) + "，reserved " + reserved(PRODUCT) + "；歷史 " + history(id));
        assertThat(early).isZero();
        assertThat(expired).isGreaterThanOrEqualTo(1);
        assertThat(status(id)).isEqualTo("REJECTED");
        assertThat(history(id)).last().isEqualTo("RESERVING→REJECTED PLACEMENT_EXPIRED");
        assertThat(keys()).isZero();
        assertThat(reservations(id)).containsExactly("RELEASED");
        assertThat(reserved(PRODUCT)).isZero();
        var fresh = place("saga-stale", PRODUCT, 2);                         // 同一個鍵：一次新的下單
        assertThat(fresh.replayed()).isFalse();
        assertThat(fresh.orderId()).isNotEqualTo(id);
    }

    @Test @DisplayName("13 站 4.7.2：補償比動作先到 —— 預留的請求還在路上，訂單已經被補償；它晚到 → 409，什麼都不留下")
    void compensationBeforeTheAction() {
        fault = Fault.BEFORE;                                                // 預留的請求「還在路上」：這一次沒有到庫存模組
        assertThatThrownBy(() -> place("saga-late", PRODUCT, 1)).isInstanceOf(ShopException.class);
        fault = Fault.NONE;
        long id = latestOrder();
        jdbc.update("UPDATE orders SET created_at = NOW(3) - INTERVAL 2 MINUTE WHERE id = ?", id);
        new OrderJobs(jdbc, transitions, clock, props).expirePlacements();
        inventoryFollows(id);                                                // 補償：佔掉這張訂單的預留那一列
        long tombstones = jdbc.queryForObject("SELECT COUNT(*) FROM processed_messages WHERE consumer = 'inventory.http.reserve' AND message_id = ?",
                Long.class, String.valueOf(id));
        Throwable late = null;
        try {
            realInventory.reserve(id, List.of(new ReserveLine(PRODUCT, 1)), List.of());   // 晚到的那一次預留
        } catch (Throwable t) {
            late = t;
        }
        System.out.println("4.7.2 補償先到：" + status(id) + "；processed_messages 裡這張訂單的預留那一列 " + tombstones + " 筆；晚到的預留 → "
                + (late == null ? "成功" : ((ShopException) late).type() + "「" + late.getMessage() + "」") + "；預留 " + reservations(id) + "；reserved " + reserved(PRODUCT));
        assertThat(status(id)).isEqualTo("REJECTED");
        assertThat(tombstones).isEqualTo(1);
        assertThat(late).isInstanceOfSatisfying(ShopException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.INVALID_STATE));
        assertThat(reservations(id)).isEmpty();
        assertThat(reserved(PRODUCT)).isZero();
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/InventoryOrderEventsTest.java`**（4.6.2）

```java
package com.example.shop.inventory.internal;

import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.internal.EventDispatcher;
import com.example.shop.support.TestInfra;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 4.6.2：庫存模組收訂單的事件（協同）。同一張訂單的事件不保證順序 —— 每一個轉移只看預留「現在」是什麼狀態，
 * 所以任何順序都要收斂到同一個結果。這裡把會亂序的那幾對各釘一次：誰先到，由測試決定。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
class InventoryOrderEventsTest {

    static final long PRODUCT = 9_900_871, HOT = 9_900_872, ORDER = 99_087_001L;

    @Autowired List<EventHandler> handlers;
    @Autowired EventDispatcher dispatcher;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    EventHandler orderEvents() { return handlers.stream().filter(h -> h.consumer().equals("inventory.order-events")).findFirst().orElseThrow(); }

    @BeforeEach
    void setUp() {
        cleanup();
        for (long p : List.of(PRODUCT, HOT)) {
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", p);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'order-events')", p);
        }
    }

    @AfterEach
    void cleanup() {
        for (long p : List.of(PRODUCT, HOT)) {
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", p);
            TestInfra.adminJdbc().update("DELETE FROM inventory_ledger WHERE product_id = ?", p);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", p);
        }
        jdbc.update("DELETE FROM processed_messages WHERE consumer = 'inventory.order-events'");
        jdbc.update("DELETE FROM outbox_events WHERE aggregate_id = ?", ORDER);
    }

    /** 下單的 Saga 走完之後的樣子：一筆 HELD 預留（counted：一般商品已經計入；熱點商品還沒落帳） */
    void held(long product, boolean counted) {
        if (counted) jdbc.update("UPDATE inventory SET reserved = reserved + 1 WHERE product_id = ?", product);
        jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status, counted) VALUES (?, ?, 1, 'HELD', ?)", ORDER, product, counted);
        if (counted) jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 0, 1, 'RESERVE', ?)", product, "order:" + ORDER);
    }

    Event event(String type) throws Exception {
        return new Event(UUID.randomUUID().toString(), type, "ORDER", ORDER, Instant.now(), json.readTree(json.writeValueAsString(Map.of("orderId", ORDER))), 1);
    }

    Map<String, Object> state(long product) {
        return jdbc.queryForMap("""
                SELECT (SELECT status FROM inventory_reservations WHERE order_id = ? AND product_id = ?) AS reservation,
                       (SELECT CONCAT(on_hand, '/', reserved) FROM inventory WHERE product_id = ?) AS stock,
                       (SELECT GROUP_CONCAT(reason ORDER BY id) FROM inventory_ledger WHERE ref = CONCAT('order:', ?) AND product_id = ?) AS ledger""",
                ORDER, product, product, ORDER, product);
    }

    @Test @DisplayName("order.shipped 比 order.paid 先到 → HELD 直接出庫；晚到的 order.paid 什麼都不改")
    void shippedBeforePaid() throws Exception {
        held(PRODUCT, true);
        dispatcher.dispatch(orderEvents(), event("order.shipped"));
        Map<String, Object> afterShip = state(PRODUCT);
        dispatcher.dispatch(orderEvents(), event("order.paid"));
        System.out.println("4.6.2 先出貨、後付款：出貨之後 " + afterShip + "；付款晚到之後 " + state(PRODUCT));
        assertThat(afterShip).containsEntry("reservation", "CONSUMED").containsEntry("stock", "9/0").containsEntry("ledger", "RESERVE,SHIP");
        assertThat(state(PRODUCT)).isEqualTo(afterShip);
    }

    @Test @DisplayName("order.paid 比 order.cancelled 晚到 → 維持 RELEASED（確認只改 HELD）")
    void paidAfterCancelled() throws Exception {
        held(PRODUCT, true);
        dispatcher.dispatch(orderEvents(), event("order.cancelled"));
        Map<String, Object> afterCancel = state(PRODUCT);
        dispatcher.dispatch(orderEvents(), event("order.paid"));
        System.out.println("4.6.2 先取消、後付款：取消之後 " + afterCancel + "；付款晚到之後 " + state(PRODUCT));
        assertThat(afterCancel).containsEntry("reservation", "RELEASED").containsEntry("stock", "10/0").containsEntry("ledger", "RESERVE,RELEASE");
        assertThat(state(PRODUCT)).isEqualTo(afterCancel);
    }

    @Test @DisplayName("熱點預留還沒落帳就收到 order.shipped → 先落帳、再出庫；晚到的落帳什麼都不做")
    void shippedBeforeSettlement() throws Exception {
        held(HOT, false);
        dispatcher.dispatch(orderEvents(), event("order.shipped"));
        Map<String, Object> afterShip = state(HOT);
        EventHandler settlement = handlers.stream().filter(h -> h.consumer().equals("inventory.hot-settlement")).findFirst().orElseThrow();
        dispatcher.dispatch(settlement, new Event(UUID.randomUUID().toString(), "order.placed", "ORDER", ORDER, Instant.now(),
                json.readTree(json.writeValueAsString(Map.of("orderId", ORDER, "hotProductIds", List.of(HOT)))), 1));
        System.out.println("4.6.2 先出貨、後落帳：出貨之後 " + afterShip + "；落帳晚到之後 " + state(HOT));
        assertThat(afterShip).containsEntry("reservation", "CONSUMED").containsEntry("stock", "9/0").containsEntry("ledger", "RESERVE,SHIP");
        assertThat(state(HOT)).isEqualTo(afterShip);
    }

    @Test @DisplayName("同一則 order.cancelled 交付兩次 → 第二次 DUPLICATE；另一則取消（不同的 eventId）→ 已經 RELEASED，什麼都不改")
    void sameEventTwice() throws Exception {
        held(PRODUCT, true);
        Event cancelled = event("order.cancelled");
        var first = dispatcher.dispatch(orderEvents(), cancelled);
        var second = dispatcher.dispatch(orderEvents(), cancelled);
        var anotherCopy = dispatcher.dispatch(orderEvents(), event("order.cancelled"));   // 另一個 eventId：processed_messages 擋不住，靠的是預留已經 RELEASED
        System.out.println("4.6.2 同一則取消兩次：" + first + "、" + second + "；另一則取消 " + anotherCopy + "；" + state(PRODUCT));
        assertThat(first).isEqualTo(EventDispatcher.Outcome.PROCESSED);
        assertThat(second).isEqualTo(EventDispatcher.Outcome.DUPLICATE);
        assertThat(state(PRODUCT)).containsEntry("reservation", "RELEASED").containsEntry("stock", "10/0").containsEntry("ledger", "RESERVE,RELEASE");
    }
}
```

**`src/test/java/com/example/shop/api/AdminOrderSagaApiTest.java`**（4.9）

```java
package com.example.shop.api;

import com.example.shop.ordering.OrderingApi;
import com.example.shop.ordering.internal.OrderCommands;
import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
import com.example.shop.support.InlineEvents;
import com.example.shop.support.TestInfra;
import com.example.shop.support.TestRedis;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 13 站 4.9：GET /api/admin/orders/{orderNo}/saga —— 一張訂單的 Saga 走到哪裡了。
 * 取消之後、庫存模組還沒收到 order.cancelled：預留還是 HELD，「對不上」；交付之後 RELEASED、對得上。
 * 被拒絕的下單（REJECTED）買家看不到，管理員看得到。
 */
@SpringBootTest(properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
@AutoConfigureMockMvc
class AdminOrderSagaApiTest {

    static final long PRODUCT = 9_900_881, SELLER = 2, BUYER = 990_881, ADMIN = 990_882;

    @Autowired MockMvc mvc;
    @Autowired AccessTokens tokens;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired StringRedisTemplate redis;
    @Autowired OrderingApi ordering;
    @Autowired OrderCommands commands;
    @Autowired ApplicationContext ctx;

    @BeforeEach
    void setUp() {
        cleanup();
        InlineEvents.skipBacklog(ctx);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, 'Saga 檢視', 100.00, 'ON_SALE')", PRODUCT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 3, 0)", PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 3, 0, 'INITIAL', 'saga-view')", PRODUCT);
    }

    @AfterEach
    void cleanup() {
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        TestInfra.adminJdbc().update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
        TestRedis.forgetProducts(redis, PRODUCT);
    }

    JsonNode saga(String orderNo, Role role, int expect) throws Exception {
        MockHttpServletResponse r = mvc.perform(get("/api/admin/orders/" + orderNo + "/saga")
                .header("Authorization", TestTokens.bearer(tokens, role == Role.ADMIN ? ADMIN : BUYER, role))).andReturn().getResponse();
        assertThat(r.getStatus()).isEqualTo(expect);
        return expect == 200 ? json.readTree(r.getContentAsString(StandardCharsets.UTF_8)) : null;
    }

    static String brief(JsonNode v) {
        StringBuilder s = new StringBuilder(v.get("status").asText()).append("；歷史 ");
        v.get("history").forEach(h -> s.append(h.get("event").asText()).append(' '));
        s.append("；事件 ");
        v.get("events").forEach(e -> s.append(e.get("type").asText()).append(e.get("publishedAt").isNull() ? "（還沒送）" : "（已送）").append(' '));
        s.append("；預留 ");
        v.get("reservations").forEach(r -> s.append(r.get("status").asText()).append(' '));
        return s.append("；應該是 ").append(v.get("expectedReservation")).append("、對得上 ").append(v.get("consistent").asBoolean()).toString();
    }

    @Test @DisplayName("13 站 4.9：取消之後，庫存還沒跟上 → 對不上；交付 order.cancelled 之後 → 對得上。買家打這一支 → 403")
    void cancelledOrderBeforeAndAfterInventoryFollows() throws Exception {
        var o = ordering.placeOrder(BUYER, "saga-view-1", List.of(new OrderingApi.OrderLine(PRODUCT, 1, new BigDecimal("100"))));
        commands.cancelByBuyer(BUYER, o.orderNo());
        JsonNode before = saga(o.orderNo(), Role.ADMIN, 200);
        InlineEvents.deliverTo(ctx, InlineEvents.ofOrders(List.of(o.orderId())), "inventory.order-events");
        JsonNode after = saga(o.orderNo(), Role.ADMIN, 200);
        System.out.println("4.9 取消之後：" + brief(before));
        System.out.println("4.9 庫存跟上之後：" + brief(after));
        assertThat(before.get("consistent").asBoolean()).isFalse();
        assertThat(before.get("reservations").get(0).get("status").asText()).isEqualTo("HELD");
        assertThat(after.get("consistent").asBoolean()).isTrue();
        assertThat(after.get("reservations").get(0).get("status").asText()).isEqualTo("RELEASED");
        saga(o.orderNo(), Role.BUYER, 403);
    }

    @Test @DisplayName("13 站 4.9：被拒絕的下單 —— 買家看不到（404），管理員看得到 REJECTED 與它的 order.rejected")
    void rejectedPlacementIsVisibleToAdminsOnly() throws Exception {
        assertThatThrownBy(() -> ordering.placeOrder(BUYER, "saga-view-2", List.of(new OrderingApi.OrderLine(PRODUCT, 9, new BigDecimal("100")))))
                .isInstanceOf(com.example.shop.inventory.InsufficientStockException.class);
        String no = jdbc.queryForObject("SELECT order_no FROM orders WHERE buyer_id = ? ORDER BY id DESC LIMIT 1", String.class, BUYER);
        int buyerSees = mvc.perform(get("/api/orders/" + no).header("Authorization", TestTokens.bearer(tokens, BUYER))).andReturn().getResponse().getStatus();
        JsonNode v = saga(no, Role.ADMIN, 200);
        System.out.println("4.9 被拒絕的下單：買家查 → " + buyerSees + "；管理員：" + brief(v));
        assertThat(buyerSees).isEqualTo(404);
        assertThat(v.get("status").asText()).isEqualTo("REJECTED");
        assertThat(v.get("events").get(0).get("type").asText()).isEqualTo("order.rejected");
        assertThat(v.get("consistent").asBoolean()).isTrue();
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/LegacyPlaceOrder.java`**（4.10.3）

```java
package com.example.shop.ordering.internal;

import com.example.shop.cart.CartApi;
import com.example.shop.catalog.CatalogApi;
import com.example.shop.catalog.ProductSnapshot;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.ordering.OrderStatus;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.ordering.OrderingApi.OrderLine;
import com.example.shop.ordering.OrderingApi.PlacedOrder;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.events.EventTypes;
import com.example.shop.shared.events.Outbox;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.core.Ordered;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 13 站 4.10.3（E5）：同一個行程裡，把「第 03 章的下單」與「這一章的 Saga」交錯著量 —— 不同的版本放在不同次的執行裡比，差的往往是機器那一刻的狀態（第 01 章 1.8.2）。
 * 請求帶 X-Lab-Flow: legacy → 第 03 章的流程（一個交易，預留在交易裡）；其他 → src/main 的 PlaceOrderService（Saga）。
 *
 * 舊的流程照 d03 的 PlaceOrderService.placeInTransaction 寫，差兩個地方，都寫在這裡：
 *   ① 訂單直接以 PENDING_PAYMENT 寫下（第 04 章的 Order.place 是 RESERVING；這裡在 INSERT 之前把欄位改掉，不多送一句 SQL）
 *   ② InventoryApi.reserve 現在帶著 processed_messages 那一句（4.5）：單體裡第 03 章沒有它 —— 兩邊都多這一句，差別只剩「一個交易 vs 三個」
 * 只在 lab.d04.flow-switch=true 時存在（實驗用），沒有冪等鍵重送、熱點閘門的補償這些路徑：E5 只量第一次下單。
 */
@Configuration
@ConditionalOnProperty(name = "lab.d04.flow-switch", havingValue = "true")
class LegacyPlaceOrder {

    static final ThreadLocal<Boolean> LEGACY = ThreadLocal.withInitial(() -> false);

    @Bean @Primary
    OrderingApi flowSwitch(PlaceOrderService saga, CatalogApi catalog, InventoryApi inventory, CartApi cart, OrderRepository orders,
                           OrderHistory history, IdempotencyKeys keys, Outbox outbox, PlatformTransactionManager tm, Clock clock, ShopProperties props) {
        TransactionTemplate tx = new TransactionTemplate(tm);
        return (buyerId, key, lines) -> {
            if (!LEGACY.get()) return saga.placeOrder(buyerId, key, lines);
            Set<Long> hotIds = catalog.hotProducts(lines.stream().map(OrderLine::productId).toList());
            List<ReserveLine> hot = lines.stream().filter(l -> hotIds.contains(l.productId())).map(l -> new ReserveLine(l.productId(), l.quantity())).toList();
            inventory.gateHot(hot);
            IdempotencyKeys.Claim claim = keys.claim(buyerId, key, PlaceOrderService.hash(lines));
            if (!(claim instanceof IdempotencyKeys.Claimed)) throw new ShopException(ProblemType.IDEMPOTENCY_IN_PROGRESS, "E5 只量第一次下單");
            Map<Long, ProductSnapshot> products = catalog.snapshots(lines.stream().map(OrderLine::productId).toList());
            for (int attempt = 1; ; attempt++) {
                try {
                    return legacyTx(tx, buyerId, key, lines, hotIds, hot, products, inventory, cart, orders, history, keys, outbox, clock, props);
                } catch (org.springframework.dao.DataIntegrityViolationException e) {
                    // 第 03 章也有這個迴圈（2.4.4：訂單編號撞號，換一個號碼重來）。第一版的 E5 漏了它：21 張 500，舊流程的吞吐被低估
                    if (attempt >= PlaceOrderService.ORDER_NO_ATTEMPTS || !com.example.shop.shared.error.ConstraintViolations.isViolationOf(e, "uk_orders_order_no")) throw e;
                }
            }
        };
    }

    static PlacedOrder legacyTx(TransactionTemplate tx, long buyerId, String key, List<OrderLine> lines, Set<Long> hotIds, List<ReserveLine> hot,
                                Map<Long, ProductSnapshot> products, InventoryApi inventory, CartApi cart, OrderRepository orders, OrderHistory history,
                                IdempotencyKeys keys, Outbox outbox, Clock clock, ShopProperties props) {
            return tx.execute(s -> {
                List<Long> ids = lines.stream().map(OrderLine::productId).toList();
                Instant now = clock.instant();
                Order order = Order.place(OrderNumbers.next(now), buyerId, products.get(ids.get(0)).sellerId(), now, now.plus(props.order().paymentTimeout()));
                ReflectionTestUtils.setField(order, "status", OrderStatus.PENDING_PAYMENT);   // ①
                for (OrderLine l : lines) {
                    ProductSnapshot p = products.get(l.productId());
                    order.addItem(p.id(), p.name(), p.price(), l.quantity(), hotIds.contains(l.productId()));
                }
                orders.saveAndFlush(order);
                Set<Long> hotSet = new HashSet<>(hotIds);
                List<ReserveLine> normal = lines.stream().filter(l -> !hotSet.contains(l.productId())).map(l -> new ReserveLine(l.productId(), l.quantity())).toList();
                inventory.reserve(order.getId(), normal, hot);                // ② 在交易裡（切開的部署：交易裡的一次 HTTP）
                history.record(order.getId(), null, order.getStatus(), "PLACE_ORDER", OrderHistory.Actor.buyer(buyerId), now);
                keys.complete(buyerId, key, order.getId());
                cart.removeItems(buyerId, ids);
                outbox.add("ORDER", order.getId(), EventTypes.ORDER_PLACED, Map.of("orderId", order.getId(), "orderNo", order.getOrderNo(),
                        "buyerId", buyerId, "sellerId", order.getSellerId(), "totalAmount", order.getTotalAmount(), "hotProductIds", hotIds.stream().sorted().toList()));
                return new PlacedOrder(order.getId(), order.getOrderNo(), false);
            });
    }

    @Bean
    FilterRegistrationBean<OncePerRequestFilter> d04FlowSwitch() {
        FilterRegistrationBean<OncePerRequestFilter> r = new FilterRegistrationBean<>(new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                LEGACY.set("legacy".equals(req.getHeader("X-Lab-Flow")));
                try { chain.doFilter(req, res); } finally { LEGACY.remove(); }
            }
        });
        r.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return r;
    }
}
```

**`src/test/java/com/example/shop/dist04/OrderNode.java`**（4.2.1、4.10.3）

```java
package com.example.shop.dist04;

import com.example.shop.ShopApplication;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Roles;

import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * 13 站 4.2：一台訂單服務，在**另一個 JVM** 裡（同一個 classpath，第 00 章 SplitLab.startInventoryService 的做法）。
 * 參數跟第 03 章的 Roles.orderService 是同一份（正式的 order-service profile、誠實的兩個庫），只多一個固定的埠。
 *
 * 為什麼要另一個 JVM：這一章要的是「行程當掉」—— kill -9，不是 context.close()。close() 會等進行中的請求做完、跑完 finally 與 catch；
 * kill -9 之後什麼都不會再執行：交易沒有 commit（MySQL 在連線斷掉時 rollback）、catch 裡的補償不會跑、記憶體裡的東西全部不見。
 * 日誌寫到 target/d04-&lt;name&gt;.log。
 */
public final class OrderNode implements AutoCloseable {

    final String name;
    final int port;
    final int inventoryPort;
    final File log;
    Process process;
    int starts;
    /** 13 站 4.10：false = 訂單服務（Roles.orderArgs）；true = 庫存服務（Roles.inventoryArgs） */
    final boolean inventory;

    private OrderNode(String name, int port, int inventoryPort, boolean inventory) {
        this.name = name;
        this.port = port;
        this.inventoryPort = inventoryPort;
        this.inventory = inventory;
        this.log = new File("target/d04-" + name + ".log");
    }

    public static OrderNode start(String name, int port, int inventoryPort, List<String> extra) throws Exception {
        OrderNode n = new OrderNode(name, port, inventoryPort, false);
        n.boot(extra);
        return n;
    }

    /** 13 站 4.10（E5）：庫存服務放在另一個 JVM —— 量延遲時，兩個服務不搶同一個 JVM 的 CPU 與 GC（第 00 章 K1 的做法） */
    public static OrderNode inventory(String name, int port, List<String> extra) throws Exception {
        OrderNode n = new OrderNode(name, port, -1, true);
        n.boot(extra);
        return n;
    }

    /**
     * 起來、等到 readiness 是 200。回傳花了幾毫秒。
     * 上一個行程還活著就先關掉，而且要等埠真的空出來 —— 不然新的行程綁不到埠、自己死掉，readiness 卻由舊的那一個回 200
     * （第一版就是這樣：「重新起來 18 ms」，接下來的實驗全部跑在舊的行程上）
     */
    public long boot(List<String> extra) throws Exception {
        if (alive()) close();
        for (int i = 0; i < 100 && listening(); i++) Thread.sleep(100);
        if (listening()) throw new IllegalStateException("埠 " + port + " 還有人在聽");
        List<String> a = Split.override(inventory ? Roles.inventoryArgs() : Roles.orderArgs(inventoryPort), extra);
        a = Split.override(a, List.of("--server.port=" + port, "--logging.level.com.example.shop=INFO"));
        List<String> cmd = new ArrayList<>(List.of(ProcessHandle.current().info().command().orElse("java"),
                "-Dshop.test.infra=compose", "-cp", System.getProperty("java.class.path"), ShopApplication.class.getName()));
        cmd.addAll(a);
        starts++;
        ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true);
        pb.redirectOutput(starts == 1 ? ProcessBuilder.Redirect.to(log) : ProcessBuilder.Redirect.appendTo(log));
        long t0 = System.nanoTime();
        process = pb.start();
        HttpClient c = HttpClient.newHttpClient();
        for (int i = 0; i < 240; i++) {
            try {
                if (c.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/actuator/health/readiness")).build(),
                        HttpResponse.BodyHandlers.discarding()).statusCode() == 200) return (System.nanoTime() - t0) / 1_000_000;
            } catch (Exception notYet) { /* 還沒開始聽 */ }
            if (!process.isAlive()) throw new IllegalStateException(name + " 沒有起來，看 " + log);
            Thread.sleep(250);
        }
        process.destroyForcibly();
        throw new IllegalStateException(name + " 60 秒內沒有 ready，看 " + log);
    }

    /** kill -9：Process.destroyForcibly() 在 Unix 上送的是 SIGKILL。等到行程真的不見 */
    public void kill() throws Exception {
        process.destroyForcibly();
        if (!process.waitFor(10, TimeUnit.SECONDS)) throw new IllegalStateException(name + " 殺不掉");
    }

    public boolean alive() { return process != null && process.isAlive(); }

    boolean listening() {
        try (var socket = new java.net.Socket()) {
            socket.connect(new java.net.InetSocketAddress("127.0.0.1", port), 200);
            return true;
        } catch (Exception closed) {
            return false;
        }
    }

    public int port() { return port; }

    /** 日誌裡含 marker 的行（去掉時間與執行緒之前的那一段） */
    public List<String> lines(String marker) throws Exception {
        List<String> out = new ArrayList<>();
        for (String l : Files.readAllLines(log.toPath(), StandardCharsets.UTF_8))
            if (l.contains(marker)) out.add(l.substring(Math.max(0, l.indexOf(" : ") + 3)));
        return out;
    }

    @Override
    public void close() throws Exception {
        if (alive()) {
            process.destroy();
            if (!process.waitFor(20, TimeUnit.SECONDS)) kill();
        }
    }
}
```

**`src/test/java/com/example/shop/dist04/CrashPoint.java`**（4.2.1、4.8.3）

```java
package com.example.shop.dist04;

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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 13 站 4.2：「呼叫端在最壞的時刻當掉」。庫存服務照常處理、commit，**回應送出之前**先執行一個動作（kill -9 呼叫端的那個 JVM），
 * 再把回應寫到一條已經斷掉的連線上。從兩邊看：
 *   庫存服務 —— 做完了、commit 了；
 *   訂單服務 —— 等回應的那一刻行程就不見了：它的交易沒有 commit（MySQL 在連線斷掉時 rollback），catch 裡的補償一行都沒跑。
 *
 * 跟第 03 章的 LostResponse 是同一個做法（先做完、回應先收著），差在「之後做什麼」：那裡是等，這裡是殺。
 * 狀態是 static 的：庫存服務在這個 JVM 裡（Roles.inventoryService），filter 只在它的 context 裡（lab.d04.crash-point=true）。
 */
@Configuration
@ConditionalOnProperty(name = "lab.d04.crash-point", havingValue = "true")
public class CrashPoint {

    /** hold = null：處理完、commit 之後才執行 action；hold ≠ null：還沒處理就執行 action，然後扣著這個請求，等 hold 放行才處理（13 站 4.7.2） */
    record Arm(String method, String path, ThrowingRunnable action, AtomicInteger times, CountDownLatch hold) {}

    public interface ThrowingRunnable { void run() throws Exception; }

    /** 一次觸發：哪一個請求、庫存服務回了什麼（回應沒有送到） */
    public record Hit(String method, String path, int status) {}

    static final ConcurrentLinkedQueue<Arm> ARMED = new ConcurrentLinkedQueue<>();
    public static final ConcurrentLinkedQueue<Hit> HITS = new ConcurrentLinkedQueue<>();

    /** 下一個（method、路徑含 path 的）請求：處理完、commit 之後，回應送出之前，執行 action */
    public static void arm(String method, String path, ThrowingRunnable action) {
        ARMED.add(new Arm(method, path, action, new AtomicInteger(1), null));
    }

    /**
     * 13 站 4.7.2：「請求還在路上」。下一個（method、路徑含 path 的）請求一到，先執行 action（kill -9 呼叫端），
     * 再把這個請求扣在庫存服務門口，直到 hold 被放行（最多 120 秒）才照常處理 —— 它的回應也送不回去了
     */
    public static void hold(String method, String path, ThrowingRunnable action, CountDownLatch hold) {
        ARMED.add(new Arm(method, path, action, new AtomicInteger(1), hold));
    }

    public static void reset() {
        ARMED.clear();
        HITS.clear();
    }

    @Bean
    FilterRegistrationBean<OncePerRequestFilter> d04CrashPoint() {
        FilterRegistrationBean<OncePerRequestFilter> r = new FilterRegistrationBean<>(new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                Arm arm = ARMED.stream().filter(a -> a.method().equals(req.getMethod()) && req.getRequestURI().contains(a.path())
                        && a.times().getAndDecrement() > 0).findFirst().orElse(null);
                if (arm == null) { chain.doFilter(req, res); return; }
                if (arm.hold() != null) {
                    try {
                        arm.action().run();                                  // kill -9 呼叫端：這個請求已經離開了它
                        if (!arm.hold().await(120, TimeUnit.SECONDS)) throw new IllegalStateException("沒有人放行");
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                }
                ContentCachingResponseWrapper held = new ContentCachingResponseWrapper(res);
                chain.doFilter(req, held);                                   // controller 執行完、庫存服務的交易 commit 了
                HITS.add(new Hit(req.getMethod(), req.getRequestURI(), held.getStatus()));
                if (arm.hold() == null) {
                    try {
                        arm.action().run();                                  // kill -9 呼叫端
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                }
                try { held.copyBodyToResponse(); } catch (IOException gone) { /* 呼叫端已經不在了 */ }
            }
        });
        r.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return r;
    }
}
```

**`src/test/java/com/example/shop/dist04/Nodes.java`**（4.2、4.8.3）

```java
package com.example.shop.dist04;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist03.Shop;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import io.lettuce.core.RedisClient;
import org.springframework.context.ConfigurableApplicationContext;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 13 站第 04 章的實驗：讀兩個庫（root，直接讀擁有那張表的庫）、等事件安靜下來、組參數。
 * 訂單服務在另一個 JVM 裡（OrderNode），拿不到它的 bean —— 能看的只有資料庫、Redis、broker 與它的日誌。
 */
public final class Nodes {

    private Nodes() {}

    @SafeVarargs
    public static List<String> with(List<String>... lists) {
        List<String> a = new ArrayList<>();
        for (List<String> l : lists) a.addAll(l);
        return a;
    }

    /** 訂單服務的 Redis（OrderNode 不會替自己清；資料庫每次重建、id 從同一個號碼開始，上一次的商品快取會被讀到 —— 第 01 章 1.4.5 的 ⚠️） */
    public static void flushRedis(int db) {
        RedisClient c = RedisClient.create("redis://localhost:6379/" + db);
        try (var conn = c.connect()) { conn.sync().flushdb(); } finally { c.shutdown(); }
    }

    /** 兩個庫的 outbox 都送完、每一個佇列（含重試佇列）都沒有 ready 的訊息，連續 1 秒 */
    public static long quiet(ConfigurableApplicationContext inv, long max) throws Exception {
        List<String> queues = Broker.queueNames().stream().filter(q -> !q.endsWith(".dlq")).toList();
        long t0 = System.nanoTime(), calm = -1;
        while (true) {
            long pending = SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL")
                    + SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL");
            int ready = Broker.ready(inv, queues).values().stream().mapToInt(Integer::intValue).sum();
            long now = System.nanoTime();
            if (pending == 0 && ready == 0) {
                if (calm < 0) calm = now;
                if (now - calm > 1_000_000_000L) return (calm - t0) / 1_000_000;
            } else calm = -1;
            if (now - t0 > max * 1_000_000L) throw new IllegalStateException("沒有安靜下來：outbox 還有 " + pending + " 筆、佇列 ready " + ready);
            Thread.sleep(100);
        }
    }

    // ───────── 訂單服務的庫 ─────────

    public static long orders(long buyer) throws Exception {
        return SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM orders WHERE buyer_id = " + buyer);
    }

    public static String orders(long buyer, boolean statuses) throws Exception {
        return one(Split.ORDER_DB, "SELECT GROUP_CONCAT(status ORDER BY id) FROM orders WHERE buyer_id = " + buyer, "（沒有）");
    }

    /** 冪等鍵的狀態：「（沒有）」、「PROCESSING（租約還有 n 秒）」、「SUCCEEDED → 訂單 n」（DATETIME 存的是 UTC） */
    public static String key(long buyer, String key) throws Exception {
        return one(Split.ORDER_DB, """
                SELECT CONCAT(status, CASE WHEN status = 'PROCESSING'
                                           THEN CONCAT('（租約還有 ', GREATEST(0, ROUND(TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), locked_until) / 1e6, 1)), ' 秒）')
                                           ELSE CONCAT(' → 訂單 ', order_id) END)
                  FROM idempotency_keys WHERE buyer_id = %d AND idem_key = '%s'""".formatted(buyer, key), "（沒有）");
    }

    public static long orderId(String orderNo) throws Exception {
        return SplitLab.count(Split.ORDER_DB, "SELECT id FROM orders WHERE order_no = '" + orderNo + "'");
    }

    public static String orderStatus(String orderNo) throws Exception {
        return one(Split.ORDER_DB, "SELECT status FROM orders WHERE order_no = '" + orderNo + "'", "（沒有這張）");
    }

    public static String payments(String orderNo) throws Exception {
        return one(Split.ORDER_DB, "SELECT GROUP_CONCAT(p.status ORDER BY p.id) FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.order_no = '"
                + orderNo + "'", "（沒有）");
    }

    public static long refunds(String orderNo) throws Exception {
        return SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.order_no = '" + orderNo + "'");
    }

    /** 付款期限改到 1 分鐘前（逾時排程的下一輪就會取消它） */
    public static void expire(String orderNo) throws Exception {
        try (Connection c = SplitLab.root(Split.ORDER_DB); Statement st = c.createStatement()) {
            st.executeUpdate("UPDATE orders SET payment_deadline = NOW(3) - INTERVAL 1 MINUTE WHERE order_no = '" + orderNo + "'");
        }
    }

    public interface Check { boolean ok() throws Exception; }

    /** 等到 check 成立；max 毫秒之內沒有 → 丟例外 */
    public static void until(Check check, long max) throws Exception {
        long end = System.nanoTime() + max * 1_000_000L;
        while (!check.ok()) {
            if (System.nanoTime() > end) throw new IllegalStateException(max + " ms 之內沒有等到");
            Thread.sleep(100);
        }
    }

    public static long lastOrder(long buyer) throws Exception {
        return SplitLab.count(Split.ORDER_DB, "SELECT COALESCE(MAX(id), 0) FROM orders WHERE buyer_id = " + buyer);
    }

    public static String status(long orderId) throws Exception {
        return one(Split.ORDER_DB, "SELECT status FROM orders WHERE id = " + orderId, "（沒有這張）");
    }

    public static String history(long orderId) throws Exception {
        return one(Split.ORDER_DB, "SELECT GROUP_CONCAT(event ORDER BY id SEPARATOR ' → ') FROM order_status_history WHERE order_id = " + orderId, "（沒有）");
    }

    public static long keys(long buyer) throws Exception {
        return SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM idempotency_keys WHERE buyer_id = " + buyer);
    }

    public static long events(long orderId, String type) throws Exception {
        return SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM outbox_events WHERE aggregate_type = 'ORDER' AND aggregate_id = " + orderId
                + " AND event_type = '" + type + "'");
    }

    /** outbox 裡這張訂單、這種事件，還沒送出的幾筆 */
    public static long unpublished(long orderId, String type) throws Exception {
        return SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM outbox_events WHERE aggregate_type = 'ORDER' AND aggregate_id = " + orderId
                + " AND event_type = '" + type + "' AND published_at IS NULL");
    }

    public static String refundStatus(String orderNo) throws Exception {
        return one(Split.ORDER_DB, "SELECT GROUP_CONCAT(r.status) FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.order_no = '" + orderNo + "'", "（沒有）");
    }

    public static String allOrders() throws Exception {
        return one(Split.ORDER_DB, "SELECT GROUP_CONCAT(CONCAT(id, ' ', status) ORDER BY id SEPARATOR '、') FROM orders", "（沒有）");
    }

    // ───────── 庫存服務的庫 ─────────

    public static String reservationsOf(long orderId) throws Exception {
        return one(Split.INV_DB, "SELECT GROUP_CONCAT(status ORDER BY id) FROM inventory_reservations WHERE order_id = " + orderId, "（沒有）");
    }

    /** processed_messages 裡這張訂單的「預留」那一列（預留過、或被補償佔掉了） */
    public static long tombstones(long orderId) throws Exception {
        return SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM processed_messages WHERE consumer = 'inventory.http.reserve' AND message_id = '" + orderId + "'");
    }

    public static String allReservations() throws Exception {
        return one(Split.INV_DB, "SELECT GROUP_CONCAT(CONCAT(order_id, ' ', status) ORDER BY id SEPARATOR '、') FROM inventory_reservations", "（沒有）");
    }

    public static long reserved(long product) throws Exception {
        return SplitLab.count(Split.INV_DB, "SELECT reserved FROM inventory WHERE product_id = " + product);
    }

    public static long reservations(long product) throws Exception {
        return SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory_reservations WHERE product_id = " + product);
    }

    public static String reservationStatus(String orderNo) throws Exception {
        return one(Split.INV_DB, "SELECT GROUP_CONCAT(status ORDER BY id) FROM inventory_reservations WHERE order_id = " + orderId(orderNo), "（沒有）");
    }

    /** 這個商品的預留裡，order_id 在訂單服務的庫找不到的（兩個庫在同一台 MySQL：跨庫的 JOIN 當標準答案，2.6.6） */
    public static long orphans(long product) throws Exception {
        return SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory_reservations r LEFT JOIN " + Split.ORDER_DB
                + ".orders o ON o.id = r.order_id WHERE r.product_id = " + product + " AND o.id IS NULL");
    }

    /** 同上，只算還佔著庫存的（HELD、CONFIRMED） */
    public static long orphansActive(long product) throws Exception {
        return SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory_reservations r LEFT JOIN " + Split.ORDER_DB
                + ".orders o ON o.id = r.order_id WHERE r.product_id = " + product + " AND o.id IS NULL AND r.status IN ('HELD', 'CONFIRMED')");
    }

    public static String orphanOrderIds(long product) throws Exception {
        return one(Split.INV_DB, "SELECT GROUP_CONCAT(r.order_id ORDER BY r.id) FROM inventory_reservations r LEFT JOIN " + Split.ORDER_DB
                + ".orders o ON o.id = r.order_id WHERE r.product_id = " + product + " AND o.id IS NULL", "—");
    }

    /** 第 12 站 HotStock.GATE_BASE_SQL：熱點閘門「應該」是多少 */
    public static long gateBase(long product) throws Exception {
        var f = Class.forName("com.example.shop.inventory.internal.HotStock").getDeclaredField("GATE_BASE_SQL");
        f.setAccessible(true);
        return SplitLab.count(Split.INV_DB, ((String) f.get(null)).replace("?", String.valueOf(product)));
    }

    // ───────── 金流 ─────────

    /** 建立付款（走 HTTP），回傳簽好章、還沒送的金流回呼 */
    public static Map<String, Object> callback(Shop shop, ConfigurableApplicationContext keys, long buyer, String orderNo) throws Exception {
        Shop.Res p = shop.send("POST", "/api/orders/" + orderNo + "/payments", shop.bearer(buyer), null, Map.of());
        if (p.status() != 201) throw new IllegalStateException("建立付款 " + p.brief());
        long paymentId = p.json().get("paymentId").asLong();
        BigDecimal amount = new BigDecimal(p.json().get("amount").asText());
        String txn = "d04-" + UUID.randomUUID();
        String secret = keys.getBean(ShopProperties.class).payment().callbackSecret();
        return Map.of("paymentId", paymentId, "providerTxnId", txn, "amount", amount, "result", "SUCCEEDED",
                "signature", CallbackSignature.sign(secret, CallbackSignature.canonical(paymentId, txn, amount, true)));
    }

    static String one(String db, String sql, String none) throws Exception {
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            if (!rs.next()) return none;
            String v = rs.getString(1);
            return v == null ? none : v;
        }
    }
}
```

**`src/test/java/com/example/shop/dist04/E1CrashTest.java`**（4.2）

```java
package com.example.shop.dist04;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist03.Roles;
import com.example.shop.dist03.Shop;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 13 站 4.2：第 03 章的線上，訂單服務有兩台（A、B），A 在「庫存服務已經 commit、自己還沒 commit」的那一刻被 kill -9。
 * 第 02 章 2.5.3 用 trigger 讓訂單服務的交易失敗 —— 那是「行程還活著」的失敗：catch 會執行、補償會跑。這裡是行程不見了。
 *
 *   ⓪ 下單（熱點商品）：Redis 的閘門扣了之後，A 當掉
 *   ① 下單：預留 commit 之後，A 當掉；買家用同一個 Idempotency-Key 重送（負載平衡器把它送到 B）
 *   ② 逾時排程：釋放 commit 之後，A 當掉；買家的付款在 B 的排程輪到之前到了
 *   最後：A 重新起來（對帳的 grace 縮到 1 秒），看對帳找到什麼
 *
 *   mvn test -Pexperiments -Dtest=E1CrashTest
 */
@Tag("experiment")
class E1CrashTest {

    static final int A_PORT = 18421, B_PORT = 18422;
    /** 兩台都不讓對帳自己跑；A 的逾時排程只有 ② 需要 */
    static final List<String> QUIET = List.of("--shop.order.reservation-check-interval=1h");

    final PrintStream out = System.out;

    @Test
    void crashBetweenTheTwoCommits() throws Exception {
        out.printf("═══ 4.2 訂單服務兩台（A、B）；A 在「庫存服務 commit 之後、自己 commit 之前」被 kill -9（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        Broker.freshVhost();
        CrashPoint.reset();
        Nodes.flushRedis(Split.ORDER_REDIS);
        List<String> invArgs = new ArrayList<>(Broker.args());
        invArgs.add("--lab.d04.crash-point=true");
        try (ConfigurableApplicationContext inv = Roles.inventoryService(invArgs);
             OrderNode a = OrderNode.start("a", A_PORT, SplitLab.port(inv), Nodes.with(Broker.args(), QUIET));
             OrderNode b = OrderNode.start("b", B_PORT, SplitLab.port(inv), Nodes.with(Broker.args(), QUIET))) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Shop toA = new Shop(inv, a::port), toB = new Shop(inv, b::port);
            StringRedisTemplate invRedis = inv.getBean(StringRedisTemplate.class);
            long hot = SplitLab.FIRST_PRODUCT, p1 = hot + 1, p2 = hot + 2;
            toB.hot(hot);

            // ── ⓪ 熱點閘門扣了之後當掉 ──
            out.println("  ⓪ 下單（熱點商品）：Redis 的閘門扣了 1 件之後，A 被 kill -9");
            long buyer = 7_400_001L;
            String key = UUID.randomUUID().toString();
            CrashPoint.arm("POST", "/hot-gate", a::kill);
            out.println("     買家送到 A → " + attempt(toA, buyer, key, hot));
            out.printf("     那一刻：這位買家的訂單 %d 張；冪等鍵 %s；這個商品的預留 %d 筆；閘門 Redis %s、MySQL 算出來 %d%n",
                    Nodes.orders(buyer), Nodes.key(buyer, key), Nodes.reservations(hot), invRedis.opsForValue().get("stock:" + hot), Nodes.gateBase(hot));
            out.println("     買家用同一個鍵重送，到了 B → " + attempt(toB, buyer, key, hot));
            Nodes.quiet(inv, 30_000);
            out.printf("     之後：這位買家的訂單 %d 張；預留 %d 筆；閘門 Redis %s、MySQL 算出來 %d%n",
                    Nodes.orders(buyer), Nodes.reservations(hot), invRedis.opsForValue().get("stock:" + hot), Nodes.gateBase(hot));

            // ── ① 預留 commit 之後當掉 ──
            out.printf("  ① 下單：庫存服務的預留 commit 之後，A 被 kill -9（A 重新起來花了 %,d ms）%n", a.boot(Nodes.with(Broker.args(), QUIET)));
            buyer = 7_400_002L;
            key = UUID.randomUUID().toString();
            long reserved0 = Nodes.reserved(p1);
            CrashPoint.arm("PUT", "/reservations/", a::kill);
            out.println("     買家送到 A → " + attempt(toA, buyer, key, p1));
            out.printf("     那一刻：這位買家的訂單 %d 張；冪等鍵 %s；商品 %d 的 reserved %+d；沒有訂單的預留 %d 筆%n",
                    Nodes.orders(buyer), Nodes.key(buyer, key), p1, Nodes.reserved(p1) - reserved0, Nodes.orphans(p1));
            List<String> tries = new ArrayList<>();
            long t0 = System.nanoTime();
            while (true) {
                Shop.Res r = toB.place(buyer, key, p1);
                tries.add(String.format("%.1f 秒 %d", (System.nanoTime() - t0) / 1e9, r.status()));
                if (r.status() == 201) break;
                if (tries.size() == 1) out.println("     買家用同一個鍵重送，到了 B → " + r.brief());
                if (tries.size() > 20) throw new IllegalStateException("一直沒有成功：" + tries);
                Thread.sleep(5_000);
            }
            out.println("     每 5 秒重送一次：" + String.join("、", tries));
            out.printf("     之後：這位買家的訂單 %d 張；reserved %+d（應該 +1）；沒有訂單的預留 %d 筆（order_id %s）%n",
                    Nodes.orders(buyer), Nodes.reserved(p1) - reserved0, Nodes.orphans(p1), Nodes.orphanOrderIds(p1));

            // ── ② 逾時排程：釋放 commit 之後當掉；買家的付款先到 ──
            buyer = 7_400_003L;
            String no = toB.placeOk(buyer, p2);
            Map<String, Object> callback = Nodes.callback(toB, inv, buyer, no);
            out.printf("  ② 逾時排程：A 重新起來（%,d ms，逾時排程每 10 秒一輪）；訂單 %s 的付款期限改到過去%n",
                    a.boot(Nodes.with(Broker.args(), QUIET, List.of("--shop.order.timeout-scan-interval=10s"))), no);
            CrashPoint.arm("POST", "/release", a::kill);
            Nodes.expire(no);
            for (int i = 0; i < 300 && a.alive(); i++) Thread.sleep(100);
            CrashPoint.Hit hit = CrashPoint.HITS.stream().reduce((x, y) -> y).orElseThrow();
            out.printf("     A 的排程取消它 → 庫存服務 %s %s → %d、commit → A 被 kill -9%n", hit.method(), hit.path(), hit.status());
            out.printf("     那一刻：訂單 %s；預留 %s%n", Nodes.orderStatus(no), Nodes.reservationStatus(no));
            Shop.Res paid = toB.send("POST", "/api/payments/callback", null, callback, Map.of());
            out.printf("     金流回呼到了 B（B 的逾時排程還沒輪到）→ %d；訂單 %s；預留 %s%n", paid.status(), Nodes.orderStatus(no), Nodes.reservationStatus(no));
            Shop.Res picking = toB.startPicking(no), ship = toB.ship(no);
            out.printf("     賣家撿貨 → %d；出貨 → %s%n", picking.status(), ship.brief());
            Nodes.quiet(inv, 30_000);
            out.printf("     最後：訂單 %s；預留 %s；付款 %s；退款單 %d%n", Nodes.orderStatus(no), Nodes.reservationStatus(no),
                    Nodes.payments(no), Nodes.refunds(no));

            // ── 對帳 ──
            long ms = a.boot(Nodes.with(Broker.args(), List.of("--shop.order.reservation-grace=1s", "--shop.order.reservation-check-interval=10s")));
            out.printf("  A 重新起來（%,d ms），對帳的 grace 1 秒、每 10 秒一輪；等第一輪%n", ms);
            for (int i = 0; i < 300 && a.lines("CROSS_RECONCILIATION 掃了").isEmpty(); i++) Thread.sleep(100);
            for (String l : a.lines("CROSS_RECONCILIATION")) out.println("     " + l);
            Nodes.quiet(inv, 30_000);
            out.printf("     對帳之後：① 沒有訂單的預留 %d 筆；② 訂單 %s、預留 %s；⓪ 閘門 Redis %s、MySQL 算出來 %d%n",
                    Nodes.orphansActive(p1), Nodes.orderStatus(no), Nodes.reservationStatus(no),
                    invRedis.opsForValue().get("stock:" + hot), Nodes.gateBase(hot));
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    static String attempt(Shop shop, long buyer, String key, long product) {
        try {
            return shop.place(buyer, key, product).brief();
        } catch (Exception e) {
            return "連線斷了：" + e.getClass().getSimpleName() + (e.getMessage() == null ? "" : "（" + e.getMessage() + "）");
        }
    }
}
```

**`src/test/java/com/example/shop/dist04/E2TwoPhaseCommitTest.java`**（4.3）

```java
package com.example.shop.dist04;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Roles;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站 4.3：兩階段提交（XA）。訂單服務的庫、庫存服務的庫（同一台 MySQL 上的兩個庫 —— 但兩條連線、兩個交易，跟兩台機器的協定一模一樣），
 * 一張訂單 = 訂單那一邊 INSERT orders、庫存那一邊 UPDATE inventory + INSERT inventory_reservations。
 *
 *   ① 代價：「兩個本地交易，各自 commit」（第 03 章的下單：預留在庫存服務 commit、訂單在訂單服務 commit）vs XA 兩階段提交。
 *      單筆的延遲（交錯量），16 條執行緒的吞吐（隨機商品、同一個熱門商品各一次）。
 *   ② 協調者在 PREPARE 之後當掉：兩個分支都準備好了，沒有人告訴它們 commit 還是 rollback。
 *
 * 這裡的「協調者」就是這個測試自己：它直接連兩個庫。在拆開的部署裡，這件事本身就不成立 —— 訂單服務連不到庫存服務的庫（第 02 章 2.4.4）。
 *
 *   mvn test -Pexperiments -Dtest=E2TwoPhaseCommitTest
 */
@Tag("experiment")
class E2TwoPhaseCommitTest {

    static final long BUYER = 7_500_001L;
    static final AtomicLong SEQ = new AtomicLong();

    final PrintStream out = System.out;

    @Test
    void twoPhaseCommit() throws Exception {
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Roles.inventoryService(List.of());
             ConfigurableApplicationContext order = Roles.orderService(inv, List.of())) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
        }
        cost();
        coordinatorDies();
    }

    // ───────── ① 代價 ─────────

    enum Mode { LOCAL, XA }

    void cost() throws Exception {
        out.printf("═══ 4.3 ① 兩個本地交易 vs XA 兩階段提交：一張訂單（load %s）═══%n", SplitLab.load());
        try (Connection lo = connect(Split.ORDER_DB, Mode.LOCAL); Connection li = connect(Split.INV_DB, Mode.LOCAL);
             Connection xo = connect(Split.ORDER_DB, Mode.XA); Connection xi = connect(Split.INV_DB, Mode.XA)) {
            for (int w = 0; w < 200; w++) { place(Mode.LOCAL, lo, li, randomProduct()); place(Mode.XA, xo, xi, randomProduct()); }   // 熱身
            List<Long> local = new ArrayList<>(), xa = new ArrayList<>();
            for (int round = 0; round < 3; round++)
                for (Mode m : Mode.values())
                    for (int n = 0; n < 300; n++) {
                        long t0 = System.nanoTime();
                        if (m == Mode.LOCAL) place(m, lo, li, randomProduct()); else place(m, xo, xi, randomProduct());
                        (m == Mode.LOCAL ? local : xa).add(System.nanoTime() - t0);
                    }
            out.printf("  單筆（3 輪 × 300 張、交錯）│ 兩個本地交易 p50 %6.2f ms p99 %6.2f ms │ XA p50 %6.2f ms p99 %6.2f ms%n",
                    pct(local, 50), pct(local, 99), pct(xa, 50), pct(xa, 99));
        }
        for (boolean hot : new boolean[]{false, true}) {
            long[][] done = new long[2][3];
            for (int round = 0; round < 3; round++)
                for (Mode m : Mode.values()) done[m.ordinal()][round] = throughput(m, hot, 16, 4_000);
            out.printf("  16 條執行緒、每格 4 秒 × 3 輪（%s）│ 兩個本地交易 每秒 %s 張 │ XA 每秒 %s 張%n",
                    hot ? "全部買同一個商品" : "隨機的 1,000 個商品", perSecond(done[0]), perSecond(done[1]));
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    static long randomProduct() { return SplitLab.FIRST_PRODUCT + ThreadLocalRandom.current().nextInt(SplitLab.PRODUCTS); }

    /** LOCAL 的連線一直是 autocommit = false（每一張訂單不必再送 SET autocommit）；XA 的連線是 autocommit = true —— XA START 不能在本地交易裡 */
    static Connection connect(String db, Mode m) throws Exception {
        Connection c = SplitLab.root(db);
        c.setAutoCommit(m == Mode.XA);
        return c;
    }

    /** 一張訂單、一個品項。LOCAL：庫存那一邊先 commit、訂單那一邊後 commit（第 03 章的順序）；XA：兩邊都 PREPARE 了才 COMMIT */
    static void place(Mode m, Connection o, Connection i, long product) throws SQLException {
        String gtrid = "e2-" + SEQ.incrementAndGet();
        if (m == Mode.XA) { exec(o, "XA START '" + gtrid + "','o'"); exec(i, "XA START '" + gtrid + "','i'"); }
        long orderId = insertOrder(o);
        reserve(i, orderId, product);
        if (m == Mode.XA) {
            exec(o, "XA END '" + gtrid + "','o'");
            exec(i, "XA END '" + gtrid + "','i'");
            exec(i, "XA PREPARE '" + gtrid + "','i'");                     // 第一階段：兩邊都說「我做得到」
            exec(o, "XA PREPARE '" + gtrid + "','o'");
            exec(i, "XA COMMIT '" + gtrid + "','i'");                      // 第二階段：協調者決定 commit
            exec(o, "XA COMMIT '" + gtrid + "','o'");
        } else {
            i.commit();
            o.commit();
        }
    }

    static long insertOrder(Connection o) throws SQLException {
        try (PreparedStatement ps = o.prepareStatement("""
                INSERT INTO orders (order_no, buyer_id, seller_id, status, total_amount, payment_deadline)
                VALUES (?, ?, ?, 'PENDING_PAYMENT', 100.00, NOW(3) + INTERVAL 15 MINUTE)""", Statement.RETURN_GENERATED_KEYS)) {
            ps.setString(1, String.format("E2%013d", SEQ.incrementAndGet()));
            ps.setLong(2, BUYER);
            ps.setLong(3, SplitLab.SELLER);
            ps.executeUpdate();
            try (ResultSet rs = ps.getGeneratedKeys()) { rs.next(); return rs.getLong(1); }
        }
    }

    static void reserve(Connection i, long orderId, long product) throws SQLException {
        try (PreparedStatement ps = i.prepareStatement("UPDATE inventory SET reserved = reserved + 1 WHERE product_id = ? AND on_hand - reserved >= 1")) {
            ps.setLong(1, product);
            if (ps.executeUpdate() != 1) throw new IllegalStateException("庫存不足：" + product);
        }
        try (PreparedStatement ps = i.prepareStatement("INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (?, ?, 1, 'HELD')")) {
            ps.setLong(1, orderId);
            ps.setLong(2, product);
            ps.executeUpdate();
        }
    }

    long throughput(Mode m, boolean hot, int threads, long millis) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        AtomicLong done = new AtomicLong();
        long end = System.nanoTime() + millis * 1_000_000L;
        List<Future<?>> fs = new ArrayList<>();
        for (int t = 0; t < threads; t++)
            fs.add(pool.submit(() -> {
                try (Connection o = connect(Split.ORDER_DB, m); Connection i = connect(Split.INV_DB, m)) {
                    while (System.nanoTime() < end) {
                        place(m, o, i, hot ? SplitLab.FIRST_PRODUCT + 999 : randomProduct());
                        done.incrementAndGet();
                    }
                }
                return null;
            }));
        for (Future<?> f : fs) f.get();
        pool.shutdown();
        return done.get();
    }

    static String perSecond(long[] counts) {
        return String.join(" / ", Arrays.stream(counts).mapToObj(c -> String.format("%,d", c / 4)).toList());
    }

    static double pct(List<Long> nanos, double p) {
        long[] a = nanos.stream().mapToLong(Long::longValue).sorted().toArray();
        return SplitLab.pct(a, p);
    }

    // ───────── ② 協調者在 PREPARE 之後當掉 ─────────

    void coordinatorDies() throws Exception {
        out.printf("═══ 4.3 ② 協調者在 PREPARE 之後當掉（load %s）═══%n", SplitLab.load());
        long product = SplitLab.FIRST_PRODUCT + 500;
        String gtrid = "e2-crash";
        long orderId;
        try (Connection o = SplitLab.root(Split.ORDER_DB); Connection i = SplitLab.root(Split.INV_DB)) {
            exec(o, "XA START '" + gtrid + "','o'");
            exec(i, "XA START '" + gtrid + "','i'");
            orderId = insertOrder(o);
            reserve(i, orderId, product);
            exec(o, "XA END '" + gtrid + "','o'");
            exec(i, "XA END '" + gtrid + "','i'");
            exec(i, "XA PREPARE '" + gtrid + "','i'");
            exec(o, "XA PREPARE '" + gtrid + "','o'");
            out.printf("  協調者：兩個分支都 PREPARE 了（訂單 %d、商品 %d 預留 1 件）；決定 commit 之前，協調者不見了（兩條連線關掉）%n", orderId, product);
        }
        out.println("  XA RECOVER（任何一條連線都看得到，整台 MySQL 的）：" + recover());
        out.printf("  另一個 session 一般地讀：訂單 %d %s；商品 %d reserved = %d（還是準備之前的值）%n", orderId,
                SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM orders WHERE id = " + orderId) == 0 ? "不存在" : "存在", product,
                SplitLab.count(Split.INV_DB, "SELECT reserved FROM inventory WHERE product_id = " + product));
        out.println("  鎖（performance_schema.data_locks，這個商品那一列）：" + locks(product));

        // 下一位買家要同一個商品：等那一列的鎖
        try (Connection next = SplitLab.root(Split.INV_DB)) {
            exec(next, "SET SESSION innodb_lock_wait_timeout = 5");
            next.setAutoCommit(false);
            long t0 = System.nanoTime();
            String result;
            try {
                reserve(next, 999_999_999L, product);
                result = "成功";
            } catch (SQLException e) {
                result = "ERROR " + e.getErrorCode() + " " + e.getMessage();
            }
            next.rollback();
            out.printf("  下一位買家預留同一個商品（innodb_lock_wait_timeout 改成 5 秒；預設是 50 秒）→ %,d ms 後：%s%n", (System.nanoTime() - t0) / 1_000_000, result);
        }
        try (Connection next = SplitLab.root(Split.INV_DB)) {
            exec(next, "SET SESSION innodb_lock_wait_timeout = 5");
            long t0 = System.nanoTime();
            String result;
            try (Statement st = next.createStatement(); ResultSet rs = st.executeQuery("SELECT reserved FROM inventory WHERE product_id = " + product + " FOR SHARE")) {
                rs.next();
                result = "reserved = " + rs.getLong(1);
            } catch (SQLException e) {
                result = "ERROR " + e.getErrorCode() + " " + e.getMessage();
            }
            out.printf("  可售量的加鎖讀（FOR SHARE）→ %,d ms 後：%s%n", (System.nanoTime() - t0) / 1_000_000, result);
        }

        // 收尾：只有一半的決定 —— 協調者其實已經決定 commit、也 commit 了訂單那一邊，才當掉；值班的人看到庫存那一邊卡著，rollback 它
        try (Connection any = SplitLab.root(Split.ORDER_DB)) {
            exec(any, "XA COMMIT '" + gtrid + "','o'");
            out.println("  協調者重新起來，照它記下的決定 commit 了訂單那一邊；還沒 commit 庫存那一邊，又當掉了。XA RECOVER：" + recover());
            exec(any, "XA ROLLBACK '" + gtrid + "','i'");
            out.println("  值班的人只看到「一個卡住的交易，鎖著熱門商品」，XA ROLLBACK 它。XA RECOVER：" + recover());
        }
        out.printf("  最後：訂單 %d %s；它的預留 %d 筆；商品 %d reserved = %d —— 兩階段提交保證的那一件事（全有或全無），被一個人工的決定打破了%n",
                orderId, SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM orders WHERE id = " + orderId) == 1 ? "存在（PENDING_PAYMENT）" : "不存在",
                SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory_reservations WHERE order_id = " + orderId), product,
                SplitLab.count(Split.INV_DB, "SELECT reserved FROM inventory WHERE product_id = " + product));
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    static String recover() throws Exception {
        List<String> xids = new ArrayList<>();
        try (Connection c = SplitLab.root(""); Statement st = c.createStatement(); ResultSet rs = st.executeQuery("XA RECOVER")) {
            while (rs.next()) {
                String data = rs.getString("data");
                int g = rs.getInt("gtrid_length");
                xids.add(data.substring(0, g) + "," + data.substring(g));
            }
        }
        return xids.isEmpty() ? "（沒有）" : xids.toString();
    }

    static String locks(long product) throws Exception {
        try (Connection c = SplitLab.root(""); Statement st = c.createStatement(); ResultSet rs = st.executeQuery("""
                SELECT GROUP_CONCAT(CONCAT(object_name, ' ', lock_mode, ' ', lock_status) ORDER BY object_name SEPARATOR '；')
                  FROM performance_schema.data_locks
                 WHERE object_schema = '%s' AND object_name = 'inventory' AND lock_type = 'RECORD' AND lock_data = '%d'"""
                .formatted(Split.INV_DB, product))) {
            rs.next();
            return rs.getString(1) == null ? "（沒有）" : rs.getString(1);
        }
    }

    static void exec(Connection c, String sql) throws SQLException {
        try (Statement st = c.createStatement()) { st.execute(sql); }
    }
}
```

**`src/test/java/com/example/shop/dist04/E3SagaDrillTest.java`**（4.8.3）

```java
package com.example.shop.dist04;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist03.Roles;
import com.example.shop.dist03.Shop;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;

/**
 * 13 站 4.8.3：E1 的同一套演練，換成這一章的 Saga。訂單服務兩台（A、B），A 在最壞的時刻被 kill -9：
 *
 *   ⓪ 熱點閘門扣了之後（Saga 的第一步之前）—— 這一章沒有修它
 *   ① 預留 commit 之後；買家用同一個鍵重送到 B
 *   ①' 同上，但沒有人重送 —— A 重新起來，排程補償
 *   ①'' 預留的請求還在路上（扣在庫存服務門口），A 就不見了；排程補償之後，那個請求才到
 *   ② 逾時排程取消、commit 之後，A 就不見了（它的 relay 還沒送出 order.cancelled）；買家的付款接著到了 B
 *   最後：A 重新起來（對帳的 grace 縮到 1 秒），看對帳找到什麼
 *
 *   mvn test -Pexperiments -Dtest=E3SagaDrillTest
 */
@Tag("experiment")
class E3SagaDrillTest {

    static final int A_PORT = 18431, B_PORT = 18432;
    static final List<String> QUIET = List.of("--shop.order.reservation-check-interval=1h");
    /** A 重新起來時：排程每 10 秒一輪，RESERVING 超過 5 秒就補償（正式的設定是 30 秒、60 秒） */
    static final List<String> FAST = List.of("--shop.order.timeout-scan-interval=10s", "--shop.order.placement-timeout=5s");

    final PrintStream out = System.out;

    @Test
    void sagaUnderCrashes() throws Exception {
        out.printf("═══ 4.8.3 同樣的 kill -9，換成 Saga：訂單服務兩台（A、B）（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        Broker.freshVhost();
        CrashPoint.reset();
        Nodes.flushRedis(Split.ORDER_REDIS);
        List<String> invArgs = new ArrayList<>(Broker.args());
        invArgs.add("--lab.d04.crash-point=true");
        try (ConfigurableApplicationContext inv = Roles.inventoryService(invArgs);
             OrderNode a = OrderNode.start("e3-a", A_PORT, SplitLab.port(inv), Nodes.with(Broker.args(), QUIET));
             OrderNode b = OrderNode.start("e3-b", B_PORT, SplitLab.port(inv), Nodes.with(Broker.args(), QUIET))) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Shop toA = new Shop(inv, a::port), toB = new Shop(inv, b::port);
            StringRedisTemplate invRedis = inv.getBean(StringRedisTemplate.class);
            long hot = SplitLab.FIRST_PRODUCT, p1 = hot + 1, p2 = hot + 2, p3 = hot + 3;
            toB.hot(hot);

            // ── ⓪ ──
            out.println("  ⓪ 下單（熱點商品）：Redis 的閘門扣了 1 件之後，A 被 kill -9");
            long buyer = 7_600_001L;
            String key = UUID.randomUUID().toString();
            CrashPoint.arm("POST", "/hot-gate", a::kill);
            out.println("     買家送到 A → " + E1CrashTest.attempt(toA, buyer, key, hot));
            out.println("     買家用同一個鍵重送，到了 B → " + E1CrashTest.attempt(toB, buyer, key, hot));
            Nodes.quiet(inv, 30_000);
            out.printf("     之後：這位買家的訂單 %s；閘門 Redis %s、MySQL 算出來 %d（閘門在 Saga 的第一步之前：這一件要等熱點對帳）%n",
                    Nodes.orders(buyer, true), invRedis.opsForValue().get("stock:" + hot), Nodes.gateBase(hot));

            // ── ① ──
            out.printf("  ① 下單：庫存服務的預留 commit 之後，A 被 kill -9（A 重新起來 %,d ms）%n", a.boot(Nodes.with(Broker.args(), QUIET)));
            buyer = 7_600_002L;
            key = UUID.randomUUID().toString();
            long reserved0 = Nodes.reserved(p1);
            CrashPoint.arm("PUT", "/reservations/", a::kill);
            out.println("     買家送到 A → " + E1CrashTest.attempt(toA, buyer, key, p1));
            out.printf("     那一刻：這位買家的訂單 %s；冪等鍵 %s；商品 %d 的 reserved %+d%n", Nodes.orders(buyer, true), Nodes.key(buyer, key), p1,
                    Nodes.reserved(p1) - reserved0);
            Shop.Res resent = toB.place(buyer, key, p1);
            out.printf("     買家用同一個鍵重送，到了 B → %s（%,d ms）%n", resent.brief(), resent.millis());
            out.printf("     之後：這位買家的訂單 %s；reserved %+d（應該 +1）；沒有訂單的預留 %d 筆%n", Nodes.orders(buyer, true),
                    Nodes.reserved(p1) - reserved0, Nodes.orphans(p1));

            // ── ①' ──
            out.printf("  ①' 同上，但買家沒有重送：A 重新起來（%,d ms；排程每 10 秒，RESERVING 超過 5 秒就補償）%n", a.boot(Nodes.with(Broker.args(), QUIET, FAST)));
            buyer = 7_600_003L;
            reserved0 = Nodes.reserved(p2);
            CrashPoint.arm("PUT", "/reservations/", a::kill);
            out.println("     買家送到 A → " + E1CrashTest.attempt(toA, buyer, UUID.randomUUID().toString(), p2));
            long orderId = Nodes.lastOrder(buyer);
            out.printf("     那一刻：訂單 %d %s；預留 %s；reserved %+d%n", orderId, Nodes.status(orderId), Nodes.reservationsOf(orderId), Nodes.reserved(p2) - reserved0);
            long t0 = System.nanoTime();
            out.printf("     A 重新起來（%,d ms）%n", a.boot(Nodes.with(Broker.args(), QUIET, FAST)));
            Nodes.until(() -> Nodes.status(orderId).equals("REJECTED"), 60_000);
            long rejectedAt = (System.nanoTime() - t0) / 1_000_000;
            Nodes.quiet(inv, 30_000);
            out.printf("     %,d ms 之後：訂單 %s（歷史 %s）；預留 %s；reserved %+d；這位買家的冪等鍵 %d 個%n", rejectedAt, Nodes.status(orderId),
                    Nodes.history(orderId), Nodes.reservationsOf(orderId), Nodes.reserved(p2) - reserved0, Nodes.keys(buyer));

            // ── ①'' ──
            out.println("  ①'' 預留的請求還在路上：一到庫存服務，A 就被 kill -9；請求扣在門口");
            buyer = 7_600_004L;
            CountDownLatch release = new CountDownLatch(1);
            CrashPoint.hold("PUT", "/reservations/", a::kill, release);
            String gate0 = invRedis.opsForValue().get("stock:" + hot);
            out.println("     買家送到 A（熱點商品 + 一般商品）→ " + attempt(toA, buyer, hot, p3));
            long held = Nodes.lastOrder(buyer);
            out.printf("     那一刻：訂單 %d %s；預留 %s；閘門 Redis %s → %s；MySQL 算出來 %d（差的那一件是 ⓪ 留下的）%n", held, Nodes.status(held),
                    Nodes.reservationsOf(held), gate0, invRedis.opsForValue().get("stock:" + hot), Nodes.gateBase(hot));
            t0 = System.nanoTime();
            out.printf("     A 重新起來（%,d ms）%n", a.boot(Nodes.with(Broker.args(), QUIET, FAST)));
            Nodes.until(() -> Nodes.status(held).equals("REJECTED"), 60_000);
            Nodes.quiet(inv, 30_000);
            out.printf("     %,d ms 之後補償：訂單 %s；processed_messages 裡這張訂單的預留那一列 %d 筆；預留 %s；閘門 Redis %s、MySQL 算出來 %d%n",
                    (System.nanoTime() - t0) / 1_000_000, Nodes.status(held), Nodes.tombstones(held), Nodes.reservationsOf(held),
                    invRedis.opsForValue().get("stock:" + hot), Nodes.gateBase(hot));
            release.countDown();                                             // 那個請求終於到了
            Nodes.until(() -> CrashPoint.HITS.stream().anyMatch(h -> h.path().endsWith("/reservations/" + held)), 30_000);
            CrashPoint.Hit late = CrashPoint.HITS.stream().filter(h -> h.path().endsWith("/reservations/" + held)).findFirst().orElseThrow();
            Nodes.quiet(inv, 30_000);
            out.printf("     晚到的預留 %s %s → %d；之後：預留 %s；閘門 Redis %s、MySQL 算出來 %d%n", late.method(), late.path(), late.status(),
                    Nodes.reservationsOf(held), invRedis.opsForValue().get("stock:" + hot), Nodes.gateBase(hot));

            // ── ② ──
            buyer = 7_600_005L;
            String no = toB.placeOk(buyer, p2);
            Map<String, Object> callback = Nodes.callback(toB, inv, buyer, no);
            out.printf("  ② 逾時排程：A 重新起來，它的 relay 關著（%,d ms）；訂單 %s 的付款期限改到過去%n",
                    a.boot(Nodes.with(Broker.args(), QUIET, FAST, List.of("--shop.messaging.relay-enabled=false"))), no);
            Nodes.expire(no);
            Nodes.until(() -> Nodes.orderStatus(no).equals("CANCELLED"), 30_000);
            a.kill();
            out.printf("     A 的排程取消它、commit；A 被 kill -9。那一刻：訂單 %s；outbox 裡的 order.cancelled：%d 筆、還沒送出的 %d 筆（A 的 relay 關著）%n",
                    Nodes.orderStatus(no), Nodes.events(Nodes.orderId(no), "order.cancelled"), Nodes.unpublished(Nodes.orderId(no), "order.cancelled"));
            Nodes.quiet(inv, 30_000);
            out.printf("     B 的 relay 讀的是同一個 outbox：送出之後，預留 %s%n", Nodes.reservationStatus(no));
            Shop.Res paid = toB.send("POST", "/api/payments/callback", null, callback, Map.of());
            out.printf("     金流回呼到了 B → %d；訂單 %s%n", paid.status(), Nodes.orderStatus(no));
            Shop.Res picking = toB.startPicking(no);
            out.printf("     賣家撿貨 → %s%n", picking.brief());
            Nodes.quiet(inv, 30_000);
            Nodes.until(() -> Nodes.refundStatus(no).equals("SUCCEEDED"), 30_000);
            out.printf("     最後（B 的 relay 送出了 A 留下的事件）：訂單 %s；預留 %s；付款 %s；退款 %s%n", Nodes.orderStatus(no), Nodes.reservationStatus(no),
                    Nodes.payments(no), Nodes.refundStatus(no));

            // ── 對帳 ──
            long ms = a.boot(Nodes.with(Broker.args(), List.of("--shop.order.reservation-grace=1s", "--shop.order.reservation-check-interval=10s",
                    "--logging.level.com.example.shop.ordering.internal.ReservationReconciliation=DEBUG")));   // DEBUG：找到 0 張也寫一行
            out.printf("  A 重新起來（%,d ms），對帳的 grace 1 秒、每 10 秒一輪；等第一輪%n", ms);
            Nodes.until(() -> !a.lines("CROSS_RECONCILIATION 掃了").isEmpty(), 30_000);
            for (String l : a.lines("CROSS_RECONCILIATION")) out.println("     " + l);
            out.printf("     全部的預留：%s；全部的訂單：%s%n", Nodes.allReservations(), Nodes.allOrders());
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    /** 一張兩個品項的訂單：一個熱點、一個一般 */
    static String attempt(Shop shop, long buyer, long hot, long normal) {
        try {
            List<Map<String, Object>> items = List.of(Map.of("productId", hot, "quantity", 1, "unitPrice", new java.math.BigDecimal("100.00")),
                    Map.of("productId", normal, "quantity", 1, "unitPrice", new java.math.BigDecimal("100.00")));
            return shop.send("POST", "/api/orders", shop.bearer(buyer), Map.of("items", items), Map.of("Idempotency-Key", UUID.randomUUID().toString())).brief();
        } catch (Exception e) {
            return "連線斷了：" + e.getClass().getSimpleName() + (e.getMessage() == null ? "" : "（" + e.getMessage() + "）");
        }
    }
}
```

**`src/test/java/com/example/shop/dist04/E4SagaDayTest.java`**（4.10.2）

```java
package com.example.shop.dist04;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist01.D01Workload;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist03.CallTap;
import com.example.shop.dist03.Flow;
import com.example.shop.dist03.Roles;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 4.10.2：使用者的一天（第 01 章 1.4.4），跑在這一章的 Saga 上：兩個服務、正式的角色、事件走 RabbitMQ（第 03 章 D4 的做法），
 * 再數訂單服務打了庫存服務幾次（第 03 章 D2 的 CallTap）。第 03 章的數字：61 個請求、打庫存服務 38 次（D2）；
 * 庫存服務的 processed_messages 21 列（D4）。
 *
 *   mvn test -Pexperiments -Dtest=E4SagaDayTest
 */
@Tag("experiment")
class E4SagaDayTest {

    final PrintStream out = System.out;

    @Test
    void userDayOnTheSaga() throws Exception {
        out.printf("═══ 4.10.2 使用者的一天，Saga、事件走 RabbitMQ：兩個服務、正式的角色（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        Broker.freshVhost();
        try (ConfigurableApplicationContext inv = Roles.inventoryService(Broker.args());
             ConfigurableApplicationContext order = Roles.orderService(inv, Nodes.with(Broker.args(), List.of("--lab.d03.call-tap=true")))) {
            List<String> mains = Broker.queueNames().stream().filter(q -> !q.endsWith(".dlq") && !q.startsWith("shop.retry")).toList();
            for (int i = 0; i < 100 && Broker.consumers(order, mains).values().stream().anyMatch(n -> n < 2); i++) Thread.sleep(100);
            out.printf("  每一個佇列的消費者數：%s%n", Broker.consumers(order, mains));
            List<String> dbs = List.of(Split.ORDER_DB, Split.INV_DB);
            List<ConfigurableApplicationContext> both = List.of(order, inv);
            CallTap.CALLS.clear();
            D01Workload w = new D01Workload(order, Split.owners(order, inv), Split.databases());
            long[] waited = new long[2];
            w.broker = () -> { waited[0] += Flow.quiet(both, dbs, 60_000); waited[1]++; return null; };
            long t0 = System.nanoTime();
            w.run();
            long requests = w.steps.stream().filter(s -> s.status() > 0).count();
            out.printf("  使用者的一天：%d 個 HTTP 請求全部是預期的回應；等事件 %d 次、一共 %,d ms；整天 %,d ms%n",
                    requests, waited[1], waited[0], (System.nanoTime() - t0) / 1_000_000);

            Map<String, Integer> byOpAndEndpoint = new TreeMap<>();
            for (CallTap.Call c : CallTap.CALLS) byOpAndEndpoint.merge(c.op() + " → " + c.method() + " " + c.path(), 1, Integer::sum);
            out.printf("  訂單服務 → 庫存服務：%d 次 HTTP、%d 種端點（第 03 章：38 次、10 種）%n", CallTap.CALLS.size(),
                    CallTap.CALLS.stream().map(c -> c.method() + " " + c.path()).distinct().count());
            byOpAndEndpoint.forEach((k, n) -> out.printf("    %-100s × %d%n", k, n));
            Flow.print(out, order, inv);
            for (String db : dbs)
                out.printf("  %-15s outbox：送出 %d 筆、還沒送 %d 筆；processed_messages %d 列 %s%n", db,
                        SplitLab.count(db, "SELECT COUNT(*) FROM outbox_events WHERE published_at IS NOT NULL"),
                        SplitLab.count(db, "SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL"),
                        SplitLab.count(db, "SELECT COUNT(*) FROM processed_messages"), byConsumer(db));
            out.printf("  訂單：%s；預留：%s%n", Nodes.allOrders(), Nodes.allReservations());
            assertThat(requests).isEqualTo(61);
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    static String byConsumer(String db) throws Exception {
        return Nodes.one(db, "SELECT CONCAT('{', GROUP_CONCAT(CONCAT(consumer, '=', n) ORDER BY consumer SEPARATOR ', '), '}') FROM "
                + "(SELECT consumer, COUNT(*) AS n FROM processed_messages GROUP BY consumer) x", "{}");
    }
}
```

**`src/test/java/com/example/shop/dist04/E5SagaCostTest.java`**（4.10.3）

```java
package com.example.shop.dist04;

import com.example.shop.ShopApplication;
import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Roles;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 4.10.3：Saga 的代價。下單從「一個交易」變成「三個交易 + 中間一次預留」：
 *   第 03 章（legacy）：一個交易 —— 訂單、預留（切開的部署：交易裡的一次 HTTP）、歷史、冪等鍵、購物車、outbox
 *   這一章（saga）    ：T1 訂單 RESERVING → 預留（自己的交易；切開的部署：一次 HTTP，交易之外）→ T3 PENDING_PAYMENT、購物車、outbox
 * 兩種部署 × 兩種流程，同一次執行、交錯著量（LegacyPlaceOrder：請求帶 X-Lab-Flow: legacy 走第 03 章的流程）。
 * 單體、切開的訂單服務在這個 JVM；切開的庫存服務在另一個 JVM（第 00 章 K1 的做法）。
 *
 *   mvn test -Pexperiments -Dtest=E5SagaCostTest
 */
@Tag("experiment")
class E5SagaCostTest {

    static final String MONO_DB = "shop_d04_mono";
    static final int MONO_REDIS = 11, INV_PORT = 18451;
    static final AtomicLong BUYERS = new AtomicLong(7_700_000);

    final PrintStream out = System.out;

    record Target(String name, ConfigurableApplicationContext ctx) {}

    @Test
    void sagaCost() throws Exception {
        SplitLab.freshDatabase(MONO_DB);
        Split.freshDatabases();
        Nodes.flushRedis(MONO_REDIS);
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        List<String> mono = Split.override(SplitLab.common(MONO_DB, MONO_REDIS), List.of("--lab.d04.flow-switch=true"));
        try (OrderNode inv = OrderNode.inventory("e5-inventory", INV_PORT, List.of());
             ConfigurableApplicationContext m = new SpringApplicationBuilder(ShopApplication.class).run(mono.toArray(String[]::new));
             ConfigurableApplicationContext o = new SpringApplicationBuilder(ShopApplication.class)
                     .run(Split.override(Roles.orderArgs(INV_PORT), List.of("--lab.d04.flow-switch=true", "--shop.order.jobs-enabled=false")).toArray(String[]::new))) {
            SplitLab.seed(MONO_DB, true, true);
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            List<Target> targets = List.of(new Target("單體", m), new Target("切開", o));
            String[] flows = {"legacy", "saga"};

            out.printf("═══ 4.10.3 Saga 的代價：一張一張送，每格 3 輪 × 100 張、交錯（load %s）═══%n", SplitLab.load());
            for (Target t : targets) for (String f : flows) for (int i = 0; i < 100; i++) place(t, f, 3);   // 熱身
            Map<String, List<Long>> lat = new TreeMap<>();
            for (int round = 0; round < 3; round++)
                for (int items : new int[]{1, 10})
                    for (Target t : targets)
                        for (String f : flows)
                            for (int i = 0; i < 100; i++) {
                                long[] r = place(t, f, items);
                                assertThat(r[0]).as(t.name() + " " + f).isEqualTo(201);
                                lat.computeIfAbsent(items + "|" + t.name() + "|" + f, k -> new ArrayList<>()).add(r[1]);
                            }
            for (int items : new int[]{1, 10})
                for (Target t : targets) {
                    List<Long> a = lat.get(items + "|" + t.name() + "|legacy"), b = lat.get(items + "|" + t.name() + "|saga");
                    out.printf("  %2d 個品項 │ %s │ 第 03 章 p50 %6.2f ms p99 %7.2f ms │ Saga p50 %6.2f ms p99 %7.2f ms │ p50 差 %+6.2f ms%n",
                            items, t.name(), pct(a, 50), pct(a, 99), pct(b, 50), pct(b, 99), pct(b, 50) - pct(a, 50));
                }

            out.printf("═══ 4.10.3 16 條執行緒同時送 3 個品項的訂單：每格 3 輪 × 4 秒、交錯（load %s）═══%n", SplitLab.load());
            Map<String, long[]> done = new TreeMap<>(), failed = new TreeMap<>();
            Map<String, List<Long>> tl = new TreeMap<>();
            for (int round = 0; round < 3; round++)
                for (Target t : targets)
                    for (String f : flows) {
                        List<Long> nanos = java.util.Collections.synchronizedList(new ArrayList<>());
                        AtomicLong bad = new AtomicLong();
                        long n = load(t, f, 16, 4_000, nanos, bad);
                        done.computeIfAbsent(t.name() + "|" + f, k -> new long[3])[round] = n;
                        failed.computeIfAbsent(t.name() + "|" + f, k -> new long[1])[0] += bad.get();
                        tl.computeIfAbsent(t.name() + "|" + f, k -> new ArrayList<>()).addAll(nanos);
                    }
            for (Target t : targets)
                for (String f : flows) {
                    long[] d = done.get(t.name() + "|" + f);
                    List<Long> l = tl.get(t.name() + "|" + f);
                    out.printf("  %s │ %-6s │ 每秒 %s 張 │ p50 %6.2f ms │ p99 %7.2f ms │ 不是 201 的 %d 張%n", t.name(), f.equals("legacy") ? "第 03 章" : "Saga",
                            String.join(" / ", Arrays.stream(d).mapToObj(x -> String.format("%,d", x / 4)).toList()), pct(l, 50), pct(l, 99),
                            failed.get(t.name() + "|" + f)[0]);
                }
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    /** {狀態碼, 奈秒}。n 個不同的商品（避開同一列的鎖競爭），每一張一位新的買家 */
    static long[] place(Target t, String flow, int items) {
        long[] ids = ThreadLocalRandom.current().longs(0, SplitLab.PRODUCTS).distinct().limit(items).map(i -> SplitLab.FIRST_PRODUCT + i).toArray();
        String body = "{\"items\":[" + String.join(",", Arrays.stream(ids).mapToObj(id -> "{\"productId\":" + id + ",\"quantity\":1,\"unitPrice\":100.00}").toList()) + "]}";
        long buyer = BUYERS.incrementAndGet();
        HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + SplitLab.port(t.ctx()) + "/api/orders"))
                .timeout(Duration.ofSeconds(30)).header("Content-Type", "application/json")
                .header("Authorization", TestTokens.bearer(t.ctx(), buyer)).header("Idempotency-Key", UUID.randomUUID().toString())
                .header("X-Lab-Flow", flow).POST(HttpRequest.BodyPublishers.ofString(body)).build();
        long t0 = System.nanoTime();
        try {
            int status = SplitLab.CLIENT.send(req, HttpResponse.BodyHandlers.discarding()).statusCode();
            return new long[]{status, System.nanoTime() - t0};
        } catch (Exception e) {
            return new long[]{-1, System.nanoTime() - t0};
        }
    }

    static long load(Target t, String flow, int threads, long millis, List<Long> nanos, AtomicLong bad) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        AtomicLong ok = new AtomicLong();
        long end = System.nanoTime() + millis * 1_000_000L;
        List<Future<?>> fs = new ArrayList<>();
        for (int i = 0; i < threads; i++)
            fs.add(pool.submit(() -> {
                while (System.nanoTime() < end) {
                    long[] r = place(t, flow, 3);
                    if (r[0] == 201) { ok.incrementAndGet(); nanos.add(r[1]); } else bad.incrementAndGet();
                }
                return null;
            }));
        for (Future<?> f : fs) f.get();
        pool.shutdown();
        return ok.get();
    }

    static double pct(List<Long> nanos, double p) {
        return SplitLab.pct(nanos.stream().mapToLong(Long::longValue).sorted().toArray(), p);
    }
}
```

**`src/test/java/com/example/shop/dist04/E6NewStatusCostTest.java`**（4.5.6）

```java
package com.example.shop.dist04;

import com.example.shop.dist00.SplitLab;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站 4.5.6：多兩個訂單狀態的代價。10 萬張訂單（100 位賣家、30 天）的複本，schema 停在 V25（這一章之前）：
 *   ① V26 的第一版：換一個會檢查的 ck_orders_status —— 同時有 8 條執行緒一直在下單（INSERT orders），看它們被擋多久
 *   ② V26 現在的寫法：NOT ENFORCED、ALGORITHM=INSTANT；之後要再檢查（ALTER CHECK … ENFORCED）是另一次整表複製
 *   ③ V27：order_items 加一欄（INSTANT）
 *   ④ 報表的「訂單數」多一個 status 條件：(seller_id, created_at) 不再是覆蓋索引
 * 第 12 站 7.6.3 量過同一種改動（取消原因的 CHECK）：10 萬列 2.25～3.61 秒、期間不能下單，那一章因此沒有加那個值。
 *
 *   mvn test -Pexperiments -Dtest=E6NewStatusCostTest
 */
@Tag("experiment")
class E6NewStatusCostTest {

    static final String DB = "shop_d04_ddl", DB2 = "shop_d04_ddl2";
    static final String NEW_CHECK = "CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'PICKING', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'RESERVING', 'REJECTED'))";

    final PrintStream out = System.out;
    /** underLoad 寫進去的訂單 id：同一個庫會跑兩次 DDL，號碼要接著用 */
    final AtomicLong seq = new AtomicLong(200_000);

    @Test
    void newStatusCost() throws Exception {
        for (String db : List.of(DB, DB2)) {
            SplitLab.freshDatabase(db);
            Flyway.configure().dataSource(SplitLab.url(db), "root", "root").locations("classpath:db/migration").target("25").load().migrate();
            seed(db);
        }
        out.printf("═══ 4.5.6 ① V26 的第一版（換一個會檢查的 CHECK）：10 萬張訂單，8 條執行緒同時在下單（load %s）═══%n", SplitLab.load());
        try (Connection c = SplitLab.root(DB)) {
            probe(c, "ALTER TABLE orders DROP CHECK ck_orders_status, ADD CONSTRAINT ck_orders_status " + NEW_CHECK + ", ALGORITHM=INPLACE");
        }
        underLoad(DB, "ALTER TABLE orders DROP CHECK ck_orders_status, ADD CONSTRAINT ck_orders_status " + NEW_CHECK);

        out.printf("═══ 4.5.6 ② V26 現在的寫法（NOT ENFORCED、INSTANT），另一份同樣的複本，同樣的負載 ═══%n");
        String v26 = Files.readString(Path.of("src/main/resources/db/migration/ordering/V26__ordering_placement_statuses.sql"), StandardCharsets.UTF_8)
                .lines().filter(l -> !l.startsWith("--")).reduce("", (x, y) -> x + "\n" + y).strip();
        if (v26.endsWith(";")) v26 = v26.substring(0, v26.length() - 1);
        underLoad(DB2, v26);
        try (Connection c = SplitLab.root(DB2)) {
            probe(c, "INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline) "
                    + "VALUES (999999, 'E6-BOGUS', 1, 1, 'BOGUS', 1, NOW(3))");                                         // MySQL 不再擋
            probe(c, "DELETE FROM orders WHERE id = 999999");
        }
        out.println("  之後要讓 MySQL 再檢查：另一次停機維護");
        underLoad(DB2, "ALTER TABLE orders ALTER CHECK ck_orders_status ENFORCED");

        out.printf("═══ 4.5.6 ③ V27：order_items 加一欄（10 萬列）═══%n");
        try (Connection c = SplitLab.root(DB)) {
            probe(c, Files.readString(Path.of("src/main/resources/db/migration/ordering/V27__ordering_item_hot.sql"), StandardCharsets.UTF_8)
                    .lines().filter(l -> !l.startsWith("--")).reduce("", (x, y) -> x + y).strip().replace(";", ""));
        }

        out.printf("═══ 4.5.6 ④ 報表的「訂單數」：一位賣家 30 天（load %s）═══%n", SplitLab.load());
        String before = """
                SELECT DATE(CONVERT_TZ(o.created_at, '+00:00', '+08:00')) AS day, COUNT(*) FROM orders o
                 WHERE o.created_at >= NOW(3) - INTERVAL 30 DAY AND o.created_at < NOW(3) AND o.seller_id = 900042 GROUP BY day""";
        String after = before.replace("AND o.seller_id = 900042", "AND o.seller_id = 900042 AND o.status NOT IN ('RESERVING', 'REJECTED')");
        String siteBefore = before.replace(" AND o.seller_id = 900042", "");
        String siteAfter = after.replace(" AND o.seller_id = 900042", "");
        try (Connection c = SplitLab.root(DB)) {
            for (String[] q : new String[][]{{"一位賣家，第 03 章", before}, {"一位賣家，這一章", after}, {"全站，第 03 章", siteBefore}, {"全站，這一章", siteAfter}})
                out.printf("  %s：%n%s%n", q[0], explain(c, q[1]));
            long[][] t = new long[4][];
            String[] qs = {before, after, siteBefore, siteAfter};
            for (int i = 0; i < 4; i++) t[i] = new long[60];
            for (int round = 0; round < 60; round++)
                for (int i = 0; i < 4; i++) {
                    long t0 = System.nanoTime();
                    try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(qs[i])) { while (rs.next()) { } }
                    t[i][round] = System.nanoTime() - t0;
                }
            for (int i = 0; i < 4; i++) java.util.Arrays.sort(t[i]);
            out.printf("  60 次、交錯，p50：一位賣家 %.2f → %.2f ms；全站 %.2f → %.2f ms%n",
                    SplitLab.pct(t[0], 50), SplitLab.pct(t[1], 50), SplitLab.pct(t[2], 50), SplitLab.pct(t[3], 50));
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    /** 10 萬張訂單：100 位賣家、30 天內均勻分布；1% 待付款、2% 已付款、97% 已完成；每張一個品項 */
    static void seed(String db) throws Exception {
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement()) {
            st.execute("SET SESSION cte_max_recursion_depth = 1000000");
            st.execute("""
                    INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline, carrier, tracking_no,
                                        paid_at, shipped_at, completed_at, created_at, updated_at)
                    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
                    SELECT i, CONCAT('20990101-', LPAD(i, 6, '0')), 800000 + i % 5000, 900000 + i % 100,
                           CASE WHEN i % 100 = 0 THEN 'PENDING_PAYMENT' WHEN i % 100 IN (1, 2) THEN 'PAID' ELSE 'COMPLETED' END,
                           300, NOW(3) + INTERVAL 15 MINUTE,
                           IF(i % 100 > 2, '黑貓', NULL), IF(i % 100 > 2, CONCAT('T', i), NULL),
                           IF(i % 100 > 0, NOW(3) - INTERVAL i * 25 SECOND, NULL), IF(i % 100 > 2, NOW(3) - INTERVAL i * 25 SECOND, NULL),
                           IF(i % 100 > 2, NOW(3) - INTERVAL i * 25 SECOND, NULL), NOW(3) - INTERVAL i * 25 SECOND, NOW(3) - INTERVAL i * 25 SECOND
                      FROM n""");
            st.execute("""
                    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
                    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
                    SELECT i, 9000001 + i % 1000, '種子商品', 300, 1 FROM n""");
            st.execute("ANALYZE TABLE orders, order_items");
        }
    }

    /** 8 條執行緒一直 INSERT 訂單（跟下單交易的第一句一樣），同時跑 ddl。印出 ddl 花多久、那段時間裡下單被擋了多久 */
    void underLoad(String db, String ddl) throws Exception {
        AtomicBoolean stop = new AtomicBoolean();
        List<long[]> inserts = java.util.Collections.synchronizedList(new ArrayList<>());   // {開始, 結束}（奈秒）
        ExecutorService pool = Executors.newFixedThreadPool(8);
        List<Future<?>> fs = new ArrayList<>();
        for (int i = 0; i < 8; i++)
            fs.add(pool.submit(() -> {
                try (Connection c = SplitLab.root(db); Statement st = c.createStatement()) {
                    while (!stop.get()) {
                        long id = seq.incrementAndGet(), t0 = System.nanoTime();
                        st.executeUpdate("INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline) VALUES ("
                                + id + ", 'E6-" + id + "', 7800001, 900001, 'PENDING_PAYMENT', 100, NOW(3) + INTERVAL 15 MINUTE)");
                        inserts.add(new long[]{t0, System.nanoTime()});
                    }
                }
                return null;
            }));
        Thread.sleep(1_000);
        String result;
        long a0 = System.nanoTime(), a1;
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement()) {
            st.execute(ddl);
            result = "成功";
        } catch (SQLException e) {
            result = "ERROR " + e.getErrorCode() + " " + e.getMessage();
        }
        a1 = System.nanoTime();
        Thread.sleep(1_000);
        stop.set(true);
        for (Future<?> f : fs) f.get();
        pool.shutdown();
        long during = inserts.stream().filter(x -> x[1] > a0 && x[0] < a1).count();
        long blocked = inserts.stream().filter(x -> x[0] < a1 && x[1] > a0).mapToLong(x -> x[1] - x[0]).max().orElse(0);
        long beforeCount = inserts.stream().filter(x -> x[1] <= a0).count();
        out.printf("  %s%n    → %s，%,d ms；DDL 之前 1 秒內下單 %,d 張；DDL 期間完成 %,d 張；最慢的一張等了 %,d ms%n",
                ddl.replace("\n", " ").replaceAll(" +", " "), result, (a1 - a0) / 1_000_000, beforeCount, during, blocked / 1_000_000);
    }

    void probe(Connection c, String ddl) {
        long t0 = System.nanoTime();
        String result;
        try (Statement st = c.createStatement()) {
            st.execute(ddl);
            result = "成功";
        } catch (SQLException e) {
            result = "ERROR " + e.getErrorCode() + " " + e.getMessage();
        }
        out.printf("  %s%n    → %s（%,d ms）%n", ddl.replaceAll(" +", " "), result, (System.nanoTime() - t0) / 1_000_000);
    }

    static String explain(Connection c, String sql) throws Exception {
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("EXPLAIN ANALYZE " + sql)) {
            rs.next();
            return rs.getString(1).lines().map(l -> "    " + l).reduce("", (x, y) -> x.isEmpty() ? y : x + "\n" + y);
        }
    }
}
```

改過的（diff）：

**`src/test/java/com/example/shop/dist03/Roles.java`**

```diff
     private Roles() {}
 
     public static ConfigurableApplicationContext inventoryService(List<String> extra) throws Exception {
+        return flushed(new SpringApplicationBuilder(ShopApplication.class).run(Split.override(inventoryArgs(), extra).toArray(String[]::new)));
+    }
+
+    /** 13 站 4.10：庫存服務的參數。第 04 章的 E5 把它放到另一個 JVM 裡跑（dist04.OrderNode.inventory），參數是同一份 */
+    public static List<String> inventoryArgs() throws Exception {
         List<String> a = Split.args(Split.INV_DB, Split.INV_REDIS, Split.Schema.HONEST, true, false);
-        a = Split.override(a, List.of("--spring.profiles.active=local,inventory-service", "--shop.deployment.service-token.secret=" + SECRET));
-        return flushed(new SpringApplicationBuilder(ShopApplication.class).run(Split.override(a, extra).toArray(String[]::new)));
+        return Split.override(a, List.of("--spring.profiles.active=local,inventory-service", "--shop.deployment.service-token.secret=" + SECRET));
     }
 
     public static ConfigurableApplicationContext orderService(ConfigurableApplicationContext inventory, List<String> extra) throws Exception {
-        List<String> a = Split.args(Split.ORDER_DB, Split.ORDER_REDIS, Split.Schema.HONEST, false, false);
-        a = Split.override(a, List.of("--spring.profiles.active=local,order-service", "--shop.deployment.service-token.secret=" + SECRET,
-                "--shop.deployment.inventory.url=http://127.0.0.1:" + SplitLab.port(inventory),
-                // 使用者的一天直接呼叫 OrderJobs（第 01 章 1.4.4）：要有這個 bean；間隔拉長到不會自己再跑一次
-                "--shop.order.jobs-enabled=true", "--shop.order.timeout-scan-interval=1h"));
+        List<String> a = orderArgs(SplitLab.port(inventory));
         ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ShopApplication.class).run(Split.override(a, extra).toArray(String[]::new));
         Thread.sleep(1000);                                                  // 排程在啟動時各跑一次（空的資料庫）：等它跑完
         return flushed(ctx);
     }
 
+    /** 13 站 4.2：訂單服務的參數。第 04 章把它放到另一個 JVM 裡跑（dist04.OrderNode），參數是同一份 */
+    public static List<String> orderArgs(int inventoryPort) throws Exception {
+        List<String> a = Split.args(Split.ORDER_DB, Split.ORDER_REDIS, Split.Schema.HONEST, false, false);
+        return Split.override(a, List.of("--spring.profiles.active=local,order-service", "--shop.deployment.service-token.secret=" + SECRET,
+                "--shop.deployment.inventory.url=http://127.0.0.1:" + inventoryPort,
+                // 使用者的一天直接呼叫 OrderJobs（第 01 章 1.4.4）：要有這個 bean；間隔拉長到不會自己再跑一次
+                "--shop.order.jobs-enabled=true", "--shop.order.timeout-scan-interval=1h"));
+    }
+
     static ConfigurableApplicationContext flushed(ConfigurableApplicationContext ctx) {
         ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class).execute(
                 (org.springframework.data.redis.core.RedisCallback<Void>) c -> { c.serverCommands().flushDb(); return null; });
```

**`src/test/java/com/example/shop/dist03/Shop.java`**

```diff
     }
 
     final ConfigurableApplicationContext gateway;
+    final java.util.function.IntSupplier port;
     final ObjectMapper json = new ObjectMapper();
 
-    public Shop(ConfigurableApplicationContext gateway) { this.gateway = gateway; }
+    public Shop(ConfigurableApplicationContext gateway) { this(gateway, () -> SplitLab.port(gateway)); }
+
+    /**
+     * 13 站 4.2：訂單服務在另一個 JVM 裡（dist04.OrderNode）。token 與金流回呼的簽章用 keys 這個 context 的設定簽
+     * （兩個服務的使用者 token 金鑰、金流金鑰是同一份設定，3.7.2 的小坑），請求送到 port
+     */
+    public Shop(ConfigurableApplicationContext keys, java.util.function.IntSupplier port) {
+        this.gateway = keys;
+        this.port = port;
+    }
 
     // ───────── 賣家 ─────────
 
…
     public String seller() { return TestTokens.bearer(gateway, SELLER, Role.SELLER); }
 
     public Res send(String method, String path, String token, Object body, Map<String, String> headers) throws Exception {
-        return send(SplitLab.port(gateway), method, path, token, body, headers);
+        return send(port.getAsInt(), method, path, token, body, headers);
     }
 
     /** 直接打某一個服務（例如繞過訂單服務、直接打庫存服務） */
```

**`src/test/java/com/example/shop/dist00/RemoteInventoryApi.java`**

```diff
     }
 
     // ── 下單流程不會走到的，照舊用本地的實作 ──
-    @Override public void confirm(long orderId) { local.confirm(orderId); }
-    @Override public void release(long orderId) { local.release(orderId); }
-    @Override public void consume(long orderId) { local.consume(orderId); }
+    // 13 站 4.6：confirm、release、consume 不在 InventoryApi 上了（庫存模組收訂單的事件）
+    @Override public void checkShippable(long orderId) { local.checkShippable(orderId); }
     @Override public void restock(long productId, int quantity, String note) { local.restock(productId, quantity, note); }
     @Override public void gateHot(List<ReserveLine> hotLines) { local.gateHot(hotLines); }
     @Override public void returnHot(List<ReserveLine> hotLines) { local.returnHot(hotLines); }
```

**`src/test/java/com/example/shop/dist02/RemoteInventory.java`**

```diff
         if (!lines.isEmpty()) call("reserve", Map.of("orderId", orderId, "lines", lines));
         if (!hotLines.isEmpty()) call("hold-hot", Map.of("orderId", orderId, "lines", hotLines));
     }
-    @Override public void confirm(long orderId) { call("confirm", Map.of("orderId", orderId)); }
-    @Override public void release(long orderId) { call("release", Map.of("orderId", orderId)); }
-    @Override public void consume(long orderId) { call("consume", Map.of("orderId", orderId)); }
+    // 13 站 4.6：confirm、release、consume 不在 InventoryApi 上了（庫存模組收訂單的事件）；出貨之前的檢查，這條線沒有（走本地的會讀錯庫）
+    @Override public void checkShippable(long orderId) { }
     @Override public void restock(long productId, int quantity, String note) { call("restock", Map.of("productId", productId, "quantity", quantity, "note", note)); }
     @Override public void gateHot(List<ReserveLine> hotLines) { call("gate-hot", Map.of("lines", hotLines)); }
     @Override public void returnHot(List<ReserveLine> hotLines) { call("return-hot", Map.of("lines", hotLines)); }
```

**`src/test/java/com/example/shop/dist02/InventoryEndpoints.java`**

```diff
                 // 13 站 3.4：initialize 不在 InventoryApi 上了（第 02 章 2.7 之後就沒有遠端的呼叫者）；holdHot 併進了 reserve 的第三個參數
                 case "reserve" -> tx.executeWithoutResult(s -> inventory.reserve(b.get("orderId").asLong(), lines(b), List.of()));
                 case "hold-hot" -> tx.executeWithoutResult(s -> inventory.reserve(b.get("orderId").asLong(), List.of(), lines(b)));
-                case "confirm" -> tx.executeWithoutResult(s -> inventory.confirm(b.get("orderId").asLong()));
-                case "release" -> tx.executeWithoutResult(s -> inventory.release(b.get("orderId").asLong()));
-                case "consume" -> tx.executeWithoutResult(s -> inventory.consume(b.get("orderId").asLong()));
+                // 13 站 4.6：confirm、release、consume 不在 InventoryApi 上了（庫存模組收訂單的事件），這條線上也沒有人再呼叫它們
                 case "set-hot" -> tx.executeWithoutResult(s -> inventory.setHot(b.get("productId").asLong(), b.get("hot").asBoolean()));
                 case "restock" -> inventory.restock(b.get("productId").asLong(), b.get("quantity").asInt(), b.get("note").asText());
                 case "gate-hot" -> inventory.gateHot(lines(b));
```

**`src/test/java/com/example/shop/dist01/CrossModuleCallInTxTest.java`**

```diff
      * 第 01 章結束時，還在交易裡的跨模組呼叫：全部是「寫」，全部要等 Saga（第 04 章）才拿得出來。
      * 13 站 2.7：「catalog → InventoryApi.initialize」拿掉了 —— 建立商品改成寫一個 product.created，期初庫存由庫存模組的消費者建立（12 → 11 種）
      * 13 站 3.4：「ordering → InventoryApi.holdHot」拿掉了 —— 熱點品項併進 reserve() 的第三個參數，一張訂單的預留是一次呼叫（11 → 10 種）
+     * 13 站 4.5、4.6：ordering → InventoryApi 的四種全部拿掉了（10 → 6 種）。reserve 是下單 Saga 的一步，在任何交易之外；
+     * confirm、release、consume 不在 InventoryApi 上了 —— 庫存模組收 order.paid、order.cancelled、order.shipped。
+     * 剩下的 6 種都在訂單服務自己的庫裡（cart、payment 跟 ordering 在同一個服務）：庫存這一刀，不再切斷任何一個交易
      */
     static final Map<String, String> ALLOWED = Map.ofEntries(
-            entry("catalog → InventoryApi.setHot", "標熱點：MANDATORY，commit 之後建立 Redis 閘門（第 04 章）"),
-            entry("ordering → CartApi.removeItems", "下單：清購物車跟訂單同一個交易（第 04 章）"),
-            entry("ordering → InventoryApi.reserve", "下單：預留（含熱點品項的預留列）跟訂單同一個交易（第 04 章）"),
-            entry("ordering → InventoryApi.confirm", "付款成功：預留確認跟訂單狀態同一個交易（第 04 章）"),
-            entry("ordering → InventoryApi.consume", "出貨：扣庫存跟訂單狀態同一個交易（第 04 章）"),
-            entry("ordering → InventoryApi.release", "取消：釋放預留跟訂單狀態同一個交易（第 04 章）"),
-            entry("ordering → PaymentApi.create", "建立付款：跟訂單同一個交易（第 04 章）"),
-            entry("ordering → PaymentApi.record", "金流回呼：付款紀錄跟訂單狀態同一個交易（第 04 章）"),
-            entry("ordering → PaymentApi.succeededPaymentOf", "取消：決定要不要退款（第 04 章）"),
-            entry("ordering → PaymentApi.requestRefund", "取消：退款單跟訂單狀態同一個交易（第 04 章）"));
+            entry("catalog → InventoryApi.setHot", "標熱點：MANDATORY，commit 之後建立 Redis 閘門（13 站 3.4.7：熱點旗標沒有搬）"),
+            entry("ordering → CartApi.removeItems", "下單的 Saga 往前走完（RESERVED）：清購物車跟訂單狀態同一個交易 —— 同一個服務、同一個庫"),
+            entry("ordering → PaymentApi.create", "建立付款：跟訂單同一個交易 —— 同一個服務、同一個庫"),
+            entry("ordering → PaymentApi.record", "金流回呼：付款紀錄跟訂單狀態同一個交易 —— 同上"),
+            entry("ordering → PaymentApi.succeededPaymentOf", "取消：決定要不要退款（第 01 章 1.6.7：不能移出交易）—— 同上"),
+            entry("ordering → PaymentApi.requestRefund", "取消：退款單跟訂單狀態同一個交易 —— 同上"));
 
     static final long SELLER = 990_961, BUYER = 990_962, PRODUCT = 9_900_961, HOT = 9_900_962;
 
```

**`src/test/java/com/example/shop/ordering/internal/OrderFlowTest.java`**

```diff
     @Autowired org.springframework.data.redis.core.StringRedisTemplate redis;
     @Autowired Clock clock;
     @Autowired ShopProperties props;
+    @Autowired org.springframework.context.ApplicationContext ctx;
 
     @BeforeEach
     void setUp() {
…
 
     int available() { return jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, PRODUCT); }
 
+    /**
+     * 13 站 4.6 的追記：付款、取消、出貨之後，庫存那一半是庫存模組收到 order.paid、order.cancelled、order.shipped 才做的。
+     * 第 12 站在同一個交易裡，所以這裡的測試一 commit 就讀預留；現在要先把這幾張訂單的事件交給庫存模組的消費者
+     */
+    void stockFollows() {
+        com.example.shop.support.InlineEvents.deliverTo(ctx, com.example.shop.support.InlineEvents.ofOrders(
+                jdbc.queryForList("SELECT id FROM orders WHERE buyer_id IN (?, ?)", Long.class, BUYER, OTHER_BUYER)), "inventory.order-events");
+    }
+
     @Test @DisplayName("ORD-1 AC-1～3：待付款、付款期限 = 建立 + 15 分鐘、HELD 預留、reserved 增加、onHand 不變")
     void placeOrder() {
         String no = place(2);
…
         long pid = pay(no, "tx-ok", "100", true, true);
         callback(pid, "tx-ok", "100", true, true);                           // 金流重送
         assertThat(status(no)).isEqualTo("PAID");
+        assertThat(reservation(no)).isEqualTo("HELD");                       // 13 站 4.6：庫存還沒跟上
+        stockFollows();
         assertThat(reservation(no)).isEqualTo("CONFIRMED");
         assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM order_status_history WHERE order_id = ? AND event = 'PAY_SUCCEEDED'", Long.class, id(no))).isEqualTo(1);
     }
…
         callback(pid, "tx-late", "100", true, true);
         assertThat(status(no)).isEqualTo("CANCELLED");
         assertThat(refunds(no)).containsExactly("LATE_PAYMENT");
+        stockFollows();
         assertThat(available()).isEqualTo(10);
     }
 
…
         commands.cancelByBuyer(BUYER, no);
         commands.cancelByBuyer(BUYER, no);                                   // 冪等
         assertThat(status(no)).isEqualTo("CANCELLED");
+        stockFollows();
         assertThat(reservation(no)).isEqualTo("RELEASED");
         assertThat(refunds(no)).containsExactly("BUYER_CANCEL");
         assertThat(available()).isEqualTo(10);
…
         assertThatThrownBy(() -> commands.cancelByBuyer(BUYER, no)).isInstanceOf(ShopException.class)
                 .extracting(e -> ((ShopException) e).type()).isEqualTo(ProblemType.INVALID_STATE);   // ORD-4 AC-3
         commands.ship(SELLER, no, "黑貓宅急便", "TW-1");
+        stockFollows();
         assertThat(reservation(no)).isEqualTo("CONSUMED");
         assertThat(jdbc.queryForMap("SELECT on_hand, reserved FROM inventory WHERE product_id = ?", PRODUCT)).containsEntry("on_hand", 8).containsEntry("reserved", 0);
         assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM inventory_ledger WHERE product_id = ? AND reason = 'SHIP'", Long.class, PRODUCT)).isEqualTo(1);
         commands.confirmReceipt(BUYER, no);
         assertThat(status(no)).isEqualTo("COMPLETED");
-        assertThat(historyCount(no)).isEqualTo(5);                           // ORD-6 AC-6：下單、付款、撿貨、出貨、收貨
+        assertThat(historyCount(no)).isEqualTo(6);                           // ORD-6 AC-6：下單、付款、撿貨、出貨、收貨（13 站 4.5：下單是兩筆 —— RESERVING、RESERVED）
     }
 
     @Test @DisplayName("ORD-6 AC-4：出貨超過 7 天未確認 → 排程自動完成")
…
         while (jobs.cancelExpired() > 0) { }
         assertThat(status(unpaid)).isEqualTo("CANCELLED");
         assertThat(jdbc.queryForObject("SELECT cancel_reason FROM orders WHERE order_no = ?", String.class, unpaid)).isEqualTo("PAYMENT_TIMEOUT");
+        stockFollows();
         assertThat(reservation(unpaid)).isEqualTo("RELEASED");
         assertThat(status(paid)).isEqualTo("PAID");
         assertThat(reservation(paid)).isEqualTo("CONFIRMED");
```

**`src/test/java/com/example/shop/ordering/internal/OrderRaceRegressionTest.java`**

```diff
     @Autowired OrderTransitionService transitions;
     @Autowired Clock clock;
     @Autowired ShopProperties props;
+    @Autowired org.springframework.context.ApplicationContext ctx;
+
+    /** 13 站 4.6 的追記：預留跟著訂單的事件走（order.paid → 確認、order.cancelled → 釋放），讀預留之前先交付 */
+    void stockFollows(List<Long> ids) {
+        com.example.shop.support.InlineEvents.deliverTo(ctx, com.example.shop.support.InlineEvents.ofOrders(ids), "inventory.order-events");
+    }
 
     @BeforeEach
     void setUp() {
…
                     OrderTransitionService.EventData.NONE); return null; });
             go.countDown();
             for (Future<?> f : List.of(a, b)) { try { f.get(); } catch (ExecutionException e) { errors.add(e.getCause()); } }
+            stockFollows(List.of(id));
             outcomes.merge(jdbc.queryForObject("""
                     SELECT CONCAT(o.status, '/', r.status, '/', p.status, '/', (SELECT COUNT(*) FROM refunds f WHERE f.order_id = o.id))
                       FROM orders o JOIN inventory_reservations r ON r.order_id = o.id JOIN payments p ON p.order_id = o.id
…
         go.countDown();
         for (Future<?> f : fs) f.get();
         pool.shutdown();
+        stockFollows(jdbc.queryForList("SELECT id FROM orders WHERE buyer_id = ?", Long.class, BUYER));
         Long cancelled = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE buyer_id = ? AND status = 'CANCELLED'", Long.class, BUYER);
         Long histories = jdbc.queryForObject("""
                 SELECT COUNT(*) FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ? AND h.event = 'PAYMENT_TIMEOUT'""",
```

**`src/test/java/com/example/shop/ordering/internal/HotSettlementTest.java`**

```diff
     void cancelBeforeSettlement() {
         var o = place(BUYER);
         commands.cancelByBuyer(BUYER, o.orderNo());
+        deliver(o.orderId(), "order.cancelled");                            // 13 站 4.6：釋放是庫存模組收到 order.cancelled 才做的
         deliver(o.orderId(), "inventory.stock-returned");
         deliver(o.orderId(), "order.placed");                               // 遲到的落帳
         Map<String, Object> s = state(o.orderId());
…
                 .satisfies(e -> assertThat(((ShopException) e).type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE));
         deliver(o.orderId(), "order.placed");
         commands.ship(SELLER, o.orderNo(), "黑貓", "T-1");
+        deliver(o.orderId(), "order.shipped");                              // 13 站 4.6：出庫是庫存模組收到 order.shipped 才做的（order.paid 還沒交付：HELD 也出庫）
         Map<String, Object> inv = jdbc.queryForMap("SELECT on_hand, reserved FROM inventory WHERE product_id = ?", HOT);
         System.out.println("7.6.4 落帳之後出貨：" + inv + "；預留 " + state(o.orderId()).get("reservation"));
         assertThat(inv).containsEntry("on_hand", 4).containsEntry("reserved", 0);
```

**`src/test/java/com/example/shop/ordering/internal/OrderStateMachineTest.java`**

```diff
  */
 class OrderStateMachineTest {
 
-    static final List<OrderEvent> COLUMNS = List.of(OrderEvent.values());   // E1～E10，順序同 0.5.2（E10 是第 07 章加的，7.6.3）
+    static final List<OrderEvent> COLUMNS = List.of(OrderEvent.values());   // E1～E13，順序同 0.5.2（E10 是第 07 章加的，7.6.3；E11～E13 是 13 站 4.5 加的）
 
-    /** 0.5.3，逐字對照。最後一欄 E10（熱點落帳時庫存不足）是第 07 章加的（7.6.3） */
+    /**
+     * 0.5.3，逐字對照。E10（熱點落帳時庫存不足）是第 07 章加的（7.6.3）。
+     * 13 站 4.5：多兩列（RESERVING、REJECTED）、三欄（E11 RESERVED、E12 RESERVE_FAILED、E13 PLACEMENT_EXPIRED）
+     */
     static final String TABLE = """
-            #                 E1       E2  E3             E4  E5             E6         E7          E8           E9           E10
-            PENDING_PAYMENT   →PAID    ＝   →CANCELLED     →CANCELLED ✗     ✗          ✗           ✗            ·            →CANCELLED
-            PAID              ＝/↺     ＝   →CANCELLED+R   ·   →CANCELLED+R   →PICKING   ✗           ✗            ·            →CANCELLED+R
-            PICKING           ＝/↺     ＝   ✗              ·   →CANCELLED+R   ＝          →SHIPPED    ✗            ·            →CANCELLED+R
-            SHIPPED           ＝/↺     ＝   ✗              ·   ✗              ✗          ＝/✗        →COMPLETED   →COMPLETED   ·
-            COMPLETED         ＝/↺     ＝   ✗              ·   ✗              ✗          ✗           ＝            ·            ·
-            CANCELLED         ↺        ＝   ＝              ·   ＝              ✗          ✗           ✗            ·            ＝
+            #                 E1       E2  E3             E4  E5             E6         E7          E8           E9           E10            E11               E12         E13
+            PENDING_PAYMENT   →PAID    ＝   →CANCELLED     →CANCELLED ✗     ✗          ✗           ✗            ·            →CANCELLED     ＝                 ·           ·
+            PAID              ＝/↺     ＝   →CANCELLED+R   ·   →CANCELLED+R   →PICKING   ✗           ✗            ·            →CANCELLED+R   ＝                 ·           ·
+            PICKING           ＝/↺     ＝   ✗              ·   →CANCELLED+R   ＝          →SHIPPED    ✗            ·            →CANCELLED+R   ＝                 ·           ·
+            SHIPPED           ＝/↺     ＝   ✗              ·   ✗              ✗          ＝/✗        →COMPLETED   →COMPLETED   ·              ＝                 ·           ·
+            COMPLETED         ＝/↺     ＝   ✗              ·   ✗              ✗          ✗           ＝            ·            ·              ＝                 ·           ·
+            CANCELLED         ↺        ＝   ＝              ·   ＝              ✗          ✗           ✗            ·            ＝              ＝                 ·           ·
+            RESERVING         ✗        ＝   ✗              ·   ✗              ✗          ✗           ✗            ·            ·              →PENDING_PAYMENT   →REJECTED   →REJECTED
+            REJECTED          ↺        ＝   ✗              ·   ✗              ✗          ✗           ✗            ·            ·              ✗                 ＝           ＝
             """;
 
     record Cell(OrderStatus from, OrderEvent event, boolean same, String expected) {
…
     }
 
     @Test
-    void theTableHas60CellsAnd5ContextDependentOnes() {                    // 6 × 10（第 07 章加了 E10，7.6.3）
-        assertThat(cells().count()).isEqualTo(60 + 5);
+    void theTableHas104CellsAnd5ContextDependentOnes() {                   // 8 × 13（第 07 章加了 E10，7.6.3；13 站 4.5 加了兩列、三欄）
+        assertThat(cells().count()).isEqualTo(104 + 5);
     }
 
     @Test
     void terminalStatesNeverLeave() {                                        // 0.5.1：進入終態之後，沒有任何事件能讓它離開
-        for (OrderStatus terminal : List.of(OrderStatus.COMPLETED, OrderStatus.CANCELLED))
+        for (OrderStatus terminal : List.of(OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.REJECTED))   // 13 站 4.5：REJECTED 也是終態
             for (OrderEvent e : OrderEvent.values())
                 for (boolean same : new boolean[]{true, false})
                     assertThat(OrderStateMachine.decide(terminal, e, same).kind()).isNotEqualTo(Kind.TRANSITION);
```

**`src/test/java/com/example/shop/inventory/internal/remote/InventoryClientPactTest.java`**

```diff
                 .isInstanceOfSatisfying(InsufficientStockException.class, e -> assertThat(e.productId()).isEqualTo(9001L));
     }
 
+    /**
+     * 13 站 4.7.2：這張訂單的預留已經被補償掉了（order.rejected 先到，這一次預留晚到）—— 409，不是「已經預留過」。
+     * 13 站 4.6：「付款成功：確認預留」「出貨：扣庫存」「出貨：熱點還在落帳」三個互動拿掉了：訂單服務不再呼叫 …/confirm、…/consume
+     * （庫存服務自己收 order.paid、order.shipped）。庫存服務那一邊還是要通過它們 —— 線上那一版的契約裡有（InventoryProviderReleasedPactIT）。
+     * 出貨的兩個「不」（503、409）換到 …/shippable（只讀，下面三個互動）
+     */
     @Pact(consumer = "order-service")
-    RequestResponsePact confirm(PactDslWithProvider b) {
-        return b.given("訂單 7001 有一筆 HELD 的預留")
-                .uponReceiving("付款成功：確認預留").method("POST").path("/internal/inventory/v1/reservations/7001/confirm")
+    RequestResponsePact reserveCompensated(PactDslWithProvider b) {
+        return b.given("訂單 7005 的預留已經被補償（order.rejected）")
+                .uponReceiving("預留一張已經被補償的訂單").method("PUT").path("/internal/inventory/v1/reservations/7005")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
-                .willRespondWith().status(204).toPact();
+                .body("{\"lines\":[{\"productId\":9001,\"quantity\":1}],\"hotLines\":[]}", "application/json")
+                .willRespondWith().headers(PROBLEM).status(409)
+                .body(new PactDslJsonBody().stringValue("type", "/problems/invalid-state"))
+                .toPact();
     }
 
-    @Test @PactTestFor(pactMethod = "confirm")
-    void confirm(MockServer server) { api(server).confirm(7001L); }
-
-    @Pact(consumer = "order-service")
-    RequestResponsePact release(PactDslWithProvider b) {
-        return b.given("訂單 7001 有一筆 HELD 的預留")
-                .uponReceiving("取消：釋放預留").method("POST").path("/internal/inventory/v1/reservations/7001/release")
-                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
-                .willRespondWith().status(204).toPact();
+    @Test @PactTestFor(pactMethod = "reserveCompensated")
+    void reserveCompensated(MockServer server) {
+        assertThatThrownBy(() -> api(server).reserve(7005L, List.of(new ReserveLine(9001, 1)), List.of()))
+                .isInstanceOfSatisfying(ShopException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.INVALID_STATE));
     }
 
-    @Test @PactTestFor(pactMethod = "release")
-    void release(MockServer server) { api(server).release(7001L); }
+    // ───────── 13 站 4.6.3：出貨之前問一次 ─────────
 
     @Pact(consumer = "order-service")
-    RequestResponsePact consume(PactDslWithProvider b) {
+    RequestResponsePact shippable(PactDslWithProvider b) {
         return b.given("訂單 7003 的預留已確認")
-                .uponReceiving("出貨：扣庫存").method("POST").path("/internal/inventory/v1/reservations/7003/consume")
+                .uponReceiving("出貨之前：可以出貨").method("GET").path("/internal/inventory/v1/reservations/7003/shippable")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                 .willRespondWith().status(204).toPact();
     }
 
-    @Test @PactTestFor(pactMethod = "consume")
-    void consume(MockServer server) { api(server).consume(7003L); }
+    @Test @PactTestFor(pactMethod = "shippable")
+    void shippable(MockServer server) { api(server).checkShippable(7003L); }
 
     @Pact(consumer = "order-service")
-    RequestResponsePact consumeWhileSettling(PactDslWithProvider b) {
+    RequestResponsePact shippableWhileSettling(PactDslWithProvider b) {
         return b.given("訂單 7004 的熱點預留已確認、還沒落帳")
-                .uponReceiving("出貨：熱點還在落帳").method("POST").path("/internal/inventory/v1/reservations/7004/consume")
+                .uponReceiving("出貨之前：熱點還在落帳").method("GET").path("/internal/inventory/v1/reservations/7004/shippable")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                 .willRespondWith().headers(PROBLEM).status(503)
                 .body(new PactDslJsonBody().stringValue("type", "/problems/temporarily-unavailable").integerType("retryAfter", 5))
                 .toPact();
     }
 
-    @Test @PactTestFor(pactMethod = "consumeWhileSettling")
-    void consumeWhileSettling(MockServer server) {
-        assertThatThrownBy(() -> api(server).consume(7004L)).isInstanceOfSatisfying(ShopException.class, e -> {
+    @Test @PactTestFor(pactMethod = "shippableWhileSettling")
+    void shippableWhileSettling(MockServer server) {
+        assertThatThrownBy(() -> api(server).checkShippable(7004L)).isInstanceOfSatisfying(ShopException.class, e -> {
             assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE);
             assertThat(e.properties()).containsKey("retryAfter");
         });
     }
 
+    @Pact(consumer = "order-service")
+    RequestResponsePact shippableShort(PactDslWithProvider b) {
+        return b.given("訂單 7006 的熱點預留落帳時不夠，已經釋放")
+                .uponReceiving("出貨之前：庫存不足、即將取消").method("GET").path("/internal/inventory/v1/reservations/7006/shippable")
+                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
+                .willRespondWith().headers(PROBLEM).status(409)
+                .body(new PactDslJsonBody().stringValue("type", "/problems/invalid-state"))
+                .toPact();
+    }
+
+    @Test @PactTestFor(pactMethod = "shippableShort")
+    void shippableShort(MockServer server) {
+        assertThatThrownBy(() -> api(server).checkShippable(7006L))
+                .isInstanceOfSatisfying(ShopException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.INVALID_STATE));
+    }
+
     // ───────── 對帳 ─────────
 
+    /** 13 站 4.6：第 03 章是「取消：釋放預留」；取消之後的釋放改成事件，訂單服務只剩對帳會呼叫這一支 */
+    @Pact(consumer = "order-service")
+    RequestResponsePact release(PactDslWithProvider b) {
+        return b.given("訂單 7001 有一筆 HELD 的預留")
+                .uponReceiving("對帳：釋放沒有人要的預留").method("POST").path("/internal/inventory/v1/reservations/7001/release")
+                .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
+                .willRespondWith().status(204).toPact();
+    }
+
+    @Test @PactTestFor(pactMethod = "release")
+    void release(MockServer server) { api(server).releaseAbandoned(7001L); }
+
     @Pact(consumer = "order-service")
     RequestResponsePact activeReservations(PactDslWithProvider b) {
         return b.given("訂單 7001 有一筆 HELD 的預留，建立在 2026-01-01")
```

**`src/test/java/com/example/shop/inventory/internal/remote/RemoteInventoryApiTest.java`**

```diff
     void twoLostResponsesAre503() {
         script.add(new Object[]{204, 600L, null});
         script.add(new Object[]{204, 600L, null});
-        assertThatThrownBy(() -> inventory.confirm(42L)).isInstanceOfSatisfying(ShopException.class,
+        assertThatThrownBy(() -> inventory.releaseAbandoned(42L)).isInstanceOfSatisfying(ShopException.class,
                 e -> assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE));
         assertThat(seen).hasSize(2);
     }
 
-    @Test @DisplayName("對方的 409 庫存不足、503 → 同一個例外；對方的 401、404 → 系統錯誤")
+    @Test @DisplayName("對方的 409 庫存不足、409 狀態不對、503 → 同一個例外；對方的 401、404 → 系統錯誤")
     void translatesProblems() {
         script.add(new Object[]{409, 0L, "{\"type\":\"/problems/insufficient-stock\",\"title\":\"庫存不足\",\"status\":409,\"detail\":\"商品 7 的可售庫存不足\",\"productId\":7}"});
         assertThatThrownBy(() -> inventory.reserve(1L, List.of(new ReserveLine(7, 1)), List.of()))
                 .isInstanceOfSatisfying(InsufficientStockException.class, e -> assertThat(e.productId()).isEqualTo(7L));
-        script.add(new Object[]{503, 0L, "{\"type\":\"/problems/temporarily-unavailable\",\"title\":\"服務暫時無法使用\",\"status\":503,\"detail\":\"還在落帳\",\"retryAfter\":5}"});
-        assertThatThrownBy(() -> inventory.consume(1L)).isInstanceOfSatisfying(ShopException.class, e -> {
+        // 13 站 4.7.2：這張訂單的預留已經被補償掉了
+        script.add(new Object[]{409, 0L, "{\"type\":\"/problems/invalid-state\",\"title\":\"目前的狀態不允許這個動作\",\"status\":409,\"detail\":\"訂單 2 的預留已經取消，不能再預留\",\"orderId\":2}"});
+        assertThatThrownBy(() -> inventory.reserve(2L, List.of(new ReserveLine(7, 1)), List.of()))
+                .isInstanceOfSatisfying(ShopException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.INVALID_STATE));
+        script.add(new Object[]{503, 0L, "{\"type\":\"/problems/temporarily-unavailable\",\"title\":\"服務暫時無法使用\",\"status\":503,\"detail\":\"Redis 暫時無法使用\",\"retryAfter\":5}"});
+        assertThatThrownBy(() -> inventory.gateHot(List.of(new ReserveLine(1, 1)))).isInstanceOfSatisfying(ShopException.class, e -> {
             assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE);
             assertThat(e.properties()).containsEntry("retryAfter", 5);
         });
         script.add(new Object[]{401, 0L, "{\"type\":\"/problems/unauthenticated\",\"title\":\"需要登入\",\"status\":401,\"detail\":\"服務的 token 無效或已過期\"}"});
-        assertThatThrownBy(() -> inventory.release(1L)).isInstanceOf(IllegalStateException.class).hasMessageContaining("401");
+        assertThatThrownBy(() -> inventory.releaseAbandoned(1L)).isInstanceOf(IllegalStateException.class).hasMessageContaining("401");
         script.add(new Object[]{404, 0L, "{\"type\":\"/problems/not-found\",\"title\":\"找不到資源\",\"status\":404}"});
         assertThatThrownBy(() -> inventory.setHot(1L, true)).isInstanceOf(IllegalStateException.class).hasMessageContaining("404");
     }
…
 
     @Test @DisplayName("token 快取起來：連續兩次呼叫用同一個")
     void cachesTheToken() {
-        inventory.confirm(1L);
-        inventory.confirm(2L);
+        inventory.releaseAbandoned(1L);
+        inventory.releaseAbandoned(2L);
         List<Seen> calls = List.copyOf(seen);
         assertThat(calls.get(0).authorization()).isEqualTo(calls.get(1).authorization());
     }
```

**`src/test/java/com/example/shop/inventory/internal/web/InventoryProviderContract.java`**

```diff
     @State("訂單 7004 的熱點預留已確認、還沒落帳")
     void unsettled7004() { clean(); stock(9005, 10, 0); reservation(7004, 9005, "CONFIRMED", false, null); }
 
+    /** 13 站 4.7.2：補償先到 —— processed_messages 裡已經有這張訂單的預留那一列（releaseRejected 佔的），預留一筆都沒有 */
+    @State("訂單 7005 的預留已經被補償（order.rejected）")
+    void compensated7005() {
+        clean();
+        stock(9001, 10, 0);
+        jdbc.update("INSERT INTO processed_messages (consumer, message_id) VALUES ('inventory.http.reserve', '7005')");
+    }
+
+    /** 13 站 4.6.3：落帳發現不夠 → 那一列 RELEASED（取消的事件還在路上） */
+    @State("訂單 7006 的熱點預留落帳時不夠，已經釋放")
+    void short7006() { clean(); stock(9005, 0, 0); reservation(7006, 9005, "RELEASED", false, null); }
+
     @State("商品 9005 是熱點，閘門有 10 件")
     void gate10() { clean(); stock(9005, 10, 0); redis.opsForValue().set("stock:9005", "10"); }
 
```

**`src/test/java/com/example/shop/api/IdorMatrixTest.java`**

```diff
             "DELETE /api/cart/items/{productId}", "同上",
             "POST /api/admin/users/{id}/roles", "管理員對任何帳號都可以操作（0.3.2），不是資料層級的權限",
             "POST /api/admin/users/{id}/suspend", "同上",
-            "POST /api/admin/dead-letters/{consumer}/replay", "{consumer} 是佇列的名字，不是誰的資源；管理員的維運動作（7.5.5）");
+            "POST /api/admin/dead-letters/{consumer}/replay", "{consumer} 是佇列的名字，不是誰的資源；管理員的維運動作（7.5.5）",
+            "GET /api/admin/orders/{orderNo}/saga", "13 站 4.9：管理員看任何一張訂單的 Saga（維運），不是資料層級的權限");
 
     @Autowired MockMvc mvc;
     @Autowired JdbcTemplate jdbc;
```

**`src/test/java/com/example/shop/acceptance/CapstoneAcceptanceTest.java`**

```diff
     }
 
     @Test
-    @DisplayName("Q1 一筆訂單的交易邊界：下單失敗時，訂單、明細、庫存異動三張表都沒有殘留")
+    @DisplayName("Q1 一筆訂單的交易邊界：下單失敗時，沒有成立的訂單、庫存異動沒有殘留（13 站 4.5：留下一張 REJECTED）")
     void q1_transactionBoundary() throws Exception {
         long buyer = 990_001, a = 9_900_101, b = 9_900_102;
         try (var ctx = startApp()) {
…
 
                 // US-ORD-1 AC-5：A 有貨、B 沒貨 —— 先預留的 A（product_id 較小）必須跟著 rollback
                 Http r = placeOrder(port, buyer, "q1-key", "[{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}, {\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]".formatted(a, b));
+                // 13 站 4.5 的追記：下單是一個 Saga 之後，「三張表都沒有殘留」不再成立 —— 訂單在預留之前就寫下了（RESERVING），
+                // 預留失敗之後變成 REJECTED，連同它的明細留在表上，買家看不到它（OrderRepository）。不變的是：沒有一張「成立的」訂單、
+                // 庫存那一邊什麼都沒留下、冪等鍵放掉了、購物車沒有被清
                 Map<String, Object> residue = jdbc.queryForMap("""
-                        SELECT (SELECT COUNT(*) FROM orders WHERE buyer_id = ?)                                  AS orders,
-                               (SELECT COUNT(*) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?) AS items,
+                        SELECT (SELECT COUNT(*) FROM orders WHERE buyer_id = ? AND status NOT IN ('RESERVING', 'REJECTED')) AS orders,
+                               (SELECT COUNT(*) FROM order_items i JOIN orders o ON o.id = i.order_id
+                                 WHERE o.buyer_id = ? AND o.status NOT IN ('RESERVING', 'REJECTED'))                     AS items,
+                               (SELECT GROUP_CONCAT(status) FROM orders WHERE buyer_id = ?)                       AS statuses,
                                (SELECT COUNT(*) FROM inventory_reservations WHERE product_id IN (?, ?))          AS reservations,
                                (SELECT reserved FROM inventory WHERE product_id = ?)                              AS reserved_a,
                                (SELECT CONCAT(COUNT(*), '/', SUM(delta_reserved)) FROM inventory_ledger WHERE product_id = ?) AS ledger_a,
                                (SELECT COUNT(*) FROM idempotency_keys WHERE buyer_id = ?)                         AS idem_keys,
                                (SELECT COUNT(*) FROM cart_items WHERE buyer_id = ?)                               AS cart""",
-                        buyer, buyer, a, b, a, a, buyer, buyer);
+                        buyer, buyer, buyer, a, b, a, a, buyer, buyer);
                 System.out.println("Q1：HTTP " + r.status() + " " + r.type() + "，productId=" + r.between("\"productId\":", "}") + "；殘留：" + residue
                         + "（庫存帳下單前 " + ledgerBefore + "）");
                 assertThat(r.status()).isEqualTo(409);
                 assertThat(r.type()).isEqualTo("/problems/insufficient-stock");
-                assertThat(residue).containsEntry("orders", 0L).containsEntry("items", 0L).containsEntry("reservations", 0L)
+                assertThat(residue).containsEntry("orders", 0L).containsEntry("items", 0L).containsEntry("statuses", "REJECTED").containsEntry("reservations", 0L)
                         .containsEntry("reserved_a", 0).containsEntry("idem_keys", 0L).containsEntry("cart", 2L);
                 assertThat(residue.get("ledger_a")).isEqualTo(ledgerBefore);
 
```

**`src/test/java/com/example/shop/schema/SchemaConstraintTest.java`**

```diff
                 "INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason) VALUES (900001, 5, 0, 'FIX')"),
         new Case("庫存帳不可寫一筆「什麼都沒變」", INVENTORY,
                 "INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason) VALUES (900001, 0, 0, 'RESTOCK')"),
-        new Case("訂單狀態只能是 0.5 的六個值", "",
-                ORDER.replace("'PENDING_PAYMENT'", "'REFUNDED'")),
+        // 13 站 4.5：「訂單狀態只能是 0.5 的六個值」拿掉了 —— ck_orders_status 改成 NOT ENFORCED（換一個會檢查的 CHECK 要整表複製、期間不能下單）。
+        // 這一道防線是刻意放掉的：orderStatusCheckIsDeliberatelyNotEnforced
         new Case("已取消的訂單必須有取消原因", ORDER, "UPDATE orders SET status = 'CANCELLED' WHERE id = 900001"),
         new Case("未取消的訂單不可有取消原因", ORDER, "UPDATE orders SET cancel_reason = 'BUYER' WHERE id = 900001"),
         new Case("已付款的訂單必須有 paid_at", ORDER, "UPDATE orders SET status = 'PAID' WHERE id = 900001"),
…
         }
         assertThat(leaked).as("這些規則資料庫沒擋住").isEmpty();
     }
+
+    /**
+     * 13 站 4.5：訂單狀態的 CHECK 是刻意 NOT ENFORCED 的 —— 換一個會檢查的 CHECK 要整張 orders 複製一次、期間不能下單（4.5.6）。
+     * 狀態的值暫時只靠 OrderStatus 與狀態機守。這個測試讓「資料庫不再擋」這件事寫在測試裡：要改回 ENFORCED（另一次停機維護），這裡跟著改
+     */
+    @Test
+    void orderStatusCheckIsDeliberatelyNotEnforced() {
+        String enforced = jdbc.queryForObject("""
+                SELECT enforced FROM information_schema.table_constraints
+                 WHERE table_schema = DATABASE() AND table_name = 'orders' AND constraint_name = 'ck_orders_status'""", String.class);
+        String clause = jdbc.queryForObject("""
+                SELECT check_clause FROM information_schema.check_constraints
+                 WHERE constraint_schema = DATABASE() AND constraint_name = 'ck_orders_status'""", String.class);
+        System.out.println("13 站 4.5：ck_orders_status ENFORCED = " + enforced + "；" + clause);
+        assertThat(enforced).isEqualTo("NO");
+        assertThat(clause).contains("RESERVING").contains("REJECTED");
+    }
 }
```

**`src/test/java/com/example/shop/shared/messaging/internal/ServiceRoleConsumersTest.java`**

```diff
 
     @Autowired List<EventHandler> handlers;
 
-    @Test @DisplayName("13 站 3.7：monolith 收 6 個；order-service、inventory-service 各收自己的 3 個，合起來剛好 6 個、沒有重複")
+    /** 13 站 4.6：多了 inventory.order-events（庫存模組收訂單的事件）—— 它在庫存模組，所以在庫存服務收 */
+    @Test @DisplayName("13 站 3.7：monolith 收 7 個；order-service 收 3 個、inventory-service 收 4 個，合起來剛好 7 個、沒有重複")
     void eachRoleConsumesOnlyItsOwnModules() {
         Map<ServiceRole, List<String>> got = new TreeMap<>();
         for (ServiceRole role : ServiceRole.values())
             got.put(role, RabbitConsumers.owned(handlers, role).stream().map(EventHandler::consumer).sorted().toList());
         got.forEach((role, consumers) -> System.out.printf("13 站 3.7：%-17s 收 %s%n", role.serviceName(), consumers));
 
-        assertThat(got.get(ServiceRole.MONOLITH)).hasSize(6);
+        assertThat(got.get(ServiceRole.MONOLITH)).hasSize(7);
         assertThat(got.get(ServiceRole.ORDER_SERVICE)).containsExactly("notification.order-events", "ordering.stock-shortage", "payment.refunds");
-        assertThat(got.get(ServiceRole.INVENTORY_SERVICE)).containsExactly("inventory.hot-settlement", "inventory.hot-stock-return", "inventory.product-created");
+        assertThat(got.get(ServiceRole.INVENTORY_SERVICE)).containsExactly("inventory.hot-settlement", "inventory.hot-stock-return", "inventory.order-events",
+                "inventory.product-created");
         List<String> both = new ArrayList<>(got.get(ServiceRole.ORDER_SERVICE));
         both.addAll(got.get(ServiceRole.INVENTORY_SERVICE));
         assertThat(both).as("切開之後，每一個消費者剛好在一個服務裡").containsExactlyInAnyOrderElementsOf(got.get(ServiceRole.MONOLITH));
```

**`src/test/java/com/example/shop/ordering/internal/CancelRefundSnapshotTest.java`**

```diff
 import static org.assertj.core.api.Assertions.assertThat;
 
 /**
- * 專題寫完之後（13 站第 01 章練習三的推論）：買家取消與金流回呼「幾乎同時」到。
+ * 專題寫完之後（13 站第 01 章 1.6.7 的推論）：買家取消與金流回呼「幾乎同時」到。
  *
  * 取消的交易：① 第一句讀（OrderAccess.buyers，一般的 SELECT）→ InnoDB 在這裡建立這個交易的一致性讀快照
  *            ② 條件式 UPDATE orders … WHERE status = 'PENDING_PAYMENT' → 0 列（回呼已經把它改成 PAID 了）
```

（同一個理由：第 01 章的練習三搬進了 1.6.7。照著第 01 章課文寫的程式碼，這一行本來就是 1.6.7。）

**`src/test/java/com/example/shop/support/InlineEvents.java`**

```diff
 
     /** 交付符合條件的事件；handler 又寫了新事件（例如落帳失敗 → 取消 → order.cancelled）也會一起交付，直到沒有新的。回傳交付了幾個事件 */
     public static int deliver(ApplicationContext ctx, Predicate<OutboxStore.Row> which) {
+        return deliver(ctx, which, h -> true);
+    }
+
+    /**
+     * 13 站 4.6：只交給這幾個消費者（例如 inventory.order-events —— 付款、取消、出貨之後的庫存）。
+     * 第 12 站的測試在付款、取消、出貨之後直接讀預留的狀態；改成事件之後要先交付，但不需要順便寄通知信
+     */
+    public static int deliverTo(ApplicationContext ctx, Predicate<OutboxStore.Row> which, String... consumers) {
+        List<String> only = List.of(consumers);
+        return deliver(ctx, which, h -> only.contains(h.consumer()));
+    }
+
+    static int deliver(ApplicationContext ctx, Predicate<OutboxStore.Row> which, Predicate<EventHandler> to) {
         JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
         ObjectMapper json = ctx.getBean(ObjectMapper.class);
         EventDispatcher dispatcher = ctx.getBean(EventDispatcher.class);
-        Map<String, EventHandler> handlers = ctx.getBeansOfType(EventHandler.class);
+        Map<String, EventHandler> handlers = new java.util.LinkedHashMap<>(ctx.getBeansOfType(EventHandler.class));
+        handlers.values().removeIf(to.negate());
         TransactionTemplate tx = new TransactionTemplate(ctx.getBean(PlatformTransactionManager.class));
         int delivered = 0;
         for (int round = 0; round < 10; round++) {
```

`src/test/resources/openapi/shop-api.json` 是 `OpenApiContractTest` 產生的快照：只有新增（一支路由、`SagaView`、`SagaStep`、`SagaEvent`、`SagaReservation` 四個元件），沒有任何一行被改或刪。

### 4.11.2 追記：改了、新增的檔案

📌 **第 04 章寫完之後的追記**（4.2.2、4.6.3、4.10.6、4.10.7、第 02 章 2.8.4 ④、第 03 章 3.8.6）接在同一個分支後面：

```
shop/                                                              ← 分支 d04，接著上面那一版往後加
├── compose.yaml                                                   ← pact-broker（--profile contracts；3.8.6）
├── scripts/d04-contracts.sh                                       ← + 發布、驗證、can-i-deploy（3.8.6）
├── src/main/java/com/example/shop/ordering/internal/OrderCommands.java ← 4.6.3 的追記：PAST_SHIPPING
└── src/test/java/com/example/shop/
    ├── ordering/internal/ShipCheckOutsideTxTest.java              ← + 4.6.3 的追記
    ├── dist04/E7BrokenTransactionsAgainTest.java                  ← + 4.10.6（實驗）
    ├── dist04/E8HotGateHoleTest.java                              ← + 4.2.2 的追記（實驗）
    ├── dist04/E9FourCostsAgainTest.java、TraceTap.java             ← + 4.10.7（實驗）
    ├── dist02/Ops.java                                            ← public（E7 要用）
    ├── dist02/C4DataMigrationTest.java                            ← 2.8.4 ④ 的追記：triggerCostOnly
    ├── inventory/internal/OrderEventsPactTest.java                ← + 3.8.6：庫存服務讀的六則事件
    ├── inventory/internal/remote/InventoryClientPactTest.java      ← 3.8.6：V3 → V4
    ├── inventory/internal/web/InventoryProviderContract.java       ← 3.8.6：事件的 target
    ├── inventory/internal/web/InventoryEventMessages.java          ← + 3.8.6
    ├── inventory/internal/web/InventoryProviderBrokerIT.java       ← + 3.8.6（不在預設的建置裡）
    ├── ordering/internal/InventoryEventsPactTest.java              ← + 3.8.6：訂單服務讀的那一則
    ├── ordering/internal/OrderEventMessages.java、OrderEventsProviderContract.java ← + 3.8.6
    └── ordering/internal/OrderEventsProviderPactIT.java、OrderEventsProviderBrokerIT.java ← + 3.8.6
```

正式程式碼只改了一個檔案（`OrderCommands`）。**沒有新的 migration、沒有改任何一支 API 的回應** —— 只有一個行為：賣家對一張還沒撿貨的訂單按出貨，現在先問庫存一次，熱點還在落帳時拿到的是 503 而不是 409（4.6.3 的追記）。

完整跑一次：

```bash
mvn clean verify
```

```
TEST_INFRA testcontainers 啟動 11,993 ms：mysql jdbc:mysql://localhost:62636/shop、redis localhost:62628、rabbitmq localhost:62635
TEST_INFRA MySQL 最多同時 31 條連線（max_connections 151）
[INFO] Tests run: 331, Failures: 0, Errors: 0, Skipped: 0
TEST_INFRA testcontainers 啟動 10,706 ms：mysql jdbc:mysql://localhost:64310/shop、redis localhost:64300、rabbitmq localhost:64306
TEST_INFRA MySQL 最多同時 5 條連線（max_connections 151）
[INFO] Tests run: 38, Failures: 0, Errors: 0, Skipped: 0
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  05:39 min
```

**331 個測試**：上面那一次的 322 個，加上 `ShipCheckOutsideTxTest` 2 個、事件契約的呼叫端 7 個（`OrderEventsPactTest` 6 個、`InventoryEventsPactTest` 1 個）。**failsafe 那一段 38 個**：這一次建置的 HTTP 契約與事件 17 個（16 + 1）、線上那一版 15 個、訂單服務的事件 6 個。`*BrokerIT` 不在裡面（3.8.6：要 broker，`scripts/d04-contracts.sh verify` 才跑）。

追記途中只跑過受影響的那幾個測試（`ShipCheckOutsideTxTest`、契約的三個呼叫端、三個 `*PactIT`）與實驗；這是追記之後第一次、也是唯一一次整套的 verify，跑在最後一個 commit 上（E7、E8、E9 的最後一輪也是）。

#### 新增的檔案

正文已經完整列出的：`InventoryProviderBrokerIT`、`scripts/d04-contracts.sh`（3.8.6）。改了幾行、正文列過 diff 的：`OrderCommands`（4.6.3）、`InventoryProviderContract`、`compose.yaml`（3.8.6）。其餘：

**`src/test/java/com/example/shop/ordering/internal/ShipCheckOutsideTxTest.java`**（4.6.3 的追記）

```java
package com.example.shop.ordering.internal;

import com.example.shop.cart.CartApi;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReservationRef;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.events.Outbox;
import com.example.shop.support.InlineEvents;
import com.example.shop.support.TestInfra;
import com.example.shop.support.TestRedis;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 4.6.3 的追記：出貨之前的那一次 checkShippable 在交易之外 —— 4.6.3 的推論說「問完之後，能讓答案變回去的只有取消，
 * 而取消與出貨由狀態機的條件式 UPDATE 排隊」。這裡用 latch 把兩個窗口釘住：
 *   ① 問完、出貨的交易之前，賣家取消（庫存模組也收到 order.cancelled、釋放了）
 *   ② ship() 讀狀態、決定「要不要問」之後，同一張訂單開始撿貨 —— 4.6.3 的推論沒有想到的那一個窗口
 * 兩個窗口各用一個掛勾：PausingInventory 在 checkShippable 回來之後停；PausingTransitions 在 ship() 第一次讀狀態之後停。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
@Import(ShipCheckOutsideTxTest.Pausing.class)
class ShipCheckOutsideTxTest {

    static final long PRODUCT = 9_900_871, HOT = 9_900_872, SELLER = 2, BUYER = 990_871;

    /** 下一次 checkShippable 回來之後、下一次 current() 讀完之後要做的事（只做一次） */
    static final AtomicReference<Runnable> afterCheck = new AtomicReference<>(), afterRead = new AtomicReference<>();

    @TestConfiguration
    static class Pausing {
        @Bean @Primary
        InventoryApi pausingInventory(@Qualifier("jdbcInventoryService") InventoryApi real) { return new PausingInventory(real); }

        @Bean @Primary
        OrderTransitionService pausingTransitions(JdbcTemplate jdbc, CartApi cart, IdempotencyKeys keys, PaymentApi payments, OrderHistory history,
                                                  Outbox outbox, Clock clock, MeterRegistry meters) {
            return new PausingTransitions(jdbc, cart, keys, payments, history, outbox, clock, meters);
        }
    }

    static class PausingTransitions extends OrderTransitionService {
        PausingTransitions(JdbcTemplate jdbc, CartApi cart, IdempotencyKeys keys, PaymentApi payments, OrderHistory history, Outbox outbox,
                           Clock clock, MeterRegistry meters) {
            super(jdbc, cart, keys, payments, history, outbox, clock, meters);
        }

        @Override
        Current current(long orderId) {
            Current c = super.current(orderId);
            run(afterRead);
            return c;
        }
    }

    record PausingInventory(InventoryApi real) implements InventoryApi {
        @Override public void checkShippable(long orderId) { real.checkShippable(orderId); run(afterCheck); }
        @Override public void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) { real.reserve(orderId, lines, hotLines); }
        @Override public void restock(long productId, int quantity, String note) { real.restock(productId, quantity, note); }
        @Override public void gateHot(List<ReserveLine> hotLines) { real.gateHot(hotLines); }
        @Override public void returnHot(List<ReserveLine> hotLines) { real.returnHot(hotLines); }
        @Override public void setHot(long productId, boolean hot) { real.setHot(productId, hot); }
        @Override public int availableForDisplay(long productId, boolean hot) { return real.availableForDisplay(productId, hot); }
        @Override public int available(long productId) { return real.available(productId); }
        @Override public Map<Long, Integer> available(Collection<Long> productIds) { return real.available(productIds); }
        @Override public List<ReservationRef> activeReservations(long afterId, Instant createdBefore, int limit) { return real.activeReservations(afterId, createdBefore, limit); }
        @Override public Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds) { return real.reservationsOf(orderIds); }
        @Override public void releaseAbandoned(long orderId) { real.releaseAbandoned(orderId); }
    }

    static void run(AtomicReference<Runnable> hook) {
        Runnable r = hook.getAndSet(null);
        if (r != null) r.run();
    }

    @Autowired OrderingApi ordering;
    @Autowired OrderCommands commands;
    @Autowired PaymentCallbackService callbacks;
    @Autowired ShopProperties props;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired ApplicationContext ctx;

    @BeforeEach
    void setUp() {
        cleanup();
        InlineEvents.skipBacklog(ctx);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '出貨測試', 100.00, 'ON_SALE')", PRODUCT, SELLER);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '出貨測試（熱點）', 100.00, 'ON_SALE', TRUE)", HOT, SELLER);
        for (long p : List.of(PRODUCT, HOT)) {
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 5, 0)", p);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 5, 0, 'INITIAL', 'ship-check-test')", p);
        }
    }

    @AfterEach
    void cleanup() {
        afterCheck.set(null);
        afterRead.set(null);
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id = ?", BUYER);
        for (long id : jdbc.queryForList("SELECT id FROM orders WHERE buyer_id = ?", Long.class, BUYER))
            jdbc.update("DELETE FROM processed_messages WHERE consumer = 'inventory.http.reserve' AND message_id = ?", String.valueOf(id));
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        for (long p : List.of(PRODUCT, HOT)) {
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", p);
            TestInfra.adminJdbc().update("DELETE FROM inventory_ledger WHERE product_id = ?", p);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", p);
            jdbc.update("DELETE FROM products WHERE id = ?", p);
            TestRedis.forgetProducts(redis, p);
        }
    }

    /** 一張一般 + 熱點的訂單，付款成功 */
    OrderingApi.PlacedOrder paidOrder() {
        var o = ordering.placeOrder(BUYER, "ship-" + System.nanoTime(), List.of(
                new OrderingApi.OrderLine(PRODUCT, 1, new BigDecimal("100")), new OrderingApi.OrderLine(HOT, 1, new BigDecimal("100"))));
        long pid = commands.startPayment(BUYER, o.orderNo()).paymentId();
        BigDecimal a = new BigDecimal("200.00");
        String txn = "ship-" + System.nanoTime();
        callbacks.handle(new PaymentApi.Callback(pid, txn, a, true, CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(pid, txn, a, true))));
        return o;
    }

    void inventoryFollows(long orderId, String... types) {
        List<String> only = List.of(types);
        InlineEvents.deliverTo(ctx, r -> r.aggregateId() == orderId && only.contains(r.eventType()),
                "inventory.order-events", "inventory.hot-settlement", "inventory.hot-stock-return");
    }

    /** 背景執行緒出貨；hook 把它停在想要的那一點，主執行緒在那裡做另一件事，再放它走 */
    CompletableFuture<Object> shipPausedAt(AtomicReference<Runnable> hook, String orderNo, CountDownLatch paused, CountDownLatch go) {
        hook.set(() -> {
            paused.countDown();
            try {
                if (!go.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("等不到放行");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        return CompletableFuture.supplyAsync(() -> {
            try {
                return commands.ship(SELLER, orderNo, "黑貓", "SC-" + orderNo);
            } catch (RuntimeException e) {
                return e;
            }
        });
    }

    Map<String, Object> state(long orderId) {
        return jdbc.queryForMap("""
                SELECT o.status,
                       (SELECT GROUP_CONCAT(CONCAT(r.status, IF(r.counted, '', '（未落帳）')) ORDER BY r.product_id) FROM inventory_reservations r WHERE r.order_id = o.id) AS reservations,
                       (SELECT GROUP_CONCAT(i.on_hand ORDER BY i.product_id) FROM inventory i WHERE i.product_id IN (?, ?)) AS on_hand,
                       (SELECT GROUP_CONCAT(event_type ORDER BY id) FROM outbox_events WHERE aggregate_type = 'ORDER' AND aggregate_id = o.id) AS events
                  FROM orders o WHERE o.id = ?""", PRODUCT, HOT, orderId);
    }

    static String outcome(Object r) {
        return r instanceof ShopException e ? e.type() + "「" + e.getMessage() + "」" : r instanceof RuntimeException e ? e.toString() : "出貨成功";
    }

    @Test @DisplayName("4.6.3 ①：問完、出貨的交易之前，賣家取消、庫存釋放 → 出貨 409（狀態機），什麼都沒出庫")
    void cancelBetweenCheckAndShip() throws Exception {
        var o = paidOrder();
        inventoryFollows(o.orderId(), "order.placed", "order.paid");          // 熱點落帳、確認：問的時候兩筆都是 CONFIRMED、已落帳
        commands.startPicking(SELLER, o.orderNo());
        CountDownLatch paused = new CountDownLatch(1), go = new CountDownLatch(1);
        CompletableFuture<Object> ship = shipPausedAt(afterCheck, o.orderNo(), paused, go);
        assertThat(paused.await(10, TimeUnit.SECONDS)).as("出貨停在「問完」之後").isTrue();
        commands.cancelBySeller(SELLER, o.orderNo());
        inventoryFollows(o.orderId(), "order.cancelled", "inventory.stock-returned");
        Map<String, Object> between = state(o.orderId());
        go.countDown();
        Object r = ship.get(10, TimeUnit.SECONDS);
        System.out.println("4.6.3 ① 問完之後取消：窗口裡 " + between + "；出貨 → " + outcome(r) + "；之後 " + state(o.orderId()));
        assertThat(r).isInstanceOfSatisfying(ShopException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.INVALID_STATE));
        assertThat(state(o.orderId())).containsEntry("status", "CANCELLED").containsEntry("reservations", "RELEASED,RELEASED")
                .containsEntry("on_hand", "5,5");
        assertThat((String) state(o.orderId()).get("events")).doesNotContain("order.shipped");
    }

    @Test @DisplayName("4.6.3 ②：ship() 讀到 PAID（還沒撿貨）之後，撿貨開始 —— 熱點還沒落帳，出貨要被擋下（503），不能因為「讀到的不是 PICKING」就不問")
    void pickingStartsBetweenReadAndShip() throws Exception {
        var o = paidOrder();                                                 // 熱點的那一筆還沒落帳（order.placed 沒有交付）
        CountDownLatch paused = new CountDownLatch(1), go = new CountDownLatch(1);
        CompletableFuture<Object> ship = shipPausedAt(afterRead, o.orderNo(), paused, go);
        assertThat(paused.await(10, TimeUnit.SECONDS)).as("出貨停在讀完狀態之後").isTrue();
        commands.startPicking(SELLER, o.orderNo());
        Map<String, Object> between = state(o.orderId());
        go.countDown();
        Object r = ship.get(10, TimeUnit.SECONDS);
        Map<String, Object> after = state(o.orderId());
        System.out.println("4.6.3 ② 讀完狀態之後撿貨：窗口裡 " + between + "；出貨 → " + outcome(r) + "；之後 " + after);
        if (!(r instanceof RuntimeException)) {                               // 沒擋下：讓庫存模組照常收到 order.shipped，看它出了什麼
            jdbc.update("UPDATE inventory SET on_hand = 0 WHERE product_id = ?", HOT);   // 而那一件熱點，其實不存在（Redis 放進了 MySQL 沒有的庫存）
            inventoryFollows(o.orderId(), "order.placed", "order.paid", "order.shipped");
            System.out.println("4.6.3 ② 沒擋下的話：庫存模組收到 order.shipped 之後 " + state(o.orderId()));
        }
        assertThat(r).isInstanceOfSatisfying(ShopException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE));
        assertThat(after).containsEntry("status", "PICKING");
    }
}
```

**`src/test/java/com/example/shop/dist04/E7BrokenTransactionsAgainTest.java`**（4.10.6）

```java
package com.example.shop.dist04;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Ops;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist03.Flow;
import com.example.shop.dist03.Roles;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.util.AopTestUtils;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.PrintStream;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 13 站第 04 章寫完之後的追記：第 02 章 2.5.3 的 C2，換成這一章的 Saga 再跑一次。同一個失敗的注入（Ops 的 trigger：寫訂單狀態歷史的那一句被拒絕），
 * 同樣的六個情境、同樣的「下一步」—— 差別只在部署：兩個服務用正式的角色（第 03 章）、事件走 RabbitMQ，每一步之後等事件都送完（Flow.quiet）再看兩個庫。
 * 第 02 章的時候，那一句被拒絕 = 「庫存服務已經 commit、訂單服務 rollback」；這一章之後，訂單服務的交易裡已經沒有遠端呼叫了。
 *
 *   mvn test -Pexperiments -Dtest=E7BrokenTransactionsAgainTest
 */
@Tag("experiment")
class E7BrokenTransactionsAgainTest {

    final PrintStream out = System.out;
    Ops ops;
    ConfigurableApplicationContext order, inv;
    long nextProduct = SplitLab.FIRST_PRODUCT, nextBuyer = 870_001;

    @Test
    void brokenTransactionsOnTheSaga() throws Exception {
        Split.freshDatabases();
        Broker.freshVhost();
        try (ConfigurableApplicationContext i = Roles.inventoryService(Broker.args());
             ConfigurableApplicationContext o = Roles.orderService(i, Broker.args())) {
            order = o;
            inv = i;
            ops = new Ops(o);
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Ops.exec(Split.INV_DB, "UPDATE inventory SET on_hand = 100");
            ops.installTrigger();
            out.printf("═══ 第 02 章 2.5.3 的六個情境，換成 Saga：訂單服務的交易在最後一句失敗，事件走 RabbitMQ（load %s）═══%n", SplitLab.load());
            out.println("  情境                         │ 回應 │ 訂單            │ 預留       │ 庫存 on_hand / reserved │ 付款 / 退款單");

            // ── 下單：T3（RESERVED → PENDING_PAYMENT）寫歷史的那一句失敗 ──
            long buyer = buyer(), p = product();
            String key = UUID.randomUUID().toString();
            ops.fail(buyer, null, "PENDING_PAYMENT");
            show("S1 下單", ops.placeStatus(buyer, key, new String[1], p), buyer, p);
            ops.unfail();
            show("   同一個鍵重送", ops.placeStatus(buyer, key, new String[1], p), buyer, p);

            // ── 付款回呼 ──
            buyer = buyer(); p = product();
            String o2 = ops.place(buyer, p);
            Map<String, Object> cb = ops.callback(buyer, o2);
            ops.fail(0, o2, "PAID");
            show("S2 付款回呼", ops.post("/api/payments/callback", null, cb), buyer, p);
            ops.unfail();
            show("   金流重送同一個回呼", ops.post("/api/payments/callback", null, cb), buyer, p);

            // ── 買家取消（已付款）──
            buyer = buyer(); p = product();
            String o3 = paid(buyer, p);
            ops.fail(0, o3, "CANCELLED");
            show("S3 買家取消（已付款）", ops.post("/api/orders/" + o3 + "/cancel", ops.bearer(buyer), null), buyer, p);
            ops.unfail();
            show("   買家再按一次取消", ops.post("/api/orders/" + o3 + "/cancel", ops.bearer(buyer), null), buyer, p);

            buyer = buyer(); p = product();
            String o3b = paid(buyer, p);
            ops.fail(0, o3b, "CANCELLED");
            show("S3' 買家取消（已付款）", ops.post("/api/orders/" + o3b + "/cancel", ops.bearer(buyer), null), buyer, p);
            ops.unfail();
            show("   賣家沒注意到，開始撿貨", ops.post("/api/seller/orders/" + o3b + "/start-picking", ops.seller(), null), buyer, p);
            show("   出貨", ops.post("/api/seller/orders/" + o3b + "/ship", ops.seller(), Map.of("carrier", "黑貓", "trackingNo", "E7-" + o3b)), buyer, p);

            // ── 出貨 ──
            buyer = buyer(); p = product();
            String o4 = picking(buyer, p);
            ops.fail(0, o4, "SHIPPED");
            show("S4 出貨", ops.post("/api/seller/orders/" + o4 + "/ship", ops.seller(), Map.of("carrier", "黑貓", "trackingNo", "E7-" + o4)), buyer, p);
            ops.unfail();
            show("   賣家再按一次出貨", ops.post("/api/seller/orders/" + o4 + "/ship", ops.seller(), Map.of("carrier", "黑貓", "trackingNo", "E7-" + o4)), buyer, p);

            buyer = buyer(); p = product();
            String o4b = picking(buyer, p);
            ops.fail(0, o4b, "SHIPPED");
            show("S4' 出貨", ops.post("/api/seller/orders/" + o4b + "/ship", ops.seller(), Map.of("carrier", "黑貓", "trackingNo", "E7-" + o4b)), buyer, p);
            ops.unfail();
            show("   賣家以為沒出成，改成取消", ops.post("/api/seller/orders/" + o4b + "/cancel", ops.seller(), null), buyer, p);

            // ── 逾時排程 ──
            buyer = buyer(); p = product();
            String o5 = ops.place(buyer, p);
            Ops.exec(Split.ORDER_DB, "UPDATE orders SET payment_deadline = NOW(3) - INTERVAL 1 MINUTE WHERE order_no = '" + o5 + "'");
            ops.fail(0, o5, "CANCELLED");
            cancelExpired();
            show("S5 逾時排程", 0, buyer, p);
            ops.unfail();
            cancelExpired();
            show("   排程的下一輪", 0, buyer, p);

            long b1 = buyer(), p1 = product(), b2 = buyer(), p2 = product();
            String first = ops.place(b1, p1), second = ops.place(b2, p2);
            Ops.exec(Split.ORDER_DB, "UPDATE orders SET payment_deadline = NOW(3) - INTERVAL 2 MINUTE WHERE order_no = '" + first + "'");
            Ops.exec(Split.ORDER_DB, "UPDATE orders SET payment_deadline = NOW(3) - INTERVAL 1 MINUTE WHERE order_no = '" + second + "'");
            ops.fail(0, first, "CANCELLED");
            ops.last = "";
            cancelExpired();
            show("S5' 逾時排程：第一張（失敗）", 0, b1, p1);
            show("    第二張（沒有注入失敗）", 0, b2, p2);
            if (!ops.last.isEmpty()) out.println("      " + ops.last);
            ops.unfail();

            Ops.exec(Split.ORDER_DB, "DROP TRIGGER d02_fail_after_remote");
            out.printf("  對帳（ReservationReconciliation）：%s%n", reconcile());
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    long buyer() { return nextBuyer++; }
    long product() { return nextProduct++; }

    /** Ops.paid / picking 之後，庫存服務要收到 order.paid 才是 CONFIRMED —— 等事件送完，下一步才從同一個起點開始 */
    String paid(long buyer, long product) throws Exception { String no = ops.paid(buyer, product); settle(); return no; }
    String picking(long buyer, long product) throws Exception { String no = ops.picking(buyer, product); settle(); return no; }

    void settle() throws Exception {
        Flow.quiet(List.of(order, inv), List.of(Split.ORDER_DB, Split.INV_DB), 60_000);
    }

    void cancelExpired() {
        Object jobs = AopTestUtils.getUltimateTargetObject(order.getBean("orderJobs"));
        try {
            ReflectionTestUtils.invokeMethod(jobs, "cancelExpired");
        } catch (Exception e) {
            Throwable t = e;
            while (t.getCause() != null) t = t.getCause();
            ops.last = "排程丟出例外：" + t;
        }
    }

    /** 對帳跑一輪（第 02 章 2.6.4），grace 0：剛建立的預留也看 —— 這個實驗的每一筆都是幾秒之內建立的 */
    String reconcile() {
        Object r = AopTestUtils.getUltimateTargetObject(order.getBean("reservationReconciliation"));
        return String.valueOf((Object) ReflectionTestUtils.invokeMethod(r, "run", java.time.Duration.ZERO));
    }

    /** 等事件送完，再看兩個庫各剩下什麼：這位買家的訂單、這個商品的預留與庫存、付款與退款單 */
    void show(String label, int status, long buyer, long product) throws Exception {
        settle();
        String orders, reservations, inventory, payments;
        List<Long> ids = new ArrayList<>();
        try (Connection c = SplitLab.root(Split.ORDER_DB); Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT id, status FROM orders WHERE buyer_id = " + buyer + " ORDER BY id")) {
            List<String> s = new ArrayList<>();
            while (rs.next()) { ids.add(rs.getLong(1)); s.add(rs.getString(2)); }
            orders = s.isEmpty() ? "（不存在）" : String.join(",", s);
        }
        try (Connection c = SplitLab.root(Split.ORDER_DB); Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("""
                     SELECT (SELECT GROUP_CONCAT(p.status) FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = %d),
                            (SELECT COUNT(*) FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = %d)"""
                     .formatted(buyer, buyer))) {
            rs.next();
            payments = (rs.getString(1) == null ? "—" : rs.getString(1)) + " / " + rs.getInt(2);
        }
        try (Connection c = SplitLab.root(Split.INV_DB); Statement st = c.createStatement()) {
            try (ResultSet rs = st.executeQuery("SELECT order_id, status FROM inventory_reservations WHERE product_id = " + product + " ORDER BY id")) {
                List<String> r = new ArrayList<>();
                while (rs.next()) r.add(rs.getString(2) + (ids.contains(rs.getLong(1)) ? "" : "（沒有訂單）"));
                reservations = r.isEmpty() ? "（沒有）" : String.join(",", r);
            }
            try (ResultSet rs = st.executeQuery("SELECT on_hand, reserved FROM inventory WHERE product_id = " + product)) {
                rs.next();
                inventory = rs.getInt(1) + " / " + rs.getInt(2);
            }
        }
        out.printf("  %-28s │ %4s │ %-15s │ %-10s │ %-23s │ %s%n", label, status == 0 ? "—" : String.valueOf(status), orders, reservations, inventory, payments);
    }
}
```

**`src/test/java/com/example/shop/dist04/E8HotGateHoleTest.java`**（4.2.2 的追記）

```java
package com.example.shop.dist04;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist03.Roles;
import com.example.shop.dist03.Shop;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站 4.2.2 的追記：熱點閘門的那一個洞（閘門扣了之後、訂單寫下之前，訂單服務當掉）—— 4.5.2 說「最後一道防線是熱點對帳（第 12 站 6.6）」，
 * 4.2.2 的 E1 卻把庫存的排程關了。這裡把它打開（預設：每分鐘一輪、同一組不一致連續兩輪才修），量它多久補回來：
 *   ① 安靜的時候：A 在閘門之後被 kill -9，之後沒有人買這個商品
 *   ② 搶購進行中：B 每秒收 10 張這個商品的訂單；A 在閘門之後被 kill -9；3 分鐘之後搶購停下來
 * 每秒看一次「MySQL 算出來的值 − Redis」（差）。正常的時候，差 = 還在路上的訂單（閘門扣了、預留還沒寫）；當掉的那一件，會讓差一直多 1。
 *
 *   mvn test -Pexperiments -Dtest=E8HotGateHoleTest
 */
@Tag("experiment")
class E8HotGateHoleTest {

    static final int A_PORT = 18481, B_PORT = 18482;
    static final List<String> QUIET = List.of("--shop.order.reservation-check-interval=1h");

    final PrintStream out = System.out;

    @Test
    void reconciliationClosesTheHole() throws Exception {
        out.printf("═══ 4.2.2 的追記：熱點閘門的洞，熱點對帳（每分鐘一輪、連續兩輪才修）多久補回來（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        Broker.freshVhost();
        CrashPoint.reset();
        Nodes.flushRedis(Split.ORDER_REDIS);
        List<String> invArgs = new ArrayList<>(Broker.args());
        invArgs.addAll(List.of("--lab.d04.crash-point=true", "--shop.inventory.jobs-enabled=true"));
        try (ConfigurableApplicationContext inv = Roles.inventoryService(invArgs);
             OrderNode a = OrderNode.start("e8a", A_PORT, SplitLab.port(inv), Nodes.with(Broker.args(), QUIET));
             OrderNode b = OrderNode.start("e8b", B_PORT, SplitLab.port(inv), Nodes.with(Broker.args(), QUIET))) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Shop toA = new Shop(inv, a::port), toB = new Shop(inv, b::port);
            StringRedisTemplate redis = inv.getBean(StringRedisTemplate.class);
            MeterRegistry meters = inv.getBean(MeterRegistry.class);
            long hot1 = SplitLab.FIRST_PRODUCT, hot2 = hot1 + 1;
            toB.hot(hot1);
            toB.hot(hot2);
            toB.placeOk(7_480_000L, hot1);                                  // 閘門建起來
            toB.placeOk(7_480_000L, hot2);

            // ── ① 安靜的時候 ──
            out.println("  ① 安靜的時候：A 在閘門扣了 1 件之後被 kill -9，之後沒有人買這個商品");
            CrashPoint.arm("POST", "/hot-gate", a::kill);
            out.println("     買家送到 A → " + E1CrashTest.attempt(toA, 7_480_001L, UUID.randomUUID().toString(), hot1));
            long t0 = System.nanoTime();
            double drift0 = drift(meters);
            List<String> series = new ArrayList<>();
            long fixedAt = -1;
            for (int s = 0; s <= 240; s++) {
                long gap = Nodes.gateBase(hot1) - Long.parseLong(redis.opsForValue().get("stock:" + hot1));
                if (s % 10 == 0) series.add(s + "s:" + gap);
                if (gap == 0) { fixedAt = (System.nanoTime() - t0) / 1_000_000_000; break; }
                Thread.sleep(1_000);
            }
            out.printf("     差（MySQL 算出來 − Redis），每 10 秒：%s%n", String.join(" ", series));
            out.printf("     補回來：%s；shop.inventory.hot.drift +%.0f%n", fixedAt < 0 ? "240 秒內沒有" : fixedAt + " 秒", drift(meters) - drift0);

            // ── ② 搶購進行中 ──
            out.println("  ② 搶購進行中：B 每秒收 10 張這個商品的訂單；A 在閘門扣了 1 件之後被 kill -9");
            out.printf("     A 重新起來（%,d ms）%n", a.boot(Nodes.with(Broker.args(), QUIET)));
            AtomicBoolean running = new AtomicBoolean(true), paused = new AtomicBoolean(false);
            AtomicInteger placed = new AtomicInteger(), failed = new AtomicInteger();
            AtomicLong nextBuyer = new AtomicLong(7_481_000L);
            Thread traffic = new Thread(() -> {
                long next = System.nanoTime();
                while (running.get()) {
                    next += 100_000_000L;
                    if (!paused.get()) {
                        try {
                            Shop.Res r = toB.place(nextBuyer.getAndIncrement(), UUID.randomUUID().toString(), hot2);
                            if (r.status() == 201) placed.incrementAndGet(); else failed.incrementAndGet();
                        } catch (Exception e) {
                            failed.incrementAndGet();
                        }
                    }
                    long sleep = (next - System.nanoTime()) / 1_000_000;
                    if (sleep > 0) try { Thread.sleep(sleep); } catch (InterruptedException e) { return; }
                }
            });
            traffic.start();
            Thread.sleep(20_000);                                           // 先跑 20 秒：看正常的時候差是多少
            List<String> before = new ArrayList<>();
            for (int s = 0; s < 10; s++) { before.add(String.valueOf(gap(redis, hot2))); Thread.sleep(1_000); }
            out.printf("     搶購進行中、還沒當掉：差每秒 %s（還在路上的訂單）%n", String.join(" ", before));
            paused.set(true);                                               // CrashPoint 只看 method 與路徑：停一下，讓 A 的那一個請求是下一個打 /hot-gate 的
            Thread.sleep(300);
            CrashPoint.arm("POST", "/hot-gate", a::kill);
            out.println("     買家送到 A → " + E1CrashTest.attempt(toA, 7_480_002L, UUID.randomUUID().toString(), hot2));
            paused.set(false);
            drift0 = drift(meters);
            t0 = System.nanoTime();
            List<String> busy = new ArrayList<>();
            int minGap = Integer.MAX_VALUE;
            for (int s = 1; s <= 180; s++) {
                Thread.sleep(1_000);
                int g = gap(redis, hot2);
                minGap = Math.min(minGap, g);
                if (s % 10 == 0) busy.add(s + "s:" + g);
            }
            out.printf("     當掉之後 3 分鐘，差每 10 秒：%s%n", String.join(" ", busy));
            out.printf("     這 3 分鐘裡差最小 %d；shop.inventory.hot.drift +%.0f；B 收了 %,d 張（失敗 %d）%n", minGap, drift(meters) - drift0, placed.get(), failed.get());
            running.set(false);
            traffic.join();
            Nodes.quiet(inv, 30_000);
            long stop = System.nanoTime();
            List<String> after = new ArrayList<>();
            fixedAt = -1;
            for (int s = 0; s <= 240; s++) {
                int g = gap(redis, hot2);
                if (s % 10 == 0) after.add(s + "s:" + g);
                if (g == 0) { fixedAt = (System.nanoTime() - stop) / 1_000_000_000; break; }
                Thread.sleep(1_000);
            }
            out.printf("     搶購停下來之後，差每 10 秒：%s%n", String.join(" ", after));
            out.printf("     補回來：%s（當掉之後 %d 秒）；shop.inventory.hot.drift +%.0f%n", fixedAt < 0 ? "240 秒內沒有" : "停下來之後 " + fixedAt + " 秒",
                    (System.nanoTime() - t0) / 1_000_000_000, drift(meters) - drift0);
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    static int gap(StringRedisTemplate redis, long product) throws Exception {
        return (int) (Nodes.gateBase(product) - Long.parseLong(redis.opsForValue().get("stock:" + product)));
    }

    static double drift(MeterRegistry meters) {
        return meters.counter("shop.inventory.hot.drift").count();
    }
}
```

**`src/test/java/com/example/shop/dist04/E9FourCostsAgainTest.java`**（4.10.7）

```java
package com.example.shop.dist04;

import com.example.shop.ShopApplication;
import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.LostResponse;
import com.example.shop.dist03.Roles;
import com.example.shop.support.TestTokens;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站第 04 章寫完之後的追記：第 00 章 0.2 的四個代價，在「真的線」上重跑。第 00 章的 K1～K5 用的是那一章的實驗支架
 * （LabInventoryService：一支 POST /lab/inventory/reserve，只有預留與可售量走 HTTP）；第 01、02 章照舊用它重跑，第 03、04 章沒有 ——
 * 那時候正式程式碼已經有自己的線了（第 03 章：/internal/inventory/v1、服務的 token、冪等、重試一次；第 04 章：Saga）。
 * 這裡用正式的角色（第 03 章 3.7）重做同樣四件事，參數照第 00 章：
 *   K1 延遲：單體 vs 切開，一張一張送（1、3、10 個品項）、16 條執行緒同時送 3 個品項
 *   K2 一致性：① 預留之後的那一步失敗 × 100（第 00 章：reserve() 之後、下單交易 commit 之前；這一章之後：T3 寫歷史的那一句）
 *              ② 庫存服務 commit 之後慢 1.5 秒才回應、訂單服務只等 1 秒；之後同一個鍵重送
 *   K3 級聯：每秒 20 張下單，庫存服務預留之後慢 3 秒（訂單服務等 10 秒，照第 00 章），看「我的訂單」與連線池
 *   K5 traceId：同一張訂單，訂單服務的 traceId、庫存服務收到的 traceparent、庫存服務日誌的 traceId
 *
 *   mvn test -Pexperiments -Dtest=E9FourCostsAgainTest
 */
@Tag("experiment")
class E9FourCostsAgainTest {

    static final String MONO_DB = "shop_d04_mono";
    static final int MONO_REDIS = 11, INV_PORT = 18491;
    static final AtomicLong BUYERS = new AtomicLong(7_900_000);
    static final long FAIL_BUYER = 777_777;

    final PrintStream out = System.out;

    record Target(String name, ConfigurableApplicationContext ctx) {}
    record Res(int status, long nanos, String body, String traceId) {}
    record Probe(long atMs, String what, int status, long nanos) {}

    @Test
    void fourCostsAgain() throws Exception {
        k1();
        k2k3k5();
    }

    // ───────── K1 ─────────

    void k1() throws Exception {
        SplitLab.freshDatabase(MONO_DB);
        Split.freshDatabases();
        Nodes.flushRedis(MONO_REDIS);
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        try (OrderNode inv = OrderNode.inventory("e9-inventory", INV_PORT, List.of());
             ConfigurableApplicationContext m = new SpringApplicationBuilder(ShopApplication.class).run(SplitLab.common(MONO_DB, MONO_REDIS).toArray(String[]::new));
             ConfigurableApplicationContext o = new SpringApplicationBuilder(ShopApplication.class)
                     .run(Split.override(Roles.orderArgs(INV_PORT), List.of("--shop.order.jobs-enabled=false")).toArray(String[]::new))) {
            SplitLab.seed(MONO_DB, true, true);
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            List<Target> targets = List.of(new Target("單體", m), new Target("切開", o));

            out.printf("═══ K1（0.2.1）一張一張送：每格 3 輪 × 100 張、交錯（load %s）═══%n", SplitLab.load());
            for (Target t : targets) for (int i = 0; i < 100; i++) place(t.ctx(), BUYERS.incrementAndGet(), 3, null, null);   // 熱身
            Map<String, List<Long>> lat = new TreeMap<>();
            for (int round = 0; round < 3; round++)
                for (int items : new int[]{1, 3, 10})
                    for (Target t : targets)
                        for (int i = 0; i < 100; i++) {
                            Res r = place(t.ctx(), BUYERS.incrementAndGet(), items, null, null);
                            if (r.status() != 201) throw new IllegalStateException(t.name() + " " + r.status() + " " + r.body());
                            lat.computeIfAbsent(items + "|" + t.name(), k -> new ArrayList<>()).add(r.nanos());
                        }
            for (int items : new int[]{1, 3, 10}) {
                List<Long> a = lat.get(items + "|單體"), b = lat.get(items + "|切開");
                out.printf("  %2d 個品項 │ 單體 p50 %6.2f ms p99 %7.2f ms │ 切開 p50 %6.2f ms p99 %7.2f ms │ p50 差 %+6.2f ms%n",
                        items, pct(a, 50), pct(a, 99), pct(b, 50), pct(b, 99), pct(b, 50) - pct(a, 50));
            }

            out.printf("═══ K1（0.2.1）16 條執行緒同時送 3 個品項的訂單：每格 3 輪 × 5 秒、交錯（load %s）═══%n", SplitLab.load());
            Map<String, long[]> done = new TreeMap<>();
            Map<String, List<Long>> tl = new TreeMap<>();
            Map<String, Long> bad = new TreeMap<>();
            for (int round = 0; round < 3; round++)
                for (Target t : targets) {
                    List<Long> nanos = java.util.Collections.synchronizedList(new ArrayList<>());
                    AtomicLong failed = new AtomicLong();
                    done.computeIfAbsent(t.name(), k -> new long[3])[round] = load(t.ctx(), 16, 5_000, nanos, failed);
                    tl.computeIfAbsent(t.name(), k -> new ArrayList<>()).addAll(nanos);
                    bad.merge(t.name(), failed.get(), Long::sum);
                }
            for (Target t : targets)
                out.printf("  %s │ 每秒 %s 張 │ p50 %6.2f ms │ p99 %7.2f ms │ 不是 201 的 %d 張%n", t.name(),
                        String.join(" / ", Arrays.stream(done.get(t.name())).mapToObj(x -> String.format("%,d", x / 5)).toList()),
                        pct(tl.get(t.name()), 50), pct(tl.get(t.name()), 99), bad.get(t.name()));
        }
    }

    // ───────── K2、K3、K5：兩個服務都在這個 JVM（LostResponse、TraceTap 是 static 的）─────────

    void k2k3k5() throws Exception {
        Split.freshDatabases();
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        com.example.shop.dist03.Broker.freshVhost();
        LostResponse.reset();
        TraceTap.reset();
        // 事件走 RabbitMQ（第 03 章 D4 的做法）：K2 ① 的補償是 order.rejected → 庫存服務釋放
        try (ConfigurableApplicationContext inv = Roles.inventoryService(Nodes.with(com.example.shop.dist03.Broker.args(),
                List.of("--lab.d03.lost-response=true", "--lab.d04.trace-tap=true")))) {
            SplitLab.seed(Split.INV_DB, false, true);
            try (ConfigurableApplicationContext impatient = Roles.orderService(inv, Nodes.with(com.example.shop.dist03.Broker.args(),
                    List.of("--shop.deployment.inventory.read-timeout=1s", "--shop.order.placement-timeout=5s")))) {
                SplitLab.seed(Split.ORDER_DB, true, false);
                k2(impatient, inv);
                k5(impatient);
            }
            // K3 照第 00 章：relay 關著（第 00 章沒有事件）、訂單服務等 10 秒
            try (ConfigurableApplicationContext patient = Roles.orderService(inv, List.of("--shop.deployment.inventory.read-timeout=10s"))) {
                k3(patient);
            }
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    void k2(ConfigurableApplicationContext order, ConfigurableApplicationContext inv) throws Exception {
        try (Connection c = SplitLab.root(Split.ORDER_DB); Statement st = c.createStatement()) {
            st.execute("""
                    CREATE TRIGGER e9_fail_after_reserve BEFORE INSERT ON order_status_history FOR EACH ROW
                    BEGIN
                      IF NEW.to_status = 'PENDING_PAYMENT' AND (SELECT buyer_id FROM orders WHERE id = NEW.order_id) = 777777 THEN
                        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'e9: injected failure after reserve';
                      END IF;
                    END""");
        }
        out.printf("═══ K2（0.2.2）① 預留之後的那一步失敗（T3 寫歷史的那一句）：100 張（load %s）═══%n", SplitLab.load());
        long r0 = reserved(), o0 = orphans();
        Map<Integer, Integer> codes = new TreeMap<>();
        String sample = null;
        for (int i = 0; i < 100; i++) {
            Res r = place(order, FAIL_BUYER, 3, null, null);
            codes.merge(r.status(), 1, Integer::sum);
            if (sample == null) sample = r.body();
        }
        out.printf("  失敗之後 │ 回應 %s │ 這位買家的訂單 %s │ 沒有訂單的預留 +%d 列 │ reserved +%d 件%n",
                codes, statuses(FAIL_BUYER), orphans() - o0, reserved() - r0);
        out.println("           第一個回應：" + sample);
        long t0 = System.nanoTime();
        int expired = 0;
        Thread.sleep(5_500);                                                // placement-timeout 5 秒
        Object jobs = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(order.getBean("orderJobs"));
        Integer n;
        while ((n = org.springframework.test.util.ReflectionTestUtils.invokeMethod(jobs, "expirePlacements")) != null && n > 0) expired += n;
        Nodes.quiet(inv, 30_000);
        com.example.shop.dist03.Flow.quiet(List.of(order, inv), List.of(Split.ORDER_DB, Split.INV_DB), 60_000);
        out.printf("  排程補償 │ 收了 %d 張（%,d ms 之後）│ 這位買家的訂單 %s │ 沒有訂單的預留 +%d 列 │ reserved +%d 件%n",
                expired, (System.nanoTime() - t0) / 1_000_000, statuses(FAIL_BUYER), orphans() - o0, reserved() - r0);

        out.printf("═══ K2（0.2.2）② 庫存服務 commit 之後慢 1.5 秒才回應，訂單服務只等 1 秒：20 張（load %s）═══%n", SplitLab.load());
        LostResponse.arm("PUT", "/reservations/", 1_500, 40);               // 每一張兩次（重試一次）
        r0 = reserved(); o0 = orphans();
        long ordersBefore = SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM orders WHERE status NOT IN ('RESERVING', 'REJECTED')");
        // ⚠️ 第一版重送時又隨機挑了 3 個商品（第 00 章的 K2 也是）：同一個鍵、不同的內容 → 422 × 20。第 00 章的時候鍵在失敗時就放掉了，
        // 內容不同也是一張新的訂單，看不出差別；這一章之後鍵綁著那張 RESERVING 的訂單。真的客戶端重送的是同一個請求 —— 記下商品
        List<long[]> sent = new ArrayList<>();
        List<String> keys = new ArrayList<>();
        codes = new TreeMap<>();
        sample = null;
        for (int i = 0; i < 20; i++) {
            long buyer = BUYERS.incrementAndGet();
            String key = UUID.randomUUID().toString();
            long[] ids = products(3);
            sent.add(new long[]{buyer, ids[0], ids[1], ids[2]});
            keys.add(key);
            Res r = place(order, buyer, ids, key, null);
            codes.merge(r.status(), 1, Integer::sum);
            if (sample == null) sample = r.body();
        }
        out.printf("  第一次送   │ 回應 %s │ 訂單（買家看得到的）+%d 張 │ 沒有訂單的預留 +%d 列 │ reserved +%d 件%n", codes,
                SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM orders WHERE status NOT IN ('RESERVING', 'REJECTED')") - ordersBefore, orphans() - o0, reserved() - r0);
        out.println("             第一個回應：" + sample);
        LostResponse.reset();
        codes = new TreeMap<>();
        for (int i = 0; i < 20; i++) {
            long[] s = sent.get(i);
            codes.merge(place(order, s[0], new long[]{s[1], s[2], s[3]}, keys.get(i), null).status(), 1, Integer::sum);
        }
        out.printf("  同一個鍵重送 │ 回應 %s │ 訂單（買家看得到的）+%d 張 │ 沒有訂單的預留 +%d 列 │ reserved +%d 件%n", codes,
                SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM orders WHERE status NOT IN ('RESERVING', 'REJECTED')") - ordersBefore, orphans() - o0, reserved() - r0);
    }

    void k5(ConfigurableApplicationContext order) throws Exception {
        out.printf("═══ K5（0.2.4）同一張訂單，兩個服務的 traceId（load %s）═══%n", SplitLab.load());
        TraceTap.reset();
        Res r = place(order, BUYERS.incrementAndGet(), 1, null, null);
        out.printf("  訂單服務 │ %d，X-Trace-Id %s%n", r.status(), r.traceId());
        for (TraceTap.Seen s : TraceTap.SEEN)
            out.printf("  庫存服務 │ %s %s │ 收到的 traceparent=%s │ 日誌的 traceId %s%n", s.method(), s.path(), s.traceparent(), s.mdcTraceId());
    }

    void k3(ConfigurableApplicationContext order) throws Exception {
        MeterRegistry meters = order.getBean(MeterRegistry.class);
        for (int i = 0; i < 300; i++) place(order, BUYERS.incrementAndGet(), 3, null, null);   // 暖機
        long probeBuyer = 4_242_424;
        for (int i = 0; i < 5; i++) place(order, probeBuyer, 1, null, null);
        out.printf("═══ K3（0.2.3）庫存服務變慢：訂單服務的其他 API 怎麼了（每秒 20 張下單、訂單服務等 10 秒；load %s）═══%n", SplitLab.load());
        long t0 = System.nanoTime();
        AtomicBoolean stop = new AtomicBoolean();
        ConcurrentLinkedQueue<Probe> orders = new ConcurrentLinkedQueue<>(), probes = new ConcurrentLinkedQueue<>();
        ExecutorService load = Executors.newVirtualThreadPerTaskExecutor();
        java.util.concurrent.atomic.AtomicInteger inFlight = new java.util.concurrent.atomic.AtomicInteger();
        Thread sender = new Thread(() -> {
            for (long i = 0; !stop.get(); i++) {
                long due = t0 + i * 50_000_000L;
                long wait = due - System.nanoTime();
                if (wait > 0) try { Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000)); } catch (InterruptedException e) { return; }
                long sentAt = (System.nanoTime() - t0) / 1_000_000;
                load.submit(() -> {
                    inFlight.incrementAndGet();
                    Res r = place(order, BUYERS.incrementAndGet(), 3, null, null);
                    inFlight.decrementAndGet();
                    orders.add(new Probe(sentAt, "order", r.status(), r.nanos()));
                });
            }
        });
        sender.start();
        Thread prober = new Thread(() -> {
            while (!stop.get()) {
                long at = (System.nanoTime() - t0) / 1_000_000;
                SplitLab.Result d = SplitLab.get(order, "/api/products/" + SplitLab.FIRST_PRODUCT, 0);
                probes.add(new Probe(at, "detail", d.status(), d.nanos()));
                at = (System.nanoTime() - t0) / 1_000_000;
                SplitLab.Result o = SplitLab.get(order, "/api/orders", probeBuyer);
                probes.add(new Probe(at, "myorders", o.status(), o.nanos()));
                try { Thread.sleep(200); } catch (InterruptedException e) { return; }
            }
        });
        prober.start();
        List<String> pool = new ArrayList<>();
        String[] phase = {"正常", "慢 3 秒", "恢復"};
        for (int p = 0; p < 3; p++) {
            if (p == 1) LostResponse.arm("PUT", "/reservations/", 3_000, Integer.MAX_VALUE);
            if (p == 2) LostResponse.reset();
            for (int s = 0; s < 20; s++) {
                Thread.sleep(1_000);
                pool.add(String.format("%3d 秒 %-5s active %2.0f pending %3.0f │ 還沒回應的下單 %3d", (System.nanoTime() - t0) / 1_000_000_000L, phase[p],
                        meters.get("hikaricp.connections.active").gauge().value(), meters.get("hikaricp.connections.pending").gauge().value(),
                        inFlight.get()));
            }
        }
        stop.set(true);
        sender.join();
        prober.join();
        load.shutdown();
        load.awaitTermination(60, TimeUnit.SECONDS);
        LostResponse.reset();
        for (int p = 0; p < 3; p++) {
            long from = p * 20_000L, to = from + 20_000L;
            for (String what : new String[]{"order", "detail", "myorders"}) {
                var src = what.equals("order") ? orders : probes;
                List<Probe> in = src.stream().filter(x -> x.what().equals(what) && x.atMs() >= from && x.atMs() < to).toList();
                long[] s = in.stream().mapToLong(Probe::nanos).sorted().toArray();
                Map<Integer, Integer> codes = new TreeMap<>();
                in.forEach(x -> codes.merge(x.status(), 1, Integer::sum));
                out.printf("  %-5s │ %-8s │ %4d 次 │ p50 %8.1f ms │ p99 %8.1f ms │ max %8.1f ms │ %s%n", phase[p],
                        Map.of("order", "下單", "detail", "商品詳情", "myorders", "我的訂單").get(what), in.size(),
                        SplitLab.pct(s, 50), SplitLab.pct(s, 99), SplitLab.pct(s, 100), codes);
            }
        }
        out.println("  連線池、還沒回應的下單（每秒）：");
        for (String line : pool) out.println("    " + line);
    }

    // ───────── 共用 ─────────

    static long reserved() throws Exception { return SplitLab.count(Split.INV_DB, "SELECT COALESCE(SUM(reserved), 0) FROM inventory"); }

    static long orphans() throws Exception {
        return SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM " + Split.INV_DB + ".inventory_reservations r WHERE NOT EXISTS (SELECT 1 FROM "
                + Split.ORDER_DB + ".orders o WHERE o.id = r.order_id)");
    }

    static String statuses(long buyer) throws Exception {
        return Nodes.one(Split.ORDER_DB, "SELECT CONCAT('{', GROUP_CONCAT(CONCAT(status, '=', n) ORDER BY status), '}') FROM "
                + "(SELECT status, COUNT(*) AS n FROM orders WHERE buyer_id = " + buyer + " GROUP BY status) x", "{}");
    }

    /** n 個不同的商品（隨機） */
    static long[] products(int n) {
        return ThreadLocalRandom.current().longs(0, SplitLab.PRODUCTS).distinct().limit(n).map(i -> SplitLab.FIRST_PRODUCT + i).toArray();
    }

    /** 一張 n 個品項的訂單（隨機挑 n 個不同的商品），走 HTTP。回傳狀態碼、奈秒、回應、X-Trace-Id */
    static Res place(ConfigurableApplicationContext ctx, long buyer, int items, String key, String traceparent) {
        return place(ctx, buyer, products(items), key, traceparent);
    }

    static Res place(ConfigurableApplicationContext ctx, long buyer, long[] ids, String key, String traceparent) {
        String body = "{\"items\":[" + String.join(",", Arrays.stream(ids).mapToObj(id -> "{\"productId\":" + id + ",\"quantity\":1,\"unitPrice\":100.00}").toList()) + "]}";
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + SplitLab.port(ctx) + "/api/orders"))
                .timeout(Duration.ofSeconds(30)).header("Content-Type", "application/json")
                .header("Authorization", TestTokens.bearer(ctx, buyer)).header("Idempotency-Key", key == null ? UUID.randomUUID().toString() : key)
                .POST(HttpRequest.BodyPublishers.ofString(body));
        if (traceparent != null) b.header("traceparent", traceparent);
        long t0 = System.nanoTime();
        try {
            HttpResponse<String> r = SplitLab.CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
            return new Res(r.statusCode(), System.nanoTime() - t0, r.body().length() > 220 ? r.body().substring(0, 220) + "…" : r.body(),
                    r.headers().firstValue("X-Trace-Id").orElse("—"));
        } catch (Exception e) {
            return new Res(-1, System.nanoTime() - t0, e.toString(), "—");
        }
    }

    static long load(ConfigurableApplicationContext ctx, int threads, long millis, List<Long> nanos, AtomicLong bad) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        AtomicLong ok = new AtomicLong();
        long end = System.nanoTime() + millis * 1_000_000L;
        List<java.util.concurrent.Future<?>> fs = new ArrayList<>();
        for (int i = 0; i < threads; i++)
            fs.add(pool.submit(() -> {
                while (System.nanoTime() < end) {
                    Res r = place(ctx, BUYERS.incrementAndGet(), 3, null, null);
                    if (r.status() == 201) { ok.incrementAndGet(); nanos.add(r.nanos()); } else bad.incrementAndGet();
                }
                return null;
            }));
        for (var f : fs) f.get();
        pool.shutdown();
        return ok.get();
    }

    static double pct(List<Long> nanos, double p) {
        return SplitLab.pct(nanos.stream().mapToLong(Long::longValue).sorted().toArray(), p);
    }
}
```

**`src/test/java/com/example/shop/dist04/TraceTap.java`**（4.10.7 的 K5）

```java
package com.example.shop.dist04;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.apache.catalina.connector.Request;
import org.apache.catalina.connector.Response;
import org.apache.catalina.valves.ValveBase;
import org.slf4j.MDC;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * 13 站第 04 章寫完之後的追記（E9 的 K5）：庫存服務收到的 traceparent，以及它的日誌用的是哪一個 traceId。
 * 第 12 站 9.8 的 TraceFilters 在最前面（HIGHEST_PRECEDENCE）把外面帶進來的 trace header 藏起來 —— 排在它前面的 filter 寫不出來（同一個 order），
 * 所以「收到什麼」在 Tomcat 的 valve 讀（valve 在所有 servlet filter 之前）；「日誌用哪一個」在最後面的 filter 讀 MDC。
 */
@Configuration
@ConditionalOnProperty(name = "lab.d04.trace-tap", havingValue = "true")
public class TraceTap {

    public record Seen(String method, String path, String traceparent, String mdcTraceId) {}

    public static final ConcurrentLinkedQueue<Seen> SEEN = new ConcurrentLinkedQueue<>();
    static final String RAW = "lab.d04.raw-traceparent";

    public static void reset() { SEEN.clear(); }

    @Bean
    WebServerFactoryCustomizer<TomcatServletWebServerFactory> d04TraceTapValve() {
        return f -> f.addContextValves(new ValveBase() {
            @Override
            public void invoke(Request req, Response res) throws IOException, ServletException {
                String h = req.getHeader("traceparent");
                req.setAttribute(RAW, h == null ? "（沒有）" : h);
                getNext().invoke(req, res);
            }
        });
    }

    @Bean
    FilterRegistrationBean<OncePerRequestFilter> d04TraceTap() {
        FilterRegistrationBean<OncePerRequestFilter> r = new FilterRegistrationBean<>(new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                if (req.getRequestURI().startsWith("/internal/"))
                    SEEN.add(new Seen(req.getMethod(), req.getRequestURI(), String.valueOf(req.getAttribute(RAW)), MDC.get("traceId")));
                chain.doFilter(req, res);
            }
        });
        r.setOrder(Ordered.LOWEST_PRECEDENCE);
        return r;
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/OrderEventsPactTest.java`**（3.8.6）

```java
package com.example.shop.inventory.internal;

import au.com.dius.pact.consumer.MessagePactBuilder;
import au.com.dius.pact.consumer.dsl.PactDslJsonBody;
import au.com.dius.pact.consumer.junit5.PactConsumerTestExt;
import au.com.dius.pact.consumer.junit5.PactTestFor;
import au.com.dius.pact.consumer.junit5.ProviderType;
import au.com.dius.pact.core.model.PactSpecVersion;
import au.com.dius.pact.core.model.V4Interaction;
import au.com.dius.pact.core.model.V4Pact;
import au.com.dius.pact.core.model.annotations.Pact;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

import java.time.Instant;
import java.util.List;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

/**
 * 13 站 3.8.6 的追記：事件的契約（message pact）。庫存服務「怎麼讀」訂單服務送來的事件 —— 一則事件一個方法：
 * 把契約裡的範例交給真的消費者（InventoryEventHandlers 的 EventHandler），看它用那幾個欄位做了什麼（JdbcInventoryService 換成 mock）。
 * 只寫消費者讀的欄位：order.paid 只讀 orderId，契約就只有 orderId —— 訂單服務可以自由加欄位，不能拿掉這裡寫了的、不能改型別。
 * 全部通過之後寫成 target/pacts/inventory-service-order-service.json；訂單服務在 failsafe 那一段（OrderEventsProviderPactIT）
 * 用真的程式碼產生每一則事件，跟這份契約比。
 */
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

    @Test @PactTestFor(pactMethod = "placed")
    void placed(V4Interaction.AsynchronousMessage m) throws Exception {
        handle(new InventoryEventHandlers().hotSettlement(inventory), "order.placed", m);
        verify(inventory).settleHot(7001L);
    }

    @Pact(consumer = "inventory-service")
    V4Pact paid(MessagePactBuilder b) {
        return b.expectsToReceive("order.paid").withContent(new PactDslJsonBody().integerType("orderId", 7001)).toPact(V4Pact.class);
    }

    @Test @PactTestFor(pactMethod = "paid")
    void paid(V4Interaction.AsynchronousMessage m) throws Exception {
        handle(new InventoryEventHandlers().orderEvents(inventory), "order.paid", m);
        verify(inventory).confirm(7001L);
    }

    @Pact(consumer = "inventory-service")
    V4Pact cancelled(MessagePactBuilder b) {
        return b.expectsToReceive("order.cancelled").withContent(new PactDslJsonBody().integerType("orderId", 7001)).toPact(V4Pact.class);
    }

    @Test @PactTestFor(pactMethod = "cancelled")
    void cancelled(V4Interaction.AsynchronousMessage m) throws Exception {
        handle(new InventoryEventHandlers().orderEvents(inventory), "order.cancelled", m);
        verify(inventory).release(7001L);
    }

    @Pact(consumer = "inventory-service")
    V4Pact shipped(MessagePactBuilder b) {
        return b.expectsToReceive("order.shipped").withContent(new PactDslJsonBody().integerType("orderId", 7001)).toPact(V4Pact.class);
    }

    @Test @PactTestFor(pactMethod = "shipped")
    void shipped(V4Interaction.AsynchronousMessage m) throws Exception {
        handle(new InventoryEventHandlers().orderEvents(inventory), "order.shipped", m);
        verify(inventory).consume(7001L);
    }

    @Pact(consumer = "inventory-service")
    V4Pact rejected(MessagePactBuilder b) {
        return b.expectsToReceive("order.rejected：熱點品項過了閘門、預留失敗")
                .withContent(new PactDslJsonBody().integerType("orderId", 7001)
                        .minArrayLike("hotLines", 1).integerType("productId", 9005).integerType("quantity", 1).closeObject().closeArray())
                .toPact(V4Pact.class);
    }

    @Test @PactTestFor(pactMethod = "rejected")
    void rejected(V4Interaction.AsynchronousMessage m) throws Exception {
        handle(new InventoryEventHandlers().orderEvents(inventory), "order.rejected", m);
        verify(inventory).releaseRejected(7001L, List.of(new ReserveLine(9005, 1)));
    }

    @Pact(consumer = "inventory-service")
    V4Pact productCreated(MessagePactBuilder b) {
        return b.expectsToReceive("product.created")
                .withContent(new PactDslJsonBody().integerType("productId", 9001).integerType("initialStock", 10)).toPact(V4Pact.class);
    }

    @Test @PactTestFor(pactMethod = "productCreated")
    void productCreated(V4Interaction.AsynchronousMessage m) throws Exception {
        handle(new InventoryEventHandlers().productCreated(inventory), "product.created", m);
        verify(inventory).initialize(9001L, 10, "product-created");
    }

    /** 契約裡的那一則，包成 EventDispatcher 交給消費者的那個樣子 */
    static void handle(EventHandler h, String type, V4Interaction.AsynchronousMessage m) throws Exception {
        h.handle(new Event("pact-" + type, type, "ORDER", 1, Instant.now(), JSON.readTree(m.getContents().getContents().valueAsString()), 1));
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/InventoryEventsPactTest.java`**（3.8.6）

```java
package com.example.shop.ordering.internal;

import au.com.dius.pact.consumer.MessagePactBuilder;
import au.com.dius.pact.consumer.dsl.PactDslJsonBody;
import au.com.dius.pact.consumer.junit5.PactConsumerTestExt;
import au.com.dius.pact.consumer.junit5.PactTestFor;
import au.com.dius.pact.consumer.junit5.ProviderType;
import au.com.dius.pact.core.model.PactSpecVersion;
import au.com.dius.pact.core.model.V4Interaction;
import au.com.dius.pact.core.model.V4Pact;
import au.com.dius.pact.core.model.annotations.Pact;
import com.example.shop.shared.events.Event;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

import java.time.Instant;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

/**
 * 13 站 3.8.6 的追記：反方向的那一則事件 —— 庫存服務的熱點落帳發現不夠（inventory.hot-settlement-failed），訂單服務收到之後取消訂單（7.6.3）。
 * 跟 HTTP 的契約（InventoryClientPactTest）是同一對服務：order-service 讀 inventory-service 的東西，寫進同一份 order-service-inventory-service.json。
 */
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

**`src/test/java/com/example/shop/ordering/internal/OrderEventMessages.java`**（3.8.6）

```java
package com.example.shop.ordering.internal;

import au.com.dius.pact.provider.MessageAndMetadata;
import au.com.dius.pact.provider.PactVerifyProvider;
import com.example.shop.catalog.internal.ProductDtos.CreateProductRequest;
import com.example.shop.catalog.internal.ProductService;
import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

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

    static volatile ApplicationContext context;

    static final long SELLER = 2;
    static final AtomicLong IDS = new AtomicLong(9_970_000), BUYERS = new AtomicLong(997_000);

    final OrderingApi ordering = context.getBean(OrderingApi.class);
    final OrderCommands commands = context.getBean(OrderCommands.class);
    final PaymentCallbackService callbacks = context.getBean(PaymentCallbackService.class);
    final ProductService products = context.getBean(ProductService.class);
    final ShopProperties props = context.getBean(ShopProperties.class);
    final JdbcTemplate jdbc = context.getBean(JdbcTemplate.class);

    public OrderEventMessages() {}

    // ───────── 每一則事件，用真的流程產生 ─────────

    @PactVerifyProvider("order.placed：有熱點品項的訂單成立")
    public MessageAndMetadata placed() {
        long hot = product(true, 5), buyer = BUYERS.incrementAndGet();
        return payload(place(buyer, hot, 1).orderId(), "order.placed");
    }

    @PactVerifyProvider("order.paid")
    public MessageAndMetadata paid() {
        long p = product(false, 5), buyer = BUYERS.incrementAndGet();
        var o = place(buyer, p, 1);
        pay(buyer, o.orderNo());
        return payload(o.orderId(), "order.paid");
    }

    @PactVerifyProvider("order.cancelled")
    public MessageAndMetadata cancelled() {
        long p = product(false, 5), buyer = BUYERS.incrementAndGet();
        var o = place(buyer, p, 1);
        commands.cancelByBuyer(buyer, o.orderNo());
        return payload(o.orderId(), "order.cancelled");
    }

    @PactVerifyProvider("order.shipped")
    public MessageAndMetadata shipped() {
        long p = product(false, 5), buyer = BUYERS.incrementAndGet();
        var o = place(buyer, p, 1);
        pay(buyer, o.orderNo());
        commands.startPicking(SELLER, o.orderNo());
        commands.ship(SELLER, o.orderNo(), "黑貓", "PACT-" + o.orderNo());
        return payload(o.orderId(), "order.shipped");
    }

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

    @PactVerifyProvider("product.created")
    public MessageAndMetadata productCreated() {
        var d = products.create(SELLER, new CreateProductRequest("契約測試商品", null, new BigDecimal("100"), 11L, 10));
        return payload("PRODUCT", d.id(), "product.created");
    }

    // ───────── 共用 ─────────

    long product(boolean hot, int stock) {
        long id = IDS.incrementAndGet();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '契約測試', 100.00, 'ON_SALE', ?)", id, SELLER, hot);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", id, stock);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, 0, 'INITIAL', 'pact-provider')", id, stock);
        return id;
    }

    OrderingApi.PlacedOrder place(long buyer, long product, int qty) {
        return ordering.placeOrder(buyer, UUID.randomUUID().toString(), List.of(new OrderingApi.OrderLine(product, qty, new BigDecimal("100"))));
    }

    void pay(long buyer, String orderNo) {
        long pid = commands.startPayment(buyer, orderNo).paymentId();
        BigDecimal a = new BigDecimal("100.00");
        String txn = "pact-" + UUID.randomUUID();
        callbacks.handle(new PaymentApi.Callback(pid, txn, a, true, CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(pid, txn, a, true))));
    }

    MessageAndMetadata payload(long orderId, String type) { return payload("ORDER", orderId, type); }

    /** outbox 裡那一列的 payload —— relay 送到 RabbitMQ 的就是這幾個位元組 */
    MessageAndMetadata payload(String aggregateType, long aggregateId, String type) {
        String json = jdbc.queryForObject("SELECT payload FROM outbox_events WHERE aggregate_type = ? AND aggregate_id = ? AND event_type = ? ORDER BY id DESC LIMIT 1",
                String.class, aggregateType, aggregateId, type);
        return new MessageAndMetadata(json.getBytes(StandardCharsets.UTF_8), Map.of("contentType", "application/json"));
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/OrderEventsProviderContract.java`**（3.8.6）

```java
package com.example.shop.ordering.internal;

import au.com.dius.pact.provider.junit5.MessageTestTarget;
import au.com.dius.pact.provider.junit5.PactVerificationContext;
import au.com.dius.pact.provider.junit5.PactVerificationInvocationContextProvider;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.TestTemplate;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;

/**
 * 13 站 3.8.6 的追記：事件的契約，提供端（訂單服務）的驗證。庫存服務寫了它讀哪幾則事件、每一則讀哪幾個欄位（OrderEventsPactTest）；
 * 每一則怎麼產生在 OrderEventMessages。
 *
 * 單體（一個行程、一個庫）：產生事件的程式碼在哪一種部署都一樣（OrderTransitionService.publish、ProductService.create），
 * 單體不需要另一個服務就能把一張訂單走完。
 *
 * 兩個子類別：OrderEventsProviderPactIT 驗證這一次建置的契約（target/pacts）；OrderEventsProviderBrokerIT 驗證 Pact Broker 上的
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
abstract class OrderEventsProviderContract {

    @Autowired ApplicationContext ctx;

    @BeforeEach
    void target(PactVerificationContext context) {
        OrderEventMessages.context = ctx;
        context.setTarget(new MessageTestTarget());
    }

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider.class)
    void verify(PactVerificationContext context) {
        context.verifyInteraction();
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/OrderEventsProviderPactIT.java`**（3.8.6）

```java
package com.example.shop.ordering.internal;

import au.com.dius.pact.provider.junitsupport.Provider;
import au.com.dius.pact.provider.junitsupport.loader.PactFolder;

/** 13 站 3.8.6 的追記：訂單服務的事件，驗證這一次建置的契約（庫存服務的呼叫端測試 OrderEventsPactTest 剛寫出來的 target/pacts） */
@Provider("order-service")
@PactFolder("target/pacts")
class OrderEventsProviderPactIT extends OrderEventsProviderContract {
}
```

**`src/test/java/com/example/shop/ordering/internal/OrderEventsProviderBrokerIT.java`**（3.8.6）

```java
package com.example.shop.ordering.internal;

import au.com.dius.pact.provider.junitsupport.Provider;
import au.com.dius.pact.provider.junitsupport.loader.PactBroker;
import au.com.dius.pact.provider.junitsupport.loader.PactBrokerConsumerVersionSelectors;
import au.com.dius.pact.provider.junitsupport.loader.SelectorBuilder;

/**
 * 13 站 3.8.6 的追記：訂單服務的事件，驗證 Pact Broker 上的契約 —— 線上（production）那一版庫存服務的，加上同一個分支最新的那一版。
 * 不在預設的建置裡（failsafe 只收 *PactIT）：scripts/d04-contracts.sh 帶著 -Dpactbroker.url 跑它，結果發布回 broker
 */
@Provider("order-service")
@PactBroker(url = "${pactbroker.url}")
class OrderEventsProviderBrokerIT extends OrderEventsProviderContract {

    @PactBrokerConsumerVersionSelectors                                    // ⚠️ 要 public static，不然 IllegalAccessException
    public static SelectorBuilder selectors() {
        return new SelectorBuilder().deployedOrReleased().branch(System.getProperty("pact.consumer.branch", "d04"));
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/web/InventoryEventMessages.java`**（3.8.6）

```java
package com.example.shop.inventory.internal.web;

import au.com.dius.pact.provider.MessageAndMetadata;
import au.com.dius.pact.provider.PactVerifyProvider;
import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.internal.EventDispatcher;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * 13 站 3.8.6 的追記：庫存服務送給訂單服務的那一則事件，用真的程式碼產生 —— 熱點預留還沒落帳、庫存是 0，
 * order.placed 交給真的落帳消費者（EventDispatcher：跟 RabbitMQ 送來的時候同一條路），它寫進 outbox 的那一列就是要送出去的。
 * 為什麼是一個獨立的 public 類別：訂單服務那一邊 OrderEventMessages 的 ⚠️。資料與 bean 用正在跑的那個測試的（InventoryProviderContract 設定）
 */
public class InventoryEventMessages {

    static volatile InventoryProviderContract contract;

    public InventoryEventMessages() {}

    @PactVerifyProvider("inventory.hot-settlement-failed：熱點落帳時庫存不夠")
    public MessageAndMetadata shortage() throws Exception {
        InventoryProviderContract c = contract;
        c.clean();
        c.stock(9005, 0, 0);
        c.reservation(7006, 9005, "HELD", false, null);
        EventHandler settlement = c.ctx.getBeansOfType(EventHandler.class).values().stream()
                .filter(h -> h.consumer().equals("inventory.hot-settlement")).findFirst().orElseThrow();
        c.ctx.getBean(EventDispatcher.class).dispatch(settlement, new Event(UUID.randomUUID().toString(), "order.placed", "ORDER", 7006, Instant.now(),
                c.ctx.getBean(ObjectMapper.class).readTree("{\"orderId\":7006,\"hotProductIds\":[9005]}"), 1));
        String payload = c.jdbc.queryForObject(
                "SELECT payload FROM outbox_events WHERE event_type = 'inventory.hot-settlement-failed' AND aggregate_id = 7006 ORDER BY id DESC LIMIT 1", String.class);
        return new MessageAndMetadata(payload.getBytes(StandardCharsets.UTF_8), Map.of("contentType", "application/json"));
    }
}
```

#### 改了的檔案

**`src/test/java/com/example/shop/dist02/Ops.java`**（E7 從 `dist04` 用它：類別、建構子、用到的方法改成 public）

```diff
  * 失敗的注入跟第 00 章 0.2.2 ① 一樣：訂單服務的庫上一個 trigger，寫訂單狀態歷史的那一句被拒絕 —— 遠端的庫存服務已經 commit 了，
  * 訂單服務的交易 rollback。要失敗的是哪一張、哪一個轉移，寫在 d02_fail 這張表（實驗自己建的，不是 migration）。
  */
-final class Ops {
+public final class Ops {
 
     static final long SELLER = SplitLab.SELLER;
 
     final ConfigurableApplicationContext order;
     final ObjectMapper json = new ObjectMapper();
-    String last = "";
+    public String last = "";
 
-    Ops(ConfigurableApplicationContext order) { this.order = order; }
+    public Ops(ConfigurableApplicationContext order) { this.order = order; }
 
     // ───────── 注入失敗 ─────────
 
-    void installTrigger() throws Exception {
+    public void installTrigger() throws Exception {
         exec(Split.ORDER_DB, "CREATE TABLE d02_fail (buyer_id BIGINT NOT NULL, order_no VARCHAR(30) NOT NULL, to_status VARCHAR(20) NOT NULL)");
         exec(Split.ORDER_DB, """
                 CREATE TRIGGER d02_fail_after_remote BEFORE INSERT ON order_status_history FOR EACH ROW
…
     }
 
     /** buyer：這位買家的每一張訂單；orderNo：只有這一張。toStatus：轉移到這個狀態時失敗（PENDING_PAYMENT = 下單） */
-    void fail(long buyer, String orderNo, String toStatus) throws Exception {
+    public void fail(long buyer, String orderNo, String toStatus) throws Exception {
         try (Connection c = SplitLab.root(Split.ORDER_DB); PreparedStatement ps = c.prepareStatement("INSERT INTO d02_fail VALUES (?, ?, ?)")) {
             ps.setLong(1, buyer); ps.setString(2, orderNo == null ? "" : orderNo); ps.setString(3, toStatus);
             ps.executeUpdate();
         }
     }
 
-    void unfail() throws Exception { exec(Split.ORDER_DB, "DELETE FROM d02_fail"); }
+    public void unfail() throws Exception { exec(Split.ORDER_DB, "DELETE FROM d02_fail"); }
 
     // ───────── 一張訂單走到某個狀態 ─────────
 
-    String place(long buyer, long... products) throws Exception {
+    public String place(long buyer, long... products) throws Exception {
         String[] no = new String[1];
         int s = placeStatus(buyer, UUID.randomUUID().toString(), no, products);
         if (s != 201) throw new IllegalStateException("下單 " + s + "：" + last);
         return no[0];
     }
 
-    int placeStatus(long buyer, String key, String[] orderNo, long... products) throws Exception {
+    public int placeStatus(long buyer, String key, String[] orderNo, long... products) throws Exception {
         List<Map<String, Object>> items = new ArrayList<>();
         for (long p : products) items.add(Map.of("productId", p, "quantity", 1, "unitPrice", new BigDecimal("100.00")));
         HttpResponse<String> r = send("POST", "/api/orders", bearer(buyer), Map.of("items", items), Map.of("Idempotency-Key", key));
…
     }
 
     /** 建立付款、算好簽章的金流回呼（還沒送） */
-    Map<String, Object> callback(long buyer, String orderNo) throws Exception {
+    public Map<String, Object> callback(long buyer, String orderNo) throws Exception {
         HttpResponse<String> r = send("POST", "/api/orders/" + orderNo + "/payments", bearer(buyer), null, Map.of());
         JsonNode p = json.readTree(r.body());
         long paymentId = p.get("paymentId").asLong();
…
                 "signature", CallbackSignature.sign(secret, CallbackSignature.canonical(paymentId, txn, amount, true)));
     }
 
-    String paid(long buyer, long product) throws Exception {
+    public String paid(long buyer, long product) throws Exception {
         String no = place(buyer, product);
         if (post("/api/payments/callback", null, callback(buyer, no)) != 200) throw new IllegalStateException("付款：" + last);
         return no;
     }
 
-    String picking(long buyer, long product) throws Exception {
+    public String picking(long buyer, long product) throws Exception {
         String no = paid(buyer, product);
         if (post("/api/seller/orders/" + no + "/start-picking", seller(), null) != 200) throw new IllegalStateException("撿貨：" + last);
         return no;
…
 
     // ───────── HTTP ─────────
 
-    String bearer(long buyer) { return TestTokens.bearer(order, buyer); }
-    String seller() { return TestTokens.bearer(order, SELLER, Role.SELLER); }
+    public String bearer(long buyer) { return TestTokens.bearer(order, buyer); }
+    public String seller() { return TestTokens.bearer(order, SELLER, Role.SELLER); }
 
-    int post(String path, String token, Object body) throws Exception {
+    public int post(String path, String token, Object body) throws Exception {
         return send("POST", path, token, body, Map.of()).statusCode();
     }
 
…
         return r;
     }
 
-    static void exec(String db, String sql) throws Exception {
+    public static void exec(String db, String sql) throws Exception {
         try (Connection c = SplitLab.root(db); Statement st = c.createStatement()) { st.execute(sql); }
     }
 }
```

**`src/test/java/com/example/shop/inventory/internal/remote/InventoryClientPactTest.java`**（3.8.6：V3 → V4，全部）

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
     }
 
     @Pact(consumer = "order-service")
-    RequestResponsePact display(PactDslWithProvider b) {
+    V4Pact display(PactDslWithProvider b) {
         return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
                 .uponReceiving("商品頁顯示用的可售量").method("GET").path("/internal/inventory/v1/stock/9001/display")
                 .query("hot=false").matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                 .willRespondWith().status(200)
                 .body(new PactDslJsonBody().integerType("productId", 9001).integerType("available", 10))
-                .toPact();
+                .toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "display")
…
     // ───────── 預留 ─────────
 
     @Pact(consumer = "order-service")
-    RequestResponsePact reserve(PactDslWithProvider b) {
+    V4Pact reserve(PactDslWithProvider b) {
         return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
                 .uponReceiving("一張訂單的預留").method("PUT").path("/internal/inventory/v1/reservations/7001")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                 .body("{\"lines\":[{\"productId\":9001,\"quantity\":2}],\"hotLines\":[]}", "application/json")
                 .willRespondWith().status(204)
-                .toPact();
+                .toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "reserve")
…
     }
 
     @Pact(consumer = "order-service")
-    RequestResponsePact reserveInsufficient(PactDslWithProvider b) {
+    V4Pact reserveInsufficient(PactDslWithProvider b) {
         return b.given("商品 9001 只有 1 件可售")
                 .uponReceiving("預留超過可售量").method("PUT").path("/internal/inventory/v1/reservations/7002")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                 .body("{\"lines\":[{\"productId\":9001,\"quantity\":2}],\"hotLines\":[]}", "application/json")
                 .willRespondWith().headers(PROBLEM).status(409)
                 .body(new PactDslJsonBody().stringValue("type", "/problems/insufficient-stock").integerType("productId", 9001))
-                .toPact();
+                .toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "reserveInsufficient")
…
      * 出貨的兩個「不」（503、409）換到 …/shippable（只讀，下面三個互動）
      */
     @Pact(consumer = "order-service")
-    RequestResponsePact reserveCompensated(PactDslWithProvider b) {
+    V4Pact reserveCompensated(PactDslWithProvider b) {
         return b.given("訂單 7005 的預留已經被補償（order.rejected）")
                 .uponReceiving("預留一張已經被補償的訂單").method("PUT").path("/internal/inventory/v1/reservations/7005")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                 .body("{\"lines\":[{\"productId\":9001,\"quantity\":1}],\"hotLines\":[]}", "application/json")
                 .willRespondWith().headers(PROBLEM).status(409)
                 .body(new PactDslJsonBody().stringValue("type", "/problems/invalid-state"))
-                .toPact();
+                .toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "reserveCompensated")
…
     // ───────── 13 站 4.6.3：出貨之前問一次 ─────────
 
     @Pact(consumer = "order-service")
-    RequestResponsePact shippable(PactDslWithProvider b) {
+    V4Pact shippable(PactDslWithProvider b) {
         return b.given("訂單 7003 的預留已確認")
                 .uponReceiving("出貨之前：可以出貨").method("GET").path("/internal/inventory/v1/reservations/7003/shippable")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
-                .willRespondWith().status(204).toPact();
+                .willRespondWith().status(204).toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "shippable")
     void shippable(MockServer server) { api(server).checkShippable(7003L); }
 
     @Pact(consumer = "order-service")
-    RequestResponsePact shippableWhileSettling(PactDslWithProvider b) {
+    V4Pact shippableWhileSettling(PactDslWithProvider b) {
         return b.given("訂單 7004 的熱點預留已確認、還沒落帳")
                 .uponReceiving("出貨之前：熱點還在落帳").method("GET").path("/internal/inventory/v1/reservations/7004/shippable")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                 .willRespondWith().headers(PROBLEM).status(503)
                 .body(new PactDslJsonBody().stringValue("type", "/problems/temporarily-unavailable").integerType("retryAfter", 5))
-                .toPact();
+                .toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "shippableWhileSettling")
…
     }
 
     @Pact(consumer = "order-service")
-    RequestResponsePact shippableShort(PactDslWithProvider b) {
+    V4Pact shippableShort(PactDslWithProvider b) {
         return b.given("訂單 7006 的熱點預留落帳時不夠，已經釋放")
                 .uponReceiving("出貨之前：庫存不足、即將取消").method("GET").path("/internal/inventory/v1/reservations/7006/shippable")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                 .willRespondWith().headers(PROBLEM).status(409)
                 .body(new PactDslJsonBody().stringValue("type", "/problems/invalid-state"))
-                .toPact();
+                .toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "shippableShort")
…
 
     /** 13 站 4.6：第 03 章是「取消：釋放預留」；取消之後的釋放改成事件，訂單服務只剩對帳會呼叫這一支 */
     @Pact(consumer = "order-service")
-    RequestResponsePact release(PactDslWithProvider b) {
+    V4Pact release(PactDslWithProvider b) {
         return b.given("訂單 7001 有一筆 HELD 的預留")
                 .uponReceiving("對帳：釋放沒有人要的預留").method("POST").path("/internal/inventory/v1/reservations/7001/release")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
-                .willRespondWith().status(204).toPact();
+                .willRespondWith().status(204).toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "release")
     void release(MockServer server) { api(server).releaseAbandoned(7001L); }
 
     @Pact(consumer = "order-service")
-    RequestResponsePact activeReservations(PactDslWithProvider b) {
+    V4Pact activeReservations(PactDslWithProvider b) {
         return b.given("訂單 7001 有一筆 HELD 的預留，建立在 2026-01-01")
                 .uponReceiving("對帳：還佔著庫存的預留").method("GET").path("/internal/inventory/v1/reservations")
                 .matchQuery("afterId", "\\d+", "0").matchQuery("createdBefore", "\\d{4}-\\d{2}-\\d{2}T[0-9:.]+Z", "2026-10-15T00:00:00Z")
…
                 .willRespondWith().status(200)
                 .body(new PactDslJsonBody().minArrayLike("items", 1).integerType("id", 1).integerType("orderId", 7001)
                         .integerType("productId", 9001).integerType("quantity", 1).stringMatcher("status", "HELD|CONFIRMED", "HELD").closeObject().closeArray())
-                .toPact();
+                .toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "activeReservations")
…
     }
 
     @Pact(consumer = "order-service")
-    RequestResponsePact reservationsOf(PactDslWithProvider b) {
+    V4Pact reservationsOf(PactDslWithProvider b) {
         return b.given("訂單 7001 有一筆 HELD 的預留，建立在 2026-01-01")
                 .uponReceiving("對帳：這些訂單的預留").method("POST").path("/internal/inventory/v1/reservations/query")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
…
                 .willRespondWith().status(200)
                 .body(new PactDslJsonBody().minArrayLike("items", 1).integerType("id", 1).numberValue("orderId", 7001)
                         .integerType("productId", 9001).integerType("quantity", 1).stringType("status", "HELD").closeObject().closeArray())
-                .toPact();
+                .toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "reservationsOf")
…
     // ───────── 商品：補貨、熱點 ─────────
 
     @Pact(consumer = "order-service")
-    RequestResponsePact restock(PactDslWithProvider b) {
+    V4Pact restock(PactDslWithProvider b) {
         return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
                 .uponReceiving("補貨").method("POST").path("/internal/inventory/v1/products/9001/restocks")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN).matchHeader("Idempotency-Key", UUID_RE, "0b7e5f2a-1111-4c3d-9e8f-123456789abc")
                 .body("{\"quantity\":10,\"note\":\"pact\"}", "application/json")
-                .willRespondWith().status(204).toPact();
+                .willRespondWith().status(204).toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "restock")
     void restock(MockServer server) { api(server).restock(9001L, 10, "pact"); }
 
     @Pact(consumer = "order-service")
-    RequestResponsePact setHot(PactDslWithProvider b) {
+    V4Pact setHot(PactDslWithProvider b) {
         return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
                 .uponReceiving("標成熱點").method("PUT").path("/internal/inventory/v1/products/9001/hot")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                 .body("{\"hot\":true}", "application/json")
-                .willRespondWith().status(204).toPact();
+                .willRespondWith().status(204).toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "setHot")
     void setHot(MockServer server) { api(server).setHot(9001L, true); }
 
     @Pact(consumer = "order-service")
-    RequestResponsePact gate(PactDslWithProvider b) {
+    V4Pact gate(PactDslWithProvider b) {
         return b.given("商品 9005 是熱點，閘門有 10 件")
                 .uponReceiving("熱點閘門：減").method("POST").path("/internal/inventory/v1/hot-gate")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN).matchHeader("Idempotency-Key", UUID_RE, "0b7e5f2a-2222-4c3d-9e8f-123456789abc")
                 .body("{\"lines\":[{\"productId\":9005,\"quantity\":1}]}", "application/json")
-                .willRespondWith().status(204).toPact();
+                .willRespondWith().status(204).toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "gate")
     void gate(MockServer server) { api(server).gateHot(List.of(new ReserveLine(9005, 1))); }
 
     @Pact(consumer = "order-service")
-    RequestResponsePact gateSoldOut(PactDslWithProvider b) {
+    V4Pact gateSoldOut(PactDslWithProvider b) {
         return b.given("商品 9005 是熱點，閘門有 0 件")
                 .uponReceiving("熱點閘門：搶不到").method("POST").path("/internal/inventory/v1/hot-gate")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN).matchHeader("Idempotency-Key", UUID_RE, "0b7e5f2a-3333-4c3d-9e8f-123456789abc")
                 .body("{\"lines\":[{\"productId\":9005,\"quantity\":1}]}", "application/json")
                 .willRespondWith().headers(PROBLEM).status(409)
                 .body(new PactDslJsonBody().stringValue("type", "/problems/insufficient-stock").integerType("productId", 9005))
-                .toPact();
+                .toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "gateSoldOut")
…
     }
 
     @Pact(consumer = "order-service")
-    RequestResponsePact giveBack(PactDslWithProvider b) {
+    V4Pact giveBack(PactDslWithProvider b) {
         return b.given("商品 9005 是熱點，閘門有 10 件")
                 .uponReceiving("熱點閘門：加回去").method("POST").path("/internal/inventory/v1/hot-gate/returns")
                 .matchHeader("Authorization", BEARER, EXAMPLE_TOKEN).matchHeader("Idempotency-Key", UUID_RE, "0b7e5f2a-4444-4c3d-9e8f-123456789abc")
                 .body("{\"lines\":[{\"productId\":9005,\"quantity\":1}]}", "application/json")
-                .willRespondWith().status(204).toPact();
+                .willRespondWith().status(204).toPact(V4Pact.class);
     }
 
     @Test @PactTestFor(pactMethod = "giveBack")
```

**`src/test/java/com/example/shop/dist02/C4DataMigrationTest.java`**（第 02 章 2.8.4 ④ 的追記；量的時候跑在第 02 章的程式碼上，同一個改動）

```diff
                 (freeze1 - drained) / 1e6, diff.isEmpty() ? "沒有" : diff);
         report(copier);
         assertThat(diff).isEmpty();
-        triggerCost(mono, copier);
+        triggerCost(mono, copier, 4, 5);
         copier.dropCapture();
     }
 
-    /** ④ trigger 的代價：每一列的寫入多一句 INSERT（同一個交易）。有、沒有 trigger 各 5 秒，交錯 4 輪 —— 不交錯的比較會被機器當下的狀態蓋過去 */
-    void triggerCost(ConfigurableApplicationContext mono, Copier copier) throws Exception {
-        out.printf("═══ 2.8.4 ④ trigger 的代價：有／沒有 trigger 各 5 秒、交錯 4 輪（load %s）═══%n", SplitLab.load());
+    /**
+     * 2.8.4 ④ 的追記：只量 trigger 的代價，多量幾輪。第一版（上面 capture() 的最後）只有各 5 秒 × 4 輪，兩次執行的結果差很多。
+     *   mvn test -Pexperiments -Dtest='C4DataMigrationTest#triggerCostOnly' -Dd02.rounds=10 -Dd02.seconds=10
+     */
+    @Test
+    void triggerCostOnly() throws Exception {
+        SplitLab.freshDatabase(OLD);
+        SplitLab.freshDatabase(NEW);
+        List<String> a = new ArrayList<>(SplitLab.common(OLD, 8));             // 跟 migration() 一樣的單體（同一個 DualWriteTap）
+        a.removeIf(x -> x.startsWith("--spring.datasource.url="));
+        a.add("--spring.datasource.url=" + SplitLab.url(OLD) + "&queryInterceptors=" + DualWriteTap.class.getName());
+        try (ConfigurableApplicationContext mono = Split.flushed(new SpringApplicationBuilder(ShopApplication.class).run(a.toArray(String[]::new)))) {
+            Flyway.configure().dataSource(SplitLab.url(NEW), "shop_migrator", "shop_migrator")
+                    .locations("classpath:db/migration/inventory", "classpath:db/migration/shared").load().migrate();
+            seed();
+            Copier copier = new Copier(OLD, NEW);
+            copier.installCapture();
+            try (Load warm = new Load(mono, THREADS)) { Thread.sleep(5_000); }
+            triggerCost(mono, copier, Integer.getInteger("d02.rounds", 10), Integer.getInteger("d02.seconds", 10));
+            copier.dropCapture();
+            out.printf("  （結束時 load %s）%n", SplitLab.load());
+        }
+    }
+
+    /**
+     * ④ trigger 的代價：每一列的寫入多一句 INSERT（同一個交易）。有、沒有 trigger 各 seconds 秒，交錯 rounds 輪 —— 不交錯的比較會被機器當下的狀態蓋過去。
+     * 追記：每一輪各印一行（第一版只印合計，看不出輪與輪之間差多少）
+     */
+    void triggerCost(ConfigurableApplicationContext mono, Copier copier, int rounds, int seconds) throws Exception {
+        out.printf("═══ 2.8.4 ④ trigger 的代價：有／沒有 trigger 各 %d 秒、交錯 %d 輪（load %s）═══%n", seconds, rounds, SplitLab.load());
         long[] placed = new long[2];
         List<List<Long>> nanos = List.of(new ArrayList<>(), new ArrayList<>());
-        for (int round = 0; round < 4; round++)
+        for (int round = 0; round < rounds; round++) {
+            long[] perRound = new long[2];
             for (int with = 0; with < 2; with++) {
                 if (with == 1) copier.installTriggers(); else copier.dropTriggers();
                 try (Load load = new Load(mono, THREADS)) {
-                    Thread.sleep(5_000);
+                    Thread.sleep(seconds * 1_000L);
                     load.close();
+                    perRound[with] = load.placed.get();
                     placed[with] += load.placed.get();
                     nanos.get(with).addAll(load.placeNanos);
                 }
             }
+            if (rounds > 4) out.printf("  第 %2d 輪 │ 沒有 %,d 張、有 trigger %,d 張（%+.1f%%）%n", round + 1, perRound[0], perRound[1], 100.0 * (perRound[1] - perRound[0]) / perRound[0]);
+        }
         for (int with = 0; with < 2; with++) {
             long[] s = nanos.get(with).stream().mapToLong(Long::longValue).sorted().toArray();
-            out.printf("  %-10s │ 下單 %,d 張（每秒 %.0f）│ p50 %.1f ms │ p99 %.1f ms%n", with == 1 ? "有 trigger" : "沒有", placed[with], placed[with] / 20.0,
+            out.printf("  %-10s │ 下單 %,d 張（每秒 %.0f）│ p50 %.1f ms │ p99 %.1f ms%n", with == 1 ? "有 trigger" : "沒有", placed[with], placed[with] / (double) (rounds * seconds),
                     SplitLab.pct(s, 50), SplitLab.pct(s, 99));
         }
         out.printf("  變更紀錄這段時間多了 %,d 筆%n", SplitLab.count(OLD, "SELECT COUNT(*) FROM d02_changes WHERE seq > " + copier.maxSeen));
```

---

## 4.12 常見誤區

- **「catch 裡寫好了補償，失敗就會被處理。」** 4.2：catch 只處理「行程還活著」的失敗。`kill -9` 之後，catch、finally、下一行程式碼一個都不會跑 —— 閘門少一件、冪等鍵卡 30 秒、一筆孤兒。補償要從資料庫裡的狀態出發，誰活著誰做。
- **「兩階段提交可以把分散式交易變回 `@Transactional`。」** 4.3：可以，代價是單筆 2 倍、吞吐三分之一，而且協調者一不見，參與者握著鎖等它；人工收尾只做一半，全有或全無就破了。在服務之間，它還要求協調者連得到每一個服務的庫。
- **「Saga 就是失敗時 rollback 前面的步驟。」** 補償不是 rollback：它是另一個交易，中間狀態別人看得到，它自己也會失敗、會重送、會比動作先到（4.7）。
- **「每一步都要寫補償。」** 樞紐之後的步驟不會被拒絕，只要能重試到成功（4.4.2）；補償不回來的步驟，要放到最後、或「確定不會被拒絕」之後（出貨，4.6.3）。
- **「編排比協同好」／「協同比編排好」。** 看兩個問題：使用者要不要等這個答案、另一邊會不會拒絕。這個系統兩種都用：下單編排、其他四種動作協同（4.4.4）。
- **「事件是照順序到的。」** 重試會讓後發的先到。每一步都只看「現在是什麼狀態」，順序才不重要（4.6.2）。
- **「同一則事件來兩次，`processed_messages` 會擋。」** 它擋得住同一個 eventId；擋不住兩條路各做一次（新舊版本並存，4.6.4），也擋不住「晚到的動作」—— 那要靠狀態，與補償先佔位（4.7.2）。
- **「新增一個狀態，就是 enum 多兩個值。」** 4.5.6：一個不能在線上跑的 migration、每一句讀 `orders` 的 SQL、一個 API 契約、一個驗收條件、一道被放掉的 CHECK。
- **「卡住的 Saga，往前做完比較好。」** 要看使用者最後看到什麼。拿到 503 的買家，不該在不知道的時候多出一張待付款的訂單（4.5.5）。他自己重送，才是往前。
- **「把動作改成事件之後，單體不受影響。」** 改的是模組，單體也跟著最終一致：8 個第 12 站的測試紅了，每一個都是「commit 完就讀預留」（4.8.1）；單體的下單每張多 4～5 ms（4.10.3）。
- **「端點的形狀沒變，就是相容的。」** v1 的 `…/consume` 路徑、請求、回應都沒變，語意變了（從會拒絕變成不拒絕）—— 線上那一版的契約紅了：expected status of 503 but was 204（4.6.4）。
- **「對帳在 Saga 之後就不需要了。」** 它從「事後檢查交易保證不了的事」變成「檢查最終沒有發生的事」—— 還是最後一道防線（4.9）。
- **「這個 `if` 只是省一次呼叫。」** 4.6.3 的追記：`ship()` 讀到的不是 `PICKING` 就不問庫存 —— 那一次讀在交易之外，下一刻就可能變。決定**要不要檢查**的那一次讀，跟檢查本身一樣會過時。
- **「對帳一直在跑，不一致就會被修好。」** 4.2.2 的追記：熱點對帳要「連續兩輪看到同一組」才修 —— 搶購進行中一次都不修，在最需要它的時候它不動；而它的指標只在**修了**的時候才動。

---

## 4.13 本章小結

第 03 章讓那條線上的每一個操作都可以安全地再做一次，這一章處理交易本身：

1. **行程當掉的時候**（4.2）：兩台訂單服務，A 在庫存服務 commit 之後、自己 commit 之前被 `kill -9`。閘門少一件；重送 409 三十秒，之後留下一筆孤兒；逾時釋放之後當掉、付款先到，一張已付款的訂單永遠出不了貨。共同點：第二半靠同一個行程接下來會做的事。
2. **兩階段提交**（4.3）：真的做出來 —— 單筆 2.1 倍、吞吐約三分之一；協調者在 PREPARE 之後不見，熱門商品那一列一直被鎖著，人工只收尾一半就破了全有或全無。
3. **Saga**（4.4）：一串本地交易；可補償、樞紐、可重試；會被拒絕、使用者要等的用編排，其他用協同。
4. **下單是編排的 Saga**（4.5）：訂單先以 `RESERVING` 寫下（語意鎖），冪等鍵在預留之前就綁到它；預留是樞紐；成功 → `PENDING_PAYMENT`，不足 → `REJECTED` + `order.rejected`；沒有回應 → 503，同一個鍵重送接著做那一張；沒有人接手的，60 秒後排程補償。熱點閘門留在最前面，它留下的那一個洞也留著。新狀態的代價：一個會擋住下單 1.5 秒的 migration（改成線上版、放掉一道 CHECK）、報表從覆蓋索引變成回表、五個漏出去的地方。
5. **付款、取消、出貨、逾時是協同**（4.6）：庫存模組聽訂單的事件，每一步只看預留的狀態，任何順序都收斂；出貨之前先問一次（只讀、在交易之外）；v1 的端點保留舊的語意，線上那一版的契約證明了為什麼。
6. **補償**（4.7）：補償不是 rollback；補償先佔掉預留的冪等鍵，晚到的預留拿到 409；補償不回來的操作列成一張表，放在最後。
7. **同樣的 `kill -9`**（4.8.3）：重送 200、39 ms、沒有孤兒；沒有人重送的被補償；晚到的預留什麼都沒留下；取消在 outbox 裡活過當機；對帳 0 張。閘門那一件還在。
8. **代價**（4.10）：單體的下單每張多 4～5 ms、吞吐少一到兩成；切開的部署多 0.4～3.6 ms。B1：庫存這一刀切斷的交易 6 → **0**，名次第 80 → 第 24。

**第 00 章的四個代價**：一致性那一項，這一章換了形狀 —— 不再是「兩邊各自正確、合起來錯」，而是「最終會對、中間看得到」，而且每一種卡住都有人接手。延遲那一項變大了一點（每張多兩次 commit）。故障傳遞那一項，下單的遠端呼叫不再佔著交易，但預留仍然是同步的 —— 庫存服務掛了，下單一樣不能用（第 06 章）。除錯那一項，多了一支 API（4.9），traceId 還是斷的（第 07 章）。

### 4.13.1 驗收清單

- [ ] 從 `d03` 開出 `d04`，在第一個 commit 上跑 `mvn test -Pexperiments -Dtest=E1CrashTest`：⓪ 閘門少 1 件；① 重送 409 約 30 秒、之後孤兒 1 筆；② 訂單 `PICKING`、預留 `RELEASED`、出貨 409（4.2）。
- [ ] **不看課文**，說出 4.2.5 那張表的三列：第 03 章的程式碼各假設了什麼。
- [ ] 跑 E2，說出 XA 多出來的時間從哪裡來；說出協調者在 PREPARE 之後當掉時，為什麼連 `FOR SHARE` 的讀都要等（4.3）。
- [ ] 用 4.4.2 的三種步驟，說出下單的樞紐在哪裡、為什麼出貨要放在「問過了」之後。
- [ ] 說出 `keys.complete()` 為什麼要在 T1 裡，以及它讓 4.2.3 的哪一件事消失（4.5.4）。
- [ ] 說出卡住的 `RESERVING` 為什麼往回補償、不往前做完（4.5.5）。
- [ ] 跑 E6，說出 V26 的第一版擋住下單多久、現在的寫法放掉了什麼（4.5.6）。
- [ ] 跑 `InventoryOrderEventsTest`，說出「先出貨、後付款」為什麼收斂（4.6.2）。
- [ ] 說出 `checkShippable` 為什麼可以在交易之外、而第 01 章 1.6.7 的 `succeededPaymentOf` 不行（4.6.3）。
- [ ] 把 v1 的 `…/consume` 暫時接到新的 `consume`，跑 `InventoryProviderReleasedPactIT`，看它紅（4.6.4）。
- [ ] 說出補償先佔掉預留的冪等鍵時，「同時發生」的那一種為什麼也是對的（4.7.2）。
- [ ] 跑 E3，跟 E1 的結果逐列比較（4.8.3）。
- [ ] 打 `GET /api/admin/orders/{orderNo}/saga`，看一張剛取消的訂單「對不上」、事件送出之後「對得上」（4.9）。
- [ ] `mvn clean verify` 全綠（4.11）。
- [ ] （追記）跑 `ShipCheckOutsideTxTest`；把 `PAST_SHIPPING` 改回「只在讀到 `PICKING` 時問」，看 ② 紅，說出 4.6.3 的推論漏了哪一次讀。
- [ ] （追記）跑 E8，說出熱點對帳為什麼在搶購進行中一次都不修，以及這一個洞為什麼不修（4.2.2）。
- [ ] （追記）跑 E7、E9，說出第 02 章的 S4'、第 00 章的 K3 各是被這一章的哪一個改動修好的（4.10.6、4.10.7）。
- [ ] （追記）跑一輪 `scripts/d04-contracts.sh`（broker → baseline → publish → verify → can-i-deploy），說出這一章的兩個服務各自為什麼不能先上（第 03 章 3.8.6）。

---

## 4.14 下一章預告

這一章讓庫存這一刀不再切斷任何一個交易，但留下 9 種同步呼叫（4.10.4）—— 其中 5 種是**讀**，最常用的那幾個是購物車、商品頁、賣家的商品列表，每一次都問庫存服務「這個商品現在可以賣幾件」。E4 的使用者的一天裡，訂單服務打庫存服務 30 次，20 次是讀，其中 17 次問的就是可售量。

而這一章也讓「可以賣幾件」的答案變得更晚：取消之後，庫存要等 `order.cancelled` 送到才回來。

第 05 章處理**跨服務的查詢**：

- **API 組合**：一頁購物車要問幾個服務、延遲怎麼相乘。
- **讀模型（CQRS）**：訂單服務自己留一份可售量，靠庫存服務的事件更新 —— 不用每一次都問。它會過時：**過時多久、使用者在那段時間裡會看到什麼**（買了一件「還有 1 件」的商品，拿到 409）。
- **事件重放**：讀模型壞了、或第一次建立時，怎麼從頭建一份。
- **熱點名單**：第 01 章 1.3.3 看出來、第 03、04 章都沒有搬的熱點旗標（`products.hot`）。搬進庫存模組之後，「下單時哪些品項是熱點」就是一次跨服務的查詢 —— 每一張訂單都問一次，還是訂單服務自己留一份名單、靠事件更新。名單過時一秒，那一張多半只是走比較慢的路；可售量過時一秒，使用者拿到 409 —— 同一招讀模型，兩種代價（第 05 章要量）。
- **報表該不該直連別人的資料庫**：第 02 章說庫存這一刀不切斷報表；這一章又讓報表多了兩個要排除的狀態（4.5.6）。下一刀如果切的是訂單，報表怎麼辦。
