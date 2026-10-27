# 第 06 章：服務網的韌性

> **上一章**：[第 05 章](05-cross-service-query.md)讓三個「讀」的頁面不再問庫存服務，它們讀訂單服務自己的副本。寫還要問：訂單服務打庫存服務的 14 次裡，10 次是寫，其中**預留在下單的路徑上**（5.14）。第 04 章 4.10.7 的 K3：庫存服務的預留慢 3 秒，下單也慢 3 秒，但沒有失敗；等的那 3 秒不再佔資料庫連線，每一張下單卻還佔著一條 Tomcat 的執行緒、一條 HTTP 連線。
>
> **這一章**：處理「等」。先把 K3 用**正式的逾時**重跑。K3 照第 00 章，讓訂單服務等 10 秒；正式的設定是 read timeout 3 秒、沒有回應再送一次（第 03 章 3.5）。再量**重試風暴**，分兩個問題：每一層都重送時，最底下收到的是不是乘起來的；觸發的原因消失之後，系統回不回得來。然後做四件事：
>
> - **逾時預算由外而內遞減**，並把剩下的時間告訴庫存服務
> - **重送只在一層**，而且有預算
> - **隔艙**
> - 決定**熔斷器放在哪一層**
>
> 最後討論下單能不能不等庫存。
>
> **你手上會有**：從 `d05` 開出來的分支 `d06`。正式程式碼的改變：
>
> - `shared.resilience` 多了三個類別：`Deadline`、`RetryBudget`、`BudgetFilter`。
> - `RemoteInventoryApi` 的每一次呼叫，先過隔艙、預算、熔斷器；沒有回應時的重送，還要過重試預算。
> - read timeout 從 3 秒改成 1 秒；下單的預算 2 秒，並有兩條啟動時的檢查。
> - 庫存服務的預留借到資料庫連線之後，先看呼叫端還剩多少時間。
> - 下單在寫訂單之前，先問預留的熔斷器（`InventoryApi.ensureReservable`）。
> - 新的依賴：Resilience4j 2.2.0 的熔斷器、隔艙、指標三個模組。
>
> 測試 355 個，failsafe 契約驗證 39 個。

---

## 6.1 學習目標

讀完這一章，你應該能：

- 用**利特爾法則**（同時在等的請求數 = 每秒進來幾個 × 每個等幾秒）算出一個慢的下游會佔住多少條執行緒，並說出為什麼「慢」比「停掉」危險。
- 說出逾時怎麼**由外而內遞減**：這條線上每一個「等」的上限各是多少、誰要比誰短；把剩下的時間告訴下游，讓它不做呼叫端已經放棄的事。
- 用乘法算出每一層都重送時最底層收到多少，並解釋為什麼觸發的原因消失了，系統卻可能**回不來**，以及負載多高時才會。
- 說出重送該放在哪一層，以及**重試預算**怎麼限制它。
- 用**隔艙**替「等某一個服務」的執行緒設上限，並用利特爾法則算它的大小。
- 決定**熔斷器的顆粒度**（一個服務一個，還是一種呼叫一個）、什麼算失敗、打開時回什麼、補償為什麼不經過它，以及它為什麼不是第一道防線。
- 回答「下單能不能不等庫存」，並說明那是需求的改變，不只是技術的改變。

---

## 6.2 先看見痛：慢 3 秒的庫存服務，用正式的逾時 ★★★

### 6.2.0 開分支

```bash
git switch -c d06 d05
```

這一章的第一個 commit 只有兩個實驗（G1、G2），正式程式碼還是第 05 章的。

### 6.2.1 實驗怎麼做（G1）

第 04 章 4.10.7 的 K3，參數照第 00 章：

- 每秒 20 張下單。
- 中間 20 秒，庫存服務的預留慢 3 秒。
- **訂單服務等 10 秒**。

正式的設定不是 10 秒，是第 03 章定的：connect 1 秒、read 3 秒；沒有回應時，用同一個冪等鍵再送一次（3.5）。

G1 用正式的設定重跑：

- 兩種速率：每秒 20 張（K3 的速率）、每秒 40 張。
- 每一種三段，各 20 秒：正常 → 預留慢 3 秒 → 恢復。
- 「慢」用的是第 03 章的 `LostResponse`：庫存服務照常預留、commit，回應晚 3 秒才送出。
- 每 200 ms 打兩支不下單的 API：商品詳情（第 05 章之後讀副本，不問庫存服務）、我的訂單（只讀自己的庫）。
- 每秒記一次：
  - 訂單服務的 Tomcat：忙著的工作執行緒、排隊等執行緒的請求。
  - 還沒回應的下單。
  - 這一秒送給庫存服務的預留（第 03 章的 `CallTap`，在呼叫端數）。
  - 連線池。

```java
    void run(ConfigurableApplicationContext order, int rate) throws Exception {
        out.printf("═══ 每秒 %d 張下單（load %s）═══%n", rate, SplitLab.load());
        CallTap.CALLS.clear();
        MeterRegistry meters = order.getBean(MeterRegistry.class);
        List<String> phases = List.of("正常", "慢 3 秒", "恢復");
        List<String> perSecond = new ArrayList<>();
        long[] puts = new long[phases.size()];
        long reservesBefore = 0;
        long firstOrder = SplitLab.count(Split.ORDER_DB, "SELECT COALESCE(MAX(id), 0) FROM orders");
        double noResponseBefore = noResponse(meters);
        Rig rig = new Rig(order);
        try (rig) {
            rig.orders(rate, 1).probes(PROBE_BUYER);
            for (int p = 0; p < phases.size(); p++) {
                if (phases.get(p).equals("慢 3 秒")) LostResponse.arm("PUT", "/reservations/", 3_000, Integer.MAX_VALUE);
                if (phases.get(p).equals("恢復")) LostResponse.reset();
                for (int s = 0; s < 20; s++) {
                    Thread.sleep(1_000);
                    long reserves = CallTap.CALLS.stream().filter(c -> c.method().equals("PUT") && c.path().startsWith("/internal/inventory/v1/reservations/")).count();
                    puts[p] += reserves - reservesBefore;
                    perSecond.add(String.format("%3d 秒 %-5s │ %s │ 還沒回應的下單 %3d │ 這一秒送給庫存服務的預留 %3d │ %s", rig.now() / 1000, phases.get(p),
                            Rig.tomcat(order), rig.inFlight.get(), reserves - reservesBefore, Rig.hikari(order)));
                    reservesBefore = reserves;
                }
            }
        }
        for (int p = 0; p < phases.size(); p++) {
            long from = p * 20_000L, to = from + 20_000L;
            for (String what : new String[]{"order", "detail", "myorders"}) out.println(rig.summary(phases.get(p), what, from, to));
        }
        for (int p = 0; p < phases.size(); p++) {
            long from = p * 20_000L, to = from + 20_000L;
            long intents = rig.done.stream().filter(d -> d.atMs() >= from && d.atMs() < to).count();
            out.printf("  %-6s │ 下單 %4d 張 │ 送給庫存服務的預留 %4d 次（這一段的 20 秒裡）%n", phases.get(p), intents, puts[p]);
        }
        out.printf("  訂單服務記到的「沒有回應」%.0f 次%n", noResponse(meters) - noResponseBefore);
        out.println("  每秒：");
        for (String line : perSecond) out.println("    " + line);
        out.printf("  這一輪的訂單，狀態：%s%n", Rig.one(Split.ORDER_DB, "SELECT CONCAT('{', GROUP_CONCAT(CONCAT(status, '=', n) ORDER BY status), '}') FROM "
                + "(SELECT status, COUNT(*) AS n FROM orders WHERE id > " + firstOrder + " GROUP BY status) x"));
        out.printf("  其中卡在 RESERVING 的，庫存服務那一邊有預留的：%s 張%n", Rig.one(Split.INV_DB, "SELECT COUNT(DISTINCT r.order_id) FROM inventory_reservations r JOIN "
                + Split.ORDER_DB + ".orders o ON o.id = r.order_id WHERE o.status = 'RESERVING' AND o.id > " + firstOrder + " AND r.status = 'HELD'"));
    }
```

實驗台 `Rig` 的完整類別在 6.11.1，包括：開放式負載（第 00 章 0.2.3：時間到就送下一張，不管前一張回來沒有）、每 200 ms 的兩支 API、Tomcat 與連線池的讀法。

### 6.2.2 結果

```bash
mvn test -Pexperiments -Dtest=G1CascadeTest
```

```
═══ 6.2 庫存服務的預留慢 3 秒，訂單服務用正式的逾時（connect 1000 ms、read 3000 ms、沒有回應再送一次）═══
═══ 每秒 20 張下單（load { 5.25 5.38 5.02 }）═══
  正常     │ 下單   │  400 次 │ p50     25.5 ms │ p99     52.9 ms │ max     94.1 ms │ {201=400}
  正常     │ 商品詳情 │   95 次 │ p50      2.0 ms │ p99     28.7 ms │ max     28.7 ms │ {200=95}
  正常     │ 我的訂單 │   95 次 │ p50      4.8 ms │ p99     26.2 ms │ max     26.2 ms │ {200=95}
  慢 3 秒  │ 下單   │  400 次 │ p50   6013.7 ms │ p99   6026.3 ms │ max   6052.8 ms │ {201=60, 503=340}
  慢 3 秒  │ 商品詳情 │   96 次 │ p50      2.3 ms │ p99      4.8 ms │ max      4.8 ms │ {200=96}
  慢 3 秒  │ 我的訂單 │   96 次 │ p50      4.5 ms │ p99      8.1 ms │ max      8.1 ms │ {200=96}
  恢復     │ 下單   │  400 次 │ p50     23.7 ms │ p99     59.3 ms │ max   3022.6 ms │ {201=400}
  恢復     │ 商品詳情 │   95 次 │ p50      1.7 ms │ p99     29.4 ms │ max     29.4 ms │ {200=95}
  恢復     │ 我的訂單 │   95 次 │ p50      4.0 ms │ p99     23.9 ms │ max     23.9 ms │ {200=95}
  正常     │ 下單  400 張 │ 送給庫存服務的預留  402 次（這一段的 20 秒裡）
  慢 3 秒  │ 下單  400 張 │ 送給庫存服務的預留  741 次（這一段的 20 秒裡）
  恢復     │ 下單  400 張 │ 送給庫存服務的預留  461 次（這一段的 20 秒裡）
  訂單服務記到的「沒有回應」740 次
  每秒：
      1 秒 正常    │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0
      2 秒 正常    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  1 pending   0
     19 秒 正常    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0
     20 秒 正常    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  21 │ 連線池 active  0 pending   0
     21 秒 慢 3 秒 │ Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 這一秒送給庫存服務的預留  19 │ 連線池 active  1 pending   0
     22 秒 慢 3 秒 │ Tomcat 忙  40/200 排隊    0 │ 還沒回應的下單  40 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  1 pending   0
     23 秒 慢 3 秒 │ Tomcat 忙  60/200 排隊    0 │ 還沒回應的下單  60 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  1 pending   0
     24 秒 慢 3 秒 │ Tomcat 忙  80/200 排隊    0 │ 還沒回應的下單  80 │ 這一秒送給庫存服務的預留  41 │ 連線池 active  0 pending   0
     25 秒 慢 3 秒 │ Tomcat 忙 100/200 排隊    0 │ 還沒回應的下單 100 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  0 pending   0
     26 秒 慢 3 秒 │ Tomcat 忙 120/200 排隊    0 │ 還沒回應的下單 120 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  0 pending   0
     38 秒 慢 3 秒 │ Tomcat 忙 121/200 排隊    0 │ 還沒回應的下單 121 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  1 pending   0
     39 秒 慢 3 秒 │ Tomcat 忙 121/200 排隊    0 │ 還沒回應的下單 121 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  1 pending   0
     40 秒 慢 3 秒 │ Tomcat 忙 121/200 排隊    0 │ 還沒回應的下單 121 │ 這一秒送給庫存服務的預留  41 │ 連線池 active  1 pending   0
     41 秒 恢復    │ Tomcat 忙  81/200 排隊    0 │ 還沒回應的下單  81 │ 這一秒送給庫存服務的預留  41 │ 連線池 active  0 pending   0
     42 秒 恢復    │ Tomcat 忙  40/200 排隊    0 │ 還沒回應的下單  40 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  1 pending   0
     43 秒 恢復    │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留  39 │ 連線池 active  0 pending   0
     44 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0
     45 秒 恢復    │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0
     46 秒 恢復    │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0
  這一輪的訂單，狀態：{PENDING_PAYMENT=865,RESERVING=340}
  其中卡在 RESERVING 的，庫存服務那一邊有預留的：340 張
═══ 每秒 40 張下單（load { 4.68 5.19 4.97 }）═══
  正常     │ 下單   │  800 次 │ p50     18.7 ms │ p99     84.3 ms │ max    174.4 ms │ {201=800}
  正常     │ 商品詳情 │   97 次 │ p50      1.4 ms │ p99      7.0 ms │ max      7.0 ms │ {200=97}
  正常     │ 我的訂單 │   97 次 │ p50      3.1 ms │ p99     10.3 ms │ max     10.3 ms │ {200=97}
  慢 3 秒  │ 下單   │  800 次 │ p50   6128.0 ms │ p99   8054.5 ms │ max   8080.3 ms │ {201=200, 503=600}
  慢 3 秒  │ 商品詳情 │   29 次 │ p50      1.7 ms │ p99   2945.3 ms │ max   2945.3 ms │ {200=29}
  慢 3 秒  │ 我的訂單 │   28 次 │ p50      3.2 ms │ p99   2071.0 ms │ max   2071.0 ms │ {200=28}
  恢復     │ 下單   │  800 次 │ p50     18.3 ms │ p99    544.0 ms │ max    730.0 ms │ {201=800}
  恢復     │ 商品詳情 │   92 次 │ p50      1.3 ms │ p99     31.7 ms │ max     31.7 ms │ {200=92}
  恢復     │ 我的訂單 │   93 次 │ p50      2.8 ms │ p99    507.2 ms │ max    507.2 ms │ {200=93}
  正常     │ 下單  800 張 │ 送給庫存服務的預留  802 次（這一段的 20 秒裡）
  慢 3 秒  │ 下單  800 張 │ 送給庫存服務的預留 1282 次（這一段的 20 秒裡）
  恢復     │ 下單  800 張 │ 送給庫存服務的預留 1005 次（這一段的 20 秒裡）
  訂單服務記到的「沒有回應」1281 次
  每秒：
      1 秒 正常    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   2 │ 這一秒送給庫存服務的預留  39 │ 連線池 active  1 pending   0
      2 秒 正常    │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  41 │ 連線池 active  0 pending   0
     19 秒 正常    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  0 pending   0
     20 秒 正常    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  1 pending   0
     21 秒 慢 3 秒 │ Tomcat 忙  41/200 排隊    0 │ 還沒回應的下單  41 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  0 pending   0
     22 秒 慢 3 秒 │ Tomcat 忙  81/200 排隊    0 │ 還沒回應的下單  81 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  1 pending   0
     23 秒 慢 3 秒 │ Tomcat 忙 121/200 排隊    0 │ 還沒回應的下單 121 │ 這一秒送給庫存服務的預留  42 │ 連線池 active  0 pending   0
     24 秒 慢 3 秒 │ Tomcat 忙 161/200 排隊    0 │ 還沒回應的下單 161 │ 這一秒送給庫存服務的預留  78 │ 連線池 active  0 pending   0
     25 秒 慢 3 秒 │ Tomcat 忙 200/200 排隊    1 │ 還沒回應的下單 201 │ 這一秒送給庫存服務的預留  81 │ 連線池 active  0 pending   0
     26 秒 慢 3 秒 │ Tomcat 忙 200/200 排隊   41 │ 還沒回應的下單 240 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  1 pending   0
     38 秒 慢 3 秒 │ Tomcat 忙 200/200 排隊  123 │ 還沒回應的下單 322 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  1 pending   0
     39 秒 慢 3 秒 │ Tomcat 忙 200/200 排隊  122 │ 還沒回應的下單 321 │ 這一秒送給庫存服務的預留  81 │ 連線池 active  1 pending   0
     40 秒 慢 3 秒 │ Tomcat 忙 200/200 排隊  122 │ 還沒回應的下單 321 │ 這一秒送給庫存服務的預留  79 │ 連線池 active  0 pending   0
     41 秒 恢復    │ Tomcat 忙 159/200 排隊    0 │ 還沒回應的下單 160 │ 這一秒送給庫存服務的預留 162 │ 連線池 active  1 pending   0
     42 秒 恢復    │ Tomcat 忙  79/200 排隊    0 │ 還沒回應的下單  79 │ 這一秒送給庫存服務的預留  81 │ 連線池 active  1 pending   0
     43 秒 恢復    │ Tomcat 忙   4/200 排隊    0 │ 還沒回應的下單   5 │ 這一秒送給庫存服務的預留  77 │ 連線池 active  3 pending   0
     44 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  42 │ 連線池 active  1 pending   0
     45 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  41 │ 連線池 active  1 pending   0
     46 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  0 pending   0
  這一輪的訂單，狀態：{PENDING_PAYMENT=1809,RESERVING=600}
  其中卡在 RESERVING 的，庫存服務那一邊有預留的：600 張
  （結束時 load { 5.61 5.28 5.01 }）
```

（每秒的那幾行只留 1～2、19～26、38～46 秒；省略的那幾秒，正常的是 Tomcat 忙 0～4 條、連線池 active 0～4，慢的是跟前後一樣的數字。狀態那一行的訂單總數，比三段加起來多幾張：第 60 秒、實驗台停下來之前又送出了幾張，它們不在任何一段裡。）

### 6.2.3 三件事

**一、正式的逾時，把「慢 3 秒」變成「幾乎全部失敗」。** K3 等 10 秒：每一張都在 3 秒多一點成立。換成 3 秒的 read timeout，事情是這樣發生的：

- 回應在 3.0 秒多一點才到，逾時剛好在 3.0 秒觸發。
- 訂單服務用同一個冪等鍵再送一次。庫存服務認得這張訂單，當作重送，一樣在 3 秒後才回應。
- 第二次也逾時，回 503。

每秒 20 張的那一輪，慢的那 20 秒送出的 400 張裡，340 張是 503，p50 6,014 ms。成立的那 60 張，推論是最後 3 秒送出的（每秒 20 張 × 3 秒 = 60）：它們的第二次送出，碰上庫存服務已經恢復。

**使用者等了 6 秒、拿到失敗；庫存服務卻做了兩次。** `LostResponse` 是「做完、commit 之後才晚送」，所以每一個預留都在。這一輪結束時，340 張訂單停在 RESERVING，庫存那一邊每一張都有 HELD 的預留。可售量被它們佔著，直到下面兩件事之一先發生：

- 買家用同一個鍵再送：訂單服務接著做這一張（第 04 章 4.5）。
- 60 秒後排程補償它（4.5.5）。

這一段送給庫存服務的預留是 741 次，正常那一段是 402 次：每一張兩次。

這就是 README 那一條誤區的樣子：**外層早就放棄了，內層還在跑。** 庫存服務不知道訂單服務只等 3 秒，訂單服務也不知道庫存服務需要 3 秒多一點。兩個數字各自看都合理，放在一起，每一張都是最壞的結果：等最久，還是失敗。

**二、每秒 40 張：Tomcat 的 200 條執行緒全滿，跟庫存無關的頁面一起慢。** 一張下單從送出到 503 要 6 秒，這 6 秒都佔著一條 Tomcat 的工作執行緒。同時在等的下單有幾張，用**利特爾法則**算：

```
同時在等的請求數 = 每秒進來幾個 × 每個等幾秒
每秒 20 張 × 6 秒 = 120 條        ← 量到：Tomcat 忙 120～121 條
每秒 40 張 × 6 秒 = 240 條 > 200  ← 量到：200/200，排隊最多 123 個
```

Tomcat 的工作執行緒預設是 200 條。每秒 40 張的那一輪：

- 慢了 5 秒，200 條就全部在等庫存服務。
- 之後進來的每一個請求都在佇列裡排隊，不管它要不要問庫存。
- 商品詳情從第 05 章之後讀副本、一次都不問庫存服務，p99 從 7.0 ms 變成 2,945 ms。
- 我的訂單 p99 2,071 ms。
- 那 20 秒裡，這兩支 API 各只打了 28～29 次（正常那一段是 97 次）：每一次都在排隊。

**慢的那 20 秒，連線池一直是 active 0～1、pending 0。** 第 00 章 0.2.3 那一次，佔住的是資料庫連線（呼叫在交易裡）；第 04 章把呼叫移出交易之後，資料庫連線沒事了。**這一次佔住的是執行緒。** 0.2.3 的 📌 說的是同一件事：「服務 A 慢」變成「服務 B 倒」，中間只隔著一件事 —— B 在等 A 的時候佔著什麼。

> 📌 **第 05 章讓商品頁不再「需要」庫存服務；這一節的商品頁還是被庫存服務拖慢了。** 依賴有兩種：資料上的依賴（這一頁要庫存的資料）、資源上的依賴（這一頁要一條執行緒，而執行緒被等庫存的請求拿光了）。讀模型拿掉了前一種；後一種要靠隔艙（6.6）。

**三、用同一條法則核對第 04 章 4.10.7 的 K3。**

- 每秒 20 張、3 秒是 60 條。K3 量到「還沒回應的下單」最多 61。
- 要剛好用滿 200 條，可以是每秒 20 張、每張等 10 秒（K3 設的等待上限），或者這一節的每秒 40 張、每張 6 秒（240 條，超過）。

---

## 6.3 先看見痛之二：重試風暴 ★★★

### 6.3.1 這條線上，誰會再送一次

| 一層 | 誰寫的 | 什麼時候再送 | 最多送幾次（含第一次） |
|---|---|---|---|
| 買家的 app | 不是我們 | 收到 503，照 `Retry-After` 等一下；用同一個 `Idempotency-Key`（第 12 站 US-ORD-1a：同一個鍵再送是安全的） | 看 app。常見的預設是總共 3 次 |
| 訂單服務 → 庫存服務 | `RemoteInventoryApi`（第 03 章 3.5） | 沒有回應（連不上、逾時） | 2 |
| 庫存服務 → MySQL | —— | 不重送 | 1 |

每一層都只多送「一點點」。G2 量的是這些一點點乘起來之後，最底下的那一個服務收到多少，以及它會不會回不來。

### 6.3.2 實驗怎麼做（G2）

兩個部分，兩個服務用正式的角色，在同一個 JVM 裡。

**① 乘法**：庫存服務的預留要 7 秒才回應，比訂單服務的 3 秒長。每秒 2 張下單、10 秒，買家的 app 送 1 次或最多 3 次。在三個地方數：

| 數的地方 | 怎麼數 |
|---|---|
| app 送了幾次 | 實驗台自己數 |
| 訂單服務送了幾次 | 第 03 章的 `CallTap`，在呼叫端數 |
| 庫存服務處理了幾次 | 一個新的掛勾 `ServerTap`，在庫存服務那一邊數 |

**② 回不來**：要先有一個「量得到容量」的庫存服務。實驗把它的連線池縮成 4 條，每一個預留交易的第一句 SQL 之前先睡 100 ms（`SlowDb`）。從連線池看，這等於那一句 SQL 在 MySQL 裡跑了 100 ms：4 條連線 ÷ 每個預留約 0.1 秒 ≈ **每秒 40 個預留**。

```java
    public <T extends Resultset> T preProcess(Supplier<String> sql, Query query) {
        long ms = sleepMs;
        if (ms <= 0) return null;
        String s = sql.get();
        if (s != null && s.contains("INSERT INTO processed_messages")) {
            try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        return null;
    }
```

每一輪 70 秒，分三段：

- 正常 20 秒。
- **觸發 10 秒**：每一個預留交易睡 1,000 ms，容量掉到每秒約 4 個。
- 回到 100 ms，再看 40 秒。

觸發的原因只有那 10 秒。問題是：之後的 40 秒，系統回不回得來？

三輪：

| 每秒下單 | 用掉庫存服務的容量 | app 最多送幾次 |
|---|---|---|
| 10 張 | 約四分之一 | 1 次 |
| 25 張 | 約六成 | 1 次 |
| 25 張 | 約六成 | 3 次 |

`ServerTap` 每秒記：進來幾個預留、做完幾個、做完的裡面有幾個**呼叫端早就放棄了**、回了幾個 503。「早就放棄」的判斷是：做完的時間 − 進來的時間 > 呼叫端等的時間（第 06 章之前，就是訂單服務的 read timeout 3 秒）。

```java
                String uri = req.getRequestURI();
                if (!req.getMethod().equals("PUT") || !uri.startsWith("/internal/inventory/v1/reservations/")) { chain.doFilter(req, res); return; }
                long in = now();
                ARRIVED.add(in);
                String budget = req.getHeader("Shop-Budget-Ms");
                long waits = budget == null ? callerWaitsMs : Long.parseLong(budget);
                try {
                    chain.doFilter(req, res);
                } finally {
                    HITS.add(new Hit(in, now(), res.getStatus(), Long.parseLong(uri.substring(uri.lastIndexOf('/') + 1)), waits));
                }
```

> ⚠️ **「進來」要在請求一進來就記，不能在 `finally` 裡記。** 在 `finally` 裡記，請求做完才算 —— 排在連線池裡、還沒輪到的請求一個都不算，觸發的那幾秒看起來像「庫存服務一個請求都沒收到」，連線池的 pending 卻在往上爬。所以 `ServerTap` 一進來就記一筆（`ARRIVED`）。

app 那一層的「再送」寫在實驗台裡：

```java
    Done intent(long at, int attempts) {
        long buyer = BUYERS.incrementAndGet();
        long[] ids = ThreadLocalRandom.current().longs(0, SplitLab.PRODUCTS).distinct().limit(3).map(i -> SplitLab.FIRST_PRODUCT + i).toArray();
        String key = UUID.randomUUID().toString();
        long s = System.nanoTime();
        int status = -1;
        for (int t = 1; t <= attempts; t++) {
            HttpResponse<String> r = place(order, buyer, ids, key);
            status = r == null ? -1 : r.statusCode();
            if (t == attempts || (status != 503 && status != -1)) return new Done(at, status, System.nanoTime() - s, t);
            long after = r == null ? 1 : r.headers().firstValue("Retry-After").map(Long::parseLong).orElse(1L);
            try { Thread.sleep(after * 1000); } catch (InterruptedException e) { break; }
        }
        return new Done(at, status, System.nanoTime() - s, attempts);
    }
```

### 6.3.3 ① 乘法

```bash
mvn test -Pexperiments -Dtest=G2RetryStormTest
```

```
═══ 6.3 ① 乘法：庫存服務的預留 7 秒才回應，每秒 2 張、10 秒（load { 4.96 5.15 4.97 }）═══
  app 最多送 1 次 │ 下單意圖 22 │ app 送出 22 次 │ 訂單服務送給庫存服務 44 次 │ 庫存服務處理了 44 次（22 張訂單，每一張 2.0 次）│ 買家最後看到 {503=22} │ 每一個意圖 p50 6.0 秒
  app 最多送 3 次 │ 下單意圖 22 │ app 送出 66 次 │ 訂單服務送給庫存服務 132 次 │ 庫存服務處理了 132 次（22 張訂單，每一張 6.0 次）│ 買家最後看到 {503=22} │ 每一個意圖 p50 20.1 秒
```

這是乘法：

- **app 送 1 次 × 訂單服務送 2 次 = 每張訂單 2 次。**
- **app 送 3 次 × 2 = 6 次。**

三個地方數到的一樣：訂單服務送出幾次，庫存服務就處理了幾次。JDK 的 `HttpClient` 自己沒有偷偷再送（有一些 HTTP 用戶端預設會重試冪等的方法，05-service/06 的 6.6.4 提過 Apache HttpClient 5）。

每一次都是**真的處理了**：同一張訂單的第二次起，庫存服務認得它是重送（第 03 章 3.5 的 `processed_messages`）。重送不會多扣庫存，但每一次都是一個交易、一條連線、一段 Tomcat 執行緒的時間。

使用者那一邊：

- app 送 1 次：等了 6.0 秒才拿到 503。
- app 送 3 次：等了 20.1 秒，最後還是 503。

### 6.3.4 ② 回不來

```
═══ 6.3 ② 回不來：庫存服務的連線池 4 條、每個預留交易 +100 ms；中間 10 秒每個預留交易 +1000 ms（load { 3.90 4.80 4.85 }）═══
═══ 每秒 10 張下單，app 最多送 1 次（load { 3.90 4.80 4.85 }）═══
  正常     │ 下單   │  200 次 │ p50    143.0 ms │ p99    179.7 ms │ max    197.7 ms │ {201=200}
  觸發     │ 下單   │  100 次 │ p50   5113.0 ms │ p99   6050.0 ms │ max   6073.0 ms │ {201=70, 503=30}
  之後     │ 下單   │  400 次 │ p50    146.0 ms │ p99   1918.8 ms │ max   2059.1 ms │ {201=400}
  正常   │ 下單意圖  200 │ 庫存服務收到預留  200 次（1.0 倍）│ 做完  200，其中呼叫端早就放棄的    0 │ 503    0
  觸發   │ 下單意圖  100 │ 庫存服務收到預留  153 次（1.5 倍）│ 做完   94，其中呼叫端早就放棄的   31 │ 503   59
  之後   │ 下單意圖  400 │ 庫存服務收到預留  408 次（1.0 倍）│ 做完  408，其中呼叫端早就放棄的    0 │ 503    0
  觸發結束之後：第 33 秒起恢復（觸發結束後 2 秒）
  每秒：
     20 秒 正常 │ 這一秒成立的下單  10 │ 庫存服務：進來  10、做完  10（呼叫端早就放棄的   0）、503   0 │ 連線池 active  1 pending   0 │ 訂單服務 Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1
     21 秒 觸發 │ 這一秒成立的下單   2 │ 庫存服務：進來  10、做完   2（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending   6 │ 訂單服務 Tomcat 忙  10/200 排隊    0 │ 還沒回應的下單  10
     22 秒 觸發 │ 這一秒成立的下單   4 │ 庫存服務：進來  10、做完   4（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  12 │ 訂單服務 Tomcat 忙  16/200 排隊    0 │ 還沒回應的下單  16
     23 秒 觸發 │ 這一秒成立的下單   4 │ 庫存服務：進來  10、做完   4（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  18 │ 訂單服務 Tomcat 忙  22/200 排隊    0 │ 還沒回應的下單  22
     24 秒 觸發 │ 這一秒成立的下單   4 │ 庫存服務：進來  10、做完   4（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  25 │ 訂單服務 Tomcat 忙  28/200 排隊    0 │ 還沒回應的下單  28
     25 秒 觸發 │ 這一秒成立的下單   4 │ 庫存服務：進來  13、做完   4（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  35 │ 訂單服務 Tomcat 忙  34/200 排隊    0 │ 還沒回應的下單  34
     26 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  20、做完   4（呼叫端早就放棄的   4）、503   5 │ 連線池 active  4 pending  45 │ 訂單服務 Tomcat 忙  44/200 排隊    0 │ 還沒回應的下單  44
     30 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  20、做完   4（呼叫端早就放棄的   4）、503  16 │ 連線池 active  4 pending  60 │ 訂單服務 Tomcat 忙  60/200 排隊    0 │ 還沒回應的下單  60
     31 秒 之後 │ 這一秒成立的下單  10 │ 庫存服務：進來  18、做完  22（呼叫端早就放棄的  11）、503   7 │ 連線池 active  4 pending  46 │ 訂單服務 Tomcat 忙  51/200 排隊    0 │ 還沒回應的下單  51
     32 秒 之後 │ 這一秒成立的下單  36 │ 庫存服務：進來  10、做完  36（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  21 │ 訂單服務 Tomcat 忙  25/200 排隊    0 │ 還沒回應的下單  25
     33 秒 之後 │ 這一秒成立的下單  36 │ 庫存服務：進來  10、做完  36（呼叫端早就放棄的   0）、503   0 │ 連線池 active  1 pending   0 │ 訂單服務 Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1
     69 秒 之後 │ 這一秒成立的下單  10 │ 庫存服務：進來  10、做完  10（呼叫端早就放棄的   0）、503   0 │ 連線池 active  2 pending   0 │ 訂單服務 Tomcat 忙   2/200 排隊    0 │ 還沒回應的下單   2
     70 秒 之後 │ 這一秒成立的下單  10 │ 庫存服務：進來  10、做完  10（呼叫端早就放棄的   0）、503   0 │ 連線池 active  1 pending   0 │ 訂單服務 Tomcat 忙   2/200 排隊    0 │ 還沒回應的下單   2
═══ 每秒 25 張下單，app 最多送 1 次（load { 4.01 4.58 4.76 }）═══
  正常     │ 下單   │  500 次 │ p50    129.8 ms │ p99    219.2 ms │ max    236.6 ms │ {201=500}
  觸發     │ 下單   │  250 次 │ p50   6014.1 ms │ p99   6049.8 ms │ max   6061.7 ms │ {201=13, 503=237}
  之後     │ 下單   │ 1000 次 │ p50   6013.7 ms │ p99   6183.8 ms │ max   6307.4 ms │ {201=80, 503=920}
  正常   │ 下單意圖  500 │ 庫存服務收到預留  500 次（1.0 倍）│ 做完  500，其中呼叫端早就放棄的    0 │ 503    0
  觸發   │ 下單意圖  250 │ 庫存服務收到預留  412 次（1.6 倍）│ 做完  145，其中呼叫端早就放棄的  132 │ 503  267
  之後   │ 下單意圖 1000 │ 庫存服務收到預留 1991 次（2.0 倍）│ 做完 1444，其中呼叫端早就放棄的 1420 │ 503  547
  觸發結束之後：40 秒內沒有恢復
  每秒：
     20 秒 正常 │ 這一秒成立的下單  26 │ 庫存服務：進來  25、做完  26（呼叫端早就放棄的   0）、503   0 │ 連線池 active  3 pending   0 │ 訂單服務 Tomcat 忙   4/200 排隊    0 │ 還沒回應的下單   4
     21 秒 觸發 │ 這一秒成立的下單   4 │ 庫存服務：進來  25、做完   4（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  21 │ 訂單服務 Tomcat 忙  26/200 排隊    0 │ 還沒回應的下單  26
     22 秒 觸發 │ 這一秒成立的下單   4 │ 庫存服務：進來  25、做完   4（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  42 │ 訂單服務 Tomcat 忙  47/200 排隊    0 │ 還沒回應的下單  47
     23 秒 觸發 │ 這一秒成立的下單   4 │ 庫存服務：進來  25、做完   4（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  63 │ 訂單服務 Tomcat 忙  68/200 排隊    0 │ 還沒回應的下單  68
     24 秒 觸發 │ 這一秒成立的下單   4 │ 庫存服務：進來  37、做完   4（呼叫端早就放棄的   0）、503   8 │ 連線池 active  4 pending  89 │ 訂單服務 Tomcat 忙  89/200 排隊    0 │ 還沒回應的下單  89
     25 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  50、做完   4（呼叫端早就放棄的   4）、503  21 │ 連線池 active  4 pending 115 │ 訂單服務 Tomcat 忙 114/200 排隊    0 │ 還沒回應的下單 114
     26 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  50、做完   4（呼叫端早就放棄的   4）、503  21 │ 連線池 active  4 pending 141 │ 訂單服務 Tomcat 忙 139/200 排隊    0 │ 還沒回應的下單 139
     30 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  50、做完   4（呼叫端早就放棄的   4）、503  46 │ 連線池 active  4 pending 150 │ 訂單服務 Tomcat 忙 150/200 排隊    0 │ 還沒回應的下單 150
     31 秒 之後 │ 這一秒成立的下單   0 │ 庫存服務：進來  50、做完  31（呼叫端早就放棄的  31）、503  20 │ 連線池 active  4 pending 149 │ 訂單服務 Tomcat 忙 150/200 排隊    0 │ 還沒回應的下單 150
     32 秒 之後 │ 這一秒成立的下單   0 │ 庫存服務：進來  50、做完  37（呼叫端早就放棄的  37）、503  13 │ 連線池 active  4 pending 149 │ 訂單服務 Tomcat 忙 151/200 排隊    0 │ 還沒回應的下單 151
     33 秒 之後 │ 這一秒成立的下單   0 │ 庫存服務：進來  50、做完  36（呼叫端早就放棄的  36）、503  13 │ 連線池 active  4 pending 149 │ 訂單服務 Tomcat 忙 151/200 排隊    0 │ 還沒回應的下單 151
     69 秒 之後 │ 這一秒成立的下單  10 │ 庫存服務：進來  44、做完  36（呼叫端早就放棄的  26）、503  12 │ 連線池 active  4 pending 141 │ 訂單服務 Tomcat 忙 145/200 排隊    0 │ 還沒回應的下單 145
     70 秒 之後 │ 這一秒成立的下單   1 │ 庫存服務：進來  50、做完  33（呼叫端早就放棄的  32）、503  19 │ 連線池 active  4 pending 142 │ 訂單服務 Tomcat 忙 144/200 排隊    0 │ 還沒回應的下單 144
═══ 每秒 25 張下單，app 最多送 3 次（load { 4.17 4.43 4.67 }）═══
  正常     │ 下單   │  500 次 │ p50    128.1 ms │ p99    148.9 ms │ max    170.2 ms │ {201=500}
  觸發     │ 下單   │  250 次 │ p50  29567.0 ms │ p99  39288.1 ms │ max  39770.6 ms │ {200=10, 201=15, 503=225}（app 送了 718 次）
  之後     │ 下單   │ 1000 次 │ p50  28684.0 ms │ p99  41903.0 ms │ max  44181.6 ms │ {-1=299, 200=177, 201=100, 503=424}（app 送了 2733 次）
  正常   │ 下單意圖  500 │ 庫存服務收到預留  500 次（1.0 倍）│ 做完  500，其中呼叫端早就放棄的    0 │ 503    0
  觸發   │ 下單意圖  250 │ 庫存服務收到預留  457 次（1.8 倍）│ 做完  139，其中呼叫端早就放棄的  125 │ 503  318
  之後   │ 下單意圖 1000 │ 庫存服務收到預留 2477 次（2.5 倍）│ 做完 1393，其中呼叫端早就放棄的 1370 │ 503 1084
  觸發結束之後：40 秒內沒有恢復
  每秒：
     20 秒 正常 │ 這一秒成立的下單  25 │ 庫存服務：進來  25、做完  25（呼叫端早就放棄的   0）、503   0 │ 連線池 active  3 pending   0 │ 訂單服務 Tomcat 忙   3/200 排隊    0 │ 還沒回應的下單   3
     21 秒 觸發 │ 這一秒成立的下單   5 │ 庫存服務：進來  25、做完   5（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  21 │ 訂單服務 Tomcat 忙  25/200 排隊    0 │ 還沒回應的下單  25
     22 秒 觸發 │ 這一秒成立的下單   4 │ 庫存服務：進來  25、做完   4（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  42 │ 訂單服務 Tomcat 忙  46/200 排隊    0 │ 還沒回應的下單  46
     23 秒 觸發 │ 這一秒成立的下單   4 │ 庫存服務：進來  25、做完   4（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  64 │ 訂單服務 Tomcat 忙  67/200 排隊    0 │ 還沒回應的下單  67
     24 秒 觸發 │ 這一秒成立的下單   4 │ 庫存服務：進來  36、做完   4（呼叫端早就放棄的   0）、503   7 │ 連線池 active  4 pending  89 │ 訂單服務 Tomcat 忙  88/200 排隊    0 │ 還沒回應的下單  88
     25 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  50、做完   4（呼叫端早就放棄的   4）、503  21 │ 連線池 active  4 pending 114 │ 訂單服務 Tomcat 忙 114/200 排隊    0 │ 還沒回應的下單 114
     26 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  50、做完   4（呼叫端早就放棄的   4）、503  21 │ 連線池 active  4 pending 138 │ 訂單服務 Tomcat 忙 139/200 排隊    0 │ 還沒回應的下單 139
     30 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  60、做完   4（呼叫端早就放棄的   4）、503  46 │ 連線池 active  4 pending 196 │ 訂單服務 Tomcat 忙 200/200 排隊   14 │ 還沒回應的下單 239
     31 秒 之後 │ 這一秒成立的下單   0 │ 庫存服務：進來  62、做完  28（呼叫端早就放棄的  28）、503  34 │ 連線池 active  4 pending 197 │ 訂單服務 Tomcat 忙 200/200 排隊   39 │ 還沒回應的下單 264
     32 秒 之後 │ 這一秒成立的下單   0 │ 庫存服務：進來  79、做完  39（呼叫端早就放棄的  38）、503  40 │ 連線池 active  4 pending 196 │ 訂單服務 Tomcat 忙 200/200 排隊   63 │ 還沒回應的下單 288
     33 秒 之後 │ 這一秒成立的下單   1 │ 庫存服務：進來  61、做完  36（呼叫端早就放棄的  35）、503  25 │ 連線池 active  4 pending 197 │ 訂單服務 Tomcat 忙 200/200 排隊   87 │ 還沒回應的下單 312
     69 秒 之後 │ 這一秒成立的下單   0 │ 庫存服務：進來   0、做完  36（呼叫端早就放棄的  36）、503  25 │ 連線池 active  4 pending  82 │ 訂單服務 Tomcat 忙 200/200 排隊  579 │ 還沒回應的下單 960
     70 秒 之後 │ 這一秒成立的下單   0 │ 庫存服務：進來   1、做完  40（呼叫端早就放棄的  40）、503  19 │ 連線池 active  4 pending  12 │ 訂單服務 Tomcat 忙 200/200 排隊  485 │ 還沒回應的下單 960
  （結束時 load { 5.48 4.66 4.72 }）
```

（每秒的那幾行只留 20～26、30～33、69～70 秒；完整的輸出，每一輪的「每秒：」之後都有 70 行。）

**每秒 10 張：觸發結束後 2 秒就回來了。** 觸發的那 10 秒裡，庫存服務每秒只做得了約 4 個。來不及做的排在連線池裡（pending 一路爬），排超過 3 秒的，訂單服務逾時、再送一次。觸發一結束，容量回到每秒約 40 個：排隊的消化掉、新來的每秒 10 張，很快就不再逾時。

**每秒 25 張：40 秒內沒有恢復。** 看每秒的那幾行：

- 觸發開始後幾秒，「進來」從每秒 25 變成每秒 50：每一張都在連線池裡等超過 3 秒、被訂單服務再送一次。
- 觸發結束了，資料庫回到 100 ms，庫存服務每秒做完約 35～39 個，跟它的容量一樣，沒有閒著。
- 但**它做的每一個都是白做的**：做完的 1,444 個裡，1,420 個的呼叫端早就放棄了。每一個預留都在連線池裡等了將近 3 秒才輪到，等它做完，訂單服務已經逾時、送了第二次。第二次又排到隊伍的最後面。
- 這 40 秒裡「這一秒成立的下單」幾乎都是 0。
- 連線池停在 active 4、pending 一百九十幾。4 + 196 = 200，正好是庫存服務 Tomcat 的執行緒數：推論是庫存服務自己的 Tomcat 也滿了，再多的請求排在它的佇列裡，`ServerTap` 看不到。

這叫**亞穩態故障**（metastable failure）：系統有兩個穩定的狀態。一個是正常；另一個是「每一個請求都等超過逾時 → 每一個請求都多送一次 → 負載是平常的兩倍 → 每一個請求都等超過逾時」。觸發只是把它從第一個推到第二個；推過去之後，觸發的原因消失了，它也不會自己回來。

算一下就知道為什麼 10 張回得來、25 張回不來：

```
容量：每秒約 40 個預留
每秒 10 張 × 2（每一張都逾時、再送一次）= 20 < 40  → 排隊的消化得掉，逾時停止，回到正常
每秒 25 張 × 2                         = 50 > 40  → 排隊只會越來越長，逾時不會停
```

**一樣的重送，在用掉四分之一容量的時候無害，在用掉六成的時候就回不來。** 而且這一次買家的 app 一次都沒有重送，只有訂單服務的「再送一次」。

> ⚠️ **只用每秒 10 張量「回不來」，量不到。** 觸發的時候也逾時、也重送，但 10 × 2 還在容量裡面，2 秒就回來了；拉到 25 張才看得到。只量低負載，結論會是「重試風暴是教科書上的東西」。

**app 最多送 3 次的那一輪**也回不來，而且連訂單服務自己都滿了：

- app 照 `Retry-After: 1` 等 1 秒再送，訂單服務每秒收到的下單變成好幾倍。每一次都要等 6 秒才 503，訂單服務的 Tomcat 在觸發開始後約 10 秒就 200/200，之後排隊的請求一路爬到 698 個 —— 6.2 的級聯，加上這一節的乘法。
- 觸發之後那 40 秒送出的下單，p50 是 28,684 ms，比「三次各等 6 秒、中間各等 1 秒」的 20 秒還長：多出來的是排隊。299 個意圖連 app 自己的 30 秒都等不到（狀態 -1）。
- 庫存服務收到的是 2.5 倍，不是 6 倍：訂單服務的執行緒滿了，擋住了一部分往下送的請求。一個滿了的上游，意外地替下游擋了流量 —— 這不是保護，是另一個故障。

### 6.3.5 幾層、幾次：27 倍與 243 倍

①量到的是一條規則：**最底層收到的 = 每一層送的次數相乘。**

| 這條線 | 每一層送幾次 | 最底層收到 |
|---|---|---|
| app → 訂單服務 → 庫存服務（第 06 章之前） | 1 × 2 | **2 倍**（量到） |
| 同上，app 最多送 3 次 | 3 × 2 | **6 倍**（量到） |
| 三層，每一層都「最多 3 次」 | 3 × 3 × 3 | 27 倍（推論） |
| 五層，每一層都「最多 3 次」 | 3⁵ | 243 倍（推論） |
| 五層，每一層都「失敗之後再重試 3 次」 | 4⁵ | 1,024 倍（推論） |

「每層都重試 3 次 = 27 倍流量」與「每一層都設 3 次重試，五層下去就是 243 倍」兩個說法都對，只是前提要寫出來：**幾層**，以及「3 次」是**總共 3 次**還是**再重試 3 次**。

Resilience4j 的 `max-attempts: 3` 是總共 3 次（05-service/06 的 6.6.3）；很多人說的「重試 3 次」是另外再送 3 次。這一站的 README 用的是同一個說法：

- 每一層最多送 3 次（含第一次）。
- 三層 27 倍，五層 243 倍。
- 這個系統的線上只有兩層，量到 6 倍。

這個系統只有兩層會重送，所以 27、243 是推論，不是量的。真實的系統很容易有更多層：

- 閘道
- 服務網格的 sidecar（例如 Istio）
- BFF
- 每一個服務自己的 HTTP 用戶端
- 資料庫驅動程式

這些層裡哪幾層預設就會重送，第 08 章量了。Istio 1.31 的 sidecar 預設再送 2 次，但只在連不上、refused-stream 與幾個 gRPC 的狀態 —— 10 個一定會 503 的預留，庫存服務收到 10 次，503 沒有被重送（8.10.1）。預設就重送 503、而且連 POST 都重送的，是另一層：入口設了重試政策、沒有寫條件的時候（Envoy Gateway）。每一層實際的預設，在第 08 章 8.10.2 的表裡。

---

## 6.4 逾時預算：由外而內遞減

### 6.4.1 這條線上的每一個「等」

一張下單從買家的 app 到庫存服務的資料庫，中間有這些「等」（第 06 章之前）：

| 誰在等 | 等什麼 | 上限 | 誰設的 |
|---|---|---|---|
| 買家的 app | 下單的回應 | 不知道（實驗台用 30 秒） | app |
| 訂單服務 | 熱點閘門的回應 | 3 秒 × 2 次 | `RemoteInventoryApi`（第 03 章） |
| 訂單服務 | 預留的回應 | 3 秒 × 2 次 | 同上 |
| 訂單服務 | 連上庫存服務 | 1 秒 | 同上 |
| 庫存服務 | 一條資料庫連線 | **3 秒** | Hikari 的 `connection-timeout`（第 12 站 0.10.4） |
| 庫存服務 | SQL | 沒有上限 | —— |

把它們排成一條線，就看得出 6.2、6.3 的問題：

- **外層沒有一個總的上限。** 閘門、預留各自等兩次 3 秒，一張熱點商品的下單最壞是 12 秒。app 等不等得了那麼久，沒有人知道。
- **內層不知道外層等多久。** 庫存服務借一條連線最多等 3 秒，訂單服務也只等 3 秒。在連線池裡排了 2.9 秒才輪到的那一個，拿到連線、做完預留、commit 的時候，訂單服務早就放棄、送了第二次。6.3 ② 的 1,420 個「呼叫端早就放棄的」，都是在連線池裡排隊排出來的。

README 的那一條誤區，說的就是第二件事：「逾時設定由內而外遞增（外層 3 秒、內層 10 秒），外層早就放棄了內層還在跑」。這個系統沒有寫錯任何一個數字，只是兩個 3 秒放在一起，內層就不比外層短。

**由外而內遞減**的意思是：每往裡一層，能等的時間就少一點，少掉的是這一層自己要花的時間。做法有兩層：

1. **靜態的**：每一個設定值，裡面的要比外面的短（6.4.2、6.4.5）。
2. **動態的**：把「還剩多少」跟著請求往下送，下一層照它來等、照它決定還要不要做（6.4.3）。只靠靜態的不夠：外層等 2 秒，在自己這一層已經用掉 1.5 秒，下一層就只剩 0.5 秒，設定檔不知道這件事。

### 6.4.2 數字從哪裡來

**read timeout：3 秒 → 1 秒。** 一次送出最多等多久，要從「正常的時候要多久」推出來，不是從「我們希望它多快」：

- 6.2 正常的那一段：一整張下單（訂單服務的兩個交易 + 一次預留）p99 是 53～84 ms。
- 第 12 站 0.6.2 的 SLO：一般商品的下單 p99 300 ms、熱點商品 500 ms。
- 1 秒是 SLO 的兩到三倍、正常 p99 的十幾倍。超過 1 秒還沒回來的那一次，已經不是「慢一點」，而是庫存服務出事了。

3 秒的問題不在「太長」或「太短」，而在它跟庫存服務自己的 3 秒一樣長（6.4.1）、而且兩次加起來是 6 秒（6.2）。

**下單的預算：2 秒。** 一張下單最多花多久等其他服務（閘門、預留，含重送）。它是「放棄」的那一條線，不是目標。2 秒放得下一次完整的 1 秒、加上一次重送的一部分；用完了就 503，請買家用同一個鍵再送。

**為什麼不把庫存服務借連線的 3 秒也改短？** Hikari 要求 `validation-timeout` 比 `connection-timeout` 短；第 12 站 8.9.1 把 `validation-timeout` 定在 1 秒（`isValid()` 收的是整秒、最少 1 秒）。借連線的上限低於 1 秒，驗證一條閒置的連線就可能用掉整個上限。所以不改它，改成**借到連線之後，先看呼叫端還剩多少時間**（6.4.3）：還是可能在連線池裡等，但等完不做白工。

兩個數字之間的關係寫成啟動時的檢查（`ShopProperties`），設錯了應用程式起不來：

```java
    /** 13 站 6.4：逾時由外而內遞減 —— 下單的預算裡，至少要放得下一次完整的送出（不然切開的訂單服務每一張都是 503） */
    @jakarta.validation.constraints.AssertTrue(message = "shop.order.placement-budget 必須大於 shop.deployment.inventory.read-timeout（13 站 6.4）")
    public boolean isPlacementBudgetAboveReadTimeout() {
        return order == null || deployment == null || order.placementBudget() == null
                || order.placementBudget().compareTo(deployment.inventory().readTimeout()) > 0;
    }
```

```java
            /**
             * 13 站 6.4：一次下單最多花多久等其他服務（熱點閘門、預留，含重送）。用完了 → 503，請買家用同一個鍵再送（訂單留在 RESERVING，
             * 重送接著做這一張）。0.6.2 的 SLO 是 p99 300 ms；這是「放棄」的那一條線，不是目標
             */
            @NotNull @DefaultValue("2s") @DurationMin(millis = 200) Duration placementBudget) {

        /** 6.4：排程補償 RESERVING 的門檻，要遠大於一次下單最久會等的時間 —— 不然排程會補償一張還在下的訂單 */
        @jakarta.validation.constraints.AssertTrue(message = "shop.order.placement-timeout 至少要是 placement-budget 的 10 倍（13 站 6.4）")
        public boolean isPlacementTimeoutFarAboveBudget() {
            return placementTimeout == null || placementBudget == null || placementTimeout.compareTo(placementBudget.multipliedBy(10)) >= 0;
        }
    }
```

`DeploymentPropertiesTest` 多了一個測試：read timeout 設成 3 秒、或預算設成 10 秒，應用程式都起不來，錯誤訊息說得出是哪一條（下面是那一行，Spring 的綁定訊息中間那一長段省略）：

```
13 站 6.4：read-timeout 3s、placement-budget 2s → default message [shop.order.placement-budget 必須大於 shop.deployment.inventory.read-timeout（13 站 6.4）] | 
```

### 6.4.3 把剩下的時間送過去

`Deadline` 把「這個請求在什麼時候之前要有結果」放在執行緒上：

```java
package com.example.shop.shared.resilience;

import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;

import java.time.Duration;
import java.util.function.Supplier;

/**
 * 13 站 6.4：一個請求還剩多少時間 —— 逾時預算。放在執行緒上，跟著這個請求往下走：
 *
 *   訂單服務：下單的入口給一個預算（shop.order.placement-budget，PlaceOrderService）。每一次打庫存服務，
 *            這一次最多等「剩下的」與 read timeout 取小的，並把它放在 Shop-Budget-Ms 送過去（RemoteInventoryApi）
 *   庫存服務：收到 Shop-Budget-Ms → 這個請求的期限（BudgetFilter）；預留的交易借到連線之後先看一次，過了就不做（check）
 *
 * 期限用 System.nanoTime()：不受系統時鐘調整影響。跨服務送的是「還剩幾毫秒」，不是一個時刻 —— 兩台機器的時鐘不必對齊；
 * 代價是：請求在路上、在對方的 Tomcat 佇列裡等的那一段，對方不知道（6.4.4）。
 * 沒有期限的執行緒（排程、消費者、單體）：remaining() 是 null，check() 什麼都不做 —— 照舊用固定的逾時。
 */
public final class Deadline {

    /** 呼叫端還願意等幾毫秒 */
    public static final String HEADER = "Shop-Budget-Ms";

    private static final ThreadLocal<Long> AT = new ThreadLocal<>();

    private Deadline() {}

    /** 離開時把外層的期限放回去（沒有外層 → 清掉） */
    public interface Scope extends AutoCloseable {
        @Override void close();
    }

    /** 從現在起 budget 之內。外層已經有一個更早的期限 → 用外層的：預算只會越往裡越少 */
    public static Scope open(Duration budget) {
        Long outer = AT.get();
        long at = System.nanoTime() + budget.toNanos();
        AT.set(outer != null && outer - at < 0 ? outer : at);
        return () -> {
            if (outer == null) AT.remove();
            else AT.set(outer);
        };
    }

    public static <T> T within(Duration budget, Supplier<T> work) {
        try (Scope ignored = open(budget)) {
            return work.get();
        }
    }

    /** 還剩多久（可能是負的）；沒有期限 → null */
    public static Duration remaining() {
        Long at = AT.get();
        return at == null ? null : Duration.ofNanos(at - System.nanoTime());
    }

    public static boolean expired() {
        Long at = AT.get();
        return at != null && at - System.nanoTime() <= 0;
    }

    /** 預算已經用完 → 503，不要開始做（呼叫端已經走了：這個回應多半沒有人收，重點是那一份工作不做） */
    public static void check(String what) {
        if (expired())
            throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "呼叫端的時間已經用完，" + what + "沒有執行").with("retryAfter", 1);
    }
}
```

三個地方用它。

**① 訂單服務：下單的入口給預算。**

```java
    public PlacedOrder placeOrder(long buyerId, String idempotencyKey, List<OrderLine> lines) {
        try {
            // 13 站 6.4：這一次下單等其他服務的預算（熱點閘門、預留，含重送）。單體裡沒有遠端呼叫，期限放著沒有人讀
            return Deadline.within(budget, () -> placeOrderGated(buyerId, idempotencyKey, lines));
        } catch (InsufficientStockException e) {
            // 9.9：0.6.6「依 productId 前 N 名」。productId 不當指標的 tag（J7：1 萬個商品 = 1 萬條序列、每次 scrape 600 KB），寫進日誌，前 N 名從日誌查
            insufficient.increment();
            log.info("INSUFFICIENT_STOCK productId={} buyerId={}", e.productId(), buyerId);
            throw e;
        }
    }
```

（建構子多讀一個 `placementBudget`；6.7.5 還有一行。完整的 diff 在 6.11.1。）

**② 訂單服務：每一次送出最多等多久，並告訴庫存服務。** 一次送出的上限是「read timeout」與「剩下的預算」取小的。`JdkClientHttpRequestFactory` 的逾時是整個 factory 一個值，所以每一次送出用一個新的 factory 包住同一個 `HttpClient`（同一個連線池）。同一個值放在 `Shop-Budget-Ms` 送給庫存服務：

```java
        HttpClient http = HttpClient.newBuilder().connectTimeout(r.connectTimeout()).build();
        // 6.4：每一次送出有自己的 read timeout。JdkClientHttpRequestFactory 的逾時是整個 factory 一個值，所以每一次送出 new 一個 ——
        // 它只是「這個 HttpClient + 這一次的逾時」；HttpClient（連線池）是同一個
        ClientHttpRequestFactory perAttempt = (uri, method) -> {
            JdkClientHttpRequestFactory f = new JdkClientHttpRequestFactory(http);
            f.setReadTimeout(ATTEMPT.get() == null ? r.readTimeout() : ATTEMPT.get());
            return f.createRequest(uri, method);
        };
        RestClient rest = builder.baseUrl(r.url()).requestFactory(perAttempt)
                .requestInterceptor((req, body, exec) -> {
                    req.getHeaders().setBearerAuth(tokens.tokenFor(ServiceRole.INVENTORY_SERVICE));
                    Duration wait = ATTEMPT.get();                          // 6.4.3：告訴庫存服務這一次我等多久
                    if (wait != null) req.getHeaders().set(Deadline.HEADER, Long.toString(wait.toMillis()));
                    return exec.execute(req, body);
                })
                .build();
```

**③ 庫存服務：收到預算，借到連線之後先看一次。** `BudgetFilter` 只收 `/internal/**` 的請求：預算是上游的服務給的，買家送來的 header 不算數。

```java
@Component
class BudgetFilter extends OncePerRequestFilter {

    @Override
    protected boolean shouldNotFilter(HttpServletRequest req) {
        return !req.getRequestURI().startsWith("/internal/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        long ms;
        try {
            ms = Long.parseLong(String.valueOf(req.getHeader(Deadline.HEADER)));
        } catch (NumberFormatException none) {
            chain.doFilter(req, res);
            return;
        }
        try (Deadline.Scope ignored = Deadline.open(Duration.ofMillis(Math.max(0, ms)))) {
            chain.doFilter(req, res);
        }
    }
}
```

```java
    /**
     * 同 reserve()，多回傳「這一次是不是重送」—— 庫存服務的 PUT /reservations 要用它回 Idempotent-Replayed（3.5.2）。
     * 13 站 6.4.3：交易開始的時候連線已經借到了（JpaTransactionManager 在 begin 就拿連線、關掉 autocommit）。
     * 在連線池裡排隊的那一段，可能已經把呼叫端的預算用完：用完了就不做 —— 呼叫端早就走了，做完也沒有人收（6.3 ② 的「早就放棄的」）
     */
    @Transactional
    public boolean reserveOnce(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
        if (Deadline.expired()) {
            budgetExpired.increment();
            Deadline.check("預留");
        }
        return reserveIdempotently(orderId, lines, hotLines);
    }
```

為什麼放在交易的第一行，而不是 filter 裡？因為 6.3 ② 的「等」發生在**借連線**。`JpaTransactionManager` 在交易開始時就借好連線（Hibernate 要關掉 autocommit），所以方法的第一行執行時，連線池裡的那一段已經等完了。在 filter 裡看，看到的是還沒開始排隊的時間，預算永遠夠。

這一段是不是真的在借到連線之後，用兩個數字對照（6.10.3 有完整的輸出）：

- 6.3 ② 每秒 25 張的那一輪，觸發結束之後的 40 秒，庫存服務做完的預留裡，呼叫端早就放棄的：1,420 個 → 0 個。
- 預算用完、沒有做的：87 個。

`InventoryServiceApiTest` 多了一個測試：帶著 `Shop-Budget-Ms: 0` 的預留回 503、`processed_messages` 沒有那一列（交易 rollback，這張訂單之後重送會真的預留）；帶 5,000 的照常預留：

```
13 站 6.4.3：預算 0 ms → 503 {"type":"/problems/temporarily-unavailable","title":"服務暫時無法使用","status":503,"detail":"呼叫端的時間已經用完，預留沒有執行","instance":"/internal/inventory/v1/reservations/9930171","traceId":"6ad1eefab9d65e2dfb5bfea0da58ed87","retryAfter":1}；預算 5000 ms → 204；reserved = 1、預算用完那一張的 processed_messages 0 列
```

**預算檢查擋不了「借到連線之後才變慢」的那一種。** 觸發的那 10 秒裡，每個預留交易本身要 1 秒：拿到連線時還剩 0.5 秒的請求，檢查會放它過，它做完的時候呼叫端已經走了。所以觸發那一段的「早就放棄的」不是 0（28 個）。要擋這一種，要讓 SQL 本身也帶上限（JDBC 的 `setQueryTimeout` 只收整秒），這一章沒有做。

### 6.4.4 送「還剩幾毫秒」，不送「幾點幾分」

跨服務的預算有兩種送法：

| | 送一個時刻（「12:00:03.250 之前」） | 送一段時間（「還剩 750 ms」） |
|---|---|---|
| 兩台機器的時鐘 | 要對齊；差 200 ms，預算就錯 200 ms | 不必 |
| 請求在路上、在對方的 Tomcat 佇列裡等的時間 | 算得進去 | **算不進去**：對方從收到的那一刻起算 |
| 例子 | —— | gRPC 的 `grpc-timeout`；Envoy 送給上游的 `x-envoy-expected-rq-timeout-ms` |

這一章選第二種，因為這個系統沒有保證時鐘對齊。代價：庫存服務的 Tomcat 如果也滿了，請求在它的佇列裡等的時間，庫存服務不知道。

- 6.3.4 回不來的那一輪，就是這種情況（推論：連線池 4 + 196 = 200 條執行緒）。
- 這一章之後（6.10.3），排隊停在連線池裡（pending 三十幾），庫存服務的 Tomcat 沒有滿。連線池裡的排隊，借到連線之後檢查，算得到。

另外，庫存服務算出來的期限，一定比訂單服務真正放棄的時間**晚**一點：送出到收到之間的那一段沒有扣掉。所以庫存服務說「過期了」的時候，訂單服務一定已經放棄；反過來不一定。這個方向的誤差是安全的：最壞是做了一個白工，不會是「呼叫端還在等，庫存服務卻放棄了」。

### 6.4.5 下單的預算，管不到的地方

預算只管**等其他服務**：

- 訂單服務自己的兩個交易（T1 寫下 RESERVING、T3 轉成 PENDING_PAYMENT）借連線，還是最多等 3 秒（第 12 站 0.10.4）。
- 冪等鍵、商品快照（catalog，在同一個行程裡）也不在預算裡。

所以「下單最多 2 秒」不是一個保證；保證的是「等庫存服務的部分最多 2 秒」。

另一條啟動時的檢查也是從這裡來的：

- 排程補償 RESERVING 的門檻（`placement-timeout`，60 秒，第 04 章 4.5.5），要遠大於一次下單最久會等的時間，不然排程會補償一張還在下的訂單。
- 第 06 章之前，「最久」是兩次預留各等一個 read timeout，加上鎖等待；現在等庫存服務的部分有了上限，就把它寫成一條規則：至少 10 倍。

---

## 6.5 重送：只在一層，而且有預算

### 6.5.1 第 03 章的那一次重送，加上三個條件

05-service/06 的 6.6.4 有三條規則：

1. 一條鏈上只有一層負責重試，通常是最靠近使用者的那一層。
2. 重試必須有預算。
3. 重試必須被熔斷器看見。

這條線上，最靠近使用者的是買家的 app，它也有 `Idempotency-Key` 可以安全地再送。照第一條，訂單服務應該完全不重送。

這一章沒有拿掉訂單服務的那一次重送，理由是它處理的失敗跟 app 不一樣：

- 一條連線剛好被對方關掉、一個封包掉了，這種一次性的「沒有回應」，訂單服務再送一次，買家完全感覺不到。
- 交給 app，就是一次 503 加一次等待。

所以它留著，但要過三關（`RemoteInventoryApi.call()`）：

```java
    /**
     * 13 站 6.4～6.7：一次呼叫。
     *   ① 隔艙：同時在等庫存服務的請求有上限，滿了立刻 503 —— 不排隊（6.6）
     *   ② 每一次送出之前：這一次最多等多久 = read timeout 與剩下的預算取小的；不到 MIN_ATTEMPT 就不送（6.4）
     *   ③ 熔斷器（只有下單路徑上往前走的兩種：reserve、gate-hot）開著 → 立刻 503，Retry-After = 它要開多久（6.7）
     *   ④ 沒有回應 → 再送一次，只在：還沒送滿 max-attempts、剩下的預算還夠一次、重試預算還有（6.5）
     */
    private <T> T call(String op, Supplier<T> c) {
        Bulkhead bulkhead = ORDER_PATH.contains(op) ? orderPath : others;
        if (!bulkhead.tryAcquirePermission()) {
            rejected(op, "bulkhead");
            throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務忙碌中，請稍後再試").with("retryAfter", 1);
        }
        try {
            CircuitBreaker breaker = breakers.get(op);
            retryBudget.sent();
            for (int attempt = 1; ; attempt++) {
                Duration timeout = attemptTimeout();
                if (timeout == null) {
                    rejected(op, "budget");
                    throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "這一次的時間已經用完，請再送一次").with("retryAfter", 1);
                }
                if (breaker != null && !breaker.tryAcquirePermission()) {
                    rejected(op, "breaker");
                    throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", openSeconds);
                }
                long t0 = System.nanoTime();
                ATTEMPT.set(timeout);
                try {
                    T result = c.get();
                    if (breaker != null) breaker.onSuccess(System.nanoTime() - t0, TimeUnit.NANOSECONDS);
                    return result;
                } catch (RestClientResponseException e) {                   // 對方回應了：照它說的
                    if (breaker != null) {                                  // 5xx 算失敗；4xx 是業務的結果（庫存不足、狀態不對），不算（05-service/06 的 6.7.6）
                        if (e.getStatusCode().is5xxServerError()) breaker.onError(System.nanoTime() - t0, TimeUnit.NANOSECONDS, e);
                        else breaker.onSuccess(System.nanoTime() - t0, TimeUnit.NANOSECONDS);
                    }
                    throw decode(op, e.getStatusCode().value(), e.getResponseBodyAsString());
                } catch (ResourceAccessException e) {                       // 沒有回應：不知道它做了沒有 —— 每一支端點都可以重送（3.5）
                    if (breaker != null) breaker.onError(System.nanoTime() - t0, TimeUnit.NANOSECONDS, e);
                    Counter.builder("shop.remote.no_response").tag("service", "inventory").tag("op", op)
                            .description("呼叫其他服務沒有得到回應（連不上、逾時）的次數（13 站 3.5）").register(meters).increment();
                    if (attempt < maxAttempts && attemptTimeout() != null && retryBudget.tryRetry()) {
                        log.warn("INVENTORY_NO_RESPONSE op={} attempt={}，用同一個冪等鍵再送一次：{}", op, attempt, e.getMessage());
                        continue;
                    }
                    log.error("INVENTORY_UNAVAILABLE op={}：送了 {} 次都沒有回應：{}", op, attempt, e.getMessage());
                    throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", 1);
                } catch (RuntimeException e) {                              // 其他（解不開回應……）：我們的錯，不是庫存服務的
                    if (breaker != null) breaker.releasePermission();
                    throw e;
                } finally {
                    ATTEMPT.remove();
                }
            }
        } finally {
            bulkhead.onComplete();
        }
    }
```

- **還沒送滿 `max-attempts`（2）**：跟第 03 章一樣，最多兩次。
- **剩下的預算還夠一次（100 ms）**：第一次等滿 1 秒逾時，2 秒的預算還剩不到 1 秒；剩下的不到 100 ms 就不送。給一次幾十毫秒的送出不到 100 ms，只是多製造一個「不知道做了沒有」。
- **重試預算還有**（6.5.2）。

熔斷器在每一次送出之前問（第三條規則：每一次送出都會被它記到），不在這三關裡。

**重送之前不等待。** 它只在「沒有回應」時發生：那一次已經等了一整個逾時；連不上（立刻失敗）的情況，連續幾次之後交給熔斷器。沒有退避、也沒有抖動，這一章沒有量它的影響。

### 6.5.2 重試預算

```java
package com.example.shop.shared.resilience;

import java.util.function.LongSupplier;

/**
 * 13 站 6.5：重試預算 —— 最近 10 秒裡，重送的次數不能超過第一次送出的 ratio 倍；另外每 10 秒至少給 minRetries 次
 * （量少的時候，偶爾一次的重送不受影響）。
 *
 * 每一層都只重送「一點點」，乘起來還是很多（6.3 ①）。有了預算，這一層最多多送 ratio：下游真的壞了的時候，
 * 大部分的呼叫不會再送第二次 —— 第二次的機會留給「偶爾掉一個回應」的那種失敗。
 * 05-service/06 的 6.6.4 規則 ②；Resilience4j 沒有這個（那一章寫過），自己做：10 個一秒的桶。
 */
public final class RetryBudget {

    static final int SECONDS = 10;

    private final double ratio;
    private final int minRetries;
    private final LongSupplier millis;
    private final long[] second = new long[SECONDS], firsts = new long[SECONDS], retries = new long[SECONDS];

    public RetryBudget(double ratio, int minRetries) { this(ratio, minRetries, System::currentTimeMillis); }

    RetryBudget(double ratio, int minRetries, LongSupplier millis) {
        this.ratio = ratio;
        this.minRetries = minRetries;
        this.millis = millis;
    }

    /** 一次呼叫的第一次送出 */
    public synchronized void sent() { firsts[bucket()]++; }

    /** 可以重送嗎？可以 → 算進去 */
    public synchronized boolean tryRetry() {
        int b = bucket();
        long now = second[b], f = 0, r = 0;
        for (int i = 0; i < SECONDS; i++)
            if (now - second[i] < SECONDS) { f += firsts[i]; r += retries[i]; }     // 很久沒有被用到的桶，裡面是更早以前的
        if (r + 1 > Math.max(minRetries, ratio * f)) return false;
        retries[b]++;
        return true;
    }

    /** 這一秒的桶；桶裡是 10 秒以前的資料 → 先清掉 */
    private int bucket() {
        long s = millis.getAsLong() / 1000;
        int b = (int) Math.floorMod(s, (long) SECONDS);
        if (second[b] != s) {
            second[b] = s;
            firsts[b] = 0;
            retries[b] = 0;
        }
        return b;
    }
}
```

兩個數字：

- 最近 10 秒，重送不能超過第一次送出的 10%：下游真的壞了的時候，九成以上的呼叫只送一次。
- 每 10 秒至少給 10 次：量少的時候（凌晨、測試），偶爾一次的「沒有回應」照樣重送。

`RetryBudgetTest` 測三件事：量少時的保底、量多時的 10%、窗會滑動（6.11.1）。

這個預算是**每一個服務自己的**。乘法還是乘法，只是訂單服務那一層的「× 2」變成最多「× 1.1」：

```
第 06 章之前：app 3 次 × 訂單服務 2 次   = 6 倍
之後（量多的時候）：app 3 次 × 訂單服務 ≤ 1.1 次 ≤ 3.3 倍（推論；熔斷器打開之後更少，量到的在 6.10.3）
```

### 6.5.3 買家的 app 那一層：Retry-After

app 不是我們寫的，但它照什麼重送，是我們說的。

- 第 12 站的 503 帶著 `Retry-After`：`ShopException` 的 `retryAfter` 欄位，由 `GlobalExceptionHandler` 寫進 header。
- 這一章之後，熔斷器打開時的 503 帶的是 `Retry-After: 5`，也就是熔斷器要開著的秒數（6.7.3），不是 1。熔斷器開著的那 5 秒裡，app 照著等 5 秒再送，不會在第 1 秒就再撞一次。

`Retry-After` 是一個請求，不是一個保證：app 可以不理它。這一章量的 app 都照它等（實驗台的 `Rig.intent`）。不照它的 app，會讓 6.10.3 的數字更差。

**重送也會幫上忙。**

- 6.3 ② 每秒 10 張的那一輪（第 06 章之前），觸發那 10 秒裡送出的 100 張，有 70 張最後成立，p50 5,113 ms：一半以上要等過 3 秒的逾時，是訂單服務的第二次送出才成立的。
- 6.10.3 每秒 25 張、app 最多送 3 次的那一輪，觸發那 10 秒裡有 46 張是 app 用同一個鍵再送、拿回已經成立的那一張（200）。

這正是冪等鍵存在的理由：一次性的失敗，app 重送一次就好；持續的失敗，靠 `Retry-After` 與熔斷器讓它慢下來。

---

## 6.6 隔艙

6.2 的級聯，是「等庫存服務」的請求可以用掉全部 200 條執行緒。隔艙替它設一個上限：同時在等庫存服務的請求最多幾個，滿了的那一個立刻 503，不排隊。第 12 站 0.6.3 的熱點下單 × Redis 用的是同一種想法：一個功能 503，好過整站 503。

### 6.6.1 大小怎麼算

用利特爾法則，從正常的時候算：

```
同時在等庫存服務的請求 = 每秒幾個 × 每個多久
```

- 6.2 正常的那一段，每秒 40 張下單：整張下單在忙的 Tomcat 執行緒 0～4 條。等庫存服務的只是其中一段，更少。
- 第 12 站 0.6.2 的尖峰：一般商品每秒 50 張，就算每一張都花到 p99 的 300 ms，也只有 15 個；熱點商品每秒 200 張走 Redis 的閘門，每一次是毫秒級。

**下單路徑給 20。** 正常的時候用不到幾個；200 條 Tomcat 執行緒裡，最多 20 條會卡在庫存服務上，其他 180 條照常服務商品頁、購物車、我的訂單。

05-service/06 的 6.7.4 說過：餘裕不要留太多，隔艙的價值就在於它會滿。設成跟 Tomcat 一樣大（200）的隔艙，等於沒有隔艙。

**滿了不等**（`maxWaitDuration(Duration.ZERO)`）：在隔艙外面等一個位子，也是佔著一條執行緒在等。

### 6.6.2 兩個隔艙

```java
    /** 13 站 6.6：下單路徑上的呼叫，用自己的隔艙 —— 對帳、補貨、重建副本塞滿了，下單照樣有位子（反過來也是） */
    static final Set<String> ORDER_PATH = Set.of("reserve", "gate-hot", "return-hot");
    /**
     * 13 站 6.7.1：有熔斷器的呼叫。下單路徑上「往前走」的兩種，各一個：熱點閘門因為 Redis 掛了而一直 503，不能讓一般商品的預留也被擋掉
     *（第 12 站 0.6.3：Redis 掛掉時一般商品照樣能下單）。還回閘門（return-hot）、釋放預留這些補償不經過熔斷器：它們是回到一致的那一條路
     */
    static final Set<String> BROKEN = Set.of("reserve", "gate-hot");
```

```java
        BulkheadRegistry bulkheads = BulkheadRegistry.ofDefaults();
        this.orderPath = bulkheads.bulkhead("inventory-order-path", BulkheadConfig.custom()
                .maxConcurrentCalls(r.bulkhead().orderPath()).maxWaitDuration(Duration.ZERO).build());   // 滿了不等：等也是佔著一條執行緒
        this.others = bulkheads.bulkhead("inventory-others", BulkheadConfig.custom()
                .maxConcurrentCalls(r.bulkhead().others()).maxWaitDuration(Duration.ZERO).build());
```

下單路徑（預留、熱點閘門、還回閘門）一個，其他的一個（10）。其他的包括：

- 對帳的 `activeReservations`（排程，一次一頁）
- 補貨、標熱點（賣家）
- 出貨之前的那一問
- 重建副本的快照（第 05 章 5.6）

這些在庫存服務變慢的時候也會卡住，但它們卡住的應該是它們自己的位子：對帳跑得慢一點沒關係，買家下不了單有關係。反過來也一樣：搶購塞滿了下單路徑，賣家照樣能補貨。

這就是 README 說的「連線池切分」在這個系統裡的樣子：

- 訂單服務打庫存服務用的是同一個 `HttpClient`，它的連線池沒有上限（JDK 的 `HttpClient` 不限制一台主機的連線數）。
- 兩個隔艙限住同時在送的請求數，也就限住了每一組最多用幾條連線。
- **庫存服務那一邊的資料庫連線池沒有切**：下單的預留與對帳、重建副本的讀，用的是同一個 Hikari。這一章沒有量它們互相影響的情況。

**之後**（6.10.2）：同一個 G1，每秒 40 張、慢 3 秒，訂單服務的 Tomcat 最多忙 21 條，商品頁 p99 8.8 ms。

---

## 6.7 熔斷器放在哪一層

隔艙讓「等」有上限，但每一個進得了隔艙的請求，還是要等滿一次逾時。熔斷器回答另一個問題：**一直在失敗，還要繼續試嗎？**（05-service/06 的 6.7.2）

熔斷器打開的時候不送、立刻失敗，省下的是三樣東西：

- 這一次等待
- 一條執行緒
- 庫存服務的一次處理

### 6.7.1 一個服務一個，還是一種呼叫一個

最直接的做法：訂單服務打庫存服務的每一次呼叫，都經過同一個熔斷器。第 12 站 0.6.3 的降級矩陣說明了為什麼不行：

| | Redis 掛了 |
|---|---|
| 下單（一般商品） | **201** |
| 下單（熱點商品） | **503** |

Redis 掛了的時候，庫存服務的熱點閘門一直回 503，這是設計好的。如果它跟預留共用一個熔斷器，閘門的 503 會把它打開，**一般商品的預留也被擋掉** —— Redis 的故障，透過一個共用的熔斷器，變成了全部的下單都不能用。

所以熔斷器的顆粒度是「一種呼叫」，而且只放在下單路徑上往前走的兩種：

| 呼叫 | 熔斷器 | 為什麼 |
|---|---|---|
| 預留（`reserve`） | `inventory-reserve` | 每一張下單都走；它一直失敗，庫存服務就是出事了 |
| 熱點閘門（`gate-hot`） | `inventory-gate-hot` | 失敗的原因可能只是 Redis，不該拖累預留 |
| 還回閘門、釋放預留 | 沒有 | 補償（6.7.4） |
| 對帳、補貨、標熱點、出貨之前那一問、快照 | 沒有 | 量少；隔艙與逾時就夠，失敗時也不會造成 6.2 那樣的「等」 |

```java
        ShopProperties.Breaker b = r.breaker();
        this.openSeconds = Math.max(1, b.openFor().toSeconds());
        CircuitBreakerRegistry registry = CircuitBreakerRegistry.of(CircuitBreakerConfig.custom()
                .slidingWindowType(CircuitBreakerConfig.SlidingWindowType.TIME_BASED).slidingWindowSize((int) b.window().toSeconds())
                .minimumNumberOfCalls(b.minimumCalls()).failureRateThreshold(b.failureRate())
                .waitDurationInOpenState(b.openFor()).permittedNumberOfCallsInHalfOpenState(b.halfOpenCalls())
                .build());
        for (String op : BROKEN) {
            CircuitBreaker cb = registry.circuitBreaker("inventory-" + op);
            cb.getEventPublisher().onStateTransition(e -> log.warn("INVENTORY_BREAKER op={} {}", op, e.getStateTransition()));
            breakers.put(op, cb);
        }
        // resilience4j_circuitbreaker_state、resilience4j_bulkhead_available_concurrent_calls……
        // 05-service/06 的 6.7.1：OPEN 是「被呼叫時」才轉成 HALF_OPEN —— 沒有人下單的時候，儀表板上的 OPEN 不代表庫存服務還壞著
        TaggedCircuitBreakerMetrics.ofCircuitBreakerRegistry(registry).bindTo(meters);
        TaggedBulkheadMetrics.ofBulkheadRegistry(bulkheads).bindTo(meters);
```

設定（`ShopProperties.Breaker` 的預設值）：

- 10 秒的時間窗裡至少 20 次、失敗 50% 以上 → 打開 5 秒。
- 之後放 3 個試探，都成功才關上。

`RemoteInventoryResilienceTest` 有一個測試把這件事釘住：閘門回 503 四次、熔斷器打開，接著的預留照送、還回閘門照送（6.11.1）。

### 6.7.2 什麼算失敗

| 結果 | 熔斷器記成 | 為什麼 |
|---|---|---|
| 沒有回應（連不上、逾時） | 失敗 | |
| 5xx（包括庫存服務的 503「系統忙碌中」） | 失敗 | 庫存服務在說「我撐不住」：正是該退開的時候 |
| 4xx（庫存不足 409、狀態不對 409……） | **成功** | 業務的結果。搶購時一半的人買不到，熔斷器不能因為「賣光了」而打開（05-service/06 的 6.7.6） |

測試 `businessFailuresDoNotTrip`：十次庫存不足之後，第十一次照送。

### 6.7.3 打開的時候回什麼

503，`Retry-After` 是熔斷器要開著的秒數（5），不是平常的 1。

這一個 503 跟逾時的 503 不一樣：熔斷器打開時**根本沒有送出去**，庫存服務確定沒有處理（05-service/06 的 6.6.1 的 A 類）。app 照 `Retry-After` 等 5 秒、用同一個鍵再送是安全的。

### 6.7.4 補償不經過熔斷器

還回閘門（`return-hot`）、釋放預留這兩種，是回到一致的那一條路。熔斷器開著就擋掉它們，等於讓它停在不一致的地方更久。

它們照樣過隔艙、照樣有逾時。如果庫存服務真的不在，它們會失敗，由原本就有的機制收尾：

- 閘門每分鐘從 MySQL 對帳一次（第 12 站 6.6）。
- 沒有訂單的預留，由跨服務的對帳處理（第 02 章 2.6.4 的 `ReservationReconciliation`）。

### 6.7.5 ⚠️ 熔斷器開著，訂單還是先寫下去

只在送出預留的那一刻問熔斷器不夠。下單的 Saga 是這個順序（第 04 章 4.5）：

```
T1 訂單服務：寫下 RESERVING 的訂單  →  T2 庫存服務：預留  →  T3 訂單服務：PENDING_PAYMENT
```

熔斷器開著的時候，T2 立刻 503，但 T1 已經 commit 了。只在送出那一刻問，G1 每秒 40 張的那一輪，結束時有 **943 張** RESERVING 的訂單，要等 60 秒後的排程一張一張補償（第 04 章 4.5.5）。

訂單服務在庫存服務出事的那幾秒，每秒多寫 40 張訂單、之後再補償 40 張。每一張補償還會發一則 `order.rejected` 給庫存服務，在它剛恢復的時候。

修法是在寫訂單之前先問一次。`InventoryApi` 多一個預設什麼都不做的方法（單體、測試用的假實作都不用改），只有切開的訂單服務覆寫它：

```java
    /**
     * 13 站 6.7.5：現在預留，會不會一送出去就被擋下來（切開的部署：預留的熔斷器開著）？會 → 丟 503（帶 Retry-After）。
     * 下單在寫訂單（T1）之前先問一次：熔斷器開著的時候，不要先寫一張 RESERVING 的訂單、再讓排程在 60 秒後補償它。
     * 單體裡沒有遠端呼叫，什麼都不做
     */
    default void ensureReservable() {}
```

```java
    /**
     * 13 站 6.7.5：預留的熔斷器開著 → 503。要用 tryAcquirePermission()、再還回去，不能只看 getState()：
     * OPEN 是「被要求放行時」才轉成 HALF_OPEN（05-service/06 的 6.7.1）—— 只看狀態、從來不要求放行，它就永遠開著
     */
    @Override
    public void ensureReservable() {
        CircuitBreaker cb = breakers.get("reserve");
        if (cb.tryAcquirePermission()) {
            cb.releasePermission();
            return;
        }
        rejected("reserve", "breaker");
        throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", openSeconds);
    }
```

```java
            // 13 站 6.7.5：預留一定會被擋下來（熔斷器開著）→ 不寫這張訂單。也放在冪等鍵之後：已經成立的訂單重送，照樣回 200
            inventory.ensureReservable();
```

放在冪等鍵**之後**：一張已經成立的訂單，買家用同一個鍵再送，要照樣拿回 200，不能因為熔斷器開著而 503。

要用 `tryAcquirePermission()`、再還回去，不能只看 `getState() == OPEN`。熔斷器的 OPEN 要等有人要求放行，才轉成 HALF_OPEN（05-service/06 的 6.7.1）。如果這裡只看狀態、看到 OPEN 就不送，就永遠沒有人要求放行，它會一直開著。

同一個實驗，改了之後：RESERVING 289 張，其中 117 張庫存那一邊有預留。剩下的這些，是熔斷器打開之前的那幾秒留下的：

- **預留送到了、庫存服務做了**，回應晚了 3 秒，訂單服務 1 秒就逾時（這些有預留）。
- **隔艙滿了**：T1 已經寫了，預留沒送出去（這些沒有）。

後一種可以用同樣的辦法，在 T1 之前也問一次隔艙；這一章沒有做。

這個方法讓 B1 的名次掉回去了（6.10.4）。

### 6.7.6 熔斷器不是第一道防線

G1 之後的每秒那幾行（6.10.2）：

- 庫存服務在第 20 秒變慢，熔斷器在第 28 秒才打開，晚了大約 7 秒。時間窗是 10 秒，窗裡還有正常那一段的幾百次成功；要等失敗累積到一半，才過門檻。
- 這幾秒，Tomcat 忙 20 條上下、隔艙剩 0～1：**擋住的是隔艙。**
- 熔斷器打開之後，送給庫存服務的預留從每秒 20 個（隔艙的上限）掉到 0，每 5 秒放 3 個試探。

熔斷器還有一個代價：**庫存服務恢復了，它最多還要再擋 5 秒**，等下一次試探。

- G1 之後，每秒 40 張的「恢復」那一段，有 169 張是 503。第 06 章之前那一段一張都沒有，只是剛恢復的那幾秒比較慢。
- 6.10.3 把熔斷器關掉、重跑 G2：每秒 25 張的那兩輪，**沒有熔斷器反而回得比較快**。

所以這一章的熔斷器，管的是 6.2 那一種「等」：

- 下游一直在失敗時，不再送、不再佔執行緒，在幾毫秒內回 503。
- 讓 6.3 那種系統回得來的，是預算與重試預算。

把熔斷器當成第一道防線，等於在它打開之前的那幾秒裡沒有防線。

---

## 6.8 下單能不能不等庫存

這一章做的每一件事，都是讓「等庫存服務」等得比較有規矩：有上限、會放棄、放棄得快。還有一個選擇是**不等**：

- 下單的請求只寫下 RESERVING 的訂單、發一則事件，就回應買家「收到了」。
- 庫存服務收到事件之後預留，再發一則事件回來。
- 訂單服務收到之後，轉成 PENDING_PAYMENT 或 REJECTED。

第 04 章 4.4.2 的那張表：下單的 Saga 裡，T1 可補償、T2 預留是**樞紐**（它會拒絕，而且它之後的步驟都不會再失敗）、T3 可重試。非同步並沒有移動樞紐，它移動的是**誰在等樞紐**：從「買家在 HTTP 請求裡等」變成「買家在之後的某個時候知道結果」。

| | 現在（同步） | 不等庫存（非同步） |
|---|---|---|
| 庫存服務慢 3 秒 | 隔艙、熔斷：503，買家幾毫秒內知道「稍後再試」 | 下單照樣幾十毫秒回應；預留晚 3 秒完成 |
| 庫存服務停掉 10 分鐘 | 這 10 分鐘下單都是 503 | 這 10 分鐘照收訂單；恢復之後一口氣預留。賣光了的，買家在 10 分鐘後收到「抱歉」 |
| 訂單服務的執行緒 | 每一張佔到預留回來（最多 2 秒） | 不佔 |
| 回應 | 201 + `PENDING_PAYMENT`，或 409 庫存不足 | 202 + RESERVING，結果要另外問、或另外通知 |
| 付款 | 回應之後馬上可以付 | 要等預留完成才能付：「等」搬到了付款頁 |

最後兩列不是技術的問題，是**需求**的問題。第 12 站 US-ORD-1 的驗收條件寫得很清楚：

- AC-1：下單成功是 201、訂單狀態 `PENDING_PAYMENT`。
- AC-5：庫存不足是 409，而且 A、B 兩個品項全有或全無。

改成非同步，就是改這兩條：

- 客戶端要會處理 202 與「處理中」（輪詢或推播）。
- 「庫存不足」從一個同步的錯誤，變成一則之後的通知。
- 驗收 Q1（全有或全無）、Q2（搶購：恰好 1 筆 201、99 筆 409）全部要重寫。

**這一章不做**，理由有三個：

1. 隔艙、熔斷、預算之後，庫存服務慢或停，下單是幾毫秒的 503，不會拖垮訂單服務的其他功能（6.10.2）。
2. 熱點商品的搶購，大多數的人在 Redis 的閘門就被擋下（第 12 站 6.5.1），閘門本來就是同步的、毫秒級的。
3. 改需求要有需求的理由：庫存服務的可用性低到下單的 SLO 守不住，或者下單的尖峰大到庫存服務吃不下、需要一條佇列削峰。這兩件事都還沒有發生，也都量得到。

回頭再看的時機：庫存服務的 503 讓下單的錯誤率超過 0.6.3 的可用性目標（每月 99.9%），或者預留的 p99 讓下單的 SLO（p99 300 ms）守不住。

---

## 6.9 指標與契約

**新的指標**（`/actuator/prometheus`）：

| 指標 | 看什麼 |
|---|---|
| `resilience4j_circuitbreaker_state{name="inventory-reserve"\|"inventory-gate-hot", state=…}` | 熔斷器在哪個狀態 |
| `resilience4j_bulkhead_available_concurrent_calls{name="inventory-order-path"\|"inventory-others"}` | 隔艙還剩幾個位子 |
| `shop_remote_rejected_total{service="inventory", op, by="bulkhead"\|"breaker"\|"budget"}` | 沒有送出去就失敗的呼叫，以及是誰擋的 |
| `shop_inventory_budget_expired_total`（庫存服務） | 借到連線時，呼叫端的預算已經用完、沒有做的預留 |
| `shop_remote_no_response_total`（第 03 章就有） | 送了、沒有回應 |

日誌多一行 `INVENTORY_BREAKER op=reserve State transition from CLOSED to OPEN`（每一次狀態改變一行）。

告警該看哪一個？

- **不要只看熔斷器的狀態。** 它是被要求放行時才轉成 HALF_OPEN（6.7.5）：半夜沒有人下單時，儀表板上的 OPEN 可能已經開了一個小時，不代表庫存服務壞了一個小時（05-service/06 的 6.7.1）。
- 看 `rejected_total` 的速率：它是使用者真的拿到的 503。
- `budget_expired_total` 只要不是 0，就是庫存服務在排隊。

**契約沒有改。** 這一版的訂單服務每一次都送 `Shop-Budget-Ms`：下單時送剩下的預算；排程、管理員的呼叫沒有下單的預算，送的是 read timeout（1,000，測試 `sendsTheBudget`）。但對庫存服務來說，它是一個可以沒有的 header：

- 單體裡沒有遠端呼叫，也就沒有它。
- 線上那一版的訂單服務（第 03 章 3.8.5 的 `pacts/released/`）不送它。

所以庫存服務必須先能處理沒有它的請求，那就是原本的行為（沒有期限）。Pact 的契約不宣告它，提供端驗證時不帶它，驗的正是「沒有預算」的那一條路；帶預算的那一條路由 `InventoryServiceApiTest` 測（6.4.3）。failsafe 那一段跟第 05 章一樣是 39 個。

等到每一個版本的訂單服務都送它，才能考慮把它寫進契約、變成必要的。這是第 03 章 3.8 的同一個順序：先讓提供端接受新的東西，再讓呼叫端依賴它。

---

## 6.10 流程測試與追溯表

### 6.10.1 這一章新增的測試與實驗

| 名稱 | 種類 | 跑在哪裡 | 守什麼／量什麼 |
|---|---|---|---|
| `RemoteInventoryResilienceTest` | 測試（9 個） | 不用 Spring：假的庫存服務（JDK 的 `HttpServer`，真的 HTTP、真的逾時） | 一次送出等多久、`Shop-Budget-Ms`、預算不夠不送（6.4）；重試預算（6.5）；隔艙（6.6）；熔斷器的顆粒度、什麼算失敗、`Retry-After`、`ensureReservable`（6.7） |
| `DeadlineTest`、`RetryBudgetTest` | 測試（各 3 個） | 不用 Spring | 期限只會越往裡越少、離開就還原（6.4.3）；重試預算的保底、比例、會滑動的窗（6.5.2） |
| `InventoryServiceApiTest` | 測試（多 1 個） | Testcontainers，庫存服務的角色 | `Shop-Budget-Ms: 0` → 503、不預留、`processed_messages` 沒有那一列（6.4.3） |
| `DeploymentPropertiesTest` | 測試（多 1 個） | 只綁定設定 | 由外而內遞減的兩條規則，設錯了起不來（6.4.2） |
| G1 `G1CascadeTest` | 實驗 | compose、兩個服務在同一個 JVM | 6.2、6.10.2 |
| G2 `G2RetryStormTest` | 實驗 | compose、庫存服務的連線池 4 條 + `SlowDb` | 6.3、6.10.3 |
| 第 04 章的 E4、第 01 章的 B1 | 實驗（重跑） | —— | 6.10.4 |

> ⚠️ **`InventoryServiceApiTest` 的新測試，商品編號不能跟同一個類別裡的其他測試重複**（例如補貨那個測試的 9930031）。兩個測試共用一個資料庫，後跑的那一個 `INSERT INTO inventory` 主鍵重複（`DuplicateKeyException`）。用沒有人用的編號。

預設的測試從第 05 章的 338 個變成 355 個（6.11）。

### 6.10.2 G1，之後

同一個實驗，跑在這一章最後的程式碼上（多了每秒的熔斷器狀態與隔艙剩下的位子）：

```
═══ 6.2 庫存服務的預留慢 3 秒，訂單服務用正式的設定（connect 1000 ms、read 1000 ms、最多送 2 次；下單的預算 2000 ms；下單路徑的隔艙 20；熔斷 10 秒內至少 20 次、失敗 50% → 開 5 秒）═══
═══ 每秒 20 張下單（load { 5.45 4.73 4.74 }）═══
  正常     │ 下單   │  400 次 │ p50     25.1 ms │ p99     52.7 ms │ max     78.3 ms │ {201=400}
  正常     │ 商品詳情 │   96 次 │ p50      2.1 ms │ p99     19.1 ms │ max     19.1 ms │ {200=96}
  正常     │ 我的訂單 │   96 次 │ p50      4.7 ms │ p99     22.5 ms │ max     22.5 ms │ {200=96}
  慢 3 秒  │ 下單   │  400 次 │ p50     17.9 ms │ p99   2004.3 ms │ max   2021.9 ms │ {201=2, 503=398}
  慢 3 秒  │ 商品詳情 │   93 次 │ p50      3.3 ms │ p99     27.5 ms │ max     27.5 ms │ {200=93}
  慢 3 秒  │ 我的訂單 │   93 次 │ p50      6.5 ms │ p99     24.3 ms │ max     24.3 ms │ {200=93}
  恢復     │ 下單   │  400 次 │ p50     24.6 ms │ p99    204.0 ms │ max    279.6 ms │ {201=346, 503=54}
  恢復     │ 商品詳情 │   94 次 │ p50      1.9 ms │ p99     36.0 ms │ max     36.0 ms │ {200=94}
  恢復     │ 我的訂單 │   94 次 │ p50      4.3 ms │ p99     38.5 ms │ max     38.5 ms │ {200=94}
  正常     │ 下單  400 張 │ 送給庫存服務的預留  402 次（這一段的 20 秒裡）
  慢 3 秒  │ 下單  400 張 │ 送給庫存服務的預留  108 次（這一段的 20 秒裡）
  恢復     │ 下單  400 張 │ 送給庫存服務的預留  350 次（這一段的 20 秒裡）
  訂單服務記到的「沒有回應」108 次
  每秒：
     19 秒 正常    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  1 pending   0 │ 熔斷器 closed    │ 隔艙剩 20
     20 秒 正常    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  21 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩 19
     21 秒 慢 3 秒 │ Tomcat 忙  21/200 排隊    0 │ 還沒回應的下單  20 │ 這一秒送給庫存服務的預留  19 │ 連線池 active  1 pending   0 │ 熔斷器 closed    │ 隔艙剩  1
     22 秒 慢 3 秒 │ Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩  1
     23 秒 慢 3 秒 │ Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩  0
     24 秒 慢 3 秒 │ Tomcat 忙  19/200 排隊    0 │ 還沒回應的下單  19 │ 這一秒送給庫存服務的預留  19 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩  1
     25 秒 慢 3 秒 │ Tomcat 忙  19/200 排隊    0 │ 還沒回應的下單  19 │ 這一秒送給庫存服務的預留  19 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩  1
     26 秒 慢 3 秒 │ Tomcat 忙   5/200 排隊    0 │ 還沒回應的下單   5 │ 這一秒送給庫存服務的預留   5 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 15
     27 秒 慢 3 秒 │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     28 秒 慢 3 秒 │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     29 秒 慢 3 秒 │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     30 秒 慢 3 秒 │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     39 秒 慢 3 秒 │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     40 秒 慢 3 秒 │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     41 秒 恢復    │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     42 秒 恢復    │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     43 秒 恢復    │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留   9 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩 20
     44 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩 20
     45 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  1 pending   0 │ 熔斷器 closed    │ 隔艙剩 20
     46 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  1 pending   0 │ 熔斷器 closed    │ 隔艙剩 20
  這一輪的訂單，狀態：{PENDING_PAYMENT=754,RESERVING=112}
  其中卡在 RESERVING 的，庫存服務那一邊有預留的：90 張
═══ 每秒 40 張下單（load { 4.72 4.61 4.70 }）═══
  正常     │ 下單   │  800 次 │ p50     18.3 ms │ p99     46.7 ms │ max     92.5 ms │ {201=800}
  正常     │ 商品詳情 │   97 次 │ p50      1.3 ms │ p99      4.1 ms │ max      4.1 ms │ {200=97}
  正常     │ 我的訂單 │   97 次 │ p50      3.0 ms │ p99     14.0 ms │ max     14.0 ms │ {200=97}
  慢 3 秒  │ 下單   │  800 次 │ p50     10.6 ms │ p99   2003.3 ms │ max   2005.0 ms │ {201=2, 503=798}
  慢 3 秒  │ 商品詳情 │   96 次 │ p50      2.0 ms │ p99      8.8 ms │ max      8.8 ms │ {200=96}
  慢 3 秒  │ 我的訂單 │   96 次 │ p50      3.9 ms │ p99      7.9 ms │ max      7.9 ms │ {200=96}
  恢復     │ 下單   │  800 次 │ p50     16.8 ms │ p99     73.6 ms │ max    157.2 ms │ {201=631, 503=169}
  恢復     │ 商品詳情 │   96 次 │ p50      1.3 ms │ p99     12.3 ms │ max     12.3 ms │ {200=96}
  恢復     │ 我的訂單 │   96 次 │ p50      2.8 ms │ p99     41.6 ms │ max     41.6 ms │ {200=96}
  正常     │ 下單  800 張 │ 送給庫存服務的預留  802 次（這一段的 20 秒裡）
  慢 3 秒  │ 下單  800 張 │ 送給庫存服務的預留  146 次（這一段的 20 秒裡）
  恢復     │ 下單  800 張 │ 送給庫存服務的預留  638 次（這一段的 20 秒裡）
  訂單服務記到的「沒有回應」146 次
  每秒：
     19 秒 正常    │ Tomcat 忙   2/200 排隊    0 │ 還沒回應的下單   2 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  2 pending   0 │ 熔斷器 closed    │ 隔艙剩 20
     20 秒 正常    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  1 pending   0 │ 熔斷器 closed    │ 隔艙剩 20
     21 秒 慢 3 秒 │ Tomcat 忙  21/200 排隊    0 │ 還沒回應的下單  21 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩  0
     22 秒 慢 3 秒 │ Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  1 pending   0 │ 熔斷器 closed    │ 隔艙剩  1
     23 秒 慢 3 秒 │ Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩  0
     24 秒 慢 3 秒 │ Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 這一秒送給庫存服務的預留  21 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩  0
     25 秒 慢 3 秒 │ Tomcat 忙  19/200 排隊    0 │ 還沒回應的下單  19 │ 這一秒送給庫存服務的預留  19 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩  1
     26 秒 慢 3 秒 │ Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩  0
     27 秒 慢 3 秒 │ Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  21 │ 這一秒送給庫存服務的預留  20 │ 連線池 active  0 pending   0 │ 熔斷器 closed    │ 隔艙剩  0
     28 秒 慢 3 秒 │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  1 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     29 秒 慢 3 秒 │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     30 秒 慢 3 秒 │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     39 秒 慢 3 秒 │ Tomcat 忙   3/200 排隊    0 │ 還沒回應的下單   4 │ 這一秒送給庫存服務的預留   3 │ 連線池 active  0 pending   0 │ 熔斷器 half_open │ 隔艙剩 17
     40 秒 慢 3 秒 │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     41 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  1 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     42 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  1 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     43 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  1 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     44 秒 恢復    │ Tomcat 忙   0/200 排隊    0 │ 還沒回應的下單   0 │ 這一秒送給庫存服務的預留   0 │ 連線池 active  0 pending   0 │ 熔斷器 open      │ 隔艙剩 20
     45 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  37 │ 連線池 active  1 pending   0 │ 熔斷器 closed    │ 隔艙剩 20
     46 秒 恢復    │ Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 這一秒送給庫存服務的預留  40 │ 連線池 active  1 pending   0 │ 熔斷器 closed    │ 隔艙剩 20
  這一輪的訂單，狀態：{PENDING_PAYMENT=1441,RESERVING=289}
  其中卡在 RESERVING 的，庫存服務那一邊有預留的：117 張
  （結束時 load { 4.17 4.46 4.63 }）
```

（每秒的那幾行只留 19～30 秒、39～46 秒。狀態那一行的訂單總數，比三段加起來多幾張：第 60 秒、實驗台停下來之前又送出了幾張，它們不在任何一段裡。）

每秒 40 張、慢 3 秒的那一段，之前與之後：

| | 第 06 章之前 | 之後 |
|---|---|---|
| 下單 | p50 6,128 ms，600 張 503、200 張成立 | p50 10.6 ms，798 張 503（`Retry-After: 5`） |
| 訂單服務的 Tomcat | 200/200，排隊最多 123 | 最多 21 條 |
| 商品詳情 p99 | 2,945 ms（只打了 29 次） | 8.8 ms（96 次） |
| 我的訂單 p99 | 2,071 ms | 7.9 ms |
| 送給庫存服務的預留（這 20 秒） | 1,282 次 | 146 次 |
| 卡在 RESERVING（其中庫存那一邊有預留的） | 600（600） | 289（117） |

這張表裡最大的改變不是下單：**下單本來就會失敗**，庫存服務慢 3 秒，這一段的下單成不了。改變的是失敗的方式：

- 之前每一張等 6 秒、佔一條執行緒，把整個訂單服務一起拖下去。
- 之後大多數在十毫秒左右就 503，其他的頁面跟沒事一樣。

**下單也成立得比較少**：之前這一段有 200 張最後成立，之後只有 2 張。原因有兩個：

- 1 秒的逾時比 3 秒的慢更短，一次都等不到。
- 熔斷器打開之後，就不再試了。

這是預算的代價（6.4.2）：慢到超過預算的，一律算失敗。

**「恢復」那一段多了 169 張 503**：庫存服務在第 40 秒恢復，熔斷器在第 45 秒才關上，等的是下一次試探（6.7.6）。

### 6.10.3 G2，之後

```
═══ 6.3 ① 乘法：庫存服務的預留 7 秒才回應，每秒 2 張、10 秒（load { 4.36 4.48 4.63 }）═══
  app 最多送 1 次 │ 下單意圖 21 │ app 送出 21 次 │ 訂單服務送給庫存服務 30 次 │ 庫存服務處理了 30 次（18 張訂單，每一張 1.7 次）│ 買家最後看到 {503=21} │ 每一個意圖 p50 2.0 秒
  app 最多送 3 次 │ 下單意圖 21 │ app 送出 63 次 │ 訂單服務送給庫存服務 12 次 │ 庫存服務處理了 12 次（8 張訂單，每一張 1.5 次）│ 買家最後看到 {503=21} │ 每一個意圖 p50 10.1 秒
═══ 6.3 ② 回不來：庫存服務的連線池 4 條、每個預留交易 +100 ms；中間 10 秒每個預留交易 +1000 ms（load { 3.83 4.28 4.55 }）═══
═══ 每秒 10 張下單，app 最多送 1 次（load { 3.83 4.28 4.55 }）═══
  正常     │ 下單   │  200 次 │ p50    142.1 ms │ p99    196.3 ms │ max    223.2 ms │ {201=199, 503=1}
  觸發     │ 下單   │  100 次 │ p50     47.4 ms │ p99   2008.8 ms │ max   2060.3 ms │ {201=1, 503=99}
  之後     │ 下單   │  400 次 │ p50    142.8 ms │ p99    196.9 ms │ max   1049.2 ms │ {201=339, 503=61}
  正常   │ 下單意圖  200 │ 庫存服務收到預留  199 次（1.0 倍）│ 做完  199，其中呼叫端早就放棄的    0 │ 503    0
  觸發   │ 下單意圖  100 │ 庫存服務收到預留   60 次（0.6 倍）│ 做完   26，其中呼叫端早就放棄的   25 │ 503   34
  之後   │ 下單意圖  400 │ 庫存服務收到預留  340 次（0.9 倍）│ 做完  340，其中呼叫端早就放棄的    1 │ 503    0
  觸發結束之後：第 38 秒起恢復（觸發結束後 7 秒）
  庫存服務：借到連線時呼叫端的預算已經用完、沒有做的預留 34 次
═══ 每秒 25 張下單，app 最多送 1 次（load { 3.50 4.02 4.42 }）═══
  正常     │ 下單   │  500 次 │ p50    128.5 ms │ p99    184.3 ms │ max    225.3 ms │ {201=500}
  觸發     │ 下單   │  250 次 │ p50     19.6 ms │ p99   2005.5 ms │ max   2006.4 ms │ {201=2, 503=248}
  之後     │ 下單   │ 1000 次 │ p50    129.1 ms │ p99    205.5 ms │ max    238.4 ms │ {201=976, 503=24}
  正常   │ 下單意圖  500 │ 庫存服務收到預留  500 次（1.0 倍）│ 做完  500，其中呼叫端早就放棄的    0 │ 503    0
  觸發   │ 下單意圖  250 │ 庫存服務收到預留  117 次（0.5 倍）│ 做完   30，其中呼叫端早就放棄的   28 │ 503   87
  之後   │ 下單意圖 1000 │ 庫存服務收到預留  976 次（1.0 倍）│ 做完  976，其中呼叫端早就放棄的    0 │ 503    0
  觸發結束之後：第 33 秒起恢復（觸發結束後 2 秒）
  庫存服務：借到連線時呼叫端的預算已經用完、沒有做的預留 87 次
═══ 每秒 25 張下單，app 最多送 3 次（load { 4.44 4.17 4.44 }）═══
  正常     │ 下單   │  500 次 │ p50    128.1 ms │ p99    173.0 ms │ max    207.2 ms │ {201=500}
  觸發     │ 下單   │  250 次 │ p50   5530.9 ms │ p99   8030.7 ms │ max  10035.3 ms │ {200=46, 201=53, 503=151}（app 送了 695 次）
  之後     │ 下單   │ 1000 次 │ p50    134.0 ms │ p99   6038.9 ms │ max   6600.6 ms │ {200=75, 201=911, 503=14}（app 送了 1138 次）
  正常   │ 下單意圖  500 │ 庫存服務收到預留  500 次（1.0 倍）│ 做完  500，其中呼叫端早就放棄的    0 │ 503    0
  觸發   │ 下單意圖  250 │ 庫存服務收到預留  121 次（0.5 倍）│ 做完   30，其中呼叫端早就放棄的   28 │ 503   91
  之後   │ 下單意圖 1000 │ 庫存服務收到預留 1081 次（1.1 倍）│ 做完 1081，其中呼叫端早就放棄的    0 │ 503    0
  觸發結束之後：第 40 秒起恢復（觸發結束後 9 秒）
  庫存服務：借到連線時呼叫端的預算已經用完、沒有做的預留 91 次
═══ 6.10.3 同一個實驗，熔斷器關掉（minimum-calls 100 萬）；預算、重試預算、隔艙照舊（load { 4.14 4.19 4.42 }）═══
═══ 每秒 25 張下單，app 最多送 1 次（load { 4.14 4.19 4.42 }）═══
  正常     │ 下單   │  500 次 │ p50    125.0 ms │ p99    138.1 ms │ max    148.9 ms │ {201=500}
  觸發     │ 下單   │  250 次 │ p50   1012.6 ms │ p99   2006.1 ms │ max   2007.8 ms │ {201=15, 503=235}
  之後     │ 下單   │ 1000 次 │ p50    128.0 ms │ p99    512.4 ms │ max    735.2 ms │ {201=998, 503=2}
  正常   │ 下單意圖  500 │ 庫存服務收到預留  500 次（1.0 倍）│ 做完  500，其中呼叫端早就放棄的    0 │ 503    0
  觸發   │ 下單意圖  250 │ 庫存服務收到預留  197 次（0.8 倍）│ 做完   56，其中呼叫端早就放棄的   41 │ 503  141
  之後   │ 下單意圖 1000 │ 庫存服務收到預留  998 次（1.0 倍）│ 做完  998，其中呼叫端早就放棄的    0 │ 503    0
  觸發結束之後：第 32 秒起恢復（觸發結束後 1 秒）
  庫存服務：借到連線時呼叫端的預算已經用完、沒有做的預留 141 次
═══ 每秒 25 張下單，app 最多送 3 次（load { 4.21 4.12 4.37 }）═══
  正常     │ 下單   │  500 次 │ p50    129.4 ms │ p99    191.0 ms │ max    225.1 ms │ {201=500}
  觸發     │ 下單   │  250 次 │ p50   2122.9 ms │ p99   6021.5 ms │ max   6060.3 ms │ {200=34, 201=10, 503=206}（app 送了 718 次）
  之後     │ 下單   │ 1000 次 │ p50    132.1 ms │ p99   2026.2 ms │ max   2668.3 ms │ {200=21, 201=975, 503=4}（app 送了 1038 次）
  正常   │ 下單意圖  500 │ 庫存服務收到預留  500 次（1.0 倍）│ 做完  500，其中呼叫端早就放棄的    0 │ 503    0
  觸發   │ 下單意圖  250 │ 庫存服務收到預留  201 次（0.8 倍）│ 做完   59，其中呼叫端早就放棄的   44 │ 503  142
  之後   │ 下單意圖 1000 │ 庫存服務收到預留 1025 次（1.0 倍）│ 做完 1025，其中呼叫端早就放棄的    0 │ 503    0
  觸發結束之後：第 34 秒起恢復（觸發結束後 3 秒）
  庫存服務：借到連線時呼叫端的預算已經用完、沒有做的預留 142 次
  （結束時 load { 5.03 4.47 4.48 }）
```

（每秒的那幾行全部省略；每秒 25 張、app 送 1 次的那一輪，觸發前後在下面。）

```
     20 秒 正常 │ 這一秒成立的下單  25 │ 庫存服務：進來  25、做完  25（呼叫端早就放棄的   0）、503   0 │ 連線池 active  3 pending   0 │ 訂單服務 Tomcat 忙   3/200 排隊    0 │ 還沒回應的下單   3 │ 熔斷器 closed    │ 隔艙剩 17
     21 秒 觸發 │ 這一秒成立的下單   5 │ 庫存服務：進來  22、做完   5（呼叫端早就放棄的   0）、503   0 │ 連線池 active  4 pending  16 │ 訂單服務 Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 熔斷器 closed    │ 隔艙剩  0
     22 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  20、做完   4（呼叫端早就放棄的   4）、503   0 │ 連線池 active  4 pending  32 │ 訂單服務 Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 熔斷器 closed    │ 隔艙剩  0
     23 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  20、做完   4（呼叫端早就放棄的   4）、503  13 │ 連線池 active  4 pending  35 │ 訂單服務 Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 熔斷器 closed    │ 隔艙剩  0
     24 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  20、做完   4（呼叫端早就放棄的   4）、503  17 │ 連線池 active  4 pending  34 │ 訂單服務 Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 熔斷器 closed    │ 隔艙剩  0
     25 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  20、做完   4（呼叫端早就放棄的   4）、503  16 │ 連線池 active  4 pending  35 │ 訂單服務 Tomcat 忙  20/200 排隊    0 │ 還沒回應的下單  20 │ 熔斷器 closed    │ 隔艙剩  0
     26 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來  15、做完   4（呼叫端早就放棄的   4）、503  16 │ 連線池 active  4 pending  30 │ 訂單服務 Tomcat 忙  15/200 排隊    0 │ 還沒回應的下單  15 │ 熔斷器 open      │ 隔艙剩  5
     27 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來   0、做完   4（呼叫端早就放棄的   4）、503  15 │ 連線池 active  4 pending  10 │ 訂單服務 Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 熔斷器 open      │ 隔艙剩 20
     28 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來   0、做完   4（呼叫端早就放棄的   4）、503  10 │ 連線池 active  0 pending   0 │ 訂單服務 Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 熔斷器 open      │ 隔艙剩 20
     29 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來   0、做完   0（呼叫端早就放棄的   0）、503   0 │ 連線池 active  0 pending   0 │ 訂單服務 Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 熔斷器 open      │ 隔艙剩 20
     30 秒 觸發 │ 這一秒成立的下單   0 │ 庫存服務：進來   0、做完   0（呼叫端早就放棄的   0）、503   0 │ 連線池 active  0 pending   0 │ 訂單服務 Tomcat 忙   1/200 排隊    0 │ 還沒回應的下單   1 │ 熔斷器 open      │ 隔艙剩 20
     31 秒 之後 │ 這一秒成立的下單   0 │ 庫存服務：進來   3、做完   0（呼叫端早就放棄的   0）、503   0 │ 連線池 active  0 pending   0 │ 訂單服務 Tomcat 忙   2/200 排隊    0 │ 還沒回應的下單   2 │ 熔斷器 closed    │ 隔艙剩 20
     32 秒 之後 │ 這一秒成立的下單  23 │ 庫存服務：進來  23、做完  24（呼叫端早就放棄的   0）、503   0 │ 連線池 active  3 pending   0 │ 訂單服務 Tomcat 忙   3/200 排隊    0 │ 還沒回應的下單   3 │ 熔斷器 closed    │ 隔艙剩 17
     33 秒 之後 │ 這一秒成立的下單  25 │ 庫存服務：進來  25、做完  24（呼叫端早就放棄的   0）、503   0 │ 連線池 active  3 pending   0 │ 訂單服務 Tomcat 忙   3/200 排隊    0 │ 還沒回應的下單   3 │ 熔斷器 closed    │ 隔艙剩 17
     34 秒 之後 │ 這一秒成立的下單  25 │ 庫存服務：進來  25、做完  25（呼叫端早就放棄的   0）、503   0 │ 連線池 active  3 pending   0 │ 訂單服務 Tomcat 忙   3/200 排隊    0 │ 還沒回應的下單   3 │ 熔斷器 closed    │ 隔艙剩 17
     35 秒 之後 │ 這一秒成立的下單  25 │ 庫存服務：進來  25、做完  25（呼叫端早就放棄的   0）、503   0 │ 連線池 active  3 pending   0 │ 訂單服務 Tomcat 忙   3/200 排隊    0 │ 還沒回應的下單   3 │ 熔斷器 closed    │ 隔艙剩 17
     36 秒 之後 │ 這一秒成立的下單  25 │ 庫存服務：進來  25、做完  25（呼叫端早就放棄的   0）、503   0 │ 連線池 active  3 pending   0 │ 訂單服務 Tomcat 忙   3/200 排隊    0 │ 還沒回應的下單   3 │ 熔斷器 closed    │ 隔艙剩 17
```

**① 乘法：app 送 3 次，每一個下單意圖讓庫存服務處理的預留，從 6.0 次變成 0.6 次**（12 次 ÷ 21 個意圖）。熔斷器在前幾秒就打開，之後 app 的每一次重送都在訂單服務那裡就被擋下：不寫訂單（6.7.5）、不送出去。

app 送 1 次的那一輪，處理了 30 次。熔斷器打開之前，訂單服務的第二次送出照樣發生：重試預算每 10 秒保底 10 次，這裡還沒用完。

買家那一邊：

- app 送 1 次：等 2.0 秒拿到 503（之前 6.0 秒）：兩次 1 秒的逾時，預算就用完了。
- app 送 3 次：等 10.1 秒。中間是兩次 `Retry-After: 5`。

**② 回不來**：

| | 之前：觸發結束後 | 之後 | 熔斷器關掉 |
|---|---|---|---|
| 每秒 10 張，app 1 次 | 2 秒 | 7 秒 | （沒有跑） |
| 每秒 25 張，app 1 次 | 40 秒內沒有恢復 | 2 秒 | 1 秒 |
| 每秒 25 張，app 3 次 | 40 秒內沒有恢復 | 9 秒 | 3 秒 |

每秒 25 張、app 1 次的那一輪，對照 6.3.4 每秒的那幾行：

- **觸發一開始，「進來」沒有變成兩倍。** 之前是 25 → 50；之後是 25 → 20 上下：隔艙只放 20 個進來，第二次送出也在預算與重試預算裡被擋下。
- **連線池的 pending 停在三十幾，不再一路爬。**
- **觸發結束之後，「呼叫端早就放棄的」是 0。** 排在連線池裡、借到連線時預算已經用完的，不做（這一輪 87 個）。

只要排隊的不再被做、也不再被重送，觸發一結束，排隊就消化掉了。

**熔斷器關掉的那兩輪，回得更快**：1 秒、3 秒，比有熔斷器的 2 秒、9 秒短。觸發那 10 秒裡成立的下單也比較多（15 張，有熔斷器時 2 張）。

讓 6.3 那種系統回得來的，是三樣東西：

- 預算
- 借到連線之後的預算檢查
- 重試預算

熔斷器在這裡只多了一件事：庫存服務恢復之後，它還要等下一次試探才關上。

熔斷器的價值在 6.10.2：庫存服務一直在失敗時，訂單服務不再送、不再佔執行緒。這一章兩件事都要，但要知道各自管的是什麼（6.7.6）。

**兩個代價**，都在每秒 10 張的那一輪：

| | 之前 | 之後 |
|---|---|---|
| 觸發那 10 秒裡，最後成立的下單 | 70 張（p50 5,113 ms） | 1 張 |
| 觸發結束之後多久恢復 | 2 秒 | 7 秒 |

- 之前那 70 張等了 5 秒上下才成立；之後超過 2 秒的預算，一律 503。
- 之前觸發一結束就回來；之後要等熔斷器的下一次試探。

負載低的時候，這一章的保護讓結果**變差**了一點。它換到的，是負載高的時候不會回不來。

### 6.10.4 E4、B1 重跑

使用者的一天（第 04 章的 E4），在最後的 commit 上：

```
  訂單服務 → 庫存服務：14 次 HTTP、7 種端點（第 03 章：38 次、10 種）
    POST /api/orders → POST /internal/inventory/v1/hot-gate                                              × 2
    POST /api/orders → PUT /internal/inventory/v1/reservations/{n}                                       × 6
    POST /api/seller/orders/{orderNo}/ship → GET /internal/inventory/v1/reservations/{n}/shippable       × 2
    POST /api/seller/products/{id}/hot → PUT /internal/inventory/v1/products/{n}/hot                     × 1
    POST /api/seller/products/{id}/restock → GET /internal/inventory/v1/stock                            × 1
    POST /api/seller/products/{id}/restock → POST /internal/inventory/v1/products/{n}/restocks           × 1
    排程 ReservationReconciliation.run → GET /internal/inventory/v1/reservations                           × 1
```

跟第 05 章一樣：14 次 HTTP、7 種端點。這一章沒有改任何一次呼叫的「次數」，只改了每一次呼叫怎麼等、怎麼放棄。

B1（第 01 章的邊界地圖）：

```
  ordering → InventoryApi.ensureReservable      6 次（交易裡  0，唯讀  0）  [POST /api/orders]
     9 │ catalog+inventory                   │          0 │          0 │        9 │        1 │    5 │  25.0%（9）
    24 │ inventory                           │          0 │          0 │       10 │        0 │    7 │  22.2%（8）
```

庫存這一刀的同步呼叫從 9 種變成 10 種，127 種切法裡的名次從第 16 名回到第 24 名。多出來的那一種，是 6.7.5 的 `ensureReservable`。

B1 數的是**模組之間的介面呼叫**：單體裡，訂單模組多呼叫了庫存模組的一個方法。切開之後，這個方法不出網路，問的是訂單服務自己記憶體裡的熔斷器。B1 沒有算錯，介面確實變寬了一點：

- 這個方法屬於「切開的部署才有意義」的那一類。
- 單體的實作什麼都不做，卻還是一個訂單模組依賴庫存模組的地方。

把它換成訂單模組自己問一個「庫存服務現在能不能用」的元件，B1 會回到 9 種，但那個元件要知道庫存服務的熔斷器在哪裡 —— 只是換一個地方耦合。這一章接受這個名次。

### 6.10.5 追溯表：這一站的產出

| README 的產出 | 第 00～02 章 | 第 03～05 章 | 第 06 章加上的 |
|---|---|---|---|
| 1. 拆分決策文件 | 不該拆；四個代價；第一刀切 notification；資料的三個階段 | 同步還是非同步；2PC 不選的理由；交易各用編排還是協同；跨服務的讀哪些可以晚 | 每一個「等」的上限與它們的順序（6.4.1）；下單不等庫存：它改的是需求（6.8） |
| 2. 庫存拆成獨立服務、下單改成 Saga | 兩種部署、獨立的資料庫、對帳 | 正式的服務、契約、Saga、補償、演練、延遲對照；熱點旗標搬回庫存 | 下單路徑的四道保護：預算、重試預算、隔艙、熔斷器（6.4～6.7）；庫存服務慢 3 秒時，下單十毫秒左右就 503，其他頁面不受影響（6.10.2） |
| 3. 跨服務報表：API 組合版與讀模型版、過時視窗 | 庫存這一刀不切斷報表 | 三個讀的頁面：API 組合 → 讀模型；過時視窗；重建 | （沒有改） |
| 4. 一條完整的 trace | K5 | 送的那一邊好了、收的那一邊還斷 | （沒有量；第 07 章） |
| 5. 基礎設施選型 | 維運清單 | 一個 jar、三種角色；Pact Broker；第一次上線要重建副本 | 熔斷器放在應用程式裡（Resilience4j，6.7）；sidecar 的重試也要算進乘法（6.3.5，第 08 章） |

---

## 6.11 本章完成後的專案

```
shop/                                                              ← 分支 d06（從 d05 開出來）
├── pom.xml                                                        ← 6.6、6.7：Resilience4j 2.2.0（熔斷器、隔艙、指標）
├── src/main/java/com/example/shop/
│   ├── shared/resilience/Deadline.java、RetryBudget.java、BudgetFilter.java ← + 6.4.3、6.5.2
│   ├── shared/config/ShopProperties.java                          ← 6.4～6.7：read timeout 1 秒、max-attempts、重試預算、隔艙、熔斷器、下單的預算；兩條啟動時的檢查
│   ├── inventory/InventoryApi.java                                ← 6.7.5：ensureReservable（預設什麼都不做）
│   ├── inventory/internal/remote/RemoteInventoryApi.java          ← 6.4～6.7：每一次呼叫的四道保護
│   ├── inventory/internal/JdbcInventoryService.java               ← 6.4.3：借到連線之後看預算
│   └── ordering/internal/PlaceOrderService.java                   ← 6.4.5：下單的預算；6.7.5：寫訂單之前問熔斷器
└── src/test/java/com/example/shop/
    ├── dist06/G1CascadeTest.java、G2RetryStormTest.java            ← 6.2、6.3（實驗）
    ├── dist06/Rig.java、SlowDb.java、ServerTap.java                 ← 實驗台
    ├── inventory/internal/remote/RemoteInventoryResilienceTest.java ← + 6.4～6.7
    ├── shared/resilience/DeadlineTest.java、RetryBudgetTest.java    ← + 6.4.3、6.5.2
    ├── inventory/internal/web/InventoryServiceApiTest.java         ← 6.4.3
    └── shared/config/DeploymentPropertiesTest.java                 ← 6.4.2
```

**沒有 migration；對買家、賣家的 API 沒有任何改變**（`OpenApiContractTest` 的快照沒有動）。服務之間多了一個可以沒有的 header `Shop-Budget-Ms`，契約沒有改（6.9）。單體的行為沒有改變：`RemoteInventoryApi` 只在訂單服務的角色裡；單體的下單也帶著 2 秒的預算，但沒有遠端呼叫讀它；`ensureReservable` 什麼都不做。

完整跑一次：

```bash
mvn clean verify
```

```
TEST_INFRA testcontainers 啟動 9,063 ms：mysql jdbc:mysql://localhost:62879/shop、redis localhost:62869、rabbitmq localhost:62877
TEST_INFRA MySQL 最多同時 32 條連線（max_connections 151）
[INFO] Tests run: 355, Failures: 0, Errors: 0, Skipped: 0
TEST_INFRA testcontainers 啟動 10,588 ms：mysql jdbc:mysql://localhost:64468/shop、redis localhost:64458、rabbitmq localhost:64466
TEST_INFRA MySQL 最多同時 5 條連線（max_connections 151）
[INFO] Tests run: 39, Failures: 0, Errors: 0, Skipped: 0
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  05:52 min
```

**355 個測試**：第 05 章的 338 個，加上：

| 測試 | 多了幾個 |
|---|---|
| `RemoteInventoryResilienceTest` | 9 |
| `DeadlineTest` | 3 |
| `RetryBudgetTest` | 3 |
| `InventoryServiceApiTest` | 1 |
| `DeploymentPropertiesTest` | 1 |

**failsafe 那一段 39 個**，跟第 05 章一樣（6.9）。

> ⚠️ **整套測試偶爾會紅一個：第 12 站的驗收 Q10，不是這一章的程式。**
>
> Q10 把同一則 `order.placed` 同時送 10 次，期望通知只被「認領」一次（`notification_attempts = 1`）；紅的時候是 2。第 12 站 7.7.2 的認領是「`attempts` 從 n 改成 n + 1，條件是還是 n」。它擋得住「兩條執行緒讀到同一個 n」，擋不住下面這一種：
>
> - A 讀到 0、認領成功（0 → 1），開始寄信。
> - B 在 A 認領之後、標 SENT 之前讀到 1，`status` 還是 PENDING，認領也成功（1 → 2），也寄。
>
> 買家收到兩封。第 12 站 7.7.2 說「只有一條會成功認領」，在這個順序下不成立。
>
> 單獨跑 Q10：
>
> - 這一章的最後一個 commit 上，8 次紅 1 次。
> - 第 05 章的程式碼上，36 次紅 1 次（同樣是 `notification_attempts=2`）。
>
> 這一章的改動沒有碰通知的程式，也不在消費者的執行緒上，**這一章沒有修**。修法是像 relay 那樣給認領一個租約（第 12 站 7.4.2 的 `claimed_until`），做在第 08 章，寫成[第 12 站 7.7.2](../12-capstone/07-event-driven-order-flow.md)：認領改成租約（V26 `claimed_until`），認領不到的那一份丟例外、走重試階梯，不再 ack 掉。`NotificationClaimTest` 把上面那個順序釘住，第 08 章的整套測試裡有它。

### 6.11.1 本章其餘檔案的完整內容

正文已經完整列出的：`Deadline`（6.4.3）、`RetryBudget`（6.5.2）。正文列過片段的：`RemoteInventoryApi`、`ShopProperties`、`PlaceOrderService`、`JdbcInventoryService`、`InventoryApi`、`BudgetFilter`，以及第一個 commit 的 G1、G2、`Rig`、`SlowDb`、`ServerTap`（6.2、6.3）。

下面是其餘的檔案：新增的，列 `d06` 分支上的完整內容；改動的，列 diff。

**`src/main/java/com/example/shop/shared/resilience/BudgetFilter.java`**（6.4.3）

```java
package com.example.shop.shared.resilience;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Duration;

/**
 * 13 站 6.4.3：服務之間的請求（/internal/**）帶著 Shop-Budget-Ms → 這個請求在這個服務裡的期限（Deadline）。
 * 沒有帶、或不是一個數字 → 沒有期限（照舊）。只收 /internal/**：買家送來的 header 不算數 —— 預算是上游的服務給的，不是客戶端。
 */
@Component
class BudgetFilter extends OncePerRequestFilter {

    @Override
    protected boolean shouldNotFilter(HttpServletRequest req) {
        return !req.getRequestURI().startsWith("/internal/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        long ms;
        try {
            ms = Long.parseLong(String.valueOf(req.getHeader(Deadline.HEADER)));
        } catch (NumberFormatException none) {
            chain.doFilter(req, res);
            return;
        }
        try (Deadline.Scope ignored = Deadline.open(Duration.ofMillis(Math.max(0, ms)))) {
            chain.doFilter(req, res);
        }
    }
}
```

**`src/main/java/com/example/shop/inventory/internal/remote/RemoteInventoryApi.java`**（6.4～6.7）

```diff
 import com.example.shop.shared.config.ShopProperties;
 import com.example.shop.shared.error.ProblemType;
 import com.example.shop.shared.error.ShopException;
+import com.example.shop.shared.resilience.Deadline;
+import com.example.shop.shared.resilience.RetryBudget;
 import com.example.shop.shared.security.ServiceTokens;
 import com.fasterxml.jackson.databind.JsonNode;
 import com.fasterxml.jackson.databind.ObjectMapper;
+import io.github.resilience4j.bulkhead.Bulkhead;
+import io.github.resilience4j.bulkhead.BulkheadConfig;
+import io.github.resilience4j.bulkhead.BulkheadRegistry;
+import io.github.resilience4j.circuitbreaker.CircuitBreaker;
+import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
+import io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry;
+import io.github.resilience4j.micrometer.tagged.TaggedBulkheadMetrics;
+import io.github.resilience4j.micrometer.tagged.TaggedCircuitBreakerMetrics;
 import io.micrometer.core.instrument.Counter;
 import io.micrometer.core.instrument.MeterRegistry;
 import org.slf4j.Logger;
 import org.slf4j.LoggerFactory;
 import org.springframework.context.annotation.Primary;
+import org.springframework.http.client.ClientHttpRequestFactory;
 import org.springframework.http.client.JdkClientHttpRequestFactory;
 import org.springframework.stereotype.Component;
 import org.springframework.web.client.ResourceAccessException;
…
 import org.springframework.web.service.invoker.HttpServiceProxyFactory;
 
 import java.net.http.HttpClient;
+import java.time.Duration;
 import java.time.Instant;
 import java.util.ArrayList;
 import java.util.Collection;
…
 import java.util.Map;
 import java.util.Set;
 import java.util.UUID;
+import java.util.concurrent.TimeUnit;
 import java.util.function.Supplier;
 
 /**
…
  *
  *   ① 錯誤翻譯回同一個例外。只有三種業務錯誤原樣交給使用者：庫存不足（409）、狀態不對（409）、暫時不能用（503）。
  *      其他的 —— 401、403（服務的 token 設錯了）、404（呼叫了一支對方還沒有的端點）、400、422 —— 是「我們」的錯，不是使用者的：500。
- *   ② 沒有回應（連不上、等不到）→ 再送一次，用同一個冪等鍵。只送一次：重試的次數與間隔、跟熔斷怎麼配，是第 06 章的事。
- *      兩次都沒有回應 → 503，請使用者稍後再試。
+ *   ② 沒有回應（連不上、等不到）→ 再送一次，用同一個冪等鍵。兩次都沒有回應 → 503，請使用者稍後再試。
+ *      第 06 章：再送之前要過三關 —— 剩下的預算還夠一次、重試預算還有、熔斷器沒有打開；每一次送出也先過隔艙（call() 上面的說明）
  *   ③ 空的清單不送。在一個行程裡，gateHot(空清單) 是一個什麼都不做的方法呼叫；在這裡，它是一次網路往返（3.4.3：第 02 章每一張訂單都送了）。
  *   ④ 每一次請求帶一個服務的 token（ServiceTokens，3.6）。
  */
…
     static final Set<ProblemType> PASS_THROUGH = Set.of(ProblemType.INSUFFICIENT_STOCK, ProblemType.INVALID_STATE, ProblemType.TEMPORARILY_UNAVAILABLE);
     private static final Set<String> STANDARD = Set.of("type", "title", "status", "detail", "instance", "traceId");
 
+    /** 13 站 6.6：下單路徑上的呼叫，用自己的隔艙 —— 對帳、補貨、重建副本塞滿了，下單照樣有位子（反過來也是） */
+    static final Set<String> ORDER_PATH = Set.of("reserve", "gate-hot", "return-hot");
+    /**
+     * 13 站 6.7.1：有熔斷器的呼叫。下單路徑上「往前走」的兩種，各一個：熱點閘門因為 Redis 掛了而一直 503，不能讓一般商品的預留也被擋掉
+     *（第 12 站 0.6.3：Redis 掛掉時一般商品照樣能下單）。還回閘門（return-hot）、釋放預留這些補償不經過熔斷器：它們是回到一致的那一條路
+     */
+    static final Set<String> BROKEN = Set.of("reserve", "gate-hot");
+    /** 剩下的預算不到這麼多，就不送了（6.4）：一次幾十毫秒的送出，給它 100 ms 以下只是製造一個「不知道做了沒有」 */
+    static final Duration MIN_ATTEMPT = Duration.ofMillis(100);
+    /** 這一次送出最多等多久（call() 設、request factory 與攔截器讀） */
+    private static final ThreadLocal<Duration> ATTEMPT = new ThreadLocal<>();
+
     private final InventoryClient client;
     private final ObjectMapper json;
     private final MeterRegistry meters;
+    private final Duration readTimeout;
+    private final int maxAttempts;
+    private final long openSeconds;
+    private final RetryBudget retryBudget;
+    private final Bulkhead orderPath, others;
+    private final Map<String, CircuitBreaker> breakers = new HashMap<>();
 
     RemoteInventoryApi(RestClient.Builder builder, ShopProperties props, ServiceTokens tokens, ObjectMapper json, MeterRegistry meters) {
         ShopProperties.Remote r = props.deployment().inventory();
-        JdkClientHttpRequestFactory f = new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(r.connectTimeout()).build());
-        f.setReadTimeout(r.readTimeout());
-        RestClient rest = builder.baseUrl(r.url()).requestFactory(f)
+        HttpClient http = HttpClient.newBuilder().connectTimeout(r.connectTimeout()).build();
+        // 6.4：每一次送出有自己的 read timeout。JdkClientHttpRequestFactory 的逾時是整個 factory 一個值，所以每一次送出 new 一個 ——
+        // 它只是「這個 HttpClient + 這一次的逾時」；HttpClient（連線池）是同一個
+        ClientHttpRequestFactory perAttempt = (uri, method) -> {
+            JdkClientHttpRequestFactory f = new JdkClientHttpRequestFactory(http);
+            f.setReadTimeout(ATTEMPT.get() == null ? r.readTimeout() : ATTEMPT.get());
+            return f.createRequest(uri, method);
+        };
+        RestClient rest = builder.baseUrl(r.url()).requestFactory(perAttempt)
                 .requestInterceptor((req, body, exec) -> {
                     req.getHeaders().setBearerAuth(tokens.tokenFor(ServiceRole.INVENTORY_SERVICE));
+                    Duration wait = ATTEMPT.get();                          // 6.4.3：告訴庫存服務這一次我等多久
+                    if (wait != null) req.getHeaders().set(Deadline.HEADER, Long.toString(wait.toMillis()));
                     return exec.execute(req, body);
                 })
                 .build();
         this.client = HttpServiceProxyFactory.builderFor(RestClientAdapter.create(rest)).build().createClient(InventoryClient.class);
         this.json = json;
         this.meters = meters;
+        this.readTimeout = r.readTimeout();
+        this.maxAttempts = r.maxAttempts();
+        this.retryBudget = new RetryBudget(r.retryRatio(), r.minRetries());
+
+        BulkheadRegistry bulkheads = BulkheadRegistry.ofDefaults();
+        this.orderPath = bulkheads.bulkhead("inventory-order-path", BulkheadConfig.custom()
+                .maxConcurrentCalls(r.bulkhead().orderPath()).maxWaitDuration(Duration.ZERO).build());   // 滿了不等：等也是佔著一條執行緒
+        this.others = bulkheads.bulkhead("inventory-others", BulkheadConfig.custom()
+                .maxConcurrentCalls(r.bulkhead().others()).maxWaitDuration(Duration.ZERO).build());
+        ShopProperties.Breaker b = r.breaker();
+        this.openSeconds = Math.max(1, b.openFor().toSeconds());
+        CircuitBreakerRegistry registry = CircuitBreakerRegistry.of(CircuitBreakerConfig.custom()
+                .slidingWindowType(CircuitBreakerConfig.SlidingWindowType.TIME_BASED).slidingWindowSize((int) b.window().toSeconds())
+                .minimumNumberOfCalls(b.minimumCalls()).failureRateThreshold(b.failureRate())
+                .waitDurationInOpenState(b.openFor()).permittedNumberOfCallsInHalfOpenState(b.halfOpenCalls())
+                .build());
+        for (String op : BROKEN) {
+            CircuitBreaker cb = registry.circuitBreaker("inventory-" + op);
+            cb.getEventPublisher().onStateTransition(e -> log.warn("INVENTORY_BREAKER op={} {}", op, e.getStateTransition()));
+            breakers.put(op, cb);
+        }
+        // resilience4j_circuitbreaker_state、resilience4j_bulkhead_available_concurrent_calls……
+        // 05-service/06 的 6.7.1：OPEN 是「被呼叫時」才轉成 HALF_OPEN —— 沒有人下單的時候，儀表板上的 OPEN 不代表庫存服務還壞著
+        TaggedCircuitBreakerMetrics.ofCircuitBreakerRegistry(registry).bindTo(meters);
+        TaggedBulkheadMetrics.ofBulkheadRegistry(bulkheads).bindTo(meters);
     }
 
     // ───────── 寫 ─────────
…
         call("reserve", () -> client.reserve(orderId, new ReserveRequest(lines, hotLines)));
     }
 
+    /**
+     * 13 站 6.7.5：預留的熔斷器開著 → 503。要用 tryAcquirePermission()、再還回去，不能只看 getState()：
+     * OPEN 是「被要求放行時」才轉成 HALF_OPEN（05-service/06 的 6.7.1）—— 只看狀態、從來不要求放行，它就永遠開著
+     */
+    @Override
+    public void ensureReservable() {
+        CircuitBreaker cb = breakers.get("reserve");
+        if (cb.tryAcquirePermission()) {
+            cb.releasePermission();
+            return;
+        }
+        rejected("reserve", "breaker");
+        throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", openSeconds);
+    }
+
     // 13 站 4.6：confirm、release、consume 不在 InventoryApi 上了（庫存服務自己收 order.paid、order.cancelled、order.shipped）
 
     /** 13 站 4.6.3：只讀。503（還在落帳）、409（即將取消）照原樣交給賣家 */
…
         return out;
     }
 
-    // ───────── 呼叫：重送一次、翻譯錯誤 ─────────
+    // ───────── 呼叫：隔艙、熔斷、預算、重送一次、翻譯錯誤 ─────────
 
     private void run(String op, Runnable r) {
         call(op, () -> { r.run(); return null; });
     }
 
+    /**
+     * 13 站 6.4～6.7：一次呼叫。
+     *   ① 隔艙：同時在等庫存服務的請求有上限，滿了立刻 503 —— 不排隊（6.6）
+     *   ② 每一次送出之前：這一次最多等多久 = read timeout 與剩下的預算取小的；不到 MIN_ATTEMPT 就不送（6.4）
+     *   ③ 熔斷器（只有下單路徑上往前走的兩種：reserve、gate-hot）開著 → 立刻 503，Retry-After = 它要開多久（6.7）
+     *   ④ 沒有回應 → 再送一次，只在：還沒送滿 max-attempts、剩下的預算還夠一次、重試預算還有（6.5）
+     */
     private <T> T call(String op, Supplier<T> c) {
-        for (int attempt = 1; ; attempt++) {
-            try {
-                return c.get();
-            } catch (RestClientResponseException e) {                       // 對方回應了：照它說的
-                throw decode(op, e.getStatusCode().value(), e.getResponseBodyAsString());
-            } catch (ResourceAccessException e) {                           // 沒有回應：不知道它做了沒有 —— 每一支端點都可以重送（3.5）
-                Counter.builder("shop.remote.no_response").tag("service", "inventory").tag("op", op)
-                        .description("呼叫其他服務沒有得到回應（連不上、逾時）的次數（13 站 3.5）").register(meters).increment();
-                if (attempt < 2) {
-                    log.warn("INVENTORY_NO_RESPONSE op={} attempt={}，用同一個冪等鍵再送一次：{}", op, attempt, e.getMessage());
-                    continue;
+        Bulkhead bulkhead = ORDER_PATH.contains(op) ? orderPath : others;
+        if (!bulkhead.tryAcquirePermission()) {
+            rejected(op, "bulkhead");
+            throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務忙碌中，請稍後再試").with("retryAfter", 1);
+        }
+        try {
+            CircuitBreaker breaker = breakers.get(op);
+            retryBudget.sent();
+            for (int attempt = 1; ; attempt++) {
+                Duration timeout = attemptTimeout();
+                if (timeout == null) {
+                    rejected(op, "budget");
+                    throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "這一次的時間已經用完，請再送一次").with("retryAfter", 1);
+                }
+                if (breaker != null && !breaker.tryAcquirePermission()) {
+                    rejected(op, "breaker");
+                    throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", openSeconds);
+                }
+                long t0 = System.nanoTime();
+                ATTEMPT.set(timeout);
+                try {
+                    T result = c.get();
+                    if (breaker != null) breaker.onSuccess(System.nanoTime() - t0, TimeUnit.NANOSECONDS);
+                    return result;
+                } catch (RestClientResponseException e) {                   // 對方回應了：照它說的
+                    if (breaker != null) {                                  // 5xx 算失敗；4xx 是業務的結果（庫存不足、狀態不對），不算（05-service/06 的 6.7.6）
+                        if (e.getStatusCode().is5xxServerError()) breaker.onError(System.nanoTime() - t0, TimeUnit.NANOSECONDS, e);
+                        else breaker.onSuccess(System.nanoTime() - t0, TimeUnit.NANOSECONDS);
+                    }
+                    throw decode(op, e.getStatusCode().value(), e.getResponseBodyAsString());
+                } catch (ResourceAccessException e) {                       // 沒有回應：不知道它做了沒有 —— 每一支端點都可以重送（3.5）
+                    if (breaker != null) breaker.onError(System.nanoTime() - t0, TimeUnit.NANOSECONDS, e);
+                    Counter.builder("shop.remote.no_response").tag("service", "inventory").tag("op", op)
+                            .description("呼叫其他服務沒有得到回應（連不上、逾時）的次數（13 站 3.5）").register(meters).increment();
+                    if (attempt < maxAttempts && attemptTimeout() != null && retryBudget.tryRetry()) {
+                        log.warn("INVENTORY_NO_RESPONSE op={} attempt={}，用同一個冪等鍵再送一次：{}", op, attempt, e.getMessage());
+                        continue;
+                    }
+                    log.error("INVENTORY_UNAVAILABLE op={}：送了 {} 次都沒有回應：{}", op, attempt, e.getMessage());
+                    throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", 1);
+                } catch (RuntimeException e) {                              // 其他（解不開回應……）：我們的錯，不是庫存服務的
+                    if (breaker != null) breaker.releasePermission();
+                    throw e;
+                } finally {
+                    ATTEMPT.remove();
                 }
-                log.error("INVENTORY_UNAVAILABLE op={}：送了 {} 次都沒有回應：{}", op, attempt, e.getMessage());
-                throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", 1);
             }
+        } finally {
+            bulkhead.onComplete();
         }
     }
 
+    /** 這一次最多等多久：read timeout 與剩下的預算取小的；剩下的不到 MIN_ATTEMPT → null（不送） */
+    private Duration attemptTimeout() {
+        Duration left = Deadline.remaining();
+        if (left == null) return readTimeout;
+        if (left.compareTo(MIN_ATTEMPT) < 0) return null;
+        return left.compareTo(readTimeout) < 0 ? left : readTimeout;
+    }
+
+    private void rejected(String op, String by) {
+        Counter.builder("shop.remote.rejected").tag("service", "inventory").tag("op", op).tag("by", by)
+                .description("沒有送出去就失敗的呼叫：隔艙滿了、熔斷器開著、預算用完（13 站 6.6、6.7、6.4）").register(meters).increment();
+    }
+
     /** 庫存服務的 Problem Details → 呼叫端在一個行程裡會拿到的同一個例外 */
     RuntimeException decode(String op, int status, String body) {
         try {
```

**`src/main/java/com/example/shop/shared/config/ShopProperties.java`**（6.4～6.7）

```diff
                              @Valid @NotNull @DefaultValue Inventory inventory, @Valid @NotNull @DefaultValue RateLimit rateLimit,
                              @Valid @NotNull @DefaultValue Messaging messaging, @Valid @NotNull @DefaultValue Deployment deployment) {
 
+    /** 13 站 6.4：逾時由外而內遞減 —— 下單的預算裡，至少要放得下一次完整的送出（不然切開的訂單服務每一張都是 503） */
+    @jakarta.validation.constraints.AssertTrue(message = "shop.order.placement-budget 必須大於 shop.deployment.inventory.read-timeout（13 站 6.4）")
+    public boolean isPlacementBudgetAboveReadTimeout() {
+        return order == null || deployment == null || order.placementBudget() == null
+                || order.placementBudget().compareTo(deployment.inventory().readTimeout()) > 0;
+    }
+
     /**
      * 13 站第 03 章：同一個 jar，哪一種部署（3.7）；切開的時候，訂單服務去哪裡找庫存服務（3.4），服務之間怎麼證明自己是誰（3.6）。
      * 預設 monolith —— 第 12 站的單體，下面其他的設定都用不到。
…
         }
     }
 
-    /** 另一個服務：在哪裡、等多久（3.4）。逾時預算（由外而內遞減）是第 06 章的事，這裡先給每一次呼叫一個上限 */
+    /**
+     * 另一個服務：在哪裡、等多久（3.4）、它出事的時候怎麼保護自己（第 06 章）。
+     * 這裡是「每一次送出」的上限；一個請求還剩多少時間（逾時預算）要到呼叫的那一刻才知道（shared.resilience.Deadline，6.4）
+     */
     public record Remote(
             String url,
             @NotNull @DefaultValue("1s") @DurationMin(millis = 100) Duration connectTimeout,
-            @NotNull @DefaultValue("3s") @DurationMin(millis = 100) Duration readTimeout) {}
+            /** 6.4.2：正常的時候，一整張下單的 p99 在一百毫秒以內（6.2 的「正常」那一段）。第 03 章的 3 秒：庫存服務慢 3 秒的時候，每一張都等滿 6 秒才失敗 */
+            @NotNull @DefaultValue("1s") @DurationMin(millis = 100) Duration readTimeout,
+            /** 6.5：一次呼叫最多送幾次（含第一次）。第二次只在「沒有回應」、剩下的預算還夠、重試預算還有的時候送 */
+            @DefaultValue("2") @Min(1) @jakarta.validation.constraints.Max(3) int maxAttempts,
+            /** 6.5.2 重試預算：最近 10 秒裡，重送最多是第一次送出的幾倍；另外每 10 秒至少給幾次（量少的時候不受影響） */
+            @DefaultValue("0.1") @jakarta.validation.constraints.DecimalMin("0") @jakarta.validation.constraints.DecimalMax("1") double retryRatio,
+            @DefaultValue("10") @Min(0) int minRetries,
+            @Valid @NotNull @DefaultValue Bulkheads bulkhead,
+            @Valid @NotNull @DefaultValue Breaker breaker) {}
+
+    /** 6.6 隔艙：同時最多幾個請求在等這個服務。下單路徑（預留、熱點閘門、還回閘門）一份，其他的一份；滿了立刻 503，不排隊 */
+    public record Bulkheads(
+            @DefaultValue("20") @Min(1) int orderPath,
+            @DefaultValue("10") @Min(1) int others) {}
+
+    /**
+     * 6.7 熔斷器（預留、熱點閘門各一個）：window 之內至少 minimumCalls 次、失敗（沒有回應、5xx）佔 failureRate % 以上 → 打開 openFor，
+     * 這段時間裡不送、立刻 503（Retry-After = openFor）；之後放 halfOpenCalls 個試探，都成功才關上
+     */
+    public record Breaker(
+            @DefaultValue("50") @Min(1) @jakarta.validation.constraints.Max(100) int failureRate,
+            @DefaultValue("20") @Min(1) int minimumCalls,
+            @NotNull @DefaultValue("10s") @DurationMin(seconds = 1) Duration window,
+            @NotNull @DefaultValue("5s") @DurationMin(seconds = 1) Duration openFor,
+            @DefaultValue("3") @Min(1) int halfOpenCalls) {}
 
     /** 3.6：服務之間的 token（HS256）。ttl：一個 token 用多久；呼叫端在到期前 1 分鐘換新的 */
     public record ServiceToken(
…
             @NotNull @DefaultValue("5m") @DurationMin(seconds = 1) Duration reservationGrace,
             /**
              * 13 站 4.5：訂單停在 RESERVING（下單的 Saga 走到一半）超過這麼久，排程就補償它（REJECTED）。
-             * 要比一次下單最久會花的時間長得多：兩次預留各等一個 read timeout（3.5.4），加上鎖等待
+             * 要比一次下單最久會花的時間長得多：兩次預留各等一個 read timeout（3.5.4），加上鎖等待（第 06 章之後：等庫存服務的部分以 placement-budget 為上限）
+             */
+            @NotNull @DefaultValue("60s") @DurationMin(seconds = 1) Duration placementTimeout,
+            /**
+             * 13 站 6.4：一次下單最多花多久等其他服務（熱點閘門、預留，含重送）。用完了 → 503，請買家用同一個鍵再送（訂單留在 RESERVING，
+             * 重送接著做這一張）。0.6.2 的 SLO 是 p99 300 ms；這是「放棄」的那一條線，不是目標
              */
-            @NotNull @DefaultValue("60s") @DurationMin(seconds = 1) Duration placementTimeout) {}
+            @NotNull @DefaultValue("2s") @DurationMin(millis = 200) Duration placementBudget) {
+
+        /** 6.4：排程補償 RESERVING 的門檻，要遠大於一次下單最久會等的時間 —— 不然排程會補償一張還在下的訂單 */
+        @jakarta.validation.constraints.AssertTrue(message = "shop.order.placement-timeout 至少要是 placement-budget 的 10 倍（13 站 6.4）")
+        public boolean isPlacementTimeoutFarAboveBudget() {
+            return placementTimeout == null || placementBudget == null || placementTimeout.compareTo(placementBudget.multipliedBy(10)) >= 0;
+        }
+    }
 
     /** US-ORD-2 AC-3：金流回呼的 HMAC-SHA256 金鑰 */
     public record Payment(
```

**`src/main/java/com/example/shop/ordering/internal/PlaceOrderService.java`**（6.4.3、6.7.5）

```diff
 import com.example.shop.shared.error.ConstraintViolations;
 import com.example.shop.shared.error.ProblemType;
 import com.example.shop.shared.error.ShopException;
+import com.example.shop.shared.resilience.Deadline;
 import org.springframework.dao.DataIntegrityViolationException;
 import org.springframework.stereotype.Service;
 import org.springframework.transaction.PlatformTransactionManager;
…
     private final OrderTransitionService transitions;
     private final TransactionTemplate tx;
     private final Clock clock;
-    private final Duration paymentTimeout;
+    private final Duration paymentTimeout, budget;
 
     PlaceOrderService(CatalogApi catalog, InventoryApi inventory, OrderRepository orders, OrderHistory history, IdempotencyKeys keys,
                       OrderTransitionService transitions, PlatformTransactionManager tm, Clock clock, ShopProperties props,
…
         this.tx = new TransactionTemplate(tm);
         this.clock = clock;
         this.paymentTimeout = props.order().paymentTimeout();
+        this.budget = props.order().placementBudget();
         this.placed = meters.counter("shop.orders.placed");
         this.insufficient = meters.counter("shop.inventory.insufficient");
         this.collisions = meters.counter("shop.orders.number_collisions");
…
     @Override
     public PlacedOrder placeOrder(long buyerId, String idempotencyKey, List<OrderLine> lines) {
         try {
-            return placeOrderGated(buyerId, idempotencyKey, lines);
+            // 13 站 6.4：這一次下單等其他服務的預算（熱點閘門、預留，含重送）。單體裡沒有遠端呼叫，期限放著沒有人讀
+            return Deadline.within(budget, () -> placeOrderGated(buyerId, idempotencyKey, lines));
         } catch (InsufficientStockException e) {
             // 9.9：0.6.6「依 productId 前 N 名」。productId 不當指標的 tag（J7：1 萬個商品 = 1 萬條序列、每次 scrape 600 KB），寫進日誌，前 N 名從日誌查
             insufficient.increment();
…
             // 放在交易裡也擋不住「讀完之後賣家改價」，只是讓交易多開一段；切開之後，這一段是一次遠端呼叫。
             // 放在冪等鍵之後：重送（Existing）不需要快照，也不該因為價格變了而失敗
             Map<Long, ProductSnapshot> products = checkedSnapshots(lines);
+            // 13 站 6.7.5：預留一定會被擋下來（熔斷器開著）→ 不寫這張訂單。也放在冪等鍵之後：已經成立的訂單重送，照樣回 200
+            inventory.ensureReservable();
             for (int attempt = 1; ; attempt++) {
                 try {
                     return tx.execute(s -> insertReserving(buyerId, key, lines, hotIds, products));
```

**`src/main/java/com/example/shop/inventory/internal/JdbcInventoryService.java`**（6.4.3）

```diff
 import com.example.shop.shared.events.Inbox;
 import com.example.shop.shared.events.Outbox;
 import com.example.shop.shared.redis.RedisGuard;
+import com.example.shop.shared.resilience.Deadline;
 import io.micrometer.core.instrument.Counter;
 import io.micrometer.core.instrument.MeterRegistry;
 import org.slf4j.Logger;
…
     private final RedisGuard guard;
     private final Outbox outbox;
     private final Inbox inbox;
-    private final Counter shortages, consumeConflicts;
+    private final Counter shortages, consumeConflicts, budgetExpired;
     /** 6.9.2 Redis 不能用的時候，可售量在本機記憶體裡放 5 秒（AC-4 允許的延遲）：不然每一次看商品頁都是一句 MySQL */
     private final java.util.concurrent.ConcurrentHashMap<Long, long[]> degradedAvailable = new java.util.concurrent.ConcurrentHashMap<>();
 
…
                 .description("熱點落帳時 MySQL 不夠（Redis 的閘門放進了不存在的庫存）→ 訂單會被取消。正常應該永遠是 0").register(meters);
         this.consumeConflicts = Counter.builder("shop.inventory.consume.conflict")
                 .description("13 站 4.6.3：訂單已經出貨，它的預留卻已經釋放（熱點落帳失敗比出貨晚到）。正常應該永遠是 0，發生了要有人看").register(meters);
+        this.budgetExpired = Counter.builder("shop.inventory.budget.expired")
+                .description("13 站 6.4.3：借到連線的時候，呼叫端的預算已經用完 —— 沒有做的預留。不是 0 就是庫存服務在排隊").register(meters);
     }
 
     @Override
…
         reserveIdempotently(orderId, lines, hotLines);
     }
 
-    /** 同 reserve()，多回傳「這一次是不是重送」—— 庫存服務的 PUT /reservations 要用它回 Idempotent-Replayed（3.5.2） */
+    /**
+     * 同 reserve()，多回傳「這一次是不是重送」—— 庫存服務的 PUT /reservations 要用它回 Idempotent-Replayed（3.5.2）。
+     * 13 站 6.4.3：交易開始的時候連線已經借到了（JpaTransactionManager 在 begin 就拿連線、關掉 autocommit）。
+     * 在連線池裡排隊的那一段，可能已經把呼叫端的預算用完：用完了就不做 —— 呼叫端早就走了，做完也沒有人收（6.3 ② 的「早就放棄的」）
+     */
     @Transactional
     public boolean reserveOnce(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
+        if (Deadline.expired()) {
+            budgetExpired.increment();
+            Deadline.check("預留");
+        }
         return reserveIdempotently(orderId, lines, hotLines);
     }
 
```

**`src/main/java/com/example/shop/inventory/InventoryApi.java`**（6.7.5）

```diff
      */
     void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines);
 
+    /**
+     * 13 站 6.7.5：現在預留，會不會一送出去就被擋下來（切開的部署：預留的熔斷器開著）？會 → 丟 503（帶 Retry-After）。
+     * 下單在寫訂單（T1）之前先問一次：熔斷器開著的時候，不要先寫一張 RESERVING 的訂單、再讓排程在 60 秒後補償它。
+     * 單體裡沒有遠端呼叫，什麼都不做
+     */
+    default void ensureReservable() {}
+
     // 13 站 4.6：confirm、release、consume 從這個介面拿掉了。付款、取消、出貨之後，庫存模組收 order.paid、order.cancelled、order.shipped，
     // 自己在自己的交易裡做（InventoryEventHandlers.orderEvents）—— 沒有別的模組會再呼叫它們
 
```

**`pom.xml`**（6.6、6.7）

```diff
     <testcontainers.version>1.21.4</testcontainers.version>
     <!-- 13 站 3.8：契約測試 -->
     <pact.version>4.6.17</pact.version>
+    <!-- 13 站 6.6、6.7：隔艙與熔斷（05-service/06 用的同一套）。Boot 3.2.5 不管理它的版本 -->
+    <resilience4j.version>2.2.0</resilience4j.version>
   </properties>
   <dependencies>
     <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
…
     <dependency><groupId>org.mybatis.spring.boot</groupId><artifactId>mybatis-spring-boot-starter</artifactId><version>3.0.3</version></dependency>
     <dependency><groupId>org.springdoc</groupId><artifactId>springdoc-openapi-starter-webmvc-ui</artifactId><version>2.5.0</version></dependency>
     <dependency><groupId>com.mysql</groupId><artifactId>mysql-connector-j</artifactId><scope>runtime</scope></dependency>
+    <!-- 13 站 6.6、6.7：只用核心模組，在呼叫的地方直接用（RemoteInventoryApi），不用註解與 AOP（05-service/06 的 6.7.3：註解的順序不是你寫的那個順序） -->
+    <dependency><groupId>io.github.resilience4j</groupId><artifactId>resilience4j-circuitbreaker</artifactId><version>${resilience4j.version}</version></dependency>
+    <dependency><groupId>io.github.resilience4j</groupId><artifactId>resilience4j-bulkhead</artifactId><version>${resilience4j.version}</version></dependency>
+    <dependency><groupId>io.github.resilience4j</groupId><artifactId>resilience4j-micrometer</artifactId><version>${resilience4j.version}</version></dependency>
     <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-configuration-processor</artifactId><optional>true</optional></dependency>
     <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency>
     <dependency><groupId>org.springframework.security</groupId><artifactId>spring-security-test</artifactId><scope>test</scope></dependency>
```

**`src/test/java/com/example/shop/dist06/G1CascadeTest.java`**（6.2、6.10.2）

```java
package com.example.shop.dist06;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.CallTap;
import com.example.shop.dist03.LostResponse;
import com.example.shop.dist03.Roles;
import com.example.shop.dist04.Nodes;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * 13 站 6.2：第 04 章 4.10.7 的 K3 —— 庫存服務的預留慢 3 秒 —— 用「正式的」逾時重跑。
 * K3 照第 00 章讓訂單服務等 10 秒；正式的設定（ShopProperties.Remote）是 read timeout 3 秒、沒有回應再送一次（第 03 章 3.5）。
 * 兩種速率：每秒 20 張（K3 的速率）、每秒 40 張。每一段 20 秒：正常 → 預留慢 3 秒 → 恢復。
 * 每 200 ms 打一次商品詳情（第 05 章之後讀副本，不問庫存服務）與我的訂單；每秒記一次訂單服務的 Tomcat 工作執行緒、
 * 還沒回應的下單、這一秒送給庫存服務的預留（第 03 章的 CallTap 在呼叫端數）。
 *
 *   mvn test -Pexperiments -Dtest=G1CascadeTest
 */
@Tag("experiment")
class G1CascadeTest {

    static final long PROBE_BUYER = 6_424_242;
    final PrintStream out = System.out;

    @Test
    void slowInventoryWithRealTimeouts() throws Exception {
        Split.freshDatabases();
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        LostResponse.reset();
        ConfigurableApplicationContext inv = Roles.inventoryService(List.of("--lab.d03.lost-response=true"));
        try (ConfigurableApplicationContext order = Roles.orderService(inv, List.of("--lab.d03.call-tap=true",
                "--logging.level.com.example.shop.inventory.internal.remote=OFF"))) {   // 每一次逾時一行 WARN：幾千行
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            HttpResponse<String> rebuilt = send(order, "POST", "/api/admin/stock-levels/rebuild", TestTokens.bearer(order, 1, Role.ADMIN));
            if (rebuilt.statusCode() != 200) throw new IllegalStateException("重建副本 " + rebuilt.statusCode() + " " + rebuilt.body());
            for (int i = 0; i < 300; i++) Rig.place(order, Rig.BUYERS.incrementAndGet(), new long[]{SplitLab.FIRST_PRODUCT + i % 1000}, java.util.UUID.randomUUID().toString());
            for (int i = 0; i < 5; i++) Rig.place(order, PROBE_BUYER, new long[]{SplitLab.FIRST_PRODUCT + 500 + i}, java.util.UUID.randomUUID().toString());
            ShopProperties props = order.getBean(ShopProperties.class);
            var remote = props.deployment().inventory();
            out.printf("═══ 6.2 庫存服務的預留慢 3 秒，訂單服務用正式的設定（connect %d ms、read %d ms、最多送 %d 次；下單的預算 %d ms；"
                            + "下單路徑的隔艙 %d；熔斷 %d 秒內至少 %d 次、失敗 %d%% → 開 %d 秒）═══%n",
                    remote.connectTimeout().toMillis(), remote.readTimeout().toMillis(), remote.maxAttempts(), props.order().placementBudget().toMillis(),
                    remote.bulkhead().orderPath(), remote.breaker().window().toSeconds(), remote.breaker().minimumCalls(), remote.breaker().failureRate(),
                    remote.breaker().openFor().toSeconds());
            for (String r : System.getProperty("g1.rates", "20,40").split(",")) run(order, Integer.parseInt(r));
        } finally {
            if (inv.isActive()) inv.close();
            LostResponse.reset();
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    void run(ConfigurableApplicationContext order, int rate) throws Exception {
        out.printf("═══ 每秒 %d 張下單（load %s）═══%n", rate, SplitLab.load());
        CallTap.CALLS.clear();
        MeterRegistry meters = order.getBean(MeterRegistry.class);
        List<String> phases = List.of("正常", "慢 3 秒", "恢復");
        List<String> perSecond = new ArrayList<>();
        long[] puts = new long[phases.size()];
        long reservesBefore = 0;
        long firstOrder = SplitLab.count(Split.ORDER_DB, "SELECT COALESCE(MAX(id), 0) FROM orders");
        double noResponseBefore = noResponse(meters);
        Rig rig = new Rig(order);
        try (rig) {
            rig.orders(rate, 1).probes(PROBE_BUYER);
            for (int p = 0; p < phases.size(); p++) {
                if (phases.get(p).equals("慢 3 秒")) LostResponse.arm("PUT", "/reservations/", 3_000, Integer.MAX_VALUE);
                if (phases.get(p).equals("恢復")) LostResponse.reset();
                for (int s = 0; s < 20; s++) {
                    Thread.sleep(1_000);
                    long reserves = CallTap.CALLS.stream().filter(c -> c.method().equals("PUT") && c.path().startsWith("/internal/inventory/v1/reservations/")).count();
                    puts[p] += reserves - reservesBefore;
                    perSecond.add(String.format("%3d 秒 %-5s │ %s │ 還沒回應的下單 %3d │ 這一秒送給庫存服務的預留 %3d │ %s%s", rig.now() / 1000, phases.get(p),
                            Rig.tomcat(order), rig.inFlight.get(), reserves - reservesBefore, Rig.hikari(order), Rig.guards(order)));
                    reservesBefore = reserves;
                }
            }
        }
        for (int p = 0; p < phases.size(); p++) {
            long from = p * 20_000L, to = from + 20_000L;
            for (String what : new String[]{"order", "detail", "myorders"}) out.println(rig.summary(phases.get(p), what, from, to));
        }
        for (int p = 0; p < phases.size(); p++) {
            long from = p * 20_000L, to = from + 20_000L;
            long intents = rig.done.stream().filter(d -> d.atMs() >= from && d.atMs() < to).count();
            out.printf("  %-6s │ 下單 %4d 張 │ 送給庫存服務的預留 %4d 次（這一段的 20 秒裡）%n", phases.get(p), intents, puts[p]);
        }
        out.printf("  訂單服務記到的「沒有回應」%.0f 次%n", noResponse(meters) - noResponseBefore);
        out.println("  每秒：");
        for (String line : perSecond) out.println("    " + line);
        out.printf("  這一輪的訂單，狀態：%s%n", Rig.one(Split.ORDER_DB, "SELECT CONCAT('{', GROUP_CONCAT(CONCAT(status, '=', n) ORDER BY status), '}') FROM "
                + "(SELECT status, COUNT(*) AS n FROM orders WHERE id > " + firstOrder + " GROUP BY status) x"));
        out.printf("  其中卡在 RESERVING 的，庫存服務那一邊有預留的：%s 張%n", Rig.one(Split.INV_DB, "SELECT COUNT(DISTINCT r.order_id) FROM inventory_reservations r JOIN "
                + Split.ORDER_DB + ".orders o ON o.id = r.order_id WHERE o.status = 'RESERVING' AND o.id > " + firstOrder + " AND r.status = 'HELD'"));
    }

    static double noResponse(MeterRegistry m) {
        return m.find("shop.remote.no_response").counters().stream().mapToDouble(c -> c.count()).sum();
    }

    static HttpResponse<String> send(ConfigurableApplicationContext ctx, String method, String path, String token) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + SplitLab.port(ctx) + path)).timeout(Duration.ofSeconds(60))
                .method(method, HttpRequest.BodyPublishers.noBody());
        if (token != null) b.header("Authorization", token);
        return SplitLab.CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }
}
```

**`src/test/java/com/example/shop/dist06/G2RetryStormTest.java`**（6.3、6.10.3）

```java
package com.example.shop.dist06;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.DbTap;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.CallTap;
import com.example.shop.dist03.LostResponse;
import com.example.shop.dist03.Roles;
import com.example.shop.dist04.Nodes;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/**
 * 13 站 6.3：重試風暴。這條線上會重送的有兩層：買家的 app（503 或沒有回應 → 照 Retry-After 等一下、用同一個冪等鍵再送），
 * 訂單服務打庫存服務（沒有回應 → 再送一次，第 03 章 3.5）。
 *
 *   ① 乘法：庫存服務的預留 7 秒才回應（比訂單服務的 read timeout 3 秒長）。每秒 2 張、10 秒，app 送 1 次 vs 最多 3 次。
 *      在三個地方數：app 送了幾次、訂單服務送了幾次（CallTap）、庫存服務處理了幾次（ServerTap）。
 *   ② 回不來：庫存服務的連線池縮成 4 條、每一個預留交易多 100 ms（SlowDb）—— 每秒最多約 40 個預留。
 *      中間 10 秒資料庫再慢一點（每個預留交易 1 秒），然後回到 100 ms，再看 40 秒。觸發的原因只有那 10 秒；之後的 40 秒，系統回不回得來。
 *      三種：每秒 10 張（用掉四分之一）app 送 1 次；每秒 25 張（六成）app 送 1 次；每秒 25 張 app 最多送 3 次。
 *   ③ 第 06 章的程式碼上，再跑一次每秒 25 張的兩種，熔斷器關掉（6.10.3：哪一樣讓它回得來）。
 *
 *   mvn test -Pexperiments -Dtest=G2RetryStormTest
 *   參數（調實驗用）：-Dg2.skipMultiply=true -Dg2.skipAblation=true -Dg2.runs=10x1,25x1,25x3 -Dg2.pool=4 -Dg2.normalMs=100 -Dg2.slowMs=1000 -Dg2.trigger=10 -Dg2.after=40
 */
@Tag("experiment")
class G2RetryStormTest {

    final PrintStream out = System.out;
    final int pool = Integer.getInteger("g2.pool", 4);
    final long normalMs = Long.getLong("g2.normalMs", 100), slowMs = Long.getLong("g2.slowMs", 1000);
    final int trigger = Integer.getInteger("g2.trigger", 10), after = Integer.getInteger("g2.after", 40);

    @Test
    void retryStorm() throws Exception {
        Split.freshDatabases();
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        LostResponse.reset();
        SlowDb.sleepMs = 0;
        ConfigurableApplicationContext inv = Roles.inventoryService(List.of("--lab.d03.lost-response=true", "--lab.d06.server-tap=true",
                "--spring.datasource.url=" + SplitLab.url(Split.INV_DB) + "&queryInterceptors=" + DbTap.class.getName() + "," + SlowDb.class.getName(),
                "--spring.datasource.hikari.maximum-pool-size=" + pool));
        try {
            try (ConfigurableApplicationContext order = Roles.orderService(inv, List.of("--lab.d03.call-tap=true",
                    "--logging.level.com.example.shop.inventory.internal.remote=OFF"))) {
                SplitLab.seed(Split.ORDER_DB, true, false);
                SplitLab.seed(Split.INV_DB, false, true);
                if (G1CascadeTest.send(order, "POST", "/api/admin/stock-levels/rebuild", TestTokens.bearer(order, 1, Role.ADMIN)).statusCode() != 200)
                    throw new IllegalStateException("重建副本失敗");
                for (int i = 0; i < 300; i++) Rig.place(order, Rig.BUYERS.incrementAndGet(), new long[]{SplitLab.FIRST_PRODUCT + i % 1000}, UUID.randomUUID().toString());
                if (!Boolean.getBoolean("g2.skipMultiply")) {
                    multiply(order, 1);
                    multiply(order, 3);
                }
                ServerTap.callerWaitsMs = order.getBean(ShopProperties.class).deployment().inventory().readTimeout().toMillis();
                out.printf("═══ 6.3 ② 回不來：庫存服務的連線池 %d 條、每個預留交易 +%d ms；中間 %d 秒每個預留交易 +%d ms（load %s）═══%n",
                        pool, normalMs, trigger, slowMs, SplitLab.load());
                for (String run : System.getProperty("g2.runs", "10x1,25x1,25x3").split(",")) {
                    String[] rx = run.split("x");
                    storm(order, inv, Integer.parseInt(rx[0]), Integer.parseInt(rx[1]));
                }
            }
            // 13 站 6.10.3：哪一樣讓它回得來？同一個實驗，訂單服務的熔斷器「關掉」（至少 100 萬次才判斷 = 永遠不打開），其他照舊。
            // 第 06 章之前的程式碼沒有熔斷器、也沒有 shop.inventory.budget.expired：不跑這一段
            if (expired(inv) >= 0 && !Boolean.getBoolean("g2.skipAblation")) {
                try (ConfigurableApplicationContext order = Roles.orderService(inv, List.of("--lab.d03.call-tap=true",
                        "--logging.level.com.example.shop.inventory.internal.remote=OFF", "--shop.deployment.inventory.breaker.minimum-calls=1000000"))) {
                    for (int i = 0; i < 300; i++) Rig.place(order, Rig.BUYERS.incrementAndGet(), new long[]{SplitLab.FIRST_PRODUCT + i % 1000}, UUID.randomUUID().toString());
                    out.printf("═══ 6.10.3 同一個實驗，熔斷器關掉（minimum-calls 100 萬）；預算、重試預算、隔艙照舊（load %s）═══%n", SplitLab.load());
                    storm(order, inv, 25, 1);
                    storm(order, inv, 25, 3);
                }
            }
        } finally {
            if (inv.isActive()) inv.close();
            LostResponse.reset();
            SlowDb.sleepMs = 0;
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    // ───────── ① 乘法 ─────────

    void multiply(ConfigurableApplicationContext order, int appAttempts) throws Exception {
        if (appAttempts == 1) out.printf("═══ 6.3 ① 乘法：庫存服務的預留 7 秒才回應，每秒 2 張、10 秒（load %s）═══%n", SplitLab.load());
        LostResponse.reset();
        LostResponse.arm("PUT", "/reservations/", 7_000, Integer.MAX_VALUE);
        CallTap.CALLS.clear();
        ServerTap.reset();
        Rig rig = new Rig(order);
        try (rig) {
            rig.orders(2, appAttempts);
            Thread.sleep(10_000);
        }
        LostResponse.reset();
        Thread.sleep(8_000);                                                // 最後幾個被延後的回應送完
        long intents = rig.done.size();
        long appSent = rig.done.stream().mapToLong(Rig.Done::tries).sum();
        long orderSent = CallTap.CALLS.stream().filter(c -> c.method().equals("PUT") && c.path().startsWith("/internal/inventory/v1/reservations/")).count();
        long invHandled = ServerTap.HITS.size();
        long orders = ServerTap.HITS.stream().mapToLong(ServerTap.Hit::orderId).distinct().count();
        Map<Integer, Integer> codes = new TreeMap<>();
        rig.done.forEach(d -> codes.merge(d.status(), 1, Integer::sum));
        long[] took = rig.done.stream().mapToLong(Rig.Done::nanos).sorted().toArray();
        out.printf("  app 最多送 %d 次 │ 下單意圖 %d │ app 送出 %d 次 │ 訂單服務送給庫存服務 %d 次 │ 庫存服務處理了 %d 次（%d 張訂單，每一張 %.1f 次）│ 買家最後看到 %s │ 每一個意圖 p50 %.1f 秒%n",
                appAttempts, intents, appSent, orderSent, invHandled, orders, invHandled / (double) orders, codes, SplitLab.pct(took, 50) / 1000);
    }

    // ───────── ② 回不來 ─────────

    void storm(ConfigurableApplicationContext order, ConfigurableApplicationContext inv, int rate, int appAttempts) throws Exception {
        out.printf("═══ 每秒 %d 張下單，app 最多送 %d 次（load %s）═══%n", rate, appAttempts, SplitLab.load());
        SlowDb.sleepMs = normalMs;
        Thread.sleep(2_000);
        double expiredBefore = expired(inv);
        CallTap.CALLS.clear();
        ServerTap.reset();
        List<String> perSecond = new ArrayList<>();
        int total = 20 + trigger + after;
        Rig rig = new Rig(order);
        try (rig) {
            rig.orders(rate, appAttempts);
            for (int s = 1; s <= total; s++) {
                if (s == 21) SlowDb.sleepMs = slowMs;
                if (s == 21 + trigger) SlowDb.sleepMs = normalMs;
                Thread.sleep(1_000);
                long from = (s - 1) * 1000L, to = s * 1000L;
                long ok = rig.done.stream().filter(d -> d.status() == 201 && end(d) >= from && end(d) < to).count();
                long arrived = ServerTap.ARRIVED.stream().filter(t -> t >= from && t < to).count();
                long finished = ServerTap.HITS.stream().filter(h -> h.status() < 300 && h.outMs() >= from && h.outMs() < to).count();
                long wasted = ServerTap.HITS.stream().filter(h -> h.wasted() && h.outMs() >= from && h.outMs() < to).count();
                long busy = ServerTap.HITS.stream().filter(h -> h.status() == 503 && h.outMs() >= from && h.outMs() < to).count();
                String phase = s <= 20 ? "正常" : s <= 20 + trigger ? "觸發" : "之後";
                perSecond.add(String.format("%3d 秒 %s │ 這一秒成立的下單 %3d │ 庫存服務：進來 %3d、做完 %3d（呼叫端早就放棄的 %3d）、503 %3d │ %s │ 訂單服務 %s │ 還沒回應的下單 %3d%s",
                        s, phase, ok, arrived, finished, wasted, busy, Rig.hikari(inv), Rig.tomcat(order), rig.inFlight.get(), Rig.guards(order)));
            }
        }
        SlowDb.sleepMs = 0;
        String[] names = {"正常", "觸發", "之後"};
        long[][] spans = {{0, 20_000}, {20_000, (20 + trigger) * 1000L}, {(20 + trigger) * 1000L, total * 1000L}};
        for (int p = 0; p < 3; p++) out.println(rig.summary(names[p], "order", spans[p][0], spans[p][1]));
        for (int p = 0; p < 3; p++) {
            long from = spans[p][0], to = spans[p][1];
            List<ServerTap.Hit> in = ServerTap.HITS.stream().filter(h -> h.inMs() >= from && h.inMs() < to).toList();
            long intents = rig.done.stream().filter(d -> d.atMs() >= from && d.atMs() < to).count();
            long ok = in.stream().filter(h -> h.status() < 300).count();
            long wasted = in.stream().filter(ServerTap.Hit::wasted).count();
            out.printf("  %-4s │ 下單意圖 %4d │ 庫存服務收到預留 %4d 次（%.1f 倍）│ 做完 %4d，其中呼叫端早就放棄的 %4d │ 503 %4d%n", names[p], intents, in.size(),
                    in.size() / (double) Math.max(1, intents), ok, wasted, in.stream().filter(h -> h.status() == 503).count());
        }
        out.printf("  觸發結束之後：%s%n", recovered(rig, (20 + trigger) * 1000L, total * 1000L));
        if (expired(inv) >= 0)                                              // 第 06 章之後才有
            out.printf("  庫存服務：借到連線時呼叫端的預算已經用完、沒有做的預留 %.0f 次%n", expired(inv) - expiredBefore);
        out.println("  每秒：");
        for (String line : perSecond) out.println("    " + line);
        Thread.sleep(5_000);
    }

    /** 13 站 6.4.3 的 shop.inventory.budget.expired；第 06 章之前沒有這個指標 → -1 */
    static double expired(ConfigurableApplicationContext inv) {
        var c = inv.getBean(io.micrometer.core.instrument.MeterRegistry.class).find("shop.inventory.budget.expired").counter();
        return c == null ? -1 : c.count();
    }

    static long end(Rig.Done d) { return d.atMs() + d.nanos() / 1_000_000; }

    /** 觸發結束之後，第一個「連續 5 秒送出的下單全部 201、每一張都在 1 秒內回來」的秒數 */
    static String recovered(Rig rig, long from, long to) {
        for (long s = from; s + 5_000 <= to; s += 1_000) {
            boolean good = true;
            for (long t = s; t < s + 5_000 && good; t += 1_000) {
                long a = t, b = t + 1_000;
                List<Rig.Done> in = rig.done.stream().filter(d -> d.atMs() >= a && d.atMs() < b).toList();
                good = !in.isEmpty() && in.stream().allMatch(d -> d.status() == 201 && d.nanos() < 1_000_000_000L);
            }
            if (good) return String.format("第 %d 秒起恢復（觸發結束後 %d 秒）", s / 1000 + 1, (s - from) / 1000);
        }
        return String.format("%d 秒內沒有恢復", (to - from) / 1000);
    }
}
```

**`src/test/java/com/example/shop/dist06/Rig.java`**（6.2、6.3）

```java
package com.example.shop.dist06;

import com.example.shop.dist00.SplitLab;
import com.example.shop.support.TestTokens;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.boot.web.embedded.tomcat.TomcatWebServer;
import org.springframework.context.ConfigurableApplicationContext;

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
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站第 06 章的實驗台：開放式負載（第 00 章 0.2.3：時間到就送下一張，不管前一張回來沒有）、
 * 每 200 ms 打一次兩支「不下單」的 API、每秒記一次幾個量。
 *
 * 買家的 app（clientAttempts）：1 = 送一次，不管結果；n = 收到 503 或沒有回應時，照 Retry-After（沒有就 1 秒）等一下、
 * 用同一個 Idempotency-Key 再送，總共最多 n 次 —— 第 12 站的下單 API 給了冪等鍵，就是讓客戶端可以這樣做。
 */
final class Rig implements AutoCloseable {

    static final AtomicLong BUYERS = new AtomicLong(6_100_000);

    /** 一個下單的意圖：什麼時候送出（距開始幾毫秒）、最後的狀態碼、從第一次送到最後一次回來幾奈秒、送了幾次 */
    record Done(long atMs, int status, long nanos, int tries) {}

    /** 一次「不下單」的請求 */
    record Probe(long atMs, String what, int status, long nanos) {}

    final ConfigurableApplicationContext order;
    final long t0 = System.nanoTime();
    final ConcurrentLinkedQueue<Done> done = new ConcurrentLinkedQueue<>();
    final ConcurrentLinkedQueue<Probe> probes = new ConcurrentLinkedQueue<>();
    final AtomicInteger inFlight = new AtomicInteger();
    final AtomicBoolean stop = new AtomicBoolean();
    final ExecutorService load = Executors.newVirtualThreadPerTaskExecutor();
    final List<Thread> threads = new ArrayList<>();

    Rig(ConfigurableApplicationContext order) { this.order = order; }

    long now() { return (System.nanoTime() - t0) / 1_000_000; }

    /** 每秒 rate 張（3 個品項，每一張一位新的買家），直到 close() */
    Rig orders(int rate, int clientAttempts) {
        Thread sender = new Thread(() -> {
            long gap = 1_000_000_000L / rate;
            for (long i = 0; !stop.get(); i++) {
                long wait = t0 + i * gap - System.nanoTime();
                if (wait > 0) try { Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000)); } catch (InterruptedException e) { return; }
                long at = now();
                load.submit(() -> {
                    inFlight.incrementAndGet();
                    try {
                        done.add(intent(at, clientAttempts));
                    } finally {
                        inFlight.decrementAndGet();
                    }
                });
            }
        });
        sender.start();
        threads.add(sender);
        return this;
    }

    /** 每 200 ms：商品詳情（第 05 章之後讀副本，不問庫存服務）、我的訂單（只讀自己的庫） */
    Rig probes(long probeBuyer) {
        Thread prober = new Thread(() -> {
            while (!stop.get()) {
                long at = now();
                SplitLab.Result d = SplitLab.get(order, "/api/products/" + (SplitLab.FIRST_PRODUCT + 7), 0);
                probes.add(new Probe(at, "detail", d.status(), d.nanos()));
                at = now();
                SplitLab.Result o = SplitLab.get(order, "/api/orders", probeBuyer);
                probes.add(new Probe(at, "myorders", o.status(), o.nanos()));
                try { Thread.sleep(200); } catch (InterruptedException e) { return; }
            }
        });
        prober.start();
        threads.add(prober);
        return this;
    }

    Done intent(long at, int attempts) {
        long buyer = BUYERS.incrementAndGet();
        long[] ids = ThreadLocalRandom.current().longs(0, SplitLab.PRODUCTS).distinct().limit(3).map(i -> SplitLab.FIRST_PRODUCT + i).toArray();
        String key = UUID.randomUUID().toString();
        long s = System.nanoTime();
        int status = -1;
        for (int t = 1; t <= attempts; t++) {
            HttpResponse<String> r = place(order, buyer, ids, key);
            status = r == null ? -1 : r.statusCode();
            if (t == attempts || (status != 503 && status != -1)) return new Done(at, status, System.nanoTime() - s, t);
            long after = r == null ? 1 : r.headers().firstValue("Retry-After").map(Long::parseLong).orElse(1L);
            try { Thread.sleep(after * 1000); } catch (InterruptedException e) { break; }
        }
        return new Done(at, status, System.nanoTime() - s, attempts);
    }

    static HttpResponse<String> place(ConfigurableApplicationContext ctx, long buyer, long[] ids, String key) {
        String body = "{\"items\":[" + String.join(",", Arrays.stream(ids).mapToObj(id -> "{\"productId\":" + id + ",\"quantity\":1,\"unitPrice\":100.00}").toList()) + "]}";
        HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + SplitLab.port(ctx) + "/api/orders"))
                .timeout(Duration.ofSeconds(30)).header("Content-Type", "application/json")
                .header("Authorization", TestTokens.bearer(ctx, buyer)).header("Idempotency-Key", key)
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        try {
            return SplitLab.CLIENT.send(req, HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public void close() throws Exception {
        stop.set(true);
        for (Thread t : threads) t.join();
        load.shutdown();
        load.awaitTermination(120, TimeUnit.SECONDS);
    }

    // ───────── 量 ─────────

    /** Tomcat 的工作執行緒：忙著的 / 上限，以及排隊等一條執行緒的請求 */
    static String tomcat(ConfigurableApplicationContext ctx) {
        var ws = (TomcatWebServer) ((WebServerApplicationContext) ctx).getWebServer();
        var ex = (org.apache.tomcat.util.threads.ThreadPoolExecutor) ws.getTomcat().getConnector().getProtocolHandler().getExecutor();
        return String.format("Tomcat 忙 %3d/%d 排隊 %4d", ex.getActiveCount(), ex.getMaximumPoolSize(), ex.getQueue().size());
    }

    static String hikari(ConfigurableApplicationContext ctx) {
        MeterRegistry m = ctx.getBean(MeterRegistry.class);
        return String.format("連線池 active %2.0f pending %3.0f", m.get("hikaricp.connections.active").gauge().value(),
                m.get("hikaricp.connections.pending").gauge().value());
    }

    /** 13 站 6.6、6.7：預留的熔斷器在哪個狀態、下單路徑的隔艙還有幾個位子（第 06 章之前沒有這兩個指標 → 空字串） */
    static String guards(ConfigurableApplicationContext ctx) {
        MeterRegistry m = ctx.getBean(MeterRegistry.class);
        var states = m.find("resilience4j.circuitbreaker.state").tag("name", "inventory-reserve").gauges();
        if (states.isEmpty()) return "";
        String state = states.stream().filter(g -> g.value() == 1).map(g -> g.getId().getTag("state")).findFirst().orElse("?");
        var free = m.find("resilience4j.bulkhead.available.concurrent.calls").tag("name", "inventory-order-path").gauge();
        return String.format(" │ 熔斷器 %-9s │ 隔艙剩 %2.0f", state, free == null ? Double.NaN : free.value());
    }

    /** 一個值（root 直接讀那個庫）；null → 「—」 */
    static String one(String db, String sql) throws Exception {
        try (var c = SplitLab.root(db); var st = c.createStatement(); var rs = st.executeQuery(sql)) {
            if (!rs.next()) return "—";
            String v = rs.getString(1);
            return v == null ? "—" : v;
        }
    }

    /** 一段時間（依送出的時間）裡，下單或某一種 probe 的筆數、p50、p99、max、狀態碼 */
    String summary(String phase, String what, long from, long to) {
        List<long[]> in = new ArrayList<>();                                // {nanos, status, tries}
        if (what.equals("order")) done.stream().filter(d -> d.atMs() >= from && d.atMs() < to).forEach(d -> in.add(new long[]{d.nanos(), d.status(), d.tries()}));
        else probes.stream().filter(p -> p.what().equals(what) && p.atMs() >= from && p.atMs() < to).forEach(p -> in.add(new long[]{p.nanos(), p.status(), 1}));
        long[] s = in.stream().mapToLong(x -> x[0]).sorted().toArray();
        Map<Integer, Integer> codes = new TreeMap<>();
        in.forEach(x -> codes.merge((int) x[1], 1, Integer::sum));
        long tries = in.stream().mapToLong(x -> x[2]).sum();
        return String.format("  %-6s │ %-4s │ %4d 次 │ p50 %8.1f ms │ p99 %8.1f ms │ max %8.1f ms │ %s%s", phase,
                Map.of("order", "下單", "detail", "商品詳情", "myorders", "我的訂單").get(what), in.size(),
                SplitLab.pct(s, 50), SplitLab.pct(s, 99), SplitLab.pct(s, 100), codes,
                what.equals("order") && tries > in.size() ? "（app 送了 " + tries + " 次）" : "");
    }
}
```

**`src/test/java/com/example/shop/dist06/SlowDb.java`**（6.3.2）

```java
package com.example.shop.dist06;

import com.mysql.cj.MysqlConnection;
import com.mysql.cj.Query;
import com.mysql.cj.interceptors.QueryInterceptor;
import com.mysql.cj.log.Log;
import com.mysql.cj.protocol.Resultset;
import com.mysql.cj.protocol.ServerSession;

import java.util.Properties;
import java.util.function.Supplier;

/**
 * 13 站 6.3：庫存服務的資料庫變慢。每一個預留交易的第一句（processed_messages 的那一句 INSERT，第 03 章 3.5）送出之前，先睡 sleepMs ——
 * 連線已經借出來、交易已經開始：從連線池看，跟「這一句 SQL 在 MySQL 裡跑了 sleepMs」是同一件事。第一次的預留與重送都會經過這一句。
 * 掛法跟 DbTap 一樣（Connector/J 的 query interceptor，JDBC URL 加 queryInterceptors=…），只掛在庫存服務的庫上。
 */
public class SlowDb implements QueryInterceptor {

    public static volatile long sleepMs;

    @Override
    public QueryInterceptor init(MysqlConnection c, Properties props, Log log) { return this; }

    @Override
    public <T extends Resultset> T preProcess(Supplier<String> sql, Query query) {
        long ms = sleepMs;
        if (ms <= 0) return null;
        String s = sql.get();
        if (s != null && s.contains("INSERT INTO processed_messages")) {
            try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        return null;
    }

    @Override
    public boolean executeTopLevelOnly() { return true; }

    @Override
    public void destroy() {}

    @Override
    public <T extends Resultset> T postProcess(Supplier<String> sql, Query query, T originalResultSet, ServerSession serverSession) { return null; }
}
```

**`src/test/java/com/example/shop/dist06/ServerTap.java`**（6.3.2）

```java
package com.example.shop.dist06;

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

import java.io.IOException;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * 13 站 6.3：庫存服務這一邊，每一個預留請求（PUT /internal/inventory/v1/reservations/{orderId}）什麼時候進來、什麼時候做完、回了什麼。
 * 「做完」的時候呼叫端是不是早就放棄了 —— 從這裡看得出來：做完的時間 − 進來的時間 > 呼叫端等的時間。
 * 呼叫端等多久：請求帶著 Shop-Budget-Ms（第 06 章之後，訂單服務每一次都告訴庫存服務它等多久，6.4.3）就用它；沒有就用 callerWaitsMs（實驗設定成訂單服務的 read timeout）。
 * 進來的時間是這個 filter 開始執行的時候：在 Tomcat 的佇列裡等一條執行緒的那一段不算（這個實驗裡排隊在連線池，在 filter 裡面）。
 * 排在第 03 章 LostResponse 的裡面（它是最外層）：延後送出的那一段也不算。
 */
@Configuration
@ConditionalOnProperty(name = "lab.d06.server-tap", havingValue = "true")
public class ServerTap {

    /** 距 reset() 幾毫秒進來、幾毫秒做完、狀態碼、訂單編號、呼叫端等多久 */
    public record Hit(long inMs, long outMs, int status, long orderId, long callerWaitsMs) {
        /** 做完了（2xx），但呼叫端早就不等了 */
        public boolean wasted() { return status < 300 && outMs - inMs > callerWaitsMs; }
    }

    public static final ConcurrentLinkedQueue<Hit> HITS = new ConcurrentLinkedQueue<>();
    /** 進來的時刻（一進來就記；HITS 要做完才記） */
    public static final ConcurrentLinkedQueue<Long> ARRIVED = new ConcurrentLinkedQueue<>();
    public static volatile long callerWaitsMs = 3_000;
    static volatile long t0 = System.nanoTime();

    public static void reset() {
        HITS.clear();
        ARRIVED.clear();
        t0 = System.nanoTime();
    }

    static long now() { return (System.nanoTime() - t0) / 1_000_000; }

    @Bean
    FilterRegistrationBean<OncePerRequestFilter> d06ServerTap() {
        FilterRegistrationBean<OncePerRequestFilter> r = new FilterRegistrationBean<>(new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                String uri = req.getRequestURI();
                if (!req.getMethod().equals("PUT") || !uri.startsWith("/internal/inventory/v1/reservations/")) { chain.doFilter(req, res); return; }
                long in = now();
                ARRIVED.add(in);
                String budget = req.getHeader("Shop-Budget-Ms");
                long waits = budget == null ? callerWaitsMs : Long.parseLong(budget);
                try {
                    chain.doFilter(req, res);
                } finally {
                    HITS.add(new Hit(in, now(), res.getStatus(), Long.parseLong(uri.substring(uri.lastIndexOf('/') + 1)), waits));
                }
            }
        });
        r.setOrder(Ordered.HIGHEST_PRECEDENCE + 1);
        return r;
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/remote/RemoteInventoryResilienceTest.java`**（6.4～6.7）

```java
package com.example.shop.inventory.internal.remote;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.resilience.Deadline;
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
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 13 站 6.4～6.7：RemoteInventoryApi 的四道保護，對著一個假的庫存服務（跟 RemoteInventoryApiTest 同一種：JDK 的 HttpServer、真的逾時）：
 *   預算：每一次送出最多等 read timeout 與剩下的預算取小的，並用 Shop-Budget-Ms 告訴對方；不夠一次就不送
 *   重試預算：10 秒裡的重送有上限
 *   隔艙：同時在等的有上限，滿了立刻 503、不送
 *   熔斷：預留、熱點閘門各一個；5xx 與沒有回應算失敗，4xx 不算；打開之後不送、Retry-After = 開著的秒數；補償不經過熔斷器
 */
class RemoteInventoryResilienceTest {

    record Seen(String method, String path, String budget) {}

    static final String UNAVAILABLE = "{\"type\":\"/problems/temporarily-unavailable\",\"title\":\"服務暫時無法使用\",\"status\":503,\"detail\":\"系統忙碌中，請稍後再試\"}";
    static final String INSUFFICIENT = "{\"type\":\"/problems/insufficient-stock\",\"title\":\"庫存不足\",\"status\":409,\"detail\":\"商品 7 的可售庫存不足\",\"productId\":7}";
    static final List<ReserveLine> LINE = List.of(new ReserveLine(7, 1));

    HttpServer server;
    final ConcurrentLinkedQueue<Seen> seen = new ConcurrentLinkedQueue<>();
    /** 每一個請求依序取一個：{狀態碼, 延遲毫秒, 回應內容}；沒有了 → 204 */
    final ConcurrentLinkedQueue<Object[]> script = new ConcurrentLinkedQueue<>();
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        server.createContext("/", ex -> {
            seen.add(new Seen(ex.getRequestMethod(), ex.getRequestURI().getPath(), ex.getRequestHeaders().getFirst(Deadline.HEADER)));
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
    }

    @AfterEach
    void stop() { server.stop(0); }

    RemoteInventoryApi api(String... overrides) {
        Map<String, String> m = new HashMap<>(Map.of(
                "shop.order.payment-timeout", "15m", "shop.order.timeout-scan-interval", "30s",
                "shop.security.jwt-secret", "unit-test-user-jwt-secret-0123456789abcdef",
                "shop.payment.callback-secret", "unit-test-payment-callback-secret-0123",
                "shop.deployment.role", "order-service",
                "shop.deployment.inventory.url", "http://127.0.0.1:" + server.getAddress().getPort(),
                "shop.deployment.service-token.secret", "unit-test-service-token-secret-0123456789"));
        for (int i = 0; i < overrides.length; i += 2) m.put(overrides[i], overrides[i + 1]);
        ShopProperties props = new Binder(new MapConfigurationPropertySource(m)).bind("shop", ShopProperties.class).get();
        return new RemoteInventoryApi(RestClient.builder(), props, new ServiceTokens(props, Clock.systemUTC()), new ObjectMapper(), meters);
    }

    double rejected(String by) {
        return meters.find("shop.remote.rejected").tag("by", by).counters().stream().mapToDouble(c -> c.count()).sum();
    }

    // ───────── 預算 ─────────

    @Test @DisplayName("6.4：每一次送出最多等 read timeout 與剩下的預算取小的，並用 Shop-Budget-Ms 告訴庫存服務")
    void sendsTheBudget() {
        RemoteInventoryApi inventory = api();
        inventory.restock(1L, 1, "unit");                                  // 沒有期限（排程、管理員）：read timeout
        Deadline.within(Duration.ofMillis(400), () -> { inventory.restock(1L, 1, "unit"); return null; });
        List<Seen> calls = List.copyOf(seen);
        assertThat(calls.get(0).budget()).isEqualTo("1000");
        assertThat(Long.parseLong(calls.get(1).budget())).isBetween(300L, 400L);
    }

    @Test @DisplayName("6.4：第一次逾時之後剩下的不夠一次（100 ms）→ 不重送，503；整個呼叫沒有超過預算")
    void noRetryWithoutBudget() {
        RemoteInventoryApi inventory = api();
        script.add(new Object[]{204, 800L, null});
        long t0 = System.nanoTime();
        assertThatThrownBy(() -> Deadline.within(Duration.ofMillis(500), () -> { inventory.reserve(1L, LINE, List.of()); return null; }))
                .isInstanceOfSatisfying(ShopException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE));
        assertThat((System.nanoTime() - t0) / 1_000_000).isLessThan(700);
        assertThat(seen).hasSize(1);
    }

    @Test @DisplayName("6.4：預算已經用完 → 一次都不送")
    void nothingSentWhenTheBudgetIsGone() {
        RemoteInventoryApi inventory = api();
        assertThatThrownBy(() -> Deadline.within(Duration.ofMillis(50), () -> { inventory.reserve(1L, LINE, List.of()); return null; }))
                .isInstanceOf(ShopException.class);
        assertThat(seen).isEmpty();
        assertThat(rejected("budget")).isEqualTo(1.0);
    }

    // ───────── 重試預算 ─────────

    @Test @DisplayName("6.5：重試預算 —— 10 秒裡 11 次呼叫，前 10 次的重送照送，第 11 次不送（min-retries 10、ratio 0.1）")
    void retryBudget() {
        RemoteInventoryApi inventory = api("shop.deployment.inventory.read-timeout", "100ms");
        for (int i = 0; i < 11; i++) {
            script.add(new Object[]{204, 300L, null});                         // 第一次：處理了，但 300 ms 才回
            script.add(new Object[]{204, 0L, null});                           // 重送
        }
        for (int i = 0; i < 10; i++) inventory.releaseAbandoned(i);
        assertThat(seen).hasSize(20);
        assertThatThrownBy(() -> inventory.releaseAbandoned(10L)).isInstanceOf(ShopException.class);
        assertThat(seen).hasSize(21);
    }

    // ───────── 隔艙 ─────────

    @Test @DisplayName("6.6：下單路徑的隔艙滿了 → 立刻 503，沒有送出去；其他呼叫用另一個隔艙，照送")
    void bulkhead() throws Exception {
        RemoteInventoryApi inventory = api("shop.deployment.inventory.bulkhead.order-path", "1");
        script.add(new Object[]{204, 500L, null});
        CompletableFuture<Void> slow = CompletableFuture.runAsync(() -> inventory.reserve(1L, LINE, List.of()));
        while (seen.isEmpty()) Thread.sleep(5);
        long t0 = System.nanoTime();
        assertThatThrownBy(() -> inventory.reserve(2L, LINE, List.of()))
                .isInstanceOfSatisfying(ShopException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE));
        assertThat((System.nanoTime() - t0) / 1_000_000).isLessThan(100);
        inventory.releaseAbandoned(3L);                                     // 另一個隔艙
        slow.get();
        assertThat(seen).extracting(Seen::path).containsExactly("/internal/inventory/v1/reservations/1", "/internal/inventory/v1/reservations/3/release");
        assertThat(rejected("bulkhead")).isEqualTo(1.0);
    }

    // ───────── 熔斷 ─────────

    @Test @DisplayName("6.7：預留的熔斷器 —— 失敗一半以上就打開；打開之後不送、立刻 503，Retry-After = 開著的秒數")
    void breakerOpens() {
        RemoteInventoryApi inventory = api("shop.deployment.inventory.breaker.minimum-calls", "4");
        for (int i = 0; i < 4; i++) script.add(new Object[]{503, 0L, UNAVAILABLE});
        for (int i = 0; i < 4; i++) {
            long id = i;
            assertThatThrownBy(() -> inventory.reserve(id, LINE, List.of())).isInstanceOf(ShopException.class);   // 對方的 503，照原樣
        }
        assertThatThrownBy(() -> inventory.reserve(9L, LINE, List.of())).isInstanceOfSatisfying(ShopException.class, e -> {
            assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE);
            assertThat(e.properties()).containsEntry("retryAfter", 5L);
        });
        assertThat(seen).hasSize(4);
        assertThat(rejected("breaker")).isEqualTo(1.0);
    }

    @Test @DisplayName("6.7.5：ensureReservable() —— 熔斷器關著什麼都不做、開著立刻 503；問一次不會用掉半開時的試探名額")
    void ensureReservable() {
        RemoteInventoryApi inventory = api("shop.deployment.inventory.breaker.minimum-calls", "4");
        for (int i = 0; i < 5; i++) inventory.ensureReservable();          // 關著：放行、還回去
        for (int i = 0; i < 4; i++) script.add(new Object[]{503, 0L, UNAVAILABLE});
        for (int i = 0; i < 4; i++) {
            long id = i;
            assertThatThrownBy(() -> inventory.reserve(id, LINE, List.of())).isInstanceOf(ShopException.class);
        }
        assertThatThrownBy(inventory::ensureReservable).isInstanceOfSatisfying(ShopException.class,
                e -> assertThat(e.properties()).containsEntry("retryAfter", 5L));
        assertThat(seen).hasSize(4);
    }

    @Test @DisplayName("6.7.2：庫存不足（409）不是失敗 —— 賣光了，熔斷器不會打開")
    void businessFailuresDoNotTrip() {
        RemoteInventoryApi inventory = api("shop.deployment.inventory.breaker.minimum-calls", "4");
        for (int i = 0; i < 10; i++) script.add(new Object[]{409, 0L, INSUFFICIENT});
        for (int i = 0; i < 10; i++) {
            long id = i;
            assertThatThrownBy(() -> inventory.reserve(id, LINE, List.of())).isInstanceOf(InsufficientStockException.class);
        }
        inventory.reserve(10L, LINE, List.of());
        assertThat(seen).hasSize(11);
    }

    @Test @DisplayName("6.7.1：熱點閘門的熔斷器開著，一般商品的預留照送；還回閘門（補償）不經過熔斷器")
    void oneBreakerPerCall() {
        RemoteInventoryApi inventory = api("shop.deployment.inventory.breaker.minimum-calls", "4");
        for (int i = 0; i < 4; i++) script.add(new Object[]{503, 0L, UNAVAILABLE});   // Redis 掛了：閘門 503
        for (int i = 0; i < 4; i++) assertThatThrownBy(() -> inventory.gateHot(LINE)).isInstanceOf(ShopException.class);
        assertThatThrownBy(() -> inventory.gateHot(LINE)).isInstanceOf(ShopException.class);
        assertThat(seen).hasSize(4);                                        // 第 5 次閘門沒有送
        inventory.reserve(1L, LINE, List.of());
        inventory.returnHot(LINE);
        assertThat(seen).extracting(Seen::path).endsWith("/internal/inventory/v1/reservations/1", "/internal/inventory/v1/hot-gate/returns");
    }
}
```

**`src/test/java/com/example/shop/shared/resilience/DeadlineTest.java`**（6.4.3）

```java
package com.example.shop.shared.resilience;

import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 13 站 6.4：逾時預算放在執行緒上 —— 往裡只會越來越少、離開就還原 */
class DeadlineTest {

    @Test @DisplayName("沒有期限：remaining() 是 null，check() 什麼都不做")
    void noDeadline() {
        assertThat(Deadline.remaining()).isNull();
        assertThat(Deadline.expired()).isFalse();
        Deadline.check("測試");
    }

    @Test @DisplayName("裡面給的比外面多：用外面的；離開之後還原成外面的、再離開就沒有了")
    void innerCannotExtend() {
        Deadline.within(Duration.ofMillis(300), () -> {
            Deadline.within(Duration.ofSeconds(10), () -> {
                assertThat(Deadline.remaining()).isLessThanOrEqualTo(Duration.ofMillis(300));
                return null;
            });
            Deadline.within(Duration.ofMillis(100), () -> {
                assertThat(Deadline.remaining()).isLessThanOrEqualTo(Duration.ofMillis(100));
                return null;
            });
            assertThat(Deadline.remaining()).isBetween(Duration.ofMillis(100), Duration.ofMillis(300));
            return null;
        });
        assertThat(Deadline.remaining()).isNull();
    }

    @Test @DisplayName("用完了：check() → 503")
    void expired() {
        assertThatThrownBy(() -> Deadline.within(Duration.ZERO, () -> { Deadline.check("預留"); return null; }))
                .isInstanceOfSatisfying(ShopException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.TEMPORARILY_UNAVAILABLE));
        assertThat(Deadline.remaining()).isNull();                           // 丟出例外也還原
    }
}
```

**`src/test/java/com/example/shop/shared/resilience/RetryBudgetTest.java`**（6.5.2）

```java
package com.example.shop.shared.resilience;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/** 13 站 6.5.2：重試預算 —— 10 秒的窗、ratio、每 10 秒至少給的次數 */
class RetryBudgetTest {

    final AtomicLong now = new AtomicLong(1_000_000);
    final RetryBudget budget = new RetryBudget(0.1, 3, now::get);

    @Test @DisplayName("量少的時候：每 10 秒至少給 minRetries 次")
    void minimumWhenQuiet() {
        for (int i = 0; i < 5; i++) budget.sent();
        assertThat(budget.tryRetry()).isTrue();
        assertThat(budget.tryRetry()).isTrue();
        assertThat(budget.tryRetry()).isTrue();
        assertThat(budget.tryRetry()).isFalse();
    }

    @Test @DisplayName("量多的時候：重送最多是第一次送出的 10%")
    void ratioWhenBusy() {
        for (int i = 0; i < 200; i++) budget.sent();
        int allowed = 0;
        for (int i = 0; i < 100; i++) if (budget.tryRetry()) allowed++;
        assertThat(allowed).isEqualTo(20);
    }

    @Test @DisplayName("10 秒之後，舊的送出與重送都不算了")
    void windowSlides() {
        for (int i = 0; i < 3; i++) { budget.sent(); budget.tryRetry(); }
        assertThat(budget.tryRetry()).isFalse();
        now.addAndGet(9_000);
        assertThat(budget.tryRetry()).isFalse();                             // 第 9 秒：還在窗裡
        now.addAndGet(1_000);
        assertThat(budget.tryRetry()).isTrue();                              // 第 10 秒：一開始那一秒的桶過期了
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/web/InventoryServiceApiTest.java`**（6.4.3）

```diff
         assertThat(reserved(product)).isZero();
     }
 
+    // ───────── 預算 ─────────
+
+    @Test @DisplayName("6.4.3：Shop-Budget-Ms —— 借到連線的時候預算已經用完 → 503、不預留（不寫 processed_messages）；還有預算 → 照常")
+    void reserveChecksTheBudgetAfterBorrowingAConnection() throws Exception {
+        long product = 9_930_071, gone = 9_930_171, fine = 9_930_172;
+        stock(product, 10);
+        String body = "{\"lines\":[{\"productId\":" + product + ",\"quantity\":1}],\"hotLines\":[]}";
+        HttpResponse<String> late = budgeted("/internal/inventory/v1/reservations/" + gone, body, "0");
+        HttpResponse<String> inTime = budgeted("/internal/inventory/v1/reservations/" + fine, body, "5000");
+        long claimed = jdbc.queryForObject("SELECT COUNT(*) FROM processed_messages WHERE message_id = ?", Long.class, Long.toString(gone));
+        System.out.printf("13 站 6.4.3：預算 0 ms → %d %s；預算 5000 ms → %d；reserved = %d、預算用完那一張的 processed_messages %d 列%n",
+                late.statusCode(), late.body(), inTime.statusCode(), reserved(product), claimed);
+        assertThat(late.statusCode()).isEqualTo(503);
+        assertThat(inTime.statusCode()).isEqualTo(204);
+        assertThat(reserved(product)).isEqualTo(1);
+        assertThat(claimed).isZero();                                       // 交易 rollback：這張訂單之後重送，會真的預留
+    }
+
+    HttpResponse<String> budgeted(String path, String body, String budgetMs) throws Exception {
+        return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).header("Content-Type", "application/json")
+                .header("Authorization", service()).header("Shop-Budget-Ms", budgetMs)
+                .PUT(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
+    }
+
     // ───────── 工具 ─────────
 
     void stock(long product, int onHand) {
```

**`src/test/java/com/example/shop/shared/config/DeploymentPropertiesTest.java`**（6.4.2）

```diff
                 .run(ctx -> assertThat(ctx.getBean(ShopProperties.class).deployment().role()).isEqualTo(ServiceRole.INVENTORY_SERVICE));
     }
 
+    @Test @DisplayName("13 站 6.4：逾時由外而內遞減 —— 一次送出比下單的預算還長、排程補償的門檻不到預算的 10 倍 → 起不來")
+    void budgetsShrinkInwards() {
+        runner.run(ctx -> {
+            ShopProperties p = ctx.getBean(ShopProperties.class);
+            assertThat(p.order().placementBudget()).isGreaterThan(p.deployment().inventory().readTimeout());
+        });
+        runner.withPropertyValues("shop.deployment.inventory.read-timeout=3s").run(ctx -> {
+            assertThat(ctx).hasFailed();
+            String m = rootMessage(ctx.getStartupFailure());
+            System.out.println("13 站 6.4：read-timeout 3s、placement-budget 2s → " + m);
+            assertThat(m).contains("shop.order.placement-budget 必須大於 shop.deployment.inventory.read-timeout");
+        });
+        runner.withPropertyValues("shop.order.placement-budget=10s").run(ctx -> {
+            assertThat(ctx).hasFailed();
+            assertThat(rootMessage(ctx.getStartupFailure())).contains("placement-timeout 至少要是 placement-budget 的 10 倍");
+        });
+    }
+
     static String rootMessage(Throwable t) {
         StringBuilder all = new StringBuilder();
         for (Throwable c = t; c != null; c = c.getCause()) all.append(c.getMessage()).append(" | ");
```


---

## 6.12 常見誤區

- **「設了逾時就安全了。」** 這一章之前的每一個呼叫都有逾時，6.2 的訂單服務照樣整個倒下。逾時只是讓等待有上限；上限乘上每秒的請求數，就是你要付的執行緒（利特爾法則）。每秒 40 張 × 6 秒 = 240 條。
- **「逾時越短越好。」** 太短，就把「慢但會成功」變成「失敗」，而且對方還是做了（6.2：340 張訂單卡在 RESERVING，庫存那一邊都有預留）。逾時要從正常的延遲推出來（6.4.2），而且要知道它的代價（6.10.3：每秒 10 張那一輪，觸發時成立的下單 70 → 1）。
- **「每一層只重試一次，不多。」** 乘起來就多了：app 3 次 × 訂單服務 2 次 = 6 倍（6.3.3）。更要緊的是，**一層「只重送一次」就足以讓系統回不來**：6.3.4 每秒 25 張的那一輪，app 一次都沒有重送。
- **「觸發的原因修好了，系統就會回來。」** 亞穩態故障的定義就是：觸發消失之後，它停在壞的那一個穩定狀態（6.3.4：觸發 10 秒，之後 40 秒做的 1,444 個預留裡，1,420 個是白做的）。回得來與否，看的是重送、排隊、白工，不是觸發。
- **「下游自己會知道上游已經放棄了。」** 它不知道。上游斷線，下游的請求照樣在連線池裡排隊、照樣做完、照樣 commit。要告訴它（`Shop-Budget-Ms`），它也要在對的地方看（借到連線之後，6.4.3）。
- **「熔斷器是第一道防線。」** 時間窗的熔斷器要等失敗累積過門檻，6.7.6 量到晚了大約 7 秒；那幾秒擋住的是隔艙。G2 裡熔斷器關掉，系統反而回得比較快（6.10.3）。
- **「一個服務一個熔斷器。」** 熱點閘門因為 Redis 掛了而 503，會把一般商品的預留一起擋掉（6.7.1）。熔斷器的顆粒度要跟「失敗的原因」一樣細。
- **「熔斷器開著，就什麼都不做。」** 下單的 Saga 在呼叫庫存服務之前，已經寫了一張訂單（6.7.5：943 張）。要在做任何事之前問它，而且要用「要求放行」問，不是看狀態。
- **「庫存不足也是失敗，也要算進熔斷器。」** 搶購時一半的人買不到。業務的結果（4xx）算成功（6.7.2，05-service/06 的 6.7.6）。
- **「下單改成非同步，就不怕庫存服務慢了。」** 等待沒有消失，它搬到了付款頁、搬到了「抱歉，沒貨了」的通知信；而且 US-ORD-1 的兩條驗收條件要重寫（6.8）。

---

## 6.13 本章小結

- 庫存服務**慢**比**停掉**危險：慢的每一個請求都佔著一條執行緒等到逾時。正式的逾時（3 秒、再送一次）讓每一張下單等 6 秒才 503；每秒 40 張就是 240 條，Tomcat 的 200 條全滿，連不問庫存的商品頁也慢了（6.2）。
- 重送是乘法；一層的「再送一次」，在用掉六成容量的時候，就足以讓一次 10 秒的觸發變成回不來的故障（6.3）。
- **逾時預算由外而內遞減**：
  - 下單 2 秒、一次送出最多 1 秒，兩條規則寫成啟動時的檢查。
  - 剩下的時間用 `Shop-Budget-Ms` 送給庫存服務；庫存服務借到連線之後先看，過了就不做（6.4）。
- **重送只在一層、有預算**：訂單服務的那一次重送留著，但要過預算與重試預算（10%）；app 那一層，用 `Retry-After` 告訴它等多久（6.5）。
- **隔艙**：等庫存服務的請求最多 20 個，滿了立刻 503。下單路徑與其他呼叫各一個（6.6）。
- **熔斷器放在呼叫的那一種上**：預留、熱點閘門各一個；5xx 與沒有回應算失敗，4xx 不算；補償不經過它；寫訂單之前先問它（6.7）。
- 讓系統回得來的是預算與重試預算；熔斷器管的是「一直失敗時不要再等」。兩者都有代價：負載低時，恢復慢幾秒、慢但會成功的變成失敗（6.10.3）。
- 下單不等庫存，改的是需求，不只是程式；這一章不做（6.8）。

### 6.13.1 驗收清單

- [ ] 從 `d05` 開出 `d06`，在第一個 commit 上跑 G1：每秒 20 張時，說出 503 的那幾百張為什麼都等了 6 秒、為什麼庫存那一邊都有預留；每秒 40 張時，說出商品頁為什麼也慢了（6.2）。
- [ ] 用利特爾法則算出 6.2 兩種速率的 Tomcat 執行緒數（6.2.3）。
- [ ] 跑 G2，說出每秒 10 張回得來、25 張回不來的原因（用容量與「× 2」算一次）（6.3.4）。
- [ ] **不看課文**，畫出這條線上每一個「等」的上限，第 06 章之前與之後（6.4.1）。
- [ ] 說出庫存服務的預算檢查為什麼放在交易的第一行，而不是 filter 裡（6.4.3）；以及為什麼跨服務送的是「還剩幾毫秒」（6.4.4）。
- [ ] 把熔斷器改成一個服務一個，跑 `RemoteInventoryResilienceTest`，看哪一個測試紅、說出為什麼（6.7.1）。
- [ ] 把 `ensureReservable` 改成只看 `getState() == OPEN`，說出熔斷器之後會發生什麼（6.7.5）。
- [ ] 在最後的 commit 上跑 G1、G2，說出熔斷器關掉的那兩輪為什麼回得比較快（6.10.3）。
- [ ] 說出「下單不等庫存」要改第 12 站的哪兩條驗收條件（6.8）。
- [ ] `mvn clean verify` 全綠（6.11）。

---

## 6.14 下一章預告

這一章的每一個數字，都是實驗台量出來的：

- 每秒的 Tomcat 執行緒、連線池
- 呼叫端數的 `CallTap`
- 庫存服務那一邊數的 `ServerTap`
- 熔斷器的狀態

線上沒有實驗台。出事的時候，你手上只有每一個服務各自的日誌與指標，要回答的問題是：**這一張下單慢在哪一段？** 是訂單服務自己的交易、等庫存服務的連線、庫存服務的連線池，還是熔斷器擋掉了？

第 04 章 4.10.7 的 K5 量過：訂單服務送出了 `traceparent`，庫存服務的日誌卻用了另一個 traceId —— **收的那一邊還是斷的**。

第 07 章處理**分散式追蹤**：

- 讓一個 traceId 穿過 HTTP 與 RabbitMQ。
- 從一條 trace 看出 6.2 那一段 6 秒花在哪裡。
- 取樣率怎麼選。
- 告警該設在哪一個指標上。這一章的 6.9 只列了指標，還沒有決定哪一個要叫醒人。
