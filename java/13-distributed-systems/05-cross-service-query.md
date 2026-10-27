# 第 05 章：跨服務查詢

> **上一章**：[第 04 章](04-saga-and-compensation.md)讓庫存這一刀不再切斷任何一個交易：下單是編排的 Saga，付款、取消、出貨之後庫存模組聽事件。但兩個服務之間還有 9 種同步呼叫，其中 5 種是**讀**（4.10.4）；使用者的一天裡，訂單服務打庫存服務 30 次，20 次是讀、17 次問的是「這個商品可以賣幾件」（4.10.2）。熱點旗標也還沒搬：`catalog → setHot` 是那一刀上剩下的一個交易內呼叫。
>
> **這一章**：處理讀。先量那三個「讀」的頁面（商品頁、購物車、賣家的商品列表）在庫存服務變慢、停掉時會怎樣；再分出哪些讀可以不問 —— 能晚幾秒的，在訂單服務留一份庫存的**副本**（讀模型，CQRS），靠庫存服務的事件更新；不能晚的（出貨之前那一問、補貨之後那一讀）照舊問。然後量副本**晚多久、使用者在那段時間裡看到什麼**；做出重建它的方法並在 10 萬個商品上量；最後把熱點旗標搬回庫存 —— 搬完之後，「下單時哪些品項是熱點」也是一次跨服務的查詢，用同一招。
>
> **你手上會有**：從 `d04` 開出來的分支 `d05`。正式程式碼：庫存那一列多一個版本（V28），每一次可售量改變都在同一個交易裡發一則 `inventory.stock-changed`；訂單服務多一張 `stock_levels`（V29，catalog 的表）與它的消費者 `catalog.stock-levels`、重建用的快照端點與管理員端點；商品頁、賣家的商品列表、購物車在切開的部署裡讀副本（單體照舊直接問庫存模組）；熱點旗標搬到 `inventory.hot`（V30～V33），catalog 每秒讀一次熱點名單，標熱點不再在 catalog 的交易裡呼叫庫存。338 個測試、failsafe 39 個契約驗證。

---

## 5.1 學習目標

讀完這一章，你應該能：

- 說出一個頁面組合兩個服務的資料時，**延遲是相加、可用性是相乘**，並用 F1 的數字說明「一個欄位拖垮整頁」。
- 把跨服務的讀分成兩種：**可以晚幾秒的**（顯示用，US-PRD-3 AC-4）與**不能晚的**（決定要不要做一件補償不回來的事、讀自己剛寫的），並說出每一種該怎麼做。
- 在呼叫端做一份讀模型：誰擁有它、事件帶什麼（**版本**）、亂序與重複怎麼處理、為什麼消費者在每一個角色裡都要在。
- 量讀模型的**過時視窗**，並說出使用者在那段時間裡看到什麼、真正的判斷在哪裡。
- 從快照**重建**讀模型，說出重建途中進來的事件為什麼不會被蓋掉，以及守門的比較用 `>` 與 `>=` 的差別。
- 說出熱點名單晚一秒時，兩個方向各會發生什麼，為什麼都安全。
- 回答「報表該不該直連別人的資料庫」，以及下一刀如果切的是訂單，報表要付什麼。

---

## 5.2 先看見痛：一個欄位，拖垮整頁 ★★★

### 5.2.0 開分支

```bash
git switch -c d05 d04
```

這一章的第一個 commit 只有一個實驗（F1），正式程式碼還是第 04 章的。

### 5.2.1 實驗怎麼做（F1）

第 04 章之後，訂單服務還在問庫存服務的讀，有三個頁面每一次都要問：

| 頁面 | 問什麼 | 第 12 站的需求 |
|---|---|---|
| 商品詳情 `GET /api/products/{id}` | 這一個商品可以賣幾件（`availableForDisplay`） | US-PRD-3 AC-4：**允許最多 5 秒的延遲**，真正的判斷在下單時 |
| 購物車 `GET /api/cart` | 車裡每一個商品可以賣幾件（不夠就提醒） | US-CART-1 AC-5：提醒，不擋 |
| 賣家的商品 `GET /api/seller/products` | 這一頁 20 個商品各剩幾件 | —— |

F1 每一頁交錯著打，四段：庫存服務正常 → 每一次讀**慢 200 ms** → **慢 1 秒** → **停掉**。慢是第 03 章的 `LostResponse`：庫存服務照常處理，回應晚一點送出。對照組有兩個：同一個訂單服務的「我的訂單」（只讀自己的庫），以及單體。也用第 03 章的 `CallTap` 數一數每一頁打了庫存服務幾次：

```java
/**
 * 13 站 5.2：第 04 章之後，庫存這一刀不再切斷任何一個交易 —— 但還有 9 種同步呼叫，5 種是讀（4.10.4）。
 * 「讀」的三個頁面：商品詳情、購物車、賣家的商品列表。它們每一次都問庫存服務「這幾個商品可以賣幾件」。
 * 四段：庫存服務正常 → 每一次讀慢 200 ms → 每一次讀慢 1 秒 → 停掉。對照：同一個訂單服務的「我的訂單」（只讀自己的庫），
 * 以及單體（一個行程）正常的時候。也數一數每一頁打了庫存服務幾次（第 03 章的 CallTap）。
 *
 *   mvn test -Pexperiments -Dtest=F1QueryPainTest
 */
@Tag("experiment")
class F1QueryPainTest {

    static final String MONO_DB = "shop_d05_mono";
    static final int MONO_REDIS = 11;
    static final long BUYER = 5_100_001L;

    final PrintStream out = System.out;

    record Page(String name, String path, long user, boolean seller) {}
    record Res(int status, long nanos) {}

    final List<Page> pages = List.of(
            new Page("商品詳情", "/api/products/" + (SplitLab.FIRST_PRODUCT + 7), 0, false),
            new Page("購物車", "/api/cart", BUYER, false),
            new Page("賣家的商品", "/api/seller/products?page=0&size=20", SplitLab.SELLER, true),
            new Page("我的訂單", "/api/orders", BUYER, false));

    @Test
    void readsAcrossTheCut() throws Exception {
        out.printf("═══ 5.2 三個「讀」的頁面，庫存服務正常、變慢、停掉（load %s）═══%n", SplitLab.load());
        SplitLab.freshDatabase(MONO_DB);
        Split.freshDatabases();
        com.example.shop.dist04.Nodes.flushRedis(MONO_REDIS);
        com.example.shop.dist04.Nodes.flushRedis(Split.ORDER_REDIS);
        com.example.shop.dist04.Nodes.flushRedis(Split.INV_REDIS);
        LostResponse.reset();
        try (ConfigurableApplicationContext mono = new SpringApplicationBuilder(ShopApplication.class).run(SplitLab.common(MONO_DB, MONO_REDIS).toArray(String[]::new))) {
            SplitLab.seed(MONO_DB, true, true);
            prepare(mono);
            Map<String, String> rows = new LinkedHashMap<>();
            measure(mono, "單體", 50, rows);
            rows.forEach((k, v) -> out.println(v));
        }
        ConfigurableApplicationContext inv = Roles.inventoryService(List.of("--lab.d03.lost-response=true"));
        try (ConfigurableApplicationContext order = Roles.orderService(inv, List.of("--lab.d03.call-tap=true"))) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            prepare(order);
            for (Page p : pages) {                                          // 每一頁打了庫存服務幾次
                CallTap.CALLS.clear();
                get(order, p);
                Map<String, Integer> calls = new TreeMap<>();
                CallTap.CALLS.forEach(c -> calls.merge(c.method() + " " + c.path().replaceAll("[0-9]{4,}", "{id}"), 1, Integer::sum));
                out.printf("  %-6s → 庫存服務 %d 次 %s%n", p.name(), CallTap.CALLS.size(), calls);
            }
            Map<String, String> rows = new LinkedHashMap<>();
            measure(order, "切開：正常", 50, rows);
            LostResponse.arm("GET", "/stock", 200, Integer.MAX_VALUE);
            measure(order, "切開：每次讀慢 200 ms", 30, rows);
            LostResponse.reset();
            LostResponse.arm("GET", "/stock", 1_000, Integer.MAX_VALUE);
            measure(order, "切開：每次讀慢 1 秒", 20, rows);
            LostResponse.reset();
            inv.close();
            measure(order, "切開：庫存服務停掉", 20, rows);
            rows.forEach((k, v) -> out.println(v));
            CallTap.CALLS.clear();
            Res r = get(order, pages.get(0));
            out.printf("  庫存服務停掉時，商品詳情的回應：%d %s%n", r.status(), lastBody);
        } finally {
            if (inv.isActive()) inv.close();
            LostResponse.reset();
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }
```

（`prepare`、`measure`、`get` 與完整的類別在 5.11.1。）

### 5.2.2 結果

```bash
mvn test -Pexperiments -Dtest=F1QueryPainTest
```

```
═══ 5.2 三個「讀」的頁面，庫存服務正常、變慢、停掉（load { 3.32 4.71 6.02 }）═══
  單體               │ 商品詳情   │ p50      2.5 ms │ p99     27.2 ms │ {200=50}
  單體               │ 購物車    │ p50      7.3 ms │ p99     29.0 ms │ {200=50}
  單體               │ 賣家的商品  │ p50      8.6 ms │ p99     76.9 ms │ {200=50}
  單體               │ 我的訂單   │ p50      4.4 ms │ p99     14.8 ms │ {200=50}
  商品詳情   → 庫存服務 1 次 {GET /internal/inventory/v1/stock/{n}/display=1}
  購物車    → 庫存服務 1 次 {GET /internal/inventory/v1/stock=1}
  賣家的商品  → 庫存服務 1 次 {GET /internal/inventory/v1/stock=1}
  我的訂單   → 庫存服務 0 次 {}
  切開：正常            │ 商品詳情   │ p50      3.3 ms │ p99      7.2 ms │ {200=50}
  切開：正常            │ 購物車    │ p50      8.6 ms │ p99     17.7 ms │ {200=50}
  切開：正常            │ 賣家的商品  │ p50      9.6 ms │ p99     17.1 ms │ {200=50}
  切開：正常            │ 我的訂單   │ p50      3.9 ms │ p99      8.7 ms │ {200=50}
  切開：每次讀慢 200 ms   │ 商品詳情   │ p50    215.6 ms │ p99    246.7 ms │ {200=30}
  切開：每次讀慢 200 ms   │ 購物車    │ p50    230.4 ms │ p99    286.8 ms │ {200=30}
  切開：每次讀慢 200 ms   │ 賣家的商品  │ p50    229.9 ms │ p99    279.9 ms │ {200=30}
  切開：每次讀慢 200 ms   │ 我的訂單   │ p50     10.4 ms │ p99     66.5 ms │ {200=30}
  切開：每次讀慢 1 秒      │ 商品詳情   │ p50   1017.1 ms │ p99   1068.2 ms │ {200=20}
  切開：每次讀慢 1 秒      │ 購物車    │ p50   1028.5 ms │ p99   1078.1 ms │ {200=20}
  切開：每次讀慢 1 秒      │ 賣家的商品  │ p50   1032.5 ms │ p99   1065.7 ms │ {200=20}
  切開：每次讀慢 1 秒      │ 我的訂單   │ p50     15.1 ms │ p99     21.3 ms │ {200=20}
  切開：庫存服務停掉        │ 商品詳情   │ p50      3.1 ms │ p99     28.9 ms │ {503=20}
  切開：庫存服務停掉        │ 購物車    │ p50      7.0 ms │ p99     12.9 ms │ {503=20}
  切開：庫存服務停掉        │ 賣家的商品  │ p50      8.1 ms │ p99     18.0 ms │ {503=20}
  切開：庫存服務停掉        │ 我的訂單   │ p50      5.2 ms │ p99      7.5 ms │ {200=20}
  庫存服務停掉時，商品詳情的回應：503 {"type":"/problems/temporarily-unavailable","title":"服務暫時無法使用","status":503,"detail":"庫存服務暫時無法使用，請稍後再試","instance":"/api/products/9000008","traceId":"6ad1a61369bfe42a87a6b8ee766e3147","retryAfter":1}
  （結束時 load { 8.53 5.98 6.35 }）
```

### 5.2.3 三件事

**一、每一頁只打一次。** 第 03 章已經把「每個品項問一次」合成一次批次的呼叫（3.4），所以這裡沒有 N + 1。庫存服務慢 200 ms，頁面就慢 200 ms；慢 1 秒，就慢 1 秒 —— **延遲是相加的**。README 說的「延遲相乘」，發生在一頁要依序問好幾個服務、每一個服務又各自再問別人的時候；這個系統的頁面只組合兩個來源（自己的庫、庫存服務），相加就是全部。

**二、可用性是相乘的。** 庫存服務停掉，三頁全部 503：

```
{"type":"/problems/temporarily-unavailable","title":"服務暫時無法使用","status":503,"detail":"庫存服務暫時無法使用，請稍後再試",…}
```

商品頁要顯示的東西，名稱、價格、說明、圖片都在訂單服務自己的庫裡；只有「可以賣幾件」這一個欄位拿不到，整頁就打不開。一頁同時依賴兩個服務，它的可用性就是兩個服務的可用性相乘 —— 各 99.9%，這一頁是 99.8%。依賴的服務越多，乘得越小。

**三、跟庫存無關的頁面沒事。** 「我的訂單」在四段裡都是幾毫秒（慢 200 ms 那一段的 p99 66 ms 是同一台機器上的 CPU 競爭）。第 00 章 0.2.3 那種「庫存慢、所有頁面一起倒」，第 04 章之後已經不會發生 —— 等庫存的那幾頁，不再佔著資料庫連線（第 04 章 4.10.7 的 K3）。**剩下的痛是：等的那一頁自己倒。**

---

## 5.3 哪些讀可以不問

第 04 章 4.10.4 的 B1 列了庫存這一刀的 9 種同步呼叫，5 種是讀。一種一種看：

| 讀 | 誰 | 讀到的東西拿來做什麼 | 可以晚嗎 |
|---|---|---|---|
| `available`（購物車） | cart | 提醒「可能不夠」 | 可以：提醒錯了，下單時會被擋（409） |
| `available`、`availableForDisplay`（商品頁、賣家的列表） | catalog | 顯示 | 可以：AC-4 白紙黑字寫了 5 秒 |
| `available`（補貨之後的回應） | catalog | 告訴賣家「你剛補完，現在有幾件」 | **不行**：賣家剛寫的，要看得到（讀自己的寫） |
| `checkShippable` | ordering | 決定要不要出貨 —— 補償不回來的那一步（4.6.3） | **不行**：晚了就是出一件不存在的貨 |
| `activeReservations` | ordering（對帳） | 找兩邊對不上的預留 | 對帳本身就是在找「晚了」的東西；它要的是庫存現在的樣子 |

可以晚的那三種，有兩個做法：

| | API 組合（照舊問，加上保護） | 讀模型（在自己這邊留一份） |
|---|---|---|
| 怎麼做 | 每一次問；問不到時給一個舊的值或「暫時無法顯示」 | 庫存服務每一次改了，發一則事件；訂單服務收到之後寫進自己的庫，頁面讀自己的庫 |
| 庫存服務停掉 | 要看有沒有舊的值可以給（快取） | 頁面不受影響（副本還在，只是停在停掉那一刻） |
| 晚多久 | 快取多久就晚多久 | 事件從發出到寫好的時間（5.5 量） |
| 多了什麼 | 快取與它的失效 | 一張表、一種事件、一個消費者、**重建的方法**（5.6） |

**單體其實已經是第一種了。** 第 12 站 6.4.4 讓商品頁的可售量在 Redis 裡快取 5 秒（AC-4 允許）—— 5.5 會量到，單體的商品頁本來就晚將近 5 秒。

這一章選第二種，理由是 F1 的第二件事：讀模型讓這三頁**不再依賴庫存服務活著**。代價是那張表要有人維護、晚多久要量、壞了要能重建。不能晚的那兩種讀（補貨之後、出貨之前）照舊問 —— 它們的形狀跟「顯示」不一樣，一份會晚的副本救不了它們。

---

## 5.4 讀模型：庫存的副本

### 5.4.1 誰擁有副本

副本裡放的是庫存服務的資料，可是**它的形狀是讀它的人決定的**：商品頁要「這一個商品幾件」，購物車要「這幾個商品各幾件」，5.7 之後下單要「哪些是熱點」。所以它放在讀它的那一邊 —— 訂單服務的庫，catalog 模組的表：

| | 擁有者 | 寫它的 | 讀它的 |
|---|---|---|---|
| `inventory`（真的那一份） | 庫存模組（庫存服務） | 預留、落帳、釋放、補貨…… | 下單、出貨之前那一問 |
| `stock_levels`（副本） | catalog 模組（訂單服務） | **只有** `catalog.stock-levels` 消費者（與重建） | 商品頁、賣家的商品列表、購物車、熱點名單 |

第 02 章 2.3.3 的「唯一寫入者」在這裡仍然成立：**可售量**的唯一寫入者是庫存服務；`stock_levels` 不是另一份可售量，是它的一份抄本，抄本只有一個人能改。

### 5.4.2 庫存那一邊：版本，與 `inventory.stock-changed`

收到兩則事件，哪一則比較新？事件會重複、會亂序（第 12 站 7.5.4：重試會讓後發的先到）—— 光看「收到的順序」不行。給 `inventory` 那一列一個版本，每一次改那一列就加 1：

```sql
-- 13 站 5.4：讀模型要知道「這是第幾版」。每一次改 inventory 那一列，version 加 1；inventory.stock-changed 帶著它，
-- 另一個服務裡的副本只在版本比較新的時候才寫 —— 事件會重複、會亂序（第 12 站 7.5.4）。只改資料字典（ALGORITHM=INSTANT）
ALTER TABLE inventory ADD COLUMN version BIGINT NOT NULL DEFAULT 0, ALGORITHM=INSTANT;
```

改 `inventory` 那一列的 SQL 一共 7 句（預留、落帳、釋放、出庫 × 2、補貨、建立；5.7 的標熱點再多兩句），每一句都加上 `version = version + 1`。可售量變了的那幾個操作，在**同一個交易**的最後寫一則事件：

```java
    /**
     * 13 站 5.4：這幾個商品的可售量變了 —— 讀它們現在的值與版本，跟這個交易一起寫一則 inventory.stock-changed。
     * 讀的是這個交易剛寫的那幾列（自己的寫入，一定看得到最新的；那幾列的 X 鎖還在手上，別人改不了）
     */
    private void stockChanged(long aggregateId, java.util.Collection<Long> productIds) {
        if (productIds.isEmpty()) return;
        List<Long> ids = productIds.stream().distinct().sorted().toList();
        String in = String.join(",", ids.stream().map(id -> "?").toList());
        List<Map<String, Object>> items = jdbc.query("SELECT product_id, on_hand - reserved, version, hot FROM inventory WHERE product_id IN (" + in + ") ORDER BY product_id",
                (rs, i) -> Map.<String, Object>of("productId", rs.getLong(1), "available", rs.getInt(2), "version", rs.getLong(3), "hot", rs.getBoolean(4)), ids.toArray());
        outbox.add("INVENTORY", aggregateId, EventTypes.STOCK_CHANGED, Map.of("items", items));   // 聚合 id：觸發它的訂單或商品（跟 stock-returned 一樣）
    }
```

讀的是這個交易剛寫的那幾列 —— 自己的寫入一定看得到，那幾列的 X 鎖也還在手上，別人改不了，所以事件裡的值與版本就是 commit 那一刻的值與版本。預留的時候：

```java
        if (inbox.claim(RESERVE_KEY, Long.toString(orderId))) {
            reserveCounted(orderId, lines);
            if (!hotLines.isEmpty()) holdHot(orderId, hotLines);
            stockChanged(orderId, lines.stream().map(ReserveLine::productId).toList());   // 5.4：熱點品項還沒計入，可售量沒變
            return false;
        }
```

熱點品項只寫預留列、不碰 `inventory` 那一列（第 12 站 7.6），可售量要等落帳才變 —— 落帳的時候再發。出庫是例外：`on_hand` 與 `reserved` 一起減 1，可售量不變；版本照樣加 1，不發事件。

⚠️ 聚合類型不要寫成 `ORDER`（雖然觸發它的是一張訂單）：第 04 章的 `PlaceOrderSagaTest` 數「這張訂單的 outbox 裡有哪些事件」，會多一則，測試就紅了。這一則講的是庫存，聚合類型跟 `inventory.stock-returned` 一樣用 `INVENTORY`，聚合 id 照樣是觸發它的訂單或商品。

`StockChangedEventsTest`（`inventory.internal`）把一連串操作走一次，數每一則事件的值與版本：

```
5.4 stock-changed：[INVENTORY:9900901 5 v1, INVENTORY:99090101 3 v2, INVENTORY:99090102 2 v4, INVENTORY:99090102 3 v5]；inventory 那一列的版本 5
```

補貨 v1、預留 v2、確認（不動那一列）、出庫 v3（不發）、預留 v4、釋放 v5。

### 5.4.3 訂單服務那一邊：`stock_levels` 與它的消費者

```sql
-- 13 站 5.4：庫存的「可以賣幾件」在訂單服務這一邊的副本（讀模型）。只在切開的部署裡被寫、被讀（ServiceRole.ORDER_SERVICE）：
-- catalog.stock-levels 消費者收 inventory.stock-changed 寫它；商品頁、賣家的商品列表、購物車讀它，不再每一次問庫存服務。
--   version    ：庫存那一列的版本，只往前 —— 重複、亂序的事件不會蓋掉比較新的值
--   changed_at ：庫存那一邊改的時間（事件寫進 outbox 的那一刻）
--   updated_at ：這裡寫進來的時間；updated_at − changed_at 就是這一筆晚了多久（5.5）
-- 單體不用它（同一個庫，直接問庫存模組），表照樣建：migration 不分角色（第 02 章 2.4.2）
CREATE TABLE stock_levels (
  product_id  BIGINT       NOT NULL,                     -- catalog.products.id
  available   INT          NOT NULL,
  version     BIGINT       NOT NULL,
  changed_at  DATETIME(3)  NOT NULL,
  updated_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (product_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON stock_levels TO shop_app;
```

消費者把每一筆 upsert 進去，**版本比較新（或一樣）才寫**：

```java
    /**
     * MySQL 依序執行 ON DUPLICATE KEY UPDATE 的每一個指派：version 要放最後，前面的 IF 比的才是舊的版本。
     * >=，不是 >：同一個版本就是庫存那一列的同一個狀態，再寫一次無害 —— 而重建（5.6）要靠它修好「版本一樣、值卻錯了」的那幾列
     */
    static final String UPSERT = """
            INSERT INTO stock_levels (product_id, available, hot, version, changed_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3)) AS n
            ON DUPLICATE KEY UPDATE
              available  = IF(n.version >= stock_levels.version, n.available,  stock_levels.available),
              hot        = IF(n.version >= stock_levels.version, n.hot,        stock_levels.hot),
              changed_at = IF(n.version >= stock_levels.version, n.changed_at, stock_levels.changed_at),
              updated_at = IF(n.version >= stock_levels.version, n.updated_at, stock_levels.updated_at),
              version    = GREATEST(stock_levels.version, n.version)""";

    private final JdbcTemplate jdbc;
    private final InventoryApi inventory;

    StockReplica(JdbcTemplate jdbc, InventoryApi inventory) {
        this.jdbc = jdbc;
        this.inventory = inventory;
    }

    // ───────── 寫 ─────────

    @Override public String consumer() { return "catalog.stock-levels"; }

    @Override public Set<String> eventTypes() { return Set.of(EventTypes.STOCK_CHANGED); }

    @Override
    public void handle(Event e) {
        for (JsonNode i : e.payload().get("items"))                         // hot：5.7 才有；之前的事件沒有這個欄位 → false
            apply(i.get("productId").asLong(), i.get("available").asInt(), i.path("hot").asBoolean(false), i.get("version").asLong(), e.occurredAt());
    }

    void apply(long productId, int available, boolean hot, long version, Instant changedAt) {
        jdbc.update(UPSERT, productId, available, hot, version, Timestamp.from(changedAt));
    }
```

`ON DUPLICATE KEY UPDATE` 的每一個指派由左到右執行，後面的看得到前面改過的值：`version` 放在最後，前面那幾個 `IF` 比的才是**舊的**版本。`>=` 而不是 `>` 的理由在 5.6。

同一則事件送兩次，`processed_messages` 擋得住（`EventDispatcher`，第 12 站 7.5.2）；擋不住的是**另一則**事件帶著比較舊的值晚到 —— 兩次預留各發一則，重試讓第一則晚了。版本就是為它：

```
5.4 版本 3 → 2 → 3：{9900911=7}；version 3
```

小坑：「這一筆有沒有寫進去」不能用 `update()` 的回傳值判斷（新增 1、改了 2、沒改 0）。MySQL Connector/J 預設回的是**找到幾列**（`useAffectedRows=false`）：什麼都沒改，也是 1。所以 `apply()` 不回傳任何東西。

讀的那一邊，用一個介面把兩種部署分開：

```java
package com.example.shop.catalog.internal;

import java.util.Collection;
import java.util.List;
import java.util.Map;

/**
 * 13 站 5.4：「這幾個商品可以賣幾件」—— 商品頁、賣家的商品列表、購物車要顯示的那個數字（US-PRD-3 AC-4：允許最多 5 秒的延遲）。
 *   單體（InventoryStockLevels）：直接問庫存模組 —— 同一個行程、同一個庫，一句 SQL
 *   切開的訂單服務（StockReplica）：讀自己庫裡的副本（stock_levels），庫存服務的 inventory.stock-changed 更新它 —— 不再每一次問庫存服務
 * 沒有的商品不在結果裡（呼叫端當 0：跟「還沒有庫存列」一樣）
 */
interface StockLevels {

    Map<Long, Integer> available(Collection<Long> productIds);

    default int available(long productId) { return available(List.of(productId)).getOrDefault(productId, 0); }

    /** 商品頁顯示用。單體：熱點商品讀 Redis 的閘門（第 12 站 6.5）；切開之後那個閘門在庫存服務的 Redis 裡 —— 讀副本 */
    int forDisplay(long productId);

    /** 13 站 5.7：所有標成熱點的商品。旗標在庫存（inventory.hot）；單體問庫存模組，切開的訂單服務讀副本 */
    java.util.Set<Long> hotProducts();
}
```

單體照舊問庫存模組（沒有一刀要跨，不需要副本）；切開的訂單服務讀副本：

```java
/**
 * 13 站 5.4：單體 —— 跟第 12 站一樣，直接問庫存模組（不需要副本：沒有一刀要跨）。
 * 庫存服務的角色裡 catalog 的 bean 也在（只是沒有人用）：ProductService 要一個 StockLevels，給它這一個
 */
@Component
@ConditionalOnServiceRole({ServiceRole.MONOLITH, ServiceRole.INVENTORY_SERVICE})
class InventoryStockLevels implements StockLevels {

    private final InventoryApi inventory;

    InventoryStockLevels(InventoryApi inventory) { this.inventory = inventory; }

    @Override public Map<Long, Integer> available(Collection<Long> productIds) { return inventory.available(productIds); }

    @Override public int forDisplay(long productId) { return inventory.availableForDisplay(productId, false); }   // hot 由庫存自己判斷（5.7）

    @Override public java.util.Set<Long> hotProducts() { return inventory.hotProducts(); }
}
```

```java
/** 13 站 5.4：切開的訂單服務 —— 讀自己庫裡的副本（StockReplica），不再每一次問庫存服務 */
@Component
@ConditionalOnServiceRole(ServiceRole.ORDER_SERVICE)
class ReplicaStockLevels implements StockLevels {

    private final StockReplica replica;

    ReplicaStockLevels(StockReplica replica) { this.replica = replica; }

    @Override public Map<Long, Integer> available(Collection<Long> productIds) { return replica.available(productIds); }

    /** 熱點商品也讀副本：閘門在庫存服務的 Redis 裡（MySQL 落帳之後的值，最多晚幾秒 —— AC-4 允許 5 秒） */
    @Override public int forDisplay(long productId) { return Math.max(0, replica.available(java.util.List.of(productId)).getOrDefault(productId, 0)); }

    @Override public java.util.Set<Long> hotProducts() { return replica.hotIds(); }
}
```

⚠️ `InventoryStockLevels` 不能只標 `MONOLITH`。catalog 的 bean 在庫存服務的角色裡**也在**（只是沒有人用），它要一個 `StockLevels`；只標 `MONOLITH`，第 03 章的 `InventoryServiceApiTest` 用庫存服務的角色起一個應用程式 —— 起不來：`ProductService required a bean of type 'StockLevels' that could not be found`。

商品頁、賣家的商品列表、改價、上下架、標熱點之後的回應，都改讀 `StockLevels`：

```diff
     private final TransactionTemplate readOnly;
     private final TransactionTemplate tx;
     private final Outbox outbox;
+    private final StockLevels stock;
+    private final HotProducts hotProducts;
 
     ProductService(ProductRepository products, CategoryRepository categories, InventoryApi inventory, Clock clock, AuditLog audit,
-                   ProductCache cache, PlatformTransactionManager tm, Outbox outbox) {
+                   ProductCache cache, PlatformTransactionManager tm, Outbox outbox, StockLevels stock, HotProducts hotProducts) {
         this.products = products;
         this.categories = categories;
         this.inventory = inventory;
…
         this.readOnly.setReadOnly(true);
         this.tx = new TransactionTemplate(tm);
         this.outbox = outbox;
+        this.stock = stock;
+        this.hotProducts = hotProducts;
     }
 
     /** 快取沒有的時候才從 MySQL 載入 —— 只有這一步需要交易（Category 是 LAZY，讀它的 id 要在 session 裡） */
…
             refreshCacheAfterCommit(p);                                      // US-PRD-3 AC-3：改價後 1 秒內讀到新價格
             return detailOf(p, 0);
         });
-        return withAvailable(d, inventory.available(productId));
+        return withAvailable(d, stock.available(productId));               // 13 站 5.4：沒有改庫存 —— 讀副本就夠
     }
 
     public ProductDetail publish(long sellerId, long productId) {
…
             refreshCacheAfterCommit(p);
             return detailOf(p, 0);
         });
-        return withAvailable(d, inventory.available(productId));
+        return withAvailable(d, stock.available(productId));
     }
 
     public ProductDetail unpublish(long sellerId, long productId) {
…
             refreshCacheAfterCommit(p);                                      // US-PRD-4 AC-1：下架 1 秒內從詳情頁消失
             return detailOf(p, 0);
         });
-        return withAvailable(d, inventory.available(productId));
+        return withAvailable(d, stock.available(productId));
     }
 
     /**
      * 6.5 標記熱點商品（0.6.1 第 3 條：由賣家標記 hot=true）。熱點商品的下單先過 Redis 的閘門。
      * 庫存的 Redis 副本由 inventory 在 commit 之後建立（InventoryApi.setHot）
+     *
+     * 13 站 5.7：旗標的擁有者是庫存（inventory.hot）。順序：確認是你的商品（catalog 自己的唯讀交易）→ 庫存改旗標（它自己的交易，
+     * 不在 catalog 的交易裡 —— B1 上最後一個「交易內的跨模組呼叫」）→ products.hot（過渡期留著的舊副本，沒有人再用它做決定；第 09 章收縮）。
+     * 庫存那一步失敗：什麼都沒改（503）；products.hot 那一步失敗：只有舊副本落後，下單照樣看庫存的
      */
     public ProductDetail setHot(long sellerId, long productId, boolean hot) {
+        readOnly.execute(s -> owned(sellerId, productId));
+        inventory.setHot(productId, hot);
         ProductDetail d = tx.execute(s -> {
             Product p = owned(sellerId, productId);
-            if (p.markHot(hot, clock.instant())) {
-                inventory.setHot(productId, hot);                            // 這一個還在交易裡（MANDATORY）：13 站 1.6.7
-                refreshCacheAfterCommit(p);
-            }
+            if (p.markHot(hot, clock.instant())) refreshCacheAfterCommit(p);
             return detailOf(p, 0);
         });
-        return withAvailable(d, inventory.available(productId));
+        return withAvailable(d, stock.available(productId));
+    }
+
+    /**
+     * 13 站 5.7：搬家 —— 第 05 章之前標成熱點的商品，旗標只在 products.hot。部署這一版之後，由管理員打一次，把它們抄到庫存（setHot 冪等：
+     * 已經是熱點的不會再發事件）。在那之前，那些商品的下單不過閘門、走一般的預留：正確，只是搶購時比較慢（HotProducts 的註解）
+     * @return 抄了幾個
+     */
+    public int copyHotFlagsToInventory() {
+        List<Long> ids = readOnly.execute(s -> products.findHotIds());
+        for (long id : ids) inventory.setHot(id, true);
+        return ids.size();
     }
 
     /**
…
     public ProductDetail restock(long sellerId, long productId, RestockRequest req) {
         ProductDetail d = readOnly.execute(s -> detailOf(owned(sellerId, productId), 0));
         inventory.restock(productId, req.quantity(), req.note() == null ? "seller-restock" : "seller-restock:" + req.note());
+        // 13 站 5.4：這一個不讀副本 —— 賣家剛補了貨，回應要看到自己剛寫的（副本要等事件送到）。問庫存服務：一次讀，在寫之後
         return withAvailable(d, inventory.available(productId));
     }
 
…
         boolean visible = c.status() == ProductStatus.ON_SALE || (viewerId != null && c.sellerId() == viewerId);
         if (!visible) throw ShopException.notFound("商品");
         return new ProductDetail(c.id(), c.sellerId(), c.name(), c.description(), c.price(), c.categoryId(), c.status(),
-                inventory.availableForDisplay(productId, c.hot()));
+                stock.forDisplay(productId));                                   // 13 站 5.4：切開之後讀副本；5.7：熱點由庫存自己判斷
     }
 
     public PageResponse<SellerProductView> mine(long sellerId, Pageable pageable) {
         PageResponse<SellerProductView> page = readOnly.execute(s -> PageResponse.of(products.findBySellerId(sellerId, pageable),
                 p -> new SellerProductView(p.getId(), p.getName(), p.getPrice(), p.getStatus(), p.getCategory().getId(), 0, p.getUpdatedAt())));
-        Map<Long, Integer> available = inventory.available(page.content().stream().map(SellerProductView::id).toList());   // 13 站 1.6：交易之外
+        Map<Long, Integer> available = stock.available(page.content().stream().map(SellerProductView::id).toList());   // 13 站 1.6：交易之外；5.4：副本
         return new PageResponse<>(page.content().stream().map(v -> new SellerProductView(v.id(), v.name(), v.price(), v.status(),
                 v.categoryId(), available.getOrDefault(v.id(), 0), v.updatedAt())).toList(), page.page(), page.size(), page.totalElements(), page.totalPages());
     }
 
+    /** 13 站 5.7：不再讀 products.hot —— 讀庫存的旗標（每秒一次，HotProducts） */
     @Override
     public Set<Long> hotProducts(Collection<Long> productIds) {
+        Set<Long> all = hotProducts.current();
         Set<Long> hot = new HashSet<>();
-        for (long id : productIds)
-            cache.get(id, this::load).filter(ProductCache.Core::hot).ifPresent(c -> hot.add(id));
+        for (long id : productIds) if (all.contains(id)) hot.add(id);
         return hot;
     }
 
+    @Override
+    public Map<Long, Integer> available(Collection<Long> productIds) { return stock.available(productIds); }
+
     @Override
     @Transactional(readOnly = true)
     public Map<Long, ProductSnapshot> snapshots(Collection<Long> productIds) {
```

（標熱點、搬家、`hotProducts` 那幾段是 5.7 的。）

### 5.4.4 ⚠️ 副本一則都沒收到

如果 `StockReplica` 跟 `ReplicaStockLevels` 一樣，標 `@ConditionalOnServiceRole(ORDER_SERVICE)` —— 副本只有切開的訂單服務需要，消費者也只放在那裡，看起來很合理 —— F2（5.5）跑下去是這樣：

```
OUTBOX_UNSUBSCRIBED type=inventory.stock-changed：這個應用程式裡沒有消費者訂閱它，標成已送出、不送（每一種只記這一次）
  A 每秒  20 張 × 30 秒 │ 下單 201 600、其他 0 │ stock-changed 0 則 │ 延遲 p50    NaN ms │ p90    NaN ms │ p99     NaN ms │ max     NaN ms
  A 每秒 100 張 × 30 秒 │ 下單 201 3,000、其他 0 │ stock-changed 0 則 │ 延遲 p50    NaN ms │ p90    NaN ms │ p99     NaN ms │ max     NaN ms
```

（日誌那一行的時間與執行緒省略了。）

延遲一欄是 `NaN`：副本一則事件都沒收到。原因寫在第 12 站 9.2.1 與第 03 章 3.7.3 的註解裡 —— relay 只送「這個行程裡有人訂閱」的事件，那一份清單來自 `EventHandler` 這些 bean，**「它們在每一個角色裡都還在」**。庫存服務的 relay 看自己的行程：沒有任何一個 bean 訂閱 `inventory.stock-changed`，於是每一則都記成「沒有人訂閱」、不送。

修法是把「誰收」與「誰讀」分開：消費者在每一個角色裡都是一個 bean（只有擁有 catalog 的行程真的收訊息，`RabbitConsumers`），分角色的只有讀的那一層：

```java
/**
 * 13 站 5.4：訂單服務裡，庫存「可以賣幾件」的副本（讀模型）。
 *   寫：catalog.stock-levels 消費者 —— 收庫存服務的 inventory.stock-changed，一筆一筆 upsert 進 stock_levels
 *   讀：available() —— 切開的訂單服務裡由 ReplicaStockLevels 交給商品頁、賣家的商品列表、購物車（一句本地的 SQL，不是一次 HTTP）
 *
 * ⚠️ 這個 bean 在每一個角色裡都在，不能只在訂單服務裡：第一版標了 @ConditionalOnServiceRole(ORDER_SERVICE)，副本一則都沒收到 ——
 * 庫存服務的 relay 只送「這個行程裡有人訂閱」的事件（第 12 站 9.2.1），那一份清單來自 EventHandler 這些 bean（第 03 章 3.7.3），
 * 它在庫存服務裡看不到這個消費者，inventory.stock-changed 全部記成 OUTBOX_UNSUBSCRIBED。要分角色的是「誰讀副本」（ReplicaStockLevels），不是消費者。
 * 單體也收、也維護這張表（沒有人讀它）—— 消費者只在擁有 catalog 的行程裡真的收訊息（RabbitConsumers），庫存服務裡它只是讓 relay 知道有人要
 *
 * 版本：同一則事件送兩次，processed_messages 擋得住（EventDispatcher）；擋不住的是**另一則**事件帶著比較舊的值晚到 ——
 * 兩次預留各發一則，重試讓後發的先到（第 12 站 7.5.4）。每一筆都帶著庫存那一列的版本：比較新才寫，舊的直接略過。
 *
 * 重建（5.6）：從庫存服務的快照一頁一頁寫回來，用同一句 UPSERT —— 跟同時進來的事件誰先誰後都沒關係，版本比較新的留下。
 * public：管理員的端點（catalog.internal.web）要呼叫 rebuild()
 */
@Component
public class StockReplica implements EventHandler {
```

代價寫在註解的最後一行：單體也收、也維護這張表，沒有人讀它。`ServiceRoleConsumersTest` 多一個消費者：

```
13 站 3.7：monolith          收 [catalog.stock-levels, inventory.hot-settlement, inventory.hot-stock-return, inventory.order-events, inventory.product-created, notification.order-events, ordering.stock-shortage, payment.refunds]
13 站 3.7：order-service     收 [catalog.stock-levels, notification.order-events, ordering.stock-shortage, payment.refunds]
13 站 3.7：inventory-service 收 [inventory.hot-settlement, inventory.hot-stock-return, inventory.order-events, inventory.product-created]
```

### 5.4.5 讀自己剛寫的

補貨之後的回應**不讀副本**：

```java
    public ProductDetail restock(long sellerId, long productId, RestockRequest req) {
        ProductDetail d = readOnly.execute(s -> detailOf(owned(sellerId, productId), 0));
        inventory.restock(productId, req.quantity(), req.note() == null ? "seller-restock" : "seller-restock:" + req.note());
        // 13 站 5.4：這一個不讀副本 —— 賣家剛補了貨，回應要看到自己剛寫的（副本要等事件送到）。問庫存服務：一次讀，在寫之後
        return withAvailable(d, inventory.available(productId));
    }
```

賣家按了「補 50 件」，回應說「現在 60 件」—— 副本要等事件送到（5.5：一百毫秒上下），這時候讀副本會看到補貨之前的 10 件。**自己剛寫的，要讀寫的那一邊。** 補貨本來就是一次遠端呼叫，之後再問一次可售量，多一次往返，換賣家不會以為補貨失敗。

### 5.4.6 購物車改問 catalog

購物車第 12 站問的是庫存模組（`InventoryApi.available`）。副本是 catalog 的，所以購物車改問 catalog —— 購物車模組從此不再依賴庫存模組：

```diff
 import org.springframework.transaction.annotation.Propagation;
 import com.example.shop.catalog.CatalogApi;
 import com.example.shop.catalog.ProductSnapshot;
-import com.example.shop.inventory.InventoryApi;
 import com.example.shop.shared.error.ProblemType;
 import com.example.shop.shared.error.ShopException;
 import com.example.shop.shared.error.ConstraintViolations;
…
  * 13 站 1.6：問 catalog（商品快照）、問 inventory（可售量）都在交易「之外」。交易只包住 cart_items 自己的那幾句。
  * 第 12 站的 add/change/remove/view 整個方法是 @Transactional，別的模組的查詢也在裡面 —— 一個行程裡看不出差別，
  * 切開之後那就是「交易開著、等遠端回應」（13 站 0.2.3）。
+ * 13 站 5.4：可售量改問 catalog（CatalogApi.available）—— 切開的訂單服務裡，那是庫存服務的副本，不是一次遠端呼叫。購物車不再依賴庫存模組
  */
 @Service
 public class CartService implements CartApi {
…
 
     private final JdbcTemplate jdbc;
     private final CatalogApi catalog;
-    private final InventoryApi inventory;
     private final TransactionTemplate tx;
 
-    CartService(JdbcTemplate jdbc, CatalogApi catalog, InventoryApi inventory, PlatformTransactionManager tm) {
+    CartService(JdbcTemplate jdbc, CatalogApi catalog, PlatformTransactionManager tm) {
         this.jdbc = jdbc;
         this.catalog = catalog;
-        this.inventory = inventory;
         this.tx = new TransactionTemplate(tm);
     }
 
…
         List<Row> rows = rows(buyerId);
         List<Long> ids = rows.stream().map(Row::productId).toList();
         Map<Long, ProductSnapshot> products = catalog.snapshots(ids);      // 一句 SQL（不是每個品項一句）
-        Map<Long, Integer> available = inventory.available(ids);          // 一句 SQL
+        Map<Long, Integer> available = catalog.available(ids);            // 一句 SQL（13 站 5.4：切開之後是本地的副本）
         Map<Long, List<CartLine>> bySeller = new LinkedHashMap<>();
         for (Row r : rows) {
             ProductSnapshot p = products.get(r.productId());
```

```diff
      * 剛被標成熱點的商品，最多 1 秒內還會走一般的路徑 —— 那條路徑一樣正確，只是比較慢。
      */
     Set<Long> hotProducts(Collection<Long> productIds);
+
+    /**
+     * 13 站 5.4：這幾個商品可以賣幾件（顯示用，US-PRD-3 AC-4：允許最多 5 秒的延遲；真正的判斷在下單時）。
+     * 切開的訂單服務裡是庫存服務的副本（StockReplica），不是一次遠端呼叫。沒有的商品不在結果裡
+     */
+    Map<Long, Integer> available(Collection<Long> productIds);
 }
```

---

## 5.5 過時視窗：晚多久，使用者看到什麼（F2）

讀模型一定會晚：庫存服務的交易 commit 之後，事件要等 relay 掃到 outbox（每 100 ms 一次，第 12 站 7.4.3）、送進 RabbitMQ、訂單服務的消費者寫進副本。F2 量兩件事：

- **A：晚多久。** 每秒 N 張下單（開放式負載，各 3 個品項），每一則 `inventory.stock-changed` 從寫進庫存服務的 outbox（`created_at`）到訂單服務的副本寫好（`processed_messages.processed_at`），隔了多久。兩個庫在同一台 MySQL，是同一個時鐘。
- **B：使用者看到什麼。** 一個只剩 1 件的商品：買家 B 先看了商品頁（「還有 1 件」），買家 A 買走它；B 緊接著也下單，然後每 5 ms 看一次商品頁，看到 0 之前看了多久的「1」。單體與切開的部署各 20 次。

```java
    /** B：最後一件。回傳 B 看到「還有 1 件」的時間（ms）與 B 的下單結果 */
    void lastUnit(Shop shop, String label, java.util.function.BooleanSupplier ready) throws Exception {
        List<Long> stale = new ArrayList<>();
        List<Integer> bOrders = new ArrayList<>();
        int trials = 20;
        for (int t = 0; t < trials; t++) {
            long p = shop.createProduct("最後一件 " + t, 1);
            shop.publish(p);
            Nodes.until(() -> available(shop, p) == 1, 30_000);              // 庫存列建好了、副本（或快取）也看到了
            long a = BUYERS.incrementAndGet(), b = BUYERS.incrementAndGet();
            available(shop, p);                                             // B 先看了一次商品頁：「還有 1 件」
            Shop.Res r = shop.place(a, UUID.randomUUID().toString(), p);    // A 買走它
            if (r.status() != 201) throw new IllegalStateException("A 下單 " + r.brief());
            long t0 = System.nanoTime();
            int bOrder = shop.place(b, UUID.randomUUID().toString(), p).status();   // B 緊接著也下單
            while (available(shop, p) != 0 && System.nanoTime() - t0 < 10_000_000_000L) Thread.sleep(5);
            stale.add((System.nanoTime() - t0) / 1_000_000);
            bOrders.add(bOrder);
        }
        long[] s = stale.stream().mapToLong(x -> x * 1_000_000).sorted().toArray();
        java.util.Map<Integer, Integer> codes = new java.util.TreeMap<>();
        bOrders.forEach(c -> codes.merge(c, 1, Integer::sum));
        out.printf("  B %-30s │ %d 次 │ A 買走之後，商品頁還說「1 件」：p50 %6.0f ms │ max %6.0f ms │ 每一次 %s │ B 緊接著下單 %s%n",
                label, trials, SplitLab.pct(s, 50), SplitLab.pct(s, 100), stale, codes);
    }
```

```bash
mvn test -Pexperiments -Dtest=F2StalenessTest
```

```
═══ 5.5 讀模型的過時視窗（load { 6.03 5.33 5.10 }）═══
  B 單體（商品頁的可售量快取 5 秒）              │ 20 次 │ A 買走之後，商品頁還說「1 件」：p50   4949 ms │ max   4990 ms │ 每一次 [4875, 4960, 4950, 4955, 4966, 4972, 4977, 4957, 4946, 4949, 4947, 4946, 4948, 4978, 4990, 4946, 4942, 4936, 4952, 4937] │ B 緊接著下單 {409=20}
  切開：副本一開始是空的（種子資料直接寫進庫存服務的庫，沒有事件）→ 重建 Rebuilt[pages=2, products=1000, millis=79]
  A 每秒  20 張 × 30 秒 │ 下單 201 600、其他 0 │ stock-changed 600 則 │ 延遲 p50   67.0 ms │ p90  108.0 ms │ p99   124.0 ms │ max   140.0 ms
  A 每秒 100 張 × 30 秒 │ 下單 201 3,000、其他 0 │ stock-changed 3,000 則 │ 延遲 p50   96.0 ms │ p90  149.0 ms │ p99   269.0 ms │ max   455.0 ms
  B 切開（副本）                         │ 20 次 │ A 買走之後，商品頁還說「1 件」：p50     87 ms │ max    112 ms │ 每一次 [112, 84, 94, 93, 83, 86, 90, 87, 99, 94, 85, 84, 91, 93, 95, 83, 85, 84, 91, 83] │ B 緊接著下單 {409=20}
  （結束時 load { 6.50 5.47 5.19 }）
```

跑了兩次：

| | 第 1 次 | 第 2 次（上面那一份） |
|---|---|---|
| A 每秒 20 張：p50 / p99 / 最多 | 63 / 132 / 205 ms | 67 / 124 / 140 ms |
| A 每秒 100 張：p50 / p99 / 最多 | 101 / 322 / 410 ms | 96 / 269 / 455 ms |
| B 單體（快取 5 秒）：p50 / 最多 | 4,949 / 4,985 ms | 4,949 / 4,990 ms |
| B 切開（副本）：p50 / 最多 | 80 / 98 ms | 87 / 112 ms |
| B 緊接著下單 | 單體 409 × 20、切開 409 × 20 | 單體 409 × 20、切開 409 × 20 |

四件事：

- **副本晚一百毫秒上下，負載大的時候長尾到幾百毫秒。** 大部分是 relay 的節奏（每 100 ms 掃一次）；每秒 100 張的時候，一則事件要排在更多事件後面。都遠在 AC-4 的 5 秒之內。
- **單體的商品頁，本來就晚將近 5 秒。** 兩次各 20 次，每一次都在 4,875～4,990 ms 之間 —— 第 12 站 6.4.4 的可售量快取（5 秒，AC-4 允許）每一次都被吃滿：B 先看的那一次把「1」放進快取，之後 5 秒都讀它。**切開之後，商品頁反而比單體新得多。** 不是因為讀模型有多快，是因為單體拿 AC-4 的 5 秒換了「不用每一次都讀 MySQL」，而副本本來就在本地，不用再快取。
- **B 看到的「1」是錯的，但 B 買不到。** 兩種部署裡，B 緊接著下單都是 409：真正的判斷在下單時（預留的條件式 UPDATE，第 12 站 4.2.1）。讀模型能錯的，只有「顯示」—— 這就是 5.3 那張表把「可以晚」與「不能晚」分開的理由。
- **使用者看到的是這個序列**：「還有 1 件」→ 按下結帳 → 「庫存不足」→ 重新整理 → 「0 件」。AC-4 把它寫成「體驗問題」（12 站 0.4.3 的 📌：價格錯了是法律問題，庫存顯示錯了只是體驗問題）。如果這個序列讓客服的電話多到受不了，要改的是需求，不是副本 —— 例如「最後 3 件」不顯示確切的數字。

---

## 5.6 重建：從快照開始

副本會壞：第一次上線時它是空的；消費者有一段時間沒在收（第 12 站 7.5.5 的死信）；有人手動改了它。要能從庫存服務的現況重建一份。

README 寫的是「事件重放重建讀模型」：把事件從頭再送一次。這個系統做不到，因為沒有一份從頭開始的事件。RabbitMQ 的佇列在消費者確認之後就把訊息刪掉；庫存服務的 outbox 只留已送出的事件 3 天（第 12 站 0.6.7 的保留期限，7.4.4 的 `OutboxMaintenance`）。就算三天內的都還在，第一次上線時，舊的商品也從來沒有發過 `stock-changed`（5.6.4）。要能從頭重放，事件得存在一個不會刪的地方，這個系統沒有。所以重建從**現況**開始：庫存服務給一份快照，每一筆帶著版本。

### 5.6.1 快照端點

```java
    /**
     * 13 站 5.6：重建讀模型用的快照 —— productId 比 afterProductId 大的前 limit 個商品，依 productId 由小到大（keyset 分頁），
     * 每一個帶著 inventory 那一列現在的版本。不開交易：每一頁各自一句 SELECT，頁與頁之間的改變由事件與版本補上
     */
    List<StockVersion> stockSnapshot(long afterProductId, int limit);
```

```java
package com.example.shop.inventory;

/** 13 站 5.6：一個商品現在的可售量，與 inventory 那一列的版本（重建讀模型時，從快照開始）。5.7：多一個熱點旗標 */
public record StockVersion(long productId, int available, long version, boolean hot) {}
```

`GET /internal/inventory/v1/stock/snapshot?after=…&limit=…`：依 productId 由小到大、keyset 分頁（第 02 章 2.6.4 的做法），一頁最多 1,000 個。**不開交易**：每一頁各自一句 SELECT，頁與頁之間的改變由事件補上。

### 5.6.2 重建：用同一句 upsert

```java
    /**
     * 13 站 5.6：從庫存服務的快照重建 —— 第一次上線（副本是空的）、懷疑它漏了事件、或者整個砍掉重來。
     * 不清空：清空的那一刻起到重建完，商品頁會看到 0。直接覆蓋，舊的版本自然被蓋掉，新的版本（重建途中進來的事件）不會被快照蓋回去。
     * changed_at：快照那一頁讀到的時間（庫存那一邊「改」的時間不在快照裡）
     */
    public Rebuilt rebuild(int pageSize) {
        long t0 = System.nanoTime(), after = 0;
        int pages = 0, products = 0;
        while (true) {
            Timestamp at = Timestamp.from(Instant.now());
            List<StockVersion> page = inventory.stockSnapshot(after, pageSize);
            if (page.isEmpty()) break;
            jdbc.batchUpdate(UPSERT, page.stream().map(v -> new Object[]{v.productId(), v.available(), v.hot(), v.version(), at}).toList());
            pages++;
            products += page.size();
            after = page.get(page.size() - 1).productId();
            if (page.size() < pageSize) break;
        }
        return new Rebuilt(pages, products, (System.nanoTime() - t0) / 1_000_000);
    }
```

**不先清空。** 清空的那一刻起到重建完，每一個商品都是 0 件。直接覆蓋：快照裡的版本比副本舊（重建途中，事件已經寫進比較新的值），那一筆就不動；比副本新，就寫。重建與事件誰先誰後，結果都一樣 —— 這是版本換來的。

`StockReplicaTest` 把「重建途中進來一則事件」釘住：事件先寫了版本 6，快照讀到的是版本 5：

```
5.6 重建：Rebuilt[pages=2, products=3, millis=11]；之後 {9900913=0, 9900912=10, 9900911=4}
```

管理員的端點只在切開的訂單服務裡（單體沒有副本）：

```java
package com.example.shop.catalog.internal.web;

import com.example.shop.catalog.internal.StockReplica;
import com.example.shop.shared.config.ConditionalOnServiceRole;
import com.example.shop.shared.config.ServiceRole;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.Role;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 13 站 5.6：重建庫存的副本（StockReplica）。只在切開的訂單服務裡（單體沒有副本）。
 * 第一次上線、或懷疑副本漏了事件時，由值班的人打一次；可以重複打（每一筆都比版本，重建途中進來的事件不會被蓋掉）
 */
@RestController
@ConditionalOnServiceRole(ServiceRole.ORDER_SERVICE)
class AdminStockLevelsController {

    private final StockReplica replica;

    AdminStockLevelsController(StockReplica replica) { this.replica = replica; }

    @PostMapping("/api/admin/stock-levels/rebuild")
    StockReplica.Rebuilt rebuild(CurrentUser user) {
        user.require(Role.ADMIN);
        return replica.rebuild(500);
    }
}
```

### 5.6.3 `>` 還是 `>=`

守門的比較可以寫成 `>`：版本**比較新**才寫。先看「副本壞了」有哪幾種：

| 壞法 | 副本那一列 | 快照那一列 | `>` | `>=` |
|---|---|---|---|---|
| 漏了事件（消費者有一段時間沒在收） | 舊的版本、舊的值 | 新的版本 | 修好 | 修好 |
| 整列不見 | —— | 有 | 修好（新增） | 修好 |
| **值錯了、版本一樣**（有人手動改了它；一個寫錯的消費者） | 同一個版本、錯的值 | 同一個版本、對的值 | **修不好** | 修好 |

同一個版本就是庫存那一列的同一個狀態，再寫一次無害；比較新的版本（重建途中的事件）照樣不會被快照蓋掉。所以用 `>=`。F3 用 `>=` 跑一次，再把 `>` 也跑一次，確認推論：

```bash
mvn test -Pexperiments -Dtest=F3RebuildTest
```

庫存服務 10 萬個商品（1,000 個是下單用的，其餘直接寫進庫存服務的庫）。① 第一次上線：副本是空的，打一次重建。② 弄壞三種各 100 列，每秒 20 張下單的同時再重建一次，事件都送完之後逐列比對：

```
═══ 5.6 重建讀模型：10 萬個商品（load { 6.50 5.47 5.19 }）═══
  庫存服務：100,000 個商品；副本：0 列
  ① 第一次上線，重建 → 200 {"pages":200,"products":100000,"millis":2572}（HTTP 來回 2,629 ms）；對不上的 0 列
  ② 弄壞之後：對不上的 300 列（值錯了、版本一樣 100；不見了 100；漏了事件 100）
  ② 每秒 20 張下單的同時重建 → 200 {"pages":200,"products":100000,"millis":2445}；下單 201 171、其他 0
     事件都送完之後：對不上的 0 列（10 萬列逐列比對）
  （結束時 load { 5.65 5.39 5.16 }）
```

守門的比較暫時改成 `>`，同一個實驗：

```
     事件都送完之後：對不上的 100 列（10 萬列逐列比對）
```

**100 列 —— 剛好是「值錯了、版本一樣」的那 100 列。**

### 5.6.4 副本是空的時候

F1 在這一章的程式碼上，重建副本之前，商品頁的回應是這樣：

```
  副本還沒建：商品詳情 → {"id":9000008,"sellerId":900001,"name":"d00 商品 7","description":null,"price":100.00,"categoryId":1,"status":"ON_SALE","available":0}
  重建副本 → 200 {"pages":2,"products":1000,"millis":72}；商品詳情 → {"id":9000008,"sellerId":900001,"name":"d00 商品 7","description":null,"price":100.00,"categoryId":1,"status":"ON_SALE","available":10000000}
```

種子資料是直接寫進庫存服務的庫的，沒有事件 —— 副本是空的，**每一個商品都是 0 件**。第一次上線就是這個樣子：舊的商品從來沒有發過 `stock-changed`。下單不受影響（預留問的是庫存服務），但每一個頁面都說賣完了。

這一章沒有把重建自動化：部署之後打一次 `POST /api/admin/stock-levels/rebuild` 是部署流程的一步（1,000 個商品 72～84 ms、10 萬個 2,166～2,572 ms）。要讓「副本還沒建好」的訂單服務不要接流量，是 readiness 的事，做在第 09 章。

第 09 章在灰度之前量到了這一節說的樣子：訂單服務接著單體的庫上線，副本只有「有過 `stock-changed` 的商品」，權重還是 0 的時候兩邊各送一次商品頁，一半的商品訂單服務說 0 件（9.4.4）。灰度讓它不能再靠人記得打重建：權重一調上去，沒建好的那一台馬上接到流量。所以第 09 章做了 `StockReplicaHealthIndicator`：訂單服務起來之後先數「有幾個商品不在副本裡」，有就自己重建，重建成功之前 readiness 是 DOWN。它只在起來的那一刻檢查一次（9.4.5）。

---

## 5.7 熱點名單：旗標搬回庫存

### 5.7.1 為什麼它也是一個跨服務的查詢

第 01 章 1.3.3：「這個商品是不是熱點」是庫存的規則（要不要過閘門），旗標卻存在商品的表上（`products.hot`），由訂單模組轉手。第 03、04 章都沒有搬，理由是同一個：

> 庫存模組要有自己的一份熱點旗標，而且下單時讀它不能碰 MySQL（第 12 站 6.5 的前提）—— 等於在庫存模組裡再做一次第 12 站 6.4 的快取。（第 03 章 3.4.7）

搬了之後，下單時要知道「這幾個品項哪些是熱點」，就是去問擁有者 —— 一次跨服務的查詢。每一張訂單問一次（API 組合）：每一張訂單多一次往返，第 03 章 3.4.3 才剛把「空的呼叫」拿掉；搶購的時候，兩千個搶的人每一個都打一次庫存服務。另一個做法就是這一章的讀模型：旗標跟著 `stock-changed` 送到副本。

### 5.7.2 庫存擁有旗標

```sql
-- 13 站 5.7：熱點旗標搬回庫存（第 01 章 1.3.3 看出來、第 03、04 章都沒有搬的那一個）。「這個商品要不要過閘門」是庫存的規則，
-- 旗標卻存在商品的表上、由訂單模組轉手。之後由庫存服務改它（PUT /products/{id}/hot），跟著 inventory.stock-changed 送到訂單服務的副本。
-- 只改資料字典（ALGORITHM=INSTANT）；索引是下一個檔案（第 12 站 2.2.2 規則二：一個檔案一句 DDL）
ALTER TABLE inventory ADD COLUMN hot BOOLEAN NOT NULL DEFAULT FALSE, ALGORITHM=INSTANT;
```

```sql
-- 13 站 5.7：「全部的熱點商品」每秒讀一次（catalog 的 HotProducts）。索引不是 INSTANT —— INPLACE、不鎖寫（標成熱點的商品很少，這個索引很小）
ALTER TABLE inventory ADD INDEX idx_inventory_hot (hot), ALGORITHM=INPLACE, LOCK=NONE;
```

副本也帶著它（V32、V33，`stock_levels.hot` 與索引，5.11.1）。

⚠️ 加欄位、加索引不能寫在同一個檔案裡。寫成兩個檔案、每個檔案兩句，整套測試跑下去，第 12 站的 `MigrationOwnershipTest` 會紅：

```
✗ V31__catalog_stock_levels_hot.sql：有 2 句 DDL；V10 之後一個檔案只能有一句（MySQL 的 DDL 會各自 commit）
✗ V30__inventory_hot_flag.sql：有 2 句 DDL；V10 之後一個檔案只能有一句（MySQL 的 DDL 會各自 commit）
Expecting empty but was: ["V31__catalog_stock_levels_hot.sql：有 2 句 DDL；V10 之後一個檔案只能有一句（MySQL 的 DDL 會各自 commit）",
"V30__inventory_hot_flag.sql：有 2 句 DDL；V10 之後一個檔案只能有一句（MySQL 的 DDL 會各自 commit）"]
Expecting empty but was: ["新增 POST /api/admin/hot-flags/copy-to-inventory"]
Expecting empty but was: ["V31__catalog_stock_levels_hot.sql：有 2 句 DDL；V10 之後一個檔案只能有一句（MySQL 的 DDL 會各自 commit）",
"V30__inventory_hot_flag.sql：有 2 句 DDL；V10 之後一個檔案只能有一句（MySQL 的 DDL 會各自 commit）"]
```

第 12 站 2.2.2 的規則二：一個檔案一句 DDL —— MySQL 的 DDL 各自 commit，第二句失敗時第一句已經生效，Flyway 卻把整個檔案記成失敗。所以拆成四個檔案。

`setHot` 不再是 MANDATORY，它是庫存自己的交易：

```java
    @Override
    @Transactional
    public void setHot(long productId, boolean isHot) {
        // 13 站 5.7：旗標存在 inventory 那一列。改了才加版本、發 stock-changed（同一個值再設一次：什麼都不改，Redis 照樣確認一次）。
        // 庫存列還沒建立（product.created 還沒送到）也要記得住：先建一列 0 件（跟 restock 一樣，2.7）
        List<Boolean> cur = jdbc.queryForList("SELECT hot FROM inventory WHERE product_id = ? FOR UPDATE", Boolean.class, productId);
        if (cur.isEmpty())
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, version, hot) VALUES (?, 0, 0, 1, ?)", productId, isHot);
        else if (cur.get(0) != isHot)
            jdbc.update("UPDATE inventory SET hot = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = ?", isHot, productId);
        if (cur.isEmpty() || cur.get(0) != isHot) stockChanged(productId, List.of(productId));
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
```

改了才加版本、發事件；同一個值再設一次，什麼都不改。庫存列還沒建立（`product.created` 還沒送到）也要記得住：先建一列 0 件，跟補貨一樣（第 02 章 2.7）。

### 5.7.3 閘門只為熱點商品建

第 12 站的閘門，key 不存在就從 MySQL 建 —— 誰說是熱點，就替誰建。現在庫存自己知道：

```java
    Init initialize(long productId) {
        Optional<DistributedLock.Handle> lock = guard.call("hot-stock.lock", () -> locks.tryLock("lock:" + key(productId), Duration.ofSeconds(2)).orElse(null));
        if (lock.isEmpty()) { sleep(20); return Init.BUSY; }                // 別人在建：等一下再試
        try {
            // 13 站 5.7：只為熱點商品建閘門 —— 旗標在庫存自己的表上（第 12 站是由 catalog 說了算，呼叫端說是熱點就建）
            List<Boolean> hot = jdbc.queryForList("SELECT hot FROM inventory WHERE product_id = ?", Boolean.class, productId);
            if (!hot.isEmpty() && !hot.get(0)) return Init.NOT_HOT;
            // 13 站 2.7：庫存列還沒建立（product.created 還沒送到）—— 不建 key：用 0 建，事件送到之後 Redis 會一直少那些庫存，直到對帳
            List<Integer> rows = jdbc.queryForList(GATE_BASE_SQL, Integer.class, productId);
            if (rows.isEmpty()) { log.warn("HOT_STOCK_NO_ROW productId={}：還沒有庫存列，先不建閘門", productId); return Init.NO_ROW; }
            Integer available = rows.get(0);
            guard.run("hot-stock.init", () -> redis.opsForValue().setIfAbsent(key(productId), String.valueOf(available)));
            return Init.CREATED;
        } finally {
            guard.run("hot-stock.unlock", () -> locks.unlock(lock.get()));
        }
    }
```

庫存說「不是熱點」的那一件，從這一次的閘門裡拿掉、放行：

```java
            // -1：key 不存在 → 從 MySQL 建，再試一次。13 站 5.7：庫存說它不是熱點（呼叫端的名單過時了）→ 這一件不過閘門、不算一次嘗試：
            // 它照樣走預留的熱點那一路（只寫預留列、落帳時才計入，7.6），MySQL 才是最後一道防線 —— 慢一點，結果一樣正確
            if (initialize(productId) == Init.NOT_HOT) sorted.remove(i - 1); else attempt++;
```

為什麼可以放行：那一件照樣走熱點那一路的預留 —— 只寫預留列、落帳時才計入（第 12 站 7.6）—— MySQL 的條件式 UPDATE 才是最後一道防線。慢一點，結果一樣正確。

商品頁的「熱點商品讀閘門」（第 12 站 6.5）也不再看呼叫端說的 `hot`：閘門的 key 只為熱點商品建，有 key 就是熱點。`?hot=` 參數留著 —— 線上那一版（第 03 章）的訂單服務還會送。

### 5.7.4 名單：每秒一次

catalog 的 `hotProducts`（下單時 ordering 問它）不再讀 `products.hot`：

```java
/**
 * 13 站 5.7：「下單時哪些品項是熱點」。第 12 站讀商品快取的 products.hot（6.5：搶不到的人不碰 MySQL）；旗標搬到庫存之後，
 * 改讀 StockLevels.hotProducts() —— 但不能每一張訂單讀一次：那會讓 2,000 個搶的人每一個都碰一次 MySQL（單體：庫存的表；切開：副本）。
 * 所以記在記憶體裡，每秒最多重讀一次：一個行程每秒一句 SQL，跟流量無關。標成熱點的商品通常只有幾個，整份名單放得下。
 *
 * 會晚：最多 1 秒（加上切開之後副本的延遲，5.5）。兩個方向都安全 ——
 *   剛標成熱點、名單還沒有它 → 這一張走一般的預留（MySQL 的條件式 UPDATE），正確，只是比較重
 *   剛取消熱點、名單還有它  → 這一張去過閘門，庫存服務說它不是熱點，不扣（HotStock.gate），照樣走熱點那一路的預留、落帳時計入
 * 重讀失敗（庫存模組、副本讀不到）→ 留著上一份，記一行日誌
 */
@Component
class HotProducts {

    private static final Logger log = LoggerFactory.getLogger(HotProducts.class);
    private final StockLevels stock;
    private final long ttlNanos;
    private volatile Set<Long> ids = Set.of();
    private volatile long loadedAt;
    private volatile boolean loaded;

    HotProducts(StockLevels stock, com.example.shop.shared.config.ShopProperties props) {
        this.stock = stock;
        this.ttlNanos = props.inventory().hotListRefresh().toNanos();       // 預設 1 秒；測試設成 0（每一次都讀）
    }

    Set<Long> current() {
        if (!loaded || System.nanoTime() - loadedAt >= ttlNanos) reload();
        return ids;
    }

    private synchronized void reload() {
        long now = System.nanoTime();
        if (loaded && ttlNanos > 0 && now - loadedAt < ttlNanos) return;    // 等鎖的時候，別人已經讀好了
        try {
            ids = Set.copyOf(stock.hotProducts());
        } catch (RuntimeException e) {
            log.warn("HOT_PRODUCTS_RELOAD_FAILED 留著上一份 {}：{}", ids, e.toString());
        }
        loadedAt = now;
        loaded = true;
    }
}
```

一個行程每秒一句 SQL（`idx_inventory_hot`、`idx_stock_levels_hot`），跟流量無關 —— 第 12 站 6.5 的前提（搶不到的人不碰 MySQL）仍然成立。

測試會重用同一個 Spring context：前一個測試讀好的名單，會留給下一個測試，剛標成熱點的商品要等一秒才算熱點。所以 `shop.inventory.hot-list-refresh` 在測試裡是 0（每一次都讀），名單晚一秒是怎樣，另外用一個設成 1 秒的測試釘住。

### 5.7.5 晚一秒，兩個方向

```
剛標成熱點，名單還沒有它                       剛取消熱點，名單還有它
ordering：這一件不是熱點                         ordering：這一件是熱點
  → 一般的預留：MySQL 條件式 UPDATE，直接計入        → 過閘門：庫存說不是熱點 → 不扣、不建 key
  → 閘門沒有扣（Redis 比 MySQL 多 1）                → 熱點那一路的預留：只寫預留列，落帳時計入
```

`HotListStaleTest`（`ordering.internal`，`hot-list-refresh=1s`）：

```
5.7 ① 剛標成熱點：第一張 {reserved=1, counted=1, item_hot=0}、閘門 5；一秒之後第二張 {reserved=1, counted=0, item_hot=1}、閘門 4
5.7 ② 剛取消熱點：下單之後 {reserved=0, counted=0, item_hot=1}、閘門的 key 在嗎 false；落帳之後 {reserved=1, counted=1, item_hot=1}
```

① 的 Redis 比 MySQL 多 1，是第 12 站 6.5.3 說的「偏高」—— 多放一個人進 MySQL，MySQL 擋得住；熱點對帳會修（安靜的時候一兩分鐘，第 04 章 4.2.2）。② 的閘門 key 沒有被建回來（名單晚的那一秒，不會讓一個已經不是熱點的商品又有閘門）。**兩個方向，MySQL 的帳都對。**

如果名單錯的不是一秒、是很久呢？方向 ① 的後果是那個商品的搶購全部走 MySQL —— 第 12 站 6.5 之前的樣子：正確，但 2,000 個搶的人都在 MySQL 排隊。方向 ② 的後果只是每一張多一次閘門的往返。

### 5.7.6 誰改旗標：先擁有者，再舊的副本

```java
    /**
     * 6.5 標記熱點商品（0.6.1 第 3 條：由賣家標記 hot=true）。熱點商品的下單先過 Redis 的閘門。
     * 庫存的 Redis 副本由 inventory 在 commit 之後建立（InventoryApi.setHot）
     *
     * 13 站 5.7：旗標的擁有者是庫存（inventory.hot）。順序：確認是你的商品（catalog 自己的唯讀交易）→ 庫存改旗標（它自己的交易，
     * 不在 catalog 的交易裡 —— B1 上最後一個「交易內的跨模組呼叫」）→ products.hot（過渡期留著的舊副本，沒有人再用它做決定；第 09 章收縮）。
     * 庫存那一步失敗：什麼都沒改（503）；products.hot 那一步失敗：只有舊副本落後，下單照樣看庫存的
     */
    public ProductDetail setHot(long sellerId, long productId, boolean hot) {
        readOnly.execute(s -> owned(sellerId, productId));
        inventory.setHot(productId, hot);
        ProductDetail d = tx.execute(s -> {
            Product p = owned(sellerId, productId);
            if (p.markHot(hot, clock.instant())) refreshCacheAfterCommit(p);
            return detailOf(p, 0);
        });
        return withAvailable(d, stock.available(productId));
    }
```

順序的理由寫在註解裡：庫存那一步失敗，什麼都沒改（503）；`products.hot` 那一步失敗，只有舊的副本落後，沒有人再用它做決定。`products.hot` 這一欄還在 —— 擴充、遷移、收縮（第 03 章 3.8.5 的表）的「遷移」這一步；拿掉它是收縮（5.7.9）。

**這一個呼叫移出了 catalog 的交易**：`CrossModuleCallInTxTest`（第 01 章 1.6.6）的清單少了 `catalog → InventoryApi.setHot`，6 → 5 種 —— 剩下的 5 種全部在訂單服務自己的庫裡。

### 5.7.7 搬家：已經是熱點的商品

第 05 章之前標的熱點，旗標只在 `products.hot`。部署這一版之後，那些商品在庫存那邊不是熱點：搶購時走一般的預留（方向 ① 的樣子）。一個管理員的端點把它們抄過去：

```java
    /**
     * 13 站 5.7：搬家 —— 第 05 章之前標成熱點的商品，旗標只在 products.hot。部署這一版之後，由管理員打一次，把它們抄到庫存（setHot 冪等：
     * 已經是熱點的不會再發事件）。在那之前，那些商品的下單不過閘門、走一般的預留：正確，只是搶購時比較慢（HotProducts 的註解）
     * @return 抄了幾個
     */
    public int copyHotFlagsToInventory() {
        List<Long> ids = readOnly.execute(s -> products.findHotIds());
        for (long id : ids) inventory.setHot(id, true);
        return ids.size();
    }
```

不能寫成一個 migration：庫存的資料夾讀不到 `products`（第 02 章 2.4.5 的 `ServiceDatabaseTest`：每個服務的庫只有自己的表）。`HotToggleApiTest` 多一個：

```
5.7 搬家：200 {"copied":1}；inventory.hot 0 → 1；閘門 stock:9900881 = 5
```

### 5.7.8 測試的資料

整套跑下去，20 個紅：

```
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.026 s <<< FAILURE! -- in com.example.shop.architecture.MigrationOwnershipTest
[ERROR] Tests run: 11, Failures: 2, Errors: 0, Skipped: 0, Time elapsed: 103.7 s <<< FAILURE! -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[ERROR] Tests run: 6, Failures: 3, Errors: 2, Skipped: 0, Time elapsed: 0.426 s <<< FAILURE! -- in com.example.shop.ordering.internal.HotSettlementTest
[ERROR] Tests run: 8, Failures: 1, Errors: 1, Skipped: 0, Time elapsed: 21.30 s <<< FAILURE! -- in com.example.shop.ordering.internal.EventFlowTest
[ERROR] Tests run: 2, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 1.102 s <<< FAILURE! -- in com.example.shop.ordering.internal.ShipCheckOutsideTxTest
[ERROR] Tests run: 5, Failures: 1, Errors: 1, Skipped: 0, Time elapsed: 1.005 s <<< FAILURE! -- in com.example.shop.ordering.internal.PlaceOrderSagaTest
[ERROR] Tests run: 5, Failures: 4, Errors: 0, Skipped: 0, Time elapsed: 0.200 s <<< FAILURE! -- in com.example.shop.ordering.internal.HotStockFlowTest
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 1.173 s <<< FAILURE! -- in com.example.shop.dist01.CrossModuleCallInTxTest
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.129 s <<< FAILURE! -- in com.example.shop.api.HotToggleApiTest
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.804 s <<< FAILURE! -- in com.example.shop.api.OpenApiContractTest
```

15 個的原因一樣：測試的資料直接寫 `INSERT INTO products (…, hot) VALUES (…, TRUE)` —— 旗標不在那裡了，那些商品走的是一般的預留。改成在庫存列上標（`INSERT INTO inventory (…, hot) …`，或者再補一句 `UPDATE inventory SET hot = TRUE`），每一個檔案一行（`CapstoneAcceptanceTest` 兩處）。其餘幾個各有原因：migration 一個檔案兩句（5.7.2）、`CrossModuleCallInTxTest` 清單上的那一種沒被走到（這是要的結果，從清單拿掉）、OpenAPI 的快照多一支管理員的路由（只有新增）、`stock-changed` 的聚合類型（5.4.2）、`HotToggleApiTest`（標了熱點馬上下單 —— 名單在測試裡那時還是 1 秒）。

第 12 站與前幾章的實驗裡，直接寫 `products.hot` 的有 6 個（`E7FlashSaleLoadTest`、`G8`、`H6`、`H8`、`ExternalDrill`、`ExternalLoad`），一樣改成在庫存列上標；用 API 標熱點的（第 03、04 章的實驗）不用改。

### 5.7.9 收縮 —— 拿掉 `products.hot`

這一節的程式碼在 `d09` 分支上，實驗要第 08、09 章的 kind 環境。

5.7.6 說 `products.hot` 是過渡期留著的舊副本。這裡做擴充、遷移、收縮（第 03 章 3.8.5 的表）的最後一步：拿掉它。

收縮是兩件事：程式不再讀寫那一欄，以及刪掉那一欄。順序只能是這樣，而且是**兩次部署**：

1. **第一次部署：程式不讀也不寫它。** `Product` 拿掉 `hot`；`setHot` 只改庫存的旗標；5.7.7 的搬家端點拿掉（它讀 `products.hot` —— 那是遷移那一步的工具，用完了）；`ProductSnapshot`、商品快取的 `Core` 各少一個欄位。欄位還在。
2. **下一次部署：V36 刪掉那一欄。**

第一步的 `ProductService`：

```diff
 
     static ProductCache.Core core(Product p) {
         return new ProductCache.Core(p.getId(), p.getSellerId(), p.getName(), p.getDescription(), p.getPrice(), p.getCategory().getId(),
-                p.getStatus(), p.isHot(), p.getVersion());
+                p.getStatus(), p.getVersion());
     }
 
     /** 6.4.1 每一個改商品的方法最後都呼叫它：commit 之後，把新的值（新的版本）寫進快取 */
…
      * 庫存的 Redis 副本由 inventory 在 commit 之後建立（InventoryApi.setHot）
      *
      * 13 站 5.7：旗標的擁有者是庫存（inventory.hot）。順序：確認是你的商品（catalog 自己的唯讀交易）→ 庫存改旗標（它自己的交易，
-     * 不在 catalog 的交易裡 —— B1 上最後一個「交易內的跨模組呼叫」）→ products.hot（過渡期留著的舊副本，沒有人再用它做決定；第 09 章收縮）。
-     * 庫存那一步失敗：什麼都沒改（503）；products.hot 那一步失敗：只有舊副本落後，下單照樣看庫存的
+     * 不在 catalog 的交易裡 —— B1 上最後一個「交易內的跨模組呼叫」）。
+     * 13 站 5.7.9（收縮）：第 05 章之後還會再寫一次 products.hot（過渡期的舊副本）、還有一個把它抄到庫存的
+     * 管理員端點（5.7.7）。沒有人再用它做決定，這一版不讀也不寫它；欄位在下一次部署才刪（V36）—— 同一次部署就刪，還在跑的舊版會壞
      */
     public ProductDetail setHot(long sellerId, long productId, boolean hot) {
-        readOnly.execute(s -> owned(sellerId, productId));
+        ProductDetail d = readOnly.execute(s -> detailOf(owned(sellerId, productId), 0));
         inventory.setHot(productId, hot);
-        ProductDetail d = tx.execute(s -> {
-            Product p = owned(sellerId, productId);
-            if (p.markHot(hot, clock.instant())) refreshCacheAfterCommit(p);
-            return detailOf(p, 0);
-        });
         return withAvailable(d, stock.available(productId));
     }
 
-    /**
-     * 13 站 5.7：搬家 —— 第 05 章之前標成熱點的商品，旗標只在 products.hot。部署這一版之後，由管理員打一次，把它們抄到庫存（setHot 冪等：
-     * 已經是熱點的不會再發事件）。在那之前，那些商品的下單不過閘門、走一般的預留：正確，只是搶購時比較慢（HotProducts 的註解）
-     * @return 抄了幾個
-     */
-    public int copyHotFlagsToInventory() {
-        List<Long> ids = readOnly.execute(s -> products.findHotIds());
-        for (long id : ids) inventory.setHot(id, true);
-        return ids.size();
-    }
-
     /**
      * 補貨只改 inventory 的表。第 12 站把「確認是你的商品」與「補貨」包在 catalog 的同一個交易裡 —— 那個交易只為了讓 inventory.restock()
      * 加入它；catalog 自己什麼都沒寫。13 站 1.6：先確認（catalog 自己的唯讀交易），再補貨（inventory 自己的交易）
…
     public Map<Long, ProductSnapshot> snapshots(Collection<Long> productIds) {
         if (productIds.isEmpty()) return Map.of();
         return products.findAllById(productIds).stream()
-                .map(p -> new ProductSnapshot(p.getId(), p.getSellerId(), p.getName(), p.getPrice(), p.getStatus(), p.isHot()))
+                .map(p -> new ProductSnapshot(p.getId(), p.getSellerId(), p.getName(), p.getPrice(), p.getStatus()))
                 .collect(Collectors.toMap(ProductSnapshot::id, Function.identity()));
     }
 
```

第二步只有一句：

```sql
-- 13 站第 09 章寫完之後的追記（第 05 章 5.7.9）：收縮。第 05 章起熱點的旗標在 inventory.hot，products.hot 只是過渡期的舊副本；
-- 上一次部署之後，程式不讀也不寫它。所以這一次部署才刪 —— 同一次部署就刪，migration 先跑、舊版的 pod 還在接單，每一張下單都會壞（M6）
ALTER TABLE products DROP COLUMN hot, ALGORITHM=INSTANT;
```

**為什麼要兩次。** 第 08 章 8.4.5 的部署是 migration 的 Job 先跑完，才換應用程式的映像檔。同一次部署就刪，Job 跑完的那一刻，舊版的 pod 還在接單 —— 它的 `Product` 還有 `hot`，每一句讀商品的 SQL 都帶著那一欄。M6 量了這件事：從三個 commit 各建一個映像檔（收縮之前、第一步、第二步），只開單體，每秒 10 張下單：

```bash
mvn test -Pexperiments -Dtest=M6ContractTest -Dm6.before=9a5e7b1 -Dm6.step1=d42b0fd -Dm6.step2=17bc474
```

```
═══ 5.7.9 收縮：刪掉 products.hot。只開單體（shop_d09_mono），每秒 10 張下單；部署 = migration 的 Job 跑完 → 換映像檔（滾動更新）═══
  ① 同一次部署就刪：舊版在跑，部署 step2
    部署 step2：Job 第 15.3～20.7 秒；換映像檔、滾動更新到第 29.4 秒；舊的 pod 第 43.9 秒結束
      Job 之前 15 秒 [201=150] │ Job 跑的時候 [201=22, 500=32] │ Job 跑完 → 舊的 pod 結束 [201=141, 500=91] │ 之後 [201=142]
      舊的 pod（monolith-6dff8fb55d-8qkft）的 ERROR 日誌：{Unknown column 'pN_N.hot' in 'field list'=123, 未預期的例外=123}
    整段：下單 [201=458, 500=123]；不是 201 的格（每 5 秒一格）：15～20 秒 [201=25, 500=25]；20～25 秒 [500=50]；25～30 秒 [201=4, 500=46]；30～35 秒 [201=48, 500=2]
  ② 分兩次：舊版在跑，部署 step1，再部署 step2
    部署 step1：Job 第 15.2～21.2 秒；換映像檔、滾動更新到第 32.4 秒；舊的 pod 第 49.5 秒結束
      Job 之前 15 秒 [201=150] │ Job 跑的時候 [201=59] │ Job 跑完 → 舊的 pod 結束 [201=284] │ 之後 [201=150]
      舊的 pod（monolith-754f5b8dff-p8r8t）的 ERROR 日誌：沒有
    部署 step2：Job 第 64.2～69.6 秒；換映像檔、滾動更新到第 80.4 秒；舊的 pod 第 96.1 秒結束
      Job 之前 15 秒 [201=150] │ Job 跑的時候 [201=54] │ Job 跑完 → 舊的 pod 結束 [201=264] │ 之後 [201=150]
      舊的 pod（monolith-65bc5466b7-cmlbs）的 ERROR 日誌：沒有
    整段：下單 [201=1112]；不是 201 的格（每 5 秒一格）：沒有
  products 的欄位：id,seller_id,category_id,name,description,price,status,created_at,updated_at,version
```

- **① 同一次部署就刪：123 張 500。** Job 在第 15.3～20.7 秒跑，DROP 在 Job 的途中就生效了；滾動更新第 29.4 秒做完，舊的那一個從入口後面拿掉之後，500 才停。舊的 pod 記了 123 行 `Unknown column 'pN_N.hot'` —— 每一張下單都要讀商品（`CatalogApi.snapshots`），每一次讀都帶著那一欄。
- **② 分兩次：1,112 張，全部 201。** 第一次部署換上不碰那一欄的程式，那幾十秒新舊兩版同時在跑，欄位都還在，誰都沒事；第二次 DROP 的時候，跑著的已經是不碰它的那一版。

**滾動更新那幾十秒，兩版共用一份快取。** 商品快取（Redis，第 12 站 6.4）裡放的是 `Core` 的 JSON：舊版寫的多一個 `"hot"`，新版寫的少一個。兩邊都要讀得懂對方 —— Spring Boot 的 `ObjectMapper` 不因為多出來的欄位失敗，缺的 primitive 給預設值。`ProductCacheTest` 多一個測試把它釘住：

```
收縮：舊版寫的 {"id":9900601,"sellerId":2,"name":"x","description":null,"price":100.00,"categoryId":11,"status":"ON_SALE","hot":true,"version":3} → 新版讀到 version 3；新版寫的 {"id":9900601,"sellerId":2,"name":"x","description":null,"price":100.00,"categoryId":11,"status":"ON_SALE","version":4} → 舊版讀到 hot=false
```

**誰還在寫那一欄。** 第一步之後，正式程式碼一行都不碰它。可是只加上 V36 跑整套：

```
[ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0 <<< FAILURE! -- in com.example.shop.schema.InvariantReconciliationTest
[ERROR] Tests run: 11, Failures: 0, Errors: 3, Skipped: 0 <<< FAILURE! -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[ERROR] Tests run: 6, Failures: 0, Errors: 6, Skipped: 0 <<< FAILURE! -- in com.example.shop.ordering.internal.HotSettlementTest
[ERROR] Tests run: 8, Failures: 0, Errors: 8, Skipped: 0 <<< FAILURE! -- in com.example.shop.ordering.internal.EventFlowTest
[ERROR] Tests run: 2, Failures: 0, Errors: 2, Skipped: 0 <<< FAILURE! -- in com.example.shop.ordering.internal.ShipCheckOutsideTxTest
[ERROR] Tests run: 5, Failures: 0, Errors: 5, Skipped: 0 <<< FAILURE! -- in com.example.shop.ordering.internal.PlaceOrderSagaTest
[ERROR] Tests run: 5, Failures: 0, Errors: 5, Skipped: 0 <<< FAILURE! -- in com.example.shop.ordering.internal.HotStockFlowTest
[ERROR] Tests run: 375, Failures: 0, Errors: 30, Skipped: 0
```

7 個類別、30 個錯，全部是 `Unknown column 'hot' in 'field list'` —— 測試自己種資料的那一句還寫著 `products.hot`（5.7.8 那時候是「或者再補一句 `UPDATE inventory SET hot = TRUE`」，舊的那一句沒有拿掉）。加上不在預設測試組裡的實驗、負載與演練的工具，寫著它的一共 18 個檔案（第二步改了 19 個測試的檔案，另一個只是註解）。其中一個不是測試，是種資料的工具（`SeedData`）：它把 1 號商品標成熱點，寫的是 `products.hot` —— 第 05 章之後旗標在 `inventory.hot`，1 號商品從那時候起就不是熱點了，一直沒有人發現。改成寫 `inventory.hot`。

**一支 API 拿掉了。** 5.7.7 的 `POST /api/admin/hot-flags/copy-to-inventory`。OpenAPI 的快照比對（第 12 站 3.8.2）說：

```
  △ ⚠ 刪除 POST /api/admin/hot-flags/copy-to-inventory（破壞性變更）
```

這是刻意的（只有管理員在搬家的時候打一次），更新快照。

兩步各跑一次整套（`mvn clean verify`），都是 375 個、failsafe 39 個，全綠。

---

## 5.8 報表該不該直連別人的資料庫

第 12 站的報表（`reporting` 模組：銷售報表、熱銷排行、趨勢）讀五張表：`orders`、`order_items`、`refunds`、`products`、`users`。B1 數出來，`reporting` 這一刀「直接讀表 5」（1.5）。這五張表都在訂單服務的庫裡 —— **庫存這一刀不切斷報表**（第 02 章 2.6.7）。所以這一章沒有一份報表要改。

但第 04 章讓報表多了兩個要排除的狀態（`RESERVING`、`REJECTED`，4.5.6）：報表的 SQL 知道訂單的內部狀態。這就是「報表直連別人的資料庫」的代價，只是現在還在同一個服務裡，看不出來。如果下一刀切的是訂單（或報表自己變成一個服務），有三條路：

| | 直連別人的庫（唯讀帳號） | 讀模型（報表自己的庫，收事件） | API 組合（報表問各個服務） |
|---|---|---|---|
| 做法 | 一個只看得到那五張表的唯讀帳號 | 收 `order.*` 等事件，寫成報表要的形狀（例如一天一列） | 每一張報表即時問訂單服務、商品服務…… |
| 晚多久 | 不晚（或晚一個唯讀副本的複寫延遲） | 事件的延遲（5.5 的量級） | 不晚 |
| 誰綁住誰 | **表的形狀變成契約**：訂單服務改一個欄位、加一個狀態，報表就壞（4.5.6 的兩個狀態就是例子） | 事件是契約（第 03 章 3.8.6：可以用 message pact 守） | API 是契約；大範圍的彙總（一個月的銷售）要搬很多資料 |
| 重建 | 不需要 | 需要（從快照開始，5.6；要從頭重放，事件得一直留著） | 不需要 |

**這個系統的答案**：報表是訂單資料的另一種讀法，**它該跟著訂單**。只要訂單沒有切出去，報表留在訂單服務、讀自己的庫；如果有一天訂單切出去，報表跟著它走，或者改成讀模型 —— 不給一個唯讀帳號讓它直連，因為那會讓訂單的表再也不能自由地改。第 02 章 2.4.4 留下的「每個服務一個資料庫帳號」這一章也沒有做：現在兩個服務各自只有一個庫、一個應用程式帳號，唯讀帳號沒有對象。

---

## 5.9 契約跟著改

訂單服務怎麼用庫存服務，這一章變了三件事。呼叫端的契約（第 03 章 3.8.3）照實改：

- **拿掉**「商品頁顯示用的可售量」（`GET /stock/{id}/display`）—— 訂單服務的商品頁讀副本，不再打它。`RemoteInventoryApi.availableForDisplay` 改成丟 `UnsupportedOperationException`：一個沒有人用的遠端呼叫，就是一份沒有人守的契約（跟第 03 章 3.4 拿掉 `initialize` 同一個理由）。**端點本身留著**：線上那一版（第 03 章）的訂單服務還在打，`InventoryProviderReleasedPactIT` 照樣驗證它。
- **新增**「重建副本：可售量與版本的快照」（`GET /stock/snapshot`）。
- **新增**一則事件的契約：`inventory.stock-changed`，訂單服務讀每一筆的 `productId`、`available`、`version`、`hot`。消費者是 `StockReplica`；提供端用真的補貨產生它（第 03 章 3.8.6：每一則只標一次，標在 `InventoryEventMessages`）：

```java
@ExtendWith(PactConsumerTestExt.class)
@PactTestFor(providerName = "inventory-service", providerType = ProviderType.ASYNCH, pactVersion = PactSpecVersion.V4)
class StockChangedPactTest {

    @Pact(consumer = "order-service")
    V4Pact stockChanged(MessagePactBuilder b) {
        return b.expectsToReceive("inventory.stock-changed：補貨之後的可售量")
                .withContent(new PactDslJsonBody().minArrayLike("items", 1)
                        .integerType("productId", 9001).integerType("available", 15).integerType("version", 3).booleanType("hot", false)
                        .closeObject().closeArray())
                .toPact(V4Pact.class);
    }

    @Test @PactTestFor(pactMethod = "stockChanged")
    void stockChanged(V4Interaction.AsynchronousMessage m) throws Exception {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        new StockReplica(jdbc, mock(InventoryApi.class)).handle(new Event("pact-stock", "inventory.stock-changed", "INVENTORY", 9001, Instant.now(),
                new ObjectMapper().readTree(m.getContents().getContents().valueAsString()), 1));
        verify(jdbc).update(eq(StockReplica.UPSERT), eq(9001L), eq(15), eq(false), eq(3L), any(Timestamp.class));
    }
}
```

`InventoryApi.hotProducts()` 在 `RemoteInventoryApi` 裡也是丟例外、沒有端點 —— 切開的訂單服務讀副本的熱點名單。

提供端這一份契約從 17 個互動變成 18 個：16 個 HTTP（少一個顯示、多一個快照）、2 則事件（`hot-settlement-failed`、`stock-changed`）。

---

## 5.10 流程測試與追溯表

### 5.10.1 這一章新增的測試與實驗

| 名稱 | 種類 | 跑在哪裡 | 守什麼／量什麼 |
|---|---|---|---|
| `StockChangedEventsTest` | 測試 | Testcontainers（單體） | 可售量每一次改變都發一則 `stock-changed`，帶著版本；出庫不發（5.4.2） |
| `StockReplicaTest` | 測試 | Testcontainers | 亂序、重複只留最新的版本；重建途中的事件不會被快照蓋回去（5.4.3、5.6.2） |
| `HotListStaleTest` | 測試 | Testcontainers（`hot-list-refresh=1s`） | 熱點名單晚一秒的兩個方向（5.7.5） |
| `HotToggleApiTest` | 測試（多一個） | Testcontainers | 取消熱點之後 `inventory.hot` 也是 false；舊旗標搬家（5.7.7） |
| `StockChangedPactTest` | 契約（呼叫端） | 不用 Spring | 訂單服務的副本讀 `stock-changed` 的哪幾個欄位（5.9） |
| `ServiceRoleConsumersTest`、`CrossModuleCallInTxTest`、`TableOwnershipTest` | 測試（改） | —— | 多一個消費者（5.4.4）；交易內的跨模組呼叫 6 → 5（5.7.6）；`stock_levels` 是 catalog 的表 |
| F1 `F1QueryPainTest` | 實驗 | compose、兩個服務在同一個 JVM | 三個「讀」的頁面，庫存服務正常、變慢、停掉（5.2、5.10.2） |
| F2 `F2StalenessTest` | 實驗 | compose、RabbitMQ | 副本晚多久；最後一件被買走之後，商品頁說錯多久（5.5） |
| F3 `F3RebuildTest` | 實驗 | compose、RabbitMQ、10 萬個商品 | 重建要多久；弄壞的三種修不修得好（5.6） |
| 第 04 章的 E4、第 01 章的 B1 | 實驗（重跑） | —— | 5.10.3、5.10.4 |

預設的測試從第 04 章 4.11.2 的 331 個變成 338 個（5.11）。

### 5.10.2 F1，之後

同一個實驗，跑在這一章最後的程式碼上（F1 多了「先重建副本」那幾行，5.6.4）：

```
═══ 5.2 三個「讀」的頁面，庫存服務正常、變慢、停掉（load { 5.86 5.27 5.07 }）═══
  單體               │ 商品詳情   │ p50      2.5 ms │ p99      7.8 ms │ {200=50}
  單體               │ 購物車    │ p50      6.3 ms │ p99     10.4 ms │ {200=50}
  單體               │ 賣家的商品  │ p50      7.3 ms │ p99     15.7 ms │ {200=50}
  單體               │ 我的訂單   │ p50      4.1 ms │ p99      8.2 ms │ {200=50}
  副本還沒建：商品詳情 → {"id":9000008,"sellerId":900001,"name":"d00 商品 7","description":null,"price":100.00,"categoryId":1,"status":"ON_SALE","available":0}
  重建副本 → 200 {"pages":2,"products":1000,"millis":72}；商品詳情 → {"id":9000008,"sellerId":900001,"name":"d00 商品 7","description":null,"price":100.00,"categoryId":1,"status":"ON_SALE","available":10000000}
  商品詳情   → 庫存服務 0 次 {}
  購物車    → 庫存服務 0 次 {}
  賣家的商品  → 庫存服務 0 次 {}
  我的訂單   → 庫存服務 0 次 {}
  切開：正常            │ 商品詳情   │ p50      1.9 ms │ p99      3.2 ms │ {200=50}
  切開：正常            │ 購物車    │ p50      4.8 ms │ p99      7.4 ms │ {200=50}
  切開：正常            │ 賣家的商品  │ p50      5.9 ms │ p99      8.5 ms │ {200=50}
  切開：正常            │ 我的訂單   │ p50      3.6 ms │ p99     10.6 ms │ {200=50}
  切開：每次讀慢 200 ms   │ 商品詳情   │ p50      1.9 ms │ p99      2.9 ms │ {200=30}
  切開：每次讀慢 200 ms   │ 購物車    │ p50      4.5 ms │ p99      9.2 ms │ {200=30}
  切開：每次讀慢 200 ms   │ 賣家的商品  │ p50      6.0 ms │ p99      8.3 ms │ {200=30}
  切開：每次讀慢 200 ms   │ 我的訂單   │ p50      3.4 ms │ p99     28.6 ms │ {200=30}
  切開：每次讀慢 1 秒      │ 商品詳情   │ p50      1.7 ms │ p99      2.2 ms │ {200=20}
  切開：每次讀慢 1 秒      │ 購物車    │ p50      3.9 ms │ p99      5.3 ms │ {200=20}
  切開：每次讀慢 1 秒      │ 賣家的商品  │ p50      5.2 ms │ p99      6.5 ms │ {200=20}
  切開：每次讀慢 1 秒      │ 我的訂單   │ p50      3.1 ms │ p99     11.5 ms │ {200=20}
  切開：庫存服務停掉        │ 商品詳情   │ p50      1.6 ms │ p99      3.7 ms │ {200=20}
  切開：庫存服務停掉        │ 購物車    │ p50      3.5 ms │ p99      5.6 ms │ {200=20}
  切開：庫存服務停掉        │ 賣家的商品  │ p50      4.4 ms │ p99      5.7 ms │ {200=20}
  切開：庫存服務停掉        │ 我的訂單   │ p50      2.9 ms │ p99      4.4 ms │ {200=20}
  庫存服務停掉時，商品詳情的回應：200 {"id":9000008,"sellerId":900001,"name":"d00 商品 7","description":null,"price":100.00,"categoryId":1,"status":"ON_SALE","available":10000000}
  （結束時 load { 6.03 5.33 5.10 }）
```

三頁打庫存服務 0 次。庫存服務每一次讀慢 1 秒、甚至停掉，三頁的 p50 都在 6 ms 以內、全部 200，商品詳情的可售量照樣是對的（10,000,000 —— 種子資料的數字）。慢的那兩段，頁面已經不等庫存服務了。

### 5.10.3 使用者的一天

第 04 章的 E4（4.10.2）原封不動，跑在這一章的程式碼上：

```bash
mvn test -Pexperiments -Dtest=E4SagaDayTest
```

```
═══ 4.10.2 使用者的一天，Saga、事件走 RabbitMQ：兩個服務、正式的角色（load { 5.84 5.43 5.18 }）═══
  每一個佇列的消費者數：{shop.catalog.stock-levels=2, shop.inventory.hot-settlement=2, shop.inventory.hot-stock-return=2, shop.inventory.order-events=2, shop.inventory.product-created=2, shop.notification.order-events=2, shop.ordering.stock-shortage=2, shop.payment.refunds=2}
  使用者的一天：61 個 HTTP 請求全部是預期的回應；等事件 21 次、一共 3,288 ms；整天 27,095 ms
  訂單服務 → 庫存服務：14 次 HTTP、7 種端點（第 03 章：38 次、10 種）
    POST /api/orders → POST /internal/inventory/v1/hot-gate                                              × 2
    POST /api/orders → PUT /internal/inventory/v1/reservations/{n}                                       × 6
    POST /api/seller/orders/{orderNo}/ship → GET /internal/inventory/v1/reservations/{n}/shippable       × 2
    POST /api/seller/products/{id}/hot → PUT /internal/inventory/v1/products/{n}/hot                     × 1
    POST /api/seller/products/{id}/restock → GET /internal/inventory/v1/stock                            × 1
    POST /api/seller/products/{id}/restock → POST /internal/inventory/v1/products/{n}/restocks           × 1
    排程 ReservationReconciliation.run → GET /internal/inventory/v1/reservations                           × 1
  消費者                         │ 訂單服務：成功 / 失敗後重試 / 送進死信 │ 庫存服務：成功 / 失敗後重試 / 送進死信 │ 死信佇列
  catalog.stock-levels           │       14 /          0 /        0 │        0 /          0 /        0 │     0
  inventory.hot-settlement       │        0 /          0 /        0 │        6 /          0 /        0 │     0
  inventory.hot-stock-return     │        0 /          0 /        0 │        4 /          0 /        0 │     0
  inventory.order-events         │        0 /          0 /        0 │       10 /          0 /        0 │     0
  inventory.product-created      │        0 /          0 /        0 │        4 /          0 /        0 │     0
  notification.order-events      │       18 /          0 /        0 │        0 /          0 /        0 │     0
  ordering.stock-shortage        │        1 /          0 /        0 │        0 /          0 /        0 │     0
  payment.refunds                │        2 /          0 /        0 │        0 /          0 /        0 │     0
  shop_d02_order  outbox：送出 26 筆、還沒送 0 筆；processed_messages 15 列 {catalog.stock-levels=14, ordering.stock-shortage=1}
  shop_d02_inv    outbox：送出 19 筆、還沒送 0 筆；processed_messages 31 列 {inventory.hot-settlement=6, inventory.hot-stock-return=4, inventory.http.reserve=6, inventory.http.restock=1, inventory.order-events=10, inventory.product-created=4}
  訂單：1 COMPLETED、2 CANCELLED、3 CANCELLED、4 CANCELLED、5 COMPLETED、6 CANCELLED；預留：1 CONSUMED、1 CONSUMED、2 RELEASED、3 RELEASED、4 RELEASED、5 CONSUMED、6 RELEASED
  （結束時 load { 5.05 5.29 5.14 }）
```

| | 第 03 章（D2） | 第 04 章（E4） | 第 05 章 |
|---|---|---|---|
| 訂單服務 → 庫存服務 | 38 次 | 30 次 | **14 次** |
| 其中的讀 | —— | 20 次（17 次是可售量） | **4 次** |
| 庫存服務 → 訂單服務的事件（`catalog.stock-levels` 處理了幾則） | —— | —— | 14 則 |

剩下的讀，每一個都是 5.3 那張表上「不能晚」的那一欄：補貨之後讀自己剛寫的（1 次）、出貨之前問一次（2 次）、對帳（1 次）。61 個請求全部是預期的回應 —— 使用者的一天裡沒有一步因為副本晚了一百毫秒而看到不一樣的東西。

### 5.10.4 B1 重跑

```bash
mvn test -Pexperiments -Dtest=B1BoundaryMapTest -Dd01.range=ch09
```

```
═══ 1.5 切出 inventory：切斷了什麼 ═══
  切斷的交易：
  交易內的同步呼叫：
  所有同步呼叫：
    catalog → InventoryApi.available
    catalog → InventoryApi.availableForDisplay
    catalog → InventoryApi.hotProducts
    catalog → InventoryApi.restock
    catalog → InventoryApi.setHot
    ordering → InventoryApi.activeReservations
    ordering → InventoryApi.checkShippable
    ordering → InventoryApi.gateHot
    ordering → InventoryApi.reserve
  直接讀表：
  跨過去的事件：
    inventory.hot-settlement-failed → ordering.stock-shortage
    inventory.stock-changed → catalog.stock-levels
    order.cancelled → inventory.order-events
    order.paid → inventory.order-events
    order.placed → inventory.hot-settlement
    order.shipped → inventory.order-events
    product.created → inventory.product-created
  變更耦合：8／36 個 commit（22.2%）
```

| | 第 02、03 章之後 | 第 04 章之後 | 第 05 章之後 |
|---|---|---|---|
| inventory 這一刀的名次 | 第 80 | 第 24 | **第 16** |
| 切斷的交易 / 交易內呼叫 / 同步呼叫 / 直接讀表 / 事件 | 6 / 5～6 / 11～12 / 0 / 3 | 0 / 1 / 9 / 0 / 6 | **0 / 0 / 9 / 0 / 7** |

**交易內呼叫：1 → 0。** 庫存這一刀，連一個交易內的呼叫都沒有了。

**同步呼叫還是 9 種** —— B1 看的是**單體**的程式碼路徑（它在一個行程裡量模組之間的呼叫，1.4.1）。單體不用副本（5.4.3），catalog 照舊問庫存模組，所以 `catalog → available`、`availableForDisplay` 都還在；購物車那一種不見了（它改問 catalog），多了 `catalog → hotProducts`（熱點名單，單體裡每秒一次）。切開之後實際少了什麼，看 5.10.3：讀從 20 次變成 4 次。**B1 量的是模組之間的耦合，使用者的一天量的是兩個服務之間的流量** —— 這一章讓兩者第一次不一樣。

### 5.10.5 追溯表：這一站的產出

| README 的產出 | 第 00～02 章 | 第 03～04 章 | 第 05 章加上的 |
|---|---|---|---|
| 1. 拆分決策文件 | 不該拆；四個代價；第一刀切 notification；資料的三個階段 | 每一條線同步還是非同步；2PC 不選的理由；6 種交易各用編排還是協同 | 跨服務的讀：可以晚的、不能晚的各怎麼做（5.3）；報表跟著訂單（5.8） |
| 2. 庫存拆成獨立服務、下單改成 Saga | 兩種部署、獨立的資料庫、對帳 | 正式的服務、契約、Saga、補償、演練、延遲對照 | 熱點旗標搬回庫存（5.7）：庫存這一刀交易內呼叫 0 |
| 3. 跨服務報表：API 組合版與讀模型版、過時視窗 | 庫存這一刀不切斷報表 | 賣家的商品列表、購物車、商品頁：API 組合（每一頁問一次，第 03 章 3.4 合成一次批次） | **讀模型版**（5.4）、**過時視窗**（5.5：副本的 p50 每秒 20 張 63～67 ms、每秒 100 張 96～101 ms；單體的商品頁晚將近 5 秒）、**重建**（5.6）；銷售報表沒有改（5.8） |
| 4. 一條完整的 trace | K5 | 送的那一邊好了、收的那一邊還斷（4.10.7） | （沒有量；第 07 章） |
| 5. 基礎設施選型 | 維運清單 | 一個 jar、三種角色；Pact Broker | 部署多一步：第一次上線要重建副本（5.6.4） |

---

## 5.11 本章完成後的專案

```
shop/                                                              ← 分支 d05（從 d04 開出來）
├── src/main/java/com/example/shop/
│   ├── inventory/InventoryApi.java、StockVersion.java              ← 5.6：stockSnapshot；5.7：hotProducts、setHot 不是 MANDATORY
│   ├── inventory/internal/JdbcInventoryService.java               ← 5.4.2：版本、stock-changed；5.6：快照；5.7：旗標
│   ├── inventory/internal/HotStock.java                           ← 5.7.3：閘門只為熱點商品建
│   ├── inventory/internal/InventoryService.java、web/InventoryServiceController.java、web/InventoryWire.java ← 5.6：GET /stock/snapshot
│   ├── inventory/internal/remote/RemoteInventoryApi.java、InventoryClient.java ← 5.6：快照；5.9：不再打 display
│   ├── catalog/CatalogApi.java                                    ← 5.4.6：available
│   ├── catalog/internal/StockLevels.java、InventoryStockLevels.java、ReplicaStockLevels.java ← + 5.4.3
│   ├── catalog/internal/StockReplica.java                         ← + 5.4.3、5.6：副本、消費者、重建
│   ├── catalog/internal/HotProducts.java                          ← + 5.7.4：每秒一次的熱點名單
│   ├── catalog/internal/ProductService.java、ProductRepository.java ← 5.4.3、5.4.5、5.7
│   ├── catalog/internal/web/AdminStockLevelsController.java、AdminHotFlagsController.java ← + 5.6、5.7.7
│   ├── cart/internal/CartService.java                             ← 5.4.6：問 catalog，不再依賴庫存模組
│   └── shared/config/ShopProperties.java、shared/events/EventTypes.java ← 5.7.4：hot-list-refresh；5.4：inventory.stock-changed
├── src/main/resources/db/migration/
│   ├── inventory/V28__inventory_stock_version.sql                 ← + 5.4.2
│   ├── catalog/V29__catalog_stock_levels.sql                      ← + 5.4.3
│   ├── inventory/V30__inventory_hot_flag.sql、V31__inventory_hot_index.sql ← + 5.7.2
│   └── catalog/V32__catalog_stock_levels_hot.sql、V33__catalog_stock_levels_hot_index.sql ← + 5.7.2
└── src/test/
    ├── java/com/example/shop/
    │   ├── dist05/F1QueryPainTest.java、F2StalenessTest.java、F3RebuildTest.java ← 5.2、5.5、5.6（實驗）
    │   ├── inventory/internal/StockChangedEventsTest.java          ← + 5.4.2
    │   ├── catalog/internal/StockReplicaTest.java、StockChangedPactTest.java ← + 5.4.3、5.9
    │   ├── ordering/internal/HotListStaleTest.java                ← + 5.7.5
    │   ├── api/HotToggleApiTest.java                              ← 5.7.7
    │   ├── inventory/internal/remote/InventoryClientPactTest.java、web/InventoryEventMessages.java ← 5.9
    │   ├── shared/messaging/internal/ServiceRoleConsumersTest.java ← 5.4.4
    │   ├── dist01/CrossModuleCallInTxTest.java、architecture/TableOwnershipTest.java ← 5.7.6、5.4.1
    │   ├── （九個測試用的檔案、六個實驗的資料：inventory.hot）       ← 5.7.8
    │   └── dist00/RemoteInventoryApi.java、dist02/RemoteInventory.java ← InventoryApi 多兩個方法
    └── resources/
        ├── config/application.yml                                 ← 5.7.4：hot-list-refresh: 0s
        └── openapi/shop-api.json                                  ← 5.7.7：一支管理員的路由（只有新增）
```

**六個新的 migration**：欄位都是 `ALGORITHM=INSTANT`，兩個索引是 `INPLACE`、不鎖寫。**對買家、賣家的 API 沒有任何改變**；`OpenApiContractTest` 的快照多了一支管理員的路由（搬家）。重建副本的那一支只在切開的訂單服務裡，單體的快照看不到它。單體的行為改了兩件事：catalog 的熱點名單每秒讀一次庫存模組（5.7.4）；它也收、也維護一份沒有人讀的副本（5.4.4）。

完整跑一次：

```bash
mvn clean verify
```

```
TEST_INFRA testcontainers 啟動 9,220 ms：mysql jdbc:mysql://localhost:60429/shop、redis localhost:60418、rabbitmq localhost:60428
TEST_INFRA MySQL 最多同時 31 條連線（max_connections 151）
[INFO] Tests run: 338, Failures: 0, Errors: 0, Skipped: 0
TEST_INFRA testcontainers 啟動 9,867 ms：mysql jdbc:mysql://localhost:62077/shop、redis localhost:62063、rabbitmq localhost:62075
TEST_INFRA MySQL 最多同時 5 條連線（max_connections 151）
[INFO] Tests run: 39, Failures: 0, Errors: 0, Skipped: 0
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  05:51 min
```

**338 個測試**：第 04 章 4.11.2 的 331 個，加上 `StockChangedEventsTest` 1 個、`StockReplicaTest` 2 個、`HotListStaleTest` 2 個、`HotToggleApiTest` 多 1 個、`StockChangedPactTest` 1 個（`InventoryClientPactTest` 少一個顯示、多一個快照，還是 16 個）。**failsafe 那一段 39 個**：這一次建置的 HTTP 契約與事件 18 個、線上那一版 15 個、訂單服務的事件 6 個。

### 5.11.1 本章其餘檔案的完整內容

正文已經完整列出的：V28、V29、V30、V31（5.4.2、5.4.3、5.7.2）、`StockLevels`、`StockVersion`、`AdminStockLevelsController`（5.4.3、5.6）。`StockChangedPactTest` 在 5.9 只列了類別本身，完整的檔案在下面。正文列過 diff 的：`ProductService`、`CartService`、`CatalogApi`（5.4）。其餘新增或改動較大的，列完整內容；只改了幾行的，列 diff（`d05` 分支上的版本）。

**`src/main/java/com/example/shop/catalog/internal/StockReplica.java`**（5.4.3、5.4.4、5.6）

```java
package com.example.shop.catalog.internal;

import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.StockVersion;
import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.EventTypes;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 13 站 5.4：訂單服務裡，庫存「可以賣幾件」的副本（讀模型）。
 *   寫：catalog.stock-levels 消費者 —— 收庫存服務的 inventory.stock-changed，一筆一筆 upsert 進 stock_levels
 *   讀：available() —— 切開的訂單服務裡由 ReplicaStockLevels 交給商品頁、賣家的商品列表、購物車（一句本地的 SQL，不是一次 HTTP）
 *
 * ⚠️ 這個 bean 在每一個角色裡都在，不能只在訂單服務裡：第一版標了 @ConditionalOnServiceRole(ORDER_SERVICE)，副本一則都沒收到 ——
 * 庫存服務的 relay 只送「這個行程裡有人訂閱」的事件（第 12 站 9.2.1），那一份清單來自 EventHandler 這些 bean（第 03 章 3.7.3），
 * 它在庫存服務裡看不到這個消費者，inventory.stock-changed 全部記成 OUTBOX_UNSUBSCRIBED。要分角色的是「誰讀副本」（ReplicaStockLevels），不是消費者。
 * 單體也收、也維護這張表（沒有人讀它）—— 消費者只在擁有 catalog 的行程裡真的收訊息（RabbitConsumers），庫存服務裡它只是讓 relay 知道有人要
 *
 * 版本：同一則事件送兩次，processed_messages 擋得住（EventDispatcher）；擋不住的是**另一則**事件帶著比較舊的值晚到 ——
 * 兩次預留各發一則，重試讓後發的先到（第 12 站 7.5.4）。每一筆都帶著庫存那一列的版本：比較新才寫，舊的直接略過。
 *
 * 重建（5.6）：從庫存服務的快照一頁一頁寫回來，用同一句 UPSERT —— 跟同時進來的事件誰先誰後都沒關係，版本比較新的留下。
 * public：管理員的端點（catalog.internal.web）要呼叫 rebuild()
 */
@Component
public class StockReplica implements EventHandler {

    /**
     * MySQL 依序執行 ON DUPLICATE KEY UPDATE 的每一個指派：version 要放最後，前面的 IF 比的才是舊的版本。
     * >=，不是 >：同一個版本就是庫存那一列的同一個狀態，再寫一次無害 —— 而重建（5.6）要靠它修好「版本一樣、值卻錯了」的那幾列
     */
    static final String UPSERT = """
            INSERT INTO stock_levels (product_id, available, hot, version, changed_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3)) AS n
            ON DUPLICATE KEY UPDATE
              available  = IF(n.version >= stock_levels.version, n.available,  stock_levels.available),
              hot        = IF(n.version >= stock_levels.version, n.hot,        stock_levels.hot),
              changed_at = IF(n.version >= stock_levels.version, n.changed_at, stock_levels.changed_at),
              updated_at = IF(n.version >= stock_levels.version, n.updated_at, stock_levels.updated_at),
              version    = GREATEST(stock_levels.version, n.version)""";

    private final JdbcTemplate jdbc;
    private final InventoryApi inventory;

    StockReplica(JdbcTemplate jdbc, InventoryApi inventory) {
        this.jdbc = jdbc;
        this.inventory = inventory;
    }

    // ───────── 寫 ─────────

    @Override public String consumer() { return "catalog.stock-levels"; }

    @Override public Set<String> eventTypes() { return Set.of(EventTypes.STOCK_CHANGED); }

    @Override
    public void handle(Event e) {
        for (JsonNode i : e.payload().get("items"))                         // hot：5.7 才有；之前的事件沒有這個欄位 → false
            apply(i.get("productId").asLong(), i.get("available").asInt(), i.path("hot").asBoolean(false), i.get("version").asLong(), e.occurredAt());
    }

    void apply(long productId, int available, boolean hot, long version, Instant changedAt) {
        jdbc.update(UPSERT, productId, available, hot, version, Timestamp.from(changedAt));
    }

    // ───────── 重建 ─────────

    public record Rebuilt(int pages, int products, long millis) {}

    /**
     * 13 站 5.6：從庫存服務的快照重建 —— 第一次上線（副本是空的）、懷疑它漏了事件、或者整個砍掉重來。
     * 不清空：清空的那一刻起到重建完，商品頁會看到 0。直接覆蓋，舊的版本自然被蓋掉，新的版本（重建途中進來的事件）不會被快照蓋回去。
     * changed_at：快照那一頁讀到的時間（庫存那一邊「改」的時間不在快照裡）
     */
    public Rebuilt rebuild(int pageSize) {
        long t0 = System.nanoTime(), after = 0;
        int pages = 0, products = 0;
        while (true) {
            Timestamp at = Timestamp.from(Instant.now());
            List<StockVersion> page = inventory.stockSnapshot(after, pageSize);
            if (page.isEmpty()) break;
            jdbc.batchUpdate(UPSERT, page.stream().map(v -> new Object[]{v.productId(), v.available(), v.hot(), v.version(), at}).toList());
            pages++;
            products += page.size();
            after = page.get(page.size() - 1).productId();
            if (page.size() < pageSize) break;
        }
        return new Rebuilt(pages, products, (System.nanoTime() - t0) / 1_000_000);
    }

    // ───────── 讀 ─────────

    Map<Long, Integer> available(Collection<Long> productIds) {
        Map<Long, Integer> result = new HashMap<>();
        if (productIds.isEmpty()) return result;
        List<Long> ids = List.copyOf(productIds);
        String in = String.join(",", ids.stream().map(id -> "?").toList());
        jdbc.query("SELECT product_id, available FROM stock_levels WHERE product_id IN (" + in + ")",
                rs -> { result.put(rs.getLong(1), rs.getInt(2)); }, ids.toArray());
        return result;
    }

    /** 13 站 5.7：標成熱點的商品（idx_stock_levels_hot）。HotProducts 每秒讀一次 */
    Set<Long> hotIds() {
        return new java.util.HashSet<>(jdbc.queryForList("SELECT product_id FROM stock_levels WHERE hot", Long.class));
    }
}
```

**`src/main/java/com/example/shop/catalog/internal/InventoryStockLevels.java`**（5.4.3）

```java
package com.example.shop.catalog.internal;

import com.example.shop.inventory.InventoryApi;
import com.example.shop.shared.config.ConditionalOnServiceRole;
import com.example.shop.shared.config.ServiceRole;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.Map;

/**
 * 13 站 5.4：單體 —— 跟第 12 站一樣，直接問庫存模組（不需要副本：沒有一刀要跨）。
 * 庫存服務的角色裡 catalog 的 bean 也在（只是沒有人用）：ProductService 要一個 StockLevels，給它這一個
 */
@Component
@ConditionalOnServiceRole({ServiceRole.MONOLITH, ServiceRole.INVENTORY_SERVICE})
class InventoryStockLevels implements StockLevels {

    private final InventoryApi inventory;

    InventoryStockLevels(InventoryApi inventory) { this.inventory = inventory; }

    @Override public Map<Long, Integer> available(Collection<Long> productIds) { return inventory.available(productIds); }

    @Override public int forDisplay(long productId) { return inventory.availableForDisplay(productId, false); }   // hot 由庫存自己判斷（5.7）

    @Override public java.util.Set<Long> hotProducts() { return inventory.hotProducts(); }
}
```

**`src/main/java/com/example/shop/catalog/internal/ReplicaStockLevels.java`**（5.4.3、5.7）

```java
package com.example.shop.catalog.internal;

import com.example.shop.shared.config.ConditionalOnServiceRole;
import com.example.shop.shared.config.ServiceRole;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.Map;

/** 13 站 5.4：切開的訂單服務 —— 讀自己庫裡的副本（StockReplica），不再每一次問庫存服務 */
@Component
@ConditionalOnServiceRole(ServiceRole.ORDER_SERVICE)
class ReplicaStockLevels implements StockLevels {

    private final StockReplica replica;

    ReplicaStockLevels(StockReplica replica) { this.replica = replica; }

    @Override public Map<Long, Integer> available(Collection<Long> productIds) { return replica.available(productIds); }

    /** 熱點商品也讀副本：閘門在庫存服務的 Redis 裡（MySQL 落帳之後的值，最多晚幾秒 —— AC-4 允許 5 秒） */
    @Override public int forDisplay(long productId) { return Math.max(0, replica.available(java.util.List.of(productId)).getOrDefault(productId, 0)); }

    @Override public java.util.Set<Long> hotProducts() { return replica.hotIds(); }
}
```

**`src/main/java/com/example/shop/catalog/internal/HotProducts.java`**（5.7.4）

```java
package com.example.shop.catalog.internal;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.Set;

/**
 * 13 站 5.7：「下單時哪些品項是熱點」。第 12 站讀商品快取的 products.hot（6.5：搶不到的人不碰 MySQL）；旗標搬到庫存之後，
 * 改讀 StockLevels.hotProducts() —— 但不能每一張訂單讀一次：那會讓 2,000 個搶的人每一個都碰一次 MySQL（單體：庫存的表；切開：副本）。
 * 所以記在記憶體裡，每秒最多重讀一次：一個行程每秒一句 SQL，跟流量無關。標成熱點的商品通常只有幾個，整份名單放得下。
 *
 * 會晚：最多 1 秒（加上切開之後副本的延遲，5.5）。兩個方向都安全 ——
 *   剛標成熱點、名單還沒有它 → 這一張走一般的預留（MySQL 的條件式 UPDATE），正確，只是比較重
 *   剛取消熱點、名單還有它  → 這一張去過閘門，庫存服務說它不是熱點，不扣（HotStock.gate），照樣走熱點那一路的預留、落帳時計入
 * 重讀失敗（庫存模組、副本讀不到）→ 留著上一份，記一行日誌
 */
@Component
class HotProducts {

    private static final Logger log = LoggerFactory.getLogger(HotProducts.class);
    private final StockLevels stock;
    private final long ttlNanos;
    private volatile Set<Long> ids = Set.of();
    private volatile long loadedAt;
    private volatile boolean loaded;

    HotProducts(StockLevels stock, com.example.shop.shared.config.ShopProperties props) {
        this.stock = stock;
        this.ttlNanos = props.inventory().hotListRefresh().toNanos();       // 預設 1 秒；測試設成 0（每一次都讀）
    }

    Set<Long> current() {
        if (!loaded || System.nanoTime() - loadedAt >= ttlNanos) reload();
        return ids;
    }

    private synchronized void reload() {
        long now = System.nanoTime();
        if (loaded && ttlNanos > 0 && now - loadedAt < ttlNanos) return;    // 等鎖的時候，別人已經讀好了
        try {
            ids = Set.copyOf(stock.hotProducts());
        } catch (RuntimeException e) {
            log.warn("HOT_PRODUCTS_RELOAD_FAILED 留著上一份 {}：{}", ids, e.toString());
        }
        loadedAt = now;
        loaded = true;
    }
}
```

**`src/main/java/com/example/shop/catalog/internal/web/AdminHotFlagsController.java`**（5.7.7）

```java
package com.example.shop.catalog.internal.web;

import com.example.shop.catalog.internal.ProductService;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.Role;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 13 站 5.7：熱點旗標搬家 —— 部署第 05 章這一版之後打一次，把 products.hot 抄到庫存（擁有者）。可以重複打（setHot 冪等）。
 * /api/admin/** 在 SecurityConfig 已經是 hasRole("ADMIN")；這裡再 require 一次，跟其他管理員的 API 一樣
 */
@RestController
class AdminHotFlagsController {

    private final ProductService products;

    AdminHotFlagsController(ProductService products) { this.products = products; }

    @PostMapping("/api/admin/hot-flags/copy-to-inventory")
    Map<String, Integer> copy(CurrentUser user) {
        user.require(Role.ADMIN);
        return Map.of("copied", products.copyHotFlagsToInventory());
    }
}
```

**`src/main/resources/db/migration/catalog/V32__catalog_stock_levels_hot.sql`**（5.7.2）

```sql
-- 13 站 5.7：副本也帶著熱點旗標（inventory.stock-changed 的 hot）。切開的訂單服務下單時「哪些品項是熱點」改從這裡讀（每秒一次，HotProducts）
ALTER TABLE stock_levels ADD COLUMN hot BOOLEAN NOT NULL DEFAULT FALSE, ALGORITHM=INSTANT;
```

**`src/main/resources/db/migration/catalog/V33__catalog_stock_levels_hot_index.sql`**（5.7.2）

```sql
-- 13 站 5.7：副本的「全部的熱點商品」（每秒一次）。INPLACE、不鎖寫
ALTER TABLE stock_levels ADD INDEX idx_stock_levels_hot (hot), ALGORITHM=INPLACE, LOCK=NONE;
```

**`src/main/java/com/example/shop/catalog/internal/ProductRepository.java`**（5.7.7）

```diff
 interface ProductRepository extends JpaRepository<Product, Long>, JpaSpecificationExecutor<Product> {
 
     Page<Product> findBySellerId(long sellerId, Pageable pageable);
+
+    /** 13 站 5.7：搬家用 —— 舊的旗標（products.hot）還是 true 的商品 */
+    @org.springframework.data.jpa.repository.Query("select p.id from Product p where p.hot = true")
+    java.util.List<Long> findHotIds();
 }
```

**`src/main/java/com/example/shop/inventory/InventoryApi.java`**（5.6、5.7）

```diff
     /** 閘門過了、下單卻失敗了（價格變了、資料庫錯誤……）：把減掉的加回去（6.2.4） */
     void returnHot(List<ReserveLine> hotLines);
 
-    /** 商品被標成（或取消）熱點：commit 之後建立（或刪除）Redis 的庫存副本。MANDATORY */
+    /**
+     * 商品被標成（或取消）熱點：commit 之後建立（或刪除）Redis 的庫存副本。
+     * 13 站 5.7：旗標存在庫存（inventory.hot），不再是 MANDATORY —— 自己的交易，在 catalog 的交易之外呼叫；改了才發 inventory.stock-changed
+     */
     void setHot(long productId, boolean hot);
 
-    /** 商品頁顯示用的可售量（US-PRD-3 AC-4：最多 5 秒的延遲）。熱點商品讀 Redis 的副本；其他商品快取 5 秒 */
+    /** 13 站 5.7：所有標成熱點的商品（通常只有幾個）。單體的 catalog 每秒讀一次（HotProducts）；切開的訂單服務讀自己的副本 */
+    java.util.Set<Long> hotProducts();
+
+    /**
+     * 商品頁顯示用的可售量（US-PRD-3 AC-4：最多 5 秒的延遲）。熱點商品讀 Redis 的副本；其他商品快取 5 秒。
+     * 13 站 5.7：hot 參數不再看 —— 庫存自己知道（閘門的 key 只為熱點商品建）。留著它：第 03 章那一版的呼叫端還會送
+     */
     int availableForDisplay(long productId, boolean hot);
 
     /** 可售庫存 = onHand - reserved。13 站 2.7：沒有庫存列（product.created 還沒送到）= 0 */
…
     /** 一次查多個商品的可售庫存（一句 SQL）。沒有庫存列的商品不會出現在結果裡。 */
     Map<Long, Integer> available(Collection<Long> productIds);
 
+    /**
+     * 13 站 5.6：重建讀模型用的快照 —— productId 比 afterProductId 大的前 limit 個商品，依 productId 由小到大（keyset 分頁），
+     * 每一個帶著 inventory 那一列現在的版本。不開交易：每一頁各自一句 SELECT，頁與頁之間的改變由事件與版本補上
+     */
+    List<StockVersion> stockSnapshot(long afterProductId, int limit);
+
     // ───────── 13 站 2.6：跨模組的對帳（ordering 的 ReservationReconciliation）─────────
     // 「預留」與「訂單」在同一個資料庫裡時，一句 JOIN 就能對；拆開之後，兩邊各問各的、在程式裡比。這三個方法是庫存那一邊
 
```

**`src/main/java/com/example/shop/inventory/internal/JdbcInventoryService.java`**（5.4.2、5.6、5.7）

```diff
 import com.example.shop.inventory.InventoryApi;
 import com.example.shop.inventory.ReserveLine;
 import com.example.shop.inventory.ReservationRef;
+import com.example.shop.inventory.StockVersion;
 import com.example.shop.shared.error.ProblemType;
 import com.example.shop.shared.error.ShopException;
 import com.example.shop.shared.events.EventTypes;
…
     }
 
     @Override
-    @Transactional(propagation = Propagation.MANDATORY)
+    @Transactional
     public void setHot(long productId, boolean isHot) {
+        // 13 站 5.7：旗標存在 inventory 那一列。改了才加版本、發 stock-changed（同一個值再設一次：什麼都不改，Redis 照樣確認一次）。
+        // 庫存列還沒建立（product.created 還沒送到）也要記得住：先建一列 0 件（跟 restock 一樣，2.7）
+        List<Boolean> cur = jdbc.queryForList("SELECT hot FROM inventory WHERE product_id = ? FOR UPDATE", Boolean.class, productId);
+        if (cur.isEmpty())
+            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, version, hot) VALUES (?, 0, 0, 1, ?)", productId, isHot);
+        else if (cur.get(0) != isHot)
+            jdbc.update("UPDATE inventory SET hot = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = ?", isHot, productId);
+        if (cur.isEmpty() || cur.get(0) != isHot) stockChanged(productId, List.of(productId));
         if (isHot) {
             if (!TransactionSynchronizationManager.isSynchronizationActive()) { hot.initialize(productId); return; }
             TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
…
     }
 
     @Override
-    public int availableForDisplay(long productId, boolean isHot) {
-        if (isHot) {
-            Optional<Integer> v = hot.display(productId);
-            if (v.isPresent()) return Math.max(0, v.get());
-        }
+    public java.util.Set<Long> hotProducts() {
+        return new java.util.HashSet<>(jdbc.queryForList("SELECT product_id FROM inventory WHERE hot", Long.class));   // idx_inventory_hot
+    }
+
+    @Override
+    public int availableForDisplay(long productId, boolean ignored) {
+        // 13 站 5.7：閘門的 key 只為熱點商品建 —— 有 key 就是熱點，讀它（第 12 站 6.5：搶購時商品頁看的是閘門）
+        Optional<Integer> gate = hot.display(productId);
+        if (gate.isPresent()) return Math.max(0, gate.get());
         String key = "available:" + productId;
         Optional<String> cached = guard.call("available.get", () -> redis.opsForValue().get(key));
         if (cached.isPresent()) return Integer.parseInt(cached.get());
…
         if (onHand < 0) throw new IllegalArgumentException("onHand must not be negative");
         // 13 站 2.7：補貨可能比 product.created 先到（restock 會先建一列）—— 已經有就加上去，帳照記（INV-3 照樣成立）
         jdbc.update("""
-                INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0) AS new
-                ON DUPLICATE KEY UPDATE on_hand = inventory.on_hand + new.on_hand, updated_at = CURRENT_TIMESTAMP(3)""", productId, onHand);
+                INSERT INTO inventory (product_id, on_hand, reserved, version) VALUES (?, ?, 0, 1) AS new
+                ON DUPLICATE KEY UPDATE on_hand = inventory.on_hand + new.on_hand, version = inventory.version + 1, updated_at = CURRENT_TIMESTAMP(3)""",
+                productId, onHand);
         if (onHand > 0) ledger(productId, onHand, 0, "INITIAL", note);     // ck_ledger_delta：數量為 0 就不記帳
+        stockChanged(productId, List.of(productId));
     }
 
     /** 13 站 4.5：自己的交易（下單 Saga 的一步）。冪等：見 reserveOnce */
…
         if (inbox.claim(RESERVE_KEY, Long.toString(orderId))) {
             reserveCounted(orderId, lines);
             if (!hotLines.isEmpty()) holdHot(orderId, hotLines);
+            stockChanged(orderId, lines.stream().map(ReserveLine::productId).toList());   // 5.4：熱點品項還沒計入，可售量沒變
             return false;
         }
         List<ReservationRef> have = reservationsOf(List.of(orderId)).getOrDefault(orderId, List.of());
…
         List<ReserveLine> sorted = lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList();
         for (ReserveLine l : sorted) {
             int n = jdbc.update("""
-                    UPDATE inventory SET reserved = reserved + ?, updated_at = CURRENT_TIMESTAMP(3)
+                    UPDATE inventory SET reserved = reserved + ?, version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
                      WHERE product_id = ? AND on_hand - reserved >= ?""",
                     l.quantity(), l.productId(), l.quantity());
             if (n == 0) throw new InsufficientStockException(l.productId());
…
         }
         for (Held h : lines) {
             int n = jdbc.update("""
-                    UPDATE inventory SET reserved = reserved + ?, updated_at = CURRENT_TIMESTAMP(3)
+                    UPDATE inventory SET reserved = reserved + ?, version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
                      WHERE product_id = ? AND on_hand - reserved >= ?""", h.quantity(), h.productId(), h.quantity());
             if (n != 1) throw new IllegalStateException("inventory " + h.productId() + " 已經鎖住而且檢查過了，UPDATE 卻沒有成功");
             jdbc.update("UPDATE inventory_reservations SET counted = TRUE, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
             ledger(h.productId(), 0, h.quantity(), "RESERVE", "order:" + orderId);
         }
+        if (!lines.isEmpty()) stockChanged(orderId, lines.stream().map(Held::productId).toList());
         return lines.size();
     }
 
…
     @Transactional(propagation = Propagation.MANDATORY)
     public void release(long orderId) {
         List<ReserveLine> released = new ArrayList<>();
+        List<Long> changed = new ArrayList<>();
         for (Held h : held(orderId, "'HELD', 'CONFIRMED'")) {
             released.add(new ReserveLine(h.productId(), h.quantity()));
             if (h.counted()) {
-                jdbc.update("UPDATE inventory SET reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = ?",
+                jdbc.update("UPDATE inventory SET reserved = reserved - ?, version = version + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = ?",
                         h.quantity(), h.productId());
                 ledger(h.productId(), 0, -h.quantity(), "RELEASE", "order:" + orderId);
+                changed.add(h.productId());
             }                                                               // 7.6：還沒計入的熱點預留 —— reserved 本來就沒有加，只改狀態
             jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
         }
         returnToHotStock(orderId, released);                                // 熱點商品：Redis 的閘門要加回去（7.6.5）
+        stockChanged(orderId, changed);
     }
 
     /**
…
     public void consume(long orderId) {
         while (settleHot(orderId) < 0) { /* 每一次 -1 釋放一列不夠的；剩下的再落帳一次 */ }
         for (Held h : held(orderId, "'HELD', 'CONFIRMED'")) {
+            // 5.4：出庫時 on_hand 與 reserved 一起減，可售量不變 —— 版本照樣加 1，不發 stock-changed（讀模型只存可售量）
             jdbc.update("""
-                    UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3)
+                    UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
                      WHERE product_id = ?""", h.quantity(), h.quantity(), h.productId());
             jdbc.update("UPDATE inventory_reservations SET status = 'CONSUMED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
             ledger(h.productId(), -h.quantity(), -h.quantity(), "SHIP", "order:" + orderId);
…
         refuseToShip(orderId, rows.stream().anyMatch(h -> !h.counted()));
         for (Held h : rows) {
             jdbc.update("""
-                    UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3)
+                    UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
                      WHERE product_id = ?""", h.quantity(), h.quantity(), h.productId());
             jdbc.update("UPDATE inventory_reservations SET status = 'CONSUMED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
             ledger(h.productId(), -h.quantity(), -h.quantity(), "SHIP", "order:" + orderId);
…
         if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
         // 13 站 2.7：庫存列還沒建立（product.created 還沒送到）也要補得進去 —— 不然下一句帳撞外鍵（fk_ledger_inventory）
         jdbc.update("""
-                INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0) AS new
-                ON DUPLICATE KEY UPDATE on_hand = inventory.on_hand + new.on_hand, updated_at = CURRENT_TIMESTAMP(3)""", productId, quantity);
+                INSERT INTO inventory (product_id, on_hand, reserved, version) VALUES (?, ?, 0, 1) AS new
+                ON DUPLICATE KEY UPDATE on_hand = inventory.on_hand + new.on_hand, version = inventory.version + 1, updated_at = CURRENT_TIMESTAMP(3)""",
+                productId, quantity);
         ledger(productId, quantity, 0, "RESTOCK", note);
         returnToHotStock(productId, List.of(new ReserveLine(productId, quantity)));
+        stockChanged(productId, List.of(productId));
     }
 
     /**
…
         return result;
     }
 
+    @Override
+    public List<StockVersion> stockSnapshot(long afterProductId, int limit) {
+        return jdbc.query("SELECT product_id, on_hand - reserved, version, hot FROM inventory WHERE product_id > ? ORDER BY product_id LIMIT ?",
+                (rs, i) -> new StockVersion(rs.getLong(1), rs.getInt(2), rs.getLong(3), rs.getBoolean(4)), afterProductId, limit);
+    }
+
     // ───────── 13 站 2.6：對帳用 ─────────
 
     @Override
…
         release(orderId);                                                   // 同一個物件裡呼叫：不經過代理，MANDATORY 不檢查 —— 這個交易就是它的交易
     }
 
+    /**
+     * 13 站 5.4：這幾個商品的可售量變了 —— 讀它們現在的值與版本，跟這個交易一起寫一則 inventory.stock-changed。
+     * 讀的是這個交易剛寫的那幾列（自己的寫入，一定看得到最新的；那幾列的 X 鎖還在手上，別人改不了）
+     */
+    private void stockChanged(long aggregateId, java.util.Collection<Long> productIds) {
+        if (productIds.isEmpty()) return;
+        List<Long> ids = productIds.stream().distinct().sorted().toList();
+        String in = String.join(",", ids.stream().map(id -> "?").toList());
+        List<Map<String, Object>> items = jdbc.query("SELECT product_id, on_hand - reserved, version, hot FROM inventory WHERE product_id IN (" + in + ") ORDER BY product_id",
+                (rs, i) -> Map.<String, Object>of("productId", rs.getLong(1), "available", rs.getInt(2), "version", rs.getLong(3), "hot", rs.getBoolean(4)), ids.toArray());
+        outbox.add("INVENTORY", aggregateId, EventTypes.STOCK_CHANGED, Map.of("items", items));   // 聚合 id：觸發它的訂單或商品（跟 stock-returned 一樣）
+    }
+
     private void ledger(long productId, int deltaOnHand, int deltaReserved, String reason, String ref) {
         jdbc.update("""
                 INSERT INTO inventory_ledger(product_id, delta_on_hand, delta_reserved, reason, ref)
```

**`src/main/java/com/example/shop/inventory/internal/HotStock.java`**（5.7.3）

```diff
      * @return true = 這個鍵之前已經減過了
      */
     boolean gate(List<ReserveLine> lines, String requestKey) {
-        List<ReserveLine> sorted = lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList();
-        List<String> keys = new ArrayList<>(sorted.stream().map(l -> key(l.productId())).toList());
-        List<Object> args = new ArrayList<>(sorted.stream().map(l -> (Object) String.valueOf(l.quantity())).toList());
-        if (requestKey != null) {
-            keys.add("gate-once:" + requestKey);
-            args.add(String.valueOf(ONCE_TTL_SECONDS));
-        }
-        Object[] qty = args.toArray();
-        for (int attempt = 0; attempt < 3; attempt++) {
+        List<ReserveLine> sorted = new ArrayList<>(lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList());
+        for (int attempt = 0; attempt < 3; ) {
+            // 13 站 5.7：一件都不剩（全部都不是熱點）—— 沒有閘門要過
+            if (sorted.isEmpty()) return false;
+            List<String> keys = new ArrayList<>(sorted.stream().map(l -> key(l.productId())).toList());
+            List<Object> args = new ArrayList<>(sorted.stream().map(l -> (Object) String.valueOf(l.quantity())).toList());
+            if (requestKey != null) {
+                keys.add("gate-once:" + requestKey);
+                args.add(String.valueOf(ONCE_TTL_SECONDS));
+            }
+            Object[] qty = args.toArray();
             List<?> r = guard.call("hot-stock.gate", () -> redis.execute(requestKey == null ? GATE : GATE_ONCE, keys, qty)).orElseThrow(HotStock::unavailable);
             int code = ((Number) r.get(0)).intValue(), i = ((Number) r.get(1)).intValue();
             if (code == 1) return true;
             if (code == 0) return false;
             long productId = sorted.get(i - 1).productId();
             if (code == -2) throw new InsufficientStockException(productId);
-            initialize(productId);                                          // -1：key 不存在 → 從 MySQL 建，再試一次
+            // -1：key 不存在 → 從 MySQL 建，再試一次。13 站 5.7：庫存說它不是熱點（呼叫端的名單過時了）→ 這一件不過閘門、不算一次嘗試：
+            // 它照樣走預留的熱點那一路（只寫預留列、落帳時才計入，7.6），MySQL 才是最後一道防線 —— 慢一點，結果一樣正確
+            if (initialize(productId) == Init.NOT_HOT) sorted.remove(i - 1); else attempt++;
         }
         throw unavailable();
     }
 
+    /** 13 站 5.7：initialize 的結果 */
+    enum Init { CREATED, BUSY, NO_ROW, NOT_HOT }
+
     /**
      * 13 站 3.5：同一個 requestKey 只加回一次（RETURN_ONCE）。Redis 不能用 → 跟 giveBack 一樣記一行日誌、等對帳。
      * @return true = 這個鍵之前已經加回過了
…
      * key 不存在（剛標成熱點、或 Redis 的資料丟了）：從 MySQL 的可售量建立。
      * 鎖不是為了正確性（SET NX 只會有一個人成功），是為了「100 個請求同時發現 key 不存在」時，只有一個去讀 MySQL。
      */
-    void initialize(long productId) {
+    Init initialize(long productId) {
         Optional<DistributedLock.Handle> lock = guard.call("hot-stock.lock", () -> locks.tryLock("lock:" + key(productId), Duration.ofSeconds(2)).orElse(null));
-        if (lock.isEmpty()) { sleep(20); return; }                          // 別人在建：等一下再試
+        if (lock.isEmpty()) { sleep(20); return Init.BUSY; }                // 別人在建：等一下再試
         try {
+            // 13 站 5.7：只為熱點商品建閘門 —— 旗標在庫存自己的表上（第 12 站是由 catalog 說了算，呼叫端說是熱點就建）
+            List<Boolean> hot = jdbc.queryForList("SELECT hot FROM inventory WHERE product_id = ?", Boolean.class, productId);
+            if (!hot.isEmpty() && !hot.get(0)) return Init.NOT_HOT;
             // 13 站 2.7：庫存列還沒建立（product.created 還沒送到）—— 不建 key：用 0 建，事件送到之後 Redis 會一直少那些庫存，直到對帳
             List<Integer> rows = jdbc.queryForList(GATE_BASE_SQL, Integer.class, productId);
-            if (rows.isEmpty()) { log.warn("HOT_STOCK_NO_ROW productId={}：還沒有庫存列，先不建閘門", productId); return; }
+            if (rows.isEmpty()) { log.warn("HOT_STOCK_NO_ROW productId={}：還沒有庫存列，先不建閘門", productId); return Init.NO_ROW; }
             Integer available = rows.get(0);
             guard.run("hot-stock.init", () -> redis.opsForValue().setIfAbsent(key(productId), String.valueOf(available)));
+            return Init.CREATED;
         } finally {
             guard.run("hot-stock.unlock", () -> locks.unlock(lock.get()));
         }
```

**`src/main/java/com/example/shop/inventory/internal/InventoryService.java`**（5.6）

```diff
 
     public Map<Long, Integer> available(Collection<Long> productIds) { return inventory.available(productIds); }
 
+    /** 13 站 5.6：GET /stock/snapshot。一頁最多 1,000 個商品 */
+    public List<com.example.shop.inventory.StockVersion> stockSnapshot(long after, int limit) {
+        return inventory.stockSnapshot(after, Math.max(1, Math.min(limit, 1_000)));
+    }
+
     public int availableForDisplay(long productId, boolean hot) { return inventory.availableForDisplay(productId, hot); }
 
     public List<ReservationRef> activeReservations(long afterId, Instant createdBefore, int limit) {
```

**`src/main/java/com/example/shop/inventory/internal/web/InventoryServiceController.java`**（5.6）

```diff
  *
  *   GET  /stock?productIds=…                 可售量（一個或多個；沒有庫存列的商品不在結果裡）
  *   GET  /stock/{productId}/display?hot=…     商品頁顯示用
+ *   GET  /stock/snapshot?after=…&limit=…      重建讀模型用：可售量與版本，依 productId（keyset 分頁；13 站 5.6）
  *   PUT  /reservations/{orderId}              一張訂單的預留（URL 就是冪等鍵）
  *   POST /reservations/{orderId}/confirm|release|consume
  *   GET  /reservations/{orderId}/shippable    出貨之前問一次：204 可以、503 還在落帳、409 即將取消（13 站 4.6.3）
…
         return new StockLevels(productIds.stream().distinct().filter(m::containsKey).map(id -> new StockLevel(id, m.get(id))).toList());
     }
 
+    @GetMapping("/stock/snapshot")
+    StockSnapshot snapshot(@RequestParam(defaultValue = "0") long after, @RequestParam(defaultValue = "500") int limit) {
+        return new StockSnapshot(inventory.stockSnapshot(after, limit));
+    }
+
     @GetMapping("/stock/{productId}/display")
     StockLevel display(@PathVariable long productId, @RequestParam boolean hot) {
         return new StockLevel(productId, inventory.availableForDisplay(productId, hot));
```

**`src/main/java/com/example/shop/inventory/internal/web/InventoryWire.java`**（5.6）

```diff
 
     public record StockLevels(List<StockLevel> items) {}
 
+    /** 13 站 5.6：GET /stock/snapshot —— 重建讀模型用：可售量與版本，依 productId 由小到大 */
+    public record StockSnapshot(List<com.example.shop.inventory.StockVersion> items) {}
+
     /** POST /reservations/query：500 個 orderId 放在 URL 上會超過 8 KB（Tomcat 的預設上限）—— 查詢用 POST，它還是唯讀、可以重送 */
     public record ReservationsQuery(List<Long> orderIds) {}
 
```

**`src/main/java/com/example/shop/inventory/internal/remote/InventoryClient.java`**（5.6、5.9）

```diff
     @GetExchange("/stock")
     StockLevels stock(@RequestParam List<Long> productIds);
 
-    @GetExchange("/stock/{productId}/display")
-    StockLevel display(@PathVariable long productId, @RequestParam boolean hot);
+    @GetExchange("/stock/snapshot")
+    StockSnapshot snapshot(@RequestParam long after, @RequestParam int limit);
+
 
     @PutExchange("/reservations/{orderId}")
     ResponseEntity<Void> reserve(@PathVariable long orderId, @RequestBody ReserveRequest body);
```

**`src/main/java/com/example/shop/inventory/internal/remote/RemoteInventoryApi.java`**（5.6、5.7、5.9）

```diff
         run("set-hot", () -> client.hot(productId, new HotRequest(hot)));
     }
 
+    /**
+     * 13 站 5.7：訂單服務不問這一個 —— 它讀自己的副本（stock_levels 的 hot，ReplicaStockLevels）。
+     * 沒有對應的端點：一支沒有人該打的端點，切開之後就是一支打得到的端點（3.4 拿掉 initialize 的同一個理由）
+     */
+    @Override
+    public java.util.Set<Long> hotProducts() {
+        throw new UnsupportedOperationException("切開的訂單服務讀自己的副本（13 站 5.7）");
+    }
+
     @Override
     public void gateHot(List<ReserveLine> hotLines) {
         if (hotLines.isEmpty()) return;
…
 
     // ───────── 讀 ─────────
 
+    /**
+     * 13 站 5.4：訂單服務的商品頁讀自己的副本（ReplicaStockLevels），不再打 GET /stock/{id}/display。
+     * 端點留著（線上那一版的訂單服務還在打）；呼叫端這一邊拿掉：一個沒有人用的遠端呼叫，就是一份沒有人守的契約
+     */
     @Override
     public int availableForDisplay(long productId, boolean hot) {
-        return call("display", () -> client.display(productId, hot)).available();
+        throw new UnsupportedOperationException("切開的訂單服務讀自己的副本（13 站 5.4）");
     }
 
     @Override
…
         return out;
     }
 
+    @Override
+    public List<com.example.shop.inventory.StockVersion> stockSnapshot(long afterProductId, int limit) {
+        return call("stock-snapshot", () -> client.snapshot(afterProductId, limit)).items();
+    }
+
     @Override
     public List<ReservationRef> activeReservations(long afterId, Instant createdBefore, int limit) {
         return call("active-reservations", () -> client.active(afterId, createdBefore.toString(), limit)).items();
```

**`src/main/java/com/example/shop/shared/config/ShopProperties.java`**（5.7.4）

```diff
             @NotNull @DefaultValue("1m") @DurationMin(seconds = 5) Duration hotReconcileInterval,
             @DefaultValue("true") boolean jobsEnabled,
             /** 第 07 章（7.10）：INV-2、INV-3 的對帳（0.4.6：每小時） */
-            @NotNull @DefaultValue("1h") @DurationMin(minutes = 1) Duration invariantCheckInterval) {}
+            @NotNull @DefaultValue("1h") @DurationMin(minutes = 1) Duration invariantCheckInterval,
+            /** 13 站 5.7：catalog 的「全部的熱點商品」（HotProducts）多久重讀一次。0 = 每一次都讀（測試用） */
+            @NotNull @DefaultValue("1s") Duration hotListRefresh) {}
 
     /** 第 06 章：0.6.5 的三條限流。數字是需求，不是調校參數 —— 改它要改 0.6.5 */
     public record RateLimit(
```

**`src/main/java/com/example/shop/shared/events/EventTypes.java`**（5.4.2）

```diff
     public static final String HOT_SETTLEMENT_FAILED = "inventory.hot-settlement-failed";
     /** lines: [{productId, quantity}] —— 取消、補貨之後，熱點商品的 Redis 閘門要加回去（6.5.3） */
     public static final String STOCK_RETURNED = "inventory.stock-returned";
+    /**
+     * 13 站 5.4：items: [{productId, available, version, hot}] —— 這幾個商品的可售量變了（預留、落帳、釋放、補貨、建立；5.7：熱點旗標）。
+     * 跟那一次改變同一個交易寫進 outbox；version 是 inventory 那一列的版本，收的那一邊只留比較新的。訂單服務的讀模型（catalog 的 stock_levels）收它
+     */
+    public static final String STOCK_CHANGED = "inventory.stock-changed";
 }
```

**`src/test/java/com/example/shop/dist05/F1QueryPainTest.java`**（5.2、5.10.2）

```java
package com.example.shop.dist05;

import com.example.shop.ShopApplication;
import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.CallTap;
import com.example.shop.dist03.LostResponse;
import com.example.shop.dist03.Roles;
import com.example.shop.shared.web.Role;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 13 站 5.2：第 04 章之後，庫存這一刀不再切斷任何一個交易 —— 但還有 9 種同步呼叫，5 種是讀（4.10.4）。
 * 「讀」的三個頁面：商品詳情、購物車、賣家的商品列表。它們每一次都問庫存服務「這幾個商品可以賣幾件」。
 * 四段：庫存服務正常 → 每一次讀慢 200 ms → 每一次讀慢 1 秒 → 停掉。對照：同一個訂單服務的「我的訂單」（只讀自己的庫），
 * 以及單體（一個行程）正常的時候。也數一數每一頁打了庫存服務幾次（第 03 章的 CallTap）。
 *
 *   mvn test -Pexperiments -Dtest=F1QueryPainTest
 */
@Tag("experiment")
class F1QueryPainTest {

    static final String MONO_DB = "shop_d05_mono";
    static final int MONO_REDIS = 11;
    static final long BUYER = 5_100_001L;

    final PrintStream out = System.out;

    record Page(String name, String path, long user, boolean seller) {}
    record Res(int status, long nanos) {}

    final List<Page> pages = List.of(
            new Page("商品詳情", "/api/products/" + (SplitLab.FIRST_PRODUCT + 7), 0, false),
            new Page("購物車", "/api/cart", BUYER, false),
            new Page("賣家的商品", "/api/seller/products?page=0&size=20", SplitLab.SELLER, true),
            new Page("我的訂單", "/api/orders", BUYER, false));

    @Test
    void readsAcrossTheCut() throws Exception {
        out.printf("═══ 5.2 三個「讀」的頁面，庫存服務正常、變慢、停掉（load %s）═══%n", SplitLab.load());
        SplitLab.freshDatabase(MONO_DB);
        Split.freshDatabases();
        com.example.shop.dist04.Nodes.flushRedis(MONO_REDIS);
        com.example.shop.dist04.Nodes.flushRedis(Split.ORDER_REDIS);
        com.example.shop.dist04.Nodes.flushRedis(Split.INV_REDIS);
        LostResponse.reset();
        try (ConfigurableApplicationContext mono = new SpringApplicationBuilder(ShopApplication.class).run(SplitLab.common(MONO_DB, MONO_REDIS).toArray(String[]::new))) {
            SplitLab.seed(MONO_DB, true, true);
            prepare(mono);
            Map<String, String> rows = new LinkedHashMap<>();
            measure(mono, "單體", 50, rows);
            rows.forEach((k, v) -> out.println(v));
        }
        ConfigurableApplicationContext inv = Roles.inventoryService(List.of("--lab.d03.lost-response=true"));
        try (ConfigurableApplicationContext order = Roles.orderService(inv, List.of("--lab.d03.call-tap=true"))) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            // 5.6：種子資料直接寫進庫存服務的庫，沒有事件 —— 第 05 章之後，訂單服務的副本是空的（第 04 章之前沒有副本：404）
            get(order, pages.get(0));
            out.printf("  副本還沒建：商品詳情 → %s%n", lastBody);
            HttpResponse<String> rebuilt = send(order, "POST", "/api/admin/stock-levels/rebuild", TestTokens.bearer(order, 1, Role.ADMIN), null);
            get(order, pages.get(0));
            out.printf("  重建副本 → %d %s；商品詳情 → %s%n", rebuilt.statusCode(), rebuilt.body().length() > 120 ? rebuilt.body().substring(0, 120) : rebuilt.body(), lastBody);
            prepare(order);
            for (Page p : pages) {                                          // 每一頁打了庫存服務幾次
                CallTap.CALLS.clear();
                get(order, p);
                Map<String, Integer> calls = new TreeMap<>();
                CallTap.CALLS.forEach(c -> calls.merge(c.method() + " " + c.path().replaceAll("[0-9]{4,}", "{id}"), 1, Integer::sum));
                out.printf("  %-6s → 庫存服務 %d 次 %s%n", p.name(), CallTap.CALLS.size(), calls);
            }
            Map<String, String> rows = new LinkedHashMap<>();
            measure(order, "切開：正常", 50, rows);
            LostResponse.arm("GET", "/stock", 200, Integer.MAX_VALUE);
            measure(order, "切開：每次讀慢 200 ms", 30, rows);
            LostResponse.reset();
            LostResponse.arm("GET", "/stock", 1_000, Integer.MAX_VALUE);
            measure(order, "切開：每次讀慢 1 秒", 20, rows);
            LostResponse.reset();
            inv.close();
            measure(order, "切開：庫存服務停掉", 20, rows);
            rows.forEach((k, v) -> out.println(v));
            CallTap.CALLS.clear();
            Res r = get(order, pages.get(0));
            out.printf("  庫存服務停掉時，商品詳情的回應：%d %s%n", r.status(), lastBody);
        } finally {
            if (inv.isActive()) inv.close();
            LostResponse.reset();
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    /** 買家的購物車放 5 個商品；先每一頁打一次（熱身、建快取） */
    void prepare(ConfigurableApplicationContext ctx) throws Exception {
        for (int i = 0; i < 5; i++)
            send(ctx, "POST", "/api/cart/items", TestTokens.bearer(ctx, BUYER), "{\"productId\":" + (SplitLab.FIRST_PRODUCT + 100 + i) + ",\"quantity\":1}");
        for (int i = 0; i < 20; i++) for (Page p : pages) get(ctx, p);
    }

    /** 每一頁交錯打 n 次 */
    void measure(ConfigurableApplicationContext ctx, String label, int n, Map<String, String> rows) {
        Map<String, List<Long>> lat = new LinkedHashMap<>();
        Map<String, Map<Integer, Integer>> codes = new LinkedHashMap<>();
        for (int i = 0; i < n; i++)
            for (Page p : pages) {
                Res r = get(ctx, p);
                lat.computeIfAbsent(p.name(), k -> new ArrayList<>()).add(r.nanos());
                codes.computeIfAbsent(p.name(), k -> new TreeMap<>()).merge(r.status(), 1, Integer::sum);
            }
        for (Page p : pages) {
            long[] s = lat.get(p.name()).stream().mapToLong(Long::longValue).sorted().toArray();
            rows.put(label + p.name(), String.format("  %-16s │ %-6s │ p50 %8.1f ms │ p99 %8.1f ms │ %s", label, p.name(),
                    SplitLab.pct(s, 50), SplitLab.pct(s, 99), codes.get(p.name())));
        }
    }

    String lastBody = "";

    Res get(ConfigurableApplicationContext ctx, Page p) {
        String token = p.user() == 0 ? null : p.seller() ? TestTokens.bearer(ctx, p.user(), Role.SELLER) : TestTokens.bearer(ctx, p.user());
        try {
            long t0 = System.nanoTime();
            HttpResponse<String> r = send(ctx, "GET", p.path(), token, null);
            lastBody = r.body().length() > 200 ? r.body().substring(0, 200) + "…" : r.body();
            return new Res(r.statusCode(), System.nanoTime() - t0);
        } catch (Exception e) {
            return new Res(-1, 0);
        }
    }

    static HttpResponse<String> send(ConfigurableApplicationContext ctx, String method, String path, String token, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + SplitLab.port(ctx) + path)).timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        if (token != null) b.header("Authorization", token);
        return SplitLab.CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }
}
```

**`src/test/java/com/example/shop/dist05/F2StalenessTest.java`**（5.5）

```java
package com.example.shop.dist05;

import com.example.shop.ShopApplication;
import com.example.shop.catalog.internal.StockReplica;
import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist03.Flow;
import com.example.shop.dist03.Roles;
import com.example.shop.dist03.Shop;
import com.example.shop.dist04.Nodes;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站 5.5：讀模型的過時視窗 —— 庫存服務改了之後，訂單服務的副本晚多久才跟上，使用者在那段時間裡看到什麼。
 *   A：每秒 N 張下單（開放式負載，各 3 個品項），量每一則 inventory.stock-changed 從寫進庫存服務的 outbox，到訂單服務的副本寫好，隔了多久
 *      （兩個庫在同一台 MySQL：庫存服務 outbox_events.created_at 對訂單服務 processed_messages.processed_at，同一個時鐘）
 *   B：「最後一件」—— 一個只剩 1 件的商品，買家 B 先看了商品頁（「還有 1 件」），買家 A 買走它；之後 B 每 5 ms 看一次商品頁，
 *      看到 0 之前看了多久的「1」。單體（第 12 站 6.4.4：可售量快取 5 秒）與切開（副本）各 20 次。
 *
 *   mvn test -Pexperiments -Dtest=F2StalenessTest
 */
@Tag("experiment")
class F2StalenessTest {

    static final String MONO_DB = "shop_d05_mono";
    static final int MONO_REDIS = 11;
    static final AtomicLong BUYERS = new AtomicLong(5_200_000);

    final PrintStream out = System.out;

    @Test
    void stalenessWindow() throws Exception {
        out.printf("═══ 5.5 讀模型的過時視窗（load %s）═══%n", SplitLab.load());

        // ── B：單體（快取 5 秒）──
        SplitLab.freshDatabase(MONO_DB);
        Nodes.flushRedis(MONO_REDIS);
        Broker.freshVhost();
        try (ConfigurableApplicationContext mono = new SpringApplicationBuilder(ShopApplication.class)
                .run(Split.override(SplitLab.common(MONO_DB, MONO_REDIS), Broker.args()).toArray(String[]::new))) {   // 同名的參數要蓋掉，不能接在後面（第 01 章 1.4.5）
            SplitLab.seed(MONO_DB, true, true);
            lastUnit(new Shop(mono), "單體（商品頁的可售量快取 5 秒）", () -> true);
        }

        // ── 切開 ──
        Split.freshDatabases();
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        Broker.freshVhost();
        try (ConfigurableApplicationContext inv = Roles.inventoryService(Broker.args());
             ConfigurableApplicationContext order = Roles.orderService(inv, Broker.args())) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            StockReplica replica = order.getBean(StockReplica.class);
            StockReplica.Rebuilt r = replica.rebuild(500);
            out.printf("  切開：副本一開始是空的（種子資料直接寫進庫存服務的庫，沒有事件）→ 重建 %s%n", r);
            Shop shop = new Shop(inv, () -> SplitLab.port(order));

            // A：負載下的延遲
            for (int rate : new int[]{20, 100}) lag(order, inv, shop, rate, 30);

            // B
            lastUnit(shop, "切開（副本）", () -> true);
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    /** A：每秒 rate 張、持續 seconds 秒；之後量這段時間裡每一則 stock-changed 的延遲 */
    void lag(ConfigurableApplicationContext order, ConfigurableApplicationContext inv, Shop shop, int rate, int seconds) throws Exception {
        long since = SplitLab.count(Split.INV_DB, "SELECT COALESCE(MAX(id), 0) FROM outbox_events");
        AtomicInteger ok = new AtomicInteger(), bad = new AtomicInteger();
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        long t0 = System.nanoTime(), period = 1_000_000_000L / rate;
        for (long i = 0; i < (long) rate * seconds; i++) {
            long wait = t0 + i * period - System.nanoTime();
            if (wait > 0) Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000));
            pool.submit(() -> {
                long[] ids = java.util.concurrent.ThreadLocalRandom.current().longs(0, SplitLab.PRODUCTS).distinct().limit(3).map(x -> SplitLab.FIRST_PRODUCT + x).toArray();
                try {
                    if (shop.place(BUYERS.incrementAndGet(), UUID.randomUUID().toString(), ids).status() == 201) ok.incrementAndGet(); else bad.incrementAndGet();
                } catch (Exception e) { bad.incrementAndGet(); }
            });
        }
        pool.shutdown();
        pool.awaitTermination(120, TimeUnit.SECONDS);
        Flow.quiet(List.of(order, inv), List.of(Split.ORDER_DB, Split.INV_DB), 60_000);
        String sql = """
                SELECT TIMESTAMPDIFF(MICROSECOND, o.created_at, p.processed_at) / 1000
                  FROM %s.outbox_events o JOIN %s.processed_messages p ON p.message_id = o.event_id AND p.consumer = 'catalog.stock-levels'
                 WHERE o.event_type = 'inventory.stock-changed' AND o.id > %d ORDER BY 1""".formatted(Split.INV_DB, Split.ORDER_DB, since);
        List<Double> ms = new ArrayList<>();
        try (var c = SplitLab.root(Split.ORDER_DB); var st = c.createStatement(); var rs = st.executeQuery(sql)) {
            while (rs.next()) ms.add(rs.getDouble(1));
        }
        long[] sorted = ms.stream().mapToLong(d -> (long) (d * 1_000_000)).sorted().toArray();
        out.printf("  A 每秒 %3d 張 × %d 秒 │ 下單 201 %,d、其他 %d │ stock-changed %,d 則 │ 延遲 p50 %6.1f ms │ p90 %6.1f ms │ p99 %7.1f ms │ max %7.1f ms%n",
                rate, seconds, ok.get(), bad.get(), ms.size(), SplitLab.pct(sorted, 50), SplitLab.pct(sorted, 90), SplitLab.pct(sorted, 99), SplitLab.pct(sorted, 100));
    }

    /** B：最後一件。回傳 B 看到「還有 1 件」的時間（ms）與 B 的下單結果 */
    void lastUnit(Shop shop, String label, java.util.function.BooleanSupplier ready) throws Exception {
        List<Long> stale = new ArrayList<>();
        List<Integer> bOrders = new ArrayList<>();
        int trials = 20;
        for (int t = 0; t < trials; t++) {
            long p = shop.createProduct("最後一件 " + t, 1);
            shop.publish(p);
            Nodes.until(() -> available(shop, p) == 1, 30_000);              // 庫存列建好了、副本（或快取）也看到了
            long a = BUYERS.incrementAndGet(), b = BUYERS.incrementAndGet();
            available(shop, p);                                             // B 先看了一次商品頁：「還有 1 件」
            Shop.Res r = shop.place(a, UUID.randomUUID().toString(), p);    // A 買走它
            if (r.status() != 201) throw new IllegalStateException("A 下單 " + r.brief());
            long t0 = System.nanoTime();
            int bOrder = shop.place(b, UUID.randomUUID().toString(), p).status();   // B 緊接著也下單
            while (available(shop, p) != 0 && System.nanoTime() - t0 < 10_000_000_000L) Thread.sleep(5);
            stale.add((System.nanoTime() - t0) / 1_000_000);
            bOrders.add(bOrder);
        }
        long[] s = stale.stream().mapToLong(x -> x * 1_000_000).sorted().toArray();
        java.util.Map<Integer, Integer> codes = new java.util.TreeMap<>();
        bOrders.forEach(c -> codes.merge(c, 1, Integer::sum));
        out.printf("  B %-30s │ %d 次 │ A 買走之後，商品頁還說「1 件」：p50 %6.0f ms │ max %6.0f ms │ 每一次 %s │ B 緊接著下單 %s%n",
                label, trials, SplitLab.pct(s, 50), SplitLab.pct(s, 100), stale, codes);
    }

    static int available(Shop shop, long productId) {
        try {
            return shop.send("GET", "/api/products/" + productId, null, null, java.util.Map.of()).json().get("available").asInt();
        } catch (Exception e) {
            return -1;
        }
    }
}
```

**`src/test/java/com/example/shop/dist05/F3RebuildTest.java`**（5.6）

```java
package com.example.shop.dist05;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist03.Flow;
import com.example.shop.dist03.Roles;
import com.example.shop.dist03.Shop;
import com.example.shop.dist04.Nodes;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站 5.6：重建讀模型。庫存服務有 10 萬個商品（1,000 個是下單用的種子，其餘直接寫進庫存服務的庫）。
 *   ① 第一次上線：副本是空的 → 打一次 POST /api/admin/stock-levels/rebuild，要多久
 *   ② 副本壞了三種：值錯了但版本一樣（100 列）、整列不見（100 列）、庫存改了卻沒有事件 —— 漏了事件（100 列，庫存那一列的版本往前了）；
 *      每秒 20 張下單（開放式負載）的同時再重建一次；事件都送完之後，副本跟庫存服務的庫逐列比對
 *
 *   mvn test -Pexperiments -Dtest=F3RebuildTest
 */
@Tag("experiment")
class F3RebuildTest {

    static final long EXTRA_FIRST = 9_100_001L;
    static final int EXTRA = 99_000;
    static final AtomicLong BUYERS = new AtomicLong(5_300_000);

    final PrintStream out = System.out;

    @Test
    void rebuild() throws Exception {
        out.printf("═══ 5.6 重建讀模型：10 萬個商品（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        Broker.freshVhost();
        try (ConfigurableApplicationContext inv = Roles.inventoryService(Broker.args());
             ConfigurableApplicationContext order = Roles.orderService(inv, Broker.args())) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            try (Connection c = SplitLab.root(Split.INV_DB);
                 PreparedStatement ps = c.prepareStatement("INSERT INTO inventory (product_id, on_hand, reserved, version) VALUES (?, ?, 0, 1)")) {
                c.setAutoCommit(false);
                for (int i = 0; i < EXTRA; i++) {
                    ps.setLong(1, EXTRA_FIRST + i);
                    ps.setInt(2, ThreadLocalRandom.current().nextInt(0, 100));
                    ps.addBatch();
                    if (i % 5_000 == 4_999) ps.executeBatch();
                }
                ps.executeBatch();
                c.commit();
            }
            out.printf("  庫存服務：%,d 個商品；副本：%,d 列%n", SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM inventory"),
                    SplitLab.count(Split.ORDER_DB, "SELECT COUNT(*) FROM stock_levels"));
            Shop shop = new Shop(inv, () -> SplitLab.port(order));
            String admin = TestTokens.bearer(order, 1, Role.ADMIN);

            // ① 第一次上線
            Shop.Res r = shop.send("POST", "/api/admin/stock-levels/rebuild", admin, null, Map.of());
            out.printf("  ① 第一次上線，重建 → %d %s（HTTP 來回 %,d ms）；對不上的 %,d 列%n", r.status(), r.body(), r.millis(), diff());

            // ② 弄壞三種
            exec(Split.ORDER_DB, "UPDATE stock_levels SET available = available + 7 WHERE product_id BETWEEN " + EXTRA_FIRST + " AND " + (EXTRA_FIRST + 99));
            exec(Split.ORDER_DB, "DELETE FROM stock_levels WHERE product_id BETWEEN " + (EXTRA_FIRST + 100) + " AND " + (EXTRA_FIRST + 199));
            exec(Split.INV_DB, "UPDATE inventory SET on_hand = on_hand + 3, version = version + 1 WHERE product_id BETWEEN " + (EXTRA_FIRST + 200) + " AND " + (EXTRA_FIRST + 299));
            out.printf("  ② 弄壞之後：對不上的 %,d 列（值錯了、版本一樣 100；不見了 100；漏了事件 100）%n", diff());

            AtomicBoolean stop = new AtomicBoolean();
            AtomicInteger ok = new AtomicInteger(), bad = new AtomicInteger();
            ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
            Thread sender = new Thread(() -> {
                long t0 = System.nanoTime();
                for (long i = 0; !stop.get(); i++) {
                    long wait = t0 + i * 50_000_000L - System.nanoTime();
                    if (wait > 0) try { Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000)); } catch (InterruptedException e) { return; }
                    pool.submit(() -> {
                        long[] ids = ThreadLocalRandom.current().longs(0, SplitLab.PRODUCTS).distinct().limit(3).map(x -> SplitLab.FIRST_PRODUCT + x).toArray();
                        try {
                            if (shop.place(BUYERS.incrementAndGet(), UUID.randomUUID().toString(), ids).status() == 201) ok.incrementAndGet(); else bad.incrementAndGet();
                        } catch (Exception e) { bad.incrementAndGet(); }
                    });
                }
            });
            sender.start();
            Thread.sleep(3_000);
            r = shop.send("POST", "/api/admin/stock-levels/rebuild", admin, null, Map.of());
            Thread.sleep(3_000);
            stop.set(true);
            sender.join();
            pool.shutdown();
            pool.awaitTermination(60, TimeUnit.SECONDS);
            Flow.quiet(List.of(order, inv), List.of(Split.ORDER_DB, Split.INV_DB), 60_000);
            out.printf("  ② 每秒 20 張下單的同時重建 → %d %s；下單 201 %,d、其他 %d%n", r.status(), r.body(), ok.get(), bad.get());
            out.printf("     事件都送完之後：對不上的 %,d 列（10 萬列逐列比對）%n", diff());
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    /** 副本跟庫存服務的庫逐列比對（兩個庫在同一台 MySQL：實驗才寫得出這一句） */
    static long diff() throws Exception {
        return SplitLab.count(Split.INV_DB, "SELECT COUNT(*) FROM " + Split.INV_DB + ".inventory i LEFT JOIN " + Split.ORDER_DB
                + ".stock_levels s ON s.product_id = i.product_id WHERE s.product_id IS NULL OR s.available <> i.on_hand - i.reserved");
    }

    static void exec(String db, String sql) throws Exception {
        try (Connection c = SplitLab.root(db); var st = c.createStatement()) { st.execute(sql); }
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/StockChangedEventsTest.java`**（5.4.2）

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.ReserveLine;
import com.example.shop.support.TestInfra;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 5.4：庫存那一邊 —— 可售量變了，就跟那一次改變同一個交易寫一則 inventory.stock-changed，帶著 inventory 那一列的版本。
 * 出庫（on_hand、reserved 一起減）可售量不變：版本照樣加 1，不發事件。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
class StockChangedEventsTest {

    static final long PRODUCT = 9_900_901, O1 = 99_090_101L, O2 = 99_090_102L;

    @Autowired JdbcInventoryService inventory;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired PlatformTransactionManager tm;

    @BeforeEach
    @AfterEach
    void cleanup() {
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        TestInfra.adminJdbc().update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        for (long o : List.of(O1, O2)) jdbc.update("DELETE FROM processed_messages WHERE consumer = 'inventory.http.reserve' AND message_id = ?", String.valueOf(o));
        jdbc.update("DELETE FROM outbox_events WHERE event_type IN ('inventory.stock-changed', 'inventory.stock-returned') AND payload LIKE ?", "%" + PRODUCT + "%");
    }

    /** 這個商品的 stock-changed，依寫進 outbox 的順序：「聚合 id：可售量 v版本」 */
    List<String> events() throws Exception {
        List<String> out = new ArrayList<>();
        for (var row : jdbc.queryForList("SELECT aggregate_type, aggregate_id, payload FROM outbox_events WHERE event_type = 'inventory.stock-changed' AND payload LIKE ? ORDER BY id",
                "%" + PRODUCT + "%")) {
            for (JsonNode i : json.readTree((String) row.get("payload")).get("items"))
                out.add(row.get("aggregate_type") + ":" + row.get("aggregate_id") + " " + i.get("available").asInt() + " v" + i.get("version").asLong());
        }
        return out;
    }

    @Test @DisplayName("13 站 5.4：補貨、預留、釋放各發一則（帶著版本）；確認、出庫不發 —— 版本照樣往前")
    void everyChangeOfAvailableIsAnEvent() throws Exception {
        TransactionTemplate tx = new TransactionTemplate(tm);
        inventory.restock(PRODUCT, 5, "stock-changed-test");                          // 還沒有庫存列：建一列，version 1
        inventory.reserve(O1, List.of(new ReserveLine(PRODUCT, 2)), List.of());          // 5 → 3，version 2
        tx.executeWithoutResult(s -> inventory.confirm(O1));                              // 只改預留：不動 inventory 那一列
        tx.executeWithoutResult(s -> inventory.consume(O1));                              // on_hand 5 → 3、reserved 2 → 0：可售量 3 不變，version 3
        inventory.reserve(O2, List.of(new ReserveLine(PRODUCT, 1)), List.of());          // 3 → 2，version 4
        tx.executeWithoutResult(s -> inventory.release(O2));                              // 2 → 3，version 5
        long version = jdbc.queryForObject("SELECT version FROM inventory WHERE product_id = ?", Long.class, PRODUCT);
        System.out.println("5.4 stock-changed：" + events() + "；inventory 那一列的版本 " + version);
        assertThat(events()).containsExactly("INVENTORY:" + PRODUCT + " 5 v1", "INVENTORY:" + O1 + " 3 v2", "INVENTORY:" + O2 + " 2 v4", "INVENTORY:" + O2 + " 3 v5");
        assertThat(version).isEqualTo(5);
    }
}
```

**`src/test/java/com/example/shop/catalog/internal/StockReplicaTest.java`**（5.4.3、5.6.2）

```java
package com.example.shop.catalog.internal;

import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.StockVersion;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 13 站 5.4、5.6：訂單服務裡的庫存副本。StockReplica 只在切開的訂單服務裡是一個 bean（單體不需要副本）——
 * 這裡在單體的 context 裡直接 new 一個（stock_levels 這張表每一種部署都建，第 02 章 2.4.2），庫存服務換成一個 mock 的快照。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
class StockReplicaTest {

    static final long A = 9_900_911, B = 9_900_912, C = 9_900_913;

    @Autowired JdbcTemplate jdbc;
    final InventoryApi inventory = mock(InventoryApi.class);
    StockReplica replica;

    @BeforeEach
    void setUp() {
        cleanup();
        replica = new StockReplica(jdbc, inventory);
    }

    @AfterEach
    void cleanup() {
        jdbc.update("DELETE FROM stock_levels WHERE product_id IN (?, ?, ?)", A, B, C);
    }

    @Test @DisplayName("13 站 5.4：亂序 —— 版本 3 先到、版本 2 後到：留下 3 的值；同一個版本再來一次：不變；沒有的商品不在結果裡")
    void newerVersionWins() {
        Instant t = Instant.now();
        replica.apply(A, 7, false, 3, t);
        replica.apply(A, 9, false, 2, t);                                   // 晚到的舊值
        replica.apply(A, 7, false, 3, t);                                   // 同一則再來一次（另一個消費者實例、或重建讀到同一個版本）
        Map<Long, Integer> got = replica.available(List.of(A, C));
        System.out.println("5.4 版本 3 → 2 → 3：" + got + "；version " + jdbc.queryForObject("SELECT version FROM stock_levels WHERE product_id = ?", Long.class, A));
        assertThat(got).containsExactly(Map.entry(A, 7));
    }

    @Test @DisplayName("13 站 5.6：重建途中進來的事件不會被快照蓋回去 —— 快照讀到版本 5，事件已經寫了版本 6")
    void rebuildDoesNotOverwriteNewerEvents() {
        replica.apply(A, 4, false, 6, Instant.now());                       // 事件先到：版本 6
        when(inventory.stockSnapshot(0, 2)).thenReturn(List.of(new StockVersion(A, 5, 5, false), new StockVersion(B, 10, 1, false)));
        when(inventory.stockSnapshot(B, 2)).thenReturn(List.of(new StockVersion(C, 0, 2, false)));
        StockReplica.Rebuilt r = replica.rebuild(2);
        Map<Long, Integer> got = replica.available(List.of(A, B, C));
        System.out.println("5.6 重建：" + r + "；之後 " + got);
        assertThat(r.pages()).isEqualTo(2);
        assertThat(r.products()).isEqualTo(3);
        assertThat(got).containsEntry(A, 4).containsEntry(B, 10).containsEntry(C, 0);
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/HotListStaleTest.java`**（5.7.5）

```java
package com.example.shop.ordering.internal;

import com.example.shop.catalog.CatalogApi;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.ordering.OrderingApi;
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
import org.springframework.context.ApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 5.7：熱點名單晚一秒（catalog 的 HotProducts 每秒重讀一次；正式環境的設定，測試預設是 0）。兩個方向：
 *   ① 剛標成熱點、名單還沒有它 → 這一張走一般的預留：MySQL 直接計入，閘門沒有扣（Redis 偏高 1 件：第 12 站 6.5.3 的安全方向）
 *   ② 剛取消熱點、名單還有它  → 這一張去過閘門：庫存說它不是熱點，不扣、不建 key；照樣走熱點那一路的預留，落帳時計入
 * 兩個方向，MySQL 的帳都對：沒有一件賣超過，也沒有一件被鎖住。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false", "shop.inventory.hot-list-refresh=1s"})
class HotListStaleTest {

    static final long P = 9_900_981, SELLER = 2, BUYER = 990_981;

    @Autowired OrderingApi ordering;
    @Autowired CatalogApi catalog;
    @Autowired @Qualifier("jdbcInventoryService") InventoryApi inventory;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired ApplicationContext ctx;

    @BeforeEach
    void setUp() {
        cleanup();
        InlineEvents.skipBacklog(ctx);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '名單測試', 100.00, 'ON_SALE')", P, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 5, 0)", P);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 5, 0, 'INITIAL', 'hot-list')", P);
    }

    @AfterEach
    void cleanup() {
        for (String t : List.of("order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        for (long id : jdbc.queryForList("SELECT id FROM orders WHERE buyer_id BETWEEN ? AND ?", Long.class, BUYER, BUYER + 9))
            jdbc.update("DELETE FROM processed_messages WHERE consumer = 'inventory.http.reserve' AND message_id = ?", String.valueOf(id));
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM orders WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", P);
        TestInfra.adminJdbc().update("DELETE FROM inventory_ledger WHERE product_id = ?", P);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", P);
        jdbc.update("DELETE FROM products WHERE id = ?", P);
        TestRedis.forgetProducts(redis, P);
    }

    long place(long buyer) {
        return ordering.placeOrder(buyer, UUID.randomUUID().toString(), List.of(new OrderingApi.OrderLine(P, 1, new BigDecimal("100")))).orderId();
    }

    Map<String, Object> state(long orderId) {
        return jdbc.queryForMap("""
                SELECT (SELECT reserved FROM inventory WHERE product_id = ?) AS reserved,
                       (SELECT counted + 0 FROM inventory_reservations WHERE order_id = ?) AS counted,
                       (SELECT hot + 0 FROM order_items WHERE order_id = ?) AS item_hot""", P, orderId, orderId);
    }

    String gate() { return redis.opsForValue().get("stock:" + P); }

    @Test @DisplayName("13 站 5.7 ①：剛標成熱點、名單還沒有它 → 一般的預留（直接計入），閘門沒扣；一秒之後名單有它 → 過閘門")
    void justMarkedHot() throws Exception {
        assertThat(catalog.hotProducts(List.of(P))).isEmpty();             // 名單剛讀過：沒有它（之後一秒內都是這一份）
        inventory.setHot(P, true);                                          // 庫存：hot = TRUE、閘門 5
        long o1 = place(BUYER);
        Map<String, Object> s1 = state(o1);
        String gate1 = gate();
        Thread.sleep(1_100);
        long o2 = place(BUYER + 1);
        Map<String, Object> s2 = state(o2);
        System.out.println("5.7 ① 剛標成熱點：第一張 " + s1 + "、閘門 " + gate1 + "；一秒之後第二張 " + s2 + "、閘門 " + gate());
        assertThat(s1).containsEntry("counted", 1L).containsEntry("item_hot", 0L).containsEntry("reserved", 1);
        assertThat(gate1).isEqualTo("5");                                   // Redis 比 MySQL（4）多 1：偏高，熱點對帳會修（6.6）
        assertThat(s2).containsEntry("counted", 0L).containsEntry("item_hot", 1L);
        assertThat(gate()).isEqualTo("4");
    }

    @Test @DisplayName("13 站 5.7 ②：剛取消熱點、名單還有它 → 去過閘門，庫存說不是熱點：不扣、不建 key；走熱點那一路的預留，落帳時計入")
    void justUnmarked() {
        inventory.setHot(P, true);
        assertThat(catalog.hotProducts(List.of(P))).containsExactly(P);    // 名單剛讀過：有它
        inventory.setHot(P, false);                                         // 庫存：hot = FALSE、閘門的 key 刪掉
        long o = place(BUYER);
        Map<String, Object> before = state(o);
        Boolean key = redis.hasKey("stock:" + P);
        InlineEvents.deliverTo(ctx, r -> r.aggregateId() == o && r.eventType().equals("order.placed"), "inventory.hot-settlement");
        Map<String, Object> after = state(o);
        System.out.println("5.7 ② 剛取消熱點：下單之後 " + before + "、閘門的 key 在嗎 " + key + "；落帳之後 " + after);
        assertThat(before).containsEntry("counted", 0L).containsEntry("item_hot", 1L).containsEntry("reserved", 0);
        assertThat(key).isFalse();
        assertThat(after).containsEntry("counted", 1L).containsEntry("reserved", 1);
    }
}
```

**`src/test/java/com/example/shop/catalog/internal/StockChangedPactTest.java`**（5.9）

```java
package com.example.shop.catalog.internal;

import au.com.dius.pact.consumer.MessagePactBuilder;
import au.com.dius.pact.consumer.dsl.PactDslJsonBody;
import au.com.dius.pact.consumer.junit5.PactConsumerTestExt;
import au.com.dius.pact.consumer.junit5.PactTestFor;
import au.com.dius.pact.consumer.junit5.ProviderType;
import au.com.dius.pact.core.model.PactSpecVersion;
import au.com.dius.pact.core.model.V4Interaction;
import au.com.dius.pact.core.model.V4Pact;
import au.com.dius.pact.core.model.annotations.Pact;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.shared.events.Event;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.Timestamp;
import java.time.Instant;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

/**
 * 13 站 5.4：訂單服務的副本「怎麼讀」庫存服務的 inventory.stock-changed —— 每一筆的 productId、available、version、hot（5.7）。
 * 跟 HTTP 的契約、inventory.hot-settlement-failed 同一對服務，寫進同一份 order-service-inventory-service.json（3.8.6 的追記：V4）
 */
@ExtendWith(PactConsumerTestExt.class)
@PactTestFor(providerName = "inventory-service", providerType = ProviderType.ASYNCH, pactVersion = PactSpecVersion.V4)
class StockChangedPactTest {

    @Pact(consumer = "order-service")
    V4Pact stockChanged(MessagePactBuilder b) {
        return b.expectsToReceive("inventory.stock-changed：補貨之後的可售量")
                .withContent(new PactDslJsonBody().minArrayLike("items", 1)
                        .integerType("productId", 9001).integerType("available", 15).integerType("version", 3).booleanType("hot", false)
                        .closeObject().closeArray())
                .toPact(V4Pact.class);
    }

    @Test @PactTestFor(pactMethod = "stockChanged")
    void stockChanged(V4Interaction.AsynchronousMessage m) throws Exception {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        new StockReplica(jdbc, mock(InventoryApi.class)).handle(new Event("pact-stock", "inventory.stock-changed", "INVENTORY", 9001, Instant.now(),
                new ObjectMapper().readTree(m.getContents().getContents().valueAsString()), 1));
        verify(jdbc).update(eq(StockReplica.UPSERT), eq(9001L), eq(15), eq(false), eq(3L), any(Timestamp.class));
    }
}
```

**`src/test/java/com/example/shop/api/HotToggleApiTest.java`**（5.7.7）

```diff
         assertThat(gateAfterUnmark).isFalse();
         assertThat(o2).isEqualTo(201);
         assertThat(counted2).as("不是熱點：下單交易裡就計入").isEqualTo(1);
+        // 13 站 5.7：旗標的擁有者是庫存 —— 取消熱點之後 inventory.hot 也是 false
+        assertThat(jdbc.queryForObject("SELECT hot + 0 FROM inventory WHERE product_id = ?", Integer.class, PRODUCT)).isZero();
+    }
+
+    @Test @DisplayName("13 站 5.7：搬家 —— 第 05 章之前標的熱點只在 products.hot；管理員打一次 copy-to-inventory，庫存的旗標跟上、閘門建好")
+    void copyOldFlagsToInventory() throws Exception {
+        jdbc.update("UPDATE products SET hot = TRUE WHERE id = ?", PRODUCT);  // 舊的旗標：第 05 章之前的 setHot 只寫這裡
+        int before = jdbc.queryForObject("SELECT hot + 0 FROM inventory WHERE product_id = ?", Integer.class, PRODUCT);
+        var r = mvc.perform(post("/api/admin/hot-flags/copy-to-inventory").header("Authorization", TestTokens.bearer(tokens, 1, Role.ADMIN)))
+                .andReturn().getResponse();
+        int after = jdbc.queryForObject("SELECT hot + 0 FROM inventory WHERE product_id = ?", Integer.class, PRODUCT);
+        System.out.printf("5.7 搬家：%d %s；inventory.hot %d → %d；閘門 stock:%d = %s%n", r.getStatus(), r.getContentAsString(), before, after,
+                PRODUCT, redis.opsForValue().get("stock:" + PRODUCT));
+        assertThat(r.getStatus()).isEqualTo(200);
+        assertThat(before).isZero();
+        assertThat(after).isEqualTo(1);
+        assertThat(redis.opsForValue().get("stock:" + PRODUCT)).isEqualTo("5");
     }
 }
```

**`src/test/java/com/example/shop/inventory/internal/remote/InventoryClientPactTest.java`**（5.9）

```diff
         assertThat(m).containsEntry(9001L, 10).doesNotContainKey(9002L);
     }
 
+    // 13 站 5.4：「商品頁顯示用的可售量」（GET /stock/{id}/display）從這一份契約拿掉了 —— 訂單服務的商品頁改讀自己的副本，不再打它。
+    // 端點本身還在：線上那一版（第 03 章）的訂單服務還在打（InventoryProviderReleasedPactIT 照樣驗證它）
+
+    /** 13 站 5.6：重建副本用的快照（keyset 分頁，帶著版本與熱點旗標） */
     @Pact(consumer = "order-service")
-    V4Pact display(PactDslWithProvider b) {
+    V4Pact snapshot(PactDslWithProvider b) {
         return b.given("商品 9001 有 10 件可售，商品 9002 沒有庫存列")
-                .uponReceiving("商品頁顯示用的可售量").method("GET").path("/internal/inventory/v1/stock/9001/display")
-                .query("hot=false").matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
+                .uponReceiving("重建副本：可售量與版本的快照").method("GET").path("/internal/inventory/v1/stock/snapshot")
+                .query("after=0&limit=500").matchHeader("Authorization", BEARER, EXAMPLE_TOKEN)
                 .willRespondWith().status(200)
-                .body(new PactDslJsonBody().integerType("productId", 9001).integerType("available", 10))
+                .body(new PactDslJsonBody().minArrayLike("items", 1).integerType("productId", 9001).integerType("available", 10)
+                        .integerType("version", 1).booleanType("hot", false).closeObject().closeArray())
                 .toPact(V4Pact.class);
     }
 
-    @Test @PactTestFor(pactMethod = "display")
-    void display(MockServer server) {
-        assertThat(api(server).availableForDisplay(9001L, false)).isEqualTo(10);
+    @Test @PactTestFor(pactMethod = "snapshot")
+    void snapshot(MockServer server) {
+        assertThat(api(server).stockSnapshot(0, 500)).extracting(com.example.shop.inventory.StockVersion::productId).contains(9001L);
     }
 
     // ───────── 預留 ─────────
```

**`src/test/java/com/example/shop/inventory/internal/web/InventoryEventMessages.java`**（5.9）

```diff
                 "SELECT payload FROM outbox_events WHERE event_type = 'inventory.hot-settlement-failed' AND aggregate_id = 7006 ORDER BY id DESC LIMIT 1", String.class);
         return new MessageAndMetadata(payload.getBytes(StandardCharsets.UTF_8), Map.of("contentType", "application/json"));
     }
+
+    /** 13 站 5.4：真的補貨（庫存模組自己的交易），它跟著寫進 outbox 的那一則 stock-changed */
+    @PactVerifyProvider("inventory.stock-changed：補貨之後的可售量")
+    public MessageAndMetadata stockChanged() {
+        InventoryProviderContract c = contract;
+        c.clean();
+        c.stock(9001, 10, 0);
+        c.ctx.getBean(com.example.shop.inventory.InventoryApi.class).restock(9001, 5, "pact");
+        String payload = c.jdbc.queryForObject(
+                "SELECT payload FROM outbox_events WHERE event_type = 'inventory.stock-changed' AND aggregate_id = 9001 ORDER BY id DESC LIMIT 1", String.class);
+        return new MessageAndMetadata(payload.getBytes(StandardCharsets.UTF_8), Map.of("contentType", "application/json"));
+    }
 }
```

**`src/test/java/com/example/shop/shared/messaging/internal/ServiceRoleConsumersTest.java`**（5.4.4）

```diff
 
     @Autowired List<EventHandler> handlers;
 
-    /** 13 站 4.6：多了 inventory.order-events（庫存模組收訂單的事件）—— 它在庫存模組，所以在庫存服務收 */
-    @Test @DisplayName("13 站 3.7：monolith 收 7 個；order-service 收 3 個、inventory-service 收 4 個，合起來剛好 7 個、沒有重複")
+    /**
+     * 13 站 4.6：多了 inventory.order-events（庫存模組收訂單的事件）—— 它在庫存模組，所以在庫存服務收。
+     * 13 站 5.4：多了 catalog.stock-levels（訂單服務裡庫存的副本）—— 它在 catalog，所以在訂單服務收（單體也收）
+     */
+    @Test @DisplayName("13 站 3.7：monolith 收 8 個；order-service 收 4 個、inventory-service 收 4 個，合起來剛好 8 個、沒有重複")
     void eachRoleConsumesOnlyItsOwnModules() {
         Map<ServiceRole, List<String>> got = new TreeMap<>();
         for (ServiceRole role : ServiceRole.values())
             got.put(role, RabbitConsumers.owned(handlers, role).stream().map(EventHandler::consumer).sorted().toList());
         got.forEach((role, consumers) -> System.out.printf("13 站 3.7：%-17s 收 %s%n", role.serviceName(), consumers));
 
-        assertThat(got.get(ServiceRole.MONOLITH)).hasSize(7);
-        assertThat(got.get(ServiceRole.ORDER_SERVICE)).containsExactly("notification.order-events", "ordering.stock-shortage", "payment.refunds");
+        assertThat(got.get(ServiceRole.MONOLITH)).hasSize(8);
+        assertThat(got.get(ServiceRole.ORDER_SERVICE)).containsExactly("catalog.stock-levels", "notification.order-events", "ordering.stock-shortage", "payment.refunds");
         assertThat(got.get(ServiceRole.INVENTORY_SERVICE)).containsExactly("inventory.hot-settlement", "inventory.hot-stock-return", "inventory.order-events",
                 "inventory.product-created");
         List<String> both = new ArrayList<>(got.get(ServiceRole.ORDER_SERVICE));
```

**`src/test/java/com/example/shop/dist01/CrossModuleCallInTxTest.java`**（5.7.6）

```diff
      * 13 站 4.5、4.6：ordering → InventoryApi 的四種全部拿掉了（10 → 6 種）。reserve 是下單 Saga 的一步，在任何交易之外；
      * confirm、release、consume 不在 InventoryApi 上了 —— 庫存模組收 order.paid、order.cancelled、order.shipped。
      * 剩下的 6 種都在訂單服務自己的庫裡（cart、payment 跟 ordering 在同一個服務）：庫存這一刀，不再切斷任何一個交易
+     * 13 站 5.7：「catalog → InventoryApi.setHot」拿掉了 —— 熱點旗標搬到庫存，catalog 在自己的交易之外先請庫存改（6 → 5 種）。
+     * 剩下的 5 種全部在訂單服務自己的庫裡：庫存這一刀，連一個交易內的呼叫都沒有了
      */
     static final Map<String, String> ALLOWED = Map.ofEntries(
-            entry("catalog → InventoryApi.setHot", "標熱點：MANDATORY，commit 之後建立 Redis 閘門（13 站 3.4.7：熱點旗標沒有搬）"),
             entry("ordering → CartApi.removeItems", "下單的 Saga 往前走完（RESERVED）：清購物車跟訂單狀態同一個交易 —— 同一個服務、同一個庫"),
             entry("ordering → PaymentApi.create", "建立付款：跟訂單同一個交易 —— 同一個服務、同一個庫"),
             entry("ordering → PaymentApi.record", "金流回呼：付款紀錄跟訂單狀態同一個交易 —— 同上"),
```

**`src/test/java/com/example/shop/architecture/TableOwnershipTest.java`**（5.4.1）

```diff
     static final Map<String, String> OWNER = Map.ofEntries(
             Map.entry("users", "account"), Map.entry("user_roles", "account"), Map.entry("refresh_tokens", "account"),
             Map.entry("products", "catalog"), Map.entry("categories", "catalog"),
+            Map.entry("stock_levels", "catalog"),                              // 13 站 5.4：庫存的副本，catalog 的表（只有它寫、它讀）
             Map.entry("inventory", "inventory"), Map.entry("inventory_reservations", "inventory"), Map.entry("inventory_ledger", "inventory"),
             Map.entry("inventory_ledger_checkpoints", "inventory"), Map.entry("inventory_ledger_watermark", "inventory"),
             Map.entry("cart_items", "cart"),
```

**`src/test/resources/config/application.yml`**（5.7.4）

```diff
 shop:
   rate-limit:
     requests-per-ip-per-second: 1000000
+  # 13 站 5.7：熱點名單（catalog 的 HotProducts）每一次都重讀。正式環境是 1 秒 —— 測試重用同一個 context，
+  # 前一個測試讀好的名單會留給下一個測試，剛標成熱點的商品要等一秒才算熱點。名單晚一秒是怎樣，由 HotListStaleTest 用 1 秒測
+  inventory:
+    hot-list-refresh: 0s
   # 第 07 章：測試環境預設不送、不收事件（7.12.1）。
   # 所有測試共用同一台 RabbitMQ，Spring 又會把測試的 context 留著重用 —— 一個測試類別的消費者，會吃掉另一個測試類別的訊息。
   # 要測事件流的（EventFlowTest、驗收 Q9、Q10、實驗）自己打開，並在結束時關掉 context。
```

**`src/test/java/com/example/shop/dist00/RemoteInventoryApi.java`**（InventoryApi 多兩個方法）

```diff
     @Override public java.util.List<com.example.shop.inventory.ReservationRef> activeReservations(long afterId, java.time.Instant createdBefore, int limit) { return local.activeReservations(afterId, createdBefore, limit); }
     @Override public Map<Long, java.util.List<com.example.shop.inventory.ReservationRef>> reservationsOf(Collection<Long> orderIds) { return local.reservationsOf(orderIds); }
     @Override public void releaseAbandoned(long orderId) { local.releaseAbandoned(orderId); }
+    // 13 站 5.7：熱點旗標在庫存（第 00 章還沒有它）
+    @Override public java.util.Set<Long> hotProducts() { return local.hotProducts(); }
+    // 13 站 5.6：重建讀模型的快照（第 00 章還沒有它）
+    @Override public java.util.List<com.example.shop.inventory.StockVersion> stockSnapshot(long afterProductId, int limit) { return local.stockSnapshot(afterProductId, limit); }
 
     // ── 0.2.3：商品頁的可售量。第一版照舊交給本地 —— 訂單服務的資料庫裡沒有庫存列，商品詳情每一次都是 500（EmptyResultDataAccessException）。
     //    可售量的「唯一寫入者」是庫存服務，訂單服務只能來問（沒有快取；熱點商品照舊讀 Redis 的副本）
```

**`src/test/java/com/example/shop/dist02/RemoteInventory.java`**（InventoryApi 多兩個方法）

```diff
 
     @Override public void releaseAbandoned(long orderId) { call("release-abandoned", Map.of("orderId", orderId)); }
 
+    /** 13 站 5.7：第 02 章的線沒有這一支（熱點旗標搬到庫存是第 05 章的事） */
+    @Override public java.util.Set<Long> hotProducts() {
+        throw new UnsupportedOperationException("第 02 章的線沒有 hotProducts");
+    }
+
+    /** 13 站 5.6：第 02 章的線沒有這一支（重建讀模型是第 05 章的事） */
+    @Override public java.util.List<com.example.shop.inventory.StockVersion> stockSnapshot(long afterProductId, int limit) {
+        throw new UnsupportedOperationException("第 02 章的線沒有 stockSnapshot");
+    }
+
     static ReservationRef ref(JsonNode r) {
         return new ReservationRef(r.get("id").asLong(), r.get("orderId").asLong(), r.get("productId").asLong(), r.get("quantity").asInt(), r.get("status").asText());
     }
```

**`src/test/java/com/example/shop/ordering/internal/PlaceOrderSagaTest.java`**（5.7.8、InventoryApi 多兩個方法）

```diff
         @Override public void gateHot(List<ReserveLine> hotLines) { real.gateHot(hotLines); }
         @Override public void returnHot(List<ReserveLine> hotLines) { real.returnHot(hotLines); }
         @Override public void setHot(long productId, boolean hot) { real.setHot(productId, hot); }
+        @Override public java.util.Set<Long> hotProducts() { return real.hotProducts(); }
         @Override public int availableForDisplay(long productId, boolean hot) { return real.availableForDisplay(productId, hot); }
         @Override public int available(long productId) { return real.available(productId); }
         @Override public Map<Long, Integer> available(Collection<Long> productIds) { return real.available(productIds); }
+        @Override public List<com.example.shop.inventory.StockVersion> stockSnapshot(long afterProductId, int limit) { return real.stockSnapshot(afterProductId, limit); }
         @Override public List<ReservationRef> activeReservations(long afterId, Instant createdBefore, int limit) { return real.activeReservations(afterId, createdBefore, limit); }
         @Override public Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds) { return real.reservationsOf(orderIds); }
         @Override public void releaseAbandoned(long orderId) { real.releaseAbandoned(orderId); }
…
         jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, 'Saga 測試', 100.00, 'ON_SALE')", PRODUCT, SELLER);
         jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, 'Saga 測試（熱點）', 100.00, 'ON_SALE', TRUE)", HOT, SELLER);
         for (long p : List.of(PRODUCT, HOT)) {
-            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 5, 0)", p);
+            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 5, 0, ?)", p, p == HOT);   // 13 站 5.7：熱點旗標在庫存
             jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 5, 0, 'INITIAL', 'saga-test')", p);
         }
     }
```

**`src/test/java/com/example/shop/ordering/internal/ShipCheckOutsideTxTest.java`**（5.7.8、InventoryApi 多兩個方法）

```diff
         @Override public void gateHot(List<ReserveLine> hotLines) { real.gateHot(hotLines); }
         @Override public void returnHot(List<ReserveLine> hotLines) { real.returnHot(hotLines); }
         @Override public void setHot(long productId, boolean hot) { real.setHot(productId, hot); }
+        @Override public java.util.Set<Long> hotProducts() { return real.hotProducts(); }
         @Override public int availableForDisplay(long productId, boolean hot) { return real.availableForDisplay(productId, hot); }
         @Override public int available(long productId) { return real.available(productId); }
         @Override public Map<Long, Integer> available(Collection<Long> productIds) { return real.available(productIds); }
+        @Override public List<com.example.shop.inventory.StockVersion> stockSnapshot(long afterProductId, int limit) { return real.stockSnapshot(afterProductId, limit); }
         @Override public List<ReservationRef> activeReservations(long afterId, Instant createdBefore, int limit) { return real.activeReservations(afterId, createdBefore, limit); }
         @Override public Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds) { return real.reservationsOf(orderIds); }
         @Override public void releaseAbandoned(long orderId) { real.releaseAbandoned(orderId); }
…
         jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '出貨測試', 100.00, 'ON_SALE')", PRODUCT, SELLER);
         jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '出貨測試（熱點）', 100.00, 'ON_SALE', TRUE)", HOT, SELLER);
         for (long p : List.of(PRODUCT, HOT)) {
-            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 5, 0)", p);
+            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 5, 0, ?)", p, p == HOT);   // 13 站 5.7：熱點旗標在庫存
             jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 5, 0, 'INITIAL', 'ship-check-test')", p);
         }
     }
```

`src/test/resources/openapi/shop-api.json` 是 `OpenApiContractTest` 產生的快照：只有新增一支路由（`POST /api/admin/hot-flags/copy-to-inventory`），沒有任何一行被改或刪。重建副本的那一支（`POST /api/admin/stock-levels/rebuild`）不在快照裡：快照是用單體產生的（`shop.deployment.role` 預設 `monolith`），那一支只在切開的訂單服務裡。

**測試與實驗的資料：熱點旗標在庫存（5.7.8）**。下面每一個檔案都只改了一行（把熱點標在庫存列上；`CapstoneAcceptanceTest` 有兩處）：

`src/test/java/com/example/shop/acceptance/CapstoneAcceptanceTest.java`

```diff
                 product(jdbc, normal, 50);
                 product(jdbc, hot, 50);
                 jdbc.update("UPDATE products SET hot = TRUE WHERE id = ?", hot);
+                jdbc.update("UPDATE inventory SET hot = TRUE WHERE product_id = ?", hot);   // 13 站 5.7：熱點旗標在庫存
                 System.out.println("Q8：Redis 正常       → " + degradationColumn(port, normal, hot, buyer, 0));
 
                 com.example.shop.support.TestInfra.docker("stop", com.example.shop.support.TestInfra.redisContainer());   // 8.2.1：第一版寫死 shop-redis-1（compose 的那一台）
…
     static void hotProduct(JdbcTemplate jdbc, long id, int stock) {
         product(jdbc, id, stock);
         jdbc.update("UPDATE products SET hot = TRUE WHERE id = ?", id);
+        jdbc.update("UPDATE inventory SET hot = TRUE WHERE product_id = ?", id);   // 13 站 5.7：熱點旗標在庫存
     }
 
     static Map<String, Object> settlement(JdbcTemplate jdbc, long orderId, long product) {
```

`src/test/java/com/example/shop/ordering/internal/HotSettlementTest.java`

```diff
         cleanup();
         InlineEvents.skipBacklog(ctx);
         jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '落帳測試', 100.00, 'ON_SALE', TRUE)", HOT, SELLER);
-        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 5, 0)", HOT);
+        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 5, 0, TRUE)", HOT);   // 13 站 5.7：熱點旗標在庫存
         jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 5, 0, 'INITIAL', 'settle-test')", HOT);
     }
 
```

`src/test/java/com/example/shop/ordering/internal/HotStockFlowTest.java`

```diff
     void setUp() {
         cleanup();
         jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '熱點測試', 100.00, 'ON_SALE', TRUE)", HOT, SELLER);
-        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 3, 0)", HOT);
+        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 3, 0, TRUE)", HOT);   // 13 站 5.7：熱點旗標在庫存
         jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 3, 0, 'INITIAL', 'hot-test')", HOT);
     }
 
```

`src/test/java/com/example/shop/ordering/internal/EventFlowTest.java`

```diff
         gateway.reset();
         jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '事件一般', 100.00, 'ON_SALE', FALSE), (?, ?, 11, '事件熱點', 100.00, 'ON_SALE', TRUE)",
                 NORMAL, SELLER, HOT, SELLER);
-        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0), (?, 5, 0)", NORMAL, HOT);
+        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 10, 0, FALSE), (?, 5, 0, TRUE)", NORMAL, HOT);   // 13 站 5.7
         jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'ev'), (?, 5, 0, 'INITIAL', 'ev')", NORMAL, HOT);
     }
 
```

`src/test/java/com/example/shop/inventory/internal/H1LostSettlementTest.java`

```diff
     void setUpProduct(long id) {
         cleanup(id);
         jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, 'H1', 100.00, 'ON_SALE', TRUE)", id, SELLER);
-        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", id, STOCK);
+        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, ?, 0, TRUE)", id, STOCK);   // 13 站 5.7：熱點旗標在庫存
         jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, 0, 'INITIAL', 'h1')", id, STOCK);
     }
 
```

`src/test/java/com/example/shop/ordering/internal/G4HotGateLeakTest.java`

```diff
         jdbc.update("DELETE FROM inventory WHERE product_id = ?", HOT);
         jdbc.update("DELETE FROM products WHERE id = ?", HOT);
         jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '熱點商品', 100.00, 'ON_SALE', TRUE)", HOT, SELLER);
-        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100, 0)", HOT);
+        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 100, 0, TRUE)", HOT);   // 13 站 5.7：熱點旗標在庫存
         jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 100, 0, 'INITIAL', 'g4')", HOT);
         TestRedis.forgetProducts(redis, HOT);
         redis.opsForValue().set("stock:" + HOT, "100");
```

`src/test/java/com/example/shop/ordering/internal/G7BulkheadTest.java`

```diff
             jdbc.update("DELETE FROM products WHERE id = ?", id);
         }
         jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '限量商品', 1990.00, 'ON_SALE', TRUE)", HOT);
-        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 500, 0)", HOT);
+        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 500, 0, TRUE)", HOT);   // 13 站 5.7：熱點旗標在庫存
         jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 500, 0, 'INITIAL', 'g7')", HOT);
         for (long id = FIRST_NORMAL; id < FIRST_NORMAL + NORMALS; id++) {
             jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '一般商品', 100.00, 'ON_SALE')", id);
```

`src/test/java/com/example/shop/ordering/internal/RandomOrderWorkload.java`

```diff
             long id = FIRST_PRODUCT + i;
             jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, ?, 100.00, 'ON_SALE', ?)",
                     id, SELLER, "對帳工作負載 " + i, i == PRODUCTS - 1);
-            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 150, 0)", id);
+            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 150, 0, ?)", id, i == PRODUCTS - 1);   // 13 站 5.7
             jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 150, 0, 'INITIAL', 'workload')", id);
         }
         Random r = new Random(seed);
```

`src/test/java/com/example/shop/ordering/internal/OrderEventMessages.java`

```diff
     long product(boolean hot, int stock) {
         long id = IDS.incrementAndGet();
         jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '契約測試', 100.00, 'ON_SALE', ?)", id, SELLER, hot);
-        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", id, stock);
+        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, ?, 0, ?)", id, stock, hot);   // 13 站 5.7：熱點旗標在庫存
         jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, 0, 'INITIAL', 'pact-provider')", id, stock);
         return id;
     }
```

`src/test/java/com/example/shop/ch04/E7FlashSaleLoadTest.java`

```diff
             var hikari = (com.zaxxer.hikari.HikariDataSource) ctx.getBean(javax.sql.DataSource.class);
             cleanup(jdbc);
             jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '限量商品', 1990.00, 'ON_SALE', ?)", HOT, hot);
-            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", HOT, STOCK);
+            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, ?, 0, ?)", HOT, STOCK, hot);   // 13 站 5.7：熱點旗標在庫存
             jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, 0, 'INITIAL', 'e7')", HOT, STOCK);
 
             HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(CLIENTS)).build();
```

`src/test/java/com/example/shop/ch06/G8RedisOutageDrillTest.java`

```diff
             cleanup(jdbc, redis);
             jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '演練熱點', 100.00, 'ON_SALE', TRUE)", HOT);
             jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '演練一般', 100.00, 'ON_SALE')", NORMAL);
-            for (long id : new long[]{HOT, NORMAL}) jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", id);
+            for (long id : new long[]{HOT, NORMAL}) jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 100000, 0, ?)", id, id == HOT);   // 13 站 5.7：熱點旗標在庫存
             List<Long> products = jdbc.queryForList("SELECT id FROM products WHERE status = 'ON_SALE' AND NOT hot ORDER BY id LIMIT 100", Long.class);
             HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(64)).build();
             String base = "http://localhost:" + port;
```

`src/test/java/com/example/shop/ch07/H6RabbitOutageDrillTest.java`

```diff
             jdbc.update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");   // 別的測試留下的（7.12.1）
             jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '演練熱點', 100.00, 'ON_SALE', TRUE)", HOT);
             jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '演練一般', 100.00, 'ON_SALE')", NORMAL);
-            for (long id : new long[]{HOT, NORMAL}) jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", id);
+            for (long id : new long[]{HOT, NORMAL}) jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 100000, 0, ?)", id, id == HOT);   // 13 站 5.7：熱點旗標在庫存
             org.springframework.amqp.core.Queue q = new org.springframework.amqp.core.Queue(COUNT_Q, true, false, false);
             admin.declareQueue(q);
             admin.declareBinding(BindingBuilder.bind(q).to(new TopicExchange("shop.events", true, false)).with("order.placed"));
```

`src/test/java/com/example/shop/ch07/H8FlushDuringSaleTest.java`

```diff
             cleanup(jdbc, redis);
             jdbc.update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");   // 別的測試留下的（7.12.1）
             jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, 'H8', 100.00, 'ON_SALE', TRUE)", HOT);
-            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", HOT, STOCK);
+            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, ?, 0, TRUE)", HOT, STOCK);   // 13 站 5.7：熱點旗標在庫存
             jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, 0, 'INITIAL', 'h8')", HOT, STOCK);
 
             ExecutorService pool = Executors.newFixedThreadPool(200);
```

`src/test/java/com/example/shop/loadtest/ExternalDrill.java`

```diff
             cleanup(c);
             ExternalLoad.exec(c, "INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '演練熱點', 100.00, 'ON_SALE', TRUE)", HOT);
             ExternalLoad.exec(c, "INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '演練一般', 100.00, 'ON_SALE')", NORMAL);
-            for (long id : new long[]{HOT, NORMAL}) ExternalLoad.exec(c, "INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", id);
+            for (long id : new long[]{HOT, NORMAL}) ExternalLoad.exec(c, "INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 100000, 0, ?)", id, id == HOT);   // 13 站 5.7：熱點旗標在庫存
             ExternalLoad.exec(c, "UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");   // 別人留下的（7.12.1）
             List<Long> products = new ArrayList<>();
             try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery("SELECT id FROM products WHERE status = 'ON_SALE' AND NOT hot ORDER BY id LIMIT 100")) {
```

`src/test/java/com/example/shop/loadtest/ExternalLoad.java`

```diff
             for (int round = 0; round < rounds; round++) {
                 cleanup(c, redis);
                 exec(c, "INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '限量商品', 1990.00, 'ON_SALE', ?)", HOT, hot);
-                exec(c, "INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", HOT, STOCK);
+                exec(c, "INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, ?, 0, ?)", HOT, STOCK, hot);   // 13 站 5.7：熱點旗標在庫存
                 exec(c, "INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, 0, 'INITIAL', 'e7')", HOT, STOCK);
                 long[] lw0 = lockWaits(root);
 
```


---

## 5.12 常見誤區

- **「拆開之後，每一頁都要問好幾個服務，延遲會相乘。」** 這個系統的頁面只組合兩個來源，延遲是相加（5.2.3）。真正相乘的是**可用性**：一頁依賴兩個服務，任何一個停掉，整頁就打不開。
- **「讀模型就是快取。」** 快取是「問過的答案留一陣子」，到期了再問；讀模型是「對方改了就告訴我」，從來不問。快取在對方停掉時，到期就沒了；讀模型停在停掉那一刻。單體的 5 秒快取比副本晚了五、六十倍（5.5：4,949 ms 對 80～87 ms）。
- **「讀模型會晚，所以不能用。」** 先問「讀到的東西拿來做什麼」。顯示可以晚（AC-4 寫了 5 秒）；決定要不要做一件補償不回來的事、讀自己剛寫的，不能晚（5.3）。同一個數字，不同的讀法要不同的來源。
- **「事件照順序到，收到就寫。」** 重試會讓後發的先到。每一筆帶著版本，比較新才寫（5.4.3）。
- **「重建就是清空再重灌。」** 清空的那一刻起，每一個商品都是 0 件。直接覆蓋，比版本（5.6.2）。
- **「版本比較新才寫，用 `>`。」** 那樣修不好「版本一樣、值卻錯了」的那幾列（5.6.3，F3：100 列）。
- **「消費者只放在需要它的那個服務裡。」** 這個專案的 relay 只送「自己的行程裡有人訂閱」的事件（第 12 站 9.2.1）。消費者只放在訂單服務，庫存服務的事件就一則都送不出來（5.4.4）。
- **「熱點名單要即時。」** 晚一秒的兩個方向都安全（5.7.5）；要即時就得每一張訂單問一次，兩千個搶的人都打一次 MySQL —— 第 12 站 6.5 要避免的正是那個。
- **「報表給一個唯讀帳號直連就好。」** 表的形狀從此變成契約：訂單服務加一個狀態，報表就多算（第 04 章 4.5.6）。報表跟著它讀的資料走（5.8）。

---

## 5.13 本章小結

- 第 04 章之後，跨服務的讀只剩一種痛：**等的那一頁自己倒**。庫存服務停掉，三個頁面全部 503，只因為一個欄位（5.2）。
- 讀分兩種：**可以晚的**（顯示、提醒）放進讀模型；**不能晚的**（出貨之前、補貨之後、對帳）照舊問（5.3）。
- 讀模型放在讀它的那一邊，可售量的唯一寫入者還是庫存服務：它在同一個交易裡發 `inventory.stock-changed`，帶著版本；副本比版本才寫（5.4）。
- 副本晚一百毫秒上下（每秒 100 張時長尾到幾百毫秒），遠比單體那 5 秒的快取新；最後一件被買走之後，另一位買家多看到一下「還有 1 件」，下單照樣被擋（5.5）。
- 副本要能重建：從快照、用同一句 upsert、不清空；`>=` 才修得好「版本一樣、值錯了」（5.6）。第一次上線，它是空的。
- 熱點旗標搬回庫存：庫存這一刀，交易內呼叫 0。下單時的熱點名單每秒讀一次，晚一秒的兩個方向都安全（5.7）。
- 報表跟著訂單；這一刀不切斷它（5.8）。

### 5.13.1 驗收清單

- [ ] 從 `d04` 開出 `d05`，在第一個 commit 上跑 F1：庫存服務停掉，三頁 503；「我的訂單」不受影響（5.2）。
- [ ] **不看課文**，說出 5.3 那張表裡「不能晚」的三種讀，各自為什麼不能晚。
- [ ] 說出 `stockChanged()` 為什麼在同一個交易裡讀「剛寫的那幾列」、讀到的值為什麼就是 commit 那一刻的值（5.4.2）。
- [ ] 把 `StockReplica` 標成只在訂單服務裡，跑 F2，看延遲一欄變成 `NaN`；說出為什麼（5.4.4）。
- [ ] 跑 F2，說出單體的商品頁為什麼晚了將近 5 秒、副本為什麼只晚一百毫秒上下（5.5）。
- [ ] 跑 F3；把守門的比較改成 `>` 再跑一次，說出剩下的那 100 列是哪一種（5.6.3）。
- [ ] 跑 `HotListStaleTest`，說出兩個方向各自的 Redis 與 MySQL 是什麼樣子、為什麼都安全（5.7.5）。
- [ ] 說出標熱點為什麼先改庫存、再改 `products.hot`，以及 `products.hot` 什麼時候可以拿掉（5.7.6）。
- [ ] 說出「報表直連別人的資料庫」綁住的是什麼（5.8）。
- [ ] `mvn clean verify` 全綠（5.11）。

---

## 5.14 下一章預告

讀不問了，寫還要問。這一章之後，訂單服務打庫存服務的 14 次裡，10 次是寫：預留、閘門、補貨、標熱點 —— 加上出貨之前那一問。其中**預留在下單的路徑上**：庫存服務停掉，下單就停掉；庫存服務慢 3 秒，下單就慢 3 秒（第 04 章 4.10.7 的 K3：資料庫連線不再被佔住，但慢的那 20 秒裡同時最多有 61 張下單在等，每一張佔著一條 Tomcat 的執行緒、一條 HTTP 連線）。

第 06 章處理**服務網的韌性**：

- **逾時預算**：使用者願意等多久，往下每一層各分多少；第 03 章「沒有回應就再送一次」的最壞情況是兩個 read timeout（6 秒）。
- **重試風暴**：每一層都重試，最底下收到的是乘起來的流量。
- **隔艙與熔斷**：庫存服務慢的時候，讓等它的請求有上限，不要拖垮整個訂單服務（[05-service/06](../05-service/06-async-and-external-api-calls.md) 的熔斷，放到服務之間）。
- **下單能不能不等庫存**：預留改成非同步，代價是什麼 —— 回到第 04 章 4.4 的那張表，樞紐要不要搬。
