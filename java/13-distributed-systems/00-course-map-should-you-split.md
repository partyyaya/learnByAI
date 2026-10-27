# 第 00 章：課程地圖與該不該拆

> **上一站**：[12-capstone](../12-capstone/) 的終點是一個模組化單體。九個模組、一個 jar、一個資料庫；`ModuleBoundaryTest` 守著模組之間誰能呼叫誰，每個模組只能碰自己的表（第 12 站 1.6），應用程式的資料庫帳號只拿得到每個模組替自己授權的那幾張表（12 站 9.11）。226 個測試、一個命令起得來、出事會叫醒人。
>
> **這一章**：把那個單體的庫存模組**真的切出去** —— 同一份程式碼，跑成兩個行程、用兩個資料庫，下單時的 `inventory.reserve()` 變成一次 HTTP 呼叫 —— 然後量它付出什麼。量完之後再回答這一站的核心問題：**該不該拆。** 答案多半是「不該」，這一章要讓你說得出為什麼，而且是用數字說。
>
> **你手上會有**：一個從第 12 站專案開出來的分支，裡面有一套「切開」的實驗支架（全部在 `src/test`，正式程式碼一行都沒改）、五個實驗（K1～K5）、一支量「變更耦合」的腳本。之後九章都從這個分支往下做。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 說出拆分的**四項代價**（延遲、一致性、可用性與故障傳遞、除錯與維運），每一項都附上這一章量到的一個數字（0.2）。
- 解釋為什麼「切開之後延遲只多 3 ms」不代表拆分很便宜：**每項一次的呼叫寫法、吞吐、以及沒有被量到的真實網路**（0.2.1）。
- 指出 `@Transactional` 在服務的邊界上停止的那一行程式碼，並說出它造成的兩種不一致（失敗之後、逾時之後），以及為什麼**冪等鍵擋得住重複的訂單、擋不住重複的預留**（0.2.2）。
- 解釋「一個服務慢，另一個服務裡無關的 API 也倒」的機制：**遠端呼叫發生在本地交易裡，等待的時間全部佔著資料庫連線**（0.2.3）。
- 說出拆分的四個**正當理由**，以及三個常見的**錯的理由**（0.3.1、0.3.2）。
- 用 git 歷史量自己專案的**變更耦合**，並用它判斷一刀切在哪裡會痛（0.3.3）。
- 用康威定律解釋「團隊的形狀決定系統的形狀」，以及它對「該不該拆」的意義（0.4）。
- 說明為什麼**模組化單體**是多數團隊的終點，以及「先拆模組、再拆行程」的順序（0.5）。
- 舉出三個「拆了之後更慘、又合回去」的公開案例，並說出每一個合回去的理由（0.6）。
- 從第 12 站的專案開出本站的分支，跑起 0.2 的五個實驗（0.7）。

---

## 0.2 先看見痛：把庫存切出去

這一站的教材是你在第 12 站做出來的訂單系統。它已經是「模組化」的：`ordering` 只能透過 `InventoryApi` 改變庫存，不能碰 `inventory` 的表（12 站 1.4、1.6）。照「微服務」的說法，邊界已經畫好了，切出去只是把 `InventoryApi` 的實作從「本地呼叫」換成「HTTP 呼叫」而已。

這一節就這樣做，然後量。

> 📌 **第 12 站 1.2.3 做過一次縮小版。** 它把同一個 `InventoryApi` 包成 HTTP 端點，在**同一個 JVM、同一台 MySQL、同一個資料庫**裡比「方法呼叫」與「HTTP 呼叫」：一次查詢多 0.24 ms，1,000 筆下單裡 55 筆在預留之後失敗、留下 55 筆孤兒預留。結論是「拆服務的主要代價不是延遲，而是失去跨模組的交易」。
> 這一節把它做成真的：**兩個 JVM、兩個資料庫**（孤兒再也不能用一句 SQL 找出來）、**真的下單 API**（JWT、冪等鍵、訂單編號、連線池都在路徑上）、**併發**，再加上 1.2.3 的 📌 列了、但沒有量的那幾種：逾時、重送、遠端變慢。

### 0.2.0 這一章共用的場景

```
            一個行程（第 12 站）                               切開
  ┌──────────────────────────────────┐      ┌───────────────────────────┐   HTTP   ┌──────────────────────────┐
  │ ShopApplication                   │      │ 訂單服務                   │ ───────▶ │ 庫存服務                  │
  │   PlaceOrderService               │      │   PlaceOrderService        │          │   LabInventoryService     │
  │     └ inventory.reserve()  本地    │      │     └ RemoteInventoryApi   │          │     └ inventory.reserve() │
  │   一個交易：訂單＋預留＋帳＋歷史   │      │   交易：訂單＋歷史＋outbox  │          │   交易：預留＋帳           │
  └──────────────┬───────────────────┘      └─────────────┬─────────────┘          └────────────┬─────────────┘
                 │                                          │                                     │
          shop_d00_mono                              shop_d00_order                         shop_d00_inv
```

**同一份程式碼，兩種部署。** 左邊就是第 12 站的 `ShopApplication`。右邊也是 —— 只是在 `src/test` 多了兩個類別：

- **訂單服務**那一側：`RemoteInventoryApi` 實作 `InventoryApi`、標 `@Primary`，把 `reserve()` 換成一次 HTTP 呼叫；下單流程不會走到的其他方法，照舊交給本地的實作。
- **庫存服務**那一側：`LabInventoryService` 開一支 `POST /lab/inventory/reserve`，收到之後呼叫同一個 `InventoryApi.reserve()`。它跑在**另一個 JVM** 裡，用**另一個資料庫**。

兩個類別都用 `@ConditionalOnProperty` 關著：其他測試的 context 掃得到它們，但不會建立它們。

**訂單服務那一側**的關鍵，只有 `reserve()`：

```java
@Component
@Primary
@ConditionalOnProperty(name = "lab.d00.remote-inventory-url")
class RemoteInventoryApi implements InventoryApi {
    // ……建構子：local = 本地的 jdbcInventoryService；http = RestClient（連線逾時 1 秒、讀取逾時 lab.d00.read-timeout-ms，預設 10 秒）

    @Override
    public void reserve(long orderId, List<ReserveLine> lines) {
        if (perLine) for (ReserveLine l : lines) call(orderId, List.of(l));    // lab.d00.per-line=true：每個品項各呼叫一次
        else call(orderId, lines);                                              // 預設：整張訂單一次
    }

    private void call(long orderId, List<ReserveLine> lines) {
        http.post().uri("/lab/inventory/reserve").body(Map.of("orderId", orderId, "lines", lines))
                .retrieve()
                .onStatus(s -> s.value() == 409, (req, res) -> {               // 庫存不足 → 跟本地一樣丟 InsufficientStockException
                    JsonNode body = new ObjectMapper().readTree(res.getBody());
                    throw new InsufficientStockException(body.get("productId").asLong());
                })
                .toBodilessEntity();
    }
    // ……其他方法照舊交給 local（0.2.3 會改掉其中兩個）
}
```

**庫存服務那一側**：

```java
@PostMapping("/lab/inventory/reserve")
ResponseEntity<?> reserve(@RequestBody ReserveRequest req) throws InterruptedException {
    try {
        tx.executeWithoutResult(s -> inventory.reserve(req.orderId(), req.lines()));   // ← 自己的交易，在這裡就 commit 了
    } catch (InsufficientStockException e) {
        return ResponseEntity.status(409).body(Map.of("productId", e.productId()));
    }
    long d = delayMs;                                   // 0.2.2 ②、0.2.3：模擬「庫存服務變慢了」—— 在 commit 之後才等
    if (d > 0) Thread.sleep(d);
    return ResponseEntity.noContent().build();
}
```

（0.2.4 會在這個方法的開頭多收一個 `traceparent` header、多記一行日誌；完整版在 0.9.2。）

注意那一行 `tx.executeWithoutResult`。`InventoryApi.reserve()` 在第 12 站是 `Propagation.MANDATORY` —— 它**必須**在呼叫端的交易裡執行（12 站 1.5.2）。到了另一個行程，呼叫端的交易不存在了，庫存服務只能自己開一個、自己 commit。**這一行就是 0.2.2 的全部來源。**

> ⚠️ **第 12 站的 `SecurityConfig` 對沒有列出的路徑一律 `denyAll`。** 新的端點不在任何一條規則裡 → 401。`LabInventoryService` 另開一條 `SecurityFilterChain`，`securityMatcher("/lab/**")`、`@Order(0)` 排在原本那一條前面。（正式環境裡，服務之間的呼叫一樣要認證 —— 那是第 03 章的事，這一章先不管。）

**實驗支架 `SplitLab`** 負責建資料庫、灌資料、起應用程式：

- `shop_d00_mono`、`shop_d00_order`、`shop_d00_inv` 三個資料庫，由 root 建、把權限給 `shop_migrator`，Flyway 照第 12 站的 25 個 migration 跑一遍 —— 跟驗收 Q6 一樣（12 站 9.11）。**第 12 站的 `shop` 庫一筆都不碰。**
- 1,000 個上架的商品（同一位賣家、單價 100），每個 1,000 萬件庫存 —— 不讓「庫存不足」混進延遲。一個行程的庫兩樣都有；切開之後，**商品**在訂單服務（catalog 還在它身上），**庫存**在庫存服務。
- 訂單服務在測試的 JVM 裡起（`SpringApplicationBuilder`），庫存服務用 `ProcessBuilder` 起**另一個 JVM**，同一個 classpath，埠 18311，日誌寫到 `target/d00-inventory-service.log`。
- 排程、relay、消費者、限流全部關掉（`--shop.order.jobs-enabled=false` 等）；Redis 用 11～13 號 database，跟第 12 站的 0 號分開。
- 下單走 HTTP，跟真的客戶端一樣：JWT 用第 12 站的 `TestTokens`，每一張隨機挑 n 個不同的商品（避開熱點列的鎖競爭）、每一張一個新的買家。

`RemoteInventoryApi`、`LabInventoryService`、`SplitLab` 與五個實驗的完整內容在 0.9.2。

### 0.2.1 代價一：延遲 ★★

三種部署交錯量：一個行程、切開之後整張訂單一次呼叫、切開之後每個品項各呼叫一次。先一張一張送，每種 5 輪 × 100 張，再 16 條執行緒同時送 15 秒 × 2 輪：

```bash
mvn test -Pexperiments -Dtest=K1SplitLatencyTest
```

```
═══ 0.2.1 一張一張送：每種 5 輪 × 100 張、三種部署交錯（load { 4.94 5.57 5.18 }）═══
   1 個品項 │ 一個行程       │ p50  10.42 ms │ p90  13.25 ms │ p99  19.57 ms │ {201=500}
   1 個品項 │ 切開：一次呼叫    │ p50  13.26 ms │ p90  16.73 ms │ p99  24.82 ms │ {201=500}
   1 個品項 │ 切開：每項一次    │ p50  13.27 ms │ p90  17.33 ms │ p99  29.57 ms │ {201=500}
   3 個品項 │ 一個行程       │ p50  12.16 ms │ p90  15.90 ms │ p99  22.13 ms │ {201=500}
   3 個品項 │ 切開：一次呼叫    │ p50  14.74 ms │ p90  24.42 ms │ p99  46.65 ms │ {201=500}
   3 個品項 │ 切開：每項一次    │ p50  19.87 ms │ p90  30.68 ms │ p99  86.96 ms │ {201=500}
  10 個品項 │ 一個行程       │ p50  15.19 ms │ p90  21.27 ms │ p99  44.83 ms │ {201=500}
  10 個品項 │ 切開：一次呼叫    │ p50  17.76 ms │ p90  23.51 ms │ p99  56.74 ms │ {201=500}
  10 個品項 │ 切開：每項一次    │ p50  37.34 ms │ p90  51.60 ms │ p99  87.74 ms │ {201=500}
═══ 0.2.1 16 條執行緒同時送 3 個品項的訂單：每種 15 秒 × 2 輪、交錯（load { 4.48 5.23 5.08 }）═══
  一個行程       │ 11,266 張（每秒   376）│ p50  38.42 ms │ p99  116.53 ms │ {201=11266}
  切開：一次呼叫    │  9,214 張（每秒   307）│ p50  47.47 ms │ p99  149.60 ms │ {201=9214}
  切開：每項一次    │  7,423 張（每秒   247）│ p50  60.11 ms │ p99  137.39 ms │ {201=7423}
  （結束時 load { 10.50 7.28 5.90 }）
```

在機器比較忙的時候（load 8.8～11.2）再跑一次，p50 的樣子一樣：

| | 1 個品項 | 3 個品項 | 10 個品項 | 16 條執行緒：每秒 |
|---|---|---|---|---|
| 一個行程 | 11.63 ms | 12.56 ms | 13.90 ms | 406 張 |
| 切開：一次呼叫 | 14.46 ms | 14.62 ms | 15.61 ms | 344 張 |
| 切開：每項一次 | 14.77 ms | 18.77 ms | 33.31 ms | 282 張 |

三件事：

**一、整張訂單一次呼叫，每一張多 2.5～3 ms。** 單看這個數字，拆分好像很便宜 —— 12 站 0.6.2 的 SLO 是 p99 300 ms，3 ms 是零頭。但這 3 ms 裡有：序列化、一次 HTTP 往返、庫存服務那一側的 Tomcat 與 Spring Security，以及**庫存服務自己的那一次 commit**（`innodb_flush_log_at_trx_commit = 1`，12 站 0.10.1：每一次 commit 都 fsync）—— 一個行程的時候，預留跟訂單是同一次 commit。（這幾項各佔多少，這一章沒有拆開量。）

**二、「每項一次」讓延遲跟品項數一起長。** 10 個品項：一次呼叫 17.8 ms，每項一次 37.3 ms —— 多出來的 20 ms 就是 9 次多餘的往返。這是拆分時最常見的寫法：把 `InventoryApi` 的實作換成遠端的，**呼叫的地方一行都沒改**。第 12 站的 `reserve(orderId, lines)` 本來就收一整個清單，所以這裡改得回來；如果當初的介面是 `reserve(productId, qty)`，在一個行程裡完全看不出問題（本地呼叫一次幾奈秒），切開之後每一張訂單就是 n 次網路往返 —— **介面的粒度，在一個行程裡不重要，在服務的邊界上決定延遲。**（第 03 章。）

**三、吞吐掉得比延遲多。** 16 條執行緒同時送：p50 多 9 ms（38 → 47），每秒的張數掉了 18%（376 → 307）；每項一次掉了 34%。一台機器要同時跑兩個 JVM、兩個 Tomcat、多一倍的序列化與 HTTP 處理 —— 這台筆電的 8 核就那麼多。

> ⚠️ **這是兩個行程在同一台筆電上、走 loopback 的結果。** 真的拆開之後，兩個服務在兩台機器上：每一次呼叫多的是真的網路往返（同一個機房零點幾毫秒、跨可用區一到幾毫秒是一般的經驗值，這一章沒有量），再加上服務之間的 TLS、負載平衡器、服務網格的 sidecar（第 08 章）。反過來，兩個服務不再搶同一顆 CPU。**這一節的數字是延遲代價的下限，吞吐的數字則是「一台機器」的特例** —— 不要拿它們去推正式環境，拿它們看「方向」：多一跳就是多一跳，而且每一種「呼叫的寫法」都會被放大。

### 0.2.2 代價二：一致性 ★★★

第 12 站的下單是**一個交易**：訂單、明細、預留、庫存帳、狀態歷史、冪等鍵、outbox —— 全有或全無（US-ORD-1 AC-5）。`PlaceOrderService.placeInTransaction()` 的順序是：

```
INSERT orders、order_items          ← 訂單編號撞號會在這裡失敗、重試（2.4.4）
inventory.reserve(order.getId(), …)  ← 切開之後：HTTP → 庫存服務 → 它自己的交易 → commit
history.record(…)                    ← 0.2.2 ① 在這裡注入失敗
keys.complete(…)、cart.removeItems(…)、outbox.add(…)
commit
```

`reserve()` 後面還有四步。一個行程的時候，它們任何一步失敗，預留跟著 rollback。切開之後呢？兩種失敗：

**① `reserve()` 之後、commit 之前失敗。** 在兩個部署的訂單資料庫上各加一個 trigger：寫訂單狀態歷史的時候（`reserve()` 的下一步），如果是買家 777777 就丟錯：

```sql
CREATE TRIGGER d00_fail_after_reserve BEFORE INSERT ON order_status_history FOR EACH ROW
BEGIN
  IF (SELECT buyer_id FROM orders WHERE id = NEW.order_id) = 777777 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'd00: injected failure after reserve';
  END IF;
END
```

（用 trigger 而不是改程式碼：失敗發生在跟正式環境一樣的地方 —— 資料庫拒絕了下單交易裡的一句 INSERT —— 而 `PlaceOrderService` 一行都不用動。）

**② 逾時。** 庫存服務預留、commit 之後，**慢 1.5 秒才回應**；訂單服務的 `RestClient` 只等 1 秒。等不到就放棄，下單交易 rollback，回 500。之後客戶端用**同一個 `Idempotency-Key`** 重送 —— 第 12 站 4.8.2 說的「做完了，但對方不知道」，冪等鍵就是為它設計的。

數「沒有訂單的預留」：庫存服務的 `inventory_reservations` 裡，`order_id` 在訂單資料庫找不到的列。

```bash
mvn test -Pexperiments -Dtest=K2SplitConsistencyTest
```

```
═══ 0.2.2 ① reserve() 之後、commit 之前失敗：每種部署 100 張（load { 6.60 6.55 4.98 }）═══
  一個行程   │ 回應 {500=100} │ 這位買家的訂單 0 張 │ 沒有訂單的預留 +0 列 │ reserved +0 件
           第一個回應：{"type":"/problems/internal","title":"系統發生錯誤","status":500,"detail":"系統發生錯誤，請稍後再試","instance":"/api/orders","traceId":"6acc66b9fa00e39abcab07eef2aae6c8"}
  切開     │ 回應 {500=100} │ 這位買家的訂單 0 張 │ 沒有訂單的預留 +300 列 │ reserved +300 件
           第一個回應：{"type":"/problems/internal","title":"系統發生錯誤","status":500,"detail":"系統發生錯誤，請稍後再試","instance":"/api/orders","traceId":"6acc66bbba8ffe871d980cc969f3a4e4"}
═══ 0.2.2 ② 庫存服務 commit 之後慢 1.5 秒才回應，訂單服務只等 1 秒：20 張（load { 6.23 6.48 4.96 }）═══
  第一次送   │ 回應 {500=20} │ 訂單 +0 張 │ 沒有訂單的預留 +60 列 │ reserved +60 件
             第一個回應：{"type":"/problems/internal","title":"系統發生錯誤","status":500,"detail":"系統發生錯誤，請稍後再試","instance":"/api/orders","traceId":"6acc66be9f12b217875b84ab6e872b61"}
  同一個鍵重送 │ 回應 {201=20} │ 訂單 +20 張 │ 沒有訂單的預留 +60 列 │ reserved +120 件
  （結束時 load { 5.39 6.25 4.92 }）
```

**① 的兩行，回應一模一樣。** 使用者看到的都是 500、都沒有訂單。差別只在看不到的地方：一個行程什麼都沒留下；切開之後，**100 張不存在的訂單，各預留了 3 件** —— 300 件庫存被鎖住，沒有人會付款、沒有人會取消、逾時排程也找不到它們（逾時排程掃的是 `orders`，而這些訂單不存在）。

**每一邊各自都是「對的」。** 訂單資料庫：沒有訂單，正確。庫存資料庫：每一筆預留都有對應的帳，`reserved` 等於有效預留的總和 —— 第 12 站 2.5.4 的 INV-2、INV-3 對帳**兩條都會通過**。錯的是兩邊合起來的那件事：「每一筆預留都屬於一張存在的訂單」。上面那句數孤兒的 SQL 是跨兩個資料庫的 JOIN —— 它寫得出來，只因為實驗裡兩個庫在同一台 MySQL 上。真的拆開之後，它們在兩台機器上，**這句 JOIN 不存在**（第 02 章）。

**② 的第二行是這一節最重要的一行。** 第一次送：訂單服務等不到、放棄、rollback、回 500 —— 但庫存服務那邊已經 commit 了，60 列孤兒。客戶端照著第 12 站教的做法，用同一個 `Idempotency-Key` 重送：冪等鍵在第一次失敗時被釋放了（12 站 4.5.1 AC-4：失敗的結果不快取），所以這一次是一張新的訂單、一次新的預留 —— 20 張成立，`reserved` 多了 **120** 件，其中 60 件是孤兒。

> 📌 **冪等鍵擋得住重複的訂單，擋不住重複的預留。** 第 12 站的冪等鍵保護的是「訂單服務自己的交易」：同一個鍵只會成立一張訂單。到了服務的邊界上，訂單服務對庫存服務的呼叫是**另一個**請求，它需要自己的冪等 —— 例如用 `orderId` 當預留的冪等鍵（`uk_reservations_order_product` 本來就是 `(order_id, product_id)`）。但這裡的重送拿到的是**新的** `orderId`（第一次的訂單已經 rollback 了），連這一招都擋不住。**真正的答案不是「再加一個冪等鍵」，而是不要讓「預留」跟「訂單」分屬兩個交易而沒有人負責收尾** —— 那是第 04 章的 Saga 與補償。

> ⚠️ **一個行程的時候，這兩種失敗也會發生，只是沒有後果。** 下單交易在 `reserve()` 之後失敗、資料庫連線在 commit 之前斷掉 —— 第 12 站都遇過（4.8.2 的 503）。差別是：一個交易的失敗，結果只有兩種（全部成立、全部沒有）；兩個交易，結果有四種，其中兩種是不一致的。

### 0.2.3 代價三：一個服務慢，另一個服務倒 ★★★

切開的部署。每秒固定送 20 張下單（**開放式負載**：不管前一張回來沒有，時間到就送下一張 —— 真的使用者不會因為你慢了就少來）；同時每 200 ms 打一次訂單服務的兩支「不下單」的 API：

- **商品詳情** `GET /api/products/{id}`：公開，大部分走 Redis 快取（12 站 6.4）。
- **我的訂單** `GET /api/orders`：要查資料庫。

三段、每段 20 秒：庫存服務正常 → 每一次預留之後慢 3 秒 → 恢復正常。每秒記一次訂單服務的連線池（Hikari 的 `active`、`pending`）。依「送出的時間」分段：慢的那一段送出、恢復之後才回來的請求，算在慢的那一段。

```bash
mvn test -Pexperiments -Dtest=K3SplitCascadeTest
```

```
═══ 0.2.3 庫存服務變慢：訂單服務的其他 API 怎麼了（每秒 20 張下單；load { 5.78 6.50 5.33 }）═══
  正常    │ 下單       │  400 次 │ p50     21.6 ms │ p99     79.2 ms │ max    120.7 ms │ {201=400}
  正常    │ 商品詳情     │   93 次 │ p50      5.9 ms │ p99     25.0 ms │ max     25.0 ms │ {200=93}
  正常    │ 我的訂單     │   93 次 │ p50      5.5 ms │ p99     31.1 ms │ max     31.1 ms │ {200=93}
  慢 3 秒 │ 下單       │  400 次 │ p50   5709.5 ms │ p99  11411.5 ms │ max  11546.7 ms │ {201=208, 503=192}
  慢 3 秒 │ 商品詳情     │   12 次 │ p50      6.9 ms │ p99     13.5 ms │ max     13.5 ms │ {200=12}
  慢 3 秒 │ 我的訂單     │   12 次 │ p50   1862.2 ms │ p99   3007.6 ms │ max   3007.6 ms │ {200=11, 503=1}
  恢復    │ 下單       │  400 次 │ p50     21.7 ms │ p99   1634.9 ms │ max   1745.2 ms │ {201=400}
  恢復    │ 商品詳情     │   85 次 │ p50      5.5 ms │ p99     42.1 ms │ max     42.1 ms │ {200=85}
  恢復    │ 我的訂單     │   85 次 │ p50      4.8 ms │ p99    113.8 ms │ max    113.8 ms │ {200=85}
  連線池（每秒）：
      1 秒 正常    active  1 pending   0
      ……（正常的 20 秒裡，active 0～1、pending 0）
     21 秒 慢 3 秒 active 20 pending   1
     22 秒 慢 3 秒 active 20 pending  23
     23 秒 慢 3 秒 active 20 pending  43
     24 秒 慢 3 秒 active 20 pending  58
     25 秒 慢 3 秒 active 20 pending  78
     ……
     35 秒 慢 3 秒 active 20 pending 153
     ……
     40 秒 慢 3 秒 active 20 pending  90
     41 秒 恢復    active 20 pending 110
     42 秒 恢復    active  2 pending   0
     ……（之後 active 0～1、pending 0）
  （結束時 load { 4.23 5.90 5.19 }）
```

**庫存服務只是「慢」，不是「掛」。** 它每一個請求都成功、都在 3 秒後回應。但訂單服務：

- **連線池在 1 秒內滿了，最多 153 個請求在排隊。** 下單的 HTTP 呼叫發生在**下單交易裡面** —— 從 `INSERT orders` 到 commit，交易一直開著，資料庫連線一直佔著。每秒 20 張 × 每張佔 3 秒 = 需要 60 條連線，連線池只有 20 條（12 站 0.6.2）。
- **一半的下單 503**（192 張）。不是庫存服務回的 —— 是訂單服務自己等不到連線（Hikari 的 `connection-timeout` 3 秒，12 站 0.10.4；日誌裡 196 行 `Connection is not available`）。成立的那 208 張，最慢的等了 11.5 秒。
- **跟庫存完全無關的「我的訂單」也倒了**：p50 從 5.5 ms 變成 1,862 ms，最慢 3 秒、出現 503。它只是要一條連線讀自己的訂單，而連線全部被「等庫存」的交易佔著。
- **商品詳情沒事**：它走 Redis 快取，不需要資料庫連線。

**一恢復，1 秒內全部回來**（42 秒：active 2、pending 0）。這一次沒有留下孤兒預留：192 張 503 都是拿不到連線、還沒走到 `reserve()` 就失敗的（實驗結束後數過，0 列）。

> 📌 **「服務 A 慢」變成「服務 B 倒」，中間只隔了一件事：B 在等 A 的時候佔著什麼。** 這裡佔的是資料庫連線（因為呼叫在交易裡），也可以是 Tomcat 的執行緒、HTTP 客戶端的連線池、記憶體。一個行程的時候，`inventory.reserve()` 也在交易裡 —— 但它是幾毫秒的本地 SQL，不會「慢 3 秒」，就算慢也是同一個資料庫在慢，你的監控看得到。拆開之後，交易裡多了一段**你控制不了長度**的等待。修法有兩層：不要在本地交易裡呼叫遠端服務（第 04 章：Saga 把它們分成兩步），以及逾時、隔艙、熔斷（第 06 章，接 [05-service/06](../05-service/06-async-and-external-api-calls.md)）。

> ⚠️ **只把 `reserve()` 換成遠端呼叫，商品頁會壞。** `RemoteInventoryApi` 如果只換了 `reserve()`、其他方法照舊交給本地的實作，「正常」那一段的商品詳情就全部是 500：
>
> ```
> c.e.s.shared.web.GlobalExceptionHandler  : 未預期的例外
> org.springframework.dao.EmptyResultDataAccessException: Incorrect result size: expected 1, actual 0
> ```
>
> 商品頁要顯示可售量（US-PRD-3 AC-4），可售量是 `InventoryApi.availableForDisplay()` —— 一句本地的 SQL，查訂單服務資料庫裡的 `inventory` 表。切開之後，那張表在庫存服務的資料庫裡，訂單服務這邊是空的。**一個「只讀」的頁面，也多了一個跨服務的依賴。** 修法是讓 `available()` 與 `availableForDisplay()` 也去問庫存服務（`GET /lab/inventory/available`，熱點商品照舊讀 Redis 的副本）—— 上面那段 K3 的輸出是改了之後量的。第 12 站這個查詢有 5 秒的本地快取（12 站 6.4.4），遠端的版本沒有。**「商品頁的可售量該從哪裡來」是第 05 章的整章。**

### 0.2.4 代價四：除錯與維運 ★★

這一項大部分量不出來，但有兩個部分數得出來。

**① 出事的時候，同一張訂單接得起來嗎？** 第 12 站 9.8 花了一節，讓 traceId 穿過 HTTP、資料庫、broker 與消費者：使用者拿著錯誤畫面上的 `traceId`，一句查詢就找到那個請求在每一個地方留下的每一行日誌。切開之後，那一張訂單在**兩個行程**裡各留下日誌。它們還是同一個 traceId 嗎？

兩段：先讓訂單服務呼叫一個**只記錄 header 的假伺服器**，看它送了什麼；再接真的庫存服務，看庫存服務那一行日誌的 traceId。HTTP 客戶端兩種寫法：自己 `RestClient.builder()`（0.2.0 用的就是這種，也是最常見的寫法）、注入 Spring Boot 自動設定的 `RestClient.Builder`（`lab.d00.traced=true`）。

```bash
mvn test -Pexperiments -Dtest=K5SplitTraceTest
```

```
═══ 0.2.4 ① 訂單服務呼叫庫存時，送出了哪些 trace header（假的庫存服務，只記錄 header）（load { 5.27 6.30 5.96 }）═══
  自己 RestClient.builder()          │ 訂單服務 201，X-Trace-Id 6acc6b094bdeed4932ddbc39099ac50c
                                   │ 送出的 header：（沒有任何 trace header）
  Spring 的 RestClient.Builder      │ 訂單服務 201，X-Trace-Id 6acc6b0b1f7f628d173c79241fa8224b
                                   │ 送出的 header：traceparent=[00-6acc6b0b1f7f628d173c79241fa8224b-decf5254f14a3580-00]
═══ 0.2.4 ② 同一張訂單，兩個服務的 traceId（真的庫存服務）（load { 6.29 6.49 6.04 }）═══
  自己 RestClient.builder()          │ 訂單服務 201 20261012-538337，X-Trace-Id 6acc6b0c349c83d597bf5699bc975141
                                   │ 庫存服務 [.1-18311-exec-3] [6acc6b0cd3183150ef9921c28f4b9597-4c0ec7c2689fcf32] c.e.shop.dist00.LabInventoryService      : D00_RESERVE orderId=1 traceparent=null
  Spring 的 RestClient.Builder      │ 訂單服務 201 20261012-165735，X-Trace-Id 6acc6b0e9f35b62834823126c36529cc
                                   │ 庫存服務 [.1-18311-exec-5] [6acc6b0ece5a2506f7d34f38e0aa96da-914b6673139e9593] c.e.shop.dist00.LabInventoryService      : D00_RESERVE orderId=2 traceparent=null
```

**斷了兩次，斷在兩個不同的地方。**

- **送的那一邊**：自己 `RestClient.builder()` 建出來的客戶端，Micrometer 不知道它的存在，**一個 trace header 都沒送**。換成 Spring 管理的 `RestClient.Builder`，它帶了 W3C 的 `traceparent`，traceId 就是訂單服務自己的那一個（`6acc6b0b1f7f…`）。這是一行注入的差別，而且在一個行程裡完全看不出來 —— 第 12 站的正式程式碼裡一個 HTTP 客戶端都沒有（金流的退款、寄信都是模擬的元件），「客戶端是怎麼建的」從來不是一個問題。
- **收的那一邊**：就算送了，庫存服務那一行的 traceId（`6acc6b0ece5a…`）還是**另一個**，收到的 `traceparent` 是 null。庫存服務跑的是同一份程式碼 —— 第 12 站 9.8.4 刻意把所有**外面帶進來的** trace header 丟掉：那時候應用程式前面沒有 gateway，`traceparent` 是網路上任何人都能寫的，不擋的話，攻擊者可以讓一千個請求共用一個 traceId、或拿別人的 traceId 混淆調查。**在單體的邊緣，那是對的決定。拆開之後，庫存服務分不出「外面的人」與「自己的訂單服務」**，於是連自己人也一起擋掉了。

修法要兩邊一起改：客戶端用有 observation 的 builder；收的那一邊要分得出「從可信的內部來」與「從外面來」—— 外面的 trace header 在邊緣（gateway）就清掉，內部之間照收。那是第 07、08 章的事。**這裡要記住的是：在一個行程裡，traceId 不需要「傳」；拆開之後，它要在每一個邊界上被送出、被接受，任何一邊漏了，出事的時候兩個服務的日誌就是兩個陌生人。**（附帶一提：送出去的 `traceparent` 最後一段是 `-00`，「沒有被取樣」—— 取樣率是第 07 章的事；traceId 照樣會進日誌的 MDC，所以日誌對得起來與否，跟取樣無關。）

**② 數得出來的維運成本。** 第 12 站結束時，以及「只把庫存切出去」之後：

| | 第 12 站結束時（實數） | 庫存切出去之後（估算） |
|---|---|---|
| 部署單位（jar／映像檔） | 1 | 2 |
| 資料庫 | 1（25 個 migration、一套每模組授權） | 2（migration 與授權各一套；兩邊的 Flyway 歷史各自管） |
| compose 的服務（`--profile app`） | 9（MySQL、Redis、RabbitMQ、migrate、app、Prometheus、mysqld-exporter、Alertmanager、alert-sink） | 11 以上（多一個 app、多一個 migrate；資料庫要不要分兩台是另一個決定） |
| CI 管線 | 1 | 2（或一條管線兩個產物）＋ 一組契約測試（第 03 章） |
| 告警規則 | 19（12 站 9.10） | 通用的那幾條（停機、readiness、錯誤率、延遲）每個服務一份；再加上服務之間的呼叫失敗率、0.2.2 的孤兒預留 |
| 服務之間的認證、API 版本、追蹤的傳遞 | 不需要 | 都需要（第 03、07 章） |
| 「這張訂單怎麼了」要看的地方 | 1 個應用程式的日誌、1 個資料庫 | 2 個應用程式的日誌（0.2.4 ①）、2 個資料庫（0.2.2 的孤兒只能跨兩個庫才看得到） |

右欄是估算 —— 這一章沒有把它做出來（第 08 章會做一部分）。**換算成人力更是判斷：** 0.6.1 的 Segment 是一個現實的參考點，140 多個服務、3 位全職工程師；兩個服務不會需要那麼多人，但「多一個部署單位」不是零。

### 0.2.5 四個代價的共同形狀

| 代價 | 這一章量到的 | 在一個行程裡為什麼不存在 |
|---|---|---|
| 延遲 | +2.5～3 ms／張；每項一次 +20 ms（10 個品項）；吞吐 −18%～−34% | 呼叫是方法呼叫，幾奈秒 |
| 一致性 | 300 列孤兒預留；逾時＋重送：`reserved` 多 120 件 | 一個交易，全有或全無 |
| 故障傳遞 | 庫存慢 3 秒 → 訂單服務 192 張 503、無關的 API p50 1.9 秒 | 只有一個資料庫在慢，看得見、而且是同一件事 |
| 除錯與維運 | traceId 斷在邊界的兩邊；部署單位、資料庫、管線各 ×2 | 只有一個行程、一份日誌、一個資料庫 |

**四個代價都來自同一件事：原本一個行程「免費」給你的東西 —— 方法呼叫、一個交易、共用的資源池、一份日誌 —— 拆開之後，每一樣都要自己蓋回來。** 第 01～08 章就是在蓋這些東西：介面的粒度與契約（03）、Saga 與補償（04）、跨服務查詢（05）、韌性（06）、追蹤（07）、基礎設施（08）。每一樣都蓋得回來，但每一樣都有成本 —— 而**它們的總和，就是 0.3 那六個問題要拿來比的東西。**

---

## 0.3 什麼時候才「大到該拆」

第 12 站 1.3.2 用第 00 章的數字檢查過一次：五個常見的拆分理由，本專題**一個都不成立**。那張表的最後一句是「你的專案數字不一樣時，答案也可能不一樣」—— 這一節是那張表的完整版：每一個理由要問什麼、怎麼量、數字要變成什麼樣子才算數。

### 0.3.1 三個錯的理由

**「程式碼變多了。」** 第 12 站結束時，`src/main/java` 是 139 個檔案、約 7,800 行，九個模組裡最大的是 `shared`（約 2,700 行）與 `ordering`（約 1,500 行）。行數不是理由：一個 10 萬行、模組邊界被測試守住的單體，比十個各 1 萬行、彼此共用資料庫的服務好維護得多。**「大」本身不痛；痛的是「改一個地方，不知道會壞哪裡」** —— 而那是模組邊界解決的問題（12 站 1.6），不是行程邊界。

**「測試、建置、部署太慢了。」** 第 12 站的 `mvn clean verify` 是 4 分鐘（12 站 9.15）。拆開之後，每個服務的建置確實變短了 —— 但「整個系統還能不能用」的那一層測試沒有消失，它變成了契約測試加上一套要同時起好幾個服務的端到端測試（第 03 章），而且**要在部署之前跑**。慢的建置先用第 12 站 8.2 的方法量時間花在哪裡；那一章量出來的答案是一行設定，不是拆系統。

**「大家都在用」「履歷上要有」。** 這兩句沒有數字可以反駁，所以這一節不反駁，只提醒一件事：0.2 的四個代價會由**這個系統的使用者與值班的人**付，不是由做決定的人付。

### 0.3.2 真的理由：六個問題

把第 12 站 1.3.2 的五個理由攤開成六個問題。每一題都有「怎麼量」與「要變成什麼樣子」—— 後者是判斷，不是公式；這一章沒有、也給不出一個放諸四海皆準的門檻。

| # | 問題 | 怎麼量 | 第 12 站的答案 | 什麼時候答案會翻過來 |
|---|---|---|---|---|
| 1 | **某一部分的負載跟其他部分差很多，需要單獨加機器嗎？** | 每個模組的 CPU、記憶體、請求量，尖峰時各佔多少；「加一台整個單體」貴在哪裡 | 12 站 0.6.1：瞬間尖峰約 250 QPS、下單 0.2 張/秒；0.2.1 這台筆電一個行程每秒 376 張。搶購的瓶頸是**同一列的鎖**，加機器解決不了（12 站 0.11、6.5） | 某一個模組吃掉大部分的資源、而且需要的量跟其他模組無關（例如一個很吃 CPU 的影像處理或推薦），每一次為它擴容都要多開一份完整的單體 |
| 2 | **某一部分的資料量或儲存需求，一個資料庫放不下或不適合？** | 每個模組的資料量與成長率；讀寫的形狀 | 12 站 0.6.1：三年 31 GB，一台 MySQL | 某一部分需要不同的儲存（全文搜尋、時序、圖），或量大到要自己分庫分表，而其他部分不需要 |
| 3 | **不同部分由不同的團隊負責，而且他們在互相等？** | 有幾個團隊；一次發布要幾個團隊點頭；「等別人合併／等發布視窗」的時間 | 一個團隊（這個專題就是一個人） | 多個團隊、各自負責一塊業務能力，而發布節奏的衝突已經是**量得到**的延誤（0.4） |
| 4 | **不同部分需要不同的發布節奏？** | 每個模組多久改一次、改的時候會不會連帶改到別的模組（**變更耦合**，0.3.3） | 0.3.3：庫存被改的 10 次裡 7 次也改了訂單 | 某一部分改得很頻繁、而且很少連帶改到別人；它的發布被其他部分的測試或審核拖住 |
| 5 | **某一部分需要不同的技術棧？** | 有沒有一個需求是這個語言、這個框架做不好的 | 12 站 0.7：不做推薦、不做搜尋引擎 | 例如推薦要用 Python 的機器學習生態、即時通訊要用另一種執行模型 |
| 6 | **某一部分的故障必須跟其他部分隔離？** | 它掛了會不會拖垮別人；有沒有安全或合規上必須隔開的資料 | 12 站 0.6.3：用降級與艙壁處理（Redis 掛了熱點下單 503、其他照常），不需要行程隔離 | 一個第三方函式庫會吃光記憶體、拖垮整個 JVM；或支付卡號這類資料，合規上要求它所在的系統範圍越小越好 |

**第 12 站六題都是「不」。** 0.2 量過了代價：每一個跨服務的寫入要用 Saga 換回原本免費的交易（0.2.2），每一個在交易裡的遠端呼叫都是一條傳遞故障的路（0.2.3）。

> 📌 **「有一個理由成立」不等於「要拆成微服務」。** 第 1、2、5、6 題成立時，通常只需要把**那一塊**拆出去 —— 一個獨立擴縮的服務、一個專用的資料庫、一個用別的語言寫的元件 —— 其他部分照舊是一個模組化單體。README 說的「模組化單體 + 一兩個真的需要獨立擴縮的服務」就是這個意思。只有第 3、4 題（團隊與發布節奏）會把你推向「很多個服務」，而那兩題的答案取決於組織，不取決於程式碼（0.4）。

### 0.3.3 量一個你手上就有的指標：變更耦合

第 4 題要的數字，你的 git 歷史裡就有：**過去的每一次改動，碰了哪幾個模組？** 如果 A 模組的改動大部分也改了 B，把 A、B 拆成兩個服務，這些改動就都變成「兩個服務、兩次部署、而且順序要對」。

`scripts/d00-change-coupling.sh` 一個 commit 一個 commit 看：改了哪幾個模組的**正式程式碼**（`src/main/java/com/example/shop/<模組>/`，以及檔名是 `V<n>__<模組>_….sql` 的 migration）。測試、腳本、文件不算 —— 拆開之後，它們不需要兩個團隊協調。完整內容在 0.9.2。在第 12 站結束時的分支上跑：

```bash
scripts/d00-change-coupling.sh ch09      # 你自己第 12 站結束時的那個分支或 tag
```

```
commit：71 個；改到正式程式碼的：36 個
一個 commit 碰了幾個模組：
  1   個   20 個 commit（55.6%）
  2   個    5 個 commit（13.9%）
  3   個    3 個 commit（ 8.3%）
  4   個    0 個 commit（ 0.0%）
  5+  個    8 個 commit（22.2%）
每個模組被改了幾次：
  shared         22
  ordering       17
  catalog        13
  inventory      10
  payment         8
  account         6
  reporting       5
  cart            4
  notification    3
最常一起被改的模組（前 10 組）：
  ordering+shared             13 次（36.1%）
  catalog+shared               8 次（22.2%）
  catalog+ordering             8 次（22.2%）
  payment+shared               7 次（19.4%）
  ordering+payment             7 次（19.4%）
  inventory+shared             7 次（19.4%）
  inventory+ordering           7 次（19.4%）
  catalog+inventory            7 次（19.4%）
  reporting+shared             4 次（11.1%）
  ordering+reporting           4 次（11.1%）
```

**`inventory` 被改了 10 次，其中 7 次同一個 commit 也改了 `ordering`。** 這 7 次是哪幾個 commit？

| commit | 內容 | 性質 |
|---|---|---|
| `end of ch02` | 第 02 章結束時的整個專案（這個 repo 的第一個 commit） | 建立，不算「改動」 |
| `ch03` | 查詢與購物車 | 功能 |
| `ch04 write side` | 下單交易、預留、狀態機 | 功能 |
| `ch06 cache, hot stock, …` | 熱點庫存：Redis 閘門跨兩個模組 | 功能 |
| `ch07: outbox, …, hot settlement out of tx, …` | 熱點落帳移出下單交易 | 功能 |
| `section refs` | 註解裡的節號 | 機械性 |
| `ch09: INV-5 …` | 每個模組替自己的表授權（migration） | 機械性 |

**扣掉建立與機械性的 3 次，`inventory` 的 7 次功能改動裡，4 次同時改了 `ordering`** —— 第 04、06、07 章那幾個「庫存的行為真的變了」的時刻，訂單都跟著變了。熱點庫存（第 06、07 章）是最清楚的例子：閘門在下單交易之前、落帳在下單交易之後，一個功能橫跨兩個模組。如果庫存是另一個服務，這兩章的每一個改動都要兩個服務一起改、一起部署。

> ⚠️ **這份 git 歷史不是一個正常專案的歷史。** 它是一門課的參考實作：一個 commit 常常就是一整章的工作（`ch03`、`ch04 write side`），粒度粗得多 —— 22% 的 commit 碰了 5 個以上的模組，在一個日常開發的專案裡不會這麼高。**數字本身不能直接搬到你的專案，方法可以。** 在你自己的 repo 上跑，看兩件事：哪兩個模組最常一起被改（它們之間不要切），哪一個模組最常「自己被改」（如果真的要拆，它是候選）。第 01 章會用這張表決定邊界。

### 0.3.4 第 12 站的答案

六題都是「不」；四個代價都量到了；變更耦合說庫存與訂單是一起長大的。**這個系統不該拆。**

那這一站為什麼還要把它拆開？因為「不該拆」的判斷，要知道拆了之後要付什麼才做得出來，而那些代價只有動手才看得到 —— 0.2 的每一個數字都是這樣來的。接下來八章拿這個專案當**練習台**：把庫存切出去、資料庫分家、下單改成 Saga、報表改成跨服務查詢、加上服務之間的韌性與追蹤，每一步都量。第 09 章會回到這個問題：**拆完之後，怎麼判斷該不該合回去，以及怎麼合。**

> 📌 這一站做的每一件事，都是為了讓你在**你自己的**專案面前，能說出「這裡該拆／不該拆，因為……」，後面接的是數字，不是「大家都這樣做」。

---

## 0.4 康威定律

> 設計系統的組織，產出的設計會是這個組織溝通結構的複製品。
> —— Melvin Conway，〈How Do Committees Invent?〉，1968

這句話常被當成笑話引用，但它對「該不該拆」有一個很直接的推論：**服務的邊界，最後會長在團隊的邊界上。** 兩個團隊共用一個模組，他們會開始協調、排隊、互相等；兩個團隊各有一個服務，他們之間的溝通就變成一份 API 契約。

反過來也成立。**一個團隊拆出五個服務，邊界兩邊是同一群人** —— 0.2 的四個代價一個都沒有少，換來的「獨立部署、獨立團隊」卻用不到：同一群人改同一個功能，還是要一起改五個服務（0.3.3）。這就是「分散式單體」：所有分散式的壞處，加上單體的耦合。

所以第 3、4 題（0.3.2）其實是同一個問題的兩面：**有沒有一條團隊的邊界，需要一條服務的邊界去配合？** 有的話，順著團隊切（第 01 章）；沒有的話，模組邊界就夠了 —— 模組邊界也能讓一個團隊裡的不同人各自負責一塊（12 站 1.6 的 `ModuleBoundaryTest` 守的就是這個）。

> 📌 也有人刻意反過來用它：先把團隊照想要的架構重新編組，讓系統跟著長成那個形狀（常被稱為「反向康威操作」）。那是組織設計的問題，這一站不處理 —— 只提醒一件事：重新編組團隊的成本，遠高於重新畫一條模組的邊界。

---

## 0.5 模組化單體：多數團隊的終點

第 12 站做出來的不是「還沒拆的微服務」。它是一個完整的架構選擇，拿到了微服務大部分的好處：

| 微服務常被拿來說的好處 | 第 12 站怎麼拿到的 |
|---|---|
| 清楚的所有權：這段程式、這張表是誰的 | 每個模組一個套件，`package-info.java` 寫明它擁有的表；`TableOwnershipTest` 抓越界的 SQL（12 站 1.6） |
| 邊界不會被偷偷穿過 | `ModuleBoundaryTest` 的 6 條規則，`internal` 子套件 package-private（12 站 1.4.3、1.6） |
| 資料只能被自己的模組改 | 應用程式帳號的權限是每個模組替自己的表授權的；帳與稽核只能新增（12 站 9.11） |
| 模組之間鬆耦合 | 同步呼叫只走公開的 `*Api` 介面；「之後要做的事」走 outbox 與事件（12 站第 07 章） |
| 可以獨立測試 | 測試可以只起一個模組需要的東西（12 站第 08 章） |
| 故障隔離 | 降級與艙壁：Redis 掛了熱點下單 503、其他照常（12 站 0.6.3、第 06 章） |

**拿不到的只有兩件：獨立部署、獨立擴展。** 而 0.3.2 的六題在問的，就是「你需不需要這兩件」。

**先拆模組，再拆行程。** 第 12 站 1.3.3 的第 4 點說過：如果有一天真的要拆，邊界已經畫好、已經被測試守住了，拆的成本是「把一個模組的 API 換成 HTTP client」—— 0.2.0 的 `RemoteInventoryApi` 就是那一步，它只有一百多行。順序反過來（先拆行程，再想邊界）幾乎必然失敗：邊界畫錯了，在一個行程裡改一個 import 就修好；在兩個服務之間，要改兩邊的程式、一份 API 契約、兩個資料庫，還有一段新舊並存的遷移期（第 02、09 章）。

> ⚠️ **模組化單體也會爛。** 它的邊界靠測試守著；測試被關掉、被加例外（「這一次先讓它過」），它就會慢慢退化成大泥球。拆成服務之後，網路會強制邊界 —— 這是微服務少數真的「免費」的好處。但用網路來強制紀律，代價就是 0.2 的四項；用測試來強制，代價是有人要維護那幾個測試。

---

## 0.6 三個「拆了之後更慘」的真實情境

下面三個都是公開的文章，這一章沒有重現它們，只摘出跟 0.3 相關的事實。每一個的結局都是**把拆開的東西合回去**。

### 0.6.1 Segment：140 多個服務，3 個工程師專職讓它活著（2018）

Segment（現屬 Twilio）的產品會把客戶的資料轉送到上百種「目的地」（各種分析與行銷工具）。他們照微服務的做法，**每一種目的地一個服務、一個佇列、一個 repo**，高峰時超過 140 個。

文章列出的問題：

- **每多一種目的地，就多一份維運**：各自不同的負載形狀要各自調擴縮，值班的人常被叫醒。最後有 **3 位全職工程師把大部分時間花在讓這個系統活著**。
- **共用函式庫的版本漂移**：140 多個 repo 各自引用共用的程式庫，升級一次要改 140 多個地方，風險高到沒人敢做 —— 最後「每一個服務都在用不同版本的共用函式庫」。

他們把這些服務合成**一個服務**（搭配一個叫 Centrifuge 的新元件取代每個目的地一個佇列），共用函式庫的改進從一年 32 次變成 46 次。

**跟 0.3 的關係**：這些服務是**依名詞切的**（每一種目的地一個），不是依團隊、不是依擴縮的需求 —— 0.3.2 的六題，它們大多答不出「是」。服務的數量隨著業務的名詞一起長，維運的成本也是。

（Alexandra Noonan，〈Goodbye Microservices: From 100s of problem children to 1 superstar〉，Segment 部落格，2018 年 7 月；現在在 Twilio 的部落格：<https://twilio.com/en-us/blog/developers/best-practices/goodbye-microservices>）

### 0.6.2 Istio：控制平面從五個元件合成一個 `istiod`（2020）

Istio 是一個服務網格（第 08 章）。它的控制平面原本是幾個獨立部署的元件：Pilot（服務設定）、Galley（設定的驗證與分發）、Citadel（憑證）、Mixer（遙測與政策），再加上 sidecar 注入器。1.5 版（2020 年）把它們合成**一個執行檔 `istiod`**。

官方部落格寫的理由幾乎就是 0.3.2 的第 3、4、5、1 題：

> 微服務是一個很好的模式 —— 當服務對應到各自交付它們的不同團隊時，或者當獨立發布與獨立擴展的價值大於編排的成本時。

而對 Istio 的控制平面，這些條件都不成立：所有元件都用 Go 寫、**在絕大多數的安裝裡由同一個團隊安裝與維運**、**一直以來都是同一個版本一起發布**，而控制平面的成本幾乎都花在同一件事上（把設定推給資料平面的代理），其他功能的邊際成本很小 —— **把它們分成可以各自擴展的服務，幾乎沒有價值。** 合起來之後，安裝、升級、除錯都變簡單了。

**跟 0.3 的關係**：一個由**做服務網格的人**做的決定 —— 他們最懂服務之間的那一層有多貴。

（Craig Box，〈Introducing istiod: simplifying the control plane〉，Istio 部落格，2020 年 3 月：<https://istio.io/latest/blog/2020/istiod/>；上面那段引文是本書的翻譯。）

### 0.6.3 Prime Video：影音品質監控，成本降了 90% 以上（2023）

Amazon Prime Video 有一個服務，持續檢查串流的影音品質（例如畫面凍結、音畫不同步）。第一版是**分散式**的：AWS Step Functions 編排、AWS Lambda 做偵測、影格存在 S3 給下一步讀。文章說它在大約**預期負載的 5%** 就撞上了擴展的硬上限，而且整體成本太高 —— 主要來自 Step Functions 依狀態轉移計費（每一秒的串流就有好幾次轉移），以及大量讀取 S3 的請求。

他們把這些元件**放進同一個行程**（跑在 ECS／EC2 上），影格在記憶體裡傳，不再經過 S3。文章說基礎設施成本降了 **90% 以上**，而且擴展能力更好。

**跟 0.3 的關係**：拆開之後，元件之間的每一次資料傳遞都變成網路與儲存的成本（0.2.1 的那一跳，在這裡乘上每秒好幾次、每一路串流）。這篇文章在當時引起不少爭論 —— 有人指出它說的是**一個服務內部**的設計從分散式改回單一行程，不是整個 Prime Video 放棄微服務；這個區分是對的，也正好是 0.3.2 的 📌：拆或不拆，是**一塊一塊**決定的。

（Marcin Kolny，〈Scaling up the Prime Video audio/video monitoring service and reducing costs by 90%〉，Prime Video Tech 部落格，2023 年 3 月。原文後來從 Prime Video 的技術部落格移除，原網址現在轉址到別的頁面；上面的事實依當時的報導與多處轉述整理，例如 InfoQ、The Stack。）

> 📌 **三個案例的共同點：它們都量了。** Segment 數了值班的人力與共用函式庫的升級次數，Istio 看了「誰在維運、多久發布一次、成本花在哪裡」，Prime Video 算了帳單。合回去不是失敗，是量完之後的決定 —— 第 09 章會把「怎麼合回去」當成一個正常的工程動作來做。

---

## 0.7 起環境與本站的基準專案

### 0.7.1 從第 12 站開一個分支

這一站沒有新的專案。**從你自己第 12 站結束時的專案開一個分支**，之後每一章一個：

```bash
cd shop                                   # 第 12 站的專案
git switch -c d00 <第 12 站結束時的分支或 tag>
docker compose up -d --wait               # 照舊只起 MySQL、Redis、RabbitMQ（第 12 站 0.10）
```

建議從第 12 站 9.15 那張表的修正都做了的版本開始（付款回呼、熱點落帳、報表等，226 個測試）—— 這一站的實驗不依賴它們，但之後的章節會改到同一批檔案。

這一章加的東西全部在 `src/test/java/com/example/shop/dist00/` 與 `scripts/`，**正式程式碼一行都沒改**：

```
src/test/java/com/example/shop/dist00/
├── SplitLab.java                ← 建資料庫、灌資料、起兩種部署、下單與統計的工具
├── RemoteInventoryApi.java      ← 訂單服務那一側：reserve()、可售量改走 HTTP（lab.d00.remote-inventory-url）
├── LabInventoryService.java     ← 庫存服務那一側：/lab/inventory/**（lab.d00.inventory-service=true）
├── K1SplitLatencyTest.java      ← 0.2.1
├── K2SplitConsistencyTest.java  ← 0.2.2
├── K3SplitCascadeTest.java      ← 0.2.3
└── K5SplitTraceTest.java        ← 0.2.4
scripts/d00-change-coupling.sh   ← 0.3.3（K4）
```

五個實驗都標 `@Tag("experiment")`：預設的 `mvn test` 不跑它們，用第 12 站 2.11 的 `-Pexperiments` 跑（那個 profile 也讓測試連 compose 的那一組，而不是 Testcontainers —— 12 站 8.4）。

### 0.7.2 實驗用的資料庫

0.2 的實驗不碰第 12 站的 `shop` 庫 —— 那個庫裡的種子資料與數字，是第 12 站課文的來源。`SplitLab.freshDatabase()` 每次實驗開始時重建三個：

```sql
DROP DATABASE IF EXISTS shop_d00_inv;
CREATE DATABASE shop_d00_inv;
GRANT ALL PRIVILEGES ON `shop_d00_inv`.* TO 'shop_migrator'@'%' WITH GRANT OPTION;
```

用 root 執行（`docker exec shop-mysql-1 mysql -uroot -proot -e "…"` 也可以手動做）。為什麼要那一行 `GRANT`：第 12 站 9.11 之後，應用程式的 `shop` 帳號只拿 `shop_app` 這個角色，沒有任何 DDL 權限；Flyway 用 `shop_migrator` 跑 migration（`application-local.yml` 的 `spring.flyway.user`），而 `shop_migrator` 只對 `shop` 這個庫有權限。給它新庫的權限、`WITH GRANT OPTION`，第 12 站 V15～V22 的那些 `GRANT … TO shop_app` 才能在新庫上執行 —— 跟驗收 Q6 的 `shop_q6` 是同一個做法（12 站 9.11）。那些 `GRANT` 不帶資料庫名稱，所以在任何一個庫上都成立。

實驗結束時不會刪掉這三個庫（看完數字可以自己進去查）。要清掉：

```bash
docker exec shop-mysql-1 mysql -uroot -proot -e "DROP DATABASE IF EXISTS shop_d00_mono; DROP DATABASE IF EXISTS shop_d00_order; DROP DATABASE IF EXISTS shop_d00_inv;"
```

Redis 用 11～13 號 database（一個行程 11、訂單服務 12、庫存服務 13），不會碰到第 12 站用的 0 號。

### 0.7.3 這一站的版本與環境

跟第 12 站一樣：Java 21、Spring Boot 3.2.5、MySQL 8.0、Redis 7.2、RabbitMQ 3.13。機器也是同一台：8 核、16 GB 的筆電，Docker Desktop 的 VM 分到 8 核、7.65 GB，Docker Engine 29.1.3（12 站第 09 章開頭）。

| 東西 | 值 | 為什麼 |
|---|---|---|
| 庫存服務的埠 | 18311 | 固定的，訂單服務要知道去哪裡找它；第 12 站 8.8.3 說過這台機器的 8080 被別的專案佔著 |
| 訂單服務的埠 | 隨機（`--server.port=0`） | 在測試的 JVM 裡起，實驗自己知道是哪一個 |
| `lab.d00.read-timeout-ms` | 10,000（0.2.2 ② 用 1,000） | 訂單服務等庫存服務最多多久 |
| 連線池 | 20 條、`connection-timeout` 3 秒 | 第 12 站的設定，沒有動（12 站 0.10.4、8.9.1） |

五個實驗的長度：K1 約 3 分半、K2 約 40 秒、K3 約 80 秒、K5 約 16 秒；K4 是一支腳本，一秒。**一次只跑一個**（第 12 站的規矩）：它們共用同一台 MySQL，也搶同一顆 CPU。

### 0.7.4 跑起來確認

最快的是 K5：

```bash
mvn test -Pexperiments -Dtest=K5SplitTraceTest
```

看到 0.2.4 那兩段輸出、`BUILD SUCCESS`，就表示這些都通了：三個資料庫建得起來、Flyway 在新庫上跑得完、庫存服務的 JVM 起得來（`target/d00-inventory-service.log`）、訂單服務找得到它。

起不來的時候先看 `target/d00-inventory-service.log`。最常見的兩個原因：18311 被佔著（`lsof -iTCP:18311 -sTCP:LISTEN`）、compose 沒有起（`docker compose ps`）。

---

## 0.8 這一站的地圖

### 0.8.1 十章，每一章對第 12 站的專案做什麼

| 章 | 主題 | 對專案做的事 |
|---|---|---|
| 00 | 該不該拆（本章） | 把庫存切出去、量四個代價；結論：不該拆 —— 但接下來要學會怎麼拆 |
| 01 | 邊界怎麼切 | 用 0.3.3 的變更耦合與業務能力決定切在哪；先把模組邊界修對，再拆行程 |
| 02 | 資料庫拆分 | 庫存的表搬到自己的資料庫；跨服務的 JOIN、外鍵、報表、0.2.2 那句「數孤兒」的 SQL 怎麼辦 |
| 03 | 服務間通訊 | `@HttpExchange`／`RestClient`、介面的粒度（0.2.1 的「每項一次」）、契約測試、服務之間的認證 |
| 04 | Saga 與補償 | 下單改成 Saga：0.2.2 的孤兒預留由誰收尾、補償怎麼寫、哪些操作補償不回來 |
| 05 | 跨服務查詢 | 0.2.3 那個商品頁的可售量：API 組合 vs CQRS 讀模型，過時視窗有多長 |
| 06 | 服務網的韌性 | 0.2.3 的級聯：逾時預算、重試風暴、隔艙、熔斷放在哪一層 |
| 07 | 分散式追蹤 | 0.2.4 斷掉的那兩個地方：客戶端的傳遞、邊緣的過濾、取樣、跨 MQ |
| 08 | 基礎設施選型 | 服務發現、設定、閘道、負載平衡：Spring Cloud vs K8s 原生的決策表 |
| 09 | 遷移與回頭路 | Strangler Fig、灰度、遷移期的對帳 —— 以及**怎麼把服務合併回單體** |

### 0.8.2 這一章的事故在哪裡被解決

| 事故 | 解決在 |
|---|---|
| 0.2.1 每項一次的呼叫、吞吐下降 | 03（介面的粒度）、06（逾時預算） |
| 0.2.2 ① 失敗之後的孤兒預留 | 04（Saga 與補償）、02（跨庫的對帳） |
| 0.2.2 ② 逾時之後的重送、重複預留 | 03（服務之間的冪等）、04 |
| 0.2.3 遠端呼叫在本地交易裡、連線池耗盡 | 04（把遠端呼叫移出交易）、06（隔艙、熔斷） |
| 0.2.3 的 ⚠️ 商品頁的可售量 | 05 |
| 0.2.4 traceId 在兩邊都斷了 | 07、08（邊緣的 gateway） |
| 0.3.3 庫存與訂單一起改 | 01 |

0.2.2、0.2.3、0.2.4 在真的線上（第 03 章的線、第 04 章的 Saga）重跑的結果在第 04 章 4.10.7 —— 孤兒預留 0；庫存服務慢 3 秒時，「我的訂單」不受影響；0.2.1 的延遲反而更貴；traceId 送的那一邊好了，收的那一邊還斷。

### 0.8.3 這一站不處理的事

- **Kubernetes 本身的操作**：第 08 章會比較 K8s 原生的做法，但不教怎麼架一個叢集；需要的名詞在 [02-spring-boot/08](../02-spring-boot/08-packaging-docker-and-deployment.md)。
- **多區域、跨資料中心**：所有實驗都在一台機器上，0.2.1 的 ⚠️ 說過這件事的限制。
- **組織設計**：0.4 只說「團隊的形狀決定系統的形狀」，怎麼重新編組團隊不在這門課裡。
- **事件串流平台的進階用法**（Kafka Streams 這一類）：跨服務的事件沿用 [11-messaging](../11-messaging/) 與第 12 站第 07 章的 outbox。

---

## 0.9 本章完成後的專案

```
shop/                                       ← 第 12 站的專案，分支 d00
├── scripts/
│   └── d00-change-coupling.sh              ← + 0.3.3
└── src/test/java/com/example/shop/
    └── dist00/                             ← + 這一章的全部（正式程式碼沒有改）
        ├── SplitLab.java
        ├── RemoteInventoryApi.java
        ├── LabInventoryService.java
        ├── K1SplitLatencyTest.java
        ├── K2SplitConsistencyTest.java
        ├── K3SplitCascadeTest.java
        └── K5SplitTraceTest.java
```

**沒有新的 migration、沒有新的 API、沒有改任何一行正式程式碼。** 這一章加的東西都在 `src/test` 與 `scripts/`，而且要開關（`lab.d00.*`）才會出現。

完整跑一次（預設的 Testcontainers；五個實驗標了 `experiment`，不在裡面）：

```bash
mvn clean verify
```

```
TEST_INFRA MySQL 最多同時 25 條連線（max_connections 151）
[INFO] Tests run: 226, Failures: 0, Errors: 0, Skipped: 0
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  04:08 min
```

**226 個測試，跟第 12 站 9.15 那張表的修正都做了之後一樣** —— 這一章沒有讓任何一個既有的測試變紅，也沒有加進預設的測試。

> ⚠️ **外層類別的 `@ConditionalOnProperty` 管不到 static 巢狀的 `@RestController`。** 元件掃描會**單獨**掃到巢狀類別。`LabInventoryService` 裡的巢狀 `@RestController` 如果沒有自己標同一個條件，每一個測試的 context 都會多出三支 `/lab/**` API，兩個測試會紅 —— `SecurityRouteCoverageTest`：「這些 API 沒有出現在 SecurityConfig 的表上 ["GET /lab/inventory/available", "POST /lab/inventory/delay", "POST /lab/inventory/reserve"]」；`OpenApiContractTest`：「新增 POST /lab/inventory/reserve……」。巢狀類別自己也標上同一個條件就好。**第 12 站留下的兩個守門員（12 站 5.5.5 的路由覆蓋、3.8.2 的 API 契約快照）抓得到這種 bug。**

> ⚠️ **`ProductCacheTest.singleFlight` 在這個分支上偶爾會紅，跟這一章無關。** 它是 12 站 6.4 的測試：快取裡沒有、200 個請求同時讀 → MySQL 只被讀 1 次；紅的時候讀了 2 次。`ProductCache.get()` 有一個競態：一個請求「讀 Redis 沒命中」之後、搶讀取權之前，如果負責讀的那個請求剛好整個做完，它會搶到讀取權、再讀一次 MySQL。修法是搶到讀取權之後再看一次快取。測試（用一個 latch 讓這個交錯一定發生）、修法與「為什麼這樣就夠」在第 12 站 6.4.3；第 01 章的 `d01` 分支帶著這個修正。

### 0.9.1 追溯表：這一站的產出，在哪一章

README 的「產出」列了五項。這一章交出的，是它們共同的起點：

| README 的產出 | 在哪一章 | 這一章留下的起點 |
|---|---|---|
| 1. 拆分決策文件（該不該拆、切在哪、兩個方案的成本） | 00、01 | 0.3.2 的六個問題、0.3.3 的變更耦合、0.2 的四個代價 |
| 2. 庫存拆成獨立服務（獨立資料庫）、下單改成 Saga、失敗演練、拆分前後的延遲對照 | 02、03、04 | `SplitLab` 的兩種部署；K1 的延遲基準、K2 的失敗注入 |
| 3. 跨服務報表：API 組合版與 CQRS 讀模型版、過時視窗 | 05 | 0.2.3 的 ⚠️：商品頁的可售量已經是第一個跨服務查詢 |
| 4. 一條穿過 Gateway → 訂單 → MQ → 庫存的 trace、一次排查紀錄 | 07 | K5：斷掉的兩個地方 |
| 5. 基礎設施選型文件 | 08 | 0.2.4 ② 的維運清單 |

### 0.9.2 本章其餘檔案的完整內容

正文為了說清楚一件事，只節錄了關鍵的幾段。下面是這一章新增的每一個檔案的完整內容（`d00` 分支上的版本）。從第 12 站結束時的專案出發，加上這八個檔案，就是這一章結束時的專案。

**`src/test/java/com/example/shop/dist00/SplitLab.java`**（實驗支架（0.2.0））

```java
package com.example.shop.dist00;

import com.example.shop.ShopApplication;
import com.example.shop.support.TestTokens;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 13 站 0.2 的實驗支架：同一份第 12 站的程式碼，兩種部署。
 *
 *   一個行程（mono）    ：ShopApplication，一個資料庫 shop_d00_mono。下單交易裡 reserve() 是本地呼叫，跟訂單一起 commit。
 *   切開（split）       ：訂單服務 = ShopApplication + RemoteInventoryApi，資料庫 shop_d00_order；
 *                         庫存服務 = 另一個 JVM 的 ShopApplication + LabInventoryService，資料庫 shop_d00_inv。
 *
 * 用的是第 12 站 compose 的那一台 MySQL、Redis（不碰 shop 這個庫；Redis 用 11～13 號 database，跟 shop 的 0 號分開）。
 * 資料庫比照驗收 Q6：root 建庫、shop_migrator 跑 migration、應用程式的 shop 只拿 shop_app 這個角色（第 12 站 9.11）。
 */
final class SplitLab {

    static final String MONO_DB = "shop_d00_mono", ORDER_DB = "shop_d00_order", INV_DB = "shop_d00_inv";
    static final int INV_PORT = 18311;
    static final long SELLER = 900_001, FIRST_PRODUCT = 9_000_001;
    static final int PRODUCTS = 1_000;

    private SplitLab() {}

    // ───────── 資料庫 ─────────

    static Connection root(String db) throws Exception {
        return DriverManager.getConnection("jdbc:mysql://localhost:3306/" + db + "?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true", "root", "root");
    }

    static void freshDatabase(String db) throws Exception {
        try (Connection c = root(""); Statement st = c.createStatement()) {
            st.execute("DROP DATABASE IF EXISTS " + db);
            st.execute("CREATE DATABASE " + db);
            st.execute("GRANT ALL PRIVILEGES ON `" + db + "`.* TO 'shop_migrator'@'%' WITH GRANT OPTION");
        }
    }

    static String url(String db) {
        return "jdbc:mysql://localhost:3306/" + db + "?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true";
    }

    /** 1,000 個上架的商品（同一位賣家，單價 100）；withInventory：每個 1,000 萬件，不讓「庫存不足」混進延遲 */
    static void seed(String db, boolean products, boolean withInventory) throws Exception {
        try (Connection c = root(db)) {
            c.setAutoCommit(false);
            if (products) {
                long category;
                try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("SELECT MIN(id) FROM categories")) { rs.next(); category = rs.getLong(1); }
                try (PreparedStatement ps = c.prepareStatement("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, ?, ?, 100.00, 'ON_SALE')")) {
                    for (int i = 0; i < PRODUCTS; i++) {
                        ps.setLong(1, FIRST_PRODUCT + i); ps.setLong(2, SELLER); ps.setLong(3, category); ps.setString(4, "d00 商品 " + i);
                        ps.addBatch();
                    }
                    ps.executeBatch();
                }
            }
            if (withInventory) {
                try (PreparedStatement ps = c.prepareStatement("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10000000, 0)")) {
                    for (int i = 0; i < PRODUCTS; i++) { ps.setLong(1, FIRST_PRODUCT + i); ps.addBatch(); }
                    ps.executeBatch();
                }
            }
            c.commit();
        }
    }

    static long count(String db, String sql) throws Exception {
        try (Connection c = root(db); Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) { rs.next(); return rs.getLong(1); }
    }

    // ───────── 應用程式 ─────────

    static List<String> common(String db, int redisDb) {
        return new ArrayList<>(List.of("--server.port=0", "--spring.datasource.url=" + url(db),
                "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false",
                "--shop.messaging.relay-enabled=false", "--shop.messaging.consumers-enabled=false",
                "--shop.rate-limit.enabled=false", "--spring.data.redis.database=" + redisDb,
                "--spring.main.banner-mode=off", "--logging.level.root=WARN"));
    }

    static ConfigurableApplicationContext startMono() {
        return new SpringApplicationBuilder(ShopApplication.class).run(common(MONO_DB, 11).toArray(String[]::new));
    }

    static ConfigurableApplicationContext startSplitOrder(boolean perLine, long readTimeoutMs) {
        List<String> a = common(ORDER_DB, 12);
        a.addAll(List.of("--lab.d00.remote-inventory-url=http://127.0.0.1:" + INV_PORT, "--lab.d00.per-line=" + perLine,
                "--lab.d00.read-timeout-ms=" + readTimeoutMs));
        return new SpringApplicationBuilder(ShopApplication.class).run(a.toArray(String[]::new));
    }

    /** 庫存服務：另一個 JVM（同一個 classpath），日誌寫到 target/d00-inventory-service.log */
    static Process startInventoryService() throws Exception {
        List<String> cmd = new ArrayList<>(List.of(ProcessHandle.current().info().command().orElse("java"),
                "-Dshop.test.infra=compose", "-cp", System.getProperty("java.class.path"), ShopApplication.class.getName()));
        List<String> a = common(INV_DB, 13);
        a.set(0, "--server.port=" + INV_PORT);
        a.add("--lab.d00.inventory-service=true");
        a.add("--logging.level.com.example.shop.dist00=INFO");               // 0.2.4：D00_RESERVE 那一行
        cmd.addAll(a);
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(new File("target/d00-inventory-service.log")).start();
        HttpClient c = HttpClient.newHttpClient();
        for (int i = 0; i < 120; i++) {
            try {
                if (c.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + INV_PORT + "/actuator/health/readiness")).build(),
                        HttpResponse.BodyHandlers.discarding()).statusCode() == 200) return p;
            } catch (Exception notYet) { /* 還沒開始聽 */ }
            if (!p.isAlive()) throw new IllegalStateException("庫存服務沒有起來，看 target/d00-inventory-service.log");
            Thread.sleep(500);
        }
        p.destroy();
        throw new IllegalStateException("庫存服務 60 秒內沒有 ready");
    }

    static void inventoryDelay(long ms) throws Exception {
        HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + INV_PORT + "/lab/inventory/delay?ms=" + ms))
                .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.discarding());
    }

    static int port(ConfigurableApplicationContext ctx) {
        return ((WebServerApplicationContext) ctx).getWebServer().getPort();
    }

    // ───────── 下單 ─────────

    record Result(int status, long nanos, String body) {}

    static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

    /** 一張 n 個品項的訂單（隨機挑 n 個不同的商品，避開熱點列的鎖競爭），走 HTTP，跟真的客戶端一樣 */
    static Result placeOrder(ConfigurableApplicationContext ctx, long buyerId, int lines, String key) {
        long[] ids = ThreadLocalRandom.current().longs(0, PRODUCTS).distinct().limit(lines).map(i -> FIRST_PRODUCT + i).toArray();
        String items = String.join(",", Arrays.stream(ids).mapToObj(id -> "{\"productId\":" + id + ",\"quantity\":1,\"unitPrice\":100.00}").toList());
        HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port(ctx) + "/api/orders"))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("Authorization", TestTokens.bearer(ctx, buyerId))
                .header("Idempotency-Key", key == null ? UUID.randomUUID().toString() : key)
                .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[" + items + "]}")).build();
        long t0 = System.nanoTime();
        try {
            HttpResponse<String> r = CLIENT.send(req, HttpResponse.BodyHandlers.ofString());
            return new Result(r.statusCode(), System.nanoTime() - t0, r.body());
        } catch (Exception e) {
            return new Result(-1, System.nanoTime() - t0, e.toString());
        }
    }

    static Result get(ConfigurableApplicationContext ctx, String path, long buyerId) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port(ctx) + path)).timeout(Duration.ofSeconds(30));
        if (buyerId > 0) b.header("Authorization", TestTokens.bearer(ctx, buyerId));
        long t0 = System.nanoTime();
        try {
            HttpResponse<String> r = CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
            return new Result(r.statusCode(), System.nanoTime() - t0, r.body());
        } catch (Exception e) {
            return new Result(-1, System.nanoTime() - t0, e.toString());
        }
    }

    // ───────── 統計 ─────────

    static double pct(long[] sortedNanos, double p) {
        if (sortedNanos.length == 0) return Double.NaN;
        int i = (int) Math.ceil(p / 100.0 * sortedNanos.length) - 1;
        return sortedNanos[Math.max(0, Math.min(i, sortedNanos.length - 1))] / 1e6;
    }

    static String load() {
        try {
            Process p = new ProcessBuilder("sysctl", "-n", "vm.loadavg").start();
            return new String(p.getInputStream().readAllBytes()).strip();
        } catch (Exception e) {
            return "?";
        }
    }
}
```

**`src/test/java/com/example/shop/dist00/RemoteInventoryApi.java`**（訂單服務那一側（0.2.0、0.2.3、0.2.4））

```java
package com.example.shop.dist00;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Primary;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Collection;
import java.util.List;
import java.util.Map;

/**
 * 13 站 0.2：「訂單服務」那一側。庫存模組被切出去之後，下單交易裡的 inventory.reserve() 變成一次 HTTP 呼叫。
 * 只換 reserve() —— 下單流程裡唯一會改變庫存的那一步；其他方法照舊交給本地的實作（0.2 的實驗不會走到它們）。
 *
 * lab.d00.per-line=true：每一個品項各呼叫一次（「把方法搬到遠端，呼叫的地方不改」最常見的寫法），否則整張訂單一次。
 * lab.d00.read-timeout-ms：等庫存服務回應最多多久（預設 10 秒）。
 * lab.d00.traced=true：用 Spring Boot 自動設定的 RestClient.Builder（有 Micrometer 的 observation，會帶 traceparent）；
 *   預設是自己 RestClient.builder() —— 最常見的寫法，也是 0.2.4 那個「traceId 斷掉」的來源。
 */
@Component
@Primary
@ConditionalOnProperty(name = "lab.d00.remote-inventory-url")
class RemoteInventoryApi implements InventoryApi {

    private final InventoryApi local;
    private final RestClient http;
    private final boolean perLine;

    RemoteInventoryApi(@Qualifier("jdbcInventoryService") InventoryApi local,
                       @Value("${lab.d00.remote-inventory-url}") String url,
                       @Value("${lab.d00.per-line:false}") boolean perLine,
                       @Value("${lab.d00.read-timeout-ms:10000}") long readTimeoutMs,
                       @Value("${lab.d00.traced:false}") boolean traced,
                       org.springframework.beans.factory.ObjectProvider<RestClient.Builder> springBuilder) {
        this.local = local;
        this.perLine = perLine;
        JdkClientHttpRequestFactory f = new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build());
        f.setReadTimeout(Duration.ofMillis(readTimeoutMs));
        RestClient.Builder b = traced ? springBuilder.getObject() : RestClient.builder();
        this.http = b.baseUrl(url).requestFactory(f).build();
    }

    @Override
    public void reserve(long orderId, List<ReserveLine> lines) {
        if (perLine) for (ReserveLine l : lines) call(orderId, List.of(l));
        else call(orderId, lines);
    }

    private void call(long orderId, List<ReserveLine> lines) {
        http.post().uri("/lab/inventory/reserve").body(Map.of("orderId", orderId, "lines", lines))
                .retrieve()
                .onStatus(s -> s.value() == 409, (req, res) -> {
                    JsonNode body = new com.fasterxml.jackson.databind.ObjectMapper().readTree(res.getBody());
                    throw new InsufficientStockException(body.get("productId").asLong());
                })
                .toBodilessEntity();
    }

    // ── 下單流程不會走到的，照舊用本地的實作 ──
    @Override public void initialize(long productId, int onHand, String note) { local.initialize(productId, onHand, note); }
    @Override public void holdHot(long orderId, List<ReserveLine> lines) { local.holdHot(orderId, lines); }
    @Override public void confirm(long orderId) { local.confirm(orderId); }
    @Override public void release(long orderId) { local.release(orderId); }
    @Override public void consume(long orderId) { local.consume(orderId); }
    @Override public void restock(long productId, int quantity, String note) { local.restock(productId, quantity, note); }
    @Override public void gateHot(List<ReserveLine> hotLines) { local.gateHot(hotLines); }
    @Override public void returnHot(List<ReserveLine> hotLines) { local.returnHot(hotLines); }
    @Override public void setHot(long productId, boolean hot) { local.setHot(productId, hot); }

    // ── 0.2.3：商品頁的可售量。第一版照舊交給本地 —— 訂單服務的資料庫裡沒有庫存列，商品詳情每一次都是 500（EmptyResultDataAccessException）。
    //    可售量的「唯一寫入者」是庫存服務，訂單服務只能來問（沒有快取；熱點商品照舊讀 Redis 的副本）
    @Override public int availableForDisplay(long productId, boolean hot) { return hot ? local.availableForDisplay(productId, true) : available(productId); }
    @Override public int available(long productId) { return available(List.of(productId)).getOrDefault(productId, 0); }
    @Override public Map<Long, Integer> available(Collection<Long> productIds) {
        String ids = String.join(",", productIds.stream().map(String::valueOf).toList());
        Map<String, Integer> body = http.get().uri("/lab/inventory/available?productIds={ids}", ids).retrieve()
                .body(new org.springframework.core.ParameterizedTypeReference<Map<String, Integer>>() {});
        Map<Long, Integer> out = new java.util.HashMap<>();
        if (body != null) body.forEach((k, v) -> out.put(Long.parseLong(k), v));
        return out;
    }
}
```

**`src/test/java/com/example/shop/dist00/LabInventoryService.java`**（庫存服務那一側（0.2.0、0.2.3、0.2.4））

```java
package com.example.shop.dist00;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseEntity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 13 站 0.2：「庫存服務」那一側。同一份程式碼、另一個行程、另一個資料庫 —— 只多了一支給訂單服務呼叫的 HTTP 端點。
 * 只在 lab.d00.inventory-service=true 時存在：其他測試的 context 掃得到這個類別，但不會建立它。
 *
 * reserve() 在第 12 站是 MANDATORY（必須在下單交易裡）。到了另一個行程，「下單交易」不存在了 —— 這裡只能自己開一個交易、自己 commit。
 * 這一行 tx.executeWithoutResult 就是整個 0.2.2 的來源。
 */
@Configuration
@ConditionalOnProperty(name = "lab.d00.inventory-service", havingValue = "true")
class LabInventoryService {

    /** 0.2.2 ②、0.2.3：回應之前（預留已經 commit 之後）多等多久。模擬「庫存服務變慢了」 */
    static volatile long delayMs = 0;

    record ReserveRequest(long orderId, List<ReserveLine> lines) {}

    /**
     * 自己也要標條件：static 巢狀類別會被元件掃描「單獨」掃到，外層的 @ConditionalOnProperty 管不到它。
     * 第一版沒有標 —— 每一個測試的 context 都多了 /lab/** 兩支 API，SecurityRouteCoverageTest 與 OpenApiContractTest 紅了（0.9）。
     */
    @RestController
    @ConditionalOnProperty(name = "lab.d00.inventory-service", havingValue = "true")
    static class Endpoint {
        private final InventoryApi inventory;
        private final TransactionTemplate tx;

        Endpoint(InventoryApi inventory, PlatformTransactionManager tm) {
            this.inventory = inventory;
            this.tx = new TransactionTemplate(tm);
        }

        @PostMapping("/lab/inventory/reserve")
        ResponseEntity<?> reserve(@RequestBody ReserveRequest req,
                                  @org.springframework.web.bind.annotation.RequestHeader(value = "traceparent", required = false) String traceparent) throws InterruptedException {
            // 0.2.4：這一行日誌的 traceId（MDC，第 12 站 9.8）跟訂單服務那一張訂單的是不是同一個？
            org.slf4j.LoggerFactory.getLogger(LabInventoryService.class).info("D00_RESERVE orderId={} traceparent={}", req.orderId(), traceparent);
            try {
                tx.executeWithoutResult(s -> inventory.reserve(req.orderId(), req.lines()));   // 自己的交易，在這裡就 commit 了
            } catch (InsufficientStockException e) {
                return ResponseEntity.status(409).body(Map.of("productId", e.productId()));
            }
            long d = delayMs;
            if (d > 0) Thread.sleep(d);
            return ResponseEntity.noContent().build();
        }

        /** 0.2.3：商品頁的可售量。第 12 站它是 inventory 模組的一次本地查詢（5 秒快取）；切開之後，訂單服務只能來問 */
        @org.springframework.web.bind.annotation.GetMapping("/lab/inventory/available")
        Map<Long, Integer> available(@RequestParam List<Long> productIds) {
            return inventory.available(productIds);
        }

        @PostMapping("/lab/inventory/delay")
        Map<String, Long> delay(@RequestParam long ms) {
            delayMs = ms;
            return Map.of("delayMs", ms);
        }
    }

    /** 第 12 站的 SecurityConfig 對沒列出的路徑一律 denyAll —— 實驗用的端點另開一條鏈，排在它前面 */
    @Bean
    @Order(0)
    SecurityFilterChain labChain(HttpSecurity http) throws Exception {
        return http.securityMatcher("/lab/**")
                .csrf(AbstractHttpConfigurer::disable)
                .authorizeHttpRequests(a -> a.anyRequest().permitAll())
                .build();
    }
}
```

**`src/test/java/com/example/shop/dist00/K1SplitLatencyTest.java`**（0.2.1）

```java
package com.example.shop.dist00;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.example.shop.dist00.SplitLab.*;

/**
 * 13 站 0.2.1 代價一：延遲。同一個下單 API、同一份程式碼，三種部署交錯量：
 *   一個行程         —— reserve() 是本地呼叫（第 12 站的樣子）
 *   切開：一次呼叫   —— 整張訂單的品項一次送到庫存服務
 *   切開：每項一次   —— 每一個品項呼叫一次（把方法搬到遠端、呼叫的地方不改）
 * 先一張一張送（看單一請求多了多少），再 16 條執行緒同時送（看負載下的 p99）。
 *
 * mvn test -Pexperiments -Dtest=K1SplitLatencyTest
 */
@Tag("experiment")
class K1SplitLatencyTest {

    @Test
    void latency() throws Exception {
        freshDatabase(MONO_DB); freshDatabase(ORDER_DB); freshDatabase(INV_DB);
        Process inv = null;
        try (ConfigurableApplicationContext mono = startMono()) {
            seed(MONO_DB, true, true);
            inv = startInventoryService();
            seed(INV_DB, false, true);                                     // 庫存服務只有庫存
            try (ConfigurableApplicationContext batch = startSplitOrder(false, 10_000);
                 ConfigurableApplicationContext perLine = startSplitOrder(true, 10_000)) {
                seed(ORDER_DB, true, false);                               // 訂單服務只有商品（catalog 還在它身上）
                Map<String, ConfigurableApplicationContext> modes = new LinkedHashMap<>();
                modes.put("一個行程", mono);
                modes.put("切開：一次呼叫", batch);
                modes.put("切開：每項一次", perLine);

                for (var e : modes.entrySet()) for (int i = 0; i < 300; i++) placeOrder(e.getValue(), buyer(), 3, null);   // 暖機（不算）

                System.out.printf("═══ 0.2.1 一張一張送：每種 5 輪 × 100 張、三種部署交錯（load %s）═══%n", load());
                for (int lines : new int[]{1, 3, 10}) {
                    Map<String, List<Long>> lat = new LinkedHashMap<>();
                    Map<String, Map<Integer, Integer>> codes = new LinkedHashMap<>();
                    for (int round = 0; round < 5; round++) {
                        for (var e : modes.entrySet()) {
                            for (int i = 0; i < 100; i++) {
                                Result r = placeOrder(e.getValue(), buyer(), lines, null);
                                lat.computeIfAbsent(e.getKey(), k -> new ArrayList<>()).add(r.nanos());
                                codes.computeIfAbsent(e.getKey(), k -> new TreeMap<>()).merge(r.status(), 1, Integer::sum);
                            }
                        }
                    }
                    for (var e : lat.entrySet()) {
                        long[] s = e.getValue().stream().mapToLong(Long::longValue).sorted().toArray();
                        System.out.printf("  %2d 個品項 │ %-10s │ p50 %6.2f ms │ p90 %6.2f ms │ p99 %6.2f ms │ %s%n",
                                lines, e.getKey(), pct(s, 50), pct(s, 90), pct(s, 99), codes.get(e.getKey()));
                    }
                }

                System.out.printf("═══ 0.2.1 16 條執行緒同時送 3 個品項的訂單：每種 15 秒 × 2 輪、交錯（load %s）═══%n", load());
                Map<String, List<Long>> lat = new LinkedHashMap<>();
                Map<String, Long> done = new LinkedHashMap<>();
                Map<String, Map<Integer, Integer>> codes = new LinkedHashMap<>();
                for (int round = 0; round < 2; round++) {
                    for (var e : modes.entrySet()) {
                        ConcurrentLinkedQueue<Result> out = new ConcurrentLinkedQueue<>();
                        AtomicBoolean stop = new AtomicBoolean();
                        ExecutorService pool = Executors.newFixedThreadPool(16);
                        for (int t = 0; t < 16; t++) pool.submit(() -> { while (!stop.get()) out.add(placeOrder(e.getValue(), buyer(), 3, null)); });
                        Thread.sleep(15_000);
                        stop.set(true);
                        pool.shutdown();
                        pool.awaitTermination(60, TimeUnit.SECONDS);
                        for (Result r : out) {
                            lat.computeIfAbsent(e.getKey(), k -> new ArrayList<>()).add(r.nanos());
                            codes.computeIfAbsent(e.getKey(), k -> new TreeMap<>()).merge(r.status(), 1, Integer::sum);
                        }
                        done.merge(e.getKey(), (long) out.size(), Long::sum);
                    }
                }
                for (var e : lat.entrySet()) {
                    long[] s = e.getValue().stream().mapToLong(Long::longValue).sorted().toArray();
                    System.out.printf("  %-10s │ %,6d 張（每秒 %5.0f）│ p50 %6.2f ms │ p99 %7.2f ms │ %s%n",
                            e.getKey(), done.get(e.getKey()), done.get(e.getKey()) / 30.0, pct(s, 50), pct(s, 99), codes.get(e.getKey()));
                }
                System.out.printf("  （結束時 load %s）%n", load());
            }
        } finally {
            if (inv != null) { inv.destroy(); inv.waitFor(30, TimeUnit.SECONDS); }
        }
    }

    static long buyer() {
        return ThreadLocalRandom.current().nextLong(1_000_000, 9_000_000);
    }
}
```

**`src/test/java/com/example/shop/dist00/K2SplitConsistencyTest.java`**（0.2.2）

```java
package com.example.shop.dist00;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.sql.Connection;
import java.sql.Statement;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.TimeUnit;

import static com.example.shop.dist00.SplitLab.*;

/**
 * 13 站 0.2.2 代價二：一致性。第 12 站的下單是「一個交易」：訂單、明細、預留、帳、歷史、outbox，全有或全無（US-ORD-1 AC-5）。
 * 庫存切出去之後，預留在另一個資料庫、另一個交易裡 commit —— 下單交易後面任何一步失敗，它都不會跟著 rollback。
 *
 *   ① reserve() 之後失敗：訂單資料庫的一個 trigger，在寫訂單狀態歷史（reserve 之後的下一步）時對買家 777777 丟錯
 *   ② 逾時：庫存服務預留、commit 之後慢 1.5 秒才回應；訂單服務只等 1 秒 —— 放棄、rollback。之後用同一個 Idempotency-Key 重送
 *
 * 數「沒有訂單的預留」：庫存服務的 inventory_reservations 裡，order_id 在訂單資料庫找不到的列。
 * （這句 SQL 跨了兩個資料庫，只因為實驗裡兩個庫在同一台 MySQL 上才寫得出來 —— 真的拆開之後，它們在兩台機器上，這句 JOIN 不存在。）
 *
 * mvn test -Pexperiments -Dtest=K2SplitConsistencyTest
 */
@Tag("experiment")
class K2SplitConsistencyTest {

    static final long FAIL_BUYER = 777_777;

    static final String TRIGGER = """
            CREATE TRIGGER d00_fail_after_reserve BEFORE INSERT ON order_status_history FOR EACH ROW
            BEGIN
              IF (SELECT buyer_id FROM orders WHERE id = NEW.order_id) = 777777 THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'd00: injected failure after reserve';
              END IF;
            END""";

    static long orphans(String invDb, String orderDb) throws Exception {
        return count(invDb, "SELECT COUNT(*) FROM " + invDb + ".inventory_reservations r WHERE NOT EXISTS (SELECT 1 FROM " + orderDb + ".orders o WHERE o.id = r.order_id)");
    }

    static long reserved(String db) throws Exception {
        return count(db, "SELECT COALESCE(SUM(reserved), 0) FROM inventory");
    }

    @Test
    void consistency() throws Exception {
        freshDatabase(MONO_DB); freshDatabase(ORDER_DB); freshDatabase(INV_DB);
        Process inv = null;
        try (ConfigurableApplicationContext mono = startMono()) {
            seed(MONO_DB, true, true);
            inv = startInventoryService();
            seed(INV_DB, false, true);
            try (ConfigurableApplicationContext split = startSplitOrder(false, 10_000);
                 ConfigurableApplicationContext impatient = startSplitOrder(false, 1_000)) {
                seed(ORDER_DB, true, false);
                for (String db : new String[]{MONO_DB, ORDER_DB}) {
                    try (Connection c = root(db); Statement st = c.createStatement()) { st.execute(TRIGGER); }
                }

                System.out.printf("═══ 0.2.2 ① reserve() 之後、commit 之前失敗：每種部署 100 張（load %s）═══%n", load());
                for (var e : Map.of("一個行程", mono, "切開", split).entrySet().stream().sorted(Map.Entry.comparingByKey((a, b) -> a.equals("一個行程") ? -1 : 1)).toList()) {
                    String db = e.getKey().equals("一個行程") ? MONO_DB : ORDER_DB;
                    String invDb = e.getKey().equals("一個行程") ? MONO_DB : INV_DB;
                    long r0 = reserved(invDb), o0 = orphans(invDb, db);
                    Map<Integer, Integer> codes = new TreeMap<>();
                    String sample = null;
                    for (int i = 0; i < 100; i++) {
                        Result r = placeOrder(e.getValue(), FAIL_BUYER, 3, null);
                        codes.merge(r.status(), 1, Integer::sum);
                        if (sample == null) sample = r.body();
                    }
                    System.out.printf("  %-6s │ 回應 %s │ 這位買家的訂單 %d 張 │ 沒有訂單的預留 +%d 列 │ reserved +%d 件%n",
                            e.getKey(), codes, count(db, "SELECT COUNT(*) FROM orders WHERE buyer_id = " + FAIL_BUYER),
                            orphans(invDb, db) - o0, reserved(invDb) - r0);
                    System.out.println("           第一個回應：" + sample);
                }

                System.out.printf("═══ 0.2.2 ② 庫存服務 commit 之後慢 1.5 秒才回應，訂單服務只等 1 秒：20 張（load %s）═══%n", load());
                long r0 = reserved(INV_DB), o0 = orphans(INV_DB, ORDER_DB), ord0 = count(ORDER_DB, "SELECT COUNT(*) FROM orders");
                inventoryDelay(1_500);
                Map<Integer, Integer> codes = new TreeMap<>();
                String[] keys = new String[20];
                String sample = null;
                for (int i = 0; i < 20; i++) {
                    keys[i] = "d00-k2-timeout-" + i + "-" + System.nanoTime();
                    Result r = placeOrder(impatient, 888_000 + i, 3, keys[i]);
                    codes.merge(r.status(), 1, Integer::sum);
                    if (sample == null) sample = r.body();
                }
                inventoryDelay(0);
                TimeUnit.SECONDS.sleep(2);                                  // 讓最後一個「慢回應」也結束
                System.out.printf("  第一次送   │ 回應 %s │ 訂單 +%d 張 │ 沒有訂單的預留 +%d 列 │ reserved +%d 件%n",
                        codes, count(ORDER_DB, "SELECT COUNT(*) FROM orders") - ord0, orphans(INV_DB, ORDER_DB) - o0, reserved(INV_DB) - r0);
                System.out.println("             第一個回應：" + sample);
                codes.clear();
                for (int i = 0; i < 20; i++) codes.merge(placeOrder(impatient, 888_000 + i, 3, keys[i]).status(), 1, Integer::sum);
                System.out.printf("  同一個鍵重送 │ 回應 %s │ 訂單 +%d 張 │ 沒有訂單的預留 +%d 列 │ reserved +%d 件%n",
                        codes, count(ORDER_DB, "SELECT COUNT(*) FROM orders") - ord0, orphans(INV_DB, ORDER_DB) - o0, reserved(INV_DB) - r0);
                System.out.printf("  （結束時 load %s）%n", load());
            }
        } finally {
            if (inv != null) { inv.destroy(); inv.waitFor(30, TimeUnit.SECONDS); }
        }
    }
}
```

**`src/test/java/com/example/shop/dist00/K3SplitCascadeTest.java`**（0.2.3）

```java
package com.example.shop.dist00;

import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.example.shop.dist00.SplitLab.*;

/**
 * 13 站 0.2.3 代價三：一個服務慢，連累另一個服務裡「跟它無關」的 API。
 * 切開的部署，每秒固定送 20 張下單（開放式負載：不管前一張回來沒有，時間到就送下一張）；同時每 200 ms 打一次訂單服務的兩支「不下單」的 API：
 *   商品詳情 GET /api/products/{id}（公開，大部分走 Redis 快取）、我的訂單 GET /api/orders（要查資料庫）。
 * 三段，每段 20 秒：庫存服務正常 → 每次預留之後慢 3 秒 → 恢復正常。每秒記一次訂單服務的連線池（Hikari 的 active / pending）。
 * 第一版用 40 條執行緒不停地下單（封閉式）：連「正常」那一段連線池都是滿的（active 20、pending 21），量不出「變慢」的差別 —— 作廢。
 * 依「送出的時間」分段：慢的那一段送出、恢復之後才回來的請求，算在慢的那一段。
 *
 * mvn test -Pexperiments -Dtest=K3SplitCascadeTest
 */
@Tag("experiment")
class K3SplitCascadeTest {

    record Probe(long atMs, String what, int status, long nanos) {}

    @Test
    void cascade() throws Exception {
        freshDatabase(ORDER_DB); freshDatabase(INV_DB);
        Process inv = startInventoryService();
        try (ConfigurableApplicationContext split = startSplitOrder(false, 10_000)) {
            seed(INV_DB, false, true);
            seed(ORDER_DB, true, false);
            MeterRegistry meters = split.getBean(MeterRegistry.class);
            for (int i = 0; i < 300; i++) placeOrder(split, K1SplitLatencyTest.buyer(), 3, null);   // 暖機；也讓「我的訂單」有東西可查
            long probeBuyer = 4_242_424;
            for (int i = 0; i < 5; i++) placeOrder(split, probeBuyer, 1, null);

            System.out.printf("═══ 0.2.3 庫存服務變慢：訂單服務的其他 API 怎麼了（每秒 20 張下單；load %s）═══%n", load());
            long t0 = System.nanoTime();
            AtomicBoolean stop = new AtomicBoolean();
            ConcurrentLinkedQueue<Probe> orders = new ConcurrentLinkedQueue<>(), probes = new ConcurrentLinkedQueue<>();
            ExecutorService load = Executors.newVirtualThreadPerTaskExecutor();
            Thread sender = new Thread(() -> {
                for (long i = 0; !stop.get(); i++) {
                    long due = t0 + i * 50_000_000L;                       // 每 50 ms 一張 = 每秒 20 張
                    long wait = due - System.nanoTime();
                    if (wait > 0) try { Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000)); } catch (InterruptedException e) { return; }
                    long sentAt = (System.nanoTime() - t0) / 1_000_000;
                    load.submit(() -> {
                        Result r = placeOrder(split, K1SplitLatencyTest.buyer(), 3, null);
                        orders.add(new Probe(sentAt, "order", r.status(), r.nanos()));
                    });
                }
            });
            sender.start();
            Thread prober = new Thread(() -> {
                while (!stop.get()) {
                    long at = (System.nanoTime() - t0) / 1_000_000;
                    Result d = get(split, "/api/products/" + FIRST_PRODUCT, 0);
                    probes.add(new Probe(at, "detail", d.status(), d.nanos()));
                    at = (System.nanoTime() - t0) / 1_000_000;
                    Result o = get(split, "/api/orders", probeBuyer);
                    probes.add(new Probe(at, "myorders", o.status(), o.nanos()));
                    try { Thread.sleep(200); } catch (InterruptedException e) { return; }
                }
            });
            prober.start();
            List<String> pool = new ArrayList<>();
            String[] phase = {"正常", "慢 3 秒", "恢復"};
            for (int p = 0; p < 3; p++) {
                inventoryDelay(p == 1 ? 3_000 : 0);
                for (int s = 0; s < 20; s++) {
                    Thread.sleep(1_000);
                    pool.add(String.format("%3d 秒 %-5s active %2.0f pending %3.0f", (System.nanoTime() - t0) / 1_000_000_000L, phase[p],
                            meters.get("hikaricp.connections.active").gauge().value(), meters.get("hikaricp.connections.pending").gauge().value()));
                }
            }
            stop.set(true);
            sender.join();
            prober.join();
            load.shutdown();
            load.awaitTermination(60, TimeUnit.SECONDS);
            inventoryDelay(0);

            for (int p = 0; p < 3; p++) {
                long from = p * 20_000L, to = from + 20_000L;
                for (String what : new String[]{"order", "detail", "myorders"}) {
                    var src = what.equals("order") ? orders : probes;
                    List<Probe> in = src.stream().filter(x -> x.what().equals(what) && x.atMs() >= from && x.atMs() < to).toList();
                    long[] s = in.stream().mapToLong(Probe::nanos).sorted().toArray();
                    Map<Integer, Integer> codes = new TreeMap<>();
                    in.forEach(x -> codes.merge(x.status(), 1, Integer::sum));
                    System.out.printf("  %-5s │ %-8s │ %4d 次 │ p50 %8.1f ms │ p99 %8.1f ms │ max %8.1f ms │ %s%n", phase[p],
                            Map.of("order", "下單", "detail", "商品詳情", "myorders", "我的訂單").get(what), in.size(), pct(s, 50), pct(s, 99), pct(s, 100), codes);
                }
            }
            System.out.println("  連線池（每秒）：");
            for (String line : pool) System.out.println("    " + line);
            System.out.printf("  （結束時 load %s）%n", load());
        } finally {
            inv.destroy();
            inv.waitFor(30, TimeUnit.SECONDS);
        }
    }
}
```

**`src/test/java/com/example/shop/dist00/K5SplitTraceTest.java`**（0.2.4）

```java
package com.example.shop.dist00;

import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static com.example.shop.dist00.SplitLab.*;

/**
 * 13 站 0.2.4 代價四的一個切面：出事的時候，同一張訂單在兩個服務的日誌裡接得起來嗎？
 * 訂單服務回應的 X-Trace-Id（第 12 站 9.8），對上庫存服務那一行 D00_RESERVE 的 traceId 與收到的 traceparent。
 * 兩種寫法：自己 RestClient.builder()（預設）、Spring Boot 自動設定的 RestClient.Builder（lab.d00.traced=true）。
 * 分兩段：① 訂單服務呼叫一個只記錄 header 的假伺服器 —— 看客戶端送了什麼；② 接真的庫存服務 —— 看庫存服務的日誌。
 * 第一版只有 ②：兩種寫法庫存服務收到的 traceparent 都是 null —— 分不出是「沒送」還是「被丟掉」（第 12 站 9.8.4 的 filter）。
 *
 * mvn test -Pexperiments -Dtest=K5SplitTraceTest
 */
@Tag("experiment")
class K5SplitTraceTest {

    @Test
    void trace() throws Exception {
        freshDatabase(ORDER_DB); freshDatabase(INV_DB);
        Path log = Path.of("target/d00-inventory-service.log");
        Process inv = startInventoryService();
        try {
            seed(INV_DB, false, true);
            System.out.printf("═══ 0.2.4 ① 訂單服務呼叫庫存時，送出了哪些 trace header（假的庫存服務，只記錄 header）（load %s）═══%n", load());
            for (boolean traced : new boolean[]{false, true}) {
                java.util.concurrent.atomic.AtomicReference<String> seen = new java.util.concurrent.atomic.AtomicReference<>("（沒有請求）");
                com.sun.net.httpserver.HttpServer capture = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
                capture.createContext("/", ex -> {
                    StringBuilder h = new StringBuilder();
                    ex.getRequestHeaders().forEach((k, v) -> {
                        String key = k.toLowerCase(java.util.Locale.ROOT);
                        if (key.equals("traceparent") || key.equals("tracestate") || key.startsWith("b3") || key.startsWith("x-b3")) h.append(key).append('=').append(v).append(' ');
                    });
                    seen.set(h.isEmpty() ? "（沒有任何 trace header）" : h.toString().strip());
                    ex.sendResponseHeaders(204, -1);
                    ex.close();
                });
                capture.start();
                List<String> a = common(ORDER_DB, 12);
                a.addAll(List.of("--lab.d00.remote-inventory-url=http://127.0.0.1:" + capture.getAddress().getPort(), "--lab.d00.traced=" + traced));
                try (ConfigurableApplicationContext order = new SpringApplicationBuilder(com.example.shop.ShopApplication.class).run(a.toArray(String[]::new))) {
                    if (!traced) seed(ORDER_DB, true, false);
                    HttpResponse<String> r = CLIENT.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port(order) + "/api/orders"))
                            .header("Content-Type", "application/json").header("Authorization", TestTokens.bearer(order, 4_200_000 + (traced ? 1 : 0)))
                            .header("Idempotency-Key", UUID.randomUUID().toString())
                            .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + FIRST_PRODUCT + ",\"quantity\":1,\"unitPrice\":100.00}]}")).build(),
                            HttpResponse.BodyHandlers.ofString());
                    System.out.printf("  %-32s │ 訂單服務 %d，X-Trace-Id %s%n", traced ? "Spring 的 RestClient.Builder" : "自己 RestClient.builder()",
                            r.statusCode(), r.headers().firstValue("X-Trace-Id").orElse("（沒有）"));
                    System.out.println("  " + " ".repeat(32) + " │ 送出的 header：" + seen.get());
                } finally {
                    capture.stop(0);
                }
            }
            freshDatabase(ORDER_DB);
            System.out.printf("═══ 0.2.4 ② 同一張訂單，兩個服務的 traceId（真的庫存服務）（load %s）═══%n", load());
            for (boolean traced : new boolean[]{false, true}) {
                List<String> a = common(ORDER_DB, 12);
                a.addAll(List.of("--lab.d00.remote-inventory-url=http://127.0.0.1:" + INV_PORT, "--lab.d00.traced=" + traced));
                try (ConfigurableApplicationContext order = new SpringApplicationBuilder(com.example.shop.ShopApplication.class).run(a.toArray(String[]::new))) {
                    if (!traced) seed(ORDER_DB, true, false);
                    HttpResponse<String> r = CLIENT.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port(order) + "/api/orders"))
                            .header("Content-Type", "application/json").header("Authorization", TestTokens.bearer(order, 4_100_000 + (traced ? 1 : 0)))
                            .header("Idempotency-Key", UUID.randomUUID().toString())
                            .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + FIRST_PRODUCT + ",\"quantity\":1,\"unitPrice\":100.00}]}")).build(),
                            HttpResponse.BodyHandlers.ofString());
                    String orderId = r.body().replaceAll(".*\"orderNo\":\"([^\"]+)\".*", "$1");
                    TimeUnit.MILLISECONDS.sleep(500);
                    List<String> lines = Files.readAllLines(log);
                    String reserveLine = lines.stream().filter(l -> l.contains("D00_RESERVE")).reduce((x, y) -> y).orElse("（沒有）");
                    System.out.printf("  %-32s │ 訂單服務 %d %s，X-Trace-Id %s%n", traced ? "Spring 的 RestClient.Builder" : "自己 RestClient.builder()",
                            r.statusCode(), orderId, r.headers().firstValue("X-Trace-Id").orElse("（沒有）"));
                    System.out.println("  " + " ".repeat(32) + " │ 庫存服務 " + reserveLine.replaceAll("^.*?\\] \\[", "[").replaceAll("\\s+c\\.e\\.s\\.d\\.LabInventoryService\\s+:", ""));
                }
            }
        } finally {
            inv.destroy();
            inv.waitFor(30, TimeUnit.SECONDS);
        }
    }
}
```

**`scripts/d00-change-coupling.sh`**（0.3.3（要 `chmod +x`））

```bash
#!/usr/bin/env bash
# 13 站 0.3.3：變更耦合 —— 歷史上的每一個 commit，碰了哪幾個模組的正式程式碼？
# 用法：scripts/d00-change-coupling.sh [<revision range>]     預設：整個目前分支的歷史（第一個 parent 那一條）
# 「碰了一個模組」= 改了 src/main/java/com/example/shop/<模組>/ 底下的檔案，或檔名是 V<n>__<模組>_….sql 的 migration。
# 只看 src/main：測試、腳本、文件不算（拆開之後，它們不需要兩個團隊協調）。
set -euo pipefail
range="${1:-HEAD}"
git log --first-parent --no-merges --name-only --format='@%h' "$range" | awk '
  /^@/ { flush(); n++; next }
  /^src\/main\/java\/com\/example\/shop\/[a-z]+\// { split($0, p, "/"); m[p[7]] = 1; next }
  /^src\/main\/resources\/db\/migration\/V[0-9]+__[a-z]+_/ { f = $0; sub(/.*\/V[0-9]+__/, "", f); sub(/_.*/, "", f); m[f] = 1; next }
  function flush(   k, cnt, list, i, j, mods) {
    cnt = 0; list = ""
    for (k in m) { cnt++; mods[cnt] = k }
    if (cnt > 0) {
      touched++; hist[cnt > 4 ? "5+" : cnt]++
      for (i = 1; i <= cnt; i++) { single[mods[i]]++
        for (j = 1; j <= cnt; j++) if (mods[i] < mods[j]) pair[mods[i] "+" mods[j]]++ }
    }
    delete m
  }
  END {
    flush()
    printf "commit：%d 個；改到正式程式碼的：%d 個\n", n, touched
    printf "一個 commit 碰了幾個模組：\n"
    split("1 2 3 4 5+", ks, " ")
    for (i = 1; i <= 5; i++) printf "  %-3s 個  %3d 個 commit（%4.1f%%）\n", ks[i], hist[ks[i]], 100 * hist[ks[i]] / touched
    printf "每個模組被改了幾次：\n"
    for (k in single) printf "  %-13s %3d\n", k, single[k] | "sort -k2 -nr"
    close("sort -k2 -nr")
    printf "最常一起被改的模組（前 10 組）：\n"
    for (k in pair) printf "  %-26s %3d 次（%4.1f%%）\n", k, pair[k], 100 * pair[k] / touched | "sort -k2 -nr | head -10"
    close("sort -k2 -nr | head -10")
  }'
```

---

## 0.10 常見誤區

**「切開之後延遲只多 3 ms，所以拆分很便宜。」**
0.2.1 的 3 ms 是 loopback 上、整張訂單一次呼叫的下限。介面是「每項一次」的，10 個品項就多 20 ms；吞吐掉了 18%～34%。而延遲是四個代價裡最小的一個 —— 0.2.2、0.2.3 的代價不是毫秒，是錯的資料與倒掉的服務。

**「邊界已經畫好了，換成 HTTP 就是微服務。」**
0.2.0 的 `RemoteInventoryApi` 確實只有一百多行。但它換掉的不只是呼叫方式：`MANDATORY` 的交易語意沒了（0.2.2）、交易裡多了一段控制不了長度的等待（0.2.3）、一個只讀的頁面多了一個跨服務的依賴（0.2.3 的 ⚠️）、traceId 斷了（0.2.4）。**「邊界畫好了」讓拆分變得做得到，沒有讓它變得便宜。**

**「冪等鍵已經做好了，重送是安全的。」**
第 12 站的冪等鍵保護的是訂單服務自己的交易。0.2.2 ②：同一個鍵重送，訂單只成立一張，`reserved` 卻多了 120 件 —— 下游的呼叫需要自己的冪等，而且第一次失敗之後連 `orderId` 都換了。

**「兩邊的對帳都通過，資料就是對的。」**
0.2.2 ①：訂單資料庫沒有訂單，正確；庫存資料庫每一筆預留都有帳，INV-2、INV-3 都通過。錯的是「預留屬於一張存在的訂單」—— 這一條規則跨了兩個資料庫，沒有任何一邊的對帳看得到它。

**「服務 A 慢，最多就是 A 的功能慢。」**
0.2.3：庫存服務每一個請求都成功，只是慢 3 秒；訂單服務一半的下單 503，跟庫存無關的「我的訂單」p50 變成 1.9 秒。等待的時候佔著什麼（這裡是資料庫連線），慢就沿著那個資源傳出去。

**「traceId 是框架自動帶的。」**
自動的前提是：客戶端是框架管理的（0.2.4：自己 `RestClient.builder()` 什麼都不送），而且收的那一邊願意接（第 12 站 9.8.4 的 filter 一律丟掉）。在一個行程裡兩件事都不需要想。

**「拆了就回不去。」**
0.6 的三個案例都合回去了，而且都是量完之後的決定。第 09 章會把「合回單體」當成一個正常的遷移來做。

---

## 0.11 本章小結

這一章把第 12 站的庫存模組切成另一個行程、另一個資料庫，量了四個代價：

1. **延遲**（0.2.1）：每張 +2.5～3 ms（loopback 的下限）；介面粒度不對時，延遲跟品項數一起長；吞吐 −18%～−34%。
2. **一致性**（0.2.2）：`@Transactional` 停在服務的邊界上。失敗之後 300 列孤兒預留；逾時加重送，`reserved` 多 120 件 —— 兩邊各自都是對的。
3. **故障傳遞**（0.2.3）：遠端呼叫在本地交易裡，等待佔著連線；庫存慢 3 秒，訂單服務裡無關的 API 也倒。
4. **除錯與維運**（0.2.4）：traceId 斷在邊界的兩邊；部署單位、資料庫、管線各多一份。

然後回答「該不該拆」（0.3）：六個問題 —— 負載、資料、團隊、發布節奏、技術棧、故障隔離 —— 第 12 站的專案六題都是「不」；變更耦合說庫存與訂單是一起長大的（7 次功能改動裡 4 次一起改）。**這個系統不該拆。** 康威定律（0.4）說服務的邊界會長在團隊的邊界上，一個團隊不需要服務的邊界；模組化單體（0.5）已經拿到了微服務大部分的好處，拿不到的只有獨立部署與獨立擴展。三個公開案例（0.6）—— Segment、Istio、Prime Video —— 都是量完之後合回去的。

接下來八章，拿這個不該拆的系統當練習台，一樣一樣把拆分拿走的東西蓋回來，並且量每一樣的成本。

### 0.11.1 驗收清單

- [ ] 從第 12 站的專案開出 `d00` 分支，`docker compose up -d --wait` 之後，`mvn test -Pexperiments -Dtest=K5SplitTraceTest` 印出 0.2.4 的兩段、`BUILD SUCCESS`。
- [ ] 跑 K1，說出「一次呼叫」與「每項一次」在 10 個品項時差多少，以及差在哪裡。
- [ ] 跑 K2，指出孤兒預留是哪一行程式碼造成的（提示：`LabInventoryService` 裡）。
- [ ] 說出 0.2.2 ② 為什麼用同一個 `Idempotency-Key` 重送，`reserved` 還是多了。
- [ ] 跑 K3，說出「我的訂單」為什麼會變慢 —— 它根本不呼叫庫存服務。
- [ ] 說出 traceId 在 0.2.4 斷掉的兩個地方，以及第 12 站為什麼要那樣設計其中一個。
- [ ] 在你自己的專案上跑 `scripts/d00-change-coupling.sh`，指出最常一起被改的兩個模組。
- [ ] **不看課文**，說出 0.3.2 的六個問題，以及第 12 站的專案在每一題的答案。
- [ ] 說出 0.6 三個案例各自合回去的理由。
- [ ] `mvn clean verify` 全綠（0.9）：這一章加的東西沒有改變任何一個既有的測試。

---

## 0.12 下一章預告

這一章的結論是「不該拆」，但也留下了一個訊號：0.3.3 說庫存與訂單總是一起改。如果真的要拆，這一刀切在這裡就會一直痛 —— 那該切在哪裡？

下一章（01）處理**邊界怎麼切**：

- **從第 12 站的模組邊界出發**：九個模組裡，哪些是「業務能力」、哪些只是「名詞」（0.6.1 的 Segment 就是依名詞切的）。
- **用變更耦合與交易邊界找切點**：0.3.3 的那張表，加上「哪些寫入必須在同一個交易裡」（聚合）。
- **先拆模組、再拆行程**：在一個行程裡先把邊界修到對，用第 12 站的 `ModuleBoundaryTest` 守住，再決定哪一塊值得變成行程。
- **切錯的症狀**：每次改動都要動兩個服務、兩個服務總是一起部署、一個服務的資料總是要問另一個服務。

0.2 的實驗支架會一直留著：每一章改完，都回來量同樣的四個代價，看它們變大還是變小。
