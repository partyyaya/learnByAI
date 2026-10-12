# 第 07 章：事件驅動的訂單流：Outbox、冪等消費、通知與退款、熱點落帳移出交易

> 第 06 章結束時，Redis 擋在了 MySQL 前面：搶不到的人在幾十毫秒內知道結果，Redis 掛了 60 秒，每一個功能都照 0.6.3 降級。
> 但它留下了一個沒有達成的目標和兩個「第 07 章」：熱點搶購的 p99 還是 3.7～4.9 秒；commit 之後要做的事（快取的修復、閘門的加回）只記在記憶體裡；排行的 +1 與訂單成立是兩個寫入。
> 而 0.5.4 表格的右欄 ——「提交後（透過 Outbox，第 07 章）」—— 一格都還沒做：**從第 04 章開始，每一筆退款單都停在 `PENDING`，錢一次都沒有退出去；通知一封都沒寄過**（7.2.0）。
>
> **這一章把「commit 之後要做的事」變成資料。** 下單、付款、取消、出貨，各自在同一個交易裡寫一列 Outbox；relay 把它送到 RabbitMQ；五個消費者各自負責一件事，並且各自保證「同一件事只做一次」。然後把熱點商品的 MySQL 預留移出下單交易，交給消費者 —— 熱點 p99 的第二次嘗試。最後把 RabbitMQ 停掉、凍結各 60 秒，看 0.6.3 的那一欄。
>
> 這一章結束時，你手上會有：
>
> - **一個 Outbox 與 relay**（7.4）：事件跟業務寫入同一個交易；relay「認領 → 送出 → 標記」，送出的時候手上沒有任何資料庫的鎖。`kill -9` 五十次，遺失 0（7.2.2）。
> - **五個消費者**（7.5～7.8）：熱點落帳、落帳失敗的取消、熱點加回、通知、退款。冪等分兩種 —— 效果在 MySQL 裡的用 `processed_messages`，效果在外面的用對方的冪等鍵或自己的業務鍵。
> - **一條重試階梯與死信**（7.5.3、7.5.5）：1、2、4、8、16 秒，用完進死信；死信看得到、放得回去（`/api/admin/dead-letters`）。
> - **熱點商品的落帳移出下單交易**（7.6）：下單只寫預留列；消費者在 commit 之後計入。一個新的事件 E10，處理「Redis 放進了不存在的庫存」。
> - **一次 RabbitMQ 停機演練**（7.9）與 **INV-2、INV-3 的對帳排程**（7.10）。
> - **2 支新的 API**、**2 個 migration**（V13、V14）、**驗收 Q9、Q10、Q11 變綠**：`Skipped` 從 4 變成 1。
>
> 這一章的實測事故：
>
> - **落帳訊息掉了，對帳把它變成超賣**（7.2.1）：「commit 之後送一則『請落帳』」，RabbitMQ 停 10 秒 —— 100 件商品賣出 177、178 張訂單，**超賣 77、78 件**。第 06 章的對帳看到「Redis 比 MySQL 少」，盡責地把那些庫存放回了閘門。**MySQL 的每一條 CHECK、每一條不變量都成立。**
> - **`kill -9` 的那一刻**（7.2.2）：正式的程式、每秒 50 張訂單、隨機 `kill -9`，五輪共 50 次 —— 遺失 0；重複 0～182 則。逐次比對的兩輪裡，每一次 kill 的重複都不超過「死掉的那個行程已經認領、還沒標記」的列數 —— 機器越忙，relay 的一批越大，重複就越多。Outbox 是 at-least-once，不是 exactly-once。
> - **退款的回應沒回來**（7.2.3）：金流退了錢、回應逾時。沒有冪等鍵，20 筆退款退了 40 次錢 —— **用 `processed_messages` 包住金流呼叫，也是 40 次**。
>
> ⚠️ **還有幾個，是寫這一章的途中被這一章自己的實驗抓到的**：
>
> - **一場重試風暴**（7.5.3）：重試佇列「回到原佇列」用 headers exchange，header 叫 `x-shop-target` —— `x-match=all` 不看 `x-` 開頭的 header。一個 SMTP 失敗，3.9 秒裡 **209 次重試、281 則死信**，還有一個消費者收到不該收的事件，**把一張好好的訂單取消了**。修好之後，**舊的綁定還留在 broker 上**。
> - **RabbitMQ 卡住，整站 503 —— 連商品詳情都是**（7.9.1）：`docker pause` 的 50 秒裡，幾乎每一個請求都是 503。執行緒堆疊說出了一條四層的鏈：relay 在資料庫交易裡等 broker → 它的間隙鎖擋住訂單的 outbox INSERT → 那張訂單手上有 `inventory` 的列鎖 → 18 張訂單排在後面 → 20 條連線用完。**每一層都是對的，錯在 relay 拿著鎖等網路。**
> - **熱點那一列還在下單交易裡**（7.6.6）：拿掉了 `UPDATE inventory`，但 `INSERT inventory_reservations` 的外鍵檢查照樣要那一列的 S 鎖，跟落帳的 X 鎖互相等。列鎖等待的總時間從每輪 116～176 秒降到 8～16 秒，沒有歸零。
> - **RabbitMQ 凍結的時候，新的實例起不來**（7.9.4）：正在跑的實例沒事，但新啟動的那一個卡在 listener container 的 `start()` 上 —— 60 秒起不來，沒設上限的那一次 400 秒都沒起來。H6 量到的「啟動 40 秒」，其實是「等到 broker 回來」。
> - **「新建」與「已經有了」回傳值一樣**（7.8.2）：`INSERT … ON DUPLICATE KEY UPDATE` 在 Connector/J 的預設設定下，兩種都回 1。
>
> 另外還有幾個比較小、但一樣是實測到的坑：
>
> - **加一個取消原因要整表複製**（7.6.3）：改 `orders` 的 CHECK，10 萬列 2.25～3.61 秒、期間不能下單 —— 這一章因此沒有加。
> - **Redis 偏高的代價變了**（7.6.3）：搶購中 `FLUSHALL`，三次實驗、十二輪 FLUSHALL，每輪 3～83 個人拿到 201 之後被取消。第 06 章同樣的偏高只是多一句 409。
> - **測試之間的訊息**（7.12.1）：實驗留在佇列裡的一千多則訊息，讓下一次的 `EventFlowTest` 三個紅。
> - **實驗的資料讓對帳紅了**（7.13）：一個診斷實驗只把庫存歸零、沒刪自己的預留，全套測試的 INV-2 抓到差異 1 筆 —— 對帳排程抓到的第一個差異，來自我自己。
> - **一個 migration 比程式碼新**（7.6.6）：讓第 06 章的程式碼連到這一章的資料庫，要 `ignore-migration-patterns=*:future`，不是 `*:missing`。
>
> 以及一個**部分達成**的目標：熱點搶購的 p99 < 500 ms（7.6.6）。同樣的程式碼交錯量了三組：機器閒的時候（load 約 5～9），這一章 6 輪裡 5 輪在 150～187 ms，第 06 章 6 輪裡 2 輪；機器忙的時候（10～27），兩者都是秒級。熱點那一列的鎖在三組裡都少了 4 到 20 倍，但它已經不是 p99 的主因。

## 7.1 學習目標

完成本章後，你應該可以：

- 說出「交易 commit 了」跟「之後要做的事」之間，有哪三種斷法：交易裡送、commit 之後送、Outbox；各自在 broker 停掉、行程被 `kill -9` 的時候會怎樣（7.2.1、7.2.2、11-messaging/02）。
- 寫出一個 Outbox：跟業務寫入同一個交易的一句 `INSERT`、一個用 `SKIP LOCKED` 的 relay、等 publisher confirm 與 return 才標成已送出（7.4）。
- 說出 Outbox 保證的是 **at-least-once**，並在這個專案裡量出它重複的那一半（7.2.2）。
- 為三種不同的消費者選對冪等的做法：效果在 MySQL 裡的用 `processed_messages` 同一個交易；效果在外面的（寄信、金流）靠對方的冪等鍵或自己的業務鍵（7.5.2、7.7、7.8）。
- 設計一條重試階梯與死信：等待交給 broker、重試不卡住別人、用完了進停放區、能看、能放回去（7.5.3、7.5.5）。
- 把熱點商品的 MySQL 預留移出下單交易，並說出它付出的代價：**Redis 偏高不再只是浪費，而是「回了 201 之後取消」**（7.6）。
- 用一次真的演練回答 0.6.3 的「RabbitMQ」那一欄（7.9），並讓驗收 Q9、Q10、Q11 變綠（7.11）。

---

## 7.2 先看見痛：交易 commit 之後，沒有人負責

### 7.2.0 實驗環境

先看第 06 章結束時，0.5.4 表格的右欄「提交後（透過 Outbox，第 07 章）」做了幾格：

```bash
cd ../shop-ch06         # 第 06 章結束時的程式碼（git worktree，建法在 7.6.6）
grep -rln 'notifications\|outbox_events\|processed_messages' src/main
grep -rln 'UPDATE refunds' src/main | wc -l
grep -rln 'amqp\|rabbitmq' src/main/java | wc -l
```

```
src/main/resources/db/migration/V8__shared_create_tables.sql
src/main/resources/db/migration/V7__notification_create_tables.sql
0
0
```

**一格都沒有。** 三張表從第 02 章就建好了，但除了建表的 migration，沒有任何一行程式碼碰過它們：

- **退款**：US-ORD-2 AC-6、US-ORD-4 AC-2 說「自動發起全額退款」。第 04 章的做法是在取消的交易裡 `INSERT INTO refunds (…, status) VALUES (…, 'PENDING')`，然後 —— 就沒有然後了。`UPDATE refunds` 在整個 `src/main` 裡出現 **0 次**：從第 04 章到現在，**每一筆退款單都停在 `PENDING`，錢一次都沒有退出去**。`PaymentCallbackService` 的註解寫著「退款的實際呼叫在第 07 章改成非同步」。
- **通知**：US-NTF-1 的五條 AC，一封信都沒寄過。
- **broker**：`pom.xml` 從第 00 章就有 `spring-boot-starter-amqp`，`compose.yaml` 從第 00 章就有 RabbitMQ，但用到 AMQP 的 Java 類別是 **0 個**。第 01 章寫的 ArchUnit 規則「只有 `shared.messaging` 可以用 RabbitMQ」一直是綠的 —— **因為沒有任何人用**（7.11.3 會回來處理這件事）。

加上第 06 章留下的三件事（6.14）：熱點搶購的 p99、commit 之後只存在記憶體裡的「要做的事」、排行的兩個寫入。這一章就是把這些「之後」一件一件接起來。

本章的實驗命名接著第 06 章的 G1～G10：H1～H9。一樣標 `@Tag("experiment")`：

```bash
mvn test -Pexperiments -Dtest=H1LostSettlementTest
```

這些實驗（H1～H9，以及 H5b、H6b、H6c、H7b）的完整程式碼都在 7.13.1。

| 實驗 | 放在哪裡 | 用什麼 | 量什麼 |
|---|---|---|---|
| H1 落帳訊息掉了 | `inventory/internal/` | 「commit 之後送」的寫法 vs 正式的 `PlaceOrderService`，**真的停掉 RabbitMQ**，正式的 `HotStock.reconcile()` | 最後成立的訂單 vs 庫存 |
| H2 relay 被殺 | `ch07/` | 正式的程式在**另一個 JVM**，`kill -9` 十次 | commit 了的訂單 vs broker 收到的訊息：遺失、重複 |
| H3 退款的回應沒回來 | `payment/internal/` | 三種退款消費者，模擬金流「錢退了、回應逾時」 | 金流實際退了幾次錢 |
| H4 headers exchange | `ch07/` | 三種綁定、一則訊息 | 誰收到了 |
| H5 熱點搶購 | `ch07/`（+ 第 06 章的 worktree） | 第 04 章的 E7，第 06、07 章的程式碼**交錯** | p99、落帳要多久 |
| H6 RabbitMQ 停 60 秒 | `ch07/` | 啟動整個應用程式、混合流量、**真的停掉（或暫停）RabbitMQ 60 秒** | 每 5 秒的狀態碼、outbox 堆積、通知延遲、重複 |
| H6b、H6c（H6 的診斷） | `ch07/` | `pause` 之後取整個 JVM 的執行緒堆疊；`pause` 的時候啟動一個實例 | 誰佔住了連線；啟動卡在哪裡 |
| H7 relay 的輪詢間隔 | `ch07/` | 10 ms、100 ms、1 秒 | commit → 送出、commit → 通知、MySQL 的輪詢成本 |
| H8 Redis 的資料丟了 | `ch07/` | 搶購中 `FLUSHALL` | 回了 201 之後才被取消的訂單 |
| H9 `CLIENT_FOUND_ROWS` | `payment/internal/` | Connector/J 的預設值與 `useAffectedRows=true` | `ON DUPLICATE KEY UPDATE` 回傳幾 |

五個細節：

- **這一章的實驗會真的停掉 RabbitMQ、真的 `kill -9` 行程。** 實驗結束時會把 RabbitMQ 啟動回來；中途中斷了，記得 `docker start shop-rabbitmq-1`（或 `docker unpause`）。
- **測試環境預設不送、不收事件**（`src/test/resources/config/application.yml` 的 `shop.messaging.relay-enabled: false`、`consumers-enabled: false`，7.12.1 說為什麼）。要事件流的實驗與測試自己打開。
- 第 06 章的兩條規矩照舊：**延遲的比較一律交錯執行**（這台機器的 load average 在這一章的實驗期間從 4 到 30 都有，每一段輸出旁邊我都盡量記下了它）；**一次只跑一個實驗**。這一章我又犯了一次後者的變形：H1 跑到一半時，我在旁邊 `mvn compile` 了一次 —— 編譯會改寫正在跑的那個 JVM 用的 `target/classes`。那一次的數字我沒有用，整組重跑了（7.2.1 的是重跑的）。
- 長的實驗一律 `caffeinate -i` 包起來（6.9.2 那一次筆電睡著，100 秒的實驗跑了 9,402 秒）。
- **這一章的程式碼在途中被自己的實驗改了兩次**：7.9.2（relay 送出時不拿鎖）與 7.9.4（消費者在背景啟動）。7.9.2 之後，每一個經過 relay 的實驗都重跑了；7.9.4 之後重跑了 H5（7.6.6 的最後一組與外鍵對照）、H6、H6b 與全套測試。H1、H2、H7、H8 是 7.9.2 之後、7.9.4 之前量的 —— 7.9.4 只改了消費者在啟動時什麼時候接上 broker。H3、H4、H9 不經過 relay。

### 7.2.1 事故一：落帳訊息掉了，對帳把它變成超賣 ★★★

第 06 章 6.5.4 的結論：閘門讓搶不到的人快了兩個數量級，但搶到的 500 人仍然排在同一列 `inventory` 後面 —— **下單交易裡的 `UPDATE inventory SET reserved = reserved + 1` 是那個熱點。** 6.5.3 的 📌 也預告了方向：「MySQL 之後再慢慢落帳」。

最直覺的寫法：下單交易**只寫訂單**，commit 之後送一則「請落帳」，消費者再去 `reserved += 1`。commit 之後才送，消費者就不會讀到還沒 commit 的訂單 —— 這是 11-messaging/02 的寫法 C（`AFTER_COMMIT`），看起來沒有問題：

```java
/** naive：閘門 → 交易裡只寫訂單 → commit 之後送「請落帳」 */
String naivePlace(long buyer) {
    inventory.gateHot(List.of(new ReserveLine(NAIVE, 1)));           // 第 06 章的閘門，不夠 → 409
    tx.executeWithoutResult(s -> {
        jdbc.update("INSERT INTO lab_h1_orders (buyer_id, product_id) VALUES (?, ?)", buyer, NAIVE);
        long id = jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() {
                rabbit.convertAndSend("lab.h1", "settle", (id + ":" + NAIVE).getBytes(UTF_8));
            }
        });
    });
    return "201";
}

// 消費者：條件式 UPDATE（MySQL 仍然是最後一道防線）、建預留列、記 RESERVE
int n = jdbc.update("UPDATE inventory SET reserved = reserved + 1 WHERE product_id = ? AND on_hand - reserved >= 1", productId);
if (n == 1) { /* INSERT inventory_reservations (HELD)、INSERT inventory_ledger (RESERVE) */ }
```

對照組是這一章最後的寫法（7.6）：下單交易寫訂單、**預留列**（`counted = FALSE`）、Outbox 一列；relay 送出；消費者把數量計入 `reserved`。

H1 的情境：熱點商品 100 件，第一波 100 個買家（每秒 20 張），**RabbitMQ 在第 1 秒停掉、停 10 秒**；恢復之後等 15 秒，讓第 06 章的對帳（正式的 `HotStock.reconcile()`，連續兩輪看到同一組不一致才修正，6.6）跑兩輪；然後第二波 100 個買家。

```bash
mvn test -Pexperiments -Dtest=H1LostSettlementTest
```

```
═══ 7.2.1 熱點商品 100 件：第一波 100 人（每秒 20 張），第 1 秒起 RabbitMQ 停 10 秒；恢復後對帳兩輪；第二波 100 人 ═══
  naive  第一波 {201=23, 500（訂單其實成立了）=77}
         RabbitMQ 恢復 15 秒後：MySQL {on_hand=100, reserved=23, holds=23} │ Redis 0
         對帳兩輪：修正 1 個商品，Redis 0 → 77
         第二波 {201=77, 409=23}
         最後：成立的訂單 177 張、庫存 100 件 │ MySQL {on_hand=100, reserved=100, holds=100} → 超賣 77 件
  ours   第一波 {201=100}
         RabbitMQ 恢復 15 秒後：MySQL {on_hand=100, reserved=100, holds=100} │ Redis 0
         對帳兩輪：修正 0 個商品，Redis 0 → 0
         第二波 {409=100}
         最後：成立的訂單 100 張、庫存 100 件 │ MySQL {on_hand=100, reserved=100, holds=100} → 沒有超賣
  naive  第一波 {201=23, 500（訂單其實成立了）=77}
         RabbitMQ 恢復 15 秒後：MySQL {on_hand=100, reserved=22, holds=22} │ Redis 0
         對帳兩輪：修正 1 個商品，Redis 0 → 78
         第二波 {201=78, 409=22}
         最後：成立的訂單 178 張、庫存 100 件 │ MySQL {on_hand=100, reserved=100, holds=100} → 超賣 78 件
  ours   第一波 {201=100}
         RabbitMQ 恢復 15 秒後：MySQL {on_hand=100, reserved=100, holds=100} │ Redis 0
         對帳兩輪：修正 0 個商品，Redis 0 → 0
         第二波 {409=100}
         最後：成立的訂單 100 張、庫存 100 件 │ MySQL {on_hand=100, reserved=100, holds=100} → 沒有超賣
```

**naive：100 件商品，賣出 177 張、178 張訂單。超賣 77 件、78 件。**

一步一步看它怎麼發生的（第一輪的數字；第二輪多了一則：23 張拿到 201，`reserved` 卻是 22 —— 有一則「請落帳」在 `afterCommit` 送出時沒有丟例外，訊息還是沒到。我的推測是它在 RabbitMQ 停機的那一刻送進了一條正在關閉的連線；沒有驗證）：

1. **RabbitMQ 停掉的那 10 秒裡，77 張訂單的「請落帳」送不出去。** `afterCommit` 丟了例外 —— 但交易**已經 commit 了**。客戶端收到 500，訂單卻是真的（第一波的 `500（訂單其實成立了）=77`）。
2. **訊息就這樣沒了。** 它只存在 `afterCommit` 那一刻的記憶體裡，沒有任何地方記著「這 77 張還沒落帳」。RabbitMQ 恢復 15 秒後，MySQL 的 `reserved` 是 23 —— 只有 RabbitMQ 停掉之前的那 23 張。
3. **第 06 章的對帳把它「修正」了。** Redis 是 0（100 件都過了閘門），MySQL 說可售 77。連續兩輪看到同一組 `0/77`，CAS 把 Redis 改成 77 —— 6.6 寫的正是這件事：「Redis 偏低 = 少賣，要被對帳抓到」。**對帳盡責地把 77 件不存在的庫存放回了閘門。**
4. **第二波的 77 個人全部成功。** 他們的落帳訊息都送到了，MySQL 的條件式 UPDATE 也都通過 —— 因為 MySQL 根本不知道那 77 張訂單的存在。

最後一欄是這個事故最可怕的地方：**`reserved = 100`、`holds = 100`、`on_hand = 100`。** `CHECK (reserved <= on_hand)` 成立；INV-2（`reserved` = 有效預留的總和）成立；第 02 章的對帳 SQL 一筆差異都找不到。MySQL 裡**每一條不變量都成立**，因為那 77 張訂單在庫存模組裡**不存在** —— 它們只存在於 `orders`（這個實驗裡是 `lab_h1_orders`）。

第 06 章 6.2.4 說「少賣比超賣難發現」；這一個是超賣，而且一樣沒有任何一條規則會響。

**ours：兩輪都是 100 張、沒有超賣。** RabbitMQ 停掉的期間，第一波 100 張全部 201（下單交易根本不碰 broker）；事件堆在 outbox；RabbitMQ 恢復之後送出、落帳，15 秒後 `reserved = 100`。對帳修正 0 個商品，第二波全部 409。

兩個差別讓 ours 不會掉：

- **「要落帳」是一列資料，不是一則記憶體裡的訊息。** 它跟訂單在同一個交易裡 —— 訂單 commit 了，它就 commit 了（7.4）。
- **預留列在下單交易裡就寫了**（只是數量還沒計入 `reserved`，`counted = FALSE`，7.6）。對帳算 Redis 該是多少的時候，會把這些「還沒計入」的也扣掉（`HotStock.GATE_BASE_SQL`，7.6.2）—— 所以就算落帳還沒做，對帳也不會把它們放出去。

> ⚠️ **這個實驗的第一版，naive 的消費者還踩到了另一個坑。** RabbitMQ 停機的那一刻，有一則已經處理完、還沒 ack 的「請落帳」，在重啟之後被重送：`UPDATE` 成功、`INSERT inventory_reservations` 撞上 `uk_reservations_order_product`、交易 rollback、例外丟出去、Spring 預設把它**重新排隊** —— 那一則訊息被處理了 **1,477 次**。那是 11-messaging/06 6.3.4 的無窮迴圈，不是這個實驗要量的東西；上面的數字是把 naive 的消費者改成「失敗就丟掉」（`setDefaultRequeueRejected(false)`）、並且在 7.9.2 改完 relay 之後重跑的（改 relay 之前的那一次是超賣 77、76 件，ours 一樣是 0）。第一版的結果是超賣 74、78 件（其中一輪的 `reserved` 停在 99，就是那一則重送的訊息一直沒成功）。

> 📌 **11-messaging/02 的 2.3.2 已經說過：那個「窗」不是 commit 與送出之間的 46 微秒，而是「送訊息這件事失敗」的整段期間** —— 這裡就是 broker 停掉的 10 秒，命中率 100%。
> 這個專題多出來的是下一步：**第 06 章的對帳把「掉了 77 則訊息」放大成了「超賣 77 件」。** 兩個各自正確的機制（commit 之後才送、Redis 偏低就補回來）疊在一起，變成一個會超賣的系統。

> ⚠️ **同樣是「commit 之後送」，例外的去向不一樣。** 11-messaging/02 用的是 `@TransactionalEventListener(AFTER_COMMIT)`：例外被 Spring 吞掉，呼叫端拿到 200，**你不知道出事了**。H1 直接註冊 `TransactionSynchronization.afterCommit`：例外傳回了呼叫端，客戶端拿到 500 —— **客戶以為下單失敗了，訂單卻是真的**（第一波的那 77 個）。兩種都錯，錯的方向相反；而且兩種都沒有留下「哪幾張還沒落帳」的紀錄。

### 7.2.2 事故二：kill -9 的那一刻 ★★★

7.2.1 是「broker 停掉」。另一種死法是**行程自己死掉**：OOM killer、主機重開、部署時 `SIGTERM` 之後的 `SIGKILL`。0.4.8 的 NTF-1 AC-5、驗收 Q9 問的都是它：「訂單 commit 之後、訊息送出之前被 `kill -9`」。

這一節量的是**這一章最後的程式碼**（Outbox ＋ relay，7.4），因為它要回答兩個問題：Outbox 會不會掉？會不會重複？

H2 用同一份程式、同一個 classpath 啟動**另一個 JVM**（relay 照正式的設定每 100 ms 一輪；消費者不開，讓訊息留在佇列裡數）。測試每秒送 50 張一般商品的訂單（真的 `POST /api/orders`），在 2～6 秒之間的隨機時刻 `kill -9` 它、重啟、再殺，一共 10 次；最後一次不殺，讓 relay 把剩下的送完。一個**計數佇列**綁在 `shop.events` 的 `order.placed` 上，收下 relay 送出的每一則，最後依 `messageId`（= eventId）跟資料庫裡 commit 了的訂單比對。

```bash
mvn test -Pexperiments -Dtest=H2RelayKillTest
```

這個實驗我一共跑了五次。前兩次是 relay 的第一版（7.9.1 抓到它在交易裡等 broker 之前）；後三次是這一章最後的 relay（7.9.2：認領 → 送出 → 標記，三段各自分開）。先看最後的程式碼、機器比較閒的那一次（開始時 load average 5.7）：

```
═══ 7.2.2 正式的程式在另一個 JVM，每秒 50 張訂單；隨機時刻 kill -9，重啟，共 10 次 ═══
  第  1 次：跑了 3,782 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：6 則（其中 0 則在死掉的那個行程的租約裡）
  第  2 次：跑了 3,009 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：6 則（其中 4 則在死掉的那個行程的租約裡）
  第  3 次：跑了 4,669 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：9 則（其中 4 則在死掉的那個行程的租約裡）
  第  4 次：跑了 2,438 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：7 則（其中 4 則在死掉的那個行程的租約裡）
  第  5 次：跑了 3,543 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：5 則（其中 4 則在死掉的那個行程的租約裡）
  第  6 次：跑了 3,951 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：1 則（其中 0 則在死掉的那個行程的租約裡）
  第  7 次：跑了 3,912 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：5 則（其中 0 則在死掉的那個行程的租約裡）
  第  8 次：跑了 2,697 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：7 則（其中 0 則在死掉的那個行程的租約裡）
  第  9 次：跑了 4,924 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：3 則（其中 0 則在死掉的那個行程的租約裡）
  第 10 次：跑了 2,221 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：4 則（其中 0 則在死掉的那個行程的租約裡）
  客戶端：送出 1782 個請求，201 = 1759、失敗（連不上、被 kill 時還在路上）= 23
  資料庫：commit 了 1764 張訂單（比 201 多 5 張：回應還沒回來就被 kill，但交易已經 commit 了）
  計數佇列：收到 1768 則，不同的 eventId 1764 個 │ 遺失 0 │ 重複的 eventId 4 個（多送了 4 則）
  重複的事件屬於第幾次的訂單：{2=4}
```

**遺失 0，重複 4 則。** 每一次 `kill -9` 的當下，都有 1～9 則已經 commit、還沒送出的 `order.placed`；它們全部在下一次啟動之後送出了 —— 因為它們是 `outbox_events` 裡的列，不是誰記憶體裡的東西。

**重複的 4 則，全部是第 2 次的訂單。** 第 2 次被殺的那一刻，有 4 則在**死掉的那個行程的租約裡**（`claimed_until` 還沒過期，7.9.2）：它已經認領了這幾列，可能已經送出、也可能還沒。如果 broker 已經確認收下、`UPDATE outbox_events SET published_at` 還沒 commit，這幾列在資料庫裡仍然是「未送出」，租約過期（`confirm-timeout × 6` = 30 秒）之後，下一個行程再送一次 —— 這就是重複。第 3、4、5 次的租約裡也各有 4 則，卻沒有重複：那幾次行程大概死在「認領之後、送出之前」，broker 根本沒收到。

接下來是同樣的程式碼，前一次跑的時候機器比較忙（load average 13～16），那一次還沒有「租約裡幾則」與「屬於第幾次」兩欄：

```
═══ 7.2.2 正式的程式在另一個 JVM，每秒 50 張訂單；隨機時刻 kill -9，重啟，共 10 次 ═══
  第  1 次：跑了 5,805 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：2 則
  第  2 次：跑了 4,348 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：17 則
  第  3 次：跑了 5,978 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：108 則
  第  4 次：跑了 5,657 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：111 則
  第  5 次：跑了 5,104 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：175 則
  第  6 次：跑了 2,829 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：106 則
  第  7 次：跑了 2,454 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：7 則
  第  8 次：跑了 5,748 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：27 則
  第  9 次：跑了 4,133 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：53 則
  第 10 次：跑了 3,376 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：96 則
  客戶端：送出 2345 個請求，201 = 1522、失敗（連不上、被 kill 時還在路上）= 823
  資料庫：commit 了 1661 張訂單（比 201 多 139 張：回應還沒回來就被 kill，但交易已經 commit 了）
  計數佇列：收到 1843 則，不同的 eventId 1661 個 │ 遺失 0 │ 重複的 eventId 182 個（多送了 182 則）
```

**重複了 182 則。** 一開始我以為這是一個 bug，所以加了上面那兩欄。如果重複只能來自「死掉的行程的租約」，那麼**每一次 kill 的重複數，都不會超過那一刻租約裡的列數**；而租約裡有幾列，取決於 relay 的一批有多大 —— 機器忙、relay 落後、一批就大（`relay-batch` 上限 100）。上面那一次「還沒送出的」最多 175 則，比閒的那一次多了一個數量級。

為了驗證，我用 8 個 `yes > /dev/null` 把 8 核的 CPU 佔滿、等 20 秒，再跑一次（load average 從 11.4 升到 30.3）：

```
═══ 7.2.2 正式的程式在另一個 JVM，每秒 50 張訂單；隨機時刻 kill -9，重啟，共 10 次 ═══
  第  1 次：跑了 2,042 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：31 則（其中 0 則在死掉的那個行程的租約裡）
  第  2 次：跑了 2,780 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：28 則（其中 0 則在死掉的那個行程的租約裡）
  第  3 次：跑了 5,417 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：61 則（其中 0 則在死掉的那個行程的租約裡）
  第  4 次：跑了 4,122 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：45 則（其中 28 則在死掉的那個行程的租約裡）
  第  5 次：跑了 5,297 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：98 則（其中 57 則在死掉的那個行程的租約裡）
  第  6 次：跑了 2,495 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：50 則（其中 29 則在死掉的那個行程的租約裡）
  第  7 次：跑了 3,004 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：34 則（其中 0 則在死掉的那個行程的租約裡）
  第  8 次：跑了 4,435 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：51 則（其中 7 則在死掉的那個行程的租約裡）
  第  9 次：跑了 3,388 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：63 則（其中 19 則在死掉的那個行程的租約裡）
  第 10 次：跑了 3,863 ms 之後 kill -9（exit 137）；這時候還沒送出的 order.placed：38 則（其中 12 則在死掉的那個行程的租約裡）
  客戶端：送出 1938 個請求，201 = 412、失敗（連不上、被 kill 時還在路上）= 1526
  資料庫：commit 了 546 張訂單（比 201 多 134 張：回應還沒回來就被 kill，但交易已經 commit 了）
  計數佇列：收到 622 則，不同的 eventId 546 個 │ 遺失 0 │ 重複的 eventId 76 個（多送了 76 則）
  重複的事件屬於第幾次的訂單：{4=28, 5=29, 8=7, 9=12}
```

| 第幾次 kill | 4 | 5 | 6 | 8 | 9 | 10 | 其他（1、2、3、7） |
|---|---|---|---|---|---|---|---|
| 死掉的行程租約裡的列 | 28 | 57 | 29 | 7 | 19 | 12 | 0 |
| 這一次的訂單被重複送出 | 28 | 29 | 0 | 7 | 12 | 0 | 0 |

**每一次的重複都 ≤ 租約裡的列；租約裡是 0 的那四次，重複都是 0。** 有的整批重複（28／28、7／7），有的一部分（29／57、12／19：送到一半被殺），有的一則也沒有（0／29、0／12：還沒送出就被殺）。重複的總數（76）跟機器有多忙一起漲，**它不是另一個 bug，是同一個窗變大了**：一批越大，死在「confirm 之後、標記之前」的時候，一次多送的就越多。182 那一次沒有逐次的數字，我沒辦法一筆一筆對上，但它的形狀（「還沒送出的」幾十到 175 則）跟這一次一樣。

這不是 bug，是 Outbox 的定義：**at-least-once**。「只做一次」要靠消費者（7.5.2、驗收 Q10）。五次的總覽：

| | relay | load average | commit 的訂單 | 遺失 | 重複 |
|---|---|---|---|---|---|
| 第 1 次 | 第一版 | （沒記） | 1,691 | 0 | 0 |
| 第 2 次 | 第一版 | 22～24 | 1,261 | 0 | 4 |
| 第 3 次 | 最後的版本 | 13～16 | 1,661 | 0 | 182 |
| 第 4 次 | 最後的版本 | 5.7 | 1,764 | 0 | 4 |
| 第 5 次 | 最後的版本 | 11～30（8 個 CPU 佔用行程） | 546 | 0 | 76 |

**遺失，五次都是 0。** 重複是 0～182，取決於 kill 落在哪裡、那時候一批有多大。

還有兩個數字值得看：

- **資料庫裡的訂單比客戶端收到的 201 多。** 第 4 次多 5 張、第 5 次多 134 張：交易 commit 了、回應還沒寫出去就被 `kill -9`。客戶端看到的是連線中斷；照第 04 章 4.8.2 的規矩，它用同一個 `Idempotency-Key` 重送，會拿到 200 與同一張訂單。這也是為什麼「下單」的事件必須從 commit 出發，而不是從「回了 201」出發。
- **第 5 次只 commit 了 546 張，1,938 個請求裡 1,526 個失敗。** 我的推測是機器被佔滿的時候，應用程式每一次重啟都要比較久，那段時間送出的請求全部連不上（我沒有量重啟的時間）。這是那一次實驗刻意製造的條件，不是 relay 的問題；它也提醒了一件事：**租約讓死掉的行程認領的列要等 30 秒才會被送出**，那 30 秒裡，那幾張訂單的通知、落帳都在等。0.6.4 給「通知」與「落帳」的是 60 秒，30 秒在範圍內。

### 7.2.3 事故三：退款的回應沒回來 ★★

0.5.4 的「`PAID/PICKING → CANCELLED`：呼叫金流退款 API（可重試，失敗進死信 + 告警）」。「可重試」就是這個事故的起點。

呼叫外部 API 有一種失敗，比「失敗」更麻煩：**對方做完了，回應沒有回來**（逾時、連線被切斷）。你的程式看到的是一個例外，跟「對方根本沒收到」長得一模一樣。消費者丟出例外 → 訊息走重試階梯 → 再呼叫一次。

H3 讓模擬的金流（`SimulatedRefundGateway`）照真實金流的兩個行為做：**收冪等鍵**（同一個 key 再呼叫一次，回傳同一筆退款，錢不會再退一次），以及**會「錢退了、回應逾時」**。20 筆退款，每一筆的第一次呼叫都是後者，第二次（重試）正常。三種消費者：

- **① 沒有冪等鍵**：每次呼叫帶一個新的 request id（很多 SDK 的預設行為）。
- **② `processed_messages`**：把「呼叫金流、標成 `SUCCEEDED`」包進 `EventDispatcher` 的交易 —— 也就是 7.5.2 那個「處理一次」的機制。
- **③ 本專題的 `RefundExecutor`**：冪等鍵 `refund-{退款單 id}` 交給金流（7.8）。

```bash
mvn test -Pexperiments -Dtest=H3RefundResponseLostTest
```

```
═══ 7.2.3 20 筆退款；每一筆第一次呼叫金流：錢退了、回應逾時；broker 重送一次 ═══
  ① 沒有冪等鍵                            {退款單=20, 第一次呼叫丟例外=20, SUCCEEDED=20, 金流實際退款=40}
  ② processed_messages 包住金流呼叫        {退款單=20, 第一次呼叫丟例外=20, SUCCEEDED=20, 金流實際退款=40}
  ③ 本專題：冪等鍵 refund-{id}              {退款單=20, 第一次呼叫丟例外=20, SUCCEEDED=20, 金流實際退款=20}
  ① 沒有冪等鍵                            {退款單=20, 第一次呼叫丟例外=20, SUCCEEDED=20, 金流實際退款=40}
  ② processed_messages 包住金流呼叫        {退款單=20, 第一次呼叫丟例外=20, SUCCEEDED=20, 金流實際退款=40}
  ③ 本專題：冪等鍵 refund-{id}              {退款單=20, 第一次呼叫丟例外=20, SUCCEEDED=20, 金流實際退款=20}
```

（這個實驗的失敗是**注入**的：每一筆都安排了一次「回應丟了」。它量的不是「多常發生」，而是「發生的時候，每一種寫法各錯多少」—— 所以兩輪一模一樣。）

**① 與 ②：20 筆退款，退了 40 次錢。** 每一筆都多退了一次全額。

**② 是這個事故的重點。** `processed_messages` 是這一章冪等消費的主力（7.5.2），Q10 靠它通過。但它的保證是「**`processed_messages` 那一列，跟你的業務寫入一起 commit 或一起 rollback**」。金流的退款不是你的業務寫入 —— 它發生在金流那邊，你的 rollback 收不回來：

1. 交易開始，`INSERT processed_messages`。
2. 呼叫金流：**錢退出去了**，回應逾時，例外。
3. 交易 rollback —— `processed_messages` 那一列**也一起消失**。
4. 重試：`processed_messages` 裡沒有這個 eventId，「第一次處理」，再退一次。

**三種寫法，我們自己的資料庫都一樣好看：** 20 筆退款單都是 `SUCCEEDED`、`attempts` 都對。錢多退了 20 次這件事，只存在於金流的帳上 —— 你會在月底的對帳單上看到它，而那時候 20 位買家已經各收到兩次退款了。

**③ 退了 20 次。** 第一次呼叫「錢退了、回應丟了」；重試時帶著**同一個**冪等鍵 `refund-{id}`，金流認得它，回傳第一次的那一筆，不再退錢。

> 📌 **冪等要放在「效果發生的地方」。** 效果在 MySQL 裡（落帳、取消訂單）：`processed_messages` 跟效果同一個交易，夠了。效果在外面（金流、SMTP）：MySQL 的交易保護不了它，冪等只能在**對方**那裡 —— 對方收冪等鍵，就給它一個穩定的鍵；對方不收（像 SMTP），就只能接受「極少數時候重複」，並把那個窗縮到最小（7.7.2）。
> 11-messaging/03 的 3.4「根本不需要去重」是同一個方向：讓操作本身冪等，比在外面包一層去重表可靠。

---

## 7.3 本章的形狀

### 7.3.1 十個事件

0.5.4 表格的右欄，加上庫存與付款模組自己需要的，一共十個事件（`shared.events.EventTypes`）。每一個都是**在某個交易裡寫進 outbox**，跟那個交易一起 commit：

| 事件（routing key） | 誰寫、在哪個交易裡 | payload | 誰消費 |
|---|---|---|---|
| `order.placed` | `ordering`：下單（`PlaceOrderService`） | orderId、orderNo、buyerId、sellerId、totalAmount、**hotProductIds** | `inventory.hot-settlement`、`notification.order-events` |
| `order.paid` | `ordering`：`PENDING_PAYMENT → PAID` | 同上（沒有 hotProductIds） | `notification.order-events`（買家＋賣家） |
| `order.cancelled` | `ordering`：`→ CANCELLED` | ＋ cancelReason、event、refund | `notification.order-events` |
| `order.shipped` | `ordering`：`PICKING → SHIPPED` | ＋ carrier、trackingNo | `notification.order-events` |
| `order.completed` | `ordering`：`SHIPPED → COMPLETED` | 同 `order.paid` | （目前沒有人，0.5.4 寫的是「——」） |
| `refund.requested` | `payment`：建立退款單 | refundId、orderId、paymentId、amount、reason、buyerId | `payment.refunds` |
| `refund.succeeded` | `payment`：退款成功 | refundId、orderId、amount、buyerId | `notification.order-events` |
| `refund.failed` | `payment`：重試用完 | ＋ error | （告警，第 09 章） |
| `inventory.hot-settlement-failed` | `inventory`：熱點落帳發現不夠（7.6.3） | orderId、productId、requested、available | `ordering.stock-shortage` |
| `inventory.stock-returned` | `inventory`：取消、補貨 | lines：[{productId, quantity}] | `inventory.hot-stock-return` |

**payload 要自己帶齊。** 消費者在別的模組，`ModuleBoundaryTest` 不准它查發送端的表、不准它用發送端的類別 —— 通知要寄給誰（buyerId）、訂單編號是什麼（orderNo），都要在事件裡。`buyerId` 這種欄位出現在 `refund.requested` 裡，是因為 `payment` 模組不知道、也不該知道訂單是誰的；`ordering` 在呼叫 `requestRefund()` 時把它帶進去，只放在事件裡，不存進 `refunds`。

**事件是模組之間的契約。** 加欄位可以；改名字或改意思，跟改 API 一樣是破壞性變更（3.8 的 `OpenApiContractTest`）。`EventTypes` 的 javadoc 把每一個事件的欄位寫下來，就是那份契約。

### 7.3.2 五個消費者、一組佇列

```
                                    ┌──▶ shop.inventory.hot-settlement      （7.6 熱點落帳）
                                    ├──▶ shop.notification.order-events     （7.7 通知）
 outbox_events ──relay──▶ shop.events (topic) ──▶ shop.payment.refunds       （7.8 退款）
                                    ├──▶ shop.ordering.stock-shortage       （7.6.3 落帳失敗 → 取消）
                                    └──▶ shop.inventory.hot-stock-return    （7.6.5 熱點加回）

 每一個佇列失敗時：→ shop.retry ─▶ shop.retry.{1s,2s,4s,8s,16s}（TTL）─▶ shop.retry.return（headers）─▶ 回到原佇列
                   用完了：→ shop.dead ─▶ shop.{consumer}.dlq
```

拓撲照 11-messaging/06 的 6.9 定案：quorum 佇列、publisher confirm + return、`prefetch 10`、retry 佇列階梯（等待交給 broker，不卡住消費者）、死信停放區、佇列滿了拒收（`overflow: reject-publish`）。只改了一件事：這個專題有五個消費者共用同一組重試佇列，所以「從重試佇列回到哪個佇列」用 headers 決定 —— **這一個改動，讓這一章的第一個版本出了一場風暴**（7.5.3）。

### 7.3.3 兩個 migration、沒有新的模組依賴

| 檔案 | 內容 |
|---|---|
| `V13__inventory_reservation_counted.sql` | `inventory_reservations.counted BOOLEAN NOT NULL DEFAULT TRUE, ALGORITHM=INSTANT`（7.6.1） |
| `V14__shared_outbox_claim_lease.sql` | `outbox_events.claimed_until DATETIME(3) NULL, ALGORITHM=INSTANT`：relay 的租約（7.4.2、7.9.2） |

`outbox_events`、`processed_messages`、`notifications`、`refunds` 都是第 02 章就建好的（V6～V8）；除了 V14 給 `outbox_events` 加的租約欄位 `claimed_until`（7.9.2），欄位一個都不用改 —— 第 02 章 2.3 照著 0.3.4 的「模組與資料歸屬」把它們先建好，這一章只是第一次用它們。

模組依賴沒有變（`ModuleBoundaryTest` 的 6 條規則沒有改）：

- `inventory`、`notification`、`payment` 只依賴 `shared`：它們訂閱事件，但不知道事件是誰發的。
- `ordering` 仍然只依賴 `cart`、`catalog`、`inventory`、`payment`、`shared`：熱點落帳失敗時，`inventory` **不呼叫** `ordering`（那會是一個循環依賴），而是發一個事件，由 `ordering` 自己的消費者取消訂單（7.6.3）。
- 所有模組只認得 `shared.events`（`Outbox`、`EventHandler`、`Event`、`EventTypes`）—— 一個沒有任何 broker 類別的套件。RabbitMQ 只出現在 `shared.messaging.internal` 的五個類別裡（驗收 Q11，7.11.3）。

```
shared/
├── events/                     ← 模組看得到的：沒有任何 broker 的東西
│   ├── Outbox.java             add(aggregateType, aggregateId, eventType, payload)
│   ├── EventHandler.java       consumer()、eventTypes()、handle()、transactional()、onDeadLetter()
│   ├── Event.java、EventTypes.java
│   └── internal/               JdbcOutbox、OutboxStore、EventDispatcher、OutboxMaintenance（只有 SQL）
└── messaging/internal/         ← 只有這裡有 RabbitMQ
    ├── RabbitTopology.java     exchange、佇列、綁定、重試階梯、死信
    ├── RabbitOutboxRelay.java  outbox → broker
    ├── RabbitConsumers.java    broker → EventHandler；重試、死信
    ├── RabbitClientTimeouts.java  通道 RPC 逾時 5 秒（7.4.2、7.9.2）
    └── DeadLetterController.java  死信的查看與重放（7.5.5）
```

**換一個 broker（README 的延伸挑戰：Kafka），要改的就是 `messaging/internal` 這五個檔案。** `events/internal` 的 SQL、五個消費者、所有寫事件的地方，一行都不用動。

---

## 7.4 Outbox

### 7.4.1 寫入端：一句 INSERT

```java
/** 7.4.1 寫入端：一句 INSERT，跟呼叫端的業務寫入在同一個交易裡 */
@Override
@Transactional(propagation = Propagation.MANDATORY)
public String add(String aggregateType, long aggregateId, String eventType, Map<String, ?> payload) {
    String eventId = UUID.randomUUID().toString();
    String body = json.writeValueAsString(payload);
    jdbc.update("""
            INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload, trace_id)
            VALUES (?, ?, ?, ?, ?, ?)""",
            eventId, aggregateType, aggregateId, eventType, body, MDC.get("traceId"));   // traceId：第 09 章才有人放進 MDC
    return eventId;
}
```

`MANDATORY` 是這個方法最重要的一個字：**沒有交易，就沒有「跟它一起 commit」這件事**，那就不該呼叫它 —— Spring 會直接丟 `IllegalTransactionStateException`，而不是默默地自己開一個交易、自己 commit（那就退化成「先寫事件、再寫業務」，業務失敗了事件還在）。

下單交易的最後一步（`PlaceOrderService.placeInTransaction`）：

```java
cart.removeItems(buyerId, ids);                                     // AC-4
// 0.5.4 右欄：通知「訂單成立」、熱點商品的落帳（7.6）。跟訂單一起 commit —— 訂單不存在，這一列也不存在
outbox.add("ORDER", order.getId(), EventTypes.ORDER_PLACED, Map.of("orderId", order.getId(), "orderNo", order.getOrderNo(),
        "buyerId", buyerId, "sellerId", order.getSellerId(), "totalAmount", order.getTotalAmount(),
        "hotProductIds", hotIds.stream().sorted().toList()));
```

狀態轉移（`OrderTransitionService.apply`）在條件式 UPDATE、副作用、歷史之後，多一行 `publish(...)`：`PAID`、`CANCELLED`、`SHIPPED`、`COMPLETED` 各一個事件；`PICKING` 沒有（0.5.4 的右欄是「——」）。完整的 `OrderTransitionService`（`publish()`、`Current` 多讀的四個欄位、退款多帶的 `buyerId`）在 7.13.1。

**下單交易多了一句 `INSERT`，會不會讓它變慢？** 第 04 章的「交易持鎖 ≤ 2 ms」（0.11.5）在意的是**熱點那一列的鎖**。`outbox_events` 的 INSERT 寫的是一列全新的資料（AUTO_INCREMENT 的主鍵），不跟任何人搶同一列。7.6.6 的搶購壓測裡，這一句跟其他七張表的寫入一起量進去了。

### 7.4.2 relay：認領、送出、等確認、標記

```java
/** 一輪。回傳這一輪確認了幾筆。送出與等 confirm 的時候，手上沒有任何資料庫的連線與鎖 */
int relayOnce() {
    List<OutboxStore.Row> rows = claimTx.execute(s -> store.claim(props.relayBatch(), lease));      // ① 認領：短交易、READ COMMITTED
    if (rows == null || rows.isEmpty()) return 0;
    List<CorrelationData> sent = new ArrayList<>(rows.size());
    List<Long> confirmed = new ArrayList<>(rows.size()), failed = new ArrayList<>();
    try {
        for (OutboxStore.Row r : rows) {                                                          // ② 送出（沒有交易）
            CorrelationData cd = new CorrelationData(r.eventId());
            rabbit.send(RabbitTopology.EVENTS, r.eventType(), message(r), cd);
            sent.add(cd);
        }
    } catch (RuntimeException e) {
        // ……沒送出去的放進 failed；一則都沒送出去 → 放掉租約、丟出去……
    }
    long deadline = System.nanoTime() + props.confirmTimeout().toNanos();
    for (int i = 0; i < sent.size(); i++) {                                                      // ③ 一筆一筆等 confirm
        CorrelationData.Confirm c = sent.get(i).getFuture().get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
        if (!c.isAck()) failed.add(…);                                                           // nack
        else if (sent.get(i).getReturned() != null) failed.add(…);                               // confirm 是 ack，但沒有任何佇列收下它
        else confirmed.add(…);
        // ……TimeoutException → failed（broker 可能其實收到了，下一輪再送 = 重複）……
    }
    claimTx.executeWithoutResult(s -> {                                                          // ④ 標記：短交易
        store.markPublished(confirmed);
        store.release(failed);
    });
    return confirmed.size();
}
```

```sql
-- ① 認領：走 V8 的 idx_outbox_unpublished (published_at, id)；V14 的 claimed_until 是租約
SELECT id, event_id, aggregate_type, aggregate_id, event_type, payload, created_at, trace_id
  FROM outbox_events
 WHERE published_at IS NULL AND (claimed_until IS NULL OR claimed_until < CURRENT_TIMESTAMP(3))
 ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED;
UPDATE outbox_events SET claimed_until = CURRENT_TIMESTAMP(3) + INTERVAL ? MICROSECOND WHERE id IN (…);
```

上面是節錄：沒送出去的那幾列怎麼處理、`message()` 的信封格式（消費端與驗收 Q10 都照這個格式讀）、`loop()`、啟動與停止，在 7.13.1 的完整 `RabbitOutboxRelay` 裡；`OutboxStore` 的完整內容也在那裡。

**這是第二版。** 第一版的 ①～④ 在**同一個交易**裡：claim 的那幾列一直鎖到 confirm 回來才 commit。我當時在這一節寫的理由是「鎖住的只是 `outbox_events` 的幾十列，沒有人在等它們」—— 7.9 的演練證明了這句話是錯的：broker 被 `docker pause` 的時候，那個交易跟著卡住，它的鎖擋住了每一張訂單寫 outbox 的那一句 INSERT，連線池在 20 秒內被用光，**整站 503，連商品詳情都是**。過程與量測在 7.9.2。

第二版的四步：

- **① 認領是一個短交易**：`FOR UPDATE SKIP LOCKED` 找出還沒送出、也沒有人認領的列，蓋上租約（`claimed_until` = 現在 + 30 秒），commit。用 **READ COMMITTED**：`FOR UPDATE` 只鎖找到的那幾列，不鎖間隙 —— REPEATABLE READ 的間隙鎖會擋住新的 INSERT（7.6.6 的 H5b 量到過）。`SKIP LOCKED` 讓兩台機器的 relay 拿到不重疊的列（11-messaging/02 的 2.5）。
- **② ③ 送出、等 confirm：沒有交易、沒有鎖、沒有資料庫連線。** 這段可以慢、可以卡住，影響的只有 relay 自己。
- **④ 標記是另一個短交易**：確認了的標成已送出；沒確認的放掉租約，下一輪再認領。行程在 ② ③ 之間死掉 → 租約 30 秒後過期 → 別人（或重啟後的自己）再認領、再送。

這四個細節裡，前兩個要先在 `application.yml` 打開（`compose.yaml` 從第 00 章就有 RabbitMQ，但這一段設定是這一章才加的；`spring:` 底下原本的設定照舊，這裡只列新增的部分）：

```yaml
spring:
  rabbitmq:
    publisher-confirm-type: correlated   # 細節一「等 publisher confirm」：沒有這一行，CorrelationData 的 future 永遠不會完成 —— relay 每一筆都等到逾時，一筆都標不了
    publisher-returns: true              # 細節二「mandatory + 看 getReturned()」：讓 broker 退回的訊息有地方回來
    template:
      mandatory: true                    # 細節二：RabbitTemplate 送出時帶 mandatory。沒有它，沒有佇列收下的訊息會被 broker 默默丟掉，getReturned() 永遠是 null
    connection-timeout: 2s               # 細節四的同一類：broker 不在時，建立連線最多等 2 秒
    requested-heartbeat: 20s             # 細節四的同一類：broker 被凍結時，用戶端靠心跳發現連線死了（7.9.3 的 MissedHeartbeatException）
```

`shop.messaging.*`（`relay-interval`、`relay-batch`、`confirm-timeout`、`relay-enabled`、`consumers-enabled`、`retry-delays`、兩個保留期限）的定義是 `ShopProperties.Messaging`；細節四的 `RabbitClientTimeouts` 只有一個 bean。兩個的完整內容都在 7.13.1。`ShopProperties` 是 `ignoreUnknownFields = false`：設定檔裡的名字拼錯一個字，應用程式就起不來。

四個細節，每一個都對應 11-messaging 某一章的實測：

- **等 publisher confirm**：`send()` 回傳只代表「寫進了 socket」。broker 確認收下之前就標成已送出，broker 在那一刻掛掉，這一則就沒了（11-messaging/05 的 5.2）。
- **`mandatory` + 看 `getReturned()`**：⚠️ **confirm 是 ack，不代表有佇列收下它。** routing key 打錯、消費者的佇列還沒宣告，broker 一樣回 ack，然後把訊息丟掉（11-messaging/01 的 1.3.1 量過：500 則無聲消失）。`mandatory` 讓這種訊息被「退回」，relay 不把它標成已送出。
- **只標確認了的**：nack、退回、逾時，都放掉租約、下一輪再送。
- **RabbitMQ 用戶端的通道 RPC 逾時設成 5 秒**（`RabbitClientTimeouts`）：預設是 10 分鐘。broker 卡住時，relay 會停在用戶端裡面等（7.9.2 的執行緒堆疊）；第二版之後它等的時候手上沒有任何東西，但也不該一等十分鐘。

**它保證的是 at-least-once，不是 exactly-once。** ② 送出、broker 也收下了、③ 也確認了，在 ④ 的 commit 之前行程死掉 —— 那幾列的 `published_at` 還是 NULL，租約過期之後再送一次。7.2.2 量的就是這件事（7.2.2 的五次裡，前兩次跑的是第一版：一輪一個交易；後三次是第二版。兩版的重複都來自同一個窗 ——「broker 確認了、標記還沒 commit」—— 第二版多了一個「租約過期之前不會有人再送」的延遲）。

relay 跑在**自己的一條執行緒**上（`SmartLifecycle` + `ScheduledExecutorService`），不用 Spring 的 `@Scheduled`：`@EnableScheduling` 預設只有一條執行緒，所有排程共用。relay 卡在 broker 上的時候，付款逾時的掃描、熱點對帳不能跟著卡。

**誰宣告佇列、誰先啟動**：exchange、佇列、綁定都在 `RabbitTopology` 的一個 `Declarables` bean 裡（7.5.3），由 Spring Boot 自動設定的 `RabbitAdmin` 在**第一條連線建立的時候**宣告 —— relay 第一次 `send()` 要開連線，宣告就在那之前做完，所以 relay 不會把訊息送進一個還沒有佇列的 exchange。消費者的 `getPhase()` 比 relay 小：消費者先啟動、relay 先停止。但 7.9.4 之後，消費者的 `start()` 只是開一條背景執行緒就回來了，它**不保證**消費者已經接上 broker —— 這也沒關係：訊息已經在佇列裡，消費者接上之後照樣會收到。萬一真的有一則沒有佇列收下（例如拓撲宣告失敗），那正是 `mandatory` 要擋的情況：退回、不標記、下一輪再送。

### 7.4.3 多久輪一次

relay 是輪詢的：每一輪認領一次，沒有東西就等下一輪。間隔越短，事件越快送出；但**沒有任何訂單的時候，它也在輪**。0.6.4 的要求是「通知 60 秒（p99）」「庫存帳落帳 60 秒」—— 寬鬆得很，所以這是一個「要付多少輪詢成本」的問題。

H7 用同樣的流量（每秒 20 張一般商品的訂單、20 秒）跑三種間隔，各兩輪：commit 到 broker 確認（`shop.outbox.publish_delay`）、commit 到通知寄出（`shop.events.lag{consumer=notification.order-events}`），以及**沒有訂單的時候**，MySQL 每秒收到幾句（`Questions` 的差，5 秒）。

```bash
mvn test -Pexperiments -Dtest=H7RelayIntervalTest
```

```
═══ 7.4.3 relay 的輪詢間隔：每秒 20 張訂單、20 秒 ═══
  每 10ms  │ commit → broker 確認 p50   18.6  p99   87.8  最慢  224.9 ms │ commit → 通知寄出 p50   27.8  p99  167.2 ms │ 沒有訂單時 MySQL 388.2 句/秒
  每 100ms │ commit → broker 確認 p50   79.4  p99  234.6  最慢  375.2 ms │ commit → 通知寄出 p50   99.6  p99  317.7 ms │ 沒有訂單時 MySQL  64.4 句/秒
  每 1s    │ commit → broker 確認 p50  633.3  p99 2948.6  最慢 3160.9 ms │ commit → 通知寄出 p50  922.7  p99 4009.8 ms │ 沒有訂單時 MySQL   7.0 句/秒
  每 10ms  │ commit → broker 確認 p50   20.7  p99  251.4  最慢  557.6 ms │ commit → 通知寄出 p50   30.9  p99  284.7 ms │ 沒有訂單時 MySQL 399.0 句/秒
  每 100ms │ commit → broker 確認 p50  125.3  p99  368.6  最慢 1745.2 ms │ commit → 通知寄出 p50  148.9  p99  434.1 ms │ 沒有訂單時 MySQL  63.0 句/秒
  每 1s    │ commit → broker 確認 p50  569.4  p99 1072.7  最慢 1147.1 ms │ commit → 通知寄出 p50  666.9  p99 1203.8 ms │ 沒有訂單時 MySQL   7.0 句/秒
```

（跑的時候 load average 12～17。這是 7.9.2 修正之後的 relay；修正之前也跑過一次，延遲是同一個量級，閒置的句數少得多 —— 間隔 100 ms 時是每秒 35～37 句、10 ms 時 85～232 句。原因在下面。）

- **每 1 秒**：commit 到送出的 p50 是 0.57～0.63 秒 —— 平均要等半個間隔，加上 confirm。通知的 p99 1.2～4.0 秒。閒著的時候每秒 7 句。
- **每 100 ms**：p50 79～125 ms，通知的 p99 0.32～0.43 秒。閒著每秒 63～64 句。
- **每 10 ms**：p50 19～21 ms，通知的 p99 0.17～0.28 秒。閒著每秒 **388～399 句**。

閒著的時候那幾十句是什麼？H7b 用 MySQL 的 general log 錄 2 秒（間隔 100 ms，沒有任何訂單）：

```bash
mvn test -Pexperiments -Dtest=H7bIdlePollTest
```

```
═══ 7.4.3 沒有訂單的 2 秒，shop 送給 MySQL 的句子（relay 每 100 ms 一輪）═══
    18  SELECT @@session.transaction_isolation
    18  SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED
    18  SET autocommit=0
    18  SELECT id, event_id, aggregate_type, aggregate_id, event_type, payload, created_at, trace_id FROM outbox_event
    18  commit
    18  SET autocommit=1
    18  SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ
     1  SELECT COUNT(*), COALESCE(TIMESTAMPDIFF(MICROSECOND, MIN(created_at), CURRENT_TIMESTAMP(3)), 0) / 1e6 FROM out
```

**每一輪 7 句，真正有用的只有一句 `SELECT … FOR UPDATE SKIP LOCKED`。** 開交易、關交易是 4 句（`autocommit=0`、`commit`、`autocommit=1`，與那一句查詢）；另外 3 句是 READ COMMITTED 的代價：Spring 的交易管理器（經由 Connector/J）先問目前的隔離等級，改成 READ COMMITTED，交易結束再改回 REPEATABLE READ。7.9.2 之前的 relay 用預設的隔離等級，一輪 4 句 —— 這就是閒置成本翻倍的原因。2 秒 18 輪（間隔 100 ms 是「上一輪做完之後」再等 100 ms），7 × 9 ≈ 每秒 63 句，跟 H7 對得上。

**這一章用 100 ms。** 三種都遠在 0.6.4 的 60 秒之內；100 ms 比 1 秒快了一個數量級，比 10 ms 便宜六倍。每一台機器每秒 63 句，三台就是近 200 句 —— 0.6.1 的一般尖峰是每秒 83 個請求，**這個輪詢成本比整個網站的流量還高**，不是「可以忽略」。要更快又不想付這個成本，有兩條路：commit 之後「叫醒」relay（通常的情況下立刻送，輪詢只當備援），或者改用 CDC 讀 binlog（11-messaging/02 的 2.7）—— 練習五。另一個便宜的改法：先用一句**不加鎖**的一般查詢（`SELECT 1 … WHERE published_at IS NULL … LIMIT 1`，一般的讀不拿鎖）看看有沒有事做，有才開 READ COMMITTED 的交易 —— 空的那幾輪就從 7 句變成 1 句。（不能反過來「空的那一輪用 REPEATABLE READ 就好」：REPEATABLE READ 底下，`FOR UPDATE` 就算一列都沒找到，也會鎖住間隙。）

### 7.4.4 outbox 會長：指標與清理

0.6.7：「`outbox_events`（已送出）3 天」、「`processed_messages` 7 天」。`OutboxMaintenance` 每 10 分鐘清一輪，一次刪 1,000 列、刪到沒有為止 —— 11-messaging/02 的 2.6 量過一句 `DELETE` 刪 130 萬列會鎖住什麼：

```java
public int deletePublishedBefore(Instant before, int limit) {
    return jdbc.update("DELETE FROM outbox_events WHERE published_at < ? ORDER BY published_at LIMIT ?", Timestamp.from(before), limit);
}
```

0.6.6 的兩個指標也在這裡：`shop.outbox.pending`、`shop.outbox.oldest_age_seconds`。它們每 5 秒查一次存起來，而不是每次被抓指標就打一次 MySQL —— Prometheus 每 15 秒抓一次、三台機器，就是每分鐘 12 句；看起來不多，但它是「為了看系統健不健康而給系統增加負擔」，能省就省。`oldest_age_seconds > 60` 是 0.6.6 的告警線（第 09 章接上）。

---

## 7.5 消費端

### 7.5.1 `EventHandler`：模組只寫「收到之後做什麼」

```java
public interface EventHandler {
    /** 消費者的名字。佇列（shop.{consumer}）、死信佇列、processed_messages.consumer 都用它 */
    String consumer();
    /** 訂閱哪些事件（EventTypes 的常數，也就是 routing key） */
    Set<String> eventTypes();
    /** 丟出任何例外 = 這一次失敗，訊息會走重試階梯（1、2、4、8、16 秒），5 次之後進死信佇列 */
    void handle(Event event);
    /** true（預設）：handle() 跟 processed_messages 那一列同一個交易。false：自己負責冪等（寄信、金流） */
    default boolean transactional() { return true; }
    /** 重試用完、送進死信佇列之前呼叫一次 */
    default void onDeadLetter(Event event, Exception lastError) {}
    default int concurrency() { return 2; }
}
```

五個實作：

| 消費者 | 模組 | 訂閱 | `transactional()` | 冪等靠什麼 |
|---|---|---|---|---|
| `inventory.hot-settlement` | inventory | `order.placed` | true | `processed_messages` ＋ 預留列的 `counted`（7.6.2） |
| `inventory.hot-stock-return` | inventory | `inventory.stock-returned` | true | `processed_messages`；漏掉的是「偏高」（7.6.5） |
| `ordering.stock-shortage` | ordering | `inventory.hot-settlement-failed` | true | `processed_messages` ＋ 狀態機（`CANCELLED + E10 = ＝`） |
| `notification.order-events` | notification | 5 種 | **false** | `notifications.dedup_key` ＋ 認領（7.7） |
| `payment.refunds` | payment | `refund.requested` | **false** | `refunds.status` ＋ 金流的冪等鍵（7.8） |

**模組不碰 broker。** `RabbitTopology` 替每一個 `EventHandler` 宣告佇列與綁定（7.5.3）；`RabbitConsumers`（`shared.messaging.internal`）在啟動時替每一個 `EventHandler` 建一個 listener container（手動 ack、`prefetch 10`），收到訊息之後：

```
處理成功（或重複）                  → ack
失敗，還有重試次數                  → 複製一份送進下一級 retry 佇列，confirm 了才 ack 原本那一則
失敗，用完了                        → handler.onDeadLetter() → 送進 shop.{consumer}.dlq → ack
JSON 解析失敗                        → 直接進死信：重試也不會變好（11-messaging/10 的 10.2.6）
訂閱清單裡沒有這個事件類型（7.5.3） → 記一行 EVENT_MISROUTED，ack、丟掉這一份
```

「送到下一個地方、confirm 了才 ack」這個順序讓轉送也是 at-least-once：轉送成功、ack 之前行程死掉，同一則會在原佇列與 retry 佇列各有一份 —— 重複，交給冪等處理。反過來（先 ack 再轉送）就會掉。

`RabbitConsumers` 的完整內容 —— 重試次數怎麼記在 `shop-attempt` header 上（`parse()` 讀、`copy()` 加一）、`settle()` 怎麼「先轉送、等 confirm、再 ack」、container 的設定 —— 在 7.13.1；消費者收到的 `Event` record 也在那裡。

> 📌 **這條 at-least-once 有一段不歸我們管：重試佇列「到期 → 回原佇列」那一跳。** 消費者把訊息送進 `shop.retry.{1s…16s}` 時等了 confirm；但 TTL 到期之後，訊息經由 dead-letter 送到 `shop.retry.return`、再回到原佇列，是 **broker 自己轉送**的，不經過任何 publisher confirm。RabbitMQ 的 dead-lettering 預設是 at-most-once：轉送的那一刻 broker 出事，或者 headers exchange 找不到任何一條綁定（例如消費者改了名字，新佇列的綁定條件對不上舊訊息上的 `shop-target`），那一則就**無聲地**沒了 —— 不會進死信佇列，消費者那一側也沒有任何日誌。
> quorum 佇列可以把這一跳改成 at-least-once（佇列參數 `x-dead-letter-strategy: at-least-once`，前提是那個佇列設了 `overflow: reject-publish`）。這一章沒有改：重試佇列沒有設 `overflow`，這一跳仍然是 at-most-once。要發現它掉了東西，只能拿 `shop.events.retried` 跟後續的處理結果對帳。

### 7.5.2 冪等：`processed_messages` 跟效果同一個交易

```java
public Outcome dispatch(EventHandler handler, Event event) {
    if (!handler.transactional()) {                                     // 自己負責冪等（寄信、金流，7.7、7.8）
        handler.handle(event);
        return Outcome.PROCESSED;
    }
    Outcome o = tx.execute(s -> {
        try {
            jdbc.update("INSERT INTO processed_messages (consumer, message_id) VALUES (?, ?)", handler.consumer(), event.eventId());
        } catch (DuplicateKeyException dup) {
            return Outcome.DUPLICATE;                                   // 處理過了：這個交易什麼都沒寫，commit 也無妨
        }
        handler.handle(event);
        return Outcome.PROCESSED;
    });
    // ……DUPLICATE 記一筆 shop.events.duplicates{consumer}……
    return o;
}
```

這是 11-messaging/03 的 3.3.2「寫法二」，三個細節：

- **`INSERT` 在 `handle()` 之前。** 同一個 eventId 同時被兩條執行緒處理（7.11.2 的 Q10 故意這樣送），第二條會在這一句**等第一條 commit**（主鍵的鎖），然後撞鍵、什麼都不做。如果 `INSERT` 放在 `handle()` 之後，兩條會各自做一次 `reserved += 1`，最後才有一條撞鍵 rollback —— 結果一樣對，但兩條都搶過一次熱點列的鎖。
- **撞鍵在交易裡被接住，交易照常 commit。** MySQL 的重複鍵錯誤只讓那一句失敗，不會讓整個交易失效；Spring 的 `JdbcTemplate` 丟出來的 `DuplicateKeyException` 在 `TransactionTemplate` 的 callback 裡被接住，也不會把交易標成 rollback-only。
- **`processed_messages` 的主鍵是 `(consumer, message_id)`**（V8）：同一個事件，五個消費者各自記一筆。`order.placed` 對落帳是「處理過了」，對通知可能還沒。

`HotSettlementTest.duplicateCountsOnce` 把它寫成測試：同一則 `order.placed` 交付兩次。

```
7.5.2 同一則交付兩次：PROCESSED、DUPLICATE；{reserved=1, reservation=HELD, counted=1, ledger=1}
```

7.2.3 說過它的界線：**它只保護「跟它在同一個交易裡」的效果。** 通知與退款的效果不在 MySQL 裡，所以那兩個消費者 `transactional() = false`，各自用自己的業務鍵（7.7、7.8）。

### 7.5.3 重試階梯與死信 —— 以及第一版的那場風暴

NTF-1 AC-4：「通知服務連續失敗 → **重試 5 次（指數退避）後進死信**；下單不受影響」。0.5.4：退款「可重試，失敗進死信 + 告警」。

11-messaging/06 量過兩種退避：本地重試（`Thread.sleep` 卡住消費者執行緒，6.3.1：一則壞訊息讓 20 則好訊息等了 7 秒）與死信回送（等待交給 broker 的 TTL）。這一章用後者，而且每一級一個佇列（6.4.1：同一個佇列裡每則訊息自己的 TTL 會隊頭阻塞）：

```java
for (Duration delay : props.messaging().retryDelays()) {             // 1s, 2s, 4s, 8s, 16s
    Queue q = QueueBuilder.durable(retryQueue(delay)).quorum()
            .ttl((int) delay.toMillis())
            .deadLetterExchange(RETRY_RETURN)                       // 沒有 dead-letter routing key：靠 headers 回去
            .build();
    d.add(q);
    d.add(BindingBuilder.bind(q).to(retry).with(tier(delay)));
}
for (EventHandler h : handlers) {
    // ……主佇列、死信佇列、事件的綁定……
    d.add(BindingBuilder.bind(main).to(retryReturn).whereAll(Map.of(TARGET_HEADER, queue(h))).match());
}
```

（完整的 `RabbitTopology` 在 7.13.1。）

11-messaging/06 的 6.9 只有一個消費者，重試佇列過期之後用固定的 dead-letter routing key 回到主佇列。這個專題有五個消費者，**五個共用同一組重試佇列**：過期的訊息要回到「它從哪裡來」的那一個佇列。做法是 headers exchange：轉送到重試佇列時，在訊息上蓋一個 header 寫著原佇列的名字，`shop.retry.return` 依這個 header 把它送回去。

#### ⚠️ 第一版：一個 SMTP 失敗，3.9 秒、209 次重試、281 則死信、一張訂單被取消

第一版的 header 叫 `x-shop-target`。`EventFlowTest.mailerDownDeadLetters` 讓模擬的 SMTP 一直失敗、下一張一般商品的訂單，期待：通知重試 5 次之後 `FAILED`、死信佇列 1 則、訂單照常是 `PENDING_PAYMENT`。結果：

```
NTF-1 AC-4：{status=FAILED, attempts=36}；死信佇列 2 則；訂單 20261002-775165 狀態 CANCELLED
[ERROR] com.example.shop.ordering.internal.EventFlowTest.mailerDownDeadLetters -- Time elapsed: 3.863 s <<< FAILURE!
```

**`attempts = 36`，應該是 6。訂單被取消了 —— 這個測試從頭到尾沒有任何人取消它。**

日誌裡，同一個 eventId 的 `order.placed` 出現在**不該出現的**消費者那裡：

```
EVENT_RETRY consumer=notification.order-events eventId=760abdcb-… type=order.placed attempt=1，PT0.1S 後重試：…SimulatedMailer$MailException: SMTP 連不上
EVENT_RETRY consumer=payment.refunds eventId=760abdcb-… type=order.placed attempt=2，PT0.2S 後重試：java.lang.IllegalArgumentException: 事件 order.placed 沒有欄位 refundId
EVENT_RETRY consumer=payment.refunds eventId=760abdcb-… type=order.placed attempt=3，PT0.4S 後重試：java.lang.IllegalArgumentException: …
```

`payment.refunds` 根本沒有訂閱 `order.placed`。數一數這 3.9 秒（加上後面的測試）的日誌：

| 消費者 | 收到不該收的事件、重試 | 進了死信 |
|---|---|---|
| `inventory.hot-stock-return` | `order.placed` 37 次、`order.cancelled` 35 次 | 137 則 |
| `payment.refunds` | `order.placed` 37 次、`order.cancelled` 35 次 | 137 則 |
| `notification.order-events` | `order.placed` 32 次、`order.cancelled` 33 次 | 7 則 |
| **合計** | **209 次重試** | **281 則** |

而 `ordering.stock-shortage` 一次重試都沒有 —— **因為它每一次都「成功」了**：它收到 `order.placed` 的副本，`handle()` 只讀 `orderId`，對那張訂單套用 E10（庫存不足）→ `CANCELLED`。那張訂單、那封 `order.cancelled`、以及下一個測試收到的兩封莫名其妙的「訂單成立」「訂單已取消」，都是從這裡來的。

**原因：headers exchange 在 `x-match = all` 時，不看 `x-` 開頭的 header。** 綁定上的 `x-shop-target = shop.payment.refunds` 等於沒有寫，五個綁定都變成「無條件」—— 每一次重試，都被送回**每一個**消費者的佇列；它們各自失敗、各自重試，又各自送回每一個佇列。

H4 把它單獨量出來：同一個 headers exchange，三種綁定方式，每種兩個佇列（target = A、target = B），送一則 target = A 的訊息：

```bash
mvn test -Pexperiments -Dtest=H4HeadersMatchTest
```

```
═══ 7.5.3 headers exchange：送一則 target = A 的訊息，誰收到？═══
  x-match=all，header 叫 x-shop-target           A 佇列 1 則、B 佇列 1 則
  x-match=all，header 叫 shop-target             A 佇列 1 則、B 佇列 0 則
  x-match=all-with-x，header 叫 x-shop-target    A 佇列 1 則、B 佇列 0 則
```

（跑兩次，一模一樣。）第三列說明這台 RabbitMQ（3.13）有 `x-match = all-with-x`，會把 `x-` 開頭的也算進去；這一章選擇直接改名（`shop-target`、`shop-attempt`、`shop-error`）—— `x-` 是 broker 自己用的前綴（`x-death`、`x-match`、`x-message-ttl`），應用程式的 header 本來就不該用它。

#### ⚠️ 修好了，舊的綁定還在

改名、重新啟動、重跑 `EventFlowTest`：5 個測試全綠，`attempts = 6`、死信 1 則、訂單 `PENDING_PAYMENT`。但日誌裡多了這個：

```
EVENT_MISROUTED consumer=payment.refunds 沒有訂閱 order.placed（eventId=…）：丟掉這一份
```

15 次（5 次重試 × 3 個不該收的佇列）。broker 上的綁定：

```bash
docker exec shop-rabbitmq-1 rabbitmqctl list_bindings source_name destination_name arguments \
  | grep 'shop.retry.return' | sed -E 's/\[.*"(x-shop-target|shop-target)".*/\1/' | sort | uniq -c
```

```
   1 shop.retry.return	shop.inventory.hot-settlement	shop-target
   1 shop.retry.return	shop.inventory.hot-settlement	x-shop-target
   1 shop.retry.return	shop.inventory.hot-stock-return	shop-target
   1 shop.retry.return	shop.inventory.hot-stock-return	x-shop-target
   1 shop.retry.return	shop.notification.order-events	shop-target
   1 shop.retry.return	shop.notification.order-events	x-shop-target
   1 shop.retry.return	shop.ordering.stock-shortage	shop-target
   1 shop.retry.return	shop.ordering.stock-shortage	x-shop-target
   1 shop.retry.return	shop.payment.refunds	shop-target
   1 shop.retry.return	shop.payment.refunds	x-shop-target
```

每一個佇列都有新舊兩條綁定。

**Spring 的 `RabbitAdmin` 只會「宣告」，不會「刪除」。** 新的綁定加上去了，舊的（無條件的）那一條還在 broker 上。拓撲改了，部署之後要有人把舊的拿掉 —— 這裡是本機，直接刪掉那個 exchange、讓下一次啟動重新宣告；正式環境要照 11-messaging/04 4.6.4 那套「新名字 → 雙綁 → 排乾 → 刪」的流程。

#### 最後一道防線：消費者只處理自己訂閱的事件

那 15 次 `EVENT_MISROUTED` 沒有造成任何傷害，因為修正的同時多加了這一段（`RabbitConsumers.onMessage`）：

```java
if (!h.eventTypes().contains(e.type())) {
    // 7.5.3：拓撲出錯（第一版的重試把訊息送回了每一個佇列）時的最後一道防線 —— 不要讓一個路由的 bug 變成一個業務動作
    // （ordering.stock-shortage 收到 order.placed，就會把一張好好的訂單取消掉）。正確的佇列有它自己的那一份
    log.error("EVENT_MISROUTED consumer={} 沒有訂閱 {}（eventId={}）：丟掉這一份", h.consumer(), e.type(), e.eventId());
    counter("shop.events.misrouted", h).increment();
    ch.basicAck(tag, false);
    return;
}
```

> 📌 **這場風暴的每一個零件都是「對的」。** 每一級一個重試佇列（11-messaging/06 的建議）、共用重試佇列（少開 20 個佇列）、headers 決定回去的地方、消費者 `handle()` 只讀它需要的欄位。它們放在一起，一個 SMTP 的失敗在 3.9 秒裡長成 281 則死信，**並且取消了一張訂單**。
> 只有「端到端、真的 broker、真的讓一個東西失敗」的測試看得到它：單元測試裡沒有 headers exchange，`InlineEvents`（7.12.1）也不經過 broker。**拓撲是程式碼，而且是最少被測試的那一種。**

### 7.5.4 順序

11-messaging/05 的 5.5 量過：多個消費者（`concurrency = 2`）就沒有順序。這一章的五個消費者都**不依賴順序**，每一個都是靠「資料目前的狀態」決定要做什麼，而不是靠「上一則訊息是什麼」：

- **落帳 vs 取消**：買家在落帳之前取消（取消的交易把預留列改成 `RELEASED`）→ 遲到的 `order.placed` 找不到 `counted = FALSE` 而且還有效的預留列，什麼都不做。`HotSettlementTest.cancelBeforeSettlement`：

```
7.6 先取消、後落帳：{reserved=0, reservation=RELEASED, counted=0, ledger=0}；Redis stock = 5
```

- **落帳失敗 vs 出貨**：7.6.4。
- **取消 vs 庫存不足**：兩個都想把訂單改成 `CANCELLED`，狀態機的條件式 UPDATE 只會讓一個成功；另一個看到 `CANCELLED + E10 = ＝`（或 `CANCELLED + E3 = ＝`），什麼都不做。
- **通知**：「訂單已取消」可能比「訂單成立」先寄到。這一章接受它 —— 每一封通知自己帶著訂單編號與狀態，不需要讀者按順序讀；要嚴格順序，11-messaging/05 的 5.5.5（`x-single-active-consumer`）是代價最低的做法（練習三）。

### 7.5.5 死信：看得到、放得回去

死信佇列裡的每一則，都是「重試 5 次還是失敗」的事：SMTP 掛了 31 秒以上、金流掛了、或者程式有 bug。0.6.6 的告警是「DLQ 深度 > 0」—— **每一則死信都要有人看**。看完、修好原因之後，要能把它放回去（11-messaging/10 的 10.5.3 重放 SOP）：

```
GET  /api/admin/dead-letters                          每一個消費者的死信佇列裡有幾則
POST /api/admin/dead-letters/{consumer}/replay?max=   放回原佇列，重試次數歸零
```

```java
var got = ch.basicGet(dlq, false);                          // 手動 ack：放回去確認了，才從死信佇列拿掉
MessageProperties props = converter.toMessageProperties(got.getProps(), got.getEnvelope(), "UTF-8");
props.setHeader(RabbitTopology.ATTEMPT_HEADER, 1);
CorrelationData cd = new CorrelationData(props.getMessageId());
rabbit.send("", target, new Message(got.getBody(), props), cd);   // 預設 exchange：routing key = 佇列名稱，直接送回原佇列
// ……confirm 了才 basicAck；失敗 basicNack(requeue = true)，死信留在原地……
```

完整的 `DeadLetterController` 在 7.13.1。

三件事：

- **重放是管理員的維運動作**：只有 `ADMIN`，寫一筆 `DEAD_LETTERS_REPLAYED` 的稽核（US-AUD-1：所有管理員動作）。
- **送回「原佇列」，不是送回 `shop.events`**：送回 exchange 會讓**每一個**訂閱了這個事件的消費者再收到一次 —— 剛剛那場風暴的另一種版本。冪等會擋下來，但沒有理由製造它。
- **先修好原因，再重放。** 不然 31 秒之後它會原封不動地回到死信佇列（11-messaging/10 的 10.5.2：「一個很慢的無窮迴圈」）。

`DeadLetterReplayTest` 把這整段走一次：

```
7.5.5：死信 {"consumer":"notification.order-events","queue":"shop.notification.order-events.dlq","messages":1} → 重放 HTTP 200 {"consumer":"notification.order-events","replayed":1,"remaining":0} → 通知 SENT；買家打重放 → 403；稽核 1 筆
```

---

## 7.6 熱點落帳移出下單交易

### 7.6.1 熱點是那一個數字，不是那一筆預留

第 04 章的下單交易，對每一個品項做三件事（`JdbcInventoryService.reserve`）：

```sql
UPDATE inventory SET reserved = reserved + ? WHERE product_id = ? AND on_hand - reserved >= ?   -- 熱點那一列：X 鎖，直到 commit
INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (?, ?, ?, 'HELD')
INSERT INTO inventory_ledger (…, reason) VALUES (…, 'RESERVE')
```

500 個交易排隊的是第一句：**所有人都要改同一列的同一個數字**。第二句寫的是每一張訂單**自己的**那一列（主鍵是自增的，彼此不衝突）；第三句也是。

所以要移出交易的只有「那一個數字」。預留列照樣在下單交易裡寫 —— 它是「這張訂單佔了一件」的紀錄，跟訂單同生共死；只是它的數量**還沒有加到** `inventory.reserved` 上。用一個欄位記住這件事：

```sql
-- V13__inventory_reservation_counted.sql
-- 7.6 熱點商品的預留，數量「之後」才計入 inventory.reserved：下單交易只寫這一列（counted = FALSE），
-- 由消費者在幾秒內把數量加到 inventory 那一列、改成 TRUE。既有的每一列都已經計入了，所以預設 TRUE。
-- INV-2 從此是：reserved = Σ（HELD + CONFIRMED 而且 counted）
-- 一句 DDL、ALGORITHM=INSTANT：只改資料字典，30 萬列的表 25～65 ms（7.6.1）
ALTER TABLE inventory_reservations ADD COLUMN counted BOOLEAN NOT NULL DEFAULT TRUE, ALGORITHM=INSTANT;
```

`ALGORITHM=INSTANT` 是寫之前量過的：把 10 萬張訂單、30 萬筆預留複製到 `shop_ddl`，同一句跑三次：

```
Query_ID	Duration	Query
1	0.06514825	ALTER TABLE inventory_reservations ADD COLUMN settled BOOLEAN NOT NULL DEFAULT TRUE
1	0.04658125	ALTER TABLE inventory_reservations ADD COLUMN settled BOOLEAN NOT NULL DEFAULT TRUE
1	0.02501575	ALTER TABLE inventory_reservations ADD COLUMN settled BOOLEAN NOT NULL DEFAULT TRUE
```

（量的時候欄位還叫 `settled`，後來改名成 `counted`；三次是三個 `SHOW PROFILES` 的第一列。）MySQL 8.0 把「加在最後、有預設值」的欄位做成只改資料字典：**30 萬列，25～65 ms，不用複製表**。在真的 `shop` 上，Flyway 記下的 V13 是：

```
version	description	execution_time	installed_on
13	inventory reservation counted	311	2026-10-02 02:37:27
```

（311 ms 包含 Flyway 自己的工作：取得鎖、算 checksum、寫 `flyway_schema_history`。）

為什麼是 `counted` 而不是加一個預留狀態（例如 `PENDING`）？因為**預留的生命週期沒有變**：`HELD → CONFIRMED → CONSUMED / RELEASED`，付款、取消、出貨、逾時的程式碼都照舊。改變的只有「數量什麼時候加到那一列上」，那是一個跟狀態正交的事實。加一個狀態的話，`confirm()` 要決定 `PENDING` 付款之後變成什麼、`release()` 要多一條路 —— 而且要改 `ck_reservations_status` 這個 CHECK，那是 7.6.3 量到的另一種 DDL。

### 7.6.2 下單只寫預留列；消費者計入

下單交易（`PlaceOrderService.placeInTransaction`）把品項分成兩種：

```java
// 7.6 熱點品項（已經過了 Redis 的閘門）只寫預留列，數量由消費者之後計入；其他品項照第 04 章，在這個交易裡計入
List<ReserveLine> normal = lines.stream().filter(l -> !hotIds.contains(l.productId())).map(…).toList();
if (!normal.isEmpty()) inventory.reserve(order.getId(), normal);
if (!hot.isEmpty()) inventory.holdHot(order.getId(), hot);
```

```java
@Override
@Transactional(propagation = Propagation.MANDATORY)
public void holdHot(long orderId, List<ReserveLine> lines) {
    // 只有預留列。inventory 那一列一個字都不碰 —— 搶購時 500 個交易排的就是那一列的鎖（6.5.4）
    for (ReserveLine l : lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList())
        jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status, counted) VALUES (?, ?, ?, 'HELD', FALSE)",
                orderId, l.productId(), l.quantity());
}
```

**一般商品不變**：條件式 UPDATE 仍然在下單交易裡，0.6.4「下單時的可售庫存判斷：強一致」照舊。熱點商品的「判斷」移到了 Redis 的閘門（第 06 章），MySQL 的那一句條件式 UPDATE 移到了消費者 —— 它**仍然是最後一道防線**（6.5.3），只是不再在請求的路上。

`order.placed` 帶著 `hotProductIds`，`inventory.hot-settlement` 消費者呼叫 `settleHot(orderId)`（交易由 `EventDispatcher` 開，`processed_messages` 同一個交易）：

```java
int settleHot(long orderId) {
    List<Held> lines = jdbc.query("""
            SELECT id, product_id, quantity, counted FROM inventory_reservations
             WHERE order_id = ? AND status IN ('HELD', 'CONFIRMED') AND counted = FALSE ORDER BY product_id FOR UPDATE""", …);
    for (Held h : lines) {                                              // ② 先全部檢查（全有或全無：US-ORD-1 AC-5）
        Integer available = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ? FOR UPDATE", Integer.class, h.productId());
        if (available == null || available < h.quantity()) {
            // ……那一列 RELEASED、發 inventory.hot-settlement-failed（7.6.3）……
            return -1;
        }
    }
    for (Held h : lines) {                                              // ③ 都夠：計入
        int n = jdbc.update("""
                UPDATE inventory SET reserved = reserved + ?, updated_at = CURRENT_TIMESTAMP(3)
                 WHERE product_id = ? AND on_hand - reserved >= ?""", h.quantity(), h.productId(), h.quantity());
        if (n != 1) throw new IllegalStateException("inventory " + h.productId() + " 已經鎖住而且檢查過了，UPDATE 卻沒有成功");
        jdbc.update("UPDATE inventory_reservations SET counted = TRUE, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
        ledger(h.productId(), 0, h.quantity(), "RESERVE", "order:" + orderId);
    }
    return lines.size();
}
```

鎖的順序跟 `release()`（取消）一樣：**先預留列、再 `inventory` 列**。取消與落帳碰上同一張訂單，第二個人會在第一句排隊，進來時看到的已經是對方的結果（`RELEASED`，或 `counted = TRUE`）—— 不會死鎖，也不會重複。

**取消也要知道 `counted`。** 第 04 章的 `release()` 對每一列預留都做 `reserved -= quantity`、記一筆 `RELEASE`。現在多了一種預留，它的數量**從來沒有加到** `reserved` 上：落帳之前就被取消的熱點預留（7.5.4 的「先取消、後落帳」）。照舊減下去，`reserved` 會比真的少一件 —— 減成負數時 `ck_inventory_reserved`（`reserved >= 0`）擋下來，整個取消交易失敗；剛好有別張訂單的 `reserved` 墊著時，減下去不會報錯，INV-2 從此對不上。所以 `release()` 只對**已經計入**的那幾列減 `reserved`、記 `RELEASE`；沒有計入的，只改成 `RELEASED`：

```java
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
```

`Held` 多了一個 `counted` 欄位，`held()` 的 SELECT 跟著多讀一欄。`returnToHotStock()`（7.6.5），以及 `consume()`、`restock()`、`restockBatch()` 在這一章的版本，在 7.13.1。

`EventFlowTest.hotSettlesAfterCommit` 走一次真的 relay 與 RabbitMQ：

```
7.6：下單剛回來 {counted=false, reserved=0} → 落帳之後 {counted=true, reserved=1, reserve_ledger=1}；Redis stock = 4
```

**下單剛回來的時候，MySQL 的 `reserved` 是 0。** 這是設計，也是代價：從 commit 到消費者處理完的這段時間（7.6.6 量了它），MySQL 的 `on_hand - reserved` 比真的可售量多。兩個地方要跟著改：

- **INV-2**：`reserved = Σ（HELD + CONFIRMED **而且 counted**）`。`InvariantReconciliationTest` 與 7.10 的對帳排程都改了這一句。
- **Redis 的閘門該是多少**（6.5.1 建立、6.6 對帳）：要再扣掉「還沒計入」的。否則對帳看到「Redis 比 MySQL 少」—— 正是 7.2.1 的 naive 被對帳「修正」成超賣的那一步。

```java
static final String GATE_BASE_SQL = """
        SELECT i.on_hand - i.reserved - COALESCE((SELECT SUM(r.quantity) FROM inventory_reservations r
                                                   WHERE r.product_id = i.product_id AND r.status IN ('HELD', 'CONFIRMED')
                                                     AND r.counted = FALSE), 0)
          FROM inventory i WHERE i.product_id = ?""";
```

一句 SQL：落帳把 `counted` 從 FALSE 改成 TRUE、把同樣的數量加到 `reserved` 上，是同一個交易 —— 這句讀到的永遠是其中一邊，不會兩邊都算或兩邊都沒算。`HotSettlementTest.reconcileSubtractsUncounted`：兩張還沒落帳的訂單、把 Redis 故意改成 99、對帳兩輪：

```
7.6.2 對帳：MySQL {on_hand=5, reserved=0}、未計入 2 → Redis 3（只看 on_hand - reserved 會是 5）
```

### 7.6.3 偏高的代價變了

6.5.3 的那張表，第一列是「Redis 偏高：多放一些請求進 MySQL，MySQL 會擋下（409）—— **浪費，但不會超賣**」。

這一章之後，這句話後半還成立（MySQL 不會超賣：消費者的條件式 UPDATE 照樣擋），前半不成立了：**MySQL 不在請求的路上，它擋下來的時候，買家已經拿到 201 了。** 偏高的那幾件，要到落帳時才發現不夠 —— 訂單得取消。

什麼時候 Redis 會偏高？6.2.5 V3 量過的「對帳的 CAS 多算 1」、6.13.2 練習二的「Redis 的資料丟了、從 MySQL 重建」—— 重建的那一刻，已經過了閘門、還沒 commit 的訂單，兩邊都沒算到。H8 量了後者：

2,000 個買家搶 500 件、每秒 200 個（200 條共用執行緒，6.9.1 的模型），在第 1 秒 `FLUSHALL`；對照組不清。等落帳與取消都做完之後，數「回了 201 之後才被 E10 取消」的訂單：

```bash
mvn test -Pexperiments -Dtest=H8FlushDuringSaleTest
```

```
═══ 7.6.3 2,000 個買家搶 500 件（每秒 200 個）；第 1 秒 FLUSHALL ═══
  對照（不清）       下單 {201=500, 409=1500} │ 落帳之後：有效訂單 500、reserved 500、回了 201 之後才被取消（E10）0 張 │ Redis stock = 0 │ Redis 失敗 0 次、跳開 0 次 │ load 10.37
  FLUSHALL     下單 {201=516, 409=1363, 503=121} │ 落帳之後：有效訂單 500、reserved 500、回了 201 之後才被取消（E10）16 張 │ Redis stock = 0 │ Redis 失敗 9 次、跳開 3 次 │ load 11.85
  FLUSHALL     下單 {201=509, 409=1491} │ 落帳之後：有效訂單 500、reserved 500、回了 201 之後才被取消（E10）9 張 │ Redis stock = 0 │ Redis 失敗 0 次、跳開 0 次 │ load 13.28
  對照（不清）       下單 {201=500, 409=1500} │ 落帳之後：有效訂單 500、reserved 500、回了 201 之後才被取消（E10）0 張 │ Redis stock = 0 │ Redis 失敗 0 次、跳開 0 次 │ load 11.90
  FLUSHALL     下單 {201=523, 409=733, 503=741, CannotCreateTransactionException=3} │ 落帳之後：有效訂單 500、reserved 500、回了 201 之後才被取消（E10）23 張 │ Redis stock = 0 │ Redis 失敗 51 次、跳開 17 次 │ load 27.00
  FLUSHALL     下單 {201=515, 409=376, 503=1109} │ 落帳之後：有效訂單 500、reserved 500、回了 201 之後才被取消（E10）15 張 │ Redis stock = 0 │ Redis 失敗 14 次、跳開 4 次 │ load 29.12
```

**對照組：0 張。FLUSHALL：16、9、23、15 張 —— 它們都拿到了 201，幾秒後被取消。** MySQL 每一輪都是 `reserved = 500`、有效訂單 500 張：**沒有超賣**，最後一道防線照樣擋住了。這個實驗前後跑了三次（中間改過兩次程式碼：加 Redis 的計數器、7.9.2 的 relay），FLUSHALL 的輪次是 18、10、37、27 張，3、15、18、83 張，以及上面的 16、9、23、15 張：**3～83 張**，對照組六輪都是 0。

偏高從哪裡來：`FLUSHALL` 的那一刻，已經過了舊閘門、下單交易還沒 commit 的那些訂單，**它們的預留列還不存在** —— 下一個請求從 MySQL 重建閘門時（`GATE_BASE_SQL`），既沒有在 `reserved` 裡、也沒有在「未計入」裡看到它們，於是它們被算了兩次：舊閘門減過一次，新閘門又把同樣的數量放出去一次。在途的訂單越多（交易越慢、連線池越擠），偏高越多。83 張的那一輪也是那一組裡唯一出現連線池逾時的一輪；但我沒有量那一刻在途的交易有幾個，**這是推測，不是證明**。

上面有兩輪 FLUSHALL 出現了大量的 503（741、1,109 個）。最後一欄說出了它們從哪裡來：**Redis 失敗 51 次、跳開 17 次；失敗 14 次、跳開 4 次** —— 那兩輪的 load average 是 27、29。503 是閘門的 `unavailable()`（`RedisGuard` 跳開的 5 秒裡，熱點下單一律 503，6.9.1 的艙壁）。這是第 06 章 6.4.5 的那一種：機器忙到 Redis 指令逾時、斷路器跳開。`FLUSHALL` 本身是一個會讓 Redis 停頓的指令，它跟這些逾時有沒有關係，我沒有分開量。**對照組六輪都是 Redis 失敗 0 次。**

#### 補償：E10

落帳發現不夠的時候，庫存模組不能直接取消訂單 —— `inventory` 不依賴 `ordering`（`ModuleBoundaryTest`），反過來依賴會變成循環。它做自己能做的事，然後**發一個事件**：

```java
jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
outbox.add("ORDER", orderId, EventTypes.HOT_SETTLEMENT_FAILED, Map.of("orderId", orderId, "productId", h.productId(),
        "requested", h.quantity(), "available", available == null ? 0 : available));
shortages.increment();                                              // shop.inventory.hot.shortage：正常應該永遠是 0
log.warn("HOT_SETTLEMENT_SHORTAGE orderId={} productId={} requested={} available={}（訂單會被取消）", …);
```

> 📌 **專題寫完之後的追記**：這一段沒有把閘門減掉的數量加回 Redis。一張買 q > 1 件的訂單在這裡失敗時，Redis 會**偏低**（6.5.3 的 ⚠️ 搬到了這裡）。修法是在 `shortages.increment()` 之前，把「真的存在」的那一部分（`GATE_BASE_SQL`，上限 q）用 `inventory.stock-returned` 加回去 —— 程式碼、理由與前後的實測在 6.5.3 的追記。

`ordering.stock-shortage` 消費者收到它，對訂單套用一個新的事件 —— **E10 `STOCK_SHORTAGE`**。0.5 的轉移表從 6 × 9 變成 6 × 10：

| 狀態 ＼ 事件 | … | E10 庫存不足（系統） |
|---|---|---|
| **PENDING_PAYMENT** | | **→ CANCELLED** |
| **PAID** | | **→ CANCELLED** ＋退款 |
| **PICKING** | | **→ CANCELLED** ＋退款 |
| **SHIPPED** | | ·（不會發生：落帳沒完成或失敗的訂單出不了貨，7.6.4） |
| **COMPLETED** | | · |
| **CANCELLED** | | ＝（買家先取消了：什麼都不做） |

為什麼不沿用 E5（賣家取消）？因為 `PENDING_PAYMENT + E5 = ✗` —— 0.5.3 刻意不讓賣家取消還沒付款的訂單（那一格的理由是「賣家後悔用這個價格賣了」）。E10 不是賣家的決定，是系統發現自己答應了不存在的東西。`OrderStateMachineTest` 的表多了一欄，測試從 54 + 5 個變成 60 + 5 個；0.5.2 的事件表補上了 E10，0.5.3 的轉移表在 📌 裡補了 E10 那一欄的答案（表格本身仍是 6 × 9）。

#### ⚠️ 取消原因：一個沒有加的值

取消要寫 `cancel_reason`。V5 的 CHECK 只允許四個值：`BUYER`、`PAYMENT_TIMEOUT`、`SELLER_OUT_OF_STOCK`、`SELLER_OTHER`。直覺是加一個 `STOCK_SHORTAGE` —— 一個 migration、一句 `ALTER TABLE orders DROP CHECK …, ADD CONSTRAINT … CHECK (…)`。

寫之前一樣在 `shop_ddl`（10 萬張訂單的複本）量了：

```
Query_ID	Duration	Query
2	2.25410075	ALTER TABLE orders DROP CHECK orders_chk_2, ADD CONSTRAINT orders_chk_2 CHECK (cancel_reason IN ('BUYER','PAYMENT_TIMEOUT','SELLER_OUT_OF
2	3.61154050	ALTER TABLE orders DROP CHECK orders_chk_2, ADD CONSTRAINT orders_chk_2 CHECK (cancel_reason IN ('BUYER','PAYMENT_TIMEOUT','SELLER_OUT_OF
2	2.81224775	ALTER TABLE orders DROP CHECK orders_chk_2, ADD CONSTRAINT orders_chk_2 CHECK (cancel_reason IN ('BUYER','PAYMENT_TIMEOUT','SELLER_OUT_OF
```

```
ERROR 1845 (0A000) at line 1: ALGORITHM=INPLACE is not supported for this operation. Try ALGORITHM=COPY.
ERROR 1846 (0A000) at line 1: LOCK=NONE is not supported. Reason: COPY algorithm requires a lock. Try LOCK=SHARED.
```

（`orders_chk_2` 是 `shop_ddl` 那份複本上這個 CHECK 的名字。在 `shop` 上，V5 給它的名字是 `ck_orders_cancel_reason_values`；自己照著量，要換成這個名字。）

**2.25～3.61 秒，整張 `orders` 複製一次，而且期間 `LOCK=SHARED` —— 不能下單。** 新增一個 CHECK 要檢查每一列，MySQL 8.0 只能用 COPY。0.6.1 估 3 年 550 萬張訂單，是現在的 55 倍：照比例是兩、三分鐘不能下單。第 02 章 2.9.6 的規則是「migration 要能在線上跑」，這一句不行。

所以這一章**沒有**加這個值。E10 取消的訂單，`cancel_reason` 用 `SELLER_OUT_OF_STOCK` —— 對買家來說它就是「缺貨」；真正的原因（事件 `STOCK_SHORTAGE`、操作者 `SYSTEM`）記在 `order_status_history` 裡，那張表的 `event` 欄位沒有 CHECK：

```java
// 7.6.3：沒有新增一個取消原因 —— 改 ck_orders_cancel_reason_values 要整張 orders 表複製一次（10 萬列 2.25～3.61 秒、期間不能下單）。
// 對買家來說它就是「缺貨」；真正的原因（E10、actor = SYSTEM）在 order_status_history
case STOCK_SHORTAGE -> "SELLER_OUT_OF_STOCK";
```

這是一個妥協，而且有代價：第 03 章的報表（3.7）如果要分「賣家缺貨」與「系統超收」，要多 JOIN 一次 `order_status_history`。退款原因同理（`refunds.reason` 的 CHECK），用 `SELLER_CANCEL`。

`EventFlowTest.shortageCancels`：MySQL 只有 1 件、Redis 故意設成 3，三個買家下單：

```
7.6.3：{order_no=20261002-685204, status=PENDING_PAYMENT, cancel_reason=null, event=null, actor_type=null}
7.6.3：{order_no=20261002-942758, status=CANCELLED, cancel_reason=SELLER_OUT_OF_STOCK, event=STOCK_SHORTAGE, actor_type=SYSTEM}
7.6.3：{order_no=20261002-437552, status=CANCELLED, cancel_reason=SELLER_OUT_OF_STOCK, event=STOCK_SHORTAGE, actor_type=SYSTEM}
```

三張都回了 201；落帳時第一張計入，後兩張不夠、被取消。`reserved = 1`：**沒有超賣，但有兩個人被「答應了又反悔」**。這就是 6.5.3 那張表第一列的新代價。

> 📌 **0.6.4 的「下單時的可售庫存判斷：強一致」，對熱點商品來說改了意思。** 判斷仍然是強一致的 —— 在 Redis 的 Lua 腳本裡（原子的），而且 MySQL 仍然會在落帳時再擋一次。但「Redis 說有」不再等於「一定買得到」：Redis 偏高的那幾件，會變成 201 之後的取消。這一章把 0.6.4 那一列補了一句，並把 `shop.inventory.hot.shortage` 列進第 09 章的告警 —— **它不是 0 的時候，代表有人被答應了又反悔。**

### 7.6.4 出貨要等落帳

落帳還沒完成的熱點預留（`counted = FALSE`），如果賣家就出貨了：`consume()` 會把 `on_hand` 與 `reserved` 一起減 —— 但 `reserved` 從來沒有加過。`CHECK (reserved >= 0)` 會擋下來（500），或者更糟，剛好有別的訂單的 `reserved` 墊著，減下去不會負，帳就錯了。

落帳失敗、那一列已經 `RELEASED`、取消的事件還在路上：`consume()` 找不到任何 `CONFIRMED` 的預留，**什麼都不減就出貨了** —— 出了一件不存在的貨。

兩條都在 `consume()` 的開頭擋掉：

```java
List<Held> rows = held(orderId, "'CONFIRMED'");
if (rows.stream().anyMatch(h -> !h.counted()))                      // 7.6.4：落帳還沒完成。幾秒後就會好 —— 出貨不差這幾秒
    throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "這張訂單的庫存還在落帳，請稍後再出貨").with("retryAfter", 5);
// 7.6.4：落帳發現不夠、那一列已經 RELEASED，取消的事件還在路上。這時候出貨 = 出一件不存在的貨（onHand 不會減）
Integer released = jdbc.queryForObject("SELECT COUNT(*) FROM inventory_reservations WHERE order_id = ? AND status = 'RELEASED'", Integer.class, orderId);
if (released != null && released > 0)
    throw new ShopException(ProblemType.INVALID_STATE, "這張訂單有商品庫存不足，即將取消，不能出貨");
```

第二條是寫 E10 的時候想到的，不是量到的：落帳失敗與出貨要剛好在同一個幾百毫秒裡發生，`HotSettlementTest` 用 `InlineEvents` 控制事件到達的順序，把它做出來：

```
7.6.4 落帳之後出貨：{on_hand=4, reserved=0}；預留 CONSUMED
7.6.3 落帳失敗：出貨被擋 → 取消 {status=CANCELLED, cancel_reason=SELLER_OUT_OF_STOCK, refund=SELLER_CANCEL}
```

（第一行之前，同一個測試先在落帳之前出貨一次，拿到 503 `temporarily-unavailable`；第二行之前，出貨拿到 409 `invalid-state`。）

### 7.6.5 熱點加回：從 `afterCommit` 換成事件

第 06 章的取消、補貨，在 commit 之後把數量加回 Redis（`HotStock.giveBackAfterCommit`）。6.5.3 的表承認了它的洞：commit 之後、加回之前行程死掉，Redis 就偏低（少賣），等對帳在下一分鐘修正。

這一章把它換成事件：`release()`、`restock()` 在同一個交易裡寫一個 `inventory.stock-returned`，`inventory.hot-stock-return` 消費者把數量加回 Redis（`EXISTS` 才 `INCRBY`：不是熱點的商品沒有 key，什麼都不做）。

```java
/**
 * 7.6.5 取消、補貨之後，熱點商品的 Redis 閘門加回去。Redis 的 INCRBY 不在 MySQL 的交易裡：
 * INCRBY 成功、commit 之前行程死掉 → 重送時再加一次 → 偏高（6.5.3 的安全方向）；反過來的順序會偏低，所以 INCRBY 在交易「裡面」做。
 */
```

`hotStockReturn` 這個消費者（`InventoryEventHandlers`）與它呼叫的 `HotStock.giveBackOrFail()` —— 取代第 06 章的 `giveBackAfterCommit()`：Redis 不能用就丟例外、走重試階梯，而不是記一行日誌等對帳 —— 的完整內容在 7.13.1。

`processed_messages` 擋得住大部分的重複，擋不住「INCRBY 成功、交易 commit 之前死掉」的那一次 —— 那一次會多加一件（偏高）。6.5.3 說偏高是安全的方向；7.6.3 說它的代價變成了「201 之後取消」。兩害相權：**少賣是一定會發生的（每一次 `kill -9` 都可能），多加一件要「`INCRBY` 與 commit 之間的幾毫秒」裡死掉才會發生。** 這一章選後者，並在 6.5.3 的表上補一列：

| 動作 | 順序 | 中間失敗了 | Redis 會 |
|---|---|---|---|
| 取消、逾時、補貨（第 06 章） | MySQL commit → `afterCommit` 加 | commit 之後、加之前行程死掉 | 偏低（少賣，等對帳） |
| 取消、逾時、補貨（**第 07 章**） | MySQL commit（含事件）→ 消費者 `INCRBY` → 記 `processed_messages` | `INCRBY` 之後、commit 之前死掉 | **偏高**（重送時再加一次） |

`HotStockFlowTest.cancelAndRestockAddBack` 跟著改了：取消之後 Redis **還是** 2（加回是事件，commit 之後才發生），交付事件之後才是 3。

還沒做的一個：**`ProductCache` 的 `pendingEvictions`（6.4.2）** 一樣只在記憶體裡。它的後果是「舊價格留到 TTL（10 分鐘多）」，不會賣錯東西，這一章沒有把它換成事件（練習一）。

### 7.6.6 搶購壓測：第二次嘗試

6.5.4 的結論是：閘門讓搶不到的人快了兩個數量級，但 p99 還是 3.7～4.9 秒，因為搶到的 500 人排在同一列 `inventory` 後面。7.6.1～7.6.5 把那一句 `UPDATE` 移出了下單交易。這是第二次嘗試：第 04 章的 E7 原封不動（2,000 個買家搶 500 件、真的 `POST /api/orders`、開放式每秒 200 個、503 用同一個鍵重送），熱點商品；**第 06 章結束時的程式碼（git worktree）與這一章的程式碼交錯，各 3 次**，每次暖機一輪、量兩輪。這一章的 E7 打開了 relay 與消費者（那才是第 07 章之後的系統），等熱點預留全部計入才結束一輪，並多記兩個數字：落帳在最後一個回應之後多久完成、這一輪 InnoDB 的列鎖等待（`Innodb_row_lock_waits`、`Innodb_row_lock_time` 的差）。

下面的數字是用一支腳本 `h5-interleave.sh` 把第 06 章那一側的 `H5BaselineTest` 與這一章的 `H5HotFlashSaleTest` 輪流跑出來的。**本章沒有提供這兩個檔案**（`h5-interleave.sh` 與 `H5BaselineTest`）；要自己重做這個交錯比較，先建一個第 06 章的 worktree，跟這一章的專案並排：

```bash
git worktree add ../shop-ch06 ch06        # ch06：你自己第 06 章結束時的那個 commit 或 tag
```

這一章這一側跑 `mvn test -Pexperiments -Dtest=H5HotFlashSaleTest`（完整內容在 7.13.1）。第 06 章那一側，在 `../shop-ch06` 裡照 `H5HotFlashSaleTest` 的樣子寫一個（同樣暖機一輪、量兩輪、前後讀 `Innodb_row_lock_waits`、`Innodb_row_lock_time`；第 06 章的 `E7FlashSaleLoadTest.Run` 沒有 `settledMs`，那一欄拿掉），並在那一側 `E7FlashSaleLoadTest.flashSale` 啟動應用程式的參數裡加上 `--spring.flyway.ignore-migration-patterns=*:future`（原因在輸出下面）。兩邊輪流，各跑 3 次。

```
### ch06 第 1 次 load 27.11 19.83 17.94
  ch06 熱點 HTTP {201=479, 409=1431, 503=90} │ 10.76 秒 │ p50  2126  p95  7007  p99  8004  最慢  8756 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180 │ 列鎖等待 498 次、共 176,290 ms
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {201=1, 409=89}
  ch06 熱點 HTTP {201=489, 409=1461, 503=50} │ 10.01 秒 │ p50   628  p95  4659  p99  5222  最慢  6076 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180 │ 列鎖等待 499 次、共 123,182 ms
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=50}
### ch07 第 1 次 load 19.73 18.60 17.61
  ch07 熱點 HTTP {201=498, 409=370, 503=1132} │ 10.55 秒 │ p50    27  p95  2227  p99  2984  最慢  3528 ms │ reserved=498 明細=498 RESERVE 帳=498 │ 連線池：同時使用最多 20、等待最多 185 │ 最後一個回應之後 3 ms 全部落帳 │ 列鎖等待 687 次、共 15,621 ms
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=1132}
  ch07 熱點 HTTP {201=500, 409=701, 503=799} │ 10.00 秒 │ p50    53  p95  2385  p99  3217  最慢  4011 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 185 │ 最後一個回應之後 2 ms 全部落帳 │ 列鎖等待 628 次、共 10,035 ms
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=583, 503=216}
### ch06 第 2 次 load 17.63 18.10 17.52
  ch06 熱點 HTTP {201=489, 409=1471, 503=40} │ 10.00 秒 │ p50   453  p95  4367  p99  4977  最慢  6092 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180 │ 列鎖等待 499 次、共 120,630 ms
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=40}
  ch06 熱點 HTTP {201=497, 409=1480, 503=23} │ 10.01 秒 │ p50   446  p95  4278  p99  4892  最慢  5602 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180 │ 列鎖等待 499 次、共 116,263 ms
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=23}
### ch07 第 2 次 load 10.81 15.72 16.66
  ch07 熱點 HTTP {201=497, 409=1443, 503=60} │ 10.01 秒 │ p50   271  p95  3368  p99  4079  最慢  5533 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 185 │ 最後一個回應之後 1,045 ms 全部落帳 │ 列鎖等待 603 次、共 7,975 ms
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=60}
  ch07 熱點 HTTP {201=500, 409=1392, 503=108} │ 11.21 秒 │ p50   122  p95  2081  p99  3593  最慢  5793 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 182 │ 最後一個回應之後 1,666 ms 全部落帳 │ 列鎖等待 622 次、共 14,257 ms
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {503=108}
### ch06 第 3 次 load 15.06 16.00 16.66
  ch06 熱點 HTTP {201=498, 409=1493, 503=9} │ 10.02 秒 │ p50   587  p95  4705  p99  5454  最慢  6032 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180 │ 列鎖等待 499 次、共 123,714 ms
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=9}
  ch06 熱點 HTTP {201=487, 409=1478, 503=35} │ 10.00 秒 │ p50   216  p95  4715  p99  5412  最慢  6177 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180 │ 列鎖等待 500 次、共 128,532 ms
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=35}
### ch07 第 3 次 load 10.67 14.43 16.00
  ch07 熱點 HTTP {201=500, 409=1490, 503=10} │ 10.00 秒 │ p50   123  p95  3188  p99  4286  最慢  5198 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 185 │ 最後一個回應之後 733 ms 全部落帳 │ 列鎖等待 593 次、共 10,868 ms
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=10}
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.04 秒 │ p50    23  p95  1544  p99  2374  最慢  3371 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 185 │ 最後一個回應之後 647 ms 全部落帳 │ 列鎖等待 632 次、共 8,034 ms
### done load 9.35 13.46 15.49
```

（`load` 是每一次開始前的 load average。第 06 章的 worktree 要帶 `--spring.flyway.ignore-migration-patterns=*:future` 才起得來：資料庫已經套用了 V13、V14，對第 06 章的程式碼來說，那是「未來的」migration —— 我第一次寫成 `*:missing`，Flyway 照樣拒絕啟動，那一次的數字作廢、整組重跑。）

| | 第 06 章 | 第 07 章 |
|---|---|---|
| p99（ms） | 8,004、5,222、4,977、4,892、5,454、5,412 | 2,984、3,217、4,079、3,593、4,286、2,374 |
| p50（ms） | 2,126、628、453、446、587、216 | 27、53、271、122、123、23 |
| 列鎖等待 | 每輪 498～500 次，**116～176 秒** | 每輪 593～687 次，**8～16 秒** |
| 連線池 | 同時使用 20、等待最多 180 | 同時使用 20、等待最多 182～185 |
| 落帳完成（最後一個回應之後） | —— | 2 ms～1.7 秒 |

**列鎖等待的總時間少了一個數量級。** 第 06 章每一輪都是「499 次、加起來兩、三分鐘」—— 每一張成立的訂單都在那一列後面等過一次。第 07 章的次數反而多了，但每一次都短得多。

**p99：三對裡每一對都是第 07 章比較低**（2.4～4.3 秒 vs 4.9～8.0 秒），而且兩組的範圍沒有重疊。**但 p99 < 500 ms 在這一組裡沒有達成**：還差 5～9 倍。（後面還有一組，在機器比較閒的時候量的 —— 結論不一樣。）

**這組數字我要保守地讀。** 這是 7.9.2 修正 relay 之後的第二組交錯量測。第一組（修正之前，同樣的程式碼只差 relay）的 p99 是：第 06 章 6,660、6,051、7,149、8,531、3,662、7,063 ms，第 07 章 4,125、6,905、2,772、8,819、2,977、5,767 ms —— 兩組範圍幾乎完全重疊；列鎖等待一樣是「次數多、總時間少」（第 06 章每輪 90～180 秒，第 07 章 19～44 秒）。兩組之間只差了 relay 的寫法與機器那段時間的忙碌程度（第一組時 load average 13～17，第二組 10～27），**我分不出 p99 的差別是哪一個造成的**。可以確定的只有：熱點那一列的鎖，在兩組裡都少了一個數量級；p99 在兩組裡都是秒級。

第 07 章的第一輪有 1,132 個 503（那一輪開始時 load average 是 19.7），最後只賣出 498 件：503 的請求重送全部拿到 409（Redis 說沒有了）。少賣 2 件、沒有超賣 —— 這是 0.6.2 允許的方向（偏低是少賣，6.6 的對帳會把差額放回閘門）。**為什麼是 2 件、為什麼那一輪的 503 特別多，我沒有追到原因**；其餘五輪都賣完了 500 件。

#### 鎖還在哪裡

列鎖等待少了，但沒有歸零。H5b 跑一次第 07 章的搶購，同時每 50 ms 取樣一次 `performance_schema.data_lock_waits`（誰在等誰的鎖）與 `information_schema.processlist`（`shop` 的每一條連線正在做什麼）：

```bash
mvn test -Pexperiments -Dtest=H5bDiagnoseTest
```

```
═══ 7.6.6 第 07 章的搶購，每 50 ms 取樣 584 次 ═══
  HTTP {201=499, 409=1454, 503=47} │ p50 127  p99 4028 ms │ 連線池：同時使用最多 20、等待最多 185
  ── 鎖等待（取樣到的次數，前 8 名）──
      250  inventory.PRIMARY 要 X,REC_NOT_GAP、被 S,REC_NOT_GAP 擋
      235  inventory.PRIMARY 要 S,REC_NOT_GAP、被 X,REC_NOT_GAP 擋
       99  inventory.PRIMARY 要 X,REC_NOT_GAP、被 X,REC_NOT_GAP 擋
  ── shop 的連線在做什麼（取樣到的次數，前 12 名）──
      942  commit │ waiting for handler commit
      216  INSERT INTO inventory_reservations (order_id, product_id, qu │ update
      135  SELECT on_hand - reserved FROM inventory WHERE product_id =  │ statistics
      102  UPDATE notifications SET status = 'SENT', sent_at = CURRENT_ │ waiting for handler commit
      101  INSERT INTO notifications (user_id, type, dedup_key, payload │ waiting for handler commit
       92  UPDATE notifications SET attempts = attempts + 1 WHERE id =  │ waiting for handler commit
       24  insert into orders (buyer_id,cancel_reason,cancelled_at,carr │ update
       17  INSERT INTO order_status_history (order_id, from_status, to_ │ update
       13  INSERT INTO idempotency_keys (buyer_id, idem_key, request_ha │ update
       11  UPDATE idempotency_keys SET status = 'SUCCEEDED', order_id = │ updating
       10  （閒置） │ starting
        8  INSERT INTO outbox_events (event_id, aggregate_type, aggrega │ update
```

**取樣到的鎖等待，全部在 `inventory` 的同一列上：**

- `要 X、被 S 擋`（250）：落帳的消費者（`SELECT … FOR UPDATE`、`UPDATE inventory`）要排他鎖，被**共享鎖**擋住。
- `要 S、被 X 擋`（235）：有人要共享鎖，被落帳的排他鎖擋住 —— 對應 `INSERT INTO inventory_reservations │ update` 那 216 次取樣。
- `要 X、被 X 擋`（99）：兩條落帳的執行緒（`concurrency = 2`）互相排隊。

**那個共享鎖是外鍵。** `inventory_reservations.product_id → inventory.product_id`（V3 的 `fk_reservations_inventory`）：InnoDB 在 INSERT 子表時，要對父表的那一列加 S 鎖確認它存在。第 02 章 2.6.2 遇過它：那一節的死鎖，就是「外鍵檢查要的 S 鎖」造成的。7.6 把下單交易的 `UPDATE inventory` 拿掉了，**但 `INSERT inventory_reservations` 還在 —— 它照樣要碰那一列，只是從 X 鎖變成 S 鎖。** S 鎖彼此相容，下單的交易之間不再互相排隊；但落帳的消費者每計入一筆，都要拿一次 X 鎖，跟正在下單的那幾十個交易的 S 鎖互相等。

設計 7.6 的時候我把這件事寫在筆記裡當成一個風險（「外鍵的 S 鎖會跟落帳的 X 鎖互相等」），但沒有先量它；H5b 讓它從推測變成了數字。（修正 relay 之前的那一次 H5b，還多一種等待：`outbox_events` 的間隙鎖，64 次取樣 —— relay 的 `FOR UPDATE` 擋住了訂單寫 outbox。7.9.2 的 READ COMMITTED 之後，它不見了。）

**為了確認是外鍵，我在本機把它拿掉、重跑**（`ALTER TABLE inventory_reservations DROP FOREIGN KEY fk_reservations_inventory, ALGORITHM=INPLACE, LOCK=NONE`，0.091 秒；加回去 3.54 秒），有外鍵、沒有外鍵交錯：H5 各兩次（每次兩輪）、H5b 各一次：

```
### 有外鍵 H5HotFlashSaleTest 外鍵數=1 load 4.27 4.47 6.11
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     9  p95   538  p99   917  最慢  1526 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 100 │ 最後一個回應之後 5 ms 全部落帳 │ 列鎖等待 759 次、共 10,621 ms
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95   114  p99   205  最慢   317 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 31 │ 最後一個回應之後 2 ms 全部落帳 │ 列鎖等待 940 次、共 10,557 ms
### 沒有外鍵 H5HotFlashSaleTest 外鍵數=0 load 6.10 5.21 6.25
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     8  p95   516  p99   864  最慢  1374 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 85 │ 最後一個回應之後 3 ms 全部落帳 │ 列鎖等待 473 次、共 1,672 ms
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95   172  p99   326  最慢   448 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 37 │ 最後一個回應之後 2 ms 全部落帳 │ 列鎖等待 486 次、共 1,811 ms
### 沒有外鍵 H5bDiagnoseTest 外鍵數=0 load 5.73 5.51 6.28
═══ 7.6.6 第 07 章的搶購，每 50 ms 取樣 528 次 ═══
  HTTP {201=500, 409=1500} │ p50 8  p99 1442 ms │ 連線池：同時使用最多 20、等待最多 161
       44  inventory.PRIMARY 要 X,REC_NOT_GAP、被 X,REC_NOT_GAP 擋
      630  commit │ waiting for handler commit
       51  INSERT INTO notifications (user_id, type, dedup_key, payload │ waiting for handler commit
       43  UPDATE notifications SET attempts = attempts + 1 WHERE id =  │ waiting for handler commit
       39  UPDATE notifications SET status = 'SENT', sent_at = CURRENT_ │ waiting for handler commit
       31  SELECT on_hand - reserved FROM inventory WHERE product_id =  │ statistics
        7  （閒置） │ starting
        4  insert into orders (buyer_id,cancel_reason,cancelled_at,carr │ update
        2  UPDATE idempotency_keys SET status = 'SUCCEEDED', order_id = │ System lock
        2  SET autocommit=1 │ waiting for handler commit
        1  SELECT id, product_id, quantity, counted FROM inventory_rese │ executing
        1  UPDATE inventory SET reserved = reserved + 1, updated_at = C │ Sending to client
        1  INSERT INTO order_status_history (order_id, from_status, to_ │ update
### 有外鍵 H5bDiagnoseTest 外鍵數=1 load 5.78 5.63 6.27
═══ 7.6.6 第 07 章的搶購，每 50 ms 取樣 553 次 ═══
  HTTP {201=500, 409=1500} │ p50 8  p99 823 ms │ 連線池：同時使用最多 20、等待最多 85
      213  inventory.PRIMARY 要 S,REC_NOT_GAP、被 X,REC_NOT_GAP 擋
       95  inventory.PRIMARY 要 X,REC_NOT_GAP、被 S,REC_NOT_GAP 擋
       49  inventory.PRIMARY 要 X,REC_NOT_GAP、被 X,REC_NOT_GAP 擋
      495  commit │ waiting for handler commit
      169  INSERT INTO inventory_reservations (order_id, product_id, qu │ update
       58  SELECT on_hand - reserved FROM inventory WHERE product_id =  │ statistics
       44  UPDATE notifications SET status = 'SENT', sent_at = CURRENT_ │ waiting for handler commit
       41  INSERT INTO notifications (user_id, type, dedup_key, payload │ waiting for handler commit
       39  UPDATE notifications SET attempts = attempts + 1 WHERE id =  │ waiting for handler commit
        7  INSERT INTO outbox_events (event_id, aggregate_type, aggrega │ update
        7  （閒置） │ starting
        3  INSERT INTO idempotency_keys (buyer_id, idem_key, request_ha │ update
        3  insert into orders (buyer_id,cancel_reason,cancelled_at,carr │ update
        2  UPDATE notifications SET status = 'SENT', sent_at = CURRENT_ │ updating
        2  SELECT id, status, attempts FROM notifications WHERE dedup_k │ statistics
### 有外鍵 H5HotFlashSaleTest 外鍵數=1 load 7.26 6.14 6.43
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95   127  p99   169  最慢   341 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 19 │ 最後一個回應之後 1 ms 全部落帳 │ 列鎖等待 951 次、共 11,581 ms
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95    77  p99   108  最慢   136 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 9 │ 最後一個回應之後 1 ms 全部落帳 │ 列鎖等待 980 次、共 9,373 ms
### 沒有外鍵 H5HotFlashSaleTest 外鍵數=0 load 5.29 6.10 6.40
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95   447  p99   767  最慢  1202 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 89 │ 最後一個回應之後 3 ms 全部落帳 │ 列鎖等待 476 次、共 1,501 ms
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95   128  p99   206  最慢   336 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 23 │ 最後一個回應之後 3 ms 全部落帳 │ 列鎖等待 491 次、共 2,036 ms
```

**拿掉外鍵，S 鎖的兩種等待都不見了**：H5b 裡只剩 `要 X、被 X 擋` 44 次（兩條落帳的執行緒互相排隊）；有外鍵的那一次是 213 + 95 + 49。H5 的列鎖等待總時間，從每輪 9.4～11.6 秒降到 1.5～2.0 秒。**那一個 S 鎖，就是 7.6 之後剩下的列鎖等待的大部分。**

**但 p99 沒有跟著變好：**

| | 有外鍵 | 沒有外鍵 |
|---|---|---|
| p99（ms） | 917、205、169、108 | 864、326、767、206 |
| 列鎖等待（每輪） | 759～980 次，9.4～11.6 秒 | 473～491 次，1.5～2.0 秒 |

四輪對四輪，範圍幾乎重疊。列鎖等待少了五、六倍，p99 看不出差別 —— **在這一章之後，熱點那一列的鎖已經不是 p99 的主因了**。兩組的第一次（每次測試的第一輪）都比第二輪慢（917／205、864／326、169／108、767／206），原因我沒有查。

**外鍵留著。** 它擋的是「預留指向一個不存在的商品」（第 02 章 2.6），拿掉它換來的是列鎖等待的秒數，不是使用者看得到的延遲。

（這兩組是 7.9.4 的修正之後量的，load average 4.3～7.3 —— 比上面那兩組交錯量測時閒得多。有外鍵的四輪裡有三輪 p99 在 500 ms 以下，這是這一章第一次；所以我在同樣的條件下，把第 06 章與第 07 章再交錯量了一次，見下面的「機器閒下來的時候」。）

**三次 H5b 的取樣裡，最常見的連線狀態都不是等鎖，而是 `commit │ waiting for handler commit`**（942、630、495 次）：交易已經做完了，在等 commit 完成。我的推測是 redo log 的 fsync（`innodb_flush_log_at_trx_commit = 1`）在一台 load average 十幾到二十幾、MySQL 跑在 Docker VM 裡的筆電上很慢 —— 但我沒有直接量 fsync 的時間，**這是推測**。每一張熱點訂單要兩次 commit（冪等鍵的 claim、下單交易）；通知的消費者更多：它的三句（`INSERT`、認領的 `UPDATE`、標 `SENT` 的 `UPDATE`）各自 autocommit，一封通知三次 commit，而且它們用的是**跟下單同一個連線池**。

#### 機器閒下來的時候

同一支 `h5-interleave.sh`，同樣交錯三對，只是這一次這台機器比較閒（load average 4.7～9.0；上面那一組是 10～27）：

```
### ch06 第 1 次 load 5.10 5.99 6.33
  ch06 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     8  p95  1259  p99  1651  最慢  2089 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 174 │ 列鎖等待 501 次、共 59,966 ms
  ch06 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95   986  p99  1445  最慢  2082 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 174 │ 列鎖等待 499 次、共 52,570 ms
### ch07 第 1 次 load 4.70 5.72 6.21
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95   129  p99   172  最慢   212 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 18 │ 最後一個回應之後 1 ms 全部落帳 │ 列鎖等待 939 次、共 11,545 ms
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95    99  p99   150  最慢   226 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 21 │ 最後一個回應之後 2 ms 全部落帳 │ 列鎖等待 980 次、共 9,893 ms
### ch06 第 2 次 load 8.99 7.94 7.09
  ch06 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     8  p95  1483  p99  1944  最慢  2598 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180 │ 列鎖等待 499 次、共 59,985 ms
  ch06 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95   239  p99   305  最慢   456 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 33 │ 列鎖等待 499 次、共 40,313 ms
### ch07 第 2 次 load 6.65 7.62 7.05
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     8  p95   140  p99   187  最慢   319 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 18 │ 最後一個回應之後 1 ms 全部落帳 │ 列鎖等待 939 次、共 11,422 ms
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95    99  p99   153  最慢   198 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 15 │ 最後一個回應之後 4 ms 全部落帳 │ 列鎖等待 974 次、共 10,146 ms
### ch06 第 3 次 load 7.10 7.83 7.20
  ch06 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50    18  p95  3163  p99  3681  最慢  5135 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180 │ 列鎖等待 499 次、共 91,300 ms
  ch06 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95   326  p99   457  最慢   654 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 54 │ 列鎖等待 499 次、共 40,059 ms
### ch07 第 3 次 load 9.03 8.47 7.50
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     8  p95   542  p99   829  最慢  1600 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 115 │ 最後一個回應之後 2 ms 全部落帳 │ 列鎖等待 822 次、共 10,193 ms
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50     7  p95   119  p99   168  最慢   215 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 22 │ 最後一個回應之後 1 ms 全部落帳 │ 列鎖等待 951 次、共 10,893 ms
### done load 6.07 7.75 7.32
```

| | 第 06 章 | 第 07 章 |
|---|---|---|
| p99（ms） | 1,651、1,445、1,944、**305**、3,681、**457** | **172**、**150**、**187**、**153**、829、**168** |
| p99 < 500 ms | 6 輪裡 2 輪 | 6 輪裡 5 輪 |
| 列鎖等待（每輪） | 499～501 次，40～91 秒 | 822～980 次，9.9～11.5 秒 |
| 連線池等待（最多） | 33～180 | 15～115 |
| 落帳完成（最後一個回應之後） | —— | 1～4 ms |

**這一次，p99 < 500 ms 在第 07 章的 6 輪裡達成了 5 輪**（150～187 ms；沒達成的那一輪 829 ms）。第 06 章 6 輪裡 2 輪（305、457 ms），其他 4 輪 1.4～3.7 秒。

**同樣的程式碼、同樣的測試，兩組的差別是這台機器有多忙：**

| | load average | 第 06 章 p99 | 第 07 章 p99 |
|---|---|---|---|
| 修正 relay 之前 | 13～17 | 3.7～8.5 秒 | 2.8～8.8 秒 |
| 修正 relay 之後 | 10～27 | 4.9～8.0 秒 | 2.4～4.3 秒 |
| 7.9.4 之後、機器比較閒 | 4.7～9.0 | 0.3～3.7 秒 | 0.15～0.83 秒 |

三組裡，**列鎖等待的總時間都是第 07 章少得多**（第 06 章每輪 40～180 秒，第 07 章 8～44 秒；同一組裡少 4 到 20 倍）；p99 則跟著機器走。第 06 章 6.5.4 量到的 3.7～4.9 秒，是在 load 7～11 的時候。

我不把第三組當成「達成了」：它是 6 輪裡 5 輪、在一台 load 5～9 的筆電上、壓測的客戶端跟伺服器在同一個 JVM 裡。我能說的是：**在這台機器還有餘裕的時候，第 07 章的熱點下單可以在 500 ms 以內；機器一忙，它跟第 06 章一樣是秒級** —— 那時候花掉時間的是 commit 與 20 條連線（上面的取樣），不是那一列。第 06 章在同樣閒的時候做不到（6 輪裡 2 輪）。

**這一節的結論：**

- **熱點那一列，不再是主要的瓶頸。** 三組交錯量測裡，列鎖等待的總時間都少了 4 到 20 倍；剩下的大部分是外鍵的 S 鎖，拿掉它列鎖等待再少五、六倍，p99 卻沒有變。
- **p99 < 500 ms：部分達成。** 機器比較閒的那一組，第 07 章 6 輪裡 5 輪（150～187 ms），第 06 章 6 輪裡 2 輪；機器忙的那兩組，兩者都是秒級。**它需要第 08 章在獨立的環境、用獨立行程的壓測工具重量** —— 第 06 章 6.4.5 就說過同一句話，這一章的三組數字是那句話的理由。
- 三個可以做、但這一章沒做的：消費者用**自己的連線池**（6.9.1 的艙壁，換一個地方用，練習七）；通知的三句合成一個交易（一次 commit）；落帳用一條執行緒、或一次計入一批（讓 X 鎖少拿幾次）。

---

## 7.7 通知

### 7.7.1 US-NTF-1：誰、什麼時候、寄什麼

| 事件 | 寄給 | 類型 | NTF-1 |
|---|---|---|---|
| `order.placed` | 買家 | `ORDER_PLACED`：「訂單 … 已成立，請在 15 分鐘內完成付款」 | AC-1 |
| `order.paid` | 買家、**賣家** | `ORDER_PAID`、`NEW_ORDER`（0.5.4：「賣家通知有新訂單」） | AC-1 |
| `order.cancelled` | 買家 | `ORDER_CANCELLED`（含原因；有退款時加一句「款項將全額退回」） | AC-1 |
| `order.shipped` | 買家 | `ORDER_SHIPPED`（物流商、單號） | AC-1 |
| `refund.succeeded` | 買家 | `REFUND_SUCCEEDED` | AC-1「已取消（含退款）」 |

AC-1 說「本專題以寫入 `notifications` 表 + 日誌模擬寄信」：`SimulatedMailer` 記一行 `MAIL_SENT` 的日誌，並且可以被注入失敗（`down`、`failNext`、`poisonUser`）—— AC-4 的「模擬的 SMTP 連續失敗」。

`EventFlowTest.cancelPaidRefunds` 走一次「下單 → 付款 → 買家取消」：

```
0.5.4：退款 {status=SUCCEEDED, attempts=1, provider_refund_id=RF1541227272}；金流實際退款 1 次；買家的通知 [ORDER_PLACED, ORDER_PAID, ORDER_CANCELLED, REFUND_SUCCEEDED]；賣家 [NEW_ORDER]
```

### 7.7.2 寄信沒有交易：dedup_key、認領、與擋不住的那一次

寄信不在 MySQL 裡，`processed_messages` 保護不了它（7.2.3）。這個消費者是 `transactional() = false`，冪等靠 `notifications` 自己：

```java
for (Target t : targets(e)) {
    String dedup = e.eventId() + ":" + t.type();
    jdbc.update("""
            INSERT INTO notifications (user_id, type, dedup_key, payload) VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE id = id""", t.userId(), t.type(), dedup, payload(e, t));          // ① V7 的 uk_notifications_dedup
    Map<String, Object> row = jdbc.queryForMap("SELECT id, status, attempts FROM notifications WHERE dedup_key = ?", dedup);
    if ("SENT".equals(row.get("status"))) continue;                // AC-3：已經寄過了
    long id = ((Number) row.get("id")).longValue();
    int attempts = ((Number) row.get("attempts")).intValue();
    int claimed = jdbc.update("UPDATE notifications SET attempts = attempts + 1 WHERE id = ? AND status <> 'SENT' AND attempts = ?", id, attempts);
    if (claimed == 0) continue;                                     // ② 同一則訊息的另一份正在寄（或剛寄完）
    mailer.send(t.userId(), t.type(), dedup, t.text());             // 失敗 → 例外 → 重試階梯（AC-4）
    jdbc.update("UPDATE notifications SET status = 'SENT', sent_at = CURRENT_TIMESTAMP(3) WHERE id = ?", id);   // ③
}
```

（`targets()` —— 每一種事件寄給誰、寄什麼 —— 與 `onDeadLetter()` 在 7.13.1 的完整 `NotificationHandler` 裡；`SimulatedMailer` 也在那裡。）

- **① `dedup_key` = eventId + 通知類型**：第 02 章 V7 就有的唯一索引（「同一事件只通知一次，US-NTF-1 AC-3」）。同一個事件、同一種通知，只會有一列。
- **② 認領**：`attempts` 從 n 改成 n + 1，條件是「還是 n」—— 同一則訊息同時被兩條執行緒處理（Q10 就是這樣送的），只有一條會成功認領，另一條什麼都不做。這是 0.5.5 的條件式 UPDATE，換了一張表。
- **③ 寄完才標 `SENT`。**

**擋不住的一種：寄出去了、③ 之前行程死掉。** 重送時 `status` 還是 `PENDING`，再認領、再寄一次 —— 買家收到兩封。SMTP 沒有冪等鍵，這個窗只能縮小（③ 緊跟在寄信之後），不能消失。這是 at-least-once 在「外部效果沒有冪等鍵」時的最後一塊，0.4.8 的 AC-3「只收到一次」在這個窗裡不成立；它要的是「行程剛好死在寄信與一句 UPDATE 之間」。這一章沒有量它發生的頻率（練習四）。

Q10 的通知那一半（7.11.2）：同一則 `order.placed` 同時送 10 次 → `notifications` 1 列、`attempts = 1`。

### 7.7.3 AC-4：重試 5 次、死信、下單不受影響

`EventFlowTest.mailerDownDeadLetters`（修好 7.5.3 那場風暴之後）：

```
NTF-1 AC-4：{status=FAILED, attempts=6}；死信佇列 1 則；訂單 20261002-770053 狀態 PENDING_PAYMENT
```

`attempts = 6`：第一次 ＋ 重試 5 次。測試環境的重試階梯縮短成 100、200、400、800、1,600 ms（一樣 5 級、一樣指數，`src/test/resources/config/application.yml`）—— 正式的 1、2、4、8、16 秒要等 31 秒。訂單維持 `PENDING_PAYMENT`：**通知失敗，下單不受影響**，因為下單的交易從來不知道 SMTP 的存在。

AC-2「事件發生後 p99 60 秒內」：7.4.3 量到的 commit → 寄出，p99 在 0.17～4.0 秒之間（輪詢間隔 10 ms～1 秒；這一章用的 100 ms 是 0.32～0.43 秒）。RabbitMQ 停掉的時候不會是這樣 —— 7.9 的演練量了它。

---

## 7.8 退款

### 7.8.1 交易外呼叫、冪等鍵、FAILED

0.5.4：`PAID/PICKING → CANCELLED`「同一個交易內：建立 `refunds(PENDING)`」、「提交後：呼叫金流退款 API（可重試，失敗進死信 + 告警）」。0.6.4：「退款執行 —— 最終一致 —— 5 分鐘內發起、失敗重試」。

```java
@Override
public void handle(Event e) {
    long refundId = e.getLong("refundId");
    Map<String, Object> r = jdbc.queryForMap("SELECT payment_id, order_id, amount, status FROM refunds WHERE id = ?", refundId);
    if ("SUCCEEDED".equals(r.get("status"))) return;                    // 重複的訊息：已經退過了
    long paymentId = ((Number) r.get("payment_id")).longValue();
    String providerRefundId;
    try {
        providerRefundId = gateway.refund("refund-" + refundId, paymentId, (BigDecimal) r.get("amount"));   // 交易外
    } catch (RuntimeException ex) {
        jdbc.update("UPDATE refunds SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", refundId);
        throw ex;                                                       // 重試階梯：1、2、4、8、16 秒
    }
    tx.executeWithoutResult(s -> {
        int n = jdbc.update("""
                UPDATE refunds SET status = 'SUCCEEDED', provider_refund_id = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP(3)
                 WHERE id = ? AND status IN ('PENDING', 'FAILED')""", providerRefundId, refundId);
        if (n == 1) outbox.add("REFUND", refundId, EventTypes.REFUND_SUCCEEDED, Map.of(…));
    });
}
```

- **金流呼叫在交易外面**（0.5.4 的 ⚠️、05-service/02 的 2.9.3）：金流慢 3 秒，不會有一條連線被佔 3 秒。
- **冪等鍵 `refund-{id}`**（7.2.3 的 ③）：同一張退款單，不管被處理幾次，金流只退一次錢。
- **用完了 → `FAILED`、`refund.failed`、`REFUND_FAILED` 的 ERROR、計數器 `shop.refunds.failed`**（`onDeadLetter`）：0.5.4 的「告警」，第 09 章接到告警系統。`FAILED` 的退款單在死信重放（7.5.5）時會再被處理一次 —— `WHERE status IN ('PENDING', 'FAILED')`。

`refunds.attempts` 從第 02 章的 V6 就有，第一次被用到。`RefundExecutor`（含 `onDeadLetter()`）、`SimulatedRefundGateway`、`PaymentApi.requestRefund` 的新簽章，完整內容在 7.13.1。

### 7.8.2 ⚠️ 「新建」與「已經有了」，回傳值一樣

`requestRefund()` 要做一件第 04 章不用做的事：**只有新建了退款單的那一次**，才寫 `refund.requested`。同一筆付款被要求退款兩次（買家取消與晚到的付款同時發生，4.6），第二次不能再發一個事件 —— 雖然冪等擋得住，但沒有理由製造它。

第 04 章的寫法是：

```sql
INSERT INTO refunds (payment_id, order_id, amount, reason, status)
SELECT id, order_id, amount, ?, 'PENDING' FROM payments WHERE id = ? AND status = 'SUCCEEDED'
ON DUPLICATE KEY UPDATE payment_id = refunds.payment_id
```

看回傳值就好了吧？MySQL 文件說：新建 → 1，更新 → 2，「已經有了、值沒變」→ 0。H9 量了一次：

```bash
mvn test -Pexperiments -Dtest=H9AffectedRowsTest
```

```
═══ 7.8.2 INSERT … ON DUPLICATE KEY UPDATE k = k 的回傳值 ═══
  預設（本專題的設定）             新建 → 1 │ 已經有了（沒有改任何值）→ 1 │ 已經有了、改了一個值 → 2
  useAffectedRows=true   新建 → 1 │ 已經有了（沒有改任何值）→ 0 │ 已經有了、改了一個值 → 2
```

**在這個專題的設定下，「新建」與「已經有了」都回 1。** MySQL 文件裡的那個 0，要用戶端**沒有**設 `CLIENT_FOUND_ROWS` 才會出現；Connector/J 預設設了它（`useAffectedRows=false`），讓「找到了但沒改」也算成 1。第 04 章不在乎這個回傳值，所以從來沒有人注意到 —— 第一次要依賴它的時候，它就是錯的。

改連線參數（`useAffectedRows=true`）可以讓它變回 0，但那會改變**所有** `UPDATE` 的回傳值：0.5.5 的條件式 UPDATE、4.6 的狀態轉移、6.4 的那些「影響 0 列 = 別人改過了」，每一個都依賴「找到了就算」的語意嗎？要一個一個查。為了一個呼叫點改全域的設定，代價不成比例。

所以這一章把它改成「普通的 `INSERT … SELECT`、撞鍵就接住」：

```java
int n;
try {
    n = jdbc.update("""
            INSERT INTO refunds (payment_id, order_id, amount, reason, status)
            SELECT id, order_id, amount, ?, 'PENDING' FROM payments WHERE id = ? AND status = 'SUCCEEDED'""",
            reason.name(), paymentId);
} catch (DuplicateKeyException already) {
    return;                                                         // 這筆付款已經有退款單：不重複建、不重複發事件
}
if (n == 0) return;                                                 // 付款不是 SUCCEEDED：沒有錢可以退
// ……讀出 refundId，outbox.add(REFUND_REQUESTED, …)……
```

第 04 章的註解說「不用 `INSERT IGNORE` —— 它會把所有錯誤降級成警告，包括 CHECK 違反」。這一條仍然成立：接住的只有 `DuplicateKeyException`，CHECK 違反照樣丟出去。

---

## 7.9 RabbitMQ 掛了

0.6.3 的「RabbitMQ」那一欄：

| 功能 | RabbitMQ 掛了 | 這一章的落實 |
|---|---|---|
| 下單（一般、熱點） | **201**（事件堆在 Outbox） | 下單交易只寫 `outbox_events`，不碰 broker |
| 建立付款、付款回呼、我的訂單、登入、商品詳情、搜尋、購物車 | 200 / 201 | 都不碰 broker |
| 熱門排行 | 200（不更新） | 排行是 SQL（6.8），跟 broker 無關 —— 這一格其實是「照常更新」 |
| 通知 | **延遲**，恢復後補送 | relay 把堆積的送出、消費者處理 |
| `/actuator/health/readiness` | **UP** | 0.10.6：readiness 只看 `db` |

驗收 Q8 是一格一格檢查 Redis 那一欄；RabbitMQ 這一欄沒有驗收題，這一章用一次演練回答它（第 06 章 6.9.2 的 G8 是同一種）。

H6 是第 06 章 G8 的 RabbitMQ 版：固定的混合流量跑 100 秒（一般商品下單每秒 10 張、熱點商品下單每秒 10 張、商品詳情每秒 50 次，開放式），第 20 秒把 RabbitMQ 停掉、第 80 秒恢復。每 5 秒一列：各 API 的狀態碼與 p99、outbox 堆了多少、這 5 秒寄出幾封通知、還沒落帳的熱點預留。第 40 秒（RabbitMQ 還停著）另外**啟動第二個實例**：起得來嗎？readiness 是什麼？一個計數佇列綁在 `order.placed` 上，數恢復之後同一個事件被送了幾次。

兩種「掛了」都做（5.6.4、6.9.2 學到的）：`docker stop`（行程不在了、連線被關掉，用戶端立刻知道）與 `docker pause`（行程被凍結、TCP 連線還在，送出去的東西沒有回應）。

```bash
mvn test -Pexperiments -Dtest=H6RabbitOutageDrillTest
```

### 7.9.1 ⚠️ 第一次：RabbitMQ 卡住，整站 503 —— 連商品詳情都是

第一次跑 `stop`，在 RabbitMQ 停機的頭 5 秒，一般與熱點的下單都出現了 503（13 個、15 個），p99 5 秒；日誌裡是：

```
2026-10-02T11:52:27.995+08:00 ERROR 56374 --- [shop] [-auto-1-exec-20] o.h.engine.jdbc.spi.SqlExceptionHelper   : HikariPool-1 - Connection is not available, request timed out after 3002ms.
```

連線池在 3 秒內拿不到連線（4.8.2：這會變成 503）。同一次 `stop` 裡還有另一種：25～30、45～50 秒各有 49、35 個**只有熱點**的下單 503，一般下單同時都是 201 —— 下面那條鏈會讓所有下單一起 503，對不上這個形狀；那一次的日誌層級是 ERROR，我沒有證據，**原因沒有找到**。（下面 `pause` 那一張表的頭 10 秒 —— RabbitMQ 還沒停 —— 也有這種只有熱點的 503。我的推測是 6.5.1 建立閘門的那一刻：每一次演練的熱點商品都是新建的、Redis 裡還沒有 key，幾十個請求同時等一個人去建，`gate()` 三次重試用完就回 503；但這只是推測。）而 `pause` 那一半根本沒有跑完 —— **實驗自己用來取樣的查詢，也拿不到連線**（第一版的取樣共用應用程式的連線池）。把取樣改成用自己的連線、另外記「等 outbox 鎖的交易」與「等連線的執行緒」，只跑 `pause`：

```
═══ 7.9 RabbitMQ 停 60 秒：docker pause shop-rabbitmq-1（第 20～80 秒）═══
  秒      RabbitMQ │ 一般下單 狀態          p99 ms │ 熱點下單 狀態          p99 ms │ 詳情 狀態     │ outbox 未送出（最舊） │ 這 5 秒寄出的通知 │ 未落帳的熱點預留 │ 等 outbox 鎖的交易（最多）│ 等連線（最多）
    0-5   正常     │ {201=45}               4270 │ {201=16, 503=33}       2883 │ {200=250}    │      5（  0.2 秒）    │        0          │     16           │      3                   │   22
    5-10  正常     │ {201=53}                683 │ {201=19, 503=28}        407 │ {200=250}    │      0（  0.0 秒）    │        0          │     19           │      1                   │    0
   10-15  正常     │ {201=48}                420 │ {201=55}                388 │ {200=250}    │      0（  0.0 秒）    │        0          │      2           │      1                   │    0
   15-20  正常     │ {201=47}                572 │ {201=49}                545 │ {200=250}    │      2（  0.1 秒）    │        0          │      1           │      0                   │    0
   20-25  停了     │ {0=13, 201=9, 503=28}  10089 │ {0=5, 201=16, 503=30}  10020 │ {200=214, 503=36} │      6（  4.9 秒）    │        0          │      3           │     11                   │  143
   25-30  停了     │ {0=1, 503=49}         10024 │ {201=1, 503=49}        3550 │ {200=234, 503=16} │     29（ 10.1 秒）    │        0          │     20           │     11                   │  163
   30-35  停了     │ {503=49}               4344 │ {503=56}               4402 │ {200=11, 503=235} │     29（ 15.1 秒）    │        0          │     20           │      6                   │  182
   35-40  停了     │ {503=46}               5202 │ {503=48}               5162 │ {503=254}    │     29（ 19.9 秒）    │        0          │     20           │      6                   │  181
   40-45  停了     │ {503=49}               6124 │ {503=47}               6367 │ {503=250}    │     29（ 25.0 秒）    │        0          │     20           │      6                   │  182
   45-50  停了     │ {503=52}               7002 │ {503=66}               7297 │ {503=250}    │     29（ 29.9 秒）    │        0          │     20           │      6                   │  182
   50-55  停了     │ {503=50}               8486 │ {503=51}               8474 │ {503=250}    │     29（ 34.9 秒）    │        0          │     20           │      6                   │  125
   55-60  停了     │ {0=2, 503=48}         10137 │ {0=5, 503=56}         10000 │ {200=81, 503=169} │     29（ 39.9 秒）    │        0          │     20           │      6                   │  182
   60-65  停了     │ {503=50}               8600 │ {503=50}               8576 │ {200=250}    │     29（ 44.9 秒）    │        0          │     20           │      6                   │  182
   65-70  停了     │ {503=47}               3764 │ {503=47}               3728 │ {200=250}    │     36（ 49.9 秒）    │        0          │     25           │      6                   │  182
   70-75  停了     │ {201=5, 503=45}        8361 │ {201=9, 503=41}        8169 │ {200=61, 503=189} │     36（ 54.9 秒）    │        0          │     25           │      6                   │  182
   75-80  停了     │ {201=26, 503=24}       6334 │ {201=23, 503=26}       6610 │ {200=250}    │     46（ 59.9 秒）    │        0          │     31           │     11                   │  181
   80-85  正常     │ {201=50}               1917 │ {201=51}               1527 │ {200=250}    │      2（  0.1 秒）    │        0          │      1           │     11                   │   68
   85-90  正常     │ {201=45}                383 │ {201=54}                428 │ {200=250}    │      2（  0.1 秒）    │        0          │      1           │      0                   │    0
   90-95  正常     │ {201=34, 503=1}        7752 │ {201=32, 503=5}        7800 │ {200=248}    │      2（  4.6 秒）    │        0          │      2           │      1                   │    0
   95-100 正常     │ {201=48, 503=12}       6337 │ {201=8, 503=57}        3096 │ {200=252}    │      1（  1.7 秒）    │        0          │      2           │      2                   │   39
  恢復之後：outbox 在第 102 秒清空、熱點預留在第 102 秒全部落帳、通知在第 102 秒全部寄出（RabbitMQ 在第 80 秒恢復）
  通知延遲（訂單建立 → 寄出），其他時間下的單  ：881 封，p50 0.6 秒、p99 61.2 秒、最慢 61.7 秒
  計數佇列（order.placed）：訂單 764 張 → 收到 789 則、不同的 eventId 764 個（重複 25 則）│ 消費者擋下的重複：落帳 39、通知 （以 notifications.attempts 看）
  通知：attempts > 1 的 0 封、寄出的總數 1303 封（訂單 764 張，每張 1 封）
  第二個實例（第 40 秒啟動，RabbitMQ 停著）：啟動花了 40277 ms，readiness HTTP 200 {"status":"UP","components":{"db":{"status":"UP","details":{"database":"MySQL","validationQuery":"isValid()"}},"readinessState":{"status":"UP"}}}
```

（這一次的「這 5 秒寄出的通知」與兩行通知延遲不能用：取樣的那條連線少了 `connectionTimeZone=UTC`，時間窗差了 8 小時。其他欄位跟時間窗無關。）

**第 25 到 75 秒，幾乎每一個請求都是 503 —— 一般下單、熱點下單，還有商品詳情。** 等連線的執行緒 180 幾個。0.6.3 那一欄寫的是「RabbitMQ 掛了：下單 201（事件堆在 Outbox）、商品詳情 200」。**一格都沒有對上。**

「等 outbox 鎖的交易」只有 6～11 個，所以不是一大堆交易在等同一個鎖。是什麼佔住了 20 條連線？H6b 用同樣的流量（少一點）、`pause` 之後 20 秒，把整個 JVM 的執行緒堆疊取下來，依「卡在哪一行我們的程式碼、經過了誰」分組，同時看 MySQL 那一側 `shop` 的連線在做什麼：

```bash
mvn test -Pexperiments -Dtest=H6bPauseDiagnoseTest
```

```
═══ 7.9 pause 之後 20 秒：連線池 使用中 20、閒置 0、等連線的執行緒 182 ═══
  151 條  JdbcInventoryService.available:270 │ 最上面：Unsafe.park │ 經過：com.zaxxer（例：http-nio-auto-1-exec-165）
   30 條  IdempotencyKeys.claim:51 │ 最上面：Unsafe.park │ 經過：com.zaxxer（例：http-nio-auto-1-exec-86）
   18 條  JdbcInventoryService.reserve:116 │ 最上面：Net.poll │ 經過：com.mysql（例：http-nio-auto-1-exec-14）
    1 條  JdbcOutbox.add:37 │ 最上面：Net.poll │ 經過：com.mysql（例：http-nio-auto-1-exec-5）
    1 條  OutboxStore.backlog:52 │ 最上面：Unsafe.park │ 經過：com.zaxxer（例：scheduling-1）
    1 條  RabbitOutboxRelay.lambda$relayOnce$0:82 │ 最上面：Object.wait0 │ 經過：com.rabbitmq（例：outbox-relay）
  ── MySQL：shop 的連線 ──
   18 條  Query │ updating │ UPDATE inventory SET reserved = reserved + 1, upda │ 交易中 true
    1 條  Sleep │  │ — │ 交易中 true
    1 條  Query │ update │ INSERT INTO outbox_events (event_id, aggregate_typ │ 交易中 true
  這 25 秒的回應：{下單 0=19, 下單 201=59, 下單 503=151, 詳情 200=802, 詳情 503=341}
```

由下往上讀，是一條鏈：

1. **`outbox-relay` 停在 RabbitMQ 用戶端裡**（`relayOnce:82`，`rabbit.send(...)`，`Object.wait`）—— broker 被凍結了，它在等一個不會來的回應。**它在一個資料庫交易裡等**：MySQL 那一側有一條連線是 `Sleep`、**交易中**。那個交易 claim 了幾列 outbox，`FOR UPDATE` 的鎖（包括 REPEATABLE READ 的間隙鎖）還拿著。
2. **一張訂單卡在 `INSERT INTO outbox_events`**（`JdbcOutbox.add`，MySQL：`update`、交易中）—— 被 relay 的間隙鎖擋住。**它在下單交易的最後一步**：前面的 `UPDATE inventory SET reserved = reserved + 1` 已經做完，那個商品的 `inventory` 列鎖在它手上。
3. **18 張訂單卡在 `UPDATE inventory`**（`reserve:116`，MySQL：`updating`）—— 排在那一列後面。
4. **20 條連線用完了**：151 個商品詳情（`available:270`，可售量的那句 SQL）、30 個下單的冪等鍵（`claim:51`）在等連線，3 秒後變成 503。

**RabbitMQ 卡住，商品詳情 503 —— 中間隔了四層。** 每一層都是正確的：relay 等 confirm 是對的（7.4.2）；outbox 跟訂單同一個交易是對的（7.4.1）；下單交易先改父表、再寫子表是對的（2.6.2）；連線逾時變 503 也是對的（4.8.2）。錯在第一層：**relay 在交易裡等 broker**。7.4.2 的第一版寫的理由是「鎖住的只是 outbox 的幾十列，沒有人在等它們」—— 間隙鎖讓**每一個**要寫 outbox 的交易都在等它們，而每一個寫 outbox 的交易手上都還有別的鎖。

`stop` 沒有那麼嚴重，是因為停掉的 broker 會**立刻拒絕連線**，relay 的交易幾毫秒就 rollback；只有在 RabbitMQ 關機的那幾秒（還在關、連線還沒斷），它會短暫地等 —— 那就是第一次 `stop` 的頭 5 秒那 28 個 503。**`pause` 是比較難的那一種**（5.6.4 就說過）：網路分割、broker 卡在 GC 或磁碟上，看起來都像它。

### 7.9.2 修法：送出的時候，手上什麼都不拿

7.4.2 的第二版：認領（短交易、READ COMMITTED、蓋租約）→ 送出與等 confirm（沒有交易）→ 標記（短交易）。外加把 RabbitMQ 用戶端的通道 RPC 逾時從 10 分鐘改成 5 秒。V14 給 `outbox_events` 加了租約欄位 `claimed_until`。

同一個 H6b，修正之後：

```
═══ 7.9 pause 之後 20 秒：連線池 使用中 0、閒置 20、等連線的執行緒 0 ═══
    1 條  RabbitOutboxRelay.relayOnce:92 │ 最上面：Object.wait0 │ 經過：com.rabbitmq（例：outbox-relay）
  ── MySQL：shop 的連線 ──
   20 條  Sleep │  │ — │ 交易中 false
  這 25 秒的回應：{下單 201=251, 詳情 200=1255}
```

relay **還是**停在 RabbitMQ 用戶端裡（broker 還是凍結的），但連線池「使用中 0、閒置 20、等待 0」，MySQL 那一側 20 條連線都是 `Sleep`、**沒有一條在交易中**。這 25 秒的回應全部是 201、200。（第一次跑修正後的 H6b 時，裡面有 100 個 200：H6b 的第一版沒有清掉上一次的買家，同一個冪等鍵回了同一張訂單。那個沒清乾淨的東西後來還讓全套測試紅了一次，7.13。上面是 H6b 補上清理之後重跑的。）

> 📌 **「交易裡只有 SQL」（4.3.3）不只是為了熱點列。** 第 04 章用它保護下單交易的持鎖時間；這一節是同一條規則的另一面：**任何等外部系統的程式碼，都不能拿著資料庫的鎖等** —— 包括「只是 outbox 的幾列」。鎖的影響範圍不是你鎖了幾列，是「誰會來碰這幾列附近的東西、他們手上又拿著什麼」。

### 7.9.3 修正之後的演練

同一個 H6，修正 relay 之後，取樣用自己的連線（帶 `connectionTimeZone=UTC`）。這一節的程式碼在途中又改了一次（7.9.4），所以我一共跑了四次；下面是最後一次（這一章最後的程式碼，開始時 load average 4.2）的完整輸出：

```
═══ 7.9 RabbitMQ 停 60 秒：docker stop shop-rabbitmq-1（第 20～80 秒）═══
  秒      RabbitMQ │ 一般下單 狀態          p99 ms │ 熱點下單 狀態          p99 ms │ 詳情 狀態     │ outbox 未送出（最舊） │ 這 5 秒寄出的通知 │ 未落帳的熱點預留 │ 等 outbox 鎖的交易（最多）│ 等連線（最多）│ Redis 失敗／跳開
    0-5   正常     │ {201=50}                305 │ {201=50}                263 │ {200=250}    │      0（  0.0 秒）    │      100          │      0           │      0                   │    0          │ 0／0
    5-10  正常     │ {201=50}                 35 │ {201=50}                 65 │ {200=250}    │      1（  0.0 秒）    │      100          │      0           │      0                   │    0          │ 0／0
   10-15  正常     │ {201=50}                 73 │ {201=50}                 52 │ {200=250}    │      2（  0.1 秒）    │       98          │      0           │      0                   │    0          │ 0／0
   15-20  正常     │ {201=50}                 32 │ {201=49}                 42 │ {200=250}    │      1（  0.0 秒）    │      101          │      0           │      0                   │    0          │ 0／0
   20-25  停了     │ {201=49}                 42 │ {201=50}                 41 │ {200=250}    │     99（  5.0 秒）    │        0          │     50           │      0                   │    0          │ 0／0
   25-30  停了     │ {201=50}                 67 │ {201=51}                 36 │ {200=250}    │    201（ 10.0 秒）    │        0          │    101           │      0                   │    0          │ 0／0
   30-35  停了     │ {201=50}                 79 │ {201=52}                 44 │ {200=250}    │    302（ 15.0 秒）    │        0          │    153           │      0                   │    0          │ 0／0
   35-40  停了     │ {201=50}                 52 │ {201=50}                 37 │ {200=250}    │    403（ 20.0 秒）    │        0          │    203           │      0                   │    0          │ 0／0
   40-45  停了     │ {201=50}                 59 │ {201=50}                 57 │ {200=250}    │    502（ 25.0 秒）    │        0          │    253           │      0                   │    0          │ 0／0
   45-50  停了     │ {201=50}                102 │ {201=51}                 34 │ {200=250}    │    604（ 30.0 秒）    │        0          │    304           │      0                   │    0          │ 0／0
   50-55  停了     │ {201=50}                 30 │ {201=50}                 62 │ {200=250}    │    704（ 35.0 秒）    │        0          │    354           │      0                   │    0          │ 0／0
   55-60  停了     │ {201=50}                 66 │ {201=50}                 44 │ {200=250}    │    804（ 40.0 秒）    │        0          │    404           │      0                   │    0          │ 0／0
   60-65  停了     │ {201=50}                 80 │ {201=50}                 55 │ {200=250}    │    903（ 45.0 秒）    │        0          │    454           │      0                   │    0          │ 0／0
   65-70  停了     │ {201=50}                 65 │ {201=50}                 55 │ {200=250}    │   1004（ 50.0 秒）    │        0          │    504           │      0                   │    0          │ 0／0
   70-75  停了     │ {201=51}                 64 │ {201=50}                 50 │ {200=250}    │   1104（ 55.0 秒）    │        0          │    554           │      0                   │    0          │ 0／0
   75-80  停了     │ {201=49}                225 │ {201=49}                190 │ {200=250}    │   1202（ 60.0 秒）    │        0          │    603           │      0                   │    0          │ 0／0
   80-85  正常     │ {201=49}                 87 │ {201=50}                 68 │ {200=250}    │   1302（ 65.0 秒）    │        0          │    653           │      0                   │    0          │ 0／0
   85-90  正常     │ {201=49}                 52 │ {201=50}                 63 │ {200=250}    │      2（  0.1 秒）    │      646          │    146           │      0                   │    0          │ 0／0
   90-95  正常     │ {201=50}                147 │ {201=50}                 30 │ {200=250}    │      2（  0.1 秒）    │      852          │      1           │      0                   │    0          │ 0／0
   95-100 正常     │ {201=49}                213 │ {201=49}                186 │ {200=250}    │      1（  0.1 秒）    │       99          │      1           │      0                   │    0          │ 0／0
  恢復之後：outbox 在第 100 秒清空、熱點預留在第 100 秒全部落帳、通知在第 100 秒全部寄出（RabbitMQ 在第 80 秒恢復）
  通知延遲（訂單建立 → 寄出），停機期間下的單：1202 封，p50 39.9 秒、p99 66.8 秒、最慢 67.3 秒
  通知延遲（訂單建立 → 寄出），其他時間下的單  ：795 封，p50 0.1 秒、p99 11.5 秒、最慢 11.8 秒
  計數佇列（order.placed）：訂單 1997 張 → 收到 1997 則、不同的 eventId 1997 個（重複 0 則）│ 消費者擋下的重複：落帳 0、通知 （以 notifications.attempts 看）
  通知：attempts > 1 的 0 封、寄出的總數 1997 封（訂單 1997 張，每張 1 封）
  第二個實例（第 40 秒啟動，RabbitMQ 停著）：啟動花了 1638 ms，readiness HTTP 200 {"status":"UP","components":{"db":{"status":"UP","details":{"database":"MySQL","validationQuery":"isValid()"}},"readinessState":{"status":"UP"}}}
═══ 7.9 RabbitMQ 停 60 秒：docker pause shop-rabbitmq-1（第 20～80 秒）═══
  秒      RabbitMQ │ 一般下單 狀態          p99 ms │ 熱點下單 狀態          p99 ms │ 詳情 狀態     │ outbox 未送出（最舊） │ 這 5 秒寄出的通知 │ 未落帳的熱點預留 │ 等 outbox 鎖的交易（最多）│ 等連線（最多）│ Redis 失敗／跳開
    0-5   正常     │ {201=48}                370 │ {201=52}                413 │ {200=250}    │      2（  0.1 秒）    │       98          │      1           │      0                   │    0          │ 0／0
    5-10  正常     │ {201=50}                 42 │ {201=50}                 51 │ {200=250}    │      3（  0.1 秒）    │      100          │      1           │      0                   │    0          │ 0／0
   10-15  正常     │ {201=50}                 64 │ {201=50}                 33 │ {200=250}    │      1（  0.1 秒）    │      101          │      1           │      0                   │    0          │ 0／0
   15-20  正常     │ {201=50}                 61 │ {201=50}                 44 │ {200=250}    │      2（  0.1 秒）    │      100          │      1           │      0                   │    0          │ 0／0
   20-25  停了     │ {201=50}                 41 │ {201=50}                 48 │ {200=250}    │    101（  5.1 秒）    │        0          │     51           │      0                   │    0          │ 0／0
   25-30  停了     │ {201=50}                 57 │ {201=50}                 69 │ {200=250}    │    201（ 10.1 秒）    │        0          │    101           │      0                   │    0          │ 0／0
   30-35  停了     │ {201=50}                 36 │ {201=50}                 50 │ {200=250}    │    301（ 15.1 秒）    │        0          │    151           │      0                   │    0          │ 0／0
   35-40  停了     │ {201=50}                 36 │ {201=50}                 66 │ {200=250}    │    402（ 20.1 秒）    │        0          │    201           │      0                   │    0          │ 0／0
   40-45  停了     │ {201=50}                 78 │ {201=50}                 42 │ {200=250}    │    501（ 25.1 秒）    │        0          │    251           │      0                   │    0          │ 0／0
   45-50  停了     │ {201=50}                 47 │ {201=50}                113 │ {200=250}    │    601（ 30.1 秒）    │        0          │    301           │      0                   │    0          │ 0／0
   50-55  停了     │ {201=50}                 61 │ {201=50}                 27 │ {200=250}    │    701（ 35.1 秒）    │        0          │    351           │      0                   │    0          │ 0／0
   55-60  停了     │ {201=49}                 29 │ {201=50}                 32 │ {200=250}    │    801（ 40.1 秒）    │        0          │    401           │      0                   │    0          │ 0／0
   60-65  停了     │ {201=50}                 70 │ {201=50}                 51 │ {200=249}    │    900（ 45.1 秒）    │        0          │    451           │      0                   │    0          │ 0／0
   65-70  停了     │ {201=51}                 87 │ {201=50}                 52 │ {200=251}    │   1001（ 50.1 秒）    │        0          │    501           │      0                   │    0          │ 0／0
   70-75  停了     │ {201=50}                 30 │ {201=50}                 36 │ {200=250}    │   1101（ 55.1 秒）    │        0          │    551           │      0                   │    0          │ 0／0
   75-80  停了     │ {201=50}                 55 │ {201=50}                 43 │ {200=250}    │   1201（ 60.1 秒）    │        0          │    601           │      0                   │    0          │ 0／0
   80-85  正常     │ {201=49}                 60 │ {201=50}                 52 │ {200=250}    │      1（  0.1 秒）    │     1299          │      1           │      0                   │    0          │ 0／0
   85-90  正常     │ {201=50}                 80 │ {201=50}                 45 │ {200=250}    │      2（  0.1 秒）    │       99          │      1           │      0                   │    0          │ 0／0
   90-95  正常     │ {201=50}                 36 │ {201=50}                 28 │ {200=250}    │      1（  0.0 秒）    │      102          │      0           │      0                   │    0          │ 0／0
   95-100 正常     │ {201=50}                 80 │ {201=50}                119 │ {200=250}    │      2（  0.1 秒）    │       98          │      1           │      0                   │    0          │ 0／0
  恢復之後：outbox 在第 100 秒清空、熱點預留在第 100 秒全部落帳、通知在第 100 秒全部寄出（RabbitMQ 在第 80 秒恢復）
  通知延遲（訂單建立 → 寄出），停機期間下的單：1200 封，p50 33.0 秒、p99 59.7 秒、最慢 60.2 秒
  通知延遲（訂單建立 → 寄出），其他時間下的單  ：799 封，p50 0.1 秒、p99 4.3 秒、最慢 60.2 秒
  計數佇列（order.placed）：訂單 1999 張 → 收到 2005 則、不同的 eventId 1999 個（重複 6 則）│ 消費者擋下的重複：落帳 6、通知 （以 notifications.attempts 看）
  通知：attempts > 1 的 0 封、寄出的總數 1999 封（訂單 1999 張，每張 1 封）
  第二個實例（第 40 秒啟動，RabbitMQ 停著）：啟動花了 1252 ms，readiness HTTP 200 {"status":"UP","components":{"db":{"status":"UP","details":{"database":"MySQL","validationQuery":"isValid()"}},"readinessState":{"status":"UP"}}}
```

（`Redis 失敗／跳開` 是 `shop.redis.failures`、`shop.redis.trips` 這 5 秒的增量 —— 6.9.2 的 `RedisGuard`，第二次起才加的一欄，原因在 7.9.5。`pause` 那一半，日誌裡還有一行 `MissedHeartbeatException: Heartbeat missing with heartbeat = 20 seconds`：RabbitMQ 用戶端自己把連線判死。訊息裡的「20 seconds」是心跳的**設定值**，不是等了多久：amqp-client 5.19 把 socket 逾時設成心跳的 1/4（5 秒），連續逾時**超過 8 次**才丟這個例外 —— 也就是大約 45 秒完全沒有資料（專題寫完之後反組譯 `AMQConnection.handleSocketTimeout` 確認的）。）

（每一段輸出最後的「恢復之後：outbox 在第 100 秒清空……」要小心讀：H6 是等第 100 秒的流量結束之後，才開始檢查「清空了沒」，所以那個「第 100 秒」只是**下界**。真正清空的時間要看逐 5 秒的那幾列：最後一次的 `stop`，outbox 在 85～90 秒那一列已經只剩 2 則、未落帳的熱點預留在 90～95 秒那一列剩 1 筆；`pause` 在 80～85 秒那一列，兩者都只剩 1。）

**0.6.3 的那一欄，一格一格對，四次並排：**

| | 0.6.3 寫的 | 第 1 次（load 17.5） | 第 2 次（load 5.0） | 第 3 次（7.9.4 修正後，7.0） | 第 4 次（最後，4.2） |
|---|---|---|---|---|---|
| 一般下單 | 201 | 全部 201 | 全部 201 | 全部 201 | 全部 201 |
| 熱點下單 | 201 | **`stop` 63 個 503、`pause` 141 個 503**（7.9.5） | 全部 201 | 全部 201 | 全部 201 |
| 商品詳情 | 200 | 全部 200 | 全部 200 | 全部 200 | 全部 200 |
| 通知：停機期間下的單（`stop`） | 延遲、恢復後補送 | p50 56.6、p99 77.9 秒 | p50 40.8、p99 66.9 秒 | p50 39.7、p99 66.6 秒 | p50 39.9、p99 66.8 秒 |
| 通知：停機期間下的單（`pause`） | 同上 | p50 41.4、p99 63.6 秒 | p50 34.3、p99 60.0 秒 | p50 32.9、p99 59.8 秒 | p50 33.0、p99 59.7 秒 |
| 每張訂單一封通知、`attempts > 1` | —— | 全部一封、0 | 全部一封、0 | 全部一封、0 | 全部一封、0 |
| `order.placed` 重複（`stop`／`pause`） | （at-least-once） | 0／14 | 0／4 | 0／8 | 0／6 |
| 第二個實例（`stop`） | readiness UP | 4,734 ms，UP | 1,719 ms，UP | 1,397 ms，UP | 1,638 ms，UP |
| 第二個實例（`pause`） | readiness UP | **43,545 ms**，UP | **40,309 ms**，UP | 1,106 ms，UP | 1,252 ms，UP |

**最後兩次，那一欄每一格都對上了。** 前兩次有兩格沒有：第二個實例在 `pause` 的時候要 40 秒以上（7.9.4），以及第 1 次的熱點下單有 503（7.9.5）。先說對上的部分。

**下單與詳情不再跟著 RabbitMQ 走。** 7.9.1 的那一次，`pause` 的第 25～75 秒幾乎每一個請求都是 503；這四次，「等 outbox 鎖的交易」與「等連線」兩欄在停機的 60 秒裡全部是 0。最後一次，一般下單在停機期間的 p99 是 29～225 ms，跟停機之前（32～370 ms）是同一個範圍。

**通知延遲就是停機的長度。** 停機期間下的單，p99 是 60～78 秒：最早的那一張要等 RabbitMQ 回來（60 秒），再加上恢復之後 relay 送完一千多列、消費者寄完一千多封的時間。NTF-1 AC-2 寫的是「事件發生後 p99 60 秒內」—— RabbitMQ 停 60 秒的時候它不可能達成，**這一格我記成「平常達成（7.4.3：0.17～4.0 秒）、停機時是停機的長度加上補送」**，不寫成 ✅。（最後一次 `pause` 的「其他時間下的單」最慢也是 60.2 秒：我推測是第 20 秒前一刻建立、還沒送出就遇上凍結的那幾張；沒有逐筆查。）

**`pause` 會重複，`stop` 不會。** `stop` 的時候 broker 立刻拒絕連線，relay 送不出去，什麼都沒送到；`pause` 的時候，relay 送出去的那一批可能已經進了 broker，只是 confirm 回不來 —— 5 秒內沒有收到 confirm（`confirm-timeout`，7.4.2 的 ③），那一批放回去，恢復之後再送一次。四次分別是 14、4、8、6 則，每一次落帳的消費者擋下的重複（`processed_messages`）都是同一個數字，通知的 `attempts > 1` 都是 0。

**outbox 清空的時間，第 1 次不一樣。** 其他三次在恢復之後 5～10 秒就送完了；第 1 次的 `stop`，恢復之後的 15 秒裡 outbox 還在長（1,196 → 1,298 → 1,282），第 100 秒才清空。`docker start` 回來的那一刻不等於 broker 可以收訊息（它要重新載入 quorum 佇列），而那台機器當時很忙 —— **這是推測，我沒有量 broker 開機花了多久。**

### 7.9.4 ⚠️ RabbitMQ 凍結的時候，新的實例起不來

前兩次的第二個實例，`stop` 的時候 1.7～4.7 秒，`pause` 的時候 40.3、43.5 秒 —— readiness 最後是 UP，看起來只是「慢一點」。但第二個實例是在第 40 秒啟動的，RabbitMQ 在第 80 秒恢復：**40 秒，正好是「等到 broker 回來」。**

H6c 把這件事單獨拿出來：先 `docker pause`，再啟動一個實例，每 2 秒取一次啟動執行緒的堆疊，最多等 60 秒：

```bash
mvn test -Pexperiments -Dtest=H6cStartupUnderPauseTest
```

```
═══ 7.9.4 RabbitMQ 被 pause 的時候啟動，每 2 秒取一次啟動執行緒的堆疊（最多 60 秒）═══
    2.0 秒 │ 最上面：URL.<init>:731 │ RabbitMQ：— │ 我們的：H6cStartupUnderPauseTest.lambda$startupWhileBrokerPaused$0:39
    4.0 秒 │ 最上面：Inflater.inflateBytesBytes:-2 │ RabbitMQ：— │ 我們的：H6cStartupUnderPauseTest.lambda$startupWhileBrokerPaused$0:39
    6.0 秒 │ 最上面：Object.wait0:-2 │ RabbitMQ：BlockingCell.get:73 │ 我們的：RabbitConsumers.start:186
    8.0 秒 │ 最上面：Object.wait0:-2 │ RabbitMQ：BlockingCell.get:73 │ 我們的：RabbitConsumers.start:186
   10.0 秒 │ 最上面：Object.wait0:-2 │ RabbitMQ：BlockingCell.get:73 │ 我們的：RabbitConsumers.start:186
   12.0 秒 │ 最上面：Object.wait0:-2 │ RabbitMQ：BlockingCell.get:73 │ 我們的：RabbitConsumers.start:186
   14.0 秒 │ 最上面：Object.wait0:-2 │ RabbitMQ：BlockingCell.get:73 │ 我們的：RabbitConsumers.start:186
   16.0 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   18.0 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   20.0 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   22.0 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   24.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   26.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   28.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   30.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   32.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   34.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   36.1 秒 │ 最上面：Object.wait0:-2 │ RabbitMQ：BlockingCell.get:73 │ 我們的：RabbitConsumers.start:186
   38.1 秒 │ 最上面：Object.wait0:-2 │ RabbitMQ：BlockingCell.get:73 │ 我們的：RabbitConsumers.start:186
   40.1 秒 │ 最上面：Object.wait0:-2 │ RabbitMQ：BlockingCell.get:73 │ 我們的：RabbitConsumers.start:186
   42.1 秒 │ 最上面：Object.wait0:-2 │ RabbitMQ：BlockingCell.get:73 │ 我們的：RabbitConsumers.start:186
   44.1 秒 │ 最上面：Object.wait0:-2 │ RabbitMQ：BlockingCell.get:73 │ 我們的：RabbitConsumers.start:186
   46.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   48.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   50.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   52.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   54.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   56.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   58.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
   60.1 秒 │ 最上面：Unsafe.park:-2 │ RabbitMQ：SimpleMessageListenerContainer$AsyncMessageProcessingConsumer.getStartupException:1280 │ 我們的：RabbitConsumers.start:186
  60 秒內沒有啟動完成
```

**60 秒，起不來。** 第 6 秒之後，啟動執行緒一直停在 `RabbitConsumers.start:186` —— `SimpleMessageListenerContainer.start()`。它會等這個 container 的消費者真的連上 broker、訂閱成功（`getStartupException`），或者等到它自己放棄；放棄之後下一個 container 再等一次。堆疊在兩個地方之間輪流：`BlockingCell.get`（RabbitMQ 用戶端在等 broker 的一個回覆）與 `getStartupException`（container 在等它的消費者回報「啟動好了」），大約 30 秒一輪 —— broker 被凍結，那個回覆永遠不會來。我第一次跑這個實驗的時候沒有設 60 秒的上限，它跑了 400 秒都沒有起來，最後是我把它停掉的。

這違反了 0.6.3「RabbitMQ 掛了：readiness UP」——**不是正在跑的實例，是新的實例**：部署、擴容、被 OOM killer 殺掉之後重啟，都會卡在這裡，直到 broker 回來。`stop` 不會：四次的第二個實例都是一兩秒、最多 4.7 秒就起來了。我的理解是 broker 不在時連線**立刻**被拒絕，container 的消費者很快就回報失敗、改成在背景重試，`start()` 不用等 —— 這一段是從 `stop` 的啟動時間推的，我沒有取 `stop` 時的堆疊。

修法是讓啟動不等 broker：`RabbitConsumers.start()` 只啟動一條自己的執行緒，由它逐一啟動 container。

```java
@Override
public void start() {
    Thread t = new Thread(this::startContainers, "rabbit-consumers-starter");
    t.setDaemon(true);
    starter = t;
    t.start();
}

private void startContainers() {
    for (EventHandler h : handlers) {
        if (starter == null) return;                                    // stop() 已經被呼叫
        SimpleMessageListenerContainer c = new SimpleMessageListenerContainer(cf);
        // ……（設定同前）
        containers.add(c);                                              // 先放進去：start() 卡住時 stop() 也找得到它
        try {
            c.start();
        } catch (RuntimeException e) {
            if (starter == null) { c.stop(); return; }                  // 關機途中被 interrupt：不是錯誤
            log.error("CONSUMER_START_FAILED consumer={}：{}", h.consumer(), e.toString());
        }
    }
}
```

（第一版沒有那個 `try`：第 3 次 H6 的第二個實例在 `stop` 期間被關掉時，`stop()` 中斷了還卡在 `c.start()` 的執行緒，日誌裡多了一條沒人接的 `UncategorizedAmqpException: java.lang.InterruptedException`。加上之後跑了第 4 次。）

relay 本來就在自己的執行緒上（7.4.2），所以只有消費者要改。修正之後的 H6c：

```
═══ 7.9.4 RabbitMQ 被 pause 的時候啟動，每 2 秒取一次啟動執行緒的堆疊（最多 60 秒）═══
    2.0 秒 │ 最上面：SinksSpecs$AbstractSerializedSink.<clinit>:43 │ RabbitMQ：— │ 我們的：H6cStartupUnderPauseTest.lambda$startupWhileBrokerPaused$0:39
    4.0 秒 │ 最上面：ClassLoader.defineClass1:-2 │ RabbitMQ：— │ 我們的：H6cStartupUnderPauseTest.lambda$startupWhileBrokerPaused$0:39
  啟動花了 6,010 ms（RabbitMQ 還是 pause 的）
  readiness HTTP 200 {"status":"UP","components":{"db":{"status":"UP","details":{"database":"MySQL","validationQuery":"isValid()"}},"readinessState":{"status":"UP"}}}
  unpause 之後 0.6 秒：shop.notification.order-events 的消費者 2 個
```

**RabbitMQ 還凍結著，6.0 秒啟動完成、readiness UP；unpause 之後 0.6 秒，消費者接上了。** H6 的第 3、4 次，第二個實例在 `pause` 的時候是 1,106、1,252 ms。

> 📌 **「依賴掛了，readiness 仍 UP」要分成兩件事驗：** 正在跑的實例會不會被拖垮（7.9.1），以及**新的實例起不起得來**。而且要兩種「掛了」都做：這一個只在 `pause` 裡看得到，`stop` 的四次都是一兩秒就起來了。

### 7.9.5 沒找到原因的：第 1 次的熱點 503

第 1 次的這幾列（只摘熱點下單與等連線兩欄；完整的表跟 7.9.1、7.9.3 的格式一樣，課文沒有收錄）：

```
═══ docker stop ═══
   70-75  停了     │ 熱點 {201=34, 503=4}        4974 │ 等連線（最多）  0
   75-80  停了     │ 熱點 {503=38}               2179 │ 等連線（最多） 58
   80-85  正常     │ 熱點 {201=28, 503=21}        150 │ 等連線（最多）  0
═══ docker pause ═══
   80-85  正常     │ 熱點 {201=1, 503=68}        2877 │ 等連線（最多） 10
   85-90  正常     │ 熱點 {201=30, 503=18}        340 │ 等連線（最多）  0
   90-95  正常     │ 熱點 {201=32, 503=14}       1224 │ 等連線（最多）  0
   95-100 正常     │ 熱點 {201=9, 503=41}          73 │ 等連線（最多）  0
```

同一時間，一般下單全部是 201。熱點下單回 503 的地方只有兩個：連線池拿不到連線（`GlobalExceptionHandler`，一般下單也會中），與 `HotStock.gate()` 的 `unavailable()` —— Redis 呼叫失敗或 `RedisGuard` 跳開（6.9.2），或是 key 不存在、重建了三次還是不存在。`pause` 的 85～100 秒「等連線」是 0，所以至少那幾列不是連線池；**剩下的是 Redis 那一條，但我沒有證據說是哪一種**：那一次的日誌層級是 ERROR，`unavailable()` 不寫日誌。這就是第 2 次起加上 Redis 欄位的原因 —— 而後面三次一個熱點 503 都沒有，Redis 的失敗與跳開也全部是 0。

7.6.3 的 H8 看過同一個相關：503 多的那幾輪，Redis 的失敗與跳開也多（9／3、51／17、14／4）。**「這台機器很忙的時候，Redis 的 500 ms 逾時被觸發，`RedisGuard` 跳開，熱點下單照 0.6.3 回 503」是一個跟兩邊的數字都相符的推測，但第 1 次 H6 沒有那一欄，我沒辦法證實。** 第 1 次是四次裡唯一 load average 在 17 以上的一次；恢復的那幾秒又正是 relay 一口氣送一千多則、消費者一口氣落帳五百多筆的時候。

**所以 7.9 的結論是：** RabbitMQ 停 60 秒、凍結 60 秒，一般下單與商品詳情不受影響（四次、八種情境都是）；事件全部補送、每張訂單一封通知；新的實例在 7.9.4 之後起得來。熱點下單在一次很忙的演練裡出現了 63、141 個 503，原因沒有找到 —— 它是 0.6.3「Redis 掛了」那一欄的行為（503，不是錯的 201），不是錯帳；但它要在第 08 章獨立的環境裡重量。

---

## 7.10 對帳：INV-2、INV-3

0.4.6 的 INV-2、INV-3 是 CHECK 寫不出來的不變量，第 02 章寫了對帳 SQL（2.5.5），`InvariantReconciliationTest` 一直在用它，0.12.2 說「對帳排程在 07」。這一章把它放進排程（`InventoryReconciliation`，每小時，0.4.6），差異寫 ERROR 日誌與指標 `shop.reconciliation.diff{check=INV-2|INV-3}`：

```java
CHECKS.put("INV-2", """
        SELECT COUNT(*) FROM inventory i
          LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_reservations
                      WHERE status IN ('HELD', 'CONFIRMED') AND counted GROUP BY product_id) r ON r.product_id = i.product_id
         WHERE i.reserved <> COALESCE(r.q, 0)""");
```

`AND counted` 是這一章加的（7.6.2）。`InventoryReconciliation` 的完整內容（含 INV-3 與下面那個「未計入」的指標）、排它的 `InventoryJobs`，在 7.13.1。它在 10 萬張訂單、30 萬筆預留、60 萬筆庫存帳上要多久，`InvariantReconciliationTest` 印了出來：

```
═══ 對帳（目前 100,005 張訂單）═══
  INV-2 reserved = Σ 有效且已計入的預留           差異 0 筆      294 ms
  INV-3 on_hand = Σ ledger.delta_on_hand 差異 0 筆    1,418 ms
  INV-3' reserved = Σ ledger.delta_reserved 差異 0 筆      799 ms
  訂單金額 = Σ 明細金額                          差異 0 筆    1,169 ms
  每張訂單至少一個明細                             差異 0 筆      128 ms
```

一秒多的全表掃描，每小時一次可以接受；它**不在啟動的那一刻跑**（`FixedDelayTask` 的第一次在一個間隔之後）—— 測試會啟動幾十次應用程式，每次都掃一遍 60 萬列，整個 `mvn clean test` 會慢上不少。3 年 5,000 萬筆庫存帳時，這句要改成增量的（只看上一次對帳之後的 ledger），那是第 09 章的事。

另一個指標是這一章才有的：**還沒計入的熱點預留放了多久**（`shop.inventory.uncounted_oldest_age_seconds`，每 30 秒）。它不是錯（落帳本來就在 commit 之後），但 0.6.4 說「庫存帳落帳：最終一致，60 秒」—— 超過 60 秒，代表 relay 或 `inventory.hot-settlement` 卡住了。

這一句每 30 秒跑一次。它的成本：

```
EXPLAIN: -> Aggregate: min(inventory_reservations.created_at), count(0)  (cost=30157 rows=1) (actual time=141..141 rows=1 loops=1)
    -> Filter: ((inventory_reservations.counted = false) and (inventory_reservations.`status` in ('HELD','CONFIRMED')))  (cost=29573 rows=5842) (actual time=141..141 rows=0 loops=1)
        -> Table scan on inventory_reservations  (cost=29573 rows=292123) (actual time=1.16..129 rows=300833 loops=1)
```

**整張表掃一遍：30 萬列、141 ms，找到 0 列。** 每 30 秒一次、每一台機器一次，現在可以接受；0.6.1 估 3 年 1,600 多萬筆明細（預留差不多同樣多），照比例是每 30 秒好幾秒的全表掃描。這一章沒有改它：要嘛加一個以 `counted` 開頭的索引（「未計入」的永遠只有幾百列，索引只會掃那幾百列；代價是每一次寫預留列多維護一個索引，2.7 量過那個代價），要嘛把它拉長到幾分鐘一次、改看 `shop.events.lag{consumer=inventory.hot-settlement}` 與 outbox 的 `oldest_age_seconds`（它們已經涵蓋了「落帳卡住」的大部分情況）—— 練習八。第 06 章 6.8.1 的 V12 是同一種決定：**先量，再決定要不要那個索引。**

---

## 7.11 驗收 Q9、Q10、Q11

### 7.11.1 Q9：commit 之後、送出之前 `kill -9`

0.12.2 的追溯表寫的是「commit 後 `kill -9`（Testcontainers + 子行程）」。Testcontainers 是第 08 章的事；子行程這一章就做得到：測試用**同一份程式、同一個 classpath** 啟動另一個 JVM，讓它的 relay「每 1 小時才跑一輪」—— 訂單 commit 了，outbox 那一列還沒輪到。

```java
// ① 另一個 JVM：同一份程式，relay 每 1 小時才跑一輪 —— 訂單 commit 了，outbox 那一列還沒輪到
Process child = new ProcessBuilder(ProcessHandle.current().info().command().orElse("java"), "-cp", System.getProperty("java.class.path"),
        ShopApplication.class.getName(), "--server.port=" + port, …,
        "--shop.messaging.relay-enabled=true", "--shop.messaging.relay-interval=1h", "--shop.messaging.consumers-enabled=false", …)
        .redirectErrorStream(true).redirectOutput(log.toFile()).start();
// ……等它的 /api/ping 回 200，打一次真的 POST /api/orders（熱點商品）……

// ② kill -9：不給它任何收尾的機會（沒有 shutdown hook、沒有 SmartLifecycle.stop）
new ProcessBuilder("kill", "-9", String.valueOf(child.pid())).start().waitFor();
int exit = child.waitFor();

// ③ 重啟：一般的設定（relay 每 100 ms、消費者打開），等落帳完成
try (var restarted = startAppWithEvents()) {
    await().atMost(Duration.ofSeconds(30)).until(() -> ((Number) settlement(jdbc, orderId, hot).get("counted")).intValue() == 1);
    // ……
}
```

```
Q9：子行程（pid 1024，relay 每 1 小時一輪）下單 → HTTP 201 20261002-311166；{unpublished=1, counted=0, reserved=0, reserve_ledger=0}
Q9：kill -9 → exit 137；{unpublished=1, counted=0, reserved=0, reserve_ledger=0}
Q9：重啟（含啟動）1046 ms 後 → {unpublished=0, counted=1, reserved=1, reserve_ledger=1}；買家的「訂單成立」通知已寄出
```

三行對應題目的三個時刻：

- **commit 之後、送出之前**：HTTP 201，`outbox_events` 裡 1 列未送出，預留列 `counted = 0`，`reserved = 0`。
- **`kill -9`**：exit 137（128 + SIGKILL 的 9）。**那一列還在**。
- **重啟**：relay 送出、`inventory.hot-settlement` 落帳 —— `reserved = 1`、`RESERVE` 帳 1 筆；買家的「訂單成立」也寄出了。**「庫存最終被扣」**。

（上面是節錄；Q9、Q10、Q11 的完整內容，與它們用到的 `startAppWithEvents()`、`settlement()`、`hotProduct()`，在 7.13.1。）

「relay 每 1 小時一輪」是一個人為的設定，它把「commit 與送出之間」那個在正式設定下 p50 只有七、八十毫秒的窗（7.4.3）撐開到測試做得到的程度。7.2.2 的 H2 是不撐開的版本：正式的設定、隨機的時刻、五輪共五十次 `kill -9`。

### 7.11.2 Q10：同一則 `order.placed` 投遞 10 次

測試關掉 relay（它不能先把這一則送掉），自己用 `RabbitTemplate` 把**同一則**訊息（同一個 eventId、跟 relay 送的一模一樣的信封）用 10 條執行緒**同時**送 10 次：

```java
var go = new CountDownLatch(1);
for (int i = 0; i < 10; i++) pool.submit(() -> { go.await(); rabbit.send("shop.events", "order.placed", message); return null; });
go.countDown();
```

```
Q10：同一則 order.placed（eventId 056ed769…）同時送 10 次 → 落帳的消費者處理 1 次、擋下重複 9 次；{reserved=1, reserve_ledger=1, processed=1, notifications=1, notification_attempts=1}
```

- **落帳**：處理 1 次、擋下 9 次（`shop.events.duplicates{consumer=inventory.hot-settlement} = 9`）；`reserved = 1`、`RESERVE` 1 筆、`processed_messages` 1 列。這是 7.5.2 的 `processed_messages`。
- **通知**：`notifications` 1 列、`attempts = 1` —— 9 份重複在「已經 `SENT`」或「認領失敗」那一步停下（7.7.2）。

### 7.11.3 Q11：broker 只在 adapter 裡 —— 而且這條規則終於不是空的

第 01 章就寫了這條 ArchUnit 規則（`ModuleBoundaryTest.broker_is_isolated`），它從第 01 章到第 06 章一直是綠的 —— 7.2.0 數過：用到 AMQP 的類別是 **0 個**。**一條沒有任何東西可以違反的規則，綠燈不代表任何事。**

所以 Q11 除了跑那條規則，還要證明它不是空的，並回答 README 的原題「換成另一個要改哪些地方」：

```java
// ① 第 01 章就寫好的規則
noClasses().that().resideOutsideOfPackage("com.example.shop.shared.messaging..")
        .should().dependOnClassesThat().resideInAnyPackage("org.springframework.amqp..", "com.rabbitmq..").check(classes);
// ② 而且它不是「因為沒有人用 broker」才通過的：列出真的用到 broker 的類別
// ③ 模組也不直接依賴 adapter：它們只認得 shared.events —— 換 broker，模組一行都不用改
assertThat(brokerUsers).isNotEmpty().allMatch(n -> n.startsWith("com.example.shop.shared.messaging."));
assertThat(adapterUsers).isEmpty();
```

```
Q11：用到 broker 的類別 5 個 [com.example.shop.shared.messaging.internal.DeadLetterController, com.example.shop.shared.messaging.internal.RabbitClientTimeouts, com.example.shop.shared.messaging.internal.RabbitConsumers, com.example.shop.shared.messaging.internal.RabbitOutboxRelay, com.example.shop.shared.messaging.internal.RabbitTopology]；shared.messaging 以外依賴 adapter 的類別 0 個；實作 EventHandler 的類別 5 個
```

換成 Kafka，要改的就是列出來的那幾個類別；`EventHandler` 的實作、所有 `outbox.add(...)` 的地方、`shared.events.internal` 的 SQL，一行都不用動。README 的延伸挑戰（「用另一個 broker 再做一次」）就從這份清單開始。

`CapstoneAcceptanceTest` 的 `Skipped` 從 4 變成 1：只剩 Q7（第 09 章）。

---

## 7.12 流程測試與追溯表

### 7.12.1 測試環境：預設不送、不收

這一章最花時間的不是消費者，是**讓測試不互相干擾**。三件事：

**① 測試環境預設關掉 relay 與消費者**（`src/test/resources/config/application.yml`）：

```yaml
shop:
  messaging:
    relay-enabled: false
    consumers-enabled: false
    retry-delays: 100ms, 200ms, 400ms, 800ms, 1600ms   # 一樣是 5 級、指數退避，只是縮短（NTF-1 AC-4 的測試不用等 31 秒）
```

所有測試共用同一台 RabbitMQ，而 Spring 會把測試的 context 留著重用：A 類別的 context 還活著，它的消費者就會去吃 B 類別的訊息 —— 例如 `HotStockFlowTest` 取消一張訂單之後的 `inventory.stock-returned`，可能晚到、加在下一個測試同一個商品 id 的 Redis key 上。**這是寫測試之前就做的決定，靠的是推理，我沒有把它們全部打開跑一次來證明它**；我看到過的是它在同一個類別裡的樣子：7.5.3 那場風暴的第一版，`cancelPaidRefunds` 收到了上一個測試留下的「訂單成立」與「訂單已取消」。要事件流的測試自己打開，有兩種做法：`EventFlowTest`、`DeadLetterReplayTest`、H1 在 `@SpringBootTest(properties = …)` 裡打開，並用 `@DirtiesContext(AFTER_CLASS)` 在結束時關掉 context；驗收 Q9、Q10、`E7FlashSaleLoadTest` 與其他要事件流的實驗，用 `SpringApplicationBuilder`（或子行程）自己啟動一個應用程式，用完就關。

**② 不需要 broker 時間差的測試，用 `InlineEvents`**：直接把 outbox 裡的事件交給對應的 `EventHandler`（同一個 `EventDispatcher`、同一個 `processed_messages`），然後標成已送出。結果是確定的，而且交付的**順序由測試決定** —— `HotSettlementTest` 的「先取消、後落帳」「落帳失敗、取消還沒到」都靠它。它不經過 broker，所以它測不到 7.5.3 那種拓撲的錯；那是 `EventFlowTest` 的工作。

**③ 用真的 broker 的測試，開始之前把佇列清空**（`TestQueues.purgeConsumerQueues`）。H2 的子行程只開 relay、不開消費者，在佇列裡留下了一千多則 `order.placed`；下一次跑 `EventFlowTest`，消費者先花十幾秒處理它們，自己的那幾則排在後面 —— 3 個測試逾時、紅了。佇列清空之後重跑，5 個全綠。outbox 裡別的測試留下、資料早就被刪掉的事件也一樣（`InlineEvents.skipBacklog`）。`InlineEvents` 與 `TestQueues` 的完整內容在 7.13.1。

> 📌 **有了 broker，「測試之間互相隔離」就不再是 Spring 幫你做好的事。** 資料庫有交易、有 `@Transactional` 的 rollback；佇列裡的訊息沒有 —— 它會活得比產生它的測試久，然後在另一個測試裡被消費。第 08 章用 Testcontainers 讓每一次建置有自己的 broker，是同一個問題的另一個答案。

### 7.12.2 這一章新增的測試

| 測試 | 幾個 | 守什麼 |
|---|---|---|
| `EventFlowTest` | 5 | 真的 relay + RabbitMQ：NTF-1 AC-1、AC-4；熱點落帳；0.5.4 的退款與通知；落帳失敗 → E10 |
| `HotSettlementTest` | 5 | 先取消後落帳；重複交付只計入一次；出貨要等落帳；對帳扣掉未計入；落帳失敗擋出貨、取消、退款 |
| `DeadLetterReplayTest` | 2 | 死信的查看、重放、稽核、權限；不存在的消費者 404 |
| `OrderStateMachineTest` | ＋6 | E10 那一欄（54 + 5 → 60 + 5 格） |
| 驗收 **Q9、Q10、Q11** | 3 | 從 `@Disabled` 變成綠燈 |

改了的既有測試：`HotStockFlowTest`（落帳與加回是事件，用 `InlineEvents` 交付，7.6.5）、`InvariantReconciliationTest`（INV-2 只算已計入的，7.6.2）、`IdorMatrixTest`（`EXEMPT` 加上重放的 API）、`OpenApiContractTest` 的快照（兩支新的 operation，以及 `GET /api/admin/audit-logs` 的 `action` 參數多了一個列舉值 `DEAD_LETTERS_REPLAYED` —— 這一個是快照比對抓到、我原本沒想到的）、`E7FlashSaleLoadTest`（打開 relay 與消費者、等落帳完成、記落帳花了多久）。新增的測試支援是 `InlineEvents` 與 `TestQueues`（開始之前清空消費者的佇列；要數死信的測試先等死信落定，7.13）。三個新的測試類別、`HotStockFlowTest` 的 `deliverEvents()`、`E7FlashSaleLoadTest` 的完整內容在 7.13.1。

`OpenApiContractTest` 的快照要自己更新一次 —— 這次的 API 變更是刻意的：

```bash
mvn test -Dtest=OpenApiContractTest -Dopenapi.update=true
git diff src/test/resources/openapi/shop-api.json
```

diff 裡應該只有這幾樣：

- `components.schemas` 多了 `DeadLetters`（`consumer`、`queue`、`messages`）與 `Replayed`（`consumer`、`replayed`、`remaining`）。
- `paths` 多了 `/api/admin/dead-letters`（`get`，operationId `list`）與 `/api/admin/dead-letters/{consumer}/replay`（`post`，operationId `replay`，path 參數 `consumer`、query 參數 `max` 預設 100）。
- `GET /api/admin/audit-logs` 的 `action` 參數，`enum` 在 `REFRESH_TOKEN_REUSED` 之後多了 `DEAD_LETTERS_REPLAYED`。

多了別的東西，代表改到了不該改的 API。

**實驗**（`-Pexperiments`，不在 `mvn clean test` 裡）：H1～H9，見 7.2.0 的表。

### 7.12.3 追溯表更新

| 需求 | 驗證方式 | 狀態 |
|---|---|---|
| NTF-1 AC-1 | `EventFlowTest.placedNotifies`、`cancelPaidRefunds` | ✅ 07 |
| NTF-1 AC-2（p99 60 秒） | H7：0.17～4.0 秒；H6：RabbitMQ 停 60 秒時，停機期間下的單 p99 59.7～77.9 秒 | ✅ 07（平常）；停機時是停機的長度加補送（7.9.3） |
| NTF-1 AC-3（只收到一次） | 驗收 Q10（通知那一半）；`dedup_key` ＋ 認領 | ✅ 07（寄出與標記之間死掉的那一次除外，7.7.2） |
| NTF-1 AC-4（5 次 → 死信、下單不受影響） | `EventFlowTest.mailerDownDeadLetters`；`DeadLetterReplayTest` | ✅ 07 |
| NTF-1 AC-5（commit 之後 `kill -9`） | 驗收 **Q9** | ✅ 07 |
| ORD-2 AC-6、ORD-4 AC-2（自動全額退款） | `EventFlowTest.cancelPaidRefunds`；H3 | ✅ 04（建單）、07（執行） |
| 0.5.4 右欄（提交後） | 十個事件、五個消費者（7.3） | ✅ 07 |
| 0.5.3 轉移表 | `OrderStateMachineTest` 60 + 5 格（E10） | ✅ 04、07 |
| 0.6.3「RabbitMQ」那一欄 | H6 演練四次、H6c（7.9）：最後兩次每一格都對上；第 1 次的熱點 503 沒找到原因（7.9.5） | ✅ 07（熱點 503 → 08 重量） |
| 0.6.4 退款 5 分鐘內發起 | commit 之後由消費者立刻呼叫；失敗重試 31 秒後進死信 + `FAILED` | ✅ 07 |
| 0.6.4 庫存帳落帳 60 秒 | H5：最後一個回應之後 2 ms～1.7 秒；H6 最後一次演練：RabbitMQ 恢復後 15 秒內（7.9.3 逐 5 秒的「未落帳的熱點預留」欄；摘要行的「第 100 秒」是下界）；`shop.inventory.uncounted_oldest_age_seconds` | ✅ 07 |
| 0.6.6 outbox 指標 | `shop.outbox.pending`、`shop.outbox.oldest_age_seconds`；告警在 09 | 部分 → 09 |
| 0.6.7 保留期限（outbox 3 天、processed 7 天） | `OutboxMaintenance`（沒有專門的測試） | ✅ 07 |
| INV-2、INV-3 | `InvariantReconciliationTest`；對帳排程 `InventoryReconciliation`（7.10） | ✅ 02、07 |
| ORD-1b AC-2（熱點 p99 < 500 ms） | H5：六輪沒有超賣（五輪賣出 500 件、一輪 498 件）；**p99 < 500 ms 部分達成**：load 5～9 時 6 輪裡 5 輪（150～187 ms；第 06 章 6 輪裡 2 輪），load 10～27 時 2.4～4.3 秒 | 部分 → 08 重量 |
| 0.6.2 熱點下單 p99 500 ms | 同 ORD-1b AC-2 | 部分 → 08 重量 |
| Q9、Q10、Q11 | 驗收 | ✅ 07 |

---

## 7.13 本章完成後的專案

```
shop/
└── src/
    ├── main/
    │   ├── java/com/example/shop/
    │   │   ├── shared/
    │   │   │   ├── events/                                    ← 新增：模組看得到的事件 API（沒有任何 broker 的東西）
    │   │   │   │   ├── Outbox.java、Event.java、EventHandler.java、EventTypes.java
    │   │   │   │   └── internal/{JdbcOutbox,OutboxStore,EventDispatcher,OutboxMaintenance}.java   ← 只有 SQL（7.4、7.5.2）
    │   │   │   ├── messaging/internal/                        ← 新增：唯一碰 RabbitMQ 的地方（驗收 Q11）
    │   │   │   │   ├── RabbitTopology.java                    ← exchange、佇列、重試階梯、死信（7.5.3）
    │   │   │   │   ├── RabbitOutboxRelay.java                 ← 認領 → 送出 → 標記（7.4.2、7.9.2）
    │   │   │   │   ├── RabbitConsumers.java                   ← broker → EventHandler；重試、死信、EVENT_MISROUTED（7.5）；在自己的執行緒上啟動（7.9.4）
    │   │   │   │   ├── RabbitClientTimeouts.java              ← 通道 RPC 逾時 5 秒（7.9.2）
    │   │   │   │   └── DeadLetterController.java              ← GET/POST /api/admin/dead-letters（7.5.5）
    │   │   │   ├── audit/AuditAction.java                     ← + DEAD_LETTERS_REPLAYED
    │   │   │   └── config/ShopProperties.java                 ← + Messaging；Inventory + invariantCheckInterval
    │   │   ├── ordering/
    │   │   │   └── internal/
    │   │   │       ├── PlaceOrderService.java                 ← 熱點品項 holdHot；order.placed（7.4.1、7.6.2）
    │   │   │       ├── OrderTransitionService.java            ← 0.5.4 右欄的事件；退款帶 buyerId
    │   │   │       ├── OrderEvent.java、OrderStateMachine.java ← + E10 STOCK_SHORTAGE（7.6.3）
    │   │   │       └── StockShortageHandler.java              ← 新增：ordering.stock-shortage
    │   │   ├── inventory/
    │   │   │   ├── InventoryApi.java                          ← + holdHot；consume 的兩個新條件
    │   │   │   └── internal/
    │   │   │       ├── JdbcInventoryService.java              ← holdHot、settleHot、release 分 counted、加回走事件（7.6）
    │   │   │       ├── HotStock.java                          ← GATE_BASE_SQL 扣掉未計入；giveBackOrFail
    │   │   │       ├── InventoryEventHandlers.java            ← 新增：inventory.hot-settlement、inventory.hot-stock-return
    │   │   │       ├── InventoryReconciliation.java           ← 新增：INV-2、INV-3、未計入的熱點預留（7.10）
    │   │   │       └── InventoryJobs.java                     ← + 對帳排程
    │   │   ├── payment/
    │   │   │   ├── PaymentApi.java                            ← requestRefund 多一個 buyerId
    │   │   │   └── internal/
    │   │   │       ├── JdbcPaymentService.java                ← requestRefund：撞鍵接住、新建才發事件（7.8.2）
    │   │   │       ├── RefundExecutor.java                    ← 新增：payment.refunds（7.8.1）
    │   │   │       └── SimulatedRefundGateway.java            ← 新增：收冪等鍵、可注入「回應丟了」
    │   │   └── notification/internal/                         ← 第一次有程式碼
    │   │       ├── NotificationHandler.java                   ← 新增：notification.order-events（7.7）
    │   │       └── SimulatedMailer.java                       ← 新增
    │   └── resources/
    │       ├── application.yml                                ← + spring.rabbitmq（confirm、return、mandatory、逾時）
    │       └── db/migration/
    │           ├── V13__inventory_reservation_counted.sql     ← 新增（7.6.1）
    │           └── V14__shared_outbox_claim_lease.sql         ← 新增（7.9.2）
    └── test/
        ├── java/com/example/shop/
        │   ├── support/{InlineEvents,TestQueues}.java          ← 新增（7.12.1）
        │   ├── acceptance/CapstoneAcceptanceTest              ← Q9、Q10、Q11 變綠
        │   ├── api/DeadLetterReplayTest.java                  ← 新增
        │   ├── api/IdorMatrixTest.java                        ← EXEMPT + 重放
        │   ├── ordering/internal/{EventFlow,HotSettlement}Test.java   ← 新增
        │   ├── ordering/internal/{OrderStateMachine,HotStockFlow}Test.java   ← E10；落帳是事件
        │   ├── schema/InvariantReconciliationTest.java        ← INV-2 只算已計入的
        │   ├── inventory/internal/H1LostSettlementTest.java
        │   ├── payment/internal/{H3RefundResponseLost,H9AffectedRows}Test.java
        │   ├── ch04/E7FlashSaleLoadTest.java                  ← 打開 relay 與消費者、記落帳時間
        │   └── ch07/{H2RelayKill,H4HeadersMatch,H5HotFlashSale,H5bDiagnose,H6RabbitOutageDrill,H6bPauseDiagnose,H6cStartupUnderPause,H7RelayInterval,H7bIdlePoll,H8FlushDuringSale}Test.java
        └── resources/
            ├── config/application.yml                         ← relay、消費者預設關掉；重試階梯縮短
            └── openapi/shop-api.json                          ← + 2 個 operation、AuditAction 多一個值
```

**兩個 migration（V13、V14），都是 `ALGORITHM=INSTANT` 的加欄位；沒有新的模組依賴。** `notification` 模組從第 01 章就存在（`package-info.java`、`ModuleBoundaryTest` 裡有它的一列），這一章第一次有程式碼。

```bash
mvn clean test
```

```
[INFO] Results:
[INFO] 
[WARNING] Tests run: 178, Failures: 0, Errors: 0, Skipped: 1
[INFO] 
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
[INFO] Total time:  04:22 min
```

> 📌 **專題寫完之後重跑：`mvn clean verify`。** 上面是寫這一章時跑的 `mvn clean test`。專題寫完之後（2026-10-12），在本章結束時的程式碼上、用一套全新的 compose（空的資料庫，Flyway 從第一個 migration 開始）重跑 `mvn clean verify`。第一次在空的資料庫上跑，驗收 Q8 紅了（「登入」那一格 401：Q8 用 2.8.3 種子資料的帳號 `buyer00001@example.com` 登入 —— 第 08 章 8.2.1 的事故一）；先跑 `mvn test -Pseed -Dtest=SeedData`（2.8.3）再跑，全綠。下面是第二次（load average 6.66 → 3.24）：

```bash
mvn clean verify
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.910 s -- in com.example.shop.reporting.internal.TrendingTest
[INFO] Tests run: 7, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.654 s -- in com.example.shop.catalog.internal.ProductCacheTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.002 s -- in com.example.shop.shared.redis.RedisGuardTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.001 s -- in com.example.shop.shared.audit.internal.JdbcAuditLogTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.014 s -- in com.example.shop.shared.error.ShopExceptionTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.805 s -- in com.example.shop.schema.SchemaConstraintTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.012 s -- in com.example.shop.schema.EntitySchemaDriftTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 4.211 s -- in com.example.shop.schema.InvariantReconciliationTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.103 s -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.008 s -- in com.example.shop.architecture.MigrationOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.002 s -- in com.example.shop.architecture.MapperXmlSafetyTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.029 s -- in com.example.shop.architecture.ConfigKeyGuardTest
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 1, Time elapsed: 201.8 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.779 s -- in com.example.shop.ordering.internal.HotSettlementTest
[INFO] Tests run: 67, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.019 s -- in com.example.shop.ordering.internal.OrderStateMachineTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.954 s -- in com.example.shop.ordering.internal.AuditPlacementTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 9.741 s -- in com.example.shop.ordering.internal.EventFlowTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.341 s -- in com.example.shop.ordering.internal.OrderRaceRegressionTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.244 s -- in com.example.shop.ordering.internal.HotStockFlowTest
[INFO] Tests run: 14, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 10.11 s -- in com.example.shop.ordering.internal.OrderFlowTest
[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.903 s -- in com.example.shop.api.OrderApiTest
[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.180 s -- in com.example.shop.api.RateLimitTest
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.565 s -- in com.example.shop.api.CatalogCartApiTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.576 s -- in com.example.shop.api.IdorMatrixTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.040 s -- in com.example.shop.api.JwtGuardTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.174 s -- in com.example.shop.api.SecurityRouteCoverageTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.329 s -- in com.example.shop.api.OpenApiContractTest
[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 6.379 s -- in com.example.shop.api.AuthApiTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 11.95 s -- in com.example.shop.api.DeadLetterReplayTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.782 s -- in com.example.shop.architecture.EntityTableOwnershipTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.132 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 178, Failures: 0, Errors: 0, Skipped: 1
[INFO] ...
[INFO] Building jar: …/target/shop-0.0.1-SNAPSHOT.jar
[INFO] ...
[INFO] BUILD SUCCESS
[INFO] ...
[INFO] Total time:  04:30 min
```

178 個測試、跳過 1 個 —— 跟上面一樣。`verify` 比 `test` 多做的是打包 jar（`spring-boot:repackage`）；覆蓋率門檻要到第 08 章才有。

**178 個測試、0 個失敗、1 個跳過**（第 06 章是 160 個、跳過 4 個）。多出來的 18 個：`EventFlowTest` 5 個、`HotSettlementTest` 5 個、`DeadLetterReplayTest` 2 個、`OrderStateMachineTest` 6 個（E10 那一欄的 6 格，61 → 67）。驗收 Q9、Q10、Q11 本來就算在 160 個裡，只是從「跳過」變成「通過」—— 剩下的那一個跳過是 Q7（第 09 章）。

**這不是第一次跑就綠的。** 這一章最後一次全套測試之前的那一次，是 178 個、**2 個失敗**：

- `InvariantReconciliationTest`：INV-2 差異 1 筆 —— 一個商品的 `reserved` 是 151，有效且已計入的預留是 260。那個商品叫 `H6b`：7.9 的診斷實驗每次開始時用 `ON DUPLICATE KEY UPDATE reserved = 0` 把庫存歸零，卻沒有刪掉上一次留下的訂單與預留，結束時也不清。跑過幾次之後，對帳就抓到了它。**對帳排程抓到的第一個差異，來自我自己的實驗。**
- `DeadLetterReplayTest.replayAfterFix`：預期死信 1 則，實際 47 則。context 一啟動，relay 就把 outbox 裡別的測試留下的事件送出去了（`skipBacklog` 在那之後才跑）；它們的資料早已被清掉，處理失敗、走完 3.1 秒的重試階梯才進死信 —— 在測試清空死信佇列**之後**。7.9.4 把消費者改到背景啟動之後，這個時間差才落到測試裡面；而原本的斷言 `contains("\"messages\":1")` 寫得太鬆，`"messages":12` 也會通過，我沒辦法確定它以前是真的綠、還是碰巧綠。

修法都在測試這一側：H6b 開始與結束時清掉自己的資料；`DeadLetterReplayTest` 先等死信的數量在一個重試階梯的時間裡不再變，再清空（`TestQueues.purgeDeadLettersWhenQuiet`），斷言改成比對完整的那一筆。修好之後連跑兩次，178 個全綠。

`mvn clean test` 從第 06 章的 3 分 07 秒變成 4 分 22 秒、4 分 24 秒（同一台機器、交錯跑：第 07 章、第 06 章、第 07 章。3 分 07 秒是第 06 章的程式碼在這一章當天重跑的數字；6.11 的輸出是另一天量的 2 分 51 秒）。多出來的一分多鐘，依 surefire 記的每個類別的時間：`CapstoneAcceptanceTest` 多了 53 秒（Q9 要啟動、殺掉、再啟動一個子行程；Q10、Q11 從跳過變成真的跑），`DeadLetterReplayTest` 12 秒（其中至少 4.1 秒是等死信落定），`EventFlowTest` 9 秒。

### 7.13.1 本章其餘檔案的完整內容

正文只節錄了重點；下面是這一章新增或改動、正文沒有完整列出的檔案，都是這一章結束時的版本。標「節錄」的只列出這一章新增或改動的部分，其餘照第 06 章。正文已經完整列出的（`EventHandler`、`EventDispatcher`、`JdbcOutbox`、V13、`src/test/resources/config/application.yml`、`application.yml` 的 `spring.rabbitmq`）不再重複。

程式碼裡的註解是寫程式當時留下的，有十幾處節號跟定稿的課文不一樣；這一節貼出的版本**已依課文更正**（`7.10.1` → 7.12.1、`7.10` → 7.12、`7.9` → 7.10、`7.9.3` → 7.9.4、`EventTypes` 的 7.3.2 → 7.3.1、`RabbitTopology` 的 7.5.1 → 7.3.2），參考實作的 `ch07` 分支裡仍是舊的節號。`H6cStartupUnderPauseTest` 印出的標題也一樣：7.9.4 正文那段輸出的第一行，當時印的是「7.9.3」，課文顯示的是更正後的節號。「H9 實測」（`RabbitTopology`）是現在的 H4，這一行沒有改。

#### 事件：`shared.events`

**`src/main/java/com/example/shop/shared/events/Outbox.java`**

```java
package com.example.shop.shared.events;

import java.util.Map;

/**
 * 7.4 「這件事發生了」—— 跟發生它的那個交易一起 commit（0.5.4 表格的右欄）。
 *
 * 呼叫端只寫一列資料；送到 broker 是另一個程式（relay）在 commit 之後的事：
 *  - 交易 rollback → 這一列也不存在 → 不會有人收到一件沒有發生的事
 *  - commit 之後行程被 kill -9 → 這一列還在 → 重啟之後照樣送出（驗收 Q9）
 *
 * 這個介面裡沒有任何 broker 的東西（驗收 Q11）：模組只知道「記下一個事件」。
 */
public interface Outbox {

    /**
     * 必須在呼叫端既有的交易內呼叫（Propagation.MANDATORY）：沒有交易，就沒有「跟它一起 commit」這件事。
     * @param aggregateType 例如 ORDER、REFUND —— 給人看、給清理與查詢用
     * @param eventType     EventTypes 裡的其中一個；它就是 routing key
     * @param payload       會被轉成 JSON。消費端在別的模組，只能讀到這裡面的東西（它們不能查你的表）
     * @return 這個事件的 eventId（UUID）：消費端的冪等鍵
     */
    String add(String aggregateType, long aggregateId, String eventType, Map<String, ?> payload);
}
```

**`src/main/java/com/example/shop/shared/events/Event.java`**（7.5.1：消費者收到的事件）

```java
package com.example.shop.shared.events;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * 消費端收到的一個事件。eventId 是 outbox_events.event_id —— 同一個事件不管被送幾次，eventId 都一樣（冪等鍵）。
 * attempt：這是第幾次處理它（1 = 第一次；重試階梯每走一級加 1，7.5.3）。
 */
public record Event(String eventId, String type, String aggregateType, long aggregateId, Instant occurredAt,
                    JsonNode payload, int attempt) {

    public long getLong(String field) {
        JsonNode n = payload.get(field);
        if (n == null || n.isNull()) throw new IllegalArgumentException("事件 " + type + " 沒有欄位 " + field);
        return n.asLong();
    }

    public String getText(String field) {
        JsonNode n = payload.get(field);
        return n == null || n.isNull() ? null : n.asText();
    }

    public boolean getBoolean(String field) {
        JsonNode n = payload.get(field);
        return n != null && n.asBoolean();
    }

    public List<Long> getLongs(String field) {
        List<Long> out = new ArrayList<>();
        JsonNode n = payload.get(field);
        if (n != null && n.isArray()) n.forEach(x -> out.add(x.asLong()));
        return out;
    }
}
```

**`src/main/java/com/example/shop/shared/events/EventTypes.java`**（7.3.1）

```java
package com.example.shop.shared.events;

/**
 * 7.3.1 全專題的事件，也就是 routing key。事件是模組之間的「契約」：消費端在別的模組，
 * 不能查發送端的表、也不能用發送端的類別（ModuleBoundaryTest），所以 payload 要自己帶齊需要的欄位。
 *
 * 加欄位可以；改欄位的名字或意思 = 破壞契約（跟 API 一樣，3.8 的 OpenApiContractTest 是同一件事）。
 */
public final class EventTypes {
    private EventTypes() {}

    // ── ordering：0.5.4 表格右欄 ──
    /** orderId, orderNo, buyerId, sellerId, totalAmount, hotProductIds */
    public static final String ORDER_PLACED = "order.placed";
    /** orderId, orderNo, buyerId, sellerId, totalAmount */
    public static final String ORDER_PAID = "order.paid";
    /** orderId, orderNo, buyerId, sellerId, totalAmount, cancelReason, event, refund */
    public static final String ORDER_CANCELLED = "order.cancelled";
    /** orderId, orderNo, buyerId, sellerId, carrier, trackingNo */
    public static final String ORDER_SHIPPED = "order.shipped";
    /** orderId, orderNo, buyerId, sellerId */
    public static final String ORDER_COMPLETED = "order.completed";

    // ── payment：退款（0.5.4「呼叫金流退款 API：可重試，失敗進死信 + 告警」）──
    /** refundId, orderId, paymentId, amount, reason, buyerId */
    public static final String REFUND_REQUESTED = "refund.requested";
    /** refundId, orderId, amount, buyerId */
    public static final String REFUND_SUCCEEDED = "refund.succeeded";
    /** refundId, orderId, amount, buyerId, error */
    public static final String REFUND_FAILED = "refund.failed";

    // ── inventory：熱點商品的落帳（7.6）──
    /** orderId, productId, requested, available */
    public static final String HOT_SETTLEMENT_FAILED = "inventory.hot-settlement-failed";
    /** lines: [{productId, quantity}] —— 取消、補貨之後，熱點商品的 Redis 閘門要加回去（6.5.3） */
    public static final String STOCK_RETURNED = "inventory.stock-returned";
}
```

**`src/main/java/com/example/shop/shared/events/internal/OutboxStore.java`**（7.4.2、7.4.4）

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

**`src/main/java/com/example/shop/shared/events/internal/OutboxMaintenance.java`**（7.4.4）

```java
package com.example.shop.shared.events.internal;

import com.example.shop.shared.config.ShopProperties;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

import java.time.Clock;
import java.time.Duration;

/**
 * 7.4.4 outbox 的兩件雜事：
 *  ① 指標（0.6.6）：shop.outbox.pending、shop.outbox.oldest_age_seconds。每 5 秒查一次存起來 —— 不要每次被抓指標就打一次 MySQL
 *  ② 清理（0.6.7）：已送出 3 天、processed_messages 7 天。每 10 分鐘一輪，一次 1,000 列
 */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
class OutboxMaintenance implements SchedulingConfigurer {

    private static final Logger log = LoggerFactory.getLogger(OutboxMaintenance.class);
    static final int DELETE_BATCH = 1_000;

    private final OutboxStore store;
    private final ShopProperties.Messaging props;
    private final Clock clock;
    private volatile OutboxStore.Backlog last = new OutboxStore.Backlog(0, 0);

    OutboxMaintenance(OutboxStore store, ShopProperties props, Clock clock, MeterRegistry meters) {
        this.store = store;
        this.props = props.messaging();
        this.clock = clock;
        Gauge.builder("shop.outbox.pending", () -> last.pending()).description("還沒送出的事件數").register(meters);
        Gauge.builder("shop.outbox.oldest_age_seconds", () -> last.oldestAgeSeconds())
                .description("最舊的未送出事件已經等了幾秒（0.6.4：> 60 告警）").register(meters);
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(() -> {
            try { last = store.backlog(); } catch (RuntimeException e) { log.debug("outbox backlog 查詢失敗：{}", e.getMessage()); }
        }, Duration.ofSeconds(5));
        registrar.addFixedDelayTask(this::cleanup, Duration.ofMinutes(10));
    }

    void cleanup() {
        int outbox = 0, processed = 0, n;
        do { n = store.deletePublishedBefore(clock.instant().minus(props.outboxRetention()), DELETE_BATCH); outbox += n; } while (n == DELETE_BATCH);
        do { n = store.deleteProcessedBefore(clock.instant().minus(props.processedRetention()), DELETE_BATCH); processed += n; } while (n == DELETE_BATCH);
        if (outbox + processed > 0) log.info("清理：outbox_events {} 列、processed_messages {} 列", outbox, processed);
    }
}
```

#### RabbitMQ adapter：`shared.messaging.internal`

**`src/main/java/com/example/shop/shared/messaging/internal/RabbitTopology.java`**（7.5.3）

```java
package com.example.shop.shared.messaging.internal;

import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.events.EventHandler;
import org.springframework.amqp.core.*;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 7.3.2 拓撲：照 11-messaging/06 的 6.9 定案（quorum、confirm + return、retry 佇列階梯、停放區），
 * 只改了一件事 —— 這個專題有好幾個消費者共用同一組重試佇列，所以「從重試佇列回到哪裡」用 headers 決定（7.5.3）。
 *
 *   shop.events (topic) ──order.placed──▶ shop.inventory.hot-settlement ┐
 *                       ──order.placed──▶ shop.notification.order-events │ 失敗 → shop.retry (direct) ─"1s"─▶ shop.retry.1s（TTL 1s）
 *                       ……                                               │                            ─"2s"─▶ shop.retry.2s ……
 *                                                                        │ TTL 到 → shop.retry.return (headers：shop-target = 原佇列) ─▶ 回到原佇列
 *                                                                        └ 用完 → shop.dead (direct) ──原佇列名──▶ shop.{consumer}.dlq
 */
@Configuration(proxyBeanMethods = false)
class RabbitTopology {

    static final String EVENTS = "shop.events";
    static final String RETRY = "shop.retry";
    static final String RETRY_RETURN = "shop.retry.return";
    static final String DEAD = "shop.dead";
    /**
     * ⚠️ 不能以 x- 開頭（7.5.3）：headers exchange 在 x-match=all / any 時「不看」x- 開頭的 header ——
     * 第一版叫 x-shop-target，綁定等於沒有條件，每一次重試都被送回「所有」消費者的佇列（H9 實測：B 佇列也收到了 A 的訊息）。
     */
    static final String TARGET_HEADER = "shop-target";
    static final String ATTEMPT_HEADER = "shop-attempt";
    static final String ERROR_HEADER = "shop-error";
    /** 11-messaging/05 的 5.2.3：佇列滿了要讓發送端知道（nack），而不是默默丟掉最舊的 */
    static final long MAX_LENGTH = 1_000_000L;

    static String queue(EventHandler h) { return "shop." + h.consumer(); }
    static String deadLetterQueue(EventHandler h) { return queue(h) + ".dlq"; }
    static String tier(Duration d) { return d.toMillis() % 1000 == 0 ? (d.toMillis() / 1000) + "s" : d.toMillis() + "ms"; }
    static String retryQueue(Duration d) { return RETRY + "." + tier(d); }

    @Bean
    Declarables shopTopology(List<EventHandler> handlers, ShopProperties props) {
        List<Declarable> d = new ArrayList<>();
        TopicExchange events = ExchangeBuilder.topicExchange(EVENTS).durable(true).build();
        DirectExchange retry = ExchangeBuilder.directExchange(RETRY).durable(true).build();
        HeadersExchange retryReturn = ExchangeBuilder.headersExchange(RETRY_RETURN).durable(true).build();
        DirectExchange dead = ExchangeBuilder.directExchange(DEAD).durable(true).build();
        d.addAll(List.of(events, retry, retryReturn, dead));

        for (Duration delay : props.messaging().retryDelays()) {             // 每一級一個佇列（11-messaging/06 的 6.4.2：不要用每則訊息自己的 TTL）
            Queue q = QueueBuilder.durable(retryQueue(delay)).quorum()
                    .ttl((int) delay.toMillis())
                    .deadLetterExchange(RETRY_RETURN)                       // 沒有 dead-letter routing key：靠 headers 回去
                    .build();
            d.add(q);
            d.add(BindingBuilder.bind(q).to(retry).with(tier(delay)));
        }
        for (EventHandler h : handlers) {
            Queue main = QueueBuilder.durable(queue(h)).quorum()
                    .maxLength(MAX_LENGTH).overflow(QueueBuilder.Overflow.rejectPublish)
                    .build();
            Queue dlq = QueueBuilder.durable(deadLetterQueue(h)).quorum()
                    .maxLength(MAX_LENGTH).overflow(QueueBuilder.Overflow.rejectPublish)   // ⚠️ 它沒有 DLX：滿了 = 發送端收到 nack
                    .build();
            d.add(main);
            d.add(dlq);
            for (String type : h.eventTypes()) d.add(BindingBuilder.bind(main).to(events).with(type));
            d.add(BindingBuilder.bind(main).to(retryReturn).whereAll(Map.of(TARGET_HEADER, queue(h))).match());
            d.add(BindingBuilder.bind(dlq).to(dead).with(queue(h)));
        }
        return new Declarables(d);
    }
}
```

**`src/main/java/com/example/shop/shared/messaging/internal/RabbitOutboxRelay.java`**（7.4.2、7.9.2）

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
    private ScheduledExecutorService exec;
    private volatile boolean failing;

    RabbitOutboxRelay(OutboxStore store, RabbitTemplate rabbit, PlatformTransactionManager tm, ObjectMapper json,
                      ShopProperties props, Clock clock, MeterRegistry meters) {
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
    }

    /**
     * 一輪。回傳這一輪確認了幾筆。
     * 7.9.2：三段，只有第一段與第三段有交易，而且都是短的。**送出與等 confirm 的時候，手上沒有任何資料庫的連線與鎖。**
     */
    int relayOnce() {
        List<OutboxStore.Row> rows = claimTx.execute(s -> store.claim(props.relayBatch(), lease));      // ① 認領：短交易、READ COMMITTED
        if (rows == null || rows.isEmpty()) return 0;
        List<CorrelationData> sent = new ArrayList<>(rows.size());
        List<Long> confirmed = new ArrayList<>(rows.size()), failed = new ArrayList<>();
        try {
            for (OutboxStore.Row r : rows) {                                                          // ② 送出（沒有交易）
                CorrelationData cd = new CorrelationData(r.eventId());
                rabbit.send(RabbitTopology.EVENTS, r.eventType(), message(r), cd);
                sent.add(cd);
            }
        } catch (RuntimeException e) {
            for (int i = sent.size(); i < rows.size(); i++) failed.add(rows.get(i).id());              // 沒送出去的
            failures.increment();
            if (sent.isEmpty()) {
                claimTx.executeWithoutResult(s -> store.release(failed));
                throw e;
            }
        }
        long deadline = System.nanoTime() + props.confirmTimeout().toNanos();
        for (int i = 0; i < sent.size(); i++) {                                                      // ③ 一筆一筆等 confirm
            CorrelationData cd = sent.get(i);
            OutboxStore.Row r = rows.get(i);
            try {
                CorrelationData.Confirm c = cd.getFuture().get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                if (!c.isAck()) { log.warn("OUTBOX_NACK eventId={} type={} reason={}", r.eventId(), r.eventType(), c.getReason()); failed.add(r.id()); }
                else if (cd.getReturned() != null) {                                                  // confirm 是 ack，但沒有任何佇列收下它
                    log.error("OUTBOX_UNROUTABLE eventId={} type={}：沒有佇列綁定這個 routing key", r.eventId(), r.eventType());
                    failed.add(r.id());
                } else {
                    confirmed.add(r.id());
                    delay.record(Duration.between(r.createdAt(), clock.instant()));
                }
            } catch (TimeoutException e) {
                log.warn("OUTBOX_CONFIRM_TIMEOUT eventId={}（{} 內沒有收到 confirm；下一輪再送 —— broker 可能其實收到了，會重複）",
                        r.eventId(), props.confirmTimeout());
                failed.add(r.id());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(e);
            } catch (ExecutionException e) {
                log.warn("OUTBOX_CONFIRM_FAILED eventId={}：{}", r.eventId(), e.getCause().toString());
                failed.add(r.id());
            }
        }
        claimTx.executeWithoutResult(s -> {                                                          // ④ 標記：短交易
            store.markPublished(confirmed);
            store.release(failed);
        });
        published.increment(confirmed.size());
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

**`src/main/java/com/example/shop/shared/messaging/internal/RabbitConsumers.java`**（7.5.1、7.5.3、7.9.4）

```java
package com.example.shop.shared.messaging.internal;

import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.internal.EventDispatcher;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.rabbitmq.client.Channel;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.AcknowledgeMode;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.rabbit.listener.SimpleMessageListenerContainer;
import org.springframework.amqp.rabbit.listener.api.ChannelAwareMessageListener;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

/**
 * 7.5 消費端：每一個 EventHandler 一個 listener container（手動 ack、prefetch 10）。
 *
 * 一則訊息的命運：
 *   處理成功（或重複，EventDispatcher）→ ack
 *   失敗，還有重試次數 → 複製一份送進下一級 retry 佇列（等 1、2、4、8、16 秒）→ 確認送進去了才 ack 原本那一則
 *   失敗，用完了       → handler.onDeadLetter() → 送進 shop.{consumer}.dlq → ack
 *   JSON 解析失敗      → 直接進死信：重試也不會變好（11-messaging/10 的 10.2.6）
 * 「等待」交給 broker 的 TTL，消費者的執行緒不 sleep（11-messaging/06 的 6.3.1：本地重試會卡住同一個佇列的其他訊息）。
 */
@Component
@ConditionalOnProperty(name = "shop.messaging.consumers-enabled", havingValue = "true", matchIfMissing = true)
class RabbitConsumers implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(RabbitConsumers.class);
    /** 11-messaging/05 的 5.4.6 */
    static final int PREFETCH = 10;

    private final List<EventHandler> handlers;
    private final ConnectionFactory cf;
    private final RabbitTemplate rabbit;
    private final EventDispatcher dispatcher;
    private final ObjectMapper json;
    private final List<Duration> delays;
    private final Duration confirmTimeout;
    private final Clock clock;
    private final MeterRegistry meters;
    private final List<SimpleMessageListenerContainer> containers = new CopyOnWriteArrayList<>();
    private volatile Thread starter;

    RabbitConsumers(List<EventHandler> handlers, ConnectionFactory cf, RabbitTemplate rabbit, EventDispatcher dispatcher,
                    ObjectMapper json, ShopProperties props, Clock clock, MeterRegistry meters) {
        this.handlers = handlers;
        this.cf = cf;
        this.rabbit = rabbit;
        this.dispatcher = dispatcher;
        this.json = json;
        this.delays = props.messaging().retryDelays();
        this.confirmTimeout = props.messaging().confirmTimeout();
        this.clock = clock;
        this.meters = meters;
    }

    void onMessage(EventHandler h, Message m, Channel ch) throws IOException {
        long tag = m.getMessageProperties().getDeliveryTag();
        Event e;
        try {
            e = parse(m);
        } catch (Exception bad) {
            log.error("EVENT_UNPARSEABLE consumer={} messageId={}：{}", h.consumer(), m.getMessageProperties().getMessageId(), bad.toString());
            settle(ch, tag, () -> deadLetter(h, m, 1, bad));
            return;
        }
        if (!h.eventTypes().contains(e.type())) {
            // 7.5.3：拓撲出錯（第一版的重試把訊息送回了每一個佇列）時的最後一道防線 —— 不要讓一個路由的 bug 變成一個業務動作
            // （ordering.stock-shortage 收到 order.placed，就會把一張好好的訂單取消掉）。正確的佇列有它自己的那一份
            log.error("EVENT_MISROUTED consumer={} 沒有訂閱 {}（eventId={}）：丟掉這一份", h.consumer(), e.type(), e.eventId());
            counter("shop.events.misrouted", h).increment();
            ch.basicAck(tag, false);
            return;
        }
        try {
            if (dispatcher.dispatch(h, e) == EventDispatcher.Outcome.PROCESSED)
                Timer.builder("shop.events.lag").tag("consumer", h.consumer()).description("事件從 commit 到處理完，經過多久（0.6.4）")
                        .publishPercentiles(0.5, 0.99).register(meters).record(Duration.between(e.occurredAt(), clock.instant()));
            ch.basicAck(tag, false);
        } catch (Exception ex) {
            if (e.attempt() <= delays.size()) {
                Duration d = delays.get(e.attempt() - 1);
                log.warn("EVENT_RETRY consumer={} eventId={} type={} attempt={}，{} 後重試：{}", h.consumer(), e.eventId(), e.type(), e.attempt(), d, ex.toString());
                counter("shop.events.retried", h).increment();
                settle(ch, tag, () -> publish(RabbitTopology.RETRY, RabbitTopology.tier(d), copy(m, h, e.attempt() + 1, ex)));
            } else {
                log.error("EVENT_DEAD_LETTERED consumer={} eventId={} type={}：重試 {} 次都失敗，送進 {}：{}", h.consumer(), e.eventId(), e.type(),
                        delays.size(), RabbitTopology.deadLetterQueue(h), ex.toString());
                counter("shop.events.dead_lettered", h).increment();
                try { h.onDeadLetter(e, ex); } catch (RuntimeException hookFailed) { log.error("onDeadLetter 失敗：{}", hookFailed.toString()); }
                settle(ch, tag, () -> deadLetter(h, m, e.attempt(), ex));
            }
        }
    }

    /** 先把訊息送到下一個地方（retry 或 dlq）並等 confirm，成功了才 ack 原本那一則。送不出去 → nack 重新排隊（at-least-once） */
    private void settle(Channel ch, long tag, Runnable forward) throws IOException {
        try {
            forward.run();
            ch.basicAck(tag, false);
        } catch (RuntimeException e) {
            log.warn("EVENT_FORWARD_FAILED：{}；訊息重新排隊", e.toString());
            try { Thread.sleep(1000); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
            ch.basicNack(tag, false, true);
        }
    }

    private void deadLetter(EventHandler h, Message m, int attempt, Exception ex) {
        publish(RabbitTopology.DEAD, RabbitTopology.queue(h), copy(m, h, attempt, ex));
    }

    private void publish(String exchange, String routingKey, Message m) {
        CorrelationData cd = new CorrelationData(m.getMessageProperties().getMessageId());
        rabbit.send(exchange, routingKey, m, cd);
        try {
            CorrelationData.Confirm c = cd.getFuture().get(confirmTimeout.toMillis(), TimeUnit.MILLISECONDS);
            if (!c.isAck() || cd.getReturned() != null) throw new IllegalStateException("轉送到 " + exchange + "/" + routingKey + " 沒有成功");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        } catch (Exception e) {
            throw e instanceof RuntimeException r ? r : new IllegalStateException(e);
        }
    }

    private static Message copy(Message m, EventHandler h, int attempt, Exception ex) {
        MessageProperties in = m.getMessageProperties(), out = new MessageProperties();
        out.setMessageId(in.getMessageId());
        out.setType(in.getType());
        out.setContentType(in.getContentType());
        out.setContentEncoding(in.getContentEncoding());
        out.setTimestamp(in.getTimestamp());
        out.setDeliveryMode(MessageDeliveryMode.PERSISTENT);
        in.getHeaders().forEach(out::setHeader);
        out.setHeader(RabbitTopology.TARGET_HEADER, RabbitTopology.queue(h));
        out.setHeader(RabbitTopology.ATTEMPT_HEADER, attempt);
        String msg = String.valueOf(ex);
        out.setHeader(RabbitTopology.ERROR_HEADER, msg.length() > 500 ? msg.substring(0, 500) : msg);
        return new Message(m.getBody(), out);
    }

    Event parse(Message m) throws IOException {
        JsonNode env = json.readTree(m.getBody());
        Object a = m.getMessageProperties().getHeaders().get(RabbitTopology.ATTEMPT_HEADER);
        int attempt = a instanceof Number n ? n.intValue() : 1;
        return new Event(env.get("eventId").asText(), env.get("type").asText(), env.get("aggregateType").asText(),
                env.get("aggregateId").asLong(), Instant.parse(env.get("occurredAt").asText()), env.get("payload"), attempt);
    }

    private Counter counter(String name, EventHandler h) {
        return Counter.builder(name).tag("consumer", h.consumer()).register(meters);
    }

    /**
     * 7.9.4：container 的 start() 會等它的消費者真的連上 broker。broker 被凍結（docker pause）的時候，
     * 在啟動執行緒上逐一 start，整個應用程式就起不來 —— 0.6.3 說 RabbitMQ 掛了 readiness 仍是 UP。
     * 所以放到一條自己的執行緒：應用程式照常啟動，消費者等 broker 回來再接上。
     */
    @Override
    public void start() {
        Thread t = new Thread(this::startContainers, "rabbit-consumers-starter");
        t.setDaemon(true);
        starter = t;
        t.start();
    }

    private void startContainers() {
        for (EventHandler h : handlers) {
            if (starter == null) return;                                    // stop() 已經被呼叫
            SimpleMessageListenerContainer c = new SimpleMessageListenerContainer(cf);
            c.setQueueNames(RabbitTopology.queue(h));
            c.setAcknowledgeMode(AcknowledgeMode.MANUAL);
            c.setPrefetchCount(PREFETCH);
            c.setConcurrentConsumers(h.concurrency());
            c.setDefaultRequeueRejected(false);
            c.setMessageListener((ChannelAwareMessageListener) (m, ch) -> onMessage(h, m, ch));
            c.afterPropertiesSet();
            containers.add(c);                                              // 先放進去：start() 卡住時 stop() 也找得到它
            try {
                c.start();
            } catch (RuntimeException e) {
                if (starter == null) { c.stop(); return; }                  // 關機途中被 interrupt：不是錯誤
                log.error("CONSUMER_START_FAILED consumer={}：{}", h.consumer(), e.toString());
            }
        }
    }

    @Override
    public void stop() {
        Thread t = starter;
        starter = null;
        if (t != null) t.interrupt();
        containers.forEach(SimpleMessageListenerContainer::stop);
        containers.clear();
    }

    @Override
    public boolean isRunning() { return starter != null; }

    @Override
    public int getPhase() { return Integer.MAX_VALUE - 200; }
}
```

**`src/main/java/com/example/shop/shared/messaging/internal/RabbitClientTimeouts.java`**（7.4.2、7.9.2）

```java
package com.example.shop.shared.messaging.internal;

import com.example.shop.shared.config.ShopProperties;
import org.springframework.boot.autoconfigure.amqp.ConnectionFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 7.9.2 broker 卡住（docker pause）時，RabbitMQ 用戶端的「通道 RPC」（開通道、confirmSelect……）預設等 10 分鐘。
 * H6b 的執行緒堆疊：relay 停在 com.rabbitmq 的 Object.wait 裡。把它限制在 confirm 的逾時（5 秒）：
 * 等不到就丟例外，relay 放掉租約、下一輪再試，而不是一個執行緒卡住幾分鐘。
 */
@Configuration(proxyBeanMethods = false)
class RabbitClientTimeouts {

    @Bean
    ConnectionFactoryCustomizer shopRabbitRpcTimeout(ShopProperties props) {
        return f -> f.setChannelRpcTimeout((int) props.messaging().confirmTimeout().toMillis());
    }
}
```

**`src/main/java/com/example/shop/shared/messaging/internal/DeadLetterController.java`**（7.5.5）

```java
package com.example.shop.shared.messaging.internal;

import com.example.shop.shared.audit.AuditAction;
import com.example.shop.shared.audit.AuditEntry;
import com.example.shop.shared.audit.AuditLog;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.Role;
import org.springframework.amqp.core.AmqpAdmin;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.rabbit.support.DefaultMessagePropertiesConverter;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;

import java.util.*;
import java.util.concurrent.TimeUnit;

/**
 * 7.5.5 死信的經營（11-messaging/10 的 10.5）：看得到、放得回去。
 *   GET  /api/admin/dead-letters                         每一個消費者的死信佇列裡有幾則
 *   POST /api/admin/dead-letters/{consumer}/replay?max=  把死信放回原佇列，重試次數歸零（重新走一次 1、2、4、8、16 秒）
 *
 * 放回去之前要先修好造成它的原因（SMTP 恢復了、金流恢復了、程式的 bug 修了）—— 否則 31 秒後它會回到這裡（10.5.2 的「很慢的無窮迴圈」）。
 * 重放是管理員的維運動作：寫稽核（US-AUD-1：所有管理員動作）。
 */
@RestController
class DeadLetterController {

    record DeadLetters(String consumer, String queue, long messages) {}

    record Replayed(String consumer, int replayed, long remaining) {}

    private final Map<String, EventHandler> handlers = new TreeMap<>();
    private final AmqpAdmin admin;
    private final RabbitTemplate rabbit;
    private final AuditLog audit;
    private final TransactionTemplate tx;
    private final long confirmTimeoutMs;

    DeadLetterController(List<EventHandler> handlers, AmqpAdmin admin, RabbitTemplate rabbit, AuditLog audit,
                         PlatformTransactionManager tm, ShopProperties props) {
        handlers.forEach(h -> this.handlers.put(h.consumer(), h));
        this.admin = admin;
        this.rabbit = rabbit;
        this.audit = audit;
        this.tx = new TransactionTemplate(tm);
        this.confirmTimeoutMs = props.messaging().confirmTimeout().toMillis();
    }

    @GetMapping("/api/admin/dead-letters")
    List<DeadLetters> list(CurrentUser user) {
        user.require(Role.ADMIN);
        List<DeadLetters> out = new ArrayList<>();
        for (EventHandler h : handlers.values()) {
            var info = admin.getQueueInfo(RabbitTopology.deadLetterQueue(h));
            out.add(new DeadLetters(h.consumer(), RabbitTopology.deadLetterQueue(h), info == null ? 0 : info.getMessageCount()));
        }
        return out;
    }

    @PostMapping("/api/admin/dead-letters/{consumer}/replay")
    Replayed replay(CurrentUser user, @PathVariable String consumer, @RequestParam(defaultValue = "100") int max) {
        user.require(Role.ADMIN);
        EventHandler h = handlers.get(consumer);
        if (h == null) throw ShopException.notFound("消費者");
        String dlq = RabbitTopology.deadLetterQueue(h), target = RabbitTopology.queue(h);
        int n = rabbit.execute(ch -> {
            int moved = 0;
            var converter = new DefaultMessagePropertiesConverter();
            while (moved < Math.max(1, Math.min(max, 10_000))) {
                var got = ch.basicGet(dlq, false);                          // 手動 ack：放回去確認了，才從死信佇列拿掉
                if (got == null) break;
                MessageProperties props = converter.toMessageProperties(got.getProps(), got.getEnvelope(), "UTF-8");
                props.setHeader(RabbitTopology.ATTEMPT_HEADER, 1);
                CorrelationData cd = new CorrelationData(props.getMessageId());
                rabbit.send("", target, new Message(got.getBody(), props), cd);   // 預設 exchange：routing key = 佇列名稱，直接送回原佇列
                try {
                    CorrelationData.Confirm c = cd.getFuture().get(confirmTimeoutMs, TimeUnit.MILLISECONDS);
                    if (!c.isAck() || cd.getReturned() != null) { ch.basicNack(got.getEnvelope().getDeliveryTag(), false, true); break; }
                } catch (Exception e) {
                    ch.basicNack(got.getEnvelope().getDeliveryTag(), false, true);
                    break;
                }
                ch.basicAck(got.getEnvelope().getDeliveryTag(), false);
                moved++;
            }
            return moved;
        });
        var info = admin.getQueueInfo(dlq);
        long remaining = info == null ? 0 : info.getMessageCount();
        tx.executeWithoutResult(s -> audit.record(AuditEntry.of(AuditAction.DEAD_LETTERS_REPLAYED, user.id(), "ADMIN", "QUEUE", dlq,
                Map.of("replayed", n, "remaining", remaining))));
        return new Replayed(consumer, n, remaining);
    }
}
```

#### 設定與 migration

**`src/main/java/com/example/shop/shared/config/ShopProperties.java`**（節錄：`Messaging` 與 `Inventory`）

```java
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

    // ……RateLimit、Order、Payment、Security 等其他 record 照第 06 章……
}
```

**`src/main/resources/db/migration/V14__shared_outbox_claim_lease.sql`**（7.9.2）

```sql
-- 7.9.2 relay 不能在交易裡等 broker：claim 改成「蓋一個租約、commit」，送出時不拿任何鎖。
-- claimed_until：這一列被某一台 relay 認領到什麼時候（NULL = 沒有人）。租約過期、還沒送出 → 別人可以再認領（at-least-once）。
-- 一句 DDL、ALGORITHM=INSTANT（同 V13）。
ALTER TABLE outbox_events ADD COLUMN claimed_until DATETIME(3) NULL, ALGORITHM=INSTANT;
```

#### 庫存

**`src/main/java/com/example/shop/inventory/internal/HotStock.java`**（節錄：`giveBackOrFail()`，取代第 06 章的 `giveBackAfterCommit()`；`GATE_BASE_SQL` 在 7.6.2）

```java
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
```

**`src/main/java/com/example/shop/inventory/internal/JdbcInventoryService.java`**（節錄：`release()` 到 `returnToHotStock()`；`holdHot()`、`settleHot()` 在 7.6.2，建構子多注入 `Outbox` 與 `MeterRegistry`（`shop.inventory.hot.shortage`））

```java
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
        jdbc.update("UPDATE inventory SET on_hand = on_hand + ? WHERE product_id = ?", quantity, productId);
        ledger(productId, quantity, 0, "RESTOCK", note);
        returnToHotStock(productId, List.of(new ReserveLine(productId, quantity)));
    }

    @Override
    @Transactional
    public void restockBatch(List<RestockLine> lines, String note) {
        List<Object[]> upd = new ArrayList<>(lines.size()), led = new ArrayList<>(lines.size());
        for (RestockLine l : lines) {
            if (l.quantity() <= 0) throw new IllegalArgumentException("quantity must be positive");
            upd.add(new Object[]{l.quantity(), l.productId()});
            led.add(new Object[]{l.productId(), l.quantity(), 0, "RESTOCK", note});
        }
        jdbc.batchUpdate("UPDATE inventory SET on_hand = on_hand + ? WHERE product_id = ?", upd);
        jdbc.batchUpdate("""
                INSERT INTO inventory_ledger(product_id, delta_on_hand, delta_reserved, reason, ref)
                VALUES (?, ?, ?, ?, ?)""", led);
        returnToHotStock(0, lines.stream().map(l -> new ReserveLine(l.productId(), l.quantity())).toList());
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
```

**`src/main/java/com/example/shop/inventory/internal/InventoryEventHandlers.java`**（7.6.2、7.6.5）

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

/** 7.6 庫存模組的兩個消費者 */
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

**`src/main/java/com/example/shop/inventory/internal/InventoryJobs.java`**（7.10）

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
        var thirty = java.time.Duration.ofSeconds(30);
        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(reconciliation::checkUncounted, thirty, thirty));
    }
}
```

**`src/main/java/com/example/shop/inventory/internal/InventoryReconciliation.java`**（7.10）

```java
package com.example.shop.inventory.internal;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
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
        CHECKS.put("INV-3", """
                SELECT COUNT(*) FROM inventory i
                  LEFT JOIN (SELECT product_id, SUM(delta_on_hand) AS s FROM inventory_ledger GROUP BY product_id) l ON l.product_id = i.product_id
                 WHERE i.on_hand <> COALESCE(l.s, 0)""");
    }

    private final JdbcTemplate jdbc;
    private final Map<String, Long> diffs = new ConcurrentHashMap<>();
    private volatile double uncountedOldestSeconds;
    private volatile long uncounted;

    InventoryReconciliation(JdbcTemplate jdbc, MeterRegistry meters) {
        this.jdbc = jdbc;
        for (String check : CHECKS.keySet()) {
            diffs.put(check, 0L);
            Gauge.builder("shop.reconciliation.diff", () -> diffs.get(check)).tag("check", check)
                    .description("對帳差異（商品數）：不是 0 就要有人看").register(meters);
        }
        Gauge.builder("shop.inventory.uncounted", () -> uncounted).description("還沒計入 reserved 的熱點預留（7.6）").register(meters);
        Gauge.builder("shop.inventory.uncounted_oldest_age_seconds", () -> uncountedOldestSeconds)
                .description("最舊的未計入熱點預留放了幾秒（0.6.4：> 60 告警）").register(meters);
    }

    /** 每小時：INV-2、INV-3 */
    Map<String, Long> checkInvariants() {
        Map<String, Long> out = new LinkedHashMap<>();
        CHECKS.forEach((name, sql) -> {
            long diff = jdbc.queryForObject(sql, Long.class);
            diffs.put(name, diff);
            out.put(name, diff);
            if (diff != 0) log.error("RECONCILIATION_DIFF {}：{} 個商品對不上（0.4.6）", name, diff);
        });
        return out;
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

#### 訂單

**`src/main/java/com/example/shop/ordering/internal/OrderTransitionService.java`**（7.4.1、7.6.3）

```java
package com.example.shop.ordering.internal;

import com.example.shop.inventory.InventoryApi;
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
    private final InventoryApi inventory;
    private final PaymentApi payments;
    private final OrderHistory history;
    private final Outbox outbox;
    private final Clock clock;

    OrderTransitionService(JdbcTemplate jdbc, InventoryApi inventory, PaymentApi payments, OrderHistory history, Outbox outbox, Clock clock) {
        this.jdbc = jdbc;
        this.inventory = inventory;
        this.payments = payments;
        this.history = history;
        this.outbox = outbox;
        this.clock = clock;
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
                        boolean refunded = sideEffects(orderId, cur, d, event);
                        history.record(orderId, cur.status(), d.to(), event.name(), actor, now);
                        publish(orderId, cur, d.to(), event, data, refunded);
                        return d.to();
                    }
                    // 0 列：在我們讀取之後、更新之前，別人改了狀態（排程 vs 回呼，4.2.5）。重讀、重新決定
                }
            }
        }
        throw new ShopException(ProblemType.INVALID_STATE, "訂單狀態正在變動，請稍後再試");
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
            case PENDING_PAYMENT -> throw new IllegalStateException("沒有任何轉移會回到 PENDING_PAYMENT");
        };
    }

    /** 0.5.4 表格的左欄：必須跟狀態一起 commit 的事 */
    /** @return 有沒有建立退款單 */
    private boolean sideEffects(long orderId, Current cur, Decision d, OrderEvent event) {
        switch (d.to()) {
            case PAID -> inventory.confirm(orderId);                        // HELD → CONFIRMED：從此不能被逾時釋放（US-ORD-3 AC-4）
            case SHIPPED -> inventory.consume(orderId);                     // onHand、reserved 同時減少（US-ORD-6 AC-2）
            case CANCELLED -> {
                inventory.release(orderId);
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
    private void publish(long orderId, Current cur, OrderStatus to, OrderEvent event, EventData data, boolean refunded) {
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

**`src/main/java/com/example/shop/ordering/internal/OrderStateMachine.java`**（7.6.3：E10）

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;

import static com.example.shop.ordering.OrderStatus.*;
import static com.example.shop.ordering.internal.OrderEvent.*;

/**
 * 0.5.3 的 6 × 10 轉移表（E10 是第 07 章加的，7.6.3）。這個類別沒有任何依賴、不碰資料庫 —— 它只回答「在這個狀態收到這個事件，該怎麼辦」。
 * 真正的狀態改變（條件式 UPDATE、預留、退款）由 OrderTransitionService 照著它的答案去做。
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
            };
            case PAID -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;   // 同一筆重送 / 付了兩次錢
                case PAY_FAILED -> Decision.SAME;
                case BUYER_CANCEL, SELLER_CANCEL -> Decision.toWithRefund(CANCELLED);
                case PAYMENT_TIMEOUT, AUTO_COMPLETE -> Decision.IGNORE;
                case START_PICKING -> Decision.to(PICKING);
                case SHIP, CONFIRM_RECEIPT -> Decision.REJECT;
                case STOCK_SHORTAGE -> Decision.toWithRefund(CANCELLED);   // 付了錢、貨不存在：取消 + 退款
            };
            case PICKING -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;
                case PAY_FAILED, START_PICKING -> Decision.SAME;
                case BUYER_CANCEL, CONFIRM_RECEIPT -> Decision.REJECT; // 撿貨中買家不能取消（0.2.2 定案）
                case PAYMENT_TIMEOUT, AUTO_COMPLETE -> Decision.IGNORE;
                case SELLER_CANCEL -> Decision.toWithRefund(CANCELLED);
                case SHIP -> Decision.to(SHIPPED);
                case STOCK_SHORTAGE -> Decision.toWithRefund(CANCELLED);
            };
            case SHIPPED -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;
                case PAY_FAILED -> Decision.SAME;
                case BUYER_CANCEL, SELLER_CANCEL, START_PICKING -> Decision.REJECT;
                case PAYMENT_TIMEOUT -> Decision.IGNORE;
                case SHIP -> same ? Decision.SAME : Decision.REJECT;    // 同單號重送 / 換了單號（操作錯誤）
                case CONFIRM_RECEIPT, AUTO_COMPLETE -> Decision.to(COMPLETED);
                case STOCK_SHORTAGE -> Decision.IGNORE;                  // 不會發生：落帳沒完成的訂單出不了貨（7.6.4）
            };
            case COMPLETED -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;
                case PAY_FAILED, CONFIRM_RECEIPT -> Decision.SAME;
                case BUYER_CANCEL, SELLER_CANCEL, START_PICKING, SHIP -> Decision.REJECT;
                case PAYMENT_TIMEOUT, AUTO_COMPLETE, STOCK_SHORTAGE -> Decision.IGNORE;
            };
            case CANCELLED -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;   // 晚到的付款（0.2.2 的 2,042 筆）
                case PAY_FAILED, BUYER_CANCEL, SELLER_CANCEL, STOCK_SHORTAGE -> Decision.SAME;
                case PAYMENT_TIMEOUT, AUTO_COMPLETE -> Decision.IGNORE;
                case START_PICKING, SHIP, CONFIRM_RECEIPT -> Decision.REJECT;
            };
        };
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/StockShortageHandler.java`**（7.6.3）

```java
package com.example.shop.ordering.internal;

import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.EventTypes;
import org.springframework.stereotype.Component;

import java.util.Set;

/**
 * 7.6.3 熱點落帳發現庫存不足：這張訂單已經回了 201，現在要取消它（E10）。
 * 交易由 EventDispatcher 開，apply() 加入同一個交易：processed_messages、訂單狀態、預留釋放、退款單、order.cancelled 一起 commit。
 */
@Component
class StockShortageHandler implements EventHandler {

    private final OrderTransitionService transitions;

    StockShortageHandler(OrderTransitionService transitions) { this.transitions = transitions; }

    @Override public String consumer() { return "ordering.stock-shortage"; }

    @Override public Set<String> eventTypes() { return Set.of(EventTypes.HOT_SETTLEMENT_FAILED); }

    @Override
    public void handle(Event e) {
        transitions.apply(e.getLong("orderId"), OrderEvent.STOCK_SHORTAGE, OrderHistory.Actor.system(), OrderTransitionService.EventData.NONE);
    }
}
```

#### 付款與通知

**`src/main/java/com/example/shop/payment/PaymentApi.java`**（`requestRefund` 多一個 `buyerId`）

```java
package com.example.shop.payment;

import java.math.BigDecimal;
import java.util.Optional;

/**
 * 付款模組的對外入口（給 ordering 用）。這個模組不知道訂單的狀態機 —— 它只記錄「錢」發生了什麼事，
 * 由 ordering 決定那對訂單意味著什麼（0.5.1 的 📌：退款是付款的狀態，不是訂單的狀態）。
 */
public interface PaymentApi {

    record CreatedPayment(long paymentId, BigDecimal amount, String payUrl) {}

    /** US-ORD-2 AC-1：為一張訂單建立一次付款嘗試（PENDING）。 */
    CreatedPayment create(long orderId, BigDecimal amount);

    /** 金流回呼的內容（模擬金流送來的） */
    record Callback(long paymentId, String providerTxnId, BigDecimal amount, boolean succeeded, String signature) {}

    record Recorded(long paymentId, long orderId, Kind kind) {
        public enum Kind { FIRST_SUCCESS, DUPLICATE, FAILED }
    }

    /**
     * 驗簽（AC-3）、比對金額（AC-4）、以 providerTxnId 冪等（AC-5），然後記錄結果。
     * 簽章錯誤 → 401；金額不符 → 400。必須在呼叫端的交易內呼叫（MANDATORY）。
     */
    Recorded record(Callback callback);

    /**
     * 為一筆成功的付款建立全額退款（PENDING）。同一筆付款重複呼叫不會建第二筆（uk_refunds_payment）。MANDATORY。
     * 第 07 章：同一個交易裡記一個 refund.requested —— 真正呼叫金流的是 payment.refunds 消費者（7.8），在 commit 之後、交易之外。
     * buyerId 只放進事件（通知要寄給誰）；payment 模組不存它。
     */
    void requestRefund(long paymentId, RefundReason reason, long buyerId);

    /** 這張訂單「讓它變成已付款」的那一筆付款（最早成功、而且還沒退款的） */
    Optional<Long> succeededPaymentOf(long orderId);
}
```

**`src/main/java/com/example/shop/payment/internal/RefundExecutor.java`**（7.8.1）

```java
package com.example.shop.payment.internal;

import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.EventTypes;
import com.example.shop.shared.events.Outbox;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.util.Map;
import java.util.Set;

/**
 * 7.8 執行退款（0.5.4：「呼叫金流退款 API —— 可重試，失敗進死信 + 告警」；0.6.4：5 分鐘內發起）。
 *
 * transactional() = false：金流呼叫是外部的，processed_messages 跟它不在同一個交易裡，保護不了它（7.2.3）。
 * 冪等靠兩件事：
 *  ① refunds.status：已經 SUCCEEDED 的不再呼叫
 *  ② 冪等鍵 "refund-{id}" 交給金流：呼叫成功、回應沒回來（逾時）→ 重試時金流認得這個鍵，錢不會退兩次
 * 呼叫在交易外面（0.5.4 的 ⚠️、05-service/02 的 2.9.3）：金流慢 3 秒，不會有一條連線被佔 3 秒。
 */
@Component
class RefundExecutor implements EventHandler {

    private static final Logger log = LoggerFactory.getLogger(RefundExecutor.class);

    private final JdbcTemplate jdbc;
    private final SimulatedRefundGateway gateway;
    private final Outbox outbox;
    private final TransactionTemplate tx;
    private final Counter failed;

    RefundExecutor(JdbcTemplate jdbc, SimulatedRefundGateway gateway, Outbox outbox, PlatformTransactionManager tm, MeterRegistry meters) {
        this.jdbc = jdbc;
        this.gateway = gateway;
        this.outbox = outbox;
        this.tx = new TransactionTemplate(tm);
        this.failed = Counter.builder("shop.refunds.failed").description("重試用完仍然失敗的退款（0.5.4：告警，要有人處理）").register(meters);
    }

    @Override public String consumer() { return "payment.refunds"; }
    @Override public Set<String> eventTypes() { return Set.of(EventTypes.REFUND_REQUESTED); }
    @Override public boolean transactional() { return false; }

    @Override
    public void handle(Event e) {
        long refundId = e.getLong("refundId");
        Map<String, Object> r = jdbc.queryForMap("SELECT payment_id, order_id, amount, status FROM refunds WHERE id = ?", refundId);
        if ("SUCCEEDED".equals(r.get("status"))) return;                    // 重複的訊息：已經退過了
        long paymentId = ((Number) r.get("payment_id")).longValue();
        String providerRefundId;
        try {
            providerRefundId = gateway.refund("refund-" + refundId, paymentId, (BigDecimal) r.get("amount"));
        } catch (RuntimeException ex) {
            jdbc.update("UPDATE refunds SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", refundId);
            throw ex;                                                       // 重試階梯：1、2、4、8、16 秒
        }
        tx.executeWithoutResult(s -> {
            int n = jdbc.update("""
                    UPDATE refunds SET status = 'SUCCEEDED', provider_refund_id = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE id = ? AND status IN ('PENDING', 'FAILED')""", providerRefundId, refundId);
            if (n == 1) outbox.add("REFUND", refundId, EventTypes.REFUND_SUCCEEDED, Map.of("refundId", refundId,
                    "orderId", r.get("order_id"), "amount", r.get("amount"), "buyerId", e.getLong("buyerId")));
        });
    }

    /** 重試用完：標成 FAILED、告警。死信重放（7.5.5）時 handle() 會再試一次 —— FAILED 的也會被處理 */
    @Override
    public void onDeadLetter(Event e, Exception lastError) {
        long refundId = e.getLong("refundId");
        tx.executeWithoutResult(s -> {
            int n = jdbc.update("UPDATE refunds SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'PENDING'", refundId);
            if (n == 1) outbox.add("REFUND", refundId, EventTypes.REFUND_FAILED, Map.of("refundId", refundId, "orderId", e.getLong("orderId"),
                    "amount", e.getText("amount"), "buyerId", e.getLong("buyerId"), "error", String.valueOf(lastError)));
        });
        failed.increment();
        log.error("REFUND_FAILED refundId={} orderId={}：重試用完，需要人工處理：{}", refundId, e.getLong("orderId"), lastError.toString());
    }
}
```

**`src/main/java/com/example/shop/payment/internal/SimulatedRefundGateway.java`**（7.2.3、7.8）

```java
package com.example.shop.payment.internal;

import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 7.8 模擬的金流退款 API（0.7 第 1 條：不串真實金流）。照真實金流的兩個行為做：
 *  ① 冪等鍵：同一個 key 再呼叫一次，回傳同一筆退款，錢不會再退一次（大部分金流的退款 API 都收一個 idempotency key）
 *  ② 會失敗：連不上（呼叫失敗，錢沒退）、回應沒回來（錢退了，但你不知道）—— 後者是 7.2.3 的事故
 *
 * 失敗是「注入」的：測試與實驗用 failNext、loseResponseNext 控制（public 只是為了讓測試拿得到這些開關）。
 */
@Component
public class SimulatedRefundGateway {

    static class GatewayException extends RuntimeException {
        GatewayException(String m) { super(m); }
    }

    /** 冪等鍵 → 金流的退款編號 */
    private final Map<String, String> byKey = new ConcurrentHashMap<>();
    /** 錢真的被退出去的次數（每一筆付款） */
    private final Map<Long, AtomicInteger> moneyOut = new ConcurrentHashMap<>();
    private final AtomicInteger failNext = new AtomicInteger(), loseResponseNext = new AtomicInteger(), calls = new AtomicInteger();
    private volatile boolean down;
    private volatile long latencyMs = 20;

    /** 退款。idempotencyKey 相同 → 不會再退一次 */
    String refund(String idempotencyKey, long paymentId, BigDecimal amount) {
        calls.incrementAndGet();
        sleep(latencyMs);
        if (down) throw new GatewayException("金流退款 API 連不上");
        if (failNext.getAndUpdate(n -> Math.max(0, n - 1)) > 0) throw new GatewayException("金流退款 API 回 503");
        String id = byKey.computeIfAbsent(idempotencyKey, k -> {
            moneyOut.computeIfAbsent(paymentId, p -> new AtomicInteger()).incrementAndGet();
            return "RF" + Math.abs(k.hashCode());
        });
        if (loseResponseNext.getAndUpdate(n -> Math.max(0, n - 1)) > 0)
            throw new GatewayException("金流退款 API 逾時（錢已經退了，回應沒有回來）");
        return id;
    }

    // ───────── 測試與實驗用 ─────────
    public void failNext(int n) { failNext.set(n); }
    public void loseResponseNext(int n) { loseResponseNext.set(n); }
    public void down(boolean d) { down = d; }
    public void latency(long ms) { latencyMs = ms; }
    public int moneyOutFor(long paymentId) { AtomicInteger a = moneyOut.get(paymentId); return a == null ? 0 : a.get(); }
    public int calls() { return calls.get(); }
    public void reset() { failNext.set(0); loseResponseNext.set(0); down = false; latencyMs = 20; }

    private static void sleep(long ms) {
        if (ms <= 0) return;
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
```

**`src/main/java/com/example/shop/notification/internal/NotificationHandler.java`**（7.7）

```java
package com.example.shop.notification.internal;

import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.EventTypes;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 7.7 US-NTF-1 訂單通知。0.5.4 表格右欄的「通知……」都在這裡。
 *
 * transactional() = false：寄信不在 MySQL 裡，processed_messages 保護不了它。冪等靠 notifications 自己：
 *  ① dedup_key = eventId:類型（V7 的唯一索引）：同一個事件、同一種通知只有一列（AC-3）
 *  ② 寄之前先「認領」：attempts 從 n 改成 n + 1，只有一個人會成功 —— 同一則訊息同時被投遞兩次，只有一個去寄
 *  ③ 寄完標 SENT；之後再來的同一個事件看到 SENT 就跳過
 * 擋不住的一種：寄出去了、標 SENT 之前行程死掉 → 重送時再寄一次。寄信本身沒有冪等鍵 —— 這是 at-least-once 的代價（7.7.2）。
 */
@Component
class NotificationHandler implements EventHandler {

    private static final Logger log = LoggerFactory.getLogger(NotificationHandler.class);

    record Target(long userId, String type, String text) {}

    private final JdbcTemplate jdbc;
    private final SimulatedMailer mailer;
    private final ObjectMapper json;

    NotificationHandler(JdbcTemplate jdbc, SimulatedMailer mailer, ObjectMapper json) {
        this.jdbc = jdbc;
        this.mailer = mailer;
        this.json = json;
    }

    @Override public String consumer() { return "notification.order-events"; }

    @Override
    public Set<String> eventTypes() {
        return Set.of(EventTypes.ORDER_PLACED, EventTypes.ORDER_PAID, EventTypes.ORDER_CANCELLED, EventTypes.ORDER_SHIPPED, EventTypes.REFUND_SUCCEEDED);
    }

    @Override public boolean transactional() { return false; }

    /** AC-1：訂單成立 / 付款成功 / 已出貨 / 已取消（含退款）；0.5.4：付款成功時賣家也要知道「有新訂單」 */
    static List<Target> targets(Event e) {
        String no = e.getText("orderNo");
        long buyer = e.getLong("buyerId");
        List<Target> t = new ArrayList<>();
        switch (e.type()) {
            case EventTypes.ORDER_PLACED -> t.add(new Target(buyer, "ORDER_PLACED", "訂單 " + no + " 已成立，請在 15 分鐘內完成付款"));
            case EventTypes.ORDER_PAID -> {
                t.add(new Target(buyer, "ORDER_PAID", "訂單 " + no + " 付款成功"));
                t.add(new Target(e.getLong("sellerId"), "NEW_ORDER", "你有一張新訂單 " + no + "，請盡快出貨"));
            }
            case EventTypes.ORDER_CANCELLED -> t.add(new Target(buyer, "ORDER_CANCELLED", "訂單 " + no + " 已取消（" + e.getText("cancelReason") + "）"
                    + (e.getBoolean("refund") ? "，款項將全額退回" : "")));
            case EventTypes.ORDER_SHIPPED -> t.add(new Target(buyer, "ORDER_SHIPPED", "訂單 " + no + " 已出貨：" + e.getText("carrier") + " " + e.getText("trackingNo")));
            case EventTypes.REFUND_SUCCEEDED -> t.add(new Target(buyer, "REFUND_SUCCEEDED", "訂單的退款 " + e.getText("amount") + " 元已完成"));
            default -> { }
        }
        return t;
    }

    @Override
    public void handle(Event e) {
        for (Target t : targets(e)) {
            String dedup = e.eventId() + ":" + t.type();
            jdbc.update("""
                    INSERT INTO notifications (user_id, type, dedup_key, payload) VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE id = id""", t.userId(), t.type(), dedup, payload(e, t));
            Map<String, Object> row = jdbc.queryForMap("SELECT id, status, attempts FROM notifications WHERE dedup_key = ?", dedup);
            if ("SENT".equals(row.get("status"))) continue;                // AC-3：已經寄過了
            long id = ((Number) row.get("id")).longValue();
            int attempts = ((Number) row.get("attempts")).intValue();
            int claimed = jdbc.update("UPDATE notifications SET attempts = attempts + 1 WHERE id = ? AND status <> 'SENT' AND attempts = ?", id, attempts);
            if (claimed == 0) continue;                                     // 同一則訊息的另一份正在寄（或剛寄完）
            mailer.send(t.userId(), t.type(), dedup, t.text());             // 失敗 → 例外 → 重試階梯（AC-4）
            jdbc.update("UPDATE notifications SET status = 'SENT', sent_at = CURRENT_TIMESTAMP(3) WHERE id = ?", id);
        }
    }

    /** AC-4：重試 5 次之後進死信 —— 這幾封標成 FAILED */
    @Override
    public void onDeadLetter(Event e, Exception lastError) {
        for (Target t : targets(e))
            jdbc.update("UPDATE notifications SET status = 'FAILED' WHERE dedup_key = ? AND status = 'PENDING'", e.eventId() + ":" + t.type());
        log.error("NOTIFICATION_FAILED eventId={} type={}：{}", e.eventId(), e.type(), lastError.toString());
    }

    private String payload(Event e, Target t) {
        try {
            return json.writeValueAsString(Map.of("eventType", e.type(), "aggregateId", e.aggregateId(), "text", t.text()));
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }
}
```

**`src/main/java/com/example/shop/notification/internal/SimulatedMailer.java`**（7.7.1）

```java
package com.example.shop.notification.internal;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.LongPredicate;

/**
 * US-NTF-1 AC-1：「本專題以寫入 notifications 表 + 日誌模擬寄信」。這個類別就是那個「寄信」：記一行日誌、記下寄了什麼。
 * 失敗是注入的（AC-4 的「模擬的 SMTP 連續失敗」）：down、failNext、poisonUser。public 只是為了讓測試與實驗拿得到這些開關。
 */
@Component
public class SimulatedMailer {

    private static final Logger log = LoggerFactory.getLogger(SimulatedMailer.class);

    static class MailException extends RuntimeException {
        MailException(String m) { super(m); }
    }

    public record Sent(long userId, String type, String dedupKey, String text, long at) {}

    private final ConcurrentLinkedQueue<Sent> sent = new ConcurrentLinkedQueue<>();
    private final AtomicInteger failNext = new AtomicInteger();
    private volatile boolean down;
    private volatile LongPredicate poisonUser = u -> false;

    void send(long userId, String type, String dedupKey, String text) {
        if (down) throw new MailException("SMTP 連不上");
        if (poisonUser.test(userId)) throw new MailException("SMTP 拒收：使用者 " + userId + " 的信箱不存在");
        if (failNext.getAndUpdate(n -> Math.max(0, n - 1)) > 0) throw new MailException("SMTP 暫時失敗");
        sent.add(new Sent(userId, type, dedupKey, text, System.currentTimeMillis()));
        log.info("MAIL_SENT user={} type={} {}", userId, type, text);
    }

    // ───────── 測試與實驗用 ─────────
    public List<Sent> sent() { return List.copyOf(sent); }
    public void down(boolean d) { down = d; }
    public void failNext(int n) { failNext.set(n); }
    public void poisonUser(LongPredicate p) { poisonUser = p; }
    public void reset() { down = false; failNext.set(0); poisonUser = u -> false; sent.clear(); }
}
```

#### 測試支援與流程測試

**`src/test/java/com/example/shop/support/InlineEvents.java`**（7.12.1）

```java
package com.example.shop.support;

import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.internal.EventDispatcher;
import com.example.shop.shared.events.internal.OutboxStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

/**
 * 第 07 章（7.12.1）：不經過 RabbitMQ，把 outbox 裡還沒送出的事件直接交給訂閱它的 EventHandler，然後標成已送出。
 * 給「要消費者的效果、但不想要 broker 的時間差」的測試用：結果是確定的，而且不會被別的測試的消費者搶走。
 * 端到端（真的 relay、真的 RabbitMQ）由 EventFlowTest 與驗收 Q9、Q10 負責。
 */
public final class InlineEvents {
    private InlineEvents() {}

    /** 交付符合條件的事件；handler 又寫了新事件（例如落帳失敗 → 取消 → order.cancelled）也會一起交付，直到沒有新的。回傳交付了幾個事件 */
    public static int deliver(ApplicationContext ctx, Predicate<OutboxStore.Row> which) {
        JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
        ObjectMapper json = ctx.getBean(ObjectMapper.class);
        EventDispatcher dispatcher = ctx.getBean(EventDispatcher.class);
        Map<String, EventHandler> handlers = ctx.getBeansOfType(EventHandler.class);
        TransactionTemplate tx = new TransactionTemplate(ctx.getBean(PlatformTransactionManager.class));
        int delivered = 0;
        for (int round = 0; round < 10; round++) {
            List<OutboxStore.Row> rows = new ArrayList<>(jdbc.query("""
                    SELECT id, event_id, aggregate_type, aggregate_id, event_type, payload, created_at, trace_id
                      FROM outbox_events WHERE published_at IS NULL ORDER BY id""",
                    (rs, i) -> new OutboxStore.Row(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getLong(4), rs.getString(5),
                            rs.getString(6), rs.getTimestamp(7).toInstant(), rs.getString(8))));
            rows.removeIf(which.negate());
            if (rows.isEmpty()) return delivered;
            for (OutboxStore.Row r : rows) {
                Event e;
                try {
                    e = new Event(r.eventId(), r.eventType(), r.aggregateType(), r.aggregateId(), r.createdAt(), json.readTree(r.payload()), 1);
                } catch (Exception ex) {
                    throw new IllegalStateException(ex);
                }
                for (EventHandler h : handlers.values())
                    if (h.eventTypes().contains(r.eventType())) dispatcher.dispatch(h, e);
                tx.executeWithoutResult(s -> jdbc.update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE id = ?", r.id()));
                delivered++;
            }
        }
        throw new IllegalStateException("事件一直產生新的事件，交付了 10 輪還沒停");
    }

    /** 某些訂單（ORDER 類事件，以及取消時的 inventory.stock-returned）的事件 */
    public static Predicate<OutboxStore.Row> ofOrders(List<Long> orderIds) {
        return r -> orderIds.contains(r.aggregateId()) && (r.aggregateType().equals("ORDER") || r.aggregateType().equals("INVENTORY"));
    }

    /** 測試開始時用：outbox 裡別的測試留下、沒有人送的事件（它們的資料早就被清掉了），標成已送出 */
    public static void skipBacklog(ApplicationContext ctx) {
        ctx.getBean(JdbcTemplate.class).update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");
    }
}
```

**`src/test/java/com/example/shop/support/TestQueues.java`**（7.12.1、7.13）

```java
package com.example.shop.support;

import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.events.EventHandler;
import org.springframework.amqp.core.AmqpAdmin;
import org.springframework.amqp.core.QueueInformation;
import org.springframework.context.ApplicationContext;

import java.time.Duration;

/**
 * 第 07 章（7.12.1）：用真的 broker 的測試，開始之前把消費者的佇列清空。
 * 實驗（H2 的子行程只開 relay、不開消費者）或中斷的測試會在佇列裡留下幾百、幾千則訊息；
 * 下一個打開消費者的測試會先花十幾秒處理它們 —— 自己的那幾則被排在後面，await 就逾時了（第一次遇到：EventFlowTest 3 個紅）。
 */
public final class TestQueues {
    private TestQueues() {}

    public static void purgeConsumerQueues(ApplicationContext ctx) {
        AmqpAdmin admin = ctx.getBean(AmqpAdmin.class);
        for (EventHandler h : ctx.getBeansOfType(EventHandler.class).values()) admin.purgeQueue("shop." + h.consumer(), false);
    }

    /**
     * 要數死信的測試用：context 一啟動，relay 就把 outbox 裡別的測試留下的事件送出去了（InlineEvents.skipBacklog 在那之後才跑）。
     * 它們的資料早就被清掉，處理失敗、走完重試階梯才進死信 —— 可能在你清空死信佇列「之後」才到（第一次遇到：死信 47 則，預期 1 則）。
     * 等到死信的數量在「重試階梯的總長 + 1 秒」裡都不再變，再清空。
     */
    public static void purgeDeadLettersWhenQuiet(ApplicationContext ctx, String dlq) {
        AmqpAdmin admin = ctx.getBean(AmqpAdmin.class);
        long quietMs = ctx.getBean(ShopProperties.class).messaging().retryDelays().stream().mapToLong(Duration::toMillis).sum() + 1000;
        long last = -1;
        while (true) {
            QueueInformation q = admin.getQueueInfo(dlq);
            long n = q == null ? 0 : q.getMessageCount();
            if (n == last) break;
            last = n;
            try { Thread.sleep(quietMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
        admin.purgeQueue(dlq, false);
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/EventFlowTest.java`**（7.5.3、7.6、7.7）

```java
package com.example.shop.ordering.internal;

import com.example.shop.notification.internal.SimulatedMailer;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.payment.internal.SimulatedRefundGateway;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.support.InlineEvents;
import com.example.shop.support.TestRedis;
import org.junit.jupiter.api.*;
import org.springframework.amqp.core.AmqpAdmin;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Properties;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * 7.12 端到端：真的 relay、真的 RabbitMQ、真的消費者。0.5.4 表格的右欄一格一格走過去。
 * 測試環境預設關掉 relay 與消費者（7.12.1），這個類別打開它們，結束時關掉 context（不讓它的消費者去吃別的測試的訊息）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false",
        "shop.messaging.relay-enabled=true", "shop.messaging.consumers-enabled=true"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class EventFlowTest {

    static final long BUYER = 990_711, SELLER = 2, NORMAL = 9_900_711, HOT = 9_900_712;
    static final Duration WAIT = Duration.ofSeconds(20);

    @Autowired OrderingApi ordering;
    @Autowired OrderCommands commands;
    @Autowired PaymentCallbackService callbacks;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired ShopProperties props;
    @Autowired SimulatedMailer mailer;
    @Autowired SimulatedRefundGateway gateway;
    @Autowired AmqpAdmin admin;
    @Autowired ApplicationContext ctx;

    @BeforeEach
    void setUp() {
        cleanup();
        InlineEvents.skipBacklog(ctx);
        com.example.shop.support.TestQueues.purgeConsumerQueues(ctx);
        mailer.reset();
        gateway.reset();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '事件一般', 100.00, 'ON_SALE', FALSE), (?, ?, 11, '事件熱點', 100.00, 'ON_SALE', TRUE)",
                NORMAL, SELLER, HOT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0), (?, 5, 0)", NORMAL, HOT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'ev'), (?, 5, 0, 'INITIAL', 'ev')", NORMAL, HOT);
    }

    @AfterEach
    void cleanup() {
        mailer.reset();
        jdbc.update("DELETE n FROM notifications n JOIN orders o ON o.id = n.payload->>'$.aggregateId' WHERE o.buyer_id BETWEEN ? AND ?", BUYER, BUYER + 99);
        jdbc.update("DELETE FROM notifications WHERE user_id BETWEEN ? AND ?", BUYER, BUYER + 99);
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id BETWEEN ? AND ?", BUYER, BUYER + 99);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 99);
        jdbc.update("DELETE FROM orders WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 99);
        for (long p : List.of(NORMAL, HOT)) {
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", p);
            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", p);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", p);
            jdbc.update("DELETE FROM products WHERE id = ?", p);
        }
        TestRedis.forgetProducts(redis, NORMAL, HOT);
    }

    OrderingApi.PlacedOrder place(long buyer, long product) {
        return ordering.placeOrder(buyer, "ev-" + buyer + "-" + System.nanoTime(), List.of(new OrderingApi.OrderLine(product, 1, new BigDecimal("100"))));
    }

    long pay(long buyer, String orderNo) {
        long pid = commands.startPayment(buyer, orderNo).paymentId();
        BigDecimal a = new BigDecimal("100.00");
        String txn = "txn-" + System.nanoTime();
        callbacks.handle(new PaymentApi.Callback(pid, txn, a, true,
                CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(pid, txn, a, true))));
        return pid;
    }

    /** 還沒有那一列 → null（await 的條件不能丟例外：Awaitility 會當成失敗） */
    String notification(long userId, String type) {
        return jdbc.queryForList("SELECT status FROM notifications WHERE user_id = ? AND type = ?", String.class, userId, type).stream().findFirst().orElse(null);
    }

    List<String> sentTypes(long userId, String orderNo) {
        return mailer.sent().stream().filter(s -> s.userId() == userId && (orderNo == null || s.text().contains(orderNo)))
                .map(SimulatedMailer.Sent::type).toList();
    }

    @Test @DisplayName("下單 → order.placed → 買家收到「訂單成立」（NTF-1 AC-1、AC-2）")
    void placedNotifies() {
        var o = place(BUYER, NORMAL);
        await().atMost(WAIT).until(() -> sentTypes(BUYER, o.orderNo()).contains("ORDER_PLACED"));
        Map<String, Object> n = jdbc.queryForMap("SELECT status, attempts, TIMESTAMPDIFF(MICROSECOND, created_at, sent_at) / 1000 AS ms FROM notifications WHERE user_id = ? AND type = 'ORDER_PLACED'", BUYER);
        System.out.println("NTF-1：下單 → 通知 " + n);
        assertThat(n.get("status")).isEqualTo("SENT");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = ? AND event_type = 'order.placed' AND published_at IS NOT NULL", Long.class, o.orderId())).isEqualTo(1);
    }

    @Test @DisplayName("7.6 熱點：下單交易只寫預留列；消費者在 commit 之後計入 reserved、記 RESERVE")
    void hotSettlesAfterCommit() {
        var o = place(BUYER, HOT);
        Map<String, Object> right = jdbc.queryForMap("SELECT r.counted, i.reserved FROM inventory_reservations r JOIN inventory i ON i.product_id = r.product_id WHERE r.order_id = ?", o.orderId());
        await().atMost(WAIT).until(() -> jdbc.queryForObject("SELECT counted FROM inventory_reservations WHERE order_id = ?", Boolean.class, o.orderId()));
        Map<String, Object> later = jdbc.queryForMap("""
                SELECT r.counted, i.reserved, (SELECT COUNT(*) FROM inventory_ledger WHERE product_id = ? AND reason = 'RESERVE') AS reserve_ledger
                  FROM inventory_reservations r JOIN inventory i ON i.product_id = r.product_id WHERE r.order_id = ?""", HOT, o.orderId());
        System.out.println("7.6：下單剛回來 " + right + " → 落帳之後 " + later + "；Redis stock = " + redis.opsForValue().get("stock:" + HOT));
        assertThat(right).containsEntry("counted", false).containsEntry("reserved", 0);
        assertThat(later).containsEntry("counted", true).containsEntry("reserved", 1).containsEntry("reserve_ledger", 1L);
    }

    @Test @DisplayName("0.5.4 PAID → CANCELLED：退款在 commit 之後呼叫金流（一次），買家收到付款、取消、退款三封；賣家收到新訂單")
    void cancelPaidRefunds() {
        var o = place(BUYER, NORMAL);
        long pid = pay(BUYER, o.orderNo());
        commands.cancelByBuyer(BUYER, o.orderNo());
        await().atMost(WAIT).until(() -> jdbc.queryForList("SELECT status FROM refunds WHERE order_id = ?", String.class, o.orderId()).contains("SUCCEEDED"));
        await().atMost(WAIT).until(() -> sentTypes(BUYER, null).contains("REFUND_SUCCEEDED"));
        await().atMost(WAIT).until(() -> sentTypes(SELLER, o.orderNo()).contains("NEW_ORDER"));
        System.out.println("0.5.4：退款 " + jdbc.queryForMap("SELECT status, attempts, provider_refund_id FROM refunds WHERE order_id = ?", o.orderId())
                + "；金流實際退款 " + gateway.moneyOutFor(pid) + " 次；買家的通知 " + sentTypes(BUYER, null) + "；賣家 " + sentTypes(SELLER, o.orderNo()));
        assertThat(gateway.moneyOutFor(pid)).isEqualTo(1);
        assertThat(sentTypes(BUYER, null)).containsExactlyInAnyOrder("ORDER_PLACED", "ORDER_PAID", "ORDER_CANCELLED", "REFUND_SUCCEEDED");
    }

    @Test @DisplayName("7.6.3 Redis 偏高：放進 3 張，MySQL 只有 1 件 → 1 張成立，2 張在落帳時被取消（E10），MySQL 沒有超賣")
    void shortageCancels() {
        jdbc.update("UPDATE inventory SET on_hand = 1 WHERE product_id = ?", HOT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, -4, 0, 'RESTOCK', 'ev-shrink')", HOT);
        redis.opsForValue().set("stock:" + HOT, "3");                       // Redis 偏高 2（6.5.3 的那個方向）
        List<OrderingApi.PlacedOrder> placed = List.of(place(BUYER, HOT), place(BUYER + 1, HOT), place(BUYER + 2, HOT));
        await().atMost(WAIT).until(() -> jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE buyer_id BETWEEN ? AND ? AND status = 'CANCELLED'", Long.class, BUYER, BUYER + 2) == 2);
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT o.order_no, o.status, o.cancel_reason, h.event, h.actor_type FROM orders o
                  LEFT JOIN order_status_history h ON h.order_id = o.id AND h.to_status = 'CANCELLED'
                 WHERE o.buyer_id BETWEEN ? AND ? ORDER BY o.id""", BUYER, BUYER + 2);
        rows.forEach(r -> System.out.println("7.6.3：" + r));
        assertThat(placed).hasSize(3);
        assertThat(jdbc.queryForObject("SELECT reserved FROM inventory WHERE product_id = ?", Integer.class, HOT)).isEqualTo(1);
        assertThat(rows.stream().filter(r -> "CANCELLED".equals(r.get("status"))))
                .allSatisfy(r -> assertThat(r).containsEntry("cancel_reason", "SELLER_OUT_OF_STOCK").containsEntry("event", "STOCK_SHORTAGE").containsEntry("actor_type", "SYSTEM"));
    }

    @Test @DisplayName("NTF-1 AC-4：SMTP 一直失敗 → 重試 5 次（指數退避）→ 死信、FAILED；下單不受影響")
    void mailerDownDeadLetters() {
        admin.purgeQueue("shop.notification.order-events.dlq", false);
        mailer.down(true);
        var o = place(BUYER, NORMAL);                                       // 下單照常
        await().atMost(WAIT).until(() -> "FAILED".equals(notification(BUYER, "ORDER_PLACED")));
        Properties q = admin.getQueueProperties("shop.notification.order-events.dlq");
        Map<String, Object> n = jdbc.queryForMap("SELECT status, attempts FROM notifications WHERE user_id = ? AND type = 'ORDER_PLACED'", BUYER);
        System.out.println("NTF-1 AC-4：" + n + "；死信佇列 " + q.get("QUEUE_MESSAGE_COUNT") + " 則；訂單 " + o.orderNo() + " 狀態 "
                + jdbc.queryForObject("SELECT status FROM orders WHERE id = ?", String.class, o.orderId()));
        assertThat(n).containsEntry("attempts", 6);                         // 第一次 + 重試 5 次
        assertThat(((Number) q.get("QUEUE_MESSAGE_COUNT")).intValue()).isEqualTo(1);
        admin.purgeQueue("shop.notification.order-events.dlq", false);
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/HotSettlementTest.java`**（7.5.2、7.5.4、7.6）

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderingApi;
import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.internal.EventDispatcher;
import com.example.shop.support.InlineEvents;
import com.example.shop.support.TestRedis;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 7.6 熱點落帳移出下單交易之後的幾條路：亂序（先取消、後落帳）、重複、出貨要等落帳、對帳要扣掉還沒計入的、落帳失敗之後不能出貨。
 * 事件用 InlineEvents 直接交付（7.12.1）：交付的時機由測試決定 —— 這幾條路要的正是「某件事比另一件事早到」。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
class HotSettlementTest {

    static final long HOT = 9_900_751, SELLER = 2, BUYER = 990_751;

    @Autowired OrderingApi ordering;
    @Autowired OrderCommands commands;
    @Autowired PaymentCallbackService callbacks;
    @Autowired ShopProperties props;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired EventDispatcher dispatcher;
    @Autowired ObjectMapper json;
    @Autowired ApplicationContext ctx;

    @BeforeEach
    void setUp() {
        cleanup();
        InlineEvents.skipBacklog(ctx);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '落帳測試', 100.00, 'ON_SALE', TRUE)", HOT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 5, 0)", HOT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 5, 0, 'INITIAL', 'settle-test')", HOT);
    }

    @AfterEach
    void cleanup() {
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM orders WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM products WHERE id = ?", HOT);
        TestRedis.forgetProducts(redis, HOT);
    }

    OrderingApi.PlacedOrder place(long buyer) {
        return ordering.placeOrder(buyer, "settle-" + buyer + "-" + System.nanoTime(), List.of(new OrderingApi.OrderLine(HOT, 1, new BigDecimal("100"))));
    }

    void pay(long buyer, String orderNo) {
        long pid = commands.startPayment(buyer, orderNo).paymentId();
        BigDecimal a = new BigDecimal("100.00");
        String txn = "settle-" + System.nanoTime();
        callbacks.handle(new PaymentApi.Callback(pid, txn, a, true, CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(pid, txn, a, true))));
    }

    /** 只交付某一種事件（其他的留在 outbox） */
    void deliver(long orderId, String type) {
        InlineEvents.deliver(ctx, r -> r.eventType().equals(type) && (r.aggregateId() == orderId || r.payload().contains(String.valueOf(HOT))));
    }

    Map<String, Object> state(long orderId) {
        return jdbc.queryForMap("""
                SELECT (SELECT reserved FROM inventory WHERE product_id = ?) AS reserved,
                       (SELECT status FROM inventory_reservations WHERE order_id = ?) AS reservation,
                       (SELECT counted + 0 FROM inventory_reservations WHERE order_id = ?) AS counted,
                       (SELECT COUNT(*) FROM inventory_ledger WHERE ref = CONCAT('order:', ?)) AS ledger""", HOT, orderId, orderId, orderId);
    }

    String redisStock() { return redis.opsForValue().get("stock:" + HOT); }

    @Test @DisplayName("亂序：取消比落帳先到 → 落帳什麼都不做；reserved 沒有被加過、也沒有被減過；Redis 加回")
    void cancelBeforeSettlement() {
        var o = place(BUYER);
        commands.cancelByBuyer(BUYER, o.orderNo());
        deliver(o.orderId(), "inventory.stock-returned");
        deliver(o.orderId(), "order.placed");                               // 遲到的落帳
        Map<String, Object> s = state(o.orderId());
        System.out.println("7.6 先取消、後落帳：" + s + "；Redis stock = " + redisStock());
        assertThat(s).containsEntry("reserved", 0).containsEntry("reservation", "RELEASED").containsEntry("counted", 0L).containsEntry("ledger", 0L);
        assertThat(redisStock()).isEqualTo("5");
    }

    @Test @DisplayName("同一則 order.placed 交付兩次 → 只計入一次（processed_messages）")
    void duplicateCountsOnce() throws Exception {
        var o = place(BUYER);
        Map<String, Object> row = jdbc.queryForMap("SELECT event_id, payload FROM outbox_events WHERE aggregate_id = ? AND event_type = 'order.placed'", o.orderId());
        Event e = new Event((String) row.get("event_id"), "order.placed", "ORDER", o.orderId(), Instant.now(), json.readTree((String) row.get("payload")), 1);
        EventHandler settlement = ctx.getBeansOfType(EventHandler.class).values().stream().filter(h -> h.consumer().equals("inventory.hot-settlement")).findFirst().orElseThrow();
        var first = dispatcher.dispatch(settlement, e);
        var second = dispatcher.dispatch(settlement, e);
        System.out.println("7.5.2 同一則交付兩次：" + first + "、" + second + "；" + state(o.orderId()));
        assertThat(first).isEqualTo(EventDispatcher.Outcome.PROCESSED);
        assertThat(second).isEqualTo(EventDispatcher.Outcome.DUPLICATE);
        assertThat(state(o.orderId())).containsEntry("reserved", 1).containsEntry("counted", 1L).containsEntry("ledger", 1L);
    }

    @Test @DisplayName("7.6.4 落帳還沒完成 → 出貨 503；完成之後可以出貨，onHand 與 reserved 一起減")
    void shipWaitsForSettlement() {
        var o = place(BUYER);
        pay(BUYER, o.orderNo());
        commands.startPicking(SELLER, o.orderNo());
        assertThatThrownBy(() -> commands.ship(SELLER, o.orderNo(), "黑貓", "T-1"))
                .satisfies(e -> assertThat(((ShopException) e).type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE));
        deliver(o.orderId(), "order.placed");
        commands.ship(SELLER, o.orderNo(), "黑貓", "T-1");
        Map<String, Object> inv = jdbc.queryForMap("SELECT on_hand, reserved FROM inventory WHERE product_id = ?", HOT);
        System.out.println("7.6.4 落帳之後出貨：" + inv + "；預留 " + state(o.orderId()).get("reservation"));
        assertThat(inv).containsEntry("on_hand", 4).containsEntry("reserved", 0);
    }

    @Test @DisplayName("7.6.2 對帳：Redis 該是多少，要扣掉還沒計入的熱點預留 —— 不扣的話，對帳會把它們再放出去一次")
    void reconcileSubtractsUncounted() throws Exception {
        place(BUYER);
        place(BUYER + 1);                                                   // 兩張，都還沒落帳
        assertThat(redisStock()).isEqualTo("3");
        redis.opsForValue().set("stock:" + HOT, "99");                     // 模擬 Redis 漂掉了
        Object hot = ctx.getBean(Class.forName("com.example.shop.inventory.internal.HotStock"));
        var reconcile = hot.getClass().getDeclaredMethod("reconcile");
        reconcile.setAccessible(true);
        reconcile.invoke(hot);
        reconcile.invoke(hot);
        Map<String, Object> inv = jdbc.queryForMap("SELECT on_hand, reserved FROM inventory WHERE product_id = ?", HOT);
        System.out.println("7.6.2 對帳：MySQL " + inv + "、未計入 2 → Redis " + redisStock() + "（只看 on_hand - reserved 會是 5）");
        assertThat(redisStock()).isEqualTo("3");
    }

    @Test @DisplayName("7.6.3 落帳發現不夠 → 那一列 RELEASED；取消的事件還沒到之前，賣家出貨 → 409；事件到了 → 取消、退款")
    void shortageBlocksShipThenCancels() {
        var o = place(BUYER);
        pay(BUYER, o.orderNo());
        commands.startPicking(SELLER, o.orderNo());
        jdbc.update("UPDATE inventory SET on_hand = 0 WHERE product_id = ?", HOT);   // 模擬：Redis 放進了 MySQL 沒有的庫存
        deliver(o.orderId(), "order.placed");
        assertThat(state(o.orderId())).containsEntry("reservation", "RELEASED").containsEntry("counted", 0L);
        assertThatThrownBy(() -> commands.ship(SELLER, o.orderNo(), "黑貓", "T-2"))
                .satisfies(e -> assertThat(((ShopException) e).type()).isEqualTo(ProblemType.INVALID_STATE));
        deliver(o.orderId(), "inventory.hot-settlement-failed");
        Map<String, Object> order = jdbc.queryForMap("""
                SELECT o.status, o.cancel_reason, (SELECT reason FROM refunds WHERE order_id = o.id) AS refund
                  FROM orders o WHERE o.id = ?""", o.orderId());
        System.out.println("7.6.3 落帳失敗：出貨被擋 → 取消 " + order);
        assertThat(order).containsEntry("status", "CANCELLED").containsEntry("cancel_reason", "SELLER_OUT_OF_STOCK").containsEntry("refund", "SELLER_CANCEL");
    }
}
```

**`src/test/java/com/example/shop/api/DeadLetterReplayTest.java`**（7.5.5）

```java
package com.example.shop.api;

import com.example.shop.notification.internal.SimulatedMailer;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
import com.example.shop.support.InlineEvents;
import com.example.shop.support.TestRedis;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.AmqpAdmin;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * 7.5.5 死信的經營：SMTP 一直失敗 → 重試用完 → 死信、通知 FAILED；SMTP 修好 → 管理員把死信放回原佇列 → 寄出、SENT。
 * 真的 relay、真的 RabbitMQ（7.12.1：這個類別打開它們，結束時關掉 context）。
 */
@SpringBootTest(properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false",
        "shop.messaging.relay-enabled=true", "shop.messaging.consumers-enabled=true"})
@AutoConfigureMockMvc
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class DeadLetterReplayTest {

    static final long BUYER = 990_771, PRODUCT = 9_900_771, ADMIN = 990_779;
    static final String DLQ = "shop.notification.order-events.dlq";

    @Autowired MockMvc mvc;
    @Autowired OrderingApi ordering;
    @Autowired SimulatedMailer mailer;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired AccessTokens tokens;
    @Autowired AmqpAdmin admin;
    @Autowired ApplicationContext ctx;

    @BeforeEach
    void setUp() {
        cleanup();
        InlineEvents.skipBacklog(ctx);
        com.example.shop.support.TestQueues.purgeConsumerQueues(ctx);
        admin.purgeQueue(DLQ, false);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '死信測試', 100.00, 'ON_SALE')", PRODUCT);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", PRODUCT);
    }

    @AfterEach
    void cleanup() {
        mailer.reset();
        jdbc.update("DELETE FROM notifications WHERE user_id = ?", BUYER);
        jdbc.update("DELETE FROM audit_logs WHERE actor_id = ? AND action = 'DEAD_LETTERS_REPLAYED'", ADMIN);
        for (String t : List.of("order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
        TestRedis.forgetProducts(redis, PRODUCT);
    }

    String status() {                                                       // 還沒有那一列 → null（await 的條件不能丟例外）
        return jdbc.queryForList("SELECT status FROM notifications WHERE user_id = ? AND type = 'ORDER_PLACED'", String.class, BUYER).stream().findFirst().orElse(null);
    }

    @Test @DisplayName("SMTP 掛了 → 死信 → 修好之後由管理員重放 → 寄出；重放寫稽核")
    void replayAfterFix() throws Exception {
        com.example.shop.support.TestQueues.purgeDeadLettersWhenQuiet(ctx, DLQ);   // 這個測試要數死信：先等別的測試留下的落定
        mailer.down(true);
        ordering.placeOrder(BUYER, "dlq-key", List.of(new OrderingApi.OrderLine(PRODUCT, 1, new BigDecimal("100"))));
        await().atMost(Duration.ofSeconds(30)).until(() -> "FAILED".equals(status()));
        String bearer = TestTokens.bearer(tokens, ADMIN, Role.ADMIN);
        String listed = mvc.perform(get("/api/admin/dead-letters").header("Authorization", bearer)).andReturn().getResponse().getContentAsString();

        mailer.down(false);                                                 // 先修好原因，再重放（10.5.2：不然 31 秒後它會回到這裡）
        var replay = mvc.perform(post("/api/admin/dead-letters/notification.order-events/replay").header("Authorization", bearer)).andReturn().getResponse();
        await().atMost(Duration.ofSeconds(30)).until(() -> "SENT".equals(status()));
        var buyerTries = mvc.perform(post("/api/admin/dead-letters/notification.order-events/replay").header("Authorization", TestTokens.bearer(tokens, BUYER)))
                .andReturn().getResponse().getStatus();
        long audits = jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE actor_id = ? AND action = 'DEAD_LETTERS_REPLAYED'", Long.class, ADMIN);
        System.out.println("7.5.5：死信 " + listed.replaceAll(".*(\\{[^}]*notification[^}]*}).*", "$1") + " → 重放 HTTP " + replay.getStatus() + " "
                + replay.getContentAsString() + " → 通知 " + status() + "；買家打重放 → " + buyerTries + "；稽核 " + audits + " 筆");
        assertThat(listed).contains("\"consumer\":\"notification.order-events\",\"queue\":\"" + DLQ + "\",\"messages\":1}");
        assertThat(replay.getStatus()).isEqualTo(200);
        assertThat(replay.getContentAsString()).contains("\"replayed\":1");
        assertThat(buyerTries).isEqualTo(403);
        assertThat(audits).isEqualTo(1);
    }

    @Test @DisplayName("不存在的消費者 → 404")
    void unknownConsumer() throws Exception {
        int s = mvc.perform(post("/api/admin/dead-letters/nobody/replay").header("Authorization", TestTokens.bearer(tokens, ADMIN, Role.ADMIN)))
                .andReturn().getResponse().getStatus();
        assertThat(s).isEqualTo(404);
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/HotStockFlowTest.java`**（節錄：`deliverEvents()`；各測試在原本的斷言之間呼叫它，見 7.6.5）

```java
    /** 這個測試的訂單、以及這個商品的事件，交給消費者（7.6） */
    void deliverEvents() {
        List<Long> orders = jdbc.queryForList("SELECT id FROM orders WHERE buyer_id BETWEEN ? AND ?", Long.class, BUYER, BUYER + 99);
        InlineEvents.deliver(ctx, r -> orders.contains(r.aggregateId()) && r.aggregateType().equals("ORDER")
                || r.payload().contains("\"productId\": " + HOT) || r.payload().contains("\"productId\":" + HOT));
    }
```

**`src/test/java/com/example/shop/ch04/E7FlashSaleLoadTest.java`**（7.6.6：打開 relay 與消費者、等落帳完成）

```java
package com.example.shop.ch04;

import com.example.shop.support.TestTokens;

import com.example.shop.ShopApplication;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 4.8 US-ORD-1b AC-2：2,000 個買家搶 500 件，打真的 HTTP API（完整的下單交易：冪等鍵、價格比對、預留、明細、歷史、清購物車）。
 * 200 個並行的客戶端（≈ Tomcat 預設的 200 條執行緒）。平台執行緒 vs 虛擬執行緒（0.9.2 ⑤ 的實驗變數）。
 */
@Tag("experiment")
public class E7FlashSaleLoadTest {

    static final long HOT = 9_900_701;
    static final int STOCK = 500, BUYERS = 2_000, CLIENTS = 200;
    static final long FIRST_BUYER = 3_000_000;

    /** settledMs：第 07 章 —— 最後一個回應之後，再過多久熱點預留才全部計入 reserved（7.6；第 04、06 章的路徑永遠是 0） */
    public record Run(Map<Integer, Integer> statuses, double p50, double p95, double p99, double max, double seconds,
               int reserved, long orders, long ledger, int maxActive, int maxPending, Map<Integer, Integer> retried, long settledMs) {}

    /**
     * @param rps 0：封閉式負載（CLIENTS 個客戶端各自「送完一個、馬上送下一個」，量的是飽和時的樣子）。
     *            > 0：開放式負載（0.6.2 的寫法：每秒 rps 個請求，不管前面的回來了沒有）。延遲從「預定送出的時間」算起，
     *            否則系統變慢時送出的時間也跟著延後，p99 會被低估（coordinated omission）。
     */
    /** 第 04 章：商品不是熱點（hot = false），下單走 MySQL 的條件式 UPDATE。第 06 章的 G6 用 hot = true 重跑 */
    static Run flashSale(boolean virtualThreads, int rps) throws Exception {
        return flashSale(virtualThreads, rps, false);
    }

    public static Run flashSale(boolean virtualThreads, int rps, boolean hot) throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0",
                "--shop.order.jobs-enabled=false", "--spring.threads.virtual.enabled=" + virtualThreads,
                // 第 07 章：relay 與消費者打開 —— 這才是第 07 章之後的系統（熱點的落帳、每一張訂單的通知都在背景跑）
                "--shop.messaging.relay-enabled=true", "--shop.messaging.consumers-enabled=true",
                "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            redis = ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class);
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            var hikari = (com.zaxxer.hikari.HikariDataSource) ctx.getBean(javax.sql.DataSource.class);
            cleanup(jdbc);
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '限量商品', 1990.00, 'ON_SALE', ?)", HOT, hot);
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", HOT, STOCK);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, 0, 'INITIAL', 'e7')", HOT, STOCK);

            HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(CLIENTS)).build();
            ExecutorService clients = rps > 0 ? Executors.newCachedThreadPool() : Executors.newFixedThreadPool(CLIENTS);
            ConcurrentHashMap<Integer, AtomicInteger> statuses = new ConcurrentHashMap<>();
            ConcurrentLinkedQueue<Long> lat = new ConcurrentLinkedQueue<>();
            ConcurrentLinkedQueue<HttpRequest> unavailable = new ConcurrentLinkedQueue<>();
            AtomicInteger maxActive = new AtomicInteger(), maxPending = new AtomicInteger();
            ScheduledExecutorService sampler = Executors.newSingleThreadScheduledExecutor();
            sampler.scheduleAtFixedRate(() -> {                               // 連線池的使用狀況（0.6.6 的 hikaricp.connections.pending）
                maxActive.accumulateAndGet(hikari.getHikariPoolMXBean().getActiveConnections(), Math::max);
                maxPending.accumulateAndGet(hikari.getHikariPoolMXBean().getThreadsAwaitingConnection(), Math::max);
            }, 0, 5, TimeUnit.MILLISECONDS);
            CountDownLatch go = new CountDownLatch(1);
            List<Future<?>> fs = new ArrayList<>();
            long[] start = new long[1];                                       // 開放式：第 i 個請求預定在 start + i / rps 秒送出
            for (int i = 0; i < BUYERS; i++) {
                long buyer = FIRST_BUYER + i;
                long offset = rps > 0 ? i * 1_000_000_000L / rps : 0;
                fs.add(clients.submit(() -> {
                    go.await();
                    long due = start[0] + offset;
                    if (rps > 0) { long wait = due - System.nanoTime(); if (wait > 0) TimeUnit.NANOSECONDS.sleep(wait); }
                    HttpRequest req = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/orders"))
                            .header("Authorization", TestTokens.bearer(ctx, buyer)).header("Content-Type", "application/json")
                            .header("Idempotency-Key", "e7-" + buyer)
                            .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + HOT + ",\"quantity\":1,\"unitPrice\":1990}]}"))
                            .build();
                    long s = rps > 0 ? due : System.nanoTime();
                    int status = http.send(req, HttpResponse.BodyHandlers.discarding()).statusCode();
                    lat.add(System.nanoTime() - s);
                    statuses.computeIfAbsent(status, k -> new AtomicInteger()).incrementAndGet();
                    if (status == 503) unavailable.add(req);                  // 照 Retry-After 的意思：之後用同一個鍵再送一次
                    return null;
                }));
            }
            long t0 = System.nanoTime();
            start[0] = t0;
            go.countDown();
            for (Future<?> f : fs) f.get();
            double secs = (System.nanoTime() - t0) / 1e9;
            sampler.shutdown();
            clients.shutdown();
            Map<Integer, Integer> retried = new TreeMap<>();                   // 503 的那些請求，一秒後用同一個 Idempotency-Key 重送
            if (!unavailable.isEmpty()) Thread.sleep(1000);
            for (HttpRequest req : unavailable) retried.merge(http.send(req, HttpResponse.BodyHandlers.discarding()).statusCode(), 1, Integer::sum);
            long settleStart = System.nanoTime();                            // 7.6：熱點預留全部計入 reserved 為止（最多等 120 秒）
            while (jdbc.queryForObject("SELECT COUNT(*) FROM inventory_reservations WHERE product_id = ? AND counted = FALSE AND status IN ('HELD', 'CONFIRMED')",
                    Long.class, HOT) > 0 && System.nanoTime() - settleStart < 120_000_000_000L) Thread.sleep(20);
            long settledMs = (System.nanoTime() - settleStart) / 1_000_000;
            var admin = ctx.getBean(org.springframework.amqp.core.AmqpAdmin.class);   // 下一輪開始之前，這一輪的通知要寄完（不然算到下一輪頭上）
            for (int i = 0; i < 300; i++) {
                var info = admin.getQueueInfo("shop.notification.order-events");
                if (info == null || info.getMessageCount() == 0) break;
                Thread.sleep(100);
            }
            long[] a = lat.stream().mapToLong(Long::longValue).sorted().toArray();
            Map<Integer, Integer> st = new TreeMap<>();
            statuses.forEach((k, v) -> st.put(k, v.get()));
            Run r = new Run(st, a[a.length / 2] / 1e6, a[(int) (a.length * 0.95)] / 1e6, a[(int) (a.length * 0.99)] / 1e6, a[a.length - 1] / 1e6, secs,
                    jdbc.queryForObject("SELECT reserved FROM inventory WHERE product_id = ?", Integer.class, HOT),
                    jdbc.queryForObject("SELECT COUNT(*) FROM order_items WHERE product_id = ?", Long.class, HOT),
                    jdbc.queryForObject("SELECT COUNT(*) FROM inventory_ledger WHERE product_id = ? AND reason = 'RESERVE'", Long.class, HOT),
                    maxActive.get(), maxPending.get(), retried, settledMs);
            cleanup(jdbc);
            return r;
        }
    }

    static org.springframework.data.redis.core.StringRedisTemplate redis;

    static void cleanup(JdbcTemplate jdbc) {
        // 第 07 章：每一張訂單都會寄通知（買家、付款後還有賣家）—— 先刪，要靠 orders 找到賣家那幾封
        jdbc.update("DELETE n FROM notifications n JOIN orders o ON o.id = n.payload->>'$.aggregateId' WHERE o.buyer_id >= ? AND o.buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        jdbc.update("DELETE FROM notifications WHERE user_id >= ? AND user_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        jdbc.update("DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM products WHERE id = ?", HOT);
        if (redis != null) com.example.shop.support.TestRedis.forgetProducts(redis, HOT);
    }

    @Test
    void flashSale() throws Exception {
        flashSale(false, 0);                                                 // 暖機（JIT、連線池、buffer pool）
        System.out.printf("═══ 4.8 搶購：%,d 個買家搶 %d 件，%d 個並行的客戶端，打真的 POST /api/orders ═══%n", BUYERS, STOCK, CLIENTS);
        for (boolean vt : new boolean[]{false, true, false, true}) print(vt, flashSale(vt, 0));
        System.out.printf("═══ 4.8 同樣 %,d 個買家，改成 0.6.2 的負載：每秒 200 個請求、10 秒（開放式）═══%n", BUYERS);
        for (boolean vt : new boolean[]{false, true, false, true}) print(vt, flashSale(vt, 200));
    }

    static void print(boolean vt, Run r) {
        System.out.printf("  %-8s HTTP %s │ %.2f 秒 │ p50 %5.0f  p95 %5.0f  p99 %5.0f  最慢 %5.0f ms │ reserved=%d 明細=%d RESERVE 帳=%d │ 連線池：同時使用最多 %d、等待最多 %d%n",
                    vt ? "虛擬執行緒" : "平台執行緒", r.statuses(), r.seconds(), r.p50(), r.p95(), r.p99(), r.max(),
                r.reserved(), r.orders(), r.ledger(), r.maxActive(), r.maxPending());
        if (!r.retried().isEmpty()) System.out.printf("  %-8s   └ 503 的 %d 個請求，1 秒後用同一個 Idempotency-Key 重送 → HTTP %s%n", "",
                r.retried().values().stream().mapToInt(Integer::intValue).sum(), r.retried());
    }
}
```

#### 驗收 Q9～Q11

**`src/test/java/com/example/shop/acceptance/CapstoneAcceptanceTest.java`**（節錄：檔案最後的第 07 章那一段；`product()`、`startApp()`、`placeOrder()`、`http()`、`cleanupBuyersAndProducts()` 是前幾章就有的）

```java
    // ───────── 第 07 章：Q9～Q11 ─────────

    /** 用 SQL 建一個熱點商品（庫存 stock），Redis 的閘門留給第一張訂單去建（6.5.1） */
    static void hotProduct(JdbcTemplate jdbc, long id, int stock) {
        product(jdbc, id, stock);
        jdbc.update("UPDATE products SET hot = TRUE WHERE id = ?", id);
    }

    static Map<String, Object> settlement(JdbcTemplate jdbc, long orderId, long product) {
        return jdbc.queryForMap("""
                SELECT (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = ? AND event_type = 'order.placed' AND published_at IS NULL) AS unpublished,
                       (SELECT counted + 0 FROM inventory_reservations WHERE order_id = ?)                                                   AS counted,
                       (SELECT reserved FROM inventory WHERE product_id = ?)                                                                 AS reserved,
                       (SELECT COUNT(*) FROM inventory_ledger WHERE product_id = ? AND reason = 'RESERVE')                                  AS reserve_ledger""",
                orderId, orderId, product, product);
    }

    static ConfigurableApplicationContext startAppWithEvents() {
        ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--shop.order.jobs-enabled=false",
                "--shop.inventory.jobs-enabled=false", "--shop.messaging.relay-enabled=true", "--shop.messaging.consumers-enabled=true",
                "--spring.main.banner-mode=off", "--logging.level.root=WARN");
        tokens = ctx.getBean(AccessTokens.class);
        redis = ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class);
        return ctx;
    }

    static void cleanupEvents(JdbcTemplate jdbc, List<Long> buyers) {
        for (long b : buyers) {
            jdbc.update("DELETE n FROM notifications n JOIN orders o ON o.id = n.payload->>'$.aggregateId' WHERE o.buyer_id = ?", b);
            jdbc.update("DELETE FROM notifications WHERE user_id = ?", b);
        }
    }

    @Test
    @DisplayName("Q9 訂單 commit 後、訊息送出前程序被殺：重啟後訊息仍送出，庫存最終被扣")
    void q9_outboxSurvivesCrash() throws Exception {
        long hot = 9_900_901L, buyer = 990_901;
        try (var observer = startApp()) {                                   // 只用來拿 JdbcTemplate 與簽 JWT：relay、消費者都是關的（7.12.1）
            JdbcTemplate jdbc = observer.getBean(JdbcTemplate.class);
            try {
                cleanupEvents(jdbc, List.of(buyer));
                cleanupBuyersAndProducts(jdbc, List.of(buyer), List.of(hot));
                hotProduct(jdbc, hot, 5);

                // ① 另一個 JVM：同一份程式，relay 每 1 小時才跑一輪 —— 訂單 commit 了，outbox 那一列還沒輪到
                int port;
                try (var s = new java.net.ServerSocket(0)) { port = s.getLocalPort(); }
                Path log = Path.of("target/q9-child.log");
                Process child = new ProcessBuilder(ProcessHandle.current().info().command().orElse("java"), "-cp", System.getProperty("java.class.path"),
                        ShopApplication.class.getName(), "--server.port=" + port, "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false",
                        "--shop.messaging.relay-enabled=true", "--shop.messaging.relay-interval=1h", "--shop.messaging.consumers-enabled=false",
                        "--spring.main.banner-mode=off", "--logging.level.root=WARN")
                        .redirectErrorStream(true).redirectOutput(log.toFile()).start();
                for (int i = 0; i < 120; i++) {
                    try { if (http(port, "GET", "/api/ping", null, null).statusCode() == 200) break; } catch (java.io.IOException notYet) { }
                    Thread.sleep(500);
                }
                Http r = placeOrder(port, buyer, "q9-key", "[{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]".formatted(hot));
                long orderId = jdbc.queryForObject("SELECT id FROM orders WHERE order_no = ?", Long.class, r.orderNo());
                Map<String, Object> before = settlement(jdbc, orderId, hot);
                System.out.println("Q9：子行程（pid " + child.pid() + "，relay 每 1 小時一輪）下單 → HTTP " + r.status() + " " + r.orderNo() + "；" + before);

                // ② kill -9：不給它任何收尾的機會（沒有 shutdown hook、沒有 SmartLifecycle.stop）
                new ProcessBuilder("kill", "-9", String.valueOf(child.pid())).start().waitFor();
                int exit = child.waitFor();
                Map<String, Object> afterKill = settlement(jdbc, orderId, hot);
                System.out.println("Q9：kill -9 → exit " + exit + "；" + afterKill);

                // ③ 重啟：一般的設定（relay 每 100 ms、消費者打開）
                // 測試環境：別的測試類別留下、沒有送出的事件（它們的資料早就刪掉了，7.12.1）先標成已送出 —— 只留這一張訂單的
                jdbc.update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL AND NOT (aggregate_type = 'ORDER' AND aggregate_id = ?)", orderId);
                long t0 = System.nanoTime();
                try (var restarted = startAppWithEvents()) {
                    await().atMost(java.time.Duration.ofSeconds(30)).until(() -> ((Number) settlement(jdbc, orderId, hot).get("counted")).intValue() == 1);
                    long ms = (System.nanoTime() - t0) / 1_000_000;
                    Map<String, Object> after = settlement(jdbc, orderId, hot);
                    await().atMost(java.time.Duration.ofSeconds(30)).until(() -> jdbc.queryForObject(
                            "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND type = 'ORDER_PLACED' AND status = 'SENT'", Long.class, buyer) == 1);
                    System.out.println("Q9：重啟（含啟動）" + ms + " ms 後 → " + after + "；買家的「訂單成立」通知已寄出");
                    assertThat(r.status()).isEqualTo(201);
                    assertThat(before).containsEntry("unpublished", 1L).containsEntry("counted", 0L).containsEntry("reserved", 0);
                    assertThat(exit).isEqualTo(137);                        // 128 + SIGKILL(9)
                    assertThat(afterKill).containsEntry("unpublished", 1L);
                    assertThat(after).containsEntry("unpublished", 0L).containsEntry("counted", 1L).containsEntry("reserved", 1).containsEntry("reserve_ledger", 1L);
                }
            } finally {
                redis = observer.getBean(org.springframework.data.redis.core.StringRedisTemplate.class);   // 重啟的那一個已經關掉了
                cleanupEvents(jdbc, List.of(buyer));
                cleanupBuyersAndProducts(jdbc, List.of(buyer), List.of(hot));
            }
        }
    }

    @Test
    @DisplayName("Q10 同一則 OrderPlaced 投遞 10 次：庫存只扣 1 次")
    void q10_idempotentConsumer() throws Exception {
        long hot = 9_901_001L, buyer = 991_001;
        // relay 關著：這一則 order.placed 由測試自己送 10 次（同一個 eventId），不讓 relay 先送掉第 11 次
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--shop.order.jobs-enabled=false",
                "--shop.inventory.jobs-enabled=false", "--shop.messaging.relay-enabled=false", "--shop.messaging.consumers-enabled=true",
                "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            tokens = ctx.getBean(AccessTokens.class);
            redis = ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class);
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            var rabbit = ctx.getBean(org.springframework.amqp.rabbit.core.RabbitTemplate.class);
            var meters = ctx.getBean(io.micrometer.core.instrument.MeterRegistry.class);
            try {
                cleanupEvents(jdbc, List.of(buyer));
                cleanupBuyersAndProducts(jdbc, List.of(buyer), List.of(hot));
                hotProduct(jdbc, hot, 5);
                Http r = placeOrder(port, buyer, "q10-key", "[{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]".formatted(hot));
                long orderId = jdbc.queryForObject("SELECT id FROM orders WHERE order_no = ?", Long.class, r.orderNo());
                Map<String, Object> row = jdbc.queryForMap("SELECT event_id, payload, created_at FROM outbox_events WHERE aggregate_id = ? AND event_type = 'order.placed'", orderId);
                String eventId = (String) row.get("event_id");
                // 跟 relay 送出去的一模一樣的訊息（7.4.2 的信封）
                String body = "{\"eventId\":\"%s\",\"type\":\"order.placed\",\"aggregateType\":\"ORDER\",\"aggregateId\":%d,\"occurredAt\":\"%s\",\"payload\":%s}"
                        .formatted(eventId, orderId, ((java.time.LocalDateTime) row.get("created_at")).toInstant(java.time.ZoneOffset.UTC), row.get("payload"));
                var props = new org.springframework.amqp.core.MessageProperties();
                props.setMessageId(eventId);
                props.setContentType("application/json");
                var message = new org.springframework.amqp.core.Message(body.getBytes(java.nio.charset.StandardCharsets.UTF_8), props);

                var pool = java.util.concurrent.Executors.newFixedThreadPool(10);
                var go = new java.util.concurrent.CountDownLatch(1);
                for (int i = 0; i < 10; i++) pool.submit(() -> { go.await(); rabbit.send("shop.events", "order.placed", message); return null; });
                go.countDown();
                pool.shutdown();
                pool.awaitTermination(10, java.util.concurrent.TimeUnit.SECONDS);

                java.util.function.Supplier<Double> dup = () -> java.util.Optional.ofNullable(meters.find("shop.events.duplicates")
                        .tag("consumer", "inventory.hot-settlement").counter()).map(c -> c.count()).orElse(0.0);
                await().atMost(java.time.Duration.ofSeconds(30)).until(() -> dup.get() >= 9);
                Thread.sleep(1000);
                Map<String, Object> result = jdbc.queryForMap("""
                        SELECT (SELECT reserved FROM inventory WHERE product_id = ?)                                          AS reserved,
                               (SELECT COUNT(*) FROM inventory_ledger WHERE product_id = ? AND reason = 'RESERVE')            AS reserve_ledger,
                               (SELECT COUNT(*) FROM processed_messages WHERE consumer = 'inventory.hot-settlement' AND message_id = ?) AS processed,
                               (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND type = 'ORDER_PLACED')               AS notifications,
                               (SELECT attempts FROM notifications WHERE user_id = ? AND type = 'ORDER_PLACED')               AS notification_attempts""",
                        hot, hot, eventId, buyer, buyer);
                System.out.println("Q10：同一則 order.placed（eventId " + eventId.substring(0, 8) + "…）同時送 10 次 → 落帳的消費者處理 1 次、擋下重複 "
                        + dup.get().intValue() + " 次；" + result);
                assertThat(result).containsEntry("reserved", 1).containsEntry("reserve_ledger", 1L).containsEntry("processed", 1L)
                        .containsEntry("notifications", 1L).containsEntry("notification_attempts", 1);
                assertThat(dup.get()).isEqualTo(9.0);
            } finally {
                cleanupEvents(jdbc, List.of(buyer));
                cleanupBuyersAndProducts(jdbc, List.of(buyer), List.of(hot));
            }
        }
    }

    @Test
    @DisplayName("Q11 broker 相關程式碼只出現在 messaging adapter 套件（ArchUnit 檢查）")
    void q11_brokerIsolated() {
        var classes = new com.tngtech.archunit.core.importer.ClassFileImporter()
                .withImportOption(com.tngtech.archunit.core.importer.ImportOption.Predefined.DO_NOT_INCLUDE_TESTS).importPackages("com.example.shop");
        // ① 第 01 章就寫好的規則（ModuleBoundaryTest.broker_is_isolated）
        com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses().that().resideOutsideOfPackage("com.example.shop.shared.messaging..")
                .should().dependOnClassesThat().resideInAnyPackage("org.springframework.amqp..", "com.rabbitmq..").check(classes);
        // ② 而且它不是「因為沒有人用 broker」才通過的：列出真的用到 broker 的類別
        java.util.Set<String> brokerUsers = new TreeSet<>();
        for (var c : classes)
            if (c.getDirectDependenciesFromSelf().stream().anyMatch(d -> d.getTargetClass().getPackageName().startsWith("org.springframework.amqp")
                    || d.getTargetClass().getPackageName().startsWith("com.rabbitmq")))
                brokerUsers.add(c.getName().replaceAll("\\$.*", ""));
        // ③ 模組也不直接依賴 adapter：它們只認得 shared.events（Outbox、EventHandler）—— 換 broker，模組一行都不用改
        java.util.Set<String> adapterUsers = new TreeSet<>();
        for (var c : classes)
            if (!c.getPackageName().startsWith("com.example.shop.shared.messaging")
                    && c.getDirectDependenciesFromSelf().stream().anyMatch(d -> d.getTargetClass().getPackageName().startsWith("com.example.shop.shared.messaging")))
                adapterUsers.add(c.getName());
        long handlers = classes.stream().filter(c -> c.isAssignableTo(com.example.shop.shared.events.EventHandler.class) && !c.isInterface()).count();
        System.out.println("Q11：用到 broker 的類別 " + brokerUsers.size() + " 個 " + brokerUsers + "；shared.messaging 以外依賴 adapter 的類別 "
                + adapterUsers.size() + " 個；實作 EventHandler 的類別 " + handlers + " 個");
        assertThat(brokerUsers).isNotEmpty().allMatch(n -> n.startsWith("com.example.shop.shared.messaging."));
        assertThat(adapterUsers).isEmpty();
    }
}
```

#### 實驗 H1～H9

**`src/test/java/com/example/shop/inventory/internal/H1LostSettlementTest.java`**（7.2.1）

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.support.TestRedis;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.*;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.rabbit.listener.SimpleMessageListenerContainer;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 7.2.1 熱點商品的 MySQL 預留要移出下單交易（6.5.4 留下的 p99）。第一個想到的寫法：
 *   naive：閘門 → 下單交易只寫訂單（不碰庫存）→ commit 之後送一則「請落帳」→ 消費者 reserved += 1
 *   ours ：閘門 → 下單交易寫訂單 + 預留列（counted = FALSE）+ Outbox → relay → 消費者計入（7.6）
 *
 * 同一個情境：庫存 100 件；第一波 100 人（每秒 20 張），RabbitMQ 在第 1 秒停掉、停 10 秒；
 * 恢復後讓第 06 章的對帳（6.6，正式的 HotStock.reconcile）跑兩輪；第二波再來 100 人。
 * 量：最後成立的訂單有幾張、MySQL 的 reserved 是多少。
 */
@Tag("experiment")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false",
        "shop.messaging.relay-enabled=true", "shop.messaging.consumers-enabled=true"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class H1LostSettlementTest {

    static final long NAIVE = 9_907_101, OURS = 9_907_102, SELLER = 2, FIRST_BUYER = 3_710_000;
    static final int STOCK = 100;
    static final String LAB_X = "lab.h1", LAB_Q = "lab.h1.settle";

    @Autowired OrderingApi ordering;
    @Autowired InventoryApi inventory;
    @Autowired HotStock hot;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired RabbitTemplate rabbit;
    @Autowired ConnectionFactory cf;
    @Autowired AmqpAdmin admin;
    @Autowired PlatformTransactionManager tm;

    record Wave(Map<String, Integer> outcomes) {}

    static void docker(String... args) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("docker"));
        cmd.addAll(List.of(args));
        new ProcessBuilder(cmd).redirectErrorStream(true).start().waitFor();
    }

    static void waitRabbit() throws Exception {
        for (int i = 0; i < 120; i++) {
            Process p = new ProcessBuilder("docker", "exec", "shop-rabbitmq-1", "rabbitmq-diagnostics", "-q", "check_port_connectivity").redirectErrorStream(true).start();
            if (p.waitFor() == 0) return;
            Thread.sleep(1000);
        }
        throw new IllegalStateException("RabbitMQ 沒有回來");
    }

    void setUpProduct(long id) {
        cleanup(id);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, 'H1', 100.00, 'ON_SALE', TRUE)", id, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", id, STOCK);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, 0, 'INITIAL', 'h1')", id, STOCK);
    }

    void cleanup(long product) {
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id BETWEEN ? AND ?", FIRST_BUYER, FIRST_BUYER + 9_999);
        jdbc.update("DELETE n FROM notifications n WHERE n.user_id BETWEEN ? AND ?", FIRST_BUYER, FIRST_BUYER + 9_999);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id BETWEEN ? AND ?", FIRST_BUYER, FIRST_BUYER + 9_999);
        jdbc.update("DELETE FROM orders WHERE buyer_id BETWEEN ? AND ?", FIRST_BUYER, FIRST_BUYER + 9_999);
        jdbc.update("DROP TABLE IF EXISTS lab_h1_orders");
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", product);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", product);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", product);
        jdbc.update("DELETE FROM products WHERE id = ?", product);
        TestRedis.forgetProducts(redis, product);
    }

    // ───────── naive ─────────

    /** naive 的下單：閘門 → 交易裡只寫訂單 → commit 之後送「請落帳」。失敗就把閘門加回去（6.5.2 那一套照抄） */
    String naivePlace(long buyer) {
        List<ReserveLine> line = List.of(new ReserveLine(NAIVE, 1));
        try {
            inventory.gateHot(line);
        } catch (RuntimeException e) {
            return "409";
        }
        try {
            new TransactionTemplate(tm).executeWithoutResult(s -> {
                jdbc.update("INSERT INTO lab_h1_orders (buyer_id, product_id) VALUES (?, ?)", buyer, NAIVE);
                long id = jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
                TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                    @Override
                    public void afterCommit() {                             // 「commit 之後才送，消費者就不會讀到還沒 commit 的訂單」
                        rabbit.convertAndSend(LAB_X, "settle", (id + ":" + NAIVE).getBytes(StandardCharsets.UTF_8));
                    }
                });
            });
            return "201";
        } catch (RuntimeException afterCommitFailed) {
            // 訂單已經 commit 了，例外是 afterCommit 丟的：客戶端收到 500，但訂單其實成立了。閘門不能加回（訂單是真的）
            return "500（訂單其實成立了）";
        }
    }

    SimpleMessageListenerContainer naiveConsumer() {
        // durable：RabbitMQ 重啟之後還在（不然訊息掉了是因為實驗的設定，不是因為 naive 的設計）
        admin.declareExchange(new DirectExchange(LAB_X, true, false));
        admin.declareQueue(new org.springframework.amqp.core.Queue(LAB_Q, true, false, false));
        admin.declareBinding(BindingBuilder.bind(new org.springframework.amqp.core.Queue(LAB_Q, true, false, false)).to(new DirectExchange(LAB_X, true, false)).with("settle"));
        SimpleMessageListenerContainer c = new SimpleMessageListenerContainer(cf);
        c.setQueueNames(LAB_Q);
        // 失敗就丟掉、不重新排隊。第一版用預設（重新排隊）：RabbitMQ 停機的那一刻，有一則處理完、還沒 ack 的訊息在重啟後被重送，
        // 撞上 uk_reservations_order_product、丟例外、重新排隊 —— 1,477 次（11-messaging/06 的 6.3.4）。那不是這個實驗要量的東西
        c.setDefaultRequeueRejected(false);
        c.setMessageListener(m -> {
            String[] p = new String(m.getBody(), StandardCharsets.UTF_8).split(":");
            new TransactionTemplate(tm).executeWithoutResult(s -> {
                int n = jdbc.update("UPDATE inventory SET reserved = reserved + 1 WHERE product_id = ? AND on_hand - reserved >= 1", Long.parseLong(p[1]));
                if (n == 1) {
                    jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (?, ?, 1, 'HELD')", -Long.parseLong(p[0]), Long.parseLong(p[1]));
                    jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 0, 1, 'RESERVE', ?)", Long.parseLong(p[1]), "lab-h1:" + p[0]);
                }
            });
        });
        c.start();
        return c;
    }

    // ───────── ours ─────────

    String oursPlace(long buyer) {
        try {
            ordering.placeOrder(buyer, "h1-" + buyer, List.of(new OrderingApi.OrderLine(OURS, 1, new BigDecimal("100"))));
            return "201";
        } catch (RuntimeException e) {
            return e.getClass().getSimpleName().contains("Insufficient") ? "409" : e.getClass().getSimpleName();
        }
    }

    // ───────── 共用 ─────────

    Map<String, Integer> wave(java.util.function.LongFunction<String> place, long firstBuyer, int n, Runnable atOneSecond) throws Exception {
        Map<String, Integer> out = new TreeMap<>();
        long start = System.nanoTime();
        boolean fired = atOneSecond == null;
        for (int i = 0; i < n; i++) {
            long due = start + i * 50_000_000L;                             // 每秒 20 張
            while (System.nanoTime() < due) Thread.sleep(1);
            if (!fired && System.nanoTime() - start >= 1_000_000_000L) { atOneSecond.run(); fired = true; }
            out.merge(place.apply(firstBuyer + i), 1, Integer::sum);
        }
        return out;
    }

    Map<String, Object> mysql(long product) {
        return jdbc.queryForMap("""
                SELECT i.on_hand, i.reserved,
                       (SELECT COUNT(*) FROM inventory_reservations r WHERE r.product_id = i.product_id AND r.status IN ('HELD', 'CONFIRMED')) AS holds
                  FROM inventory i WHERE i.product_id = ?""", product);
    }

    long naiveOrders() { return jdbc.queryForObject("SELECT COUNT(*) FROM lab_h1_orders", Long.class); }

    long oursOrders() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i.product_id = ? AND o.status <> 'CANCELLED'", Long.class, OURS);
    }

    void run(String name, long product, java.util.function.LongFunction<String> place, java.util.function.LongSupplier orders) throws Exception {
        Thread stopper = new Thread(() -> { try { docker("stop", "shop-rabbitmq-1"); Thread.sleep(10_000); docker("start", "shop-rabbitmq-1"); } catch (Exception e) { throw new RuntimeException(e); } });
        Map<String, Integer> first = wave(place, FIRST_BUYER, STOCK, stopper::start);
        stopper.join();
        waitRabbit();
        Thread.sleep(15_000);                                               // 讓消費者重新連上、把恢復之後的訊息處理完
        Map<String, Object> afterFirst = mysql(product);
        String redisBefore = redis.opsForValue().get("stock:" + product);
        int fixed = hot.reconcile() + hot.reconcile();                       // 第 06 章的對帳：連續兩輪看到同一組不一致才修正（6.6）
        String redisAfter = redis.opsForValue().get("stock:" + product);
        Map<String, Integer> second = wave(place, FIRST_BUYER + 1_000, STOCK, null);
        Thread.sleep(5_000);
        Map<String, Object> end = mysql(product);
        long n = orders.getAsLong();
        System.out.printf("  %-6s 第一波 %s%n", name, first);
        System.out.printf("         RabbitMQ 恢復 15 秒後：MySQL %s │ Redis %s%n", afterFirst, redisBefore);
        System.out.printf("         對帳兩輪：修正 %d 個商品，Redis %s → %s%n", fixed, redisBefore, redisAfter);
        System.out.printf("         第二波 %s%n", second);
        System.out.printf("         最後：成立的訂單 %d 張、庫存 %s 件 │ MySQL %s → %s%n", n, end.get("on_hand"), end,
                n > ((Number) end.get("on_hand")).intValue() ? "超賣 " + (n - ((Number) end.get("on_hand")).intValue()) + " 件" : "沒有超賣");
    }

    @Test
    void lostSettlementBecomesOversell() throws Exception {
        System.out.printf("═══ 7.2.1 熱點商品 %d 件：第一波 %d 人（每秒 20 張），第 1 秒起 RabbitMQ 停 10 秒；恢復後對帳兩輪；第二波 %d 人 ═══%n", STOCK, STOCK, STOCK);
        for (int round = 1; round <= 2; round++) {
            setUpProduct(NAIVE);
            jdbc.update("CREATE TABLE lab_h1_orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, buyer_id BIGINT, product_id BIGINT)");
            SimpleMessageListenerContainer c = naiveConsumer();
            try {
                run("naive", NAIVE, this::naivePlace, this::naiveOrders);
            } finally {
                c.stop();
                admin.deleteQueue(LAB_Q);
                admin.deleteExchange(LAB_X);
                cleanup(NAIVE);
            }
            setUpProduct(OURS);
            try {
                run("ours", OURS, this::oursPlace, this::oursOrders);
            } finally {
                cleanup(OURS);
            }
        }
    }
}
```

**`src/test/java/com/example/shop/ch07/H2RelayKillTest.java`**（7.2.2）

```java
package com.example.shop.ch07;

import com.example.shop.ShopApplication;
import com.example.shop.shared.security.AccessTokens;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.*;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 7.2.2 relay 被 kill -9：正式的程式（另一個 JVM）、每秒 50 張訂單，在隨機的時刻 kill -9，重啟，再 kill……一共 10 次。
 * 一個「計數佇列」綁在 shop.events 的 order.placed 上，收下 relay 送出的每一則。最後比對：
 *   資料庫裡 commit 了的訂單 ⇄ 計數佇列收到的訊息（依 messageId = eventId）
 * 量：遺失（commit 了、從來沒送出）、重複（同一個 eventId 送了不只一次）。
 */
@Tag("experiment")
class H2RelayKillTest {

    static final long PRODUCT = 9_907_201, FIRST_BUYER = 3_720_000;
    static final int KILLS = 10, RATE = 50;
    static final String COUNT_Q = "lab.h2.count";

    static int freePort() throws Exception {
        try (var s = new java.net.ServerSocket(0)) { return s.getLocalPort(); }
    }

    static Process child(int port, int cycle) throws Exception {
        return new ProcessBuilder(ProcessHandle.current().info().command().orElse("java"), "-cp", System.getProperty("java.class.path"),
                ShopApplication.class.getName(), "--server.port=" + port, "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false",
                "--shop.messaging.relay-enabled=true", "--shop.messaging.consumers-enabled=false",
                "--spring.main.banner-mode=off", "--logging.level.root=WARN")
                .redirectErrorStream(true).redirectOutput(Path.of("target/h2-child-" + cycle + ".log").toFile()).start();
    }

    static boolean ready(HttpClient http, int port) {
        try {
            return http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/ping")).build(), HttpResponse.BodyHandlers.discarding()).statusCode() == 200;
        } catch (Exception e) {
            return false;
        }
    }

    @Test
    void killTheRelay() throws Exception {
        try (ConfigurableApplicationContext observer = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0",
                "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false", "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            JdbcTemplate jdbc = observer.getBean(JdbcTemplate.class);
            AccessTokens tokens = observer.getBean(AccessTokens.class);
            AmqpAdmin admin = observer.getBean(AmqpAdmin.class);
            RabbitTemplate rabbit = observer.getBean(RabbitTemplate.class);
            cleanup(jdbc);
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, 'H2', 100.00, 'ON_SALE')", PRODUCT);
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 1000000, 0)", PRODUCT);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 1000000, 0, 'INITIAL', 'h2')", PRODUCT);
            jdbc.update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");   // 別的測試留下的（7.12.1）
            admin.declareExchange(new TopicExchange("shop.events", true, false));
            org.springframework.amqp.core.Queue q = new org.springframework.amqp.core.Queue(COUNT_Q, true, false, false);
            admin.declareQueue(q);
            admin.declareBinding(BindingBuilder.bind(q).to(new TopicExchange("shop.events", true, false)).with("order.placed"));
            admin.purgeQueue(COUNT_Q, false);

            HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).executor(Executors.newFixedThreadPool(32)).build();
            AtomicInteger next = new AtomicInteger(), got201 = new AtomicInteger(), failed = new AtomicInteger();
            Random rnd = new Random();
            List<Long> cycleStart = new ArrayList<>();                         // 每一次（cycle）第一位買家的編號：重複的事件屬於哪一次
            System.out.printf("═══ 7.2.2 正式的程式在另一個 JVM，每秒 %d 張訂單；隨機時刻 kill -9，重啟，共 %d 次 ═══%n", RATE, KILLS);
            for (int cycle = 1; cycle <= KILLS + 1; cycle++) {
                int port = freePort();
                Process p = child(port, cycle);
                for (int i = 0; i < 240 && !ready(http, port); i++) Thread.sleep(250);
                if (cycle == KILLS + 1) {                                   // 最後一次：不殺，讓 relay 把剩下的送完
                    long ourUnpublished;
                    do {
                        Thread.sleep(500);
                        ourUnpublished = jdbc.queryForObject("""
                                SELECT COUNT(*) FROM outbox_events e JOIN orders o ON o.id = e.aggregate_id
                                 WHERE e.event_type = 'order.placed' AND e.published_at IS NULL AND o.buyer_id >= ?""", Long.class, FIRST_BUYER);
                    } while (ourUnpublished > 0);
                    p.destroy();                                            // SIGTERM：正常關機
                    p.waitFor();
                    break;
                }
                cycleStart.add(FIRST_BUYER + next.get());
                ScheduledExecutorService load = Executors.newSingleThreadScheduledExecutor();
                load.scheduleAtFixedRate(() -> {
                    long buyer = FIRST_BUYER + next.getAndIncrement();      // 每張訂單一位買家：避開每位買家每分鐘 10 張的限流（6.7.1）
                    HttpRequest req = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/orders"))
                            .header("Authorization", TestTokens.bearer(tokens, buyer)).header("Content-Type", "application/json")
                            .header("Idempotency-Key", "h2-" + buyer)
                            .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + PRODUCT + ",\"quantity\":1,\"unitPrice\":100}]}")).build();
                    http.sendAsync(req, HttpResponse.BodyHandlers.discarding())
                            .whenComplete((r, e) -> { if (r != null && r.statusCode() == 201) got201.incrementAndGet(); else failed.incrementAndGet(); });
                }, 0, 1000 / RATE, TimeUnit.MILLISECONDS);
                long runMs = 2000 + rnd.nextInt(4000);
                Thread.sleep(runMs);
                new ProcessBuilder("kill", "-9", String.valueOf(p.pid())).start().waitFor();
                int exit = p.waitFor();
                load.shutdownNow();
                Thread.sleep(300);
                Map<String, Object> left = jdbc.queryForMap("""
                        SELECT COUNT(*) AS n, COALESCE(SUM(e.claimed_until IS NOT NULL AND e.claimed_until > CURRENT_TIMESTAMP(3)), 0) AS leased
                          FROM outbox_events e JOIN orders o ON o.id = e.aggregate_id
                         WHERE e.event_type = 'order.placed' AND e.published_at IS NULL AND o.buyer_id >= ?""", FIRST_BUYER);
                System.out.printf("  第 %2d 次：跑了 %,5d ms 之後 kill -9（exit %d）；這時候還沒送出的 order.placed：%s 則（其中 %s 則在死掉的那個行程的租約裡）%n",
                        cycle, runMs, exit, left.get("n"), left.get("leased"));
            }
            Thread.sleep(1000);
            Map<String, Integer> received = new HashMap<>();
            Message m;
            while ((m = rabbit.receive(COUNT_Q, 1000)) != null) received.merge(m.getMessageProperties().getMessageId(), 1, Integer::sum);
            List<String> committed = jdbc.queryForList("""
                    SELECT e.event_id FROM outbox_events e JOIN orders o ON o.id = e.aggregate_id
                     WHERE e.event_type = 'order.placed' AND o.buyer_id >= ?""", String.class, FIRST_BUYER);
            long lost = committed.stream().filter(id -> !received.containsKey(id)).count();
            Map<Integer, Integer> dupByCycle = new TreeMap<>();                // 重複的事件，屬於第幾次的訂單
            for (Map<String, Object> row : jdbc.queryForList("""
                    SELECT e.event_id, o.buyer_id FROM outbox_events e JOIN orders o ON o.id = e.aggregate_id
                     WHERE e.event_type = 'order.placed' AND o.buyer_id >= ?""", FIRST_BUYER)) {
                if (received.getOrDefault((String) row.get("event_id"), 0) < 2) continue;
                long buyer = ((Number) row.get("buyer_id")).longValue();
                int c = 0;
                while (c + 1 < cycleStart.size() && cycleStart.get(c + 1) <= buyer) c++;
                dupByCycle.merge(c + 1, 1, Integer::sum);
            }
            long dupIds = received.values().stream().filter(n -> n > 1).count();
            int messages = received.values().stream().mapToInt(Integer::intValue).sum();
            System.out.printf("  客戶端：送出 %d 個請求，201 = %d、失敗（連不上、被 kill 時還在路上）= %d%n", next.get(), got201.get(), failed.get());
            System.out.printf("  資料庫：commit 了 %d 張訂單（比 201 多 %d 張：回應還沒回來就被 kill，但交易已經 commit 了）%n", committed.size(), committed.size() - got201.get());
            System.out.printf("  計數佇列：收到 %d 則，不同的 eventId %d 個 │ 遺失 %d │ 重複的 eventId %d 個（多送了 %d 則）%n",
                    messages, received.size(), lost, dupIds, messages - received.size());
            System.out.println("  重複的事件屬於第幾次的訂單：" + dupByCycle);
            admin.deleteQueue(COUNT_Q);
            com.example.shop.support.TestQueues.purgeConsumerQueues(observer);   // 子行程沒開消費者：送出的訊息都還在佇列裡（7.12.1）
            cleanup(jdbc);
        }
    }

    static void cleanup(JdbcTemplate jdbc) {
        for (String t : List.of("order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", FIRST_BUYER, FIRST_BUYER + 100_000);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", FIRST_BUYER, FIRST_BUYER + 100_000);
        jdbc.update("DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", FIRST_BUYER, FIRST_BUYER + 100_000);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
        jdbc.update("DELETE FROM cart_items WHERE buyer_id >= ? AND buyer_id < ?", FIRST_BUYER, FIRST_BUYER + 100_000);
    }
}
```

**`src/test/java/com/example/shop/payment/internal/H3RefundResponseLostTest.java`**（7.2.3）

```java
package com.example.shop.payment.internal;

import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.EventTypes;
import com.example.shop.shared.events.internal.EventDispatcher;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;

/**
 * 7.2.3 退款的回應沒回來：金流把錢退了，回應在路上逾時。消費者丟例外 → 重試階梯 → 再呼叫一次。
 * 三種消費者，同樣 20 筆退款、每一筆的第一次呼叫都「錢退了、回應丟了」，第二次（重試）正常：
 *   ① 沒有冪等鍵：每次呼叫帶一個新的 request id（很多 SDK 的預設）
 *   ② processed_messages：把「呼叫金流 + 標 SUCCEEDED」包進 EventDispatcher 的交易（7.5.2 的寫法，transactional = true）
 *   ③ 本專題（RefundExecutor）：冪等鍵 refund-{id} 交給金流
 * 「重試」直接再呼叫一次 —— 等於 broker 把同一則訊息再送一次（7.5.3）。量：金流實際退了幾次錢。
 */
@Tag("experiment")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
class H3RefundResponseLostTest {

    static final long FIRST_PAYMENT_ORDER = 9_903_000;
    static final int N = 20;

    @Autowired JdbcTemplate jdbc;
    @Autowired SimulatedRefundGateway gateway;
    @Autowired RefundExecutor ours;
    @Autowired EventDispatcher dispatcher;
    @Autowired ObjectMapper json;

    record Refund(long refundId, long paymentId) {}

    List<Refund> setUp() {
        cleanup();
        List<Refund> out = new ArrayList<>();
        for (int i = 0; i < N; i++) {
            long order = FIRST_PAYMENT_ORDER + i;
            jdbc.update("INSERT INTO payments (order_id, amount, status, provider, provider_txn_id) VALUES (?, 100.00, 'SUCCEEDED', 'SIMULATED', ?)", order, "h3-" + order);
            long pid = jdbc.queryForObject("SELECT id FROM payments WHERE provider_txn_id = ?", Long.class, "h3-" + order);
            jdbc.update("INSERT INTO refunds (payment_id, order_id, amount, reason, status) VALUES (?, ?, 100.00, 'BUYER_CANCEL', 'PENDING')", pid, order);
            out.add(new Refund(jdbc.queryForObject("SELECT id FROM refunds WHERE payment_id = ?", Long.class, pid), pid));
        }
        return out;
    }

    void cleanup() {
        jdbc.update("""
                DELETE o FROM outbox_events o JOIN refunds r ON o.aggregate_type = 'REFUND' AND o.aggregate_id = r.id
                  JOIN payments p ON p.id = r.payment_id WHERE p.provider_txn_id LIKE 'h3-%'""");     // ③ 成功時寫的 refund.succeeded
        jdbc.update("DELETE r FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.provider_txn_id LIKE 'h3-%'");
        jdbc.update("DELETE FROM processed_messages WHERE consumer LIKE 'lab.h3.%'");
        jdbc.update("DELETE FROM payments WHERE provider_txn_id LIKE 'h3-%'");
    }

    Event event(Refund r) throws Exception {
        return new Event(UUID.randomUUID().toString(), EventTypes.REFUND_REQUESTED, "REFUND", r.refundId(), Instant.now(),
                json.readTree("{\"refundId\":%d,\"orderId\":0,\"paymentId\":%d,\"amount\":\"100.00\",\"buyerId\":0}".formatted(r.refundId(), r.paymentId())), 1);
    }

    /** ① 沒有冪等鍵 */
    EventHandler noKey() {
        return new EventHandler() {
            @Override public String consumer() { return "lab.h3.no-key"; }
            @Override public Set<String> eventTypes() { return Set.of(EventTypes.REFUND_REQUESTED); }
            @Override public boolean transactional() { return false; }
            @Override public void handle(Event e) {
                long id = e.getLong("refundId");
                if ("SUCCEEDED".equals(jdbc.queryForObject("SELECT status FROM refunds WHERE id = ?", String.class, id))) return;
                String providerId = gateway.refund(UUID.randomUUID().toString(), e.getLong("paymentId"), new BigDecimal("100.00"));
                jdbc.update("UPDATE refunds SET status = 'SUCCEEDED', provider_refund_id = ? WHERE id = ?", providerId, id);
            }
        };
    }

    /** ② processed_messages 包住外部呼叫 */
    EventHandler processedMessages() {
        return new EventHandler() {
            @Override public String consumer() { return "lab.h3.processed"; }
            @Override public Set<String> eventTypes() { return Set.of(EventTypes.REFUND_REQUESTED); }
            @Override public void handle(Event e) {                         // transactional() = true：EventDispatcher 開交易、先插 processed_messages
                long id = e.getLong("refundId");
                String providerId = gateway.refund(UUID.randomUUID().toString(), e.getLong("paymentId"), new BigDecimal("100.00"));
                jdbc.update("UPDATE refunds SET status = 'SUCCEEDED', provider_refund_id = ? WHERE id = ?", providerId, id);
            }
        };
    }

    Map<String, Object> run(String name, EventHandler h) throws Exception {
        List<Refund> refunds = setUp();
        gateway.reset();
        gateway.latency(0);
        int exceptions = 0, money = 0;
        for (Refund r : refunds) {
            Event e = event(r);
            gateway.loseResponseNext(1);                                    // 第一次：錢退了，回應丟了
            for (int attempt = 1; attempt <= 2; attempt++) {
                try {
                    dispatcher.dispatch(h, new Event(e.eventId(), e.type(), e.aggregateType(), e.aggregateId(), e.occurredAt(), e.payload(), attempt));
                    break;
                } catch (RuntimeException ex) {
                    exceptions++;                                           // broker 會把它送進重試階梯 → 再送一次
                }
            }
            money += gateway.moneyOutFor(r.paymentId());
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("退款單", N);
        m.put("第一次呼叫丟例外", exceptions);
        m.put("SUCCEEDED", jdbc.queryForObject("SELECT COUNT(*) FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.provider_txn_id LIKE 'h3-%' AND r.status = 'SUCCEEDED'", Long.class));
        m.put("金流實際退款", money);
        System.out.printf("  %-34s %s%n", name, m);
        cleanup();
        return m;
    }

    @Test
    void responseLost() throws Exception {
        System.out.printf("═══ 7.2.3 %d 筆退款；每一筆第一次呼叫金流：錢退了、回應逾時；broker 重送一次 ═══%n", N);
        for (int round = 0; round < 2; round++) {
            run("① 沒有冪等鍵", noKey());
            run("② processed_messages 包住金流呼叫", processedMessages());
            run("③ 本專題：冪等鍵 refund-{id}", ours);
        }
    }
}
```

**`src/test/java/com/example/shop/ch07/H4HeadersMatchTest.java`**（7.5.3）

```java
package com.example.shop.ch07;

import com.rabbitmq.client.*;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 7.5.3 ⚠️ 重試佇列「回到原佇列」靠 headers exchange。同一個 header、三種綁定方式，送一則訊息，看誰收到。
 * 每一種綁定方式各有兩個佇列：一個是目標（target = A），一個不是（target = B）。只有 A 應該收到。
 */
@Tag("experiment")
class H4HeadersMatchTest {

    @Test
    void whoReceives() throws Exception {
        ConnectionFactory f = new ConnectionFactory();
        f.setUsername("shop");
        f.setPassword("shop");
        try (Connection c = f.newConnection(); Channel ch = c.createChannel()) {
            String x = "lab.h4.headers";
            ch.exchangeDelete(x);
            ch.exchangeDeclare(x, BuiltinExchangeType.HEADERS, false, false, null);   // 不能 auto-delete：解除第一組綁定時它就被刪了
            Map<String, String[]> ways = new LinkedHashMap<>();
            ways.put("x-match=all，header 叫 x-shop-target", new String[]{"all", "x-shop-target"});
            ways.put("x-match=all，header 叫 shop-target  ", new String[]{"all", "shop-target"});
            ways.put("x-match=all-with-x，header 叫 x-shop-target", new String[]{"all-with-x", "x-shop-target"});
            System.out.println("═══ 7.5.3 headers exchange：送一則 target = A 的訊息，誰收到？═══");
            int i = 0;
            for (var w : ways.entrySet()) {
                String match = w.getValue()[0], header = w.getValue()[1];
                String qa = "lab.h4." + i + ".A", qb = "lab.h4." + i + ".B";
                for (String q : new String[]{qa, qb}) { ch.queueDelete(q); ch.queueDeclare(q, false, false, true, null); }
                ch.queueBind(qa, x, "", Map.of("x-match", match, header, "A"));
                ch.queueBind(qb, x, "", Map.of("x-match", match, header, "B"));
                ch.basicPublish(x, "", new AMQP.BasicProperties.Builder().headers(Map.of(header, "A")).build(), ("m" + i).getBytes(StandardCharsets.UTF_8));
                Thread.sleep(300);
                System.out.printf("  %-44s A 佇列 %d 則、B 佇列 %d 則%n", w.getKey(), ch.messageCount(qa), ch.messageCount(qb));
                ch.queueUnbind(qa, x, "", Map.of("x-match", match, header, "A"));
                ch.queueUnbind(qb, x, "", Map.of("x-match", match, header, "B"));
                i++;
            }
            ch.exchangeDelete(x);
        }
    }
}
```

**`src/test/java/com/example/shop/ch07/H5HotFlashSaleTest.java`**（7.6.6）

```java
package com.example.shop.ch07;

import com.example.shop.ch04.E7FlashSaleLoadTest;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * 7.6.6 熱點搶購的第二次嘗試（6.5.4 的 p99 沒達成）。第 04 章的 E7 原封不動、商品是熱點、開放式 200 rps；
 * 這一章的程式碼：relay 與消費者都在跑，熱點的落帳在 commit 之後。暖機一輪、量兩輪。
 * 跟第 06 章的程式碼（ch06 worktree 的 H5BaselineTest）交錯執行，各 3 次（6.2.0：這台機器的雜訊比兩章之間的差還大）。
 */
@Tag("experiment")
class H5HotFlashSaleTest {

    static final org.springframework.jdbc.core.JdbcTemplate ROOT = new org.springframework.jdbc.core.JdbcTemplate(
            new org.springframework.jdbc.datasource.DriverManagerDataSource("jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true", "root", "root"));

    /** InnoDB 的列鎖等待（全域計數器）：{次數, 總毫秒} */
    static long[] lockWaits() {
        long[] r = new long[2];
        ROOT.query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_row_lock_waits', 'Innodb_row_lock_time')", rs -> {
            if (rs.getString(1).equals("Innodb_row_lock_waits")) r[0] = rs.getLong(2); else r[1] = rs.getLong(2);
        });
        return r;
    }

    @Test
    void ch07() throws Exception {
        E7FlashSaleLoadTest.flashSale(false, 0, true);
        for (int i = 0; i < 2; i++) {
            long[] before = lockWaits();
            var r = E7FlashSaleLoadTest.flashSale(false, 200, true);
            long[] after = lockWaits();
            System.out.printf("  ch07 熱點 HTTP %s │ %5.2f 秒 │ p50 %5.0f  p95 %5.0f  p99 %5.0f  最慢 %5.0f ms │ reserved=%d 明細=%d RESERVE 帳=%d │ 連線池：同時使用最多 %d、等待最多 %d │ 最後一個回應之後 %,d ms 全部落帳 │ 列鎖等待 %,d 次、共 %,d ms%n",
                    r.statuses(), r.seconds(), r.p50(), r.p95(), r.p99(), r.max(), r.reserved(), r.orders(), r.ledger(), r.maxActive(), r.maxPending(), r.settledMs(), after[0] - before[0], after[1] - before[1]);
            if (!r.retried().isEmpty()) System.out.printf("       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP %s%n", r.retried());
        }
    }
}
```

**`src/test/java/com/example/shop/ch07/H5bDiagnoseTest.java`**（7.6.6）

```java
package com.example.shop.ch07;

import com.example.shop.ch04.E7FlashSaleLoadTest;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.util.*;
import java.util.concurrent.*;

/**
 * 7.6.6 熱點的鎖拿掉之後，p99 為什麼還是秒級？跑一次第 07 章的搶購（開放式 200 rps），同時每 50 ms 取樣：
 *   ① performance_schema.data_lock_waits：誰在等誰的鎖（表、索引、鎖的模式）
 *   ② information_schema.processlist：shop 的連線各在做什麼（狀態、正在跑的那句 SQL 的開頭）
 */
@Tag("experiment")
class H5bDiagnoseTest {

    static final JdbcTemplate ROOT = new JdbcTemplate(new DriverManagerDataSource(
            "jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true", "root", "root"));

    @Test
    void whereDoTheyWait() throws Exception {
        E7FlashSaleLoadTest.flashSale(false, 0, true);                        // 暖機
        Map<String, Integer> waits = new ConcurrentHashMap<>(), work = new ConcurrentHashMap<>();
        int[] samples = {0};
        ScheduledExecutorService s = Executors.newSingleThreadScheduledExecutor();
        s.scheduleAtFixedRate(() -> {
            try {
                samples[0]++;
                ROOT.query("""
                        SELECT r.OBJECT_NAME, r.INDEX_NAME, r.LOCK_MODE AS want, b.LOCK_MODE AS held
                          FROM performance_schema.data_lock_waits w
                          JOIN performance_schema.data_locks r ON r.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
                          JOIN performance_schema.data_locks b ON b.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID""", rs -> {
                    waits.merge(rs.getString(1) + "." + rs.getString(2) + " 要 " + rs.getString(3) + "、被 " + rs.getString(4) + " 擋", 1, Integer::sum);
                });
                ROOT.query("SELECT COALESCE(STATE, ''), COALESCE(LEFT(INFO, 60), '（閒置）') FROM information_schema.PROCESSLIST WHERE USER = 'shop' AND COMMAND <> 'Sleep'", rs -> {
                    work.merge(rs.getString(2).replaceAll("\\s+", " ") + " │ " + rs.getString(1), 1, Integer::sum);
                });
            } catch (Exception ignored) { }
        }, 0, 50, TimeUnit.MILLISECONDS);
        var r = E7FlashSaleLoadTest.flashSale(false, 200, true);
        s.shutdownNow();
        System.out.printf("═══ 7.6.6 第 07 章的搶購，每 50 ms 取樣 %d 次 ═══%n", samples[0]);
        System.out.printf("  HTTP %s │ p50 %.0f  p99 %.0f ms │ 連線池：同時使用最多 %d、等待最多 %d%n", r.statuses(), r.p50(), r.p99(), r.maxActive(), r.maxPending());
        System.out.println("  ── 鎖等待（取樣到的次數，前 8 名）──");
        waits.entrySet().stream().sorted(Map.Entry.<String, Integer>comparingByValue().reversed()).limit(8)
                .forEach(e -> System.out.printf("    %5d  %s%n", e.getValue(), e.getKey()));
        System.out.println("  ── shop 的連線在做什麼（取樣到的次數，前 12 名）──");
        work.entrySet().stream().sorted(Map.Entry.<String, Integer>comparingByValue().reversed()).limit(12)
                .forEach(e -> System.out.printf("    %5d  %s%n", e.getValue(), e.getKey()));
    }
}
```

**`src/test/java/com/example/shop/ch07/H6RabbitOutageDrillTest.java`**（7.9）

```java
package com.example.shop.ch07;

import com.example.shop.ShopApplication;
import com.example.shop.support.TestRedis;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.*;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 7.9 0.6.3「RabbitMQ」那一欄的演練：固定的混合流量跑 100 秒，第 20 秒把 RabbitMQ 停掉（stop 或 pause），第 80 秒恢復。
 * 流量（開放式）：一般商品下單每秒 10 張、熱點商品下單每秒 10 張、商品詳情每秒 50 次。
 * 每 5 秒一列：各 API 的狀態碼與 p99、outbox 堆了多少、這 5 秒寄出幾封通知、還沒落帳的熱點預留。
 * 第 40 秒（RabbitMQ 還停著）另外啟動第二個實例：起得來嗎？readiness 是什麼？
 * 一個計數佇列綁在 order.placed 上：恢復之後，同一個事件被送了幾次。
 */
@Tag("experiment")
class H6RabbitOutageDrillTest {

    static final long HOT = 9_907_601, NORMAL = 9_907_602, BUYER = 3_760_000;
    static final String COUNT_Q = "lab.h6.count";

    @Test
    void sixtySecondsWithoutRabbit() throws Exception {
        for (String mode : System.getProperty("h6.modes", "stop,pause").split(",")) drill(mode);
    }

    record Sample(String api, int status, long nanos) {}

    record Row(long pending, double oldest, long sent, long uncounted) {}

    /** 量測用自己的連線（root）：第一版用應用程式的連線池取樣，pause 的時候池子被用光，連實驗自己都拿不到連線 */
    static final JdbcTemplate ROOT = new JdbcTemplate(new org.springframework.jdbc.datasource.DriverManagerDataSource(
            "jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC", "root", "root"));   // connectionTimeZone：跟應用程式一樣（第一次漏了，時間窗差 8 小時）

    static String[] args(int port) {
        return new String[]{"--server.port=" + port, "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false",
                "--shop.messaging.relay-enabled=true", "--shop.messaging.consumers-enabled=true",
                "--spring.main.banner-mode=off", "--logging.level.root=" + System.getProperty("h6.log", "ERROR")};
    }

    void drill(String mode) throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run(args(0))) {
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            StringRedisTemplate redis = ctx.getBean(StringRedisTemplate.class);
            AmqpAdmin admin = ctx.getBean(AmqpAdmin.class);
            RabbitTemplate rabbit = ctx.getBean(RabbitTemplate.class);
            cleanup(jdbc, redis);
            jdbc.update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");   // 別的測試留下的（7.12.1）
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '演練熱點', 100.00, 'ON_SALE', TRUE)", HOT);
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '演練一般', 100.00, 'ON_SALE')", NORMAL);
            for (long id : new long[]{HOT, NORMAL}) jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", id);
            org.springframework.amqp.core.Queue q = new org.springframework.amqp.core.Queue(COUNT_Q, true, false, false);
            admin.declareQueue(q);
            admin.declareBinding(BindingBuilder.bind(q).to(new TopicExchange("shop.events", true, false)).with("order.placed"));
            admin.purgeQueue(COUNT_Q, false);

            HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(64)).build();
            String base = "http://localhost:" + port;
            ConcurrentLinkedQueue<Sample>[] buckets = new ConcurrentLinkedQueue[20];
            for (int i = 0; i < 20; i++) buckets[i] = new ConcurrentLinkedQueue<>();
            Row[] rows = new Row[20];
            int[] outboxLockWaits = new int[20], poolWaitMax = new int[20];
            long[] redisFail = new long[21], redisTrips = new long[21];   // 每 5 秒的累計值，印的時候取差
            var meters = ctx.getBean(io.micrometer.core.instrument.MeterRegistry.class);
            java.util.function.ToLongFunction<String> counter = n -> { var c = meters.find(n).counter(); return c == null ? 0 : (long) c.count(); };
            var hikari = ((com.zaxxer.hikari.HikariDataSource) ctx.getBean(javax.sql.DataSource.class)).getHikariPoolMXBean();
            ScheduledExecutorService clock = Executors.newScheduledThreadPool(2);
            ExecutorService senders = Executors.newCachedThreadPool();
            long t0 = System.nanoTime();
            Instant start = Instant.now();
            AtomicLong buyerSeq = new AtomicLong(BUYER);
            ScheduledFuture<?> ticker = clock.scheduleAtFixedRate(() -> {     // 每 20 ms 一個 tick：詳情 1 次；每 5 個 tick 一般、熱點各 1 張
                long now = System.nanoTime();
                int bucket = (int) ((now - t0) / 5_000_000_000L);
                if (bucket >= 20) return;
                long tick = (now - t0) / 20_000_000L;
                List<String[]> reqs = new ArrayList<>();
                reqs.add(new String[]{"詳情", "GET", "/api/products/" + NORMAL});
                if (tick % 5 == 0) reqs.add(new String[]{"一般下單", "POST", "" + NORMAL});
                if (tick % 5 == 2) reqs.add(new String[]{"熱點下單", "POST", "" + HOT});
                for (String[] r : reqs) senders.submit(() -> {
                    long s = System.nanoTime();
                    HttpRequest.Builder b;
                    if (r[1].equals("GET")) b = HttpRequest.newBuilder(URI.create(base + r[2])).timeout(java.time.Duration.ofSeconds(10));
                    else {
                        long buyer = buyerSeq.getAndIncrement();
                        b = HttpRequest.newBuilder(URI.create(base + "/api/orders")).timeout(java.time.Duration.ofSeconds(10))
                                .header("Authorization", TestTokens.bearer(ctx, buyer)).header("Idempotency-Key", "h6-" + buyer).header("Content-Type", "application/json")
                                .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + r[2] + ",\"quantity\":1,\"unitPrice\":100}]}"));
                    }
                    int status;
                    try { status = http.send(b.build(), HttpResponse.BodyHandlers.discarding()).statusCode(); } catch (Exception e) { status = 0; }
                    buckets[bucket].add(new Sample(r[0], status, System.nanoTime() - s));
                });
            }, 0, 20, TimeUnit.MILLISECONDS);
            ScheduledFuture<?> sampler = clock.scheduleAtFixedRate(() -> {   // 每 200 ms：有幾個交易在等 outbox_events 的鎖、連線池有幾個人在排隊
                int b = (int) ((System.nanoTime() - t0) / 5_000_000_000L);
                if (b >= 20) return;
                try {
                    Integer w = ROOT.queryForObject("""
                            SELECT COUNT(*) FROM performance_schema.data_lock_waits w
                              JOIN performance_schema.data_locks r ON r.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
                             WHERE r.OBJECT_NAME = 'outbox_events'""", Integer.class);
                    outboxLockWaits[b] = Math.max(outboxLockWaits[b], w == null ? 0 : w);
                } catch (Exception ignored) { }
                poolWaitMax[b] = Math.max(poolWaitMax[b], hikari.getThreadsAwaitingConnection());
            }, 0, 200, TimeUnit.MILLISECONDS);

            CompletableFuture<String> second = null;
            for (int i = 0; i <= 20; i++) {
                long due = t0 + i * 5_000_000_000L;
                while (System.nanoTime() < due) Thread.sleep(20);
                if (i > 0) rows[i - 1] = row(ROOT, start.plusSeconds((i - 1) * 5L), start.plusSeconds(i * 5L));
                redisFail[i] = counter.applyAsLong("shop.redis.failures");
                redisTrips[i] = counter.applyAsLong("shop.redis.trips");
                if (i == 4) H1Docker.run(mode, "shop-rabbitmq-1");
                if (i == 8) second = startSecondInstance();                  // 第 40 秒：RabbitMQ 還停著，在背景啟動第二個實例
                if (i == 16) H1Docker.run(mode.equals("stop") ? "start" : "unpause", "shop-rabbitmq-1");
            }
            ticker.cancel(false);
            sampler.cancel(false);
            senders.shutdown();
            senders.awaitTermination(30, TimeUnit.SECONDS);
            clock.shutdown();

            // 恢復之後：等 outbox 清空、熱點全部落帳、通知全部寄出（最多 180 秒）
            long rec = System.nanoTime();
            Long outboxEmpty = null, settled = null, notified = null;
            while (System.nanoTime() - rec < 180_000_000_000L && (outboxEmpty == null || settled == null || notified == null)) {
                Row r = row(ROOT, start, Instant.now().plusSeconds(1));
                long s = (System.nanoTime() - t0) / 1_000_000_000L;
                if (outboxEmpty == null && r.pending() == 0) outboxEmpty = s;
                if (settled == null && r.uncounted() == 0) settled = s;
                if (notified == null && unsent(ROOT) == 0) notified = s;
                Thread.sleep(500);
            }

            System.out.printf("═══ 7.9 RabbitMQ 停 60 秒：docker %s shop-rabbitmq-1（第 20～80 秒）═══%n", mode);
            System.out.println("  秒      RabbitMQ │ 一般下單 狀態          p99 ms │ 熱點下單 狀態          p99 ms │ 詳情 狀態     │ outbox 未送出（最舊） │ 這 5 秒寄出的通知 │ 未落帳的熱點預留 │ 等 outbox 鎖的交易（最多）│ 等連線（最多）│ Redis 失敗／跳開");
            for (int i = 0; i < 20; i++) {
                Map<String, List<Sample>> by = new TreeMap<>();
                for (Sample s : buckets[i]) by.computeIfAbsent(s.api(), k -> new ArrayList<>()).add(s);
                Row r = rows[i];
                System.out.printf("  %3d-%-3d %-6s │ %-20s %6.0f │ %-20s %6.0f │ %-12s │ %6d（%5.1f 秒）    │ %8d          │ %6d           │ %6d                   │ %4d          │ %d／%d%n", i * 5, i * 5 + 5, i >= 4 && i < 16 ? "停了" : "正常",
                        statuses(by.get("一般下單")), p99(by.get("一般下單")), statuses(by.get("熱點下單")), p99(by.get("熱點下單")), statuses(by.get("詳情")),
                        r.pending(), r.oldest(), r.sent(), r.uncounted(), outboxLockWaits[i], poolWaitMax[i],
                        redisFail[i + 1] - redisFail[i], redisTrips[i + 1] - redisTrips[i]);
            }
            System.out.printf("  恢復之後：outbox 在第 %s 秒清空、熱點預留在第 %s 秒全部落帳、通知在第 %s 秒全部寄出（RabbitMQ 在第 80 秒恢復）%n", outboxEmpty, settled, notified);
            delays(ROOT, start);
            Map<String, Integer> seen = new HashMap<>();
            Message m;
            while ((m = rabbit.receive(COUNT_Q, 1000)) != null) seen.merge(m.getMessageProperties().getMessageId(), 1, Integer::sum);
            int total = seen.values().stream().mapToInt(Integer::intValue).sum();
            long orders = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE buyer_id >= ? AND buyer_id < ?", Long.class, BUYER, BUYER + 100_000);
            System.out.printf("  計數佇列（order.placed）：訂單 %d 張 → 收到 %d 則、不同的 eventId %d 個（重複 %d 則）│ 消費者擋下的重複：落帳 %s、通知 %s%n",
                    orders, total, seen.size(), total - seen.size(), counter(ctx, "inventory.hot-settlement"), "（以 notifications.attempts 看）");
            System.out.printf("  通知：attempts > 1 的 %d 封、寄出的總數 %d 封（訂單 %d 張，每張 1 封）%n",
                    jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE user_id >= ? AND user_id < ? AND attempts > 1", Long.class, BUYER, BUYER + 100_000),
                    jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE user_id >= ? AND user_id < ? AND status = 'SENT'", Long.class, BUYER, BUYER + 100_000), orders);
            String secondResult;
            try { secondResult = second.get(120, TimeUnit.SECONDS); } catch (Exception e) { secondResult = "120 秒內沒有結果：" + e; }
            System.out.println("  第二個實例（第 40 秒啟動，RabbitMQ 停著）：" + secondResult);
            admin.deleteQueue(COUNT_Q);
            cleanup(jdbc, redis);
        } finally {
            H1Docker.run("unpause", "shop-rabbitmq-1");
            H1Docker.run("start", "shop-rabbitmq-1");
            Thread.sleep(10_000);
        }
    }

    /** 第二個實例：RabbitMQ 停著的時候啟動 —— 起得來嗎、多久、readiness 是什麼 */
    static CompletableFuture<String> startSecondInstance() {
        return CompletableFuture.supplyAsync(() -> {
            long s = System.nanoTime();
            try (ConfigurableApplicationContext c = new SpringApplicationBuilder(ShopApplication.class).run(args(0))) {
                long ms = (System.nanoTime() - s) / 1_000_000;
                int port = ((WebServerApplicationContext) c).getWebServer().getPort();
                var r = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/actuator/health/readiness")).build(),
                        HttpResponse.BodyHandlers.ofString());
                return "啟動花了 " + ms + " ms，readiness HTTP " + r.statusCode() + " " + r.body();
            } catch (Exception e) {
                return "啟動失敗：" + e;
            }
        });
    }

    static Row row(JdbcTemplate jdbc, Instant from, Instant to) {
        Map<String, Object> o = jdbc.queryForMap("""
                SELECT COUNT(*) AS n, COALESCE(TIMESTAMPDIFF(MICROSECOND, MIN(e.created_at), CURRENT_TIMESTAMP(3)), 0) / 1e6 AS oldest
                  FROM outbox_events e WHERE e.published_at IS NULL""");
        long sent = jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE user_id >= ? AND user_id < ? AND sent_at >= ? AND sent_at < ?",
                Long.class, BUYER, BUYER + 100_000, Timestamp.from(from), Timestamp.from(to));
        long uncounted = jdbc.queryForObject("SELECT COUNT(*) FROM inventory_reservations WHERE product_id = ? AND counted = FALSE AND status IN ('HELD', 'CONFIRMED')", Long.class, HOT);
        return new Row(((Number) o.get("n")).longValue(), ((Number) o.get("oldest")).doubleValue(), sent, uncounted);
    }

    static long unsent(JdbcTemplate jdbc) {
        return jdbc.queryForObject("""
                SELECT COUNT(*) FROM orders o WHERE o.buyer_id >= ? AND o.buyer_id < ?
                   AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = o.buyer_id AND n.type = 'ORDER_PLACED' AND n.status = 'SENT')""",
                Long.class, BUYER, BUYER + 100_000);
    }

    static void delays(JdbcTemplate jdbc, Instant start) {
        for (boolean during : new boolean[]{true, false}) {
            List<Double> d = jdbc.queryForList("""
                    SELECT TIMESTAMPDIFF(MICROSECOND, o.created_at, n.sent_at) / 1e6 FROM orders o
                      JOIN notifications n ON n.user_id = o.buyer_id AND n.type = 'ORDER_PLACED' AND n.status = 'SENT'
                     WHERE o.buyer_id >= ? AND o.buyer_id < ? AND (o.created_at >= ? AND o.created_at < ?) = ?""", Double.class,
                    BUYER, BUYER + 100_000, Timestamp.from(start.plusSeconds(20)), Timestamp.from(start.plusSeconds(80)), during);
            if (d.isEmpty()) continue;
            Collections.sort(d);
            System.out.printf("  通知延遲（訂單建立 → 寄出）%s：%d 封，p50 %.1f 秒、p99 %.1f 秒、最慢 %.1f 秒%n", during ? "，停機期間下的單" : "，其他時間下的單  ",
                    d.size(), d.get(d.size() / 2), d.get((int) (d.size() * 0.99)), d.get(d.size() - 1));
        }
    }

    static String counter(ConfigurableApplicationContext ctx, String consumer) {
        var c = ctx.getBean(io.micrometer.core.instrument.MeterRegistry.class).find("shop.events.duplicates").tag("consumer", consumer).counter();
        return c == null ? "0" : String.valueOf((long) c.count());
    }

    static double p99(List<Sample> s) {
        if (s == null || s.isEmpty()) return 0;
        long[] l = s.stream().mapToLong(Sample::nanos).sorted().toArray();
        return l[(int) (l.length * 0.99)] / 1e6;
    }

    static String statuses(List<Sample> s) {
        if (s == null) return "—";
        Map<Integer, Integer> m = new TreeMap<>();
        for (Sample x : s) m.merge(x.status(), 1, Integer::sum);
        return m.toString();
    }

    static void cleanup(JdbcTemplate jdbc, StringRedisTemplate redis) {
        long lo = BUYER, hi = BUYER + 100_000;
        jdbc.update("DELETE n FROM notifications n JOIN orders o ON o.id = n.payload->>'$.aggregateId' WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM notifications WHERE user_id >= ? AND user_id < ?", lo, hi);
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM cart_items WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        for (long id : new long[]{HOT, NORMAL}) {
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", id);
            jdbc.update("DELETE FROM products WHERE id = ?", id);
            TestRedis.forgetProducts(redis, id);
        }
    }

    /** docker 指令 */
    static final class H1Docker {
        static void run(String... args) throws Exception {
            List<String> cmd = new ArrayList<>(List.of("docker"));
            cmd.addAll(List.of(args));
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            p.getInputStream().readAllBytes();
            p.waitFor();
        }
    }
}
```

**`src/test/java/com/example/shop/ch07/H6bPauseDiagnoseTest.java`**（7.9.1、7.9.2）

```java
package com.example.shop.ch07;

import com.example.shop.ShopApplication;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 7.9 docker pause 的時候，連線池為什麼被用光？每秒 10 張一般訂單 + 每秒 50 次商品詳情，第 5 秒 pause RabbitMQ，
 * 第 25 秒把整個 JVM 的執行緒堆疊取下來：拿著（或等著）資料庫連線的執行緒，卡在哪一行？同時看 MySQL 那一側 shop 的連線在做什麼。
 */
@Tag("experiment")
class H6bPauseDiagnoseTest {

    static final long NORMAL = 9_907_611, BUYER = 3_761_000;
    static final JdbcTemplate ROOT = new JdbcTemplate(new DriverManagerDataSource(
            "jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true", "root", "root"));

    @Test
    void whereAreTheThreads() throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--shop.order.jobs-enabled=false",
                "--shop.inventory.jobs-enabled=false", "--shop.messaging.relay-enabled=true", "--shop.messaging.consumers-enabled=true",
                "--spring.main.banner-mode=off", "--logging.level.root=ERROR")) {
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            jdbc.update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");
            // 第一版只把 inventory 歸零（ON DUPLICATE KEY UPDATE reserved = 0），沒有刪上一次的訂單與預留、結束時也不清：
            // 跑過兩次之後 reserved 比有效預留少 109，下一次全套測試的 INV-2 紅了（7.13）
            cleanup(jdbc, ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class));
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, 'H6b', 100.00, 'ON_SALE')", NORMAL);
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", NORMAL);
            var hikari = ((com.zaxxer.hikari.HikariDataSource) ctx.getBean(javax.sql.DataSource.class)).getHikariPoolMXBean();
            HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(32)).build();
            String base = "http://localhost:" + port;
            AtomicLong buyers = new AtomicLong(BUYER);
            ConcurrentHashMap<String, Integer> statuses = new ConcurrentHashMap<>();
            ScheduledExecutorService load = Executors.newScheduledThreadPool(2);
            load.scheduleAtFixedRate(() -> {
                long b = buyers.getAndIncrement();
                http.sendAsync(HttpRequest.newBuilder(URI.create(base + "/api/orders")).timeout(java.time.Duration.ofSeconds(10))
                        .header("Authorization", TestTokens.bearer(ctx, b)).header("Idempotency-Key", "h6b-" + b).header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + NORMAL + ",\"quantity\":1,\"unitPrice\":100}]}")).build(),
                        HttpResponse.BodyHandlers.discarding()).whenComplete((r, e) -> statuses.merge("下單 " + (r == null ? 0 : r.statusCode()), 1, Integer::sum));
            }, 0, 100, TimeUnit.MILLISECONDS);
            load.scheduleAtFixedRate(() -> http.sendAsync(HttpRequest.newBuilder(URI.create(base + "/api/products/" + NORMAL)).timeout(java.time.Duration.ofSeconds(10)).build(),
                    HttpResponse.BodyHandlers.discarding()).whenComplete((r, e) -> statuses.merge("詳情 " + (r == null ? 0 : r.statusCode()), 1, Integer::sum)), 0, 20, TimeUnit.MILLISECONDS);
            Thread.sleep(5000);
            H6RabbitOutageDrillTest.H1Docker.run("pause", "shop-rabbitmq-1");
            try {
                Thread.sleep(20_000);
                System.out.printf("═══ 7.9 pause 之後 20 秒：連線池 使用中 %d、閒置 %d、等連線的執行緒 %d ═══%n",
                        hikari.getActiveConnections(), hikari.getIdleConnections(), hikari.getThreadsAwaitingConnection());
                Map<String, List<String>> groups = new TreeMap<>();
                for (var e : Thread.getAllStackTraces().entrySet()) {
                    StackTraceElement[] st = e.getValue();
                    String where = Arrays.stream(st).filter(f -> f.getClassName().startsWith("com.example.shop") && !f.getClassName().contains("ch07"))
                            .findFirst().map(f -> f.getClassName().replaceAll(".*\\.", "") + "." + f.getMethodName() + ":" + f.getLineNumber()).orElse(null);
                    if (where == null) continue;
                    String top = st.length == 0 ? "" : st[0].getClassName().replaceAll(".*\\.", "") + "." + st[0].getMethodName();
                    String blocking = Arrays.stream(st).map(f -> f.getClassName()).filter(c -> c.startsWith("com.zaxxer") || c.startsWith("com.rabbitmq") || c.startsWith("org.springframework.amqp") || c.startsWith("com.mysql"))
                            .findFirst().map(c -> c.replaceAll("^(com\\.zaxxer|com\\.rabbitmq|org\\.springframework\\.amqp|com\\.mysql).*", "$1")).orElse("—");
                    groups.computeIfAbsent(where + " │ 最上面：" + top + " │ 經過：" + blocking, k -> new ArrayList<>()).add(e.getKey().getName());
                }
                groups.entrySet().stream().sorted((a, b) -> b.getValue().size() - a.getValue().size()).limit(12)
                        .forEach(g -> System.out.printf("  %3d 條  %s（例：%s）%n", g.getValue().size(), g.getKey(), g.getValue().get(0)));
                System.out.println("  ── MySQL：shop 的連線 ──");
                ROOT.query("""
                        SELECT p.COMMAND, COALESCE(p.STATE, ''), COALESCE(LEFT(p.INFO, 50), '—'), (t.trx_id IS NOT NULL) AS in_trx, COUNT(*)
                          FROM information_schema.PROCESSLIST p LEFT JOIN information_schema.INNODB_TRX t ON t.trx_mysql_thread_id = p.ID
                         WHERE p.USER = 'shop' GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC""",
                        rs -> { System.out.printf("  %3d 條  %s │ %s │ %s │ 交易中 %s%n", rs.getInt(5), rs.getString(1), rs.getString(2), rs.getString(3), rs.getBoolean(4)); });
                System.out.println("  這 25 秒的回應：" + new TreeMap<>(statuses));
            } finally {
                H6RabbitOutageDrillTest.H1Docker.run("unpause", "shop-rabbitmq-1");
                load.shutdownNow();
            }
            Thread.sleep(15_000);
            cleanup(jdbc, ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class));
        }
    }

    static void cleanup(JdbcTemplate jdbc, org.springframework.data.redis.core.StringRedisTemplate redis) {
        long lo = BUYER, hi = BUYER + 100_000;
        jdbc.update("DELETE FROM notifications WHERE user_id >= ? AND user_id < ?", lo, hi);
        for (String t : List.of("order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", NORMAL);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", NORMAL);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", NORMAL);
        jdbc.update("DELETE FROM products WHERE id = ?", NORMAL);
        com.example.shop.support.TestRedis.forgetProducts(redis, NORMAL);
    }
}
```

**`src/test/java/com/example/shop/ch07/H6cStartupUnderPauseTest.java`**（7.9.4）

```java
package com.example.shop.ch07;

import com.example.shop.ShopApplication;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.AmqpAdmin;
import org.springframework.amqp.core.QueueInformation;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Arrays;
import java.util.concurrent.CompletableFuture;
import java.util.function.Predicate;

/**
 * 7.9.4：RabbitMQ 被 docker pause 的時候啟動一個實例，起得來嗎？
 * 每 2 秒取一次啟動執行緒的堆疊（最多 60 秒）；起來了就看 readiness；然後 unpause，量消費者多久接上。
 *
 *   mvn test -Pexperiments -Dtest=H6cStartupUnderPauseTest
 */
@Tag("experiment")
class H6cStartupUnderPauseTest {

    static final String PROBE_QUEUE = "shop.notification.order-events";

    @Test
    void startupWhileBrokerPaused() throws Exception {
        H6RabbitOutageDrillTest.H1Docker.run("pause", "shop-rabbitmq-1");
        long unpausedAt = 0;
        long s = System.nanoTime();
        CompletableFuture<ConfigurableApplicationContext> app = new CompletableFuture<>();
        Thread starter = new Thread(() -> {
            try {
                app.complete(new SpringApplicationBuilder(ShopApplication.class).run(H6RabbitOutageDrillTest.args(0)));
            } catch (Throwable e) {
                app.completeExceptionally(e);
            }
        }, "h6c-starter");
        try {
            System.out.println("═══ 7.9.4 RabbitMQ 被 pause 的時候啟動，每 2 秒取一次啟動執行緒的堆疊（最多 60 秒）═══");
            starter.setDaemon(true);
            starter.start();
            while (!app.isDone() && secs(s) < 60) {
                Thread.sleep(2_000);
                if (!app.isDone()) System.out.printf("  %5.1f 秒 │ %s%n", secs(s), describe(starter.getStackTrace()));
            }
            if (!app.isDone()) {
                System.out.println("  60 秒內沒有啟動完成");
                return;
            }
            ConfigurableApplicationContext ctx = app.join();
            System.out.printf("  啟動花了 %,d ms（RabbitMQ 還是 pause 的）%n", (System.nanoTime() - s) / 1_000_000);
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            var r = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/actuator/health/readiness")).build(),
                    HttpResponse.BodyHandlers.ofString());
            System.out.println("  readiness HTTP " + r.statusCode() + " " + r.body());

            H6RabbitOutageDrillTest.H1Docker.run("unpause", "shop-rabbitmq-1");
            unpausedAt = System.nanoTime();
            AmqpAdmin admin = ctx.getBean(AmqpAdmin.class);
            int consumers = 0;
            while (secs(unpausedAt) < 120) {
                try {
                    QueueInformation q = admin.getQueueInfo(PROBE_QUEUE);
                    consumers = q == null ? 0 : q.getConsumerCount();
                } catch (RuntimeException e) {
                    consumers = 0;
                }
                if (consumers > 0) break;
                Thread.sleep(500);
            }
            System.out.printf("  unpause 之後 %.1f 秒：%s 的消費者 %d 個%n", secs(unpausedAt), PROBE_QUEUE, consumers);
            ctx.close();
        } finally {
            if (unpausedAt == 0) H6RabbitOutageDrillTest.H1Docker.run("unpause", "shop-rabbitmq-1");
        }
    }

    static double secs(long since) { return (System.nanoTime() - since) / 1e9; }

    /** 最上面的一個 frame、最上面的 RabbitMQ／Spring AMQP frame、最上面的 com.example frame */
    static String describe(StackTraceElement[] st) {
        if (st.length == 0) return "（沒有堆疊）";
        String rabbit = first(st, f -> f.getClassName().startsWith("com.rabbitmq") || f.getClassName().startsWith("org.springframework.amqp"));
        String ours = first(st, f -> f.getClassName().startsWith("com.example.shop"));
        return "最上面：" + frame(st[0]) + " │ RabbitMQ：" + rabbit + " │ 我們的：" + ours;
    }

    static String first(StackTraceElement[] st, Predicate<StackTraceElement> p) {
        return Arrays.stream(st).filter(p).findFirst().map(H6cStartupUnderPauseTest::frame).orElse("—");
    }

    static String frame(StackTraceElement f) {
        String c = f.getClassName();
        return c.substring(c.lastIndexOf('.') + 1) + "." + f.getMethodName() + ":" + f.getLineNumber();
    }
}
```

**`src/test/java/com/example/shop/ch07/H7RelayIntervalTest.java`**（7.4.3）

```java
package com.example.shop.ch07;

import com.example.shop.ShopApplication;
import com.example.shop.ordering.OrderingApi;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.distribution.ValueAtPercentile;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.math.BigDecimal;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * 7.4.3 relay 多久輪一次？三種間隔，同樣的流量（每秒 20 張一般商品的訂單、20 秒）：
 *   commit → broker 確認（shop.outbox.publish_delay）
 *   commit → 通知寄出（shop.events.lag{consumer=notification.order-events}）
 *   沒有任何訂單的時候，MySQL 每秒收到幾句（relay 輪詢的成本）
 */
@Tag("experiment")
class H7RelayIntervalTest {

    static final long PRODUCT = 9_907_701, FIRST_BUYER = 3_770_000;

    static double pct(Timer t, double p) {
        for (ValueAtPercentile v : t.takeSnapshot().percentileValues()) if (v.percentile() == p) return v.value(TimeUnit.MILLISECONDS);
        return Double.NaN;
    }

    static long questions(JdbcTemplate root) {
        return Long.parseLong(root.queryForMap("SHOW GLOBAL STATUS LIKE 'Questions'").get("Value").toString());
    }

    @Test
    void intervals() throws Exception {
        JdbcTemplate root = new JdbcTemplate(new DriverManagerDataSource("jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true", "root", "root"));
        System.out.println("═══ 7.4.3 relay 的輪詢間隔：每秒 20 張訂單、20 秒 ═══");
        for (int round = 0; round < 2; round++)
            for (String interval : List.of("10ms", "100ms", "1s")) {
                try (var ctx = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE).run("--shop.order.jobs-enabled=false",
                        "--shop.inventory.jobs-enabled=false", "--shop.messaging.relay-enabled=true", "--shop.messaging.consumers-enabled=true",
                        "--shop.messaging.relay-interval=" + interval, "--spring.main.banner-mode=off", "--logging.level.root=ERROR")) {
                    JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
                    OrderingApi ordering = ctx.getBean(OrderingApi.class);
                    MeterRegistry meters = ctx.getBean(MeterRegistry.class);
                    cleanup(jdbc);
                    jdbc.update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");   // 別的測試留下的（7.12.1）
                    jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, 'H7', 100.00, 'ON_SALE')", PRODUCT);
                    jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", PRODUCT);
                    Thread.sleep(3000);                                     // 啟動完成、listener 都連上
                    long q0 = questions(root);
                    Thread.sleep(5000);
                    double idle = (questions(root) - q0) / 5.0;
                    long start = System.nanoTime();
                    for (int i = 0; i < 400; i++) {                         // 每秒 20 張
                        while (System.nanoTime() < start + i * 50_000_000L) Thread.sleep(1);
                        ordering.placeOrder(FIRST_BUYER + i, "h7-" + i, List.of(new OrderingApi.OrderLine(PRODUCT, 1, new BigDecimal("100"))));
                    }
                    Thread.sleep(3000);
                    Timer publish = meters.find("shop.outbox.publish_delay").timer();
                    Timer lag = meters.find("shop.events.lag").tag("consumer", "notification.order-events").timer();
                    System.out.printf("  每 %-5s │ commit → broker 確認 p50 %6.1f  p99 %6.1f  最慢 %6.1f ms │ commit → 通知寄出 p50 %6.1f  p99 %6.1f ms │ 沒有訂單時 MySQL %5.1f 句/秒%n",
                            interval, pct(publish, 0.5), pct(publish, 0.99), publish.max(TimeUnit.MILLISECONDS),
                            pct(lag, 0.5), pct(lag, 0.99), idle);
                    cleanup(jdbc);
                }
            }
    }

    static void cleanup(JdbcTemplate jdbc) {
        long lo = FIRST_BUYER, hi = FIRST_BUYER + 10_000;
        jdbc.update("DELETE n FROM notifications n JOIN orders o ON o.id = n.payload->>'$.aggregateId' WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM notifications WHERE user_id >= ? AND user_id < ?", lo, hi);
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM cart_items WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
    }
}
```

**`src/test/java/com/example/shop/ch07/H7bIdlePollTest.java`**（7.4.3）

```java
package com.example.shop.ch07;

import com.example.shop.ShopApplication;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * 7.4.3 沒有任何訂單的時候，relay 的一輪送給 MySQL 哪幾句？用 general log 錄 2 秒（relay 每 100 ms 一輪）。
 */
@Tag("experiment")
class H7bIdlePollTest {

    @Test
    void whatDoesOnePollSend() throws Exception {
        JdbcTemplate root = new JdbcTemplate(new DriverManagerDataSource("jdbc:mysql://localhost:3306/mysql?useSSL=false&allowPublicKeyRetrieval=true", "root", "root"));
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE).run("--shop.order.jobs-enabled=false",
                "--shop.inventory.jobs-enabled=false", "--shop.messaging.relay-enabled=true", "--shop.messaging.consumers-enabled=false",
                "--spring.main.banner-mode=off", "--logging.level.root=ERROR")) {
            ctx.getBean(JdbcTemplate.class).update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");
            Thread.sleep(3000);
            root.execute("TRUNCATE TABLE mysql.general_log");
            root.execute("SET GLOBAL log_output = 'TABLE'");
            root.execute("SET GLOBAL general_log = 'ON'");
            Thread.sleep(2000);
            root.execute("SET GLOBAL general_log = 'OFF'");
            System.out.println("═══ 7.4.3 沒有訂單的 2 秒，shop 送給 MySQL 的句子（relay 每 100 ms 一輪）═══");
            root.query("""
                    SELECT COUNT(*), LEFT(REGEXP_REPLACE(CONVERT(argument USING utf8mb4), '\\\\s+', ' '), 110) AS q FROM mysql.general_log
                     WHERE command_type = 'Query' AND user_host LIKE 'shop%' GROUP BY q ORDER BY 1 DESC""",
                    rs -> { System.out.printf("  %4d  %s%n", rs.getInt(1), rs.getString(2)); });
            root.execute("TRUNCATE TABLE mysql.general_log");
        }
    }
}
```

**`src/test/java/com/example/shop/ch07/H8FlushDuringSaleTest.java`**（7.6.3）

```java
package com.example.shop.ch07;

import com.example.shop.ShopApplication;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.shared.error.ShopException;
import com.example.shop.support.TestRedis;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.util.*;
import java.util.concurrent.*;

/**
 * 7.6.3 Redis 的資料丟了（6.13.2 練習二）：搶購進行到第 1 秒，FLUSHALL。
 * 第 06 章：閘門的 key 不見 → 下一個請求從 MySQL 的可售量重建 → 偏高的那幾件，MySQL 的條件式 UPDATE 當場 409（浪費，但沒人被騙）。
 * 第 07 章：MySQL 的預留在交易之外 —— 偏高的那幾件已經回了 201，要到落帳時才發現不夠，訂單被取消（E10）。量它有幾張。
 * 2,000 個買家搶 500 件，每秒 200 個（開放式，200 條共用執行緒 = Tomcat 的 maxThreads，6.9.1）。對照組：不 FLUSHALL。
 */
@Tag("experiment")
class H8FlushDuringSaleTest {

    static final long HOT = 9_907_801, FIRST_BUYER = 3_780_000;
    static final int STOCK = 500, BUYERS = 2_000, RPS = 200;

    @Test
    void flushAll() throws Exception {
        System.out.printf("═══ 7.6.3 %,d 個買家搶 %d 件（每秒 %d 個）；第 1 秒 FLUSHALL ═══%n", BUYERS, STOCK, RPS);
        for (boolean flush : new boolean[]{false, true, true, false, true, true}) run(flush);
    }

    void run(boolean flush) throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE).run("--shop.order.jobs-enabled=false",
                "--shop.inventory.jobs-enabled=false", "--shop.messaging.relay-enabled=true", "--shop.messaging.consumers-enabled=true",
                "--spring.main.banner-mode=off", "--logging.level.root=ERROR")) {
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            StringRedisTemplate redis = ctx.getBean(StringRedisTemplate.class);
            OrderingApi ordering = ctx.getBean(OrderingApi.class);
            cleanup(jdbc, redis);
            jdbc.update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");   // 別的測試留下的（7.12.1）
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, 'H8', 100.00, 'ON_SALE', TRUE)", HOT);
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", HOT, STOCK);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, 0, 'INITIAL', 'h8')", HOT, STOCK);

            ExecutorService pool = Executors.newFixedThreadPool(200);
            ConcurrentHashMap<String, Integer> out = new ConcurrentHashMap<>();
            List<Future<?>> fs = new ArrayList<>();
            long t0 = System.nanoTime();
            boolean[] flushed = {false};
            for (int i = 0; i < BUYERS; i++) {
                long due = t0 + i * 1_000_000_000L / RPS, buyer = FIRST_BUYER + i;
                while (System.nanoTime() < due) Thread.sleep(0, 200_000);
                if (flush && !flushed[0] && System.nanoTime() - t0 >= 1_000_000_000L) {
                    redis.getConnectionFactory().getConnection().serverCommands().flushAll();
                    flushed[0] = true;
                }
                fs.add(pool.submit(() -> {
                    String r;
                    try {
                        ordering.placeOrder(buyer, "h8-" + buyer, List.of(new OrderingApi.OrderLine(HOT, 1, new BigDecimal("100"))));
                        r = "201";
                    } catch (ShopException e) {
                        r = e.type().status().value() + "";
                    } catch (RuntimeException e) {
                        r = e.getClass().getSimpleName().contains("Insufficient") ? "409" : e.getClass().getSimpleName();
                    }
                    out.merge(r, 1, Integer::sum);
                }));
            }
            for (Future<?> f : fs) f.get();
            pool.shutdown();
            long settle = System.nanoTime();                                // 等落帳與取消都做完
            while (System.nanoTime() - settle < 60_000_000_000L && (jdbc.queryForObject(
                    "SELECT COUNT(*) FROM inventory_reservations WHERE product_id = ? AND counted = FALSE AND status IN ('HELD', 'CONFIRMED')", Long.class, HOT) > 0
                    || jdbc.queryForObject("SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL", Long.class) > 0)) Thread.sleep(100);
            Thread.sleep(2000);
            Map<String, Object> end = jdbc.queryForMap("""
                    SELECT (SELECT reserved FROM inventory WHERE product_id = ?) AS reserved,
                           (SELECT COUNT(*) FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i.product_id = ? AND o.status <> 'CANCELLED') AS active,
                           (SELECT COUNT(*) FROM order_status_history h JOIN orders o ON o.id = h.order_id
                             WHERE o.buyer_id >= ? AND o.buyer_id < ? AND h.event = 'STOCK_SHORTAGE') AS shortage_cancelled""",
                    HOT, HOT, FIRST_BUYER, FIRST_BUYER + BUYERS);
            var meters = ctx.getBean(io.micrometer.core.instrument.MeterRegistry.class);
            java.util.function.Function<String, Long> count = n -> { var c = meters.find(n).counter(); return c == null ? 0 : (long) c.count(); };
            System.out.printf("  %-12s 下單 %s │ 落帳之後：有效訂單 %s、reserved %s、回了 201 之後才被取消（E10）%s 張 │ Redis stock = %s │ Redis 失敗 %d 次、跳開 %d 次 │ load %s%n",
                    flush ? "FLUSHALL" : "對照（不清）", new TreeMap<>(out), end.get("active"), end.get("reserved"), end.get("shortage_cancelled"),
                    redis.opsForValue().get("stock:" + HOT), count.apply("shop.redis.failures"), count.apply("shop.redis.trips"), load());
            cleanup(jdbc, redis);
        }
    }

    static String load() {
        try {
            var p = new ProcessBuilder("sysctl", "-n", "vm.loadavg").start();
            return new String(p.getInputStream().readAllBytes()).trim().replaceAll("[{}]", "").trim().split("\\s+")[0];
        } catch (Exception e) {
            return "?";
        }
    }

    static void cleanup(JdbcTemplate jdbc, StringRedisTemplate redis) {
        long lo = FIRST_BUYER, hi = FIRST_BUYER + BUYERS;
        jdbc.update("DELETE n FROM notifications n JOIN orders o ON o.id = n.payload->>'$.aggregateId' WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM notifications WHERE user_id >= ? AND user_id < ?", lo, hi);
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM products WHERE id = ?", HOT);
        TestRedis.forgetProducts(redis, HOT);
    }
}
```

**`src/test/java/com/example/shop/payment/internal/H9AffectedRowsTest.java`**（7.8.2）

```java
package com.example.shop.payment.internal;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * 7.8.2 requestRefund() 只有「新建了退款單」的那一次要發 refund.requested。第 04 章的寫法是 INSERT … ON DUPLICATE KEY UPDATE（no-op）：
 * 它回傳的「影響列數」分得出「新建」與「已經有了」嗎？Connector/J 的預設（CLIENT_FOUND_ROWS）與 useAffectedRows=true 各量一次。
 */
@Tag("experiment")
class H9AffectedRowsTest {

    @Test
    void onDuplicateKeyUpdate() {
        System.out.println("═══ 7.8.2 INSERT … ON DUPLICATE KEY UPDATE k = k 的回傳值 ═══");
        for (String url : new String[]{"jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true",
                "jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true&useAffectedRows=true"}) {
            JdbcTemplate jdbc = new JdbcTemplate(new DriverManagerDataSource(url, "shop", "shop"));
            jdbc.execute("DROP TABLE IF EXISTS lab_h9");
            jdbc.execute("CREATE TABLE lab_h9 (id BIGINT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, v VARCHAR(10), UNIQUE KEY uk (k))");
            String sql = "INSERT INTO lab_h9 (k, v) VALUES (1, 'a') ON DUPLICATE KEY UPDATE k = k";
            int first = jdbc.update(sql), second = jdbc.update(sql);
            int changed = jdbc.update("INSERT INTO lab_h9 (k, v) VALUES (1, 'b') ON DUPLICATE KEY UPDATE v = VALUES(v)");
            System.out.printf("  %-22s 新建 → %d │ 已經有了（沒有改任何值）→ %d │ 已經有了、改了一個值 → %d%n",
                    url.contains("useAffectedRows") ? "useAffectedRows=true" : "預設（本專題的設定）", first, second, changed);
            jdbc.execute("DROP TABLE lab_h9");
        }
    }
}
```

---

## 7.14 常見誤區

**① 「commit 之後再送訊息，就不會送出一件沒有發生的事」**

對，但它會**掉**一件發生了的事。7.2.1：RabbitMQ 停 10 秒，77、78 則「請落帳」只存在 `afterCommit` 那一刻的記憶體裡，然後就沒了。11-messaging/02 的 2.3.2 已經說過：那個窗不是幾十微秒，是「送訊息這件事失敗」的整段期間。**要「一定送得出去」，那件事要先變成一列資料。**

**② 「Outbox 保證只送一次」**

它保證的是 at-least-once。7.2.2：五十次 `kill -9`，一次也沒有遺失；重複是 0～182 則，機器越忙、relay 的一批越大，重複就越多。只送一次是消費者的事（7.5.2）。

**③ 「有 `processed_messages`，消費者就冪等了」**

它只保護**跟它在同一個交易裡**的效果。7.2.3：把金流退款包進去，20 筆退款退了 40 次錢 —— 錢退出去了，交易 rollback，`processed_messages` 那一列也跟著消失。外部效果的冪等要放在**對方**那裡（冪等鍵），或者自己的業務鍵（`notifications.dedup_key`、`refunds.status`）。

**④ 「Redis 偏低就讓對帳補回來，是安全的方向」**

第 06 章是。這一章 7.2.1：落帳訊息掉了，MySQL 的 `reserved` 偏低，對帳把 Redis「補」到跟 MySQL 一致 —— 77 件不存在的庫存被放了出去。**對帳拿來比對的那個「真相」，必須包含所有還在路上的東西**（`GATE_BASE_SQL` 扣掉 `counted = FALSE` 的預留，7.6.2）。

**⑤ 「熱點商品的 MySQL 預留移到交易外，就跟第 06 章一樣安全了」**

MySQL 仍然不會超賣，但「偏高」的代價變了：從「多一句 409」變成「回了 201 之後取消」（7.6.3）。Redis 的資料丟了一次，H8 裡就有 3～83 個人被答應了又反悔。這個代價要被看見（`shop.inventory.hot.shortage`），而不是被假設不存在。

**⑥ 「拓撲寫在程式碼裡，部署就會套用」**

`RabbitAdmin` 只宣告、不刪除。7.5.3：改了 header 的名字，舊的、無條件的綁定還留在 broker 上，修好之後還有 15 份訊息被送錯地方。**拓撲的變更要有一個「拿掉舊的」的步驟**（11-messaging/04 的 4.6.4）。

**⑦ 「headers exchange 的綁定寫了條件，就會照條件比對」**

`x-match = all` 不看 `x-` 開頭的 header（7.5.3 的 H4）。第一版的 `x-shop-target` 讓每一次重試都送回每一個佇列：一個 SMTP 失敗，3.9 秒、209 次重試、281 則死信，**還取消了一張訂單**。

**⑧ 「消費者只會收到自己訂閱的事件」**

只有在拓撲沒有錯的時候。`ordering.stock-shortage` 收到一則送錯的 `order.placed`，`handle()` 只讀 `orderId` —— 一個路由的 bug 變成了一個業務動作。**消費者自己再檢查一次事件類型**（`EVENT_MISROUTED`），成本是一個 `Set.contains`。

**⑨ 「`ON DUPLICATE KEY UPDATE` 回傳 0 就代表已經有了」**

在 Connector/J 的預設設定下不會是 0（7.8.2 的 H9：「新建」與「已經有了」都回 1）。第一次要依賴一個回傳值之前，先量它。

**⑩ 「加一個列舉值只是改一個 CHECK」**

在 10 萬列的 `orders` 上是 2.25～3.61 秒的整表複製，期間不能下單（7.6.3）。這一章因此沒有加新的取消原因。**改 CHECK 的成本跟表的大小成正比，而且不能線上做。**

**⑪ 「測試之間的隔離，Spring 會處理」**

資料庫有交易可以 rollback；佇列裡的訊息沒有。7.12.1：實驗留在佇列裡的一千多則訊息，讓 `EventFlowTest` 三個紅；7.5.3 的第一版裡，上一個測試的通知跑進了下一個測試。

**⑫ 「relay 的輪詢間隔越短越好」**

10 ms 的時候通知的 p99 是 0.17～0.28 秒，但沒有任何訂單時，每台機器每秒仍然送 388～399 句給 MySQL（7.4.3）—— 一輪 7 句，真正有用的只有 1 句。0.6.4 要的是 60 秒。**間隔是延遲與成本的取捨，不是越小越好。**

**⑬ 「出貨只要訂單是 `PICKING` 就可以」**

熱點的落帳還沒完成（`counted = FALSE`），或者落帳失敗、取消的事件還在路上（`RELEASED`）—— 這時候出貨，會出一件帳上不存在的貨（7.6.4）。**狀態機只知道訂單的狀態，不知道庫存的落帳到哪裡了**；`consume()` 自己要擋。

**⑭ 「RabbitMQ 掛了，readiness 還是 UP，所以沒事」**

那是**正在跑的**實例。新啟動的實例要走一遍 `SmartLifecycle.start()`：listener container 的 `start()` 會等它的消費者連上 broker，broker 被凍結的時候它就一直等 —— 60 秒起不來（7.9.4）。`stop` 的時候不會，所以只演練 `stop` 看不到它。**「依賴掛了照常服務」要包含「依賴掛著的時候，能不能部署、能不能擴容、被殺掉之後能不能重啟」。**

---

## 7.15 本章小結

**這一章建立了六件事**：

1. **一個 Outbox**（7.4）：事件跟業務寫入同一個交易；relay「認領 → 送出 → 標記」三段分開，送出的時候手上沒有資料庫的鎖；等 confirm 與 return、只標確認了的。`kill -9` 五十次，遺失 0；重複 0～182 則，每一次都落在死掉的行程的租約裡（7.2.2）。
2. **一個不碰 broker 的消費端**（7.5）：模組只寫 `EventHandler`；冪等分成兩種 —— 效果在 MySQL 裡的用 `processed_messages`、效果在外面的用對方的冪等鍵或自己的業務鍵；重試交給 broker 的 TTL 階梯；死信看得到、放得回去。
3. **熱點商品的落帳移出下單交易**（7.6）：下單只寫預留列（`counted = FALSE`），消費者在 commit 之後計入；對帳、INV-2、出貨都知道「還沒計入」這件事；落帳失敗有 E10。熱點那一列的列鎖等待，總時間少了 4 到 20 倍；p99 < 500 ms 在機器閒的時候 6 輪裡達成 5 輪，忙的時候還是秒級（7.6.6）。
4. **0.5.4 的右欄，一格一格**（7.7、7.8）：通知（dedup_key ＋ 認領）、退款（交易外、冪等鍵、`FAILED` ＋ 告警）。從第 04 章就停在 `PENDING` 的退款，第一次真的退出去了。
5. **一次 RabbitMQ 的停機演練**（7.9）：0.6.3 那一欄，最後兩次逐格對上；途中抓到 relay 在交易裡等 broker（7.9.1）與新的實例起不來（7.9.4），各修了一次。
6. **驗收 Q9、Q10、Q11 變綠**（7.11）：`Skipped` 從 4 變成 1。

**以及這一章自己抓到的**：一場由 headers exchange 引起的重試風暴（取消了一張訂單）、一個不會被部署拿掉的舊綁定、一個在預設設定下永遠是 1 的回傳值、一個會整表複製的 CHECK、一個拿著間隙鎖等網路的 relay、一個 broker 凍結時起不來的消費端 —— 它們都不在任何一份需求文件裡，都是端到端跑起來才看到的。

**如果這一章只能記一句話**：

> **「commit 之後要做的事」必須先變成一列資料，然後被至少做一次；「只做一次」是每一個消費者自己的責任，而且要放在效果發生的那個地方。**

### 7.15.1 驗收清單

做得到才往下走：

- [ ] 跑完 H1，說出 naive 的 77 件超賣是哪兩個機制疊出來的，以及為什麼 MySQL 的每一條不變量都沒有響。
- [ ] 說出 relay 一輪的四個步驟，以及「at-least-once 的重複」是在哪兩步之間產生的（7.4.2）；跑 H2，看你的機器上有沒有量到重複。
- [ ] 跑完 H3，說出 ② 為什麼跟 ① 一樣退了兩次錢。
- [ ] 說出五個消費者各自靠什麼冪等（7.5.1 的表），以及哪一個的冪等有一個擋不住的窗（7.7.2）。
- [ ] 把 `RabbitTopology.TARGET_HEADER` 改回 `x-shop-target`、刪掉 `EVENT_MISROUTED` 那一段，跑 `EventFlowTest.mailerDownDeadLetters`，看那張訂單被誰取消（記得之後刪掉舊的綁定）。
- [ ] 用 `docker exec shop-rabbitmq-1 rabbitmqctl list_bindings` 找出你的 broker 上有沒有「程式碼裡已經沒有」的綁定。
- [ ] 說出 `GATE_BASE_SQL` 比第 06 章多扣的那一項是什麼、不扣會怎樣（7.6.2、7.2.1）。
- [ ] 跑 H8，說出「偏高」在第 06 章與第 07 章的代價各是什麼。
- [ ] 說出為什麼這一章沒有新增 `STOCK_SHORTAGE` 這個取消原因（7.6.3），以及代價。
- [ ] 讓模擬的 SMTP 停掉，下一張訂單，等它進死信；修好之後用 `POST /api/admin/dead-letters/notification.order-events/replay` 放回去。
- [ ] `docker stop shop-rabbitmq-1`，下單、看 `outbox_events` 堆積；`docker start`，看它被送完。
- [ ] `mvn clean verify` 顯示 `Tests run: 178, Failures: 0, Errors: 0, Skipped: 1`。

### 7.15.2 本章練習

**練習一（30 分鐘）：快取的修復改走事件**

6.4.2 的 `ProductCache.pendingEvictions` 只在記憶體裡。仿照 7.6.5，讓改商品的交易寫一個 `product.changed`，由 `catalog` 的消費者把最新版本寫進快取（`SET_IF_NEWER` 本來就冪等）。Redis 掛了 60 秒，這個消費者會在 31 秒後進死信 —— 你要它進死信，還是要一條更長的重試階梯？兩者各要付什麼？

**練習二（30 分鐘）：排行改成事件驅動**

6.8.2 說「排行 +1 與訂單成立是兩個寫入，要做對需要 Outbox」。現在有了：讓一個消費者收 `order.placed`、`ZINCRBY trending:{yyyyMMddHH}`。`ZINCRBY` 不冪等 —— 用 `processed_messages` 擋得住嗎？（提示：它跟 7.6.5 的 `INCRBY` 是同一種情況。）用 H2 的 `kill -9` 量排行會不會多算。

**練習三（20 分鐘）：通知的順序**

用 `x-single-active-consumer`（11-messaging/05 的 5.5.5）讓 `notification.order-events` 一次只有一個消費者在處理。「訂單已取消」還會比「訂單成立」先寄嗎？吞吐掉了多少？

**練習四（40 分鐘）：重複的信**

7.7.2 承認「寄出去了、標 `SENT` 之前死掉」會寄兩封。設計一個實驗量它：讓 `SimulatedMailer.send()` 之後 `kill -9`（子行程，參考 Q9）。一百次裡寄了幾封兩次？把 `SENT` 的那一句搬到寄信之前（「先標再寄」），結果變成什麼？那是哪一種錯？

**練習五（進階，60 分鐘）：叫醒 relay**

7.4.3 的 relay 是輪詢的。讓寫入端在 commit 之後（`afterCommit`）叫醒 relay 立刻跑一輪，輪詢間隔拉長到 1 秒當備援。重跑 H7：commit → 寄出的 p99 與閒置時的 MySQL 句數各變成多少？**行程在 commit 之後、叫醒之前死掉，會掉事件嗎？**

**練習六（進階，半天）：Kafka 版**

README 的延伸挑戰。照 Q11 印出的那份清單，把 `shared.messaging.internal` 換成 Kafka（11-messaging/07～10）：重試主題取代 retry 佇列、DLT 取代死信佇列。哪幾個 `EventHandler` 需要改？（答案應該是 0 個。）

**練習七（進階，60 分鐘）：消費者的連線池**

7.6.6 的取樣裡，通知的消費者在搶購期間佔了大量的連線時間，而它用的是跟下單同一個 20 條的池子。給消費者一個自己的 `DataSource`（例如 5 條）與自己的交易管理器，讓 `EventDispatcher` 與消費者用它（6.9.1 的艙壁）。重跑 H5：下單的 p99、落帳完成的時間各變成多少？通知的三句合成一個交易，又差多少？

**練習八（20 分鐘）：未計入的熱點預留**

7.10 的那一句每 30 秒全表掃描一次（30 萬列、141 ms）。用 `C8IndexWriteCostTest`（2.7）的方法量：加一個 `(counted, created_at)` 的索引，下單的寫入慢多少？那一句快多少？還是乾脆不要這個指標？

**練習九（20 分鐘）：traceId 跨過 broker**

`outbox_events.trace_id` 與訊息的 `traceId` header 都已經在了，但沒有人放東西進 MDC。照 11-messaging/10 的 10.3，讓消費者把它放回 MDC、處理完清掉。這是驗收 Q7 的一部分（第 09 章）。

---

## 7.16 下一章預告

這一章的每一個實驗都在同一台機器上，跟一台 `docker compose` 起來的 MySQL、Redis、RabbitMQ 對打 —— 而這台機器的 load average 在 4 到 30 之間跳。7.12.1 花了一整節處理「測試之間共用同一台 broker」：預設關掉消費者、`InlineEvents`、開始之前清佇列、`@DirtiesContext`。`mvn clean test` 也從第 06 章的 3 分 07 秒（這一章當天重跑；6.11 那一次是 2 分 51 秒）變成 4 分 22 秒。

**熱點 p99 < 500 ms，這一章部分達成了：** 機器閒的時候 6 輪裡 5 輪，機器忙的時候還是秒級。熱點那一列不再是主要的瓶頸（7.6.6 的列鎖等待少了 4 到 20 倍），剩下的時間花在 commit 與 20 條連線上 —— 那跟這台機器的條件分不開。第 06 章 6.4.5 說「要用獨立行程的壓測工具重量」，這一章的三組 H5 是同一句話的理由；7.9.5 的熱點 503 也一樣，只在最忙的那一次出現。

下一章（08）是**測試與品質**：

- **Testcontainers**：每一次建置自己起一台 MySQL、Redis、RabbitMQ —— 7.12.1 那些「讓測試不互相干擾」的規矩，有一半可以拿掉。
- **獨立行程的壓測工具**：第 06 章 6.4.5、6.9.2 與這一章的 H5、H6，壓測的客戶端都跟伺服器擠在同一個 JVM（或同一台機器）裡。
- **覆蓋率門檻**（0.6.8：`ordering`、`inventory`、`payment` ≥ 85%）與 **CI**。

這一章讓每一件「之後要做的事」都不會掉；下一章讓「它們都還是對的」這件事，不需要靠一台很吵的筆電來證明。
