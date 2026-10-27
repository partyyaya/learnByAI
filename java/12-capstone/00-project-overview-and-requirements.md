# 第 00 章：專題總覽、需求與範圍

> 前面十一站，每一站都給你一個乾淨的小場景：一張 `orders` 表、一個 `stock` 欄位、一則 `OrderPlaced` 訊息。
> 這一站不一樣 —— **沒有人會先把場景切好給你。** 你拿到的第一份東西會是一句話：
>
> 「做一個小型電商的訂單系統。」
>
> 這一章要把那一句話，變成**一份你可以拿來寫測試的需求**。
> 這一章結束時，你手上會有：
>
> - 一份**寫得出驗收條件**的使用者故事清單（0.4），每一條都有編號，後面九章的每一段程式碼都會對回某一條。
> - 一張**定案的訂單狀態機**（0.5）—— 不是「大概是這樣」，而是「這 6 個狀態 × 9 個事件，每一格你都知道答案」。
> - 一份**帶數字的非功能需求**（0.6）—— 而且那些數字不是抄來的，是 0.11 在你自己的機器上量出來的。
> - 一張**「刻意不做」清單**（0.7）—— 這張表跟需求一樣重要。
> - 一套 `docker compose up` 就起來的環境（MySQL + Redis + RabbitMQ），以及一個**會走路的骨架**（walking skeleton）專案（0.10）。
> - 一個 **11 題全部 `@Disabled` 的驗收測試類別**（0.12）—— 專題的「完成」定義就是它全部變綠。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 用 0.2.1 的模擬說明**扣庫存時機的三種選擇**，並說出每一種的代價（退款 33 筆 / 佔住 30 件 / 還剩 2 件）。
- 說明**為什麼三個 `boolean` 會產生 8 種組合**、其中只有幾種合法，並用 0.2.2 的數字說出狀態機多擋下了什麼（0.2.2）。
- 把一個模糊的功能描述，拆成**帶編號、帶 Given / When / Then 的驗收條件**，而且每一條都能直接改寫成測試（0.4）。
- 畫出本專題的**訂單狀態機**，並回答任何一個「狀態 × 事件」組合會發生什麼事（0.5）。
- 用**餐巾紙估算**（back-of-the-envelope）從「日活 5 萬」推到「尖峰每秒幾筆下單」，並說出哪一個數字最危險（0.6.1）。
- 寫出一張**依賴故障矩陣**：MySQL / Redis / RabbitMQ 各自掛掉時，每一支 API 應該怎樣（0.6.3）。
- 說出**哪些資料必須強一致、哪些可以最終一致**，以及「最終」是幾秒（0.6.4）。
- 列出本專題**刻意不做**的十三件事，以及每一件為什麼不做（0.7）。
- 說明本專題的技術選型（Java 21 / Boot 3.2 / MySQL 8.0 / Redis 7.2 / RabbitMQ 3.13），以及**為什麼主線選 RabbitMQ 而不是 Kafka**（0.9）。
- 用 `docker compose up -d --wait` 起環境，並說明 `compose.yaml` 裡**每一個參數**的用意（0.10.1）。
- 重現「Redis 停掉 → `/actuator/health` 503」，並用 **liveness / readiness 分組**修好它（0.10.5～0.10.6）。
- 在自己的機器上量出**熱點商品的扣庫存天花板**，並把它回填到非功能需求（0.11）。
- 建好本專題的**驗收測試骨架**，並說出每一題由哪一章負責（0.12）。

---

## 0.2 先看見痛：程式碼沒有 bug，需求有

### 0.2.0 為什麼專題從「需求」開始

大部分人做期末專題的順序是這樣的：

```
開 Spring Initializr → 建 Entity → 建 Repository → 建 Controller → 「好，功能差不多了」
  → 寫到一半發現庫存扣的時機不對 → 改 → 發現取消訂單要退款 → 改 → 發現 status 欄位不夠用 → 改 schema
  → 改到第三次，放棄測試
```

這個順序的問題不是「慢」，而是**每一次改都是在改「已經寫好、看起來正確」的程式碼**。
你沒辦法說它錯 —— 它確實做到了你當時以為的需求。

前面十一站，每一章的第一節都是「先看見痛」：先讓東西壞掉，再學怎麼修。
這一站也一樣，只是這次壞掉的**不是某個框架的某個設定**，而是**你對需求的理解**。

> 📌 本節兩個實驗都是**純 Java 的離散事件模擬**，不需要任何環境，`mvn test -Dtest='A1*,A2*'` 直接跑。
> （等你在 0.11 加了 `A3HotRowCeilingTest`，不指定 `-Dtest` 的 `mvn test` 就需要 MySQL 與 Redis 先起來 —— A3 兩邊都量。）
> 程式碼放在 `src/test/java/com/example/shop/ch00/`，專案骨架在 0.10 才建 ——
> 如果你想現在就跑，先跳去 0.10.3 把 `pom.xml` 抄好再回來。
>
> 模擬用固定的亂數種子（`new Random(42)`、`new Random(7)`），**你跑出來的數字會跟課文一模一樣**。

### 0.2.1 事故一：「下單後扣庫存」的三種讀法 ★★★

需求文件上寫著一句話：

> 「使用者下單後扣庫存。」

這句話看起來沒有任何問題。三個工程師讀完，各自寫出了一個版本：

| 讀法 | 工程師的理解 | 聽起來的理由 |
|---|---|---|
| **A 付款成功才扣** | 「下單」只是意向，錢進來了才算數 | 不付錢的人不該佔庫存 |
| **B 下單就扣，永不歸還** | 下單那一刻就扣，訂單成立就是成立 | 使用者按下「送出」就該保證有貨 |
| **C 下單就扣，15 分鐘未付款歸還** | 下單時「預留」，付款時「確認」，逾時「釋放」 | —— |

三個版本的程式碼都不長，也都**正確實作了那一句話**。現在讓它們面對同一場限量活動：

- 限量 **100 件**。
- 60 分鐘內 **400 人**下單（到達時間均勻分布）。
- **35%** 的人下了單之後不付款（比價、忘了、信用卡被拒、只是想佔位子）。
- 會付款的人在下單後 **1～10 分鐘**內付款。
- 畫面上庫存歸零時，後面的人會看到「已售完」，下不了單。

```java
package com.example.shop.ch00;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.PriorityQueue;
import java.util.Random;

/**
 * 0.2.1 同一句需求「下單後扣庫存」，三種讀法，三種結局。
 * 純 Java 離散事件模擬，不需要任何環境。
 */
class A1WhenToDeductTest {

    enum Strategy { DEDUCT_ON_PAY, DEDUCT_ON_ORDER, DEDUCT_ON_ORDER_WITH_TIMEOUT }

    static final int STOCK = 100;                // 限量 100 件
    static final int BUYERS = 400;               // 60 分鐘內湧入 400 人
    static final int WINDOW_MIN = 60;
    static final double ABANDON_RATE = 0.35;     // 35% 下了單不付款（比價、忘了、信用卡被拒）
    static final int PAY_TIMEOUT_MIN = 15;       // 策略三：15 分鐘未付款自動取消

    record Buyer(int id, int arriveAt, boolean willPay, int payDelay) {}

    // 事件：時間、種類、買家
    record Event(int at, int seq, String type, Buyer buyer) {}

    static List<Buyer> buyers(long seed) {
        Random r = new Random(seed);
        List<Buyer> list = new ArrayList<>();
        for (int i = 0; i < BUYERS; i++) {
            list.add(new Buyer(i, r.nextInt(WINDOW_MIN), r.nextDouble() >= ABANDON_RATE, 1 + r.nextInt(10)));
        }
        return list;
    }

    static final class Result {
        int placed, rejectedAtOrder, rejectedPayers, paidAndShipped, paidButNoStock, lockedByUnpaid, stockLeft;
    }

    static Result run(Strategy s, List<Buyer> buyers) {
        PriorityQueue<Event> q = new PriorityQueue<>((a, b) ->
                a.at != b.at ? Integer.compare(a.at, b.at) : Integer.compare(a.seq, b.seq));
        int seq = 0;
        for (Buyer b : buyers) q.add(new Event(b.arriveAt, seq++, "ORDER", b));

        Result res = new Result();
        int stock = STOCK;
        boolean[] holding = new boolean[BUYERS];   // 這張訂單是否正佔著一件庫存
        boolean[] open = new boolean[BUYERS];      // 訂單是否仍是「待付款」

        while (!q.isEmpty()) {
            Event e = q.poll();
            Buyer b = e.buyer;
            switch (e.type) {
                case "ORDER" -> {
                    if (stock <= 0) {                           // 畫面上顯示「已售完」
                        res.rejectedAtOrder++;
                        if (b.willPay) res.rejectedPayers++;
                        continue;
                    }
                    res.placed++;
                    open[b.id] = true;
                    if (s != Strategy.DEDUCT_ON_PAY) { stock--; holding[b.id] = true; }
                    if (b.willPay) q.add(new Event(e.at + b.payDelay, seq++, "PAY", b));
                    if (s == Strategy.DEDUCT_ON_ORDER_WITH_TIMEOUT)
                        q.add(new Event(e.at + PAY_TIMEOUT_MIN, seq++, "TIMEOUT", b));
                }
                case "PAY" -> {
                    if (!open[b.id]) continue;                  // 已被逾時取消（本模擬中付款都在 10 分鐘內，不會發生）
                    open[b.id] = false;
                    if (s == Strategy.DEDUCT_ON_PAY) {
                        if (stock > 0) { stock--; res.paidAndShipped++; }
                        else res.paidButNoStock++;              // 錢收了，貨沒了
                    } else {
                        holding[b.id] = false;
                        res.paidAndShipped++;
                    }
                }
                case "TIMEOUT" -> {
                    if (open[b.id]) {                            // 還沒付款 → 取消並歸還庫存
                        open[b.id] = false;
                        holding[b.id] = false;
                        stock++;
                    }
                }
            }
        }
        for (boolean h : holding) if (h) res.lockedByUnpaid++;
        res.stockLeft = stock;
        return res;
    }

    @Test
    void threeReadingsOfOneSentence() {
        List<Buyer> buyers = buyers(42);
        long payers = buyers.stream().filter(Buyer::willPay).count();
        System.out.println("═══ 0.2.1 「下單後扣庫存」的三種讀法 ═══");
        System.out.printf("  限量 %d 件；60 分鐘內 %d 人下單，其中 %d 人真的會付款（%.0f%% 下單後放棄）%n%n",
                STOCK, BUYERS, payers, ABANDON_RATE * 100);
        for (Strategy s : Strategy.values()) {
            Result r = run(s, buyers);
            String name = switch (s) {
                case DEDUCT_ON_PAY -> "A 付款成功才扣";
                case DEDUCT_ON_ORDER -> "B 下單就扣，永不歸還";
                case DEDUCT_ON_ORDER_WITH_TIMEOUT -> "C 下單就扣，15 分鐘未付款歸還";
            };
            System.out.printf("  %s%n", name);
            System.out.printf("    成交（付了錢、有出貨）     : %3d%n", r.paidAndShipped);
            System.out.printf("    付了錢才發現沒貨（要退款） : %3d%n", r.paidButNoStock);
            System.out.printf("    想付錢卻被擋在門外         : %3d%n", r.rejectedPayers);
            System.out.printf("    被未付款訂單永久佔住       : %3d%n", r.lockedByUnpaid);
            System.out.printf("    活動結束還剩在架上         : %3d%n%n", r.stockLeft);
        }
    }
}
```

**輸出**：

```
═══ 0.2.1 「下單後扣庫存」的三種讀法 ═══
  限量 100 件；60 分鐘內 400 人下單，其中 269 人真的會付款（35% 下單後放棄）

  A 付款成功才扣
    成交（付了錢、有出貨）     : 100
    付了錢才發現沒貨（要退款） :  33
    想付錢卻被擋在門外         : 136
    被未付款訂單永久佔住       :   0
    活動結束還剩在架上         :   0

  B 下單就扣，永不歸還
    成交（付了錢、有出貨）     :  70
    付了錢才發現沒貨（要退款） :   0
    想付錢卻被擋在門外         : 199
    被未付款訂單永久佔住       :  30
    活動結束還剩在架上         :   0

  C 下單就扣，15 分鐘未付款歸還
    成交（付了錢、有出貨）     :  98
    付了錢才發現沒貨（要退款） :   0
    想付錢卻被擋在門外         : 171
    被未付款訂單永久佔住       :   0
    活動結束還剩在架上         :   2
```

**停下來，一個讀法一個讀法看**：

**讀法 A：賣光了，但收了 133 個人的錢。**

A 看起來最漂亮：100 件全部賣掉，沒有一件被佔住。但問題在第二行 ——
**33 個人付款成功之後，才被告知沒貨。**

為什麼？因為下單時只「看」庫存、不「扣」庫存。庫存 = 1 的那一刻，可能有 20 個人同時看到「還有貨」、同時下單，
這 20 個人都會走到付款頁、都會輸入信用卡、都會付款成功 —— 然後只有第一個人扣得到。

在真實世界，這 33 筆代表：

- 33 筆**退款**（金流手續費通常不退，你要自己吞）。
- 33 通**客服電話**（「我已經付錢了，你說沒貨？」）。
- 如果是信用卡分期、或是跨境支付，退款可能要 **7～14 個工作天**才會回到使用者手上。

> 📌 讀法 A 在**非限量**的情況下是合理的 —— 大部分電商的一般商品庫存很多，「付款才扣」可以避免被佔位子。
> 它的問題只在「庫存 < 需求」的時候才會出現。**而那正好是你最需要它正確的時候。**

**讀法 B：倉庫裡有 30 件貨，但網站上寫「已售完」。**

B 的成交只有 70 件，但它沒有任何一筆退款 —— 看起來「很安全」。
問題在第四行：**30 件被「下了單、永遠不會付款」的人佔住了。**

這 30 件在資料庫裡是「已扣除」，在倉庫裡是「還在架上」，在網站上是「已售完」。
而且注意第三行：**有 199 個會付款的人被擋在門外**（比 A 的 136 多了 63 個）。

B 的問題不會在活動當下被發現。它會在**月底盤點**時被發現：
「系統庫存 0、實體庫存 30、差異 30 件，原因不明。」

**讀法 C：98 件成交，0 筆退款，架上剩 2 件。**

C 是三個裡面唯一「對」的。它把一件事拆成了**三個動作**：

```
下單 ──▶ 預留（reserve）   可售庫存 -1，但貨還沒真的被買走
付款 ──▶ 確認（confirm）   預留變成實際扣除
逾時 ──▶ 釋放（release）   預留歸還給可售庫存
```

剩下的 2 件是在活動最後 15 分鐘內被釋放出來、但已經沒有人來買的。這是 C 的**唯一代價**，而且可以調：
逾時從 15 分鐘縮短到 5 分鐘，剩下的數量會變少、但付款比較慢的人會被取消。

**這一節要帶走的不是「C 是對的」，而是這三件事**：

1. **三個版本的程式碼都「照需求」實作了。** 沒有一個工程師犯錯。錯的是那一句需求 —— 它沒有定義「扣」是什麼意思。
2. **三種讀法的差別在單元測試裡看不出來。** 你給任何一個版本寫「下單後庫存 -1」的測試，它都會通過（A 要改成「付款後」，但那也是照規格）。
   **差別只有在「庫存 < 需求」＋「有人不付錢」＋「時間在流動」的時候才會出現** —— 這三個條件，單元測試一個都沒有。
3. **所以需求要寫到「可以被模擬」的程度。** 不是寫「下單後扣庫存」，而是寫：

> **US-ORD-1 驗收條件 AC-3**：下單成功時，對每一個品項**預留**庫存（可售庫存減少、實體庫存不變）。
> **US-ORD-3 驗收條件 AC-1**：訂單建立後 **15 分鐘**內未付款，系統自動取消，並**釋放**該訂單的所有預留。
> **US-ORD-2 驗收條件 AC-2**：付款成功時，預留轉為**確認扣除**。

0.4.5 會把這三條（以及它們的邊界條件）完整寫出來。

> ⚠️ **還有一個 C 沒有處理的情況**：如果付款通知**在第 16 分鐘才到** —— 使用者其實在第 14 分鐘付了款，但金流的通知晚了兩分鐘 ——
> 這時候訂單已經被逾時取消、庫存已經被釋放、可能已經被別人買走了。
> **錢收了，訂單卻是取消的。**
> 本模擬的付款延遲設在 1～10 分鐘，所以沒有觸發這個情況。下一節會讓它發生。

### 0.2.2 事故二：「可以取消訂單」與三個 `boolean` ★★★

需求文件上的第二句話：

> 「使用者可以取消訂單。已出貨的訂單不可取消。」

很多人的第一版訂單長這樣：

```java
@Entity
public class Order {
    private boolean paid;
    private boolean shipped;
    private boolean cancelled;
    // ...
}
```

然後每個方法加上「看起來合理」的檢查：

```java
void pay()    { paid = true; }                       // 金流說付了，就記下來
void cancel() { if (!shipped) cancelled = true; }    // 需求說：已出貨就不能取消 ✓
void ship()   { if (paid) shipped = true; }          // 有付錢才出貨 ✓
```

每一個方法單獨看都沒有問題，而且**需求裡寫的那一條（已出貨不可取消）確實被實作了**。

現在讓它面對真實世界的事件流。真實世界裡，一張訂單的事件**不是由一個人依序觸發的**，而是由五個互不相識的來源觸發：

| 事件來源 | 事件 | 真實世界的特性 |
|---|---|---|
| 金流 | `PAY`（付款通知） | 可能**晚到**（使用者 14:59 付款、通知 15:02 才到）、可能**重送**（金流沒收到你的 200 就會重送） |
| 使用者 | `USER_CANCEL` | 隨時可能按 |
| 排程 | `TIMEOUT` | 第 15 分鐘掃一次，未付款就取消 |
| 倉庫 | `WAREHOUSE_PICK` | 每 10 分鐘撈一批「已付款、未取消」的訂單去撿貨 |
| 倉庫 | `WAREHOUSE_SHIP` | 撿好之後 2 分鐘出貨 —— **撈單和出貨之間有時間差** |

模擬的設定（刻意放大，讓每一種情況都出現得夠多次）：

- 10,000 張訂單。70% 會付款，付款時間在 1～20 分鐘（所以有一部分會晚於 15 分鐘的逾時）。
- 付款的人裡面，10% 的通知會被金流重送一次。
- 10% 的使用者會在 1～40 分鐘內某個時間點按取消。

```java
package com.example.shop.ch00;

import org.junit.jupiter.api.Test;

import java.util.*;

/**
 * 0.2.2 「可以取消訂單」——用三個 boolean 實作 vs 用狀態機實作。
 * 同一組事件序列（含晚到、重複的付款通知，以及倉庫批次撿貨的時間差）餵給兩種模型。
 */
class A2FlagsVsStateMachineTest {

    enum Ev { PAY, USER_CANCEL, TIMEOUT, WAREHOUSE_PICK, WAREHOUSE_SHIP }

    record Event(int at, int seq, int orderId, Ev type) {}

    static final int ORDERS = 10_000;

    /** 產生事件：付款通知可能晚到或重複、使用者可能隨時取消、倉庫每 10 分鐘撿一批、2 分鐘後出貨 */
    static List<Event> events(long seed) {
        Random r = new Random(seed);
        List<Event> list = new ArrayList<>();
        int seq = 0;
        for (int id = 0; id < ORDERS; id++) {
            if (r.nextDouble() < 0.70) {                                   // 70% 會付款
                int payAt = 1 + r.nextInt(20);                               // 1～20 分鐘，超過 15 分鐘就是「晚到」
                list.add(new Event(payAt, seq++, id, Ev.PAY));
                if (r.nextDouble() < 0.10)                                   // 10% 金流重送通知
                    list.add(new Event(payAt + 1 + r.nextInt(3), seq++, id, Ev.PAY));
            }
            if (r.nextDouble() < 0.10)                                       // 10% 使用者自己按取消
                list.add(new Event(1 + r.nextInt(40), seq++, id, Ev.USER_CANCEL));
            list.add(new Event(15, seq++, id, Ev.TIMEOUT));                  // 排程：15 分鐘未付款就取消
            for (int t = 10; t <= 40; t += 10) {                             // 倉庫：每 10 分鐘撿一批
                list.add(new Event(t, seq++, id, Ev.WAREHOUSE_PICK));
                list.add(new Event(t + 2, seq++, id, Ev.WAREHOUSE_SHIP));
            }
        }
        list.sort(Comparator.comparingInt(Event::at).thenComparingInt(Event::seq));
        return list;
    }

    // ───────────── 版本一：三個 boolean，每個方法都有「看起來合理」的檢查 ─────────────
    static final class FlagOrder {
        boolean paid, cancelled, shipped, picked;
        int payCount;

        void pay()    { paid = true; payCount++; }             // 金流說付了，就記下來
        void cancel() { if (!shipped) cancelled = true; }      // 已出貨就不能取消
        void ship()   { if (paid) shipped = true; }            // 有付錢才出貨
    }

    static void runFlags(List<Event> evs) {
        FlagOrder[] os = new FlagOrder[ORDERS];
        for (int i = 0; i < ORDERS; i++) os[i] = new FlagOrder();
        for (Event e : evs) {
            FlagOrder o = os[e.orderId];
            switch (e.type) {
                case PAY -> o.pay();
                case USER_CANCEL -> o.cancel();
                case TIMEOUT -> { if (!o.paid) o.cancel(); }
                case WAREHOUSE_PICK -> { if (o.paid && !o.cancelled && !o.shipped) o.picked = true; } // 撿貨單：已付款、未取消
                case WAREHOUSE_SHIP -> { if (o.picked && !o.shipped) o.ship(); }                      // 撿好的就出
            }
        }
        Map<String, Integer> combos = new TreeMap<>();
        int paidAndCancelled = 0, shippedAndCancelled = 0, doublePay = 0;
        for (FlagOrder o : os) {
            combos.merge("paid=%-5s shipped=%-5s cancelled=%-5s".formatted(o.paid, o.shipped, o.cancelled), 1, Integer::sum);
            if (o.paid && o.cancelled && !o.shipped) paidAndCancelled++;
            if (o.shipped && o.cancelled) shippedAndCancelled++;
            if (o.payCount > 1) doublePay++;
        }
        System.out.println("  ── 版本一：三個 boolean ──");
        System.out.println("  最終組合分布（2³ = 8 種可能）：");
        combos.forEach((k, v) -> System.out.printf("    %s : %,6d%n", k, v));
        System.out.printf("%n  已取消、但錢收了（誰來退？）   : %,5d%n", paidAndCancelled);
        System.out.printf("  已取消、但貨出了               : %,5d%n", shippedAndCancelled);
        System.out.printf("  付款被記了兩次                 : %,5d%n", doublePay);
        System.out.println("  以上全部：沒有例外、沒有日誌、每一個方法都「有檢查」");
    }

    // ───────────── 版本二：狀態機，轉移表是唯一真相 ─────────────
    enum Status { PENDING_PAYMENT, PAID, PICKING, SHIPPED, CANCELLED }

    static final Map<Status, Map<Ev, Status>> TRANSITIONS = new EnumMap<>(Status.class);
    static {
        TRANSITIONS.put(Status.PENDING_PAYMENT, Map.of(Ev.PAY, Status.PAID, Ev.USER_CANCEL, Status.CANCELLED, Ev.TIMEOUT, Status.CANCELLED));
        TRANSITIONS.put(Status.PAID,            Map.of(Ev.USER_CANCEL, Status.CANCELLED, Ev.WAREHOUSE_PICK, Status.PICKING));
        TRANSITIONS.put(Status.PICKING,         Map.of(Ev.WAREHOUSE_SHIP, Status.SHIPPED));
        TRANSITIONS.put(Status.SHIPPED,         Map.of());
        TRANSITIONS.put(Status.CANCELLED,       Map.of());
    }

    static void runStateMachine(List<Event> evs) {
        Status[] os = new Status[ORDERS];
        Arrays.fill(os, Status.PENDING_PAYMENT);
        Map<String, Integer> rejected = new TreeMap<>();
        int refundAfterCancel = 0, latePayRefund = 0, duplicatePayIgnored = 0;

        for (Event e : evs) {
            Status from = os[e.orderId];
            Status to = TRANSITIONS.get(from).get(e.type);
            if (to != null) {
                if (from == Status.PAID && to == Status.CANCELLED) refundAfterCancel++;   // 轉移本身就帶著「要退款」
                os[e.orderId] = to;
                continue;
            }
            // 不在表上的轉移：不是默默忽略，而是逐一決定怎麼處理
            if (e.type == Ev.PAY && from == Status.CANCELLED) latePayRefund++;             // 取消後才到的付款 → 原路退款
            else if (e.type == Ev.PAY) duplicatePayIgnored++;                               // 重複通知 → 冪等忽略
            else if (e.type == Ev.TIMEOUT || e.type == Ev.WAREHOUSE_PICK || e.type == Ev.WAREHOUSE_SHIP) continue; // 排程掃到不相干的單，正常
            rejected.merge(from + " + " + e.type, 1, Integer::sum);
        }
        Map<Status, Integer> dist = new EnumMap<>(Status.class);
        for (Status s : os) dist.merge(s, 1, Integer::sum);

        System.out.println("\n  ── 版本二：狀態機 ──");
        System.out.println("  最終狀態分布：");
        dist.forEach((k, v) -> System.out.printf("    %-16s : %,6d%n", k, v));
        System.out.printf("%n  PAID → CANCELLED（明確觸發退款） : %,5d%n", refundAfterCancel);
        System.out.printf("  取消後才到的付款（自動原路退款）  : %,5d%n", latePayRefund);
        System.out.printf("  重複付款通知（冪等忽略）          : %,5d%n", duplicatePayIgnored);
        System.out.println("  被轉移表擋下、且有被記錄的事件：");
        rejected.forEach((k, v) -> System.out.printf("    %-34s : %,5d%n", k, v));
    }

    @Test
    void flagsVsStateMachine() {
        List<Event> evs = events(7);
        System.out.println("═══ 0.2.2 「可以取消訂單」：三個 boolean vs 狀態機 ═══");
        System.out.printf("  %,d 張訂單、%,d 個事件（同一份事件序列餵給兩個版本）%n%n", ORDERS, evs.size());
        runFlags(evs);
        runStateMachine(evs);
    }
}
```

**輸出**：

```
═══ 0.2.2 「可以取消訂單」：三個 boolean vs 狀態機 ═══
  10,000 張訂單、98,657 個事件（同一份事件序列餵給兩個版本）

  ── 版本一：三個 boolean ──
  最終組合分布（2³ = 8 種可能）：
    paid=false shipped=false cancelled=true  :  3,012
    paid=true  shipped=false cancelled=true  :  1,951
    paid=true  shipped=true  cancelled=false :  5,020
    paid=true  shipped=true  cancelled=true  :     17

  已取消、但錢收了（誰來退？）   : 1,951
  已取消、但貨出了               :    17
  付款被記了兩次                 :   703
  以上全部：沒有例外、沒有日誌、每一個方法都「有檢查」

  ── 版本二：狀態機 ──
  最終狀態分布：
    SHIPPED          :  5,037
    CANCELLED        :  4,963

  PAID → CANCELLED（明確觸發退款） :    91
  取消後才到的付款（自動原路退款）  : 2,042
  重複付款通知（冪等忽略）          :   521
  被轉移表擋下、且有被記錄的事件：
    CANCELLED + PAY                    : 2,042
    CANCELLED + USER_CANCEL            :   287
    PAID + PAY                         :   457
    PICKING + PAY                      :    57
    PICKING + USER_CANCEL              :    17
    SHIPPED + PAY                      :     7
    SHIPPED + USER_CANCEL              :   289
```

**先看版本一的三個數字，它們各自來自一個不同的漏洞**：

| 數字 | 怎麼發生的 | 哪一個「合理的檢查」沒擋住 |
|---|---|---|
| **1,951 張「已取消、但錢收了」** | **1,860 張是晚到的付款**：第 15 分鐘排程取消了訂單，第 16～20 分鐘付款通知才到，`pay()` 照樣把 `paid` 設成 `true`；**另外 91 張是「已付款的人按了取消」**（跟版本二的 `PAID → CANCELLED : 91` 是同一批） | `pay()` 沒有檢查 `cancelled`。而且就算檢查了，**「取消後才收到錢」該怎麼辦，需求裡沒寫** |
| **17 張「已取消、但貨出了」** | 倉庫在第 10 分鐘撈單（此時未取消），使用者在第 11 分鐘按取消（`shipped` 還是 `false`，所以取消成功），倉庫在第 12 分鐘照撿貨單出貨 | `cancel()` 檢查了 `shipped`、`ship()` 檢查了 `paid` —— **但兩者之間那 2 分鐘的「撿貨中」根本不是一個狀態**，沒有任何欄位能表達它 |
| **703 筆付款被記了兩次** | 金流重送通知 | `pay()` 沒有冪等。在這個模擬裡「記兩次」只是計數器，在真實世界它可能是**點數發兩次、營收算兩次、發票開兩張** |

⚠️ **注意最後一行：「沒有例外、沒有日誌」。** 版本一的每一個非法狀態都是**安靜地**發生的。
你的監控看板上，這一萬張訂單的處理成功率是 100%。

**再看為什麼三個 `boolean` 天生就有這個問題**：

三個 `boolean` 有 2³ = **8 種組合**。我們來逐一看它們合不合法：

| # | paid | shipped | cancelled | 合法嗎？ | 意思 |
|---|---|---|---|---|---|
| 1 | ✗ | ✗ | ✗ | ✅ | 待付款 |
| 2 | ✓ | ✗ | ✗ | ✅ | 已付款、待出貨 |
| 3 | ✓ | ✓ | ✗ | ✅ | 已出貨 |
| 4 | ✗ | ✗ | ✓ | ✅ | 未付款就取消 |
| 5 | ✓ | ✗ | ✓ | ⚠️ | 付了款又取消 —— **退款了沒？** 這個組合**表達不出來** |
| 6 | ✗ | ✓ | ✗ | ❌ | 沒付錢就出貨 |
| 7 | ✗ | ✓ | ✓ | ❌ | 沒付錢、出了貨、又取消 |
| 8 | ✓ | ✓ | ✓ | ❌ | 出了貨又取消 |

8 種組合裡，**只有 4 種是清楚合法的**。剩下 4 種裡有 3 種是非法、1 種是「資訊不足」。
**每多一個 `boolean`，非法組合就翻倍**：加一個 `refunded`，變成 16 種組合，合法的大概 6 種。

而且注意，**「撿貨中」這個狀態在 8 種組合裡根本不存在**。它是事故「17 張已取消但出了貨」的根因 ——
**你沒辦法在一個不存在的狀態上加檢查。**

**然後看版本二做了什麼不一樣的事**：

版本二沒有比版本一「更小心」。它做的是**換一個表達方式**：

```
不是「三個獨立的開關，每個方法自己檢查其他開關」
而是「一個欄位，只能是 5 個值之一；一張表，列出每個值能接受哪些事件」
```

這張表只有 5 行（`TRANSITIONS` 的 5 個 `put`），但它帶來了四個版本一做不到的事：

1. **非法組合在型別上就不存在。** `Status` 只能是 5 個值之一，你沒辦法讓一張訂單「既是 SHIPPED 又是 CANCELLED」。
2. **「撿貨中」變成了一個真的狀態。** `PICKING` 出現之後，「撿貨中能不能取消」就從一個**沒人想過的 bug** 變成一個**可以回答的問題**。
   注意輸出的 `PICKING + USER_CANCEL : 17` —— 跟版本一的「17 張已取消但貨出了」**是同一批訂單**。版本二擋下了它們，而且記錄了。
3. **每一個被擋下的事件都要被處理。** 版本二的 `else if` 鏈就是在做這件事：
   `CANCELLED + PAY` → 原路退款；`PAID + PAY` → 冪等忽略；排程掃到不相干的單 → 正常略過。
   **每一行都是一個需求決策，而不是一個 `if` 的副作用。**
4. **「PAID → CANCELLED」這個轉移本身就帶著「要退款」。** 版本一的第 5 種組合（付了款又取消）不知道退款了沒；
   版本二裡這個轉移只有一條路，那條路上寫著「觸發退款」。

**最重要的一點：版本二的輸出逼出了三個需求問題。**

看「被轉移表擋下」那一段，每一行都是一個**需求文件要回答的問題**：

| 被擋下的組合 | 需求要回答的問題 | 本專題的答案（0.5 定案） |
|---|---|---|
| `CANCELLED + PAY`（2,042） | 訂單取消後才收到付款，怎麼辦？ | **自動原路退款**：`payments` 照樣記 `SUCCEEDED`，再建一筆 `refunds(reason=LATE_PAYMENT)`；不重新成立訂單（庫存可能已被別人買走） |
| `PICKING + USER_CANCEL`（17） | 撿貨中能不能取消？ | **不能從 API 取消**，回 409 並提示「訂單已進入出貨流程，請於收貨後申請退貨」（退貨不在本專題範圍，見 0.7） |
| `SHIPPED + USER_CANCEL`（289） | 已出貨能不能取消？ | 不能（原需求已寫） |
| `PAID + PAY` 等（521） | 重複的付款通知？ | 以金流交易編號做冪等，重複通知回 200、不做任何事 |
| `CANCELLED + USER_CANCEL`（287） | 對已取消的訂單再按一次取消？ | **冪等成功**，回 200 與目前狀態（不回 409 —— 使用者的意圖已經達成了） |

> 📌 最後一列值得多想一下。「對已取消的訂單再取消一次」該回 200 還是 409？
> 兩個答案都說得通，但**你必須選一個、寫下來、寫成測試**。
> 如果需求沒寫，前端工程師會假設 200、後端工程師會實作 409，然後在整合測試時吵一架。

> 📌 **關於模擬的比例**：付款時間設成 1～20 分鐘、逾時 15 分鐘，代表約四分之一的付款會「晚到」。
> 這個比例是**刻意放大**的，真實世界大概是千分之一到百分之一。
> 但比例不重要 —— **重要的是版本一在比例為千分之一時也會出錯，而且一樣安靜。**
> 一天一萬張訂單、千分之一，就是每天 10 張「錢收了、單取消了、沒有人知道」的訂單。

**這一節帶走的**：

1. **需求裡的每一個名詞，都要問「它是一個狀態，還是一個狀態的屬性？」**
   「已付款」「已出貨」「已取消」**是狀態**，不是三個獨立的屬性。把它們寫成 `boolean`，就是在說它們可以任意組合。
2. **需求裡的每一句「可以 X」，都要問「在哪些狀態下可以？在其他狀態下會怎樣？」**
   「使用者可以取消訂單」要展開成一張「狀態 × 事件」的表，每一格都要有答案。0.5 就是那張表。
3. **事件的來源不只有使用者。** 金流、排程、倉庫、其他服務 —— 它們彼此不協調，而且都可能晚到、重複、亂序。
   **你的需求要假設它們會。**

### 0.2.3 另外兩個事故：它們需要真的環境

前兩個事故是「功能需求」寫得不清楚。另外兩個是「非功能需求」寫得不清楚，而它們需要一台真的 MySQL 和一台真的 Redis 才能重現：

- **0.10.5「Redis 停掉，整站 503」**：需求寫「Redis 掛了要降級」，但 Spring Boot 預設的健康檢查把 Redis 算進去了。
- **0.11「下單要快」**：同一個商品每秒最多成立幾筆訂單？**你以為是幾萬，量出來是 678** —— 而多 5 毫秒的交易，就剩 138。

先把需求寫完（0.3～0.9），再起環境（0.10）重現它們。

---

## 0.3 專題全貌

### 0.3.1 一句話定義

> **一個讓買家瀏覽商品、下單、付款，讓賣家上架商品、出貨，讓管理員看報表的電商訂單後端服務。
> 它在「限量商品被搶購」與「任一個依賴暫時掛掉」這兩種情況下，仍然不超賣、不重複扣款、不丟訂單。**

第一句是**功能**，第二句是**這個專題之所以難的地方**。
如果只有第一句，這是一個週末就能寫完的 CRUD 專案。第二句讓它變成九章。

### 0.3.2 角色

**人類角色**（有帳號、會登入）：

| 角色 | 代號 | 能做什麼 | 不能做什麼 |
|---|---|---|---|
| 買家 | `BUYER` | 瀏覽商品、管理自己的購物車、下單、付款、取消自己的訂單、確認收貨、看自己的訂單 | 看別人的訂單、看任何報表、改任何商品 |
| 賣家 | `SELLER` | 管理**自己的**商品（上架 / 下架 / 改價 / 補庫存）、看**自己商品的**訂單並出貨、看**自己的**銷售報表 | 碰別的賣家的商品或訂單、改訂單金額 |
| 管理員 | `ADMIN` | 看全站報表、停權帳號、強制下架商品、查稽核日誌 | **不能**以買家身分下單、**不能**改訂單狀態（除了 0.5 表列的例外） |

> 📌 注意「不能做什麼」那一欄。
> 「管理員什麼都能做」是最常見的權限設計錯誤 —— 它讓管理員帳號變成**最有價值的攻擊目標**，
> 而且讓「這筆訂單是誰改的」永遠說不清楚。本專題的管理員**看得多、改得少**。

**系統角色**（沒有帳號，但會觸發事件）：

| 角色 | 觸發什麼 | 特性（0.2.2 學到的） |
|---|---|---|
| 金流（模擬） | 付款成功 / 失敗通知、退款結果 | 會**晚到**、會**重送**、要**驗簽** |
| 排程 | 付款逾時取消、出貨後自動完成、Outbox 掃描、對帳 | 多台機器同時跑時**不能重複執行** |
| 倉庫（由賣家代表） | 開始撿貨、出貨 | 撿貨與出貨之間**有時間差** |
| 訊息消費者 | 扣庫存落帳、寄通知、更新排行榜 | 會**重複收到**同一則訊息、會**亂序** |

### 0.3.3 系統脈絡圖

```
                        ┌──────────────┐
      買家 ─── HTTPS ──▶│              │◀── HTTPS ─── 賣家
                        │              │
      管理員 ── HTTPS ─▶│  shop 服務   │◀── callback ── 金流（模擬）
                        │ （模組化單體）│─── 退款請求 ──▶
                        │              │
                        └──┬───┬───┬───┘
                           │   │   │
               ┌───────────┘   │   └───────────┐
               ▼               ▼               ▼
          ┌─────────┐    ┌─────────┐    ┌───────────┐
          │ MySQL   │    │ Redis   │    │ RabbitMQ  │
          │ 唯一真相 │    │ 快取、鎖 │    │ 事件流     │
          │         │    │ 限流、   │    │ 通知、落帳 │
          │         │    │ 熱點庫存 │    │ 排行      │
          └─────────┘    └─────────┘    └───────────┘
```

三個依賴的**角色定位**，是這個專題最重要的一張表，後面每一章的設計都從這裡推出來：

| 依賴 | 定位 | 它掛掉時 | 它的資料丟了時 |
|---|---|---|---|
| **MySQL** | **唯一真相**（system of record） | 所有寫入失敗；讀取可以部分走快取 | **不可接受** —— 備份與複製是它的責任（本專題範圍外，見 0.7） |
| **Redis** | **加速與協調**：快取、限流、分散式鎖、熱點預扣 | **降級**：快取改走 DB、限流放行或改本機、熱點商品暫停搶購 | **可以接受** —— 所有資料都能從 MySQL 重建 |
| **RabbitMQ** | **非同步事件流**：通知、庫存落帳、排行更新 | 訊息**堆在 Outbox 表**裡，恢復後補送；下單照常 | 可以接受（Outbox 可重放） |

⚠️ **「Redis 的資料丟了可以接受」這一句話，決定了第 06 章的整個設計。**
它代表你**不能**把「只存在 Redis 裡的東西」當成真相 —— 包括 Redis 裡的預扣庫存。
Redis 裡的庫存數字只是 MySQL 的一個**快速副本**，隨時要能從 MySQL 重新算出來。

### 0.3.4 模組與資料歸屬

本專題是一個**模組化單體**（第 01 章會講為什麼不是微服務）。
模組的切法以「**誰擁有這份資料**」為準 —— 每張表只屬於一個模組，其他模組只能透過該模組的公開介面存取：

| 模組 | 擁有的資料（表） | 對外提供什麼 | 會呼叫誰 |
|---|---|---|---|
| `account` | `users`、`user_roles`、`refresh_tokens` | 註冊、登入、目前使用者 | —— |
| `catalog` | `products`、`categories` | 商品 CRUD、搜尋、詳情 | —— |
| `inventory` | `inventory`、`inventory_reservations`、`inventory_ledger` | 預留、確認、釋放、出庫、查可售量 | —— |
| `cart` | `cart_items` | 加入、改量、移除、結帳前檢查 | `catalog`（查價）、`inventory`（查可售量） |
| `ordering` | `orders`、`order_items`、`order_status_history`、`idempotency_keys` | 下單、取消、狀態流轉、查詢 | `cart`、`catalog`、`inventory`、`payment` |
| `payment` | `payments`、`refunds` | 建立付款、處理回呼、退款 | —— |
| `notification` | `notifications` | 寄通知（模擬） | —— |
| `reporting` | （**不擁有表**，唯讀查詢其他模組的表） | 銷售統計、排行 | —— |
| `shared` | `outbox_events`、`processed_messages`、`audit_logs` | 事件發佈、冪等消費、稽核 | —— |

> 📌 **`reporting` 是唯一被允許「跨模組直接讀表」的模組**，而且只能讀、不能寫。
> 這是刻意的妥協：報表天生就要 JOIN 很多張表，逼它走每個模組的介面會慢到不能用。
> 第 01 章會用 ArchUnit 把這條規則寫成測試，08 站 [08-jpa-mybatis/09](../08-jpa-mybatis/09-choosing-and-mixing-in-practice.md) 的選型邏輯會在這裡落地：寫入走 JPA、報表走 MyBatis。

### 0.3.5 名詞表：全專題只用這一套說法

需求寫不清楚的一個主要來源是**同一個東西有三個名字**，或**三個東西共用一個名字**。
「庫存」這個詞在這個專題裡就至少有四種意思。所以先把詞定下來 —— 程式碼的類別名、欄位名、API 欄位、日誌訊息，**全部用這張表**：

| 中文 | 程式碼 | 定義 | ⚠️ 容易混淆成 |
|---|---|---|---|
| 實體庫存 | `onHand` | 倉庫裡實際有的數量。只有**出貨**與**補貨**會改變它 | 可售庫存 |
| 預留量 | `reserved` | 已被未完成訂單預留、還沒出貨的數量 | —— |
| 可售庫存 | `available` | `onHand - reserved`。**不存欄位，永遠用算的**。商品頁上顯示的是它 | 實體庫存 |
| 預留 | `Reservation` | 一張訂單對一個商品的一筆保留。狀態：`HELD`（待付款，可被逾時釋放）→ `CONFIRMED`（已付款，不可被逾時釋放）→ `CONSUMED`（已出貨）或 `RELEASED`（已取消） | 扣庫存 |
| 庫存帳 | `InventoryLedger` | 每一次 `onHand` 或 `reserved` 變化的**不可變**紀錄：誰、何時、為什麼、變多少 | 庫存異動 log（那是日誌，這是資料） |
| 訂單 | `Order` | 一次結帳的結果。**一張訂單只屬於一位買家、一位賣家** | 購物車 |
| 訂單明細 | `OrderItem` | 訂單裡的一個品項，帶**下單當下的價格快照** | —— |
| 價格快照 | `unitPrice`（在 `OrderItem` 上） | 下單那一刻的單價。**商品之後改價，訂單金額不變** | 商品目前價格 |
| 付款 | `Payment` | 對一張訂單的一次付款嘗試。一張訂單可以有多筆（失敗重試），**最多一筆成功** | 訂單狀態 |
| 金流交易編號 | `providerTxnId` | 金流那一端的唯一編號，**付款回呼的冪等鍵** | 訂單編號 |
| 冪等鍵 | `Idempotency-Key` | 客戶端在下單請求帶的 header，**下單的冪等鍵** | 金流交易編號 |
| 訂單編號 | `orderNo` | 對外顯示的編號（如 `20260923-000123`），**不是**主鍵 | `id` |

> 📌 **「可售庫存永遠用算的」** 是一個需求層級的決定，不是實作細節。
> 如果你把 `available` 也存成一個欄位，你就有**三個數字要保持一致**（`onHand`、`reserved`、`available`），
> 而任何一次只更新了兩個的 bug 都會產生幽靈庫存。
> 這一條會在第 02 章變成 schema 的 `CHECK (reserved >= 0 AND reserved <= on_hand)`。

> 📌 **「一張訂單只屬於一位賣家」** 也是需求層級的決定。
> 購物車裡如果有三個賣家的商品，結帳時要**分三次結**（前端依賣家分組）。
> 為什麼不做「一次結帳自動拆成三張訂單」？因為那會讓「一次請求」產生三個獨立的交易結果 ——
> 其中一張扣庫存失敗時，另外兩張算不算數？這正是 [13-distributed-systems/](../13-distributed-systems/) 要處理的問題，不是這一站的。見 0.7。

---

## 0.4 使用者故事與驗收條件

### 0.4.1 怎麼寫：一條驗收條件 = 一個測試

這一節的格式是這樣的：

```
US-<模組>-<編號>  <標題>
  作為 <角色>，我想要 <做什麼>，以便 <得到什麼>。

  AC-1  Given <前置狀態>  When <動作>  Then <可觀察的結果>
  AC-2  ...
```

每一條使用者故事（US）都有 2～8 條驗收條件（AC）。寫的時候守三條規則：

**規則一：Then 後面只能寫「可以被觀察到的東西」。**

| ❌ 不能測 | ✅ 可以測 |
|---|---|
| 「系統正確處理庫存」 | 「`available` 減少 2；`inventory_ledger` 新增一筆 `reason=RESERVE, delta=-2`」 |
| 「回傳錯誤」 | 「回應 409，body 的 `type` 為 `/problems/insufficient-stock`」 |
| 「很快」 | 「在 32 個並行請求下 p99 < 300 ms」（見 0.6） |
| 「使用者看不到別人的訂單」 | 「買家 A 以買家 B 的訂單 id 請求 → 404，且 `audit_logs` 新增一筆 `ACCESS_DENIED`」 |

**規則二：每一條 AC 都要寫「失敗時會怎樣」。**
「成功下單」只佔一條 AC。「庫存不足」「商品已下架」「價格已變動」「重複送出」「未登入」各自是一條。
**驗收條件的數量，大部分來自失敗路徑。**

**規則三：錯誤回應用 [03-rest-api/04](../03-rest-api/04-error-handling-and-problem-details.md) 的 Problem Details 格式，`type` 在需求階段就定下來。**
這樣前端可以在後端寫好之前就開始寫錯誤處理。

本專題所有的錯誤型別（第 03 章會實作成一個 enum）：

| HTTP | `type` | 什麼時候 |
|---|---|---|
| 400 | `/problems/validation` | 欄位驗證失敗（`errors[]` 列出每一個欄位） |
| 401 | `/problems/unauthenticated` | 沒帶 token、token 過期、token 無效 |
| 403 | `/problems/forbidden` | 角色不對（買家呼叫賣家 API） |
| 404 | `/problems/not-found` | 資源不存在，**或存在但不屬於你**（見 US-ORD-5） |
| 409 | `/problems/email-unavailable` | 註冊時 email 無法使用（US-ACC-1 AC-2；第 05 章實作時補上，5.4.1） |
| 409 | `/problems/insufficient-stock` | 可售庫存不足 |
| 409 | `/problems/invalid-state` | 狀態不允許此動作（例如撿貨中取消） |
| 409 | `/problems/price-changed` | 下單時的價格與客戶端看到的不同 |
| 409 | `/problems/product-unavailable` | 商品已下架 |
| 409 | `/problems/idempotency-in-progress` | 同一個冪等鍵的前一個請求還在處理 |
| 422 | `/problems/idempotency-key-reused` | 同一個冪等鍵帶了**不同的** body |
| 429 | `/problems/rate-limited` | 超過限流（帶 `Retry-After`） |
| 503 | `/problems/temporarily-unavailable` | 依賴降級中（例如熱點商品在 Redis 掛掉時暫停搶購） |
| 500 | `/problems/internal` | 未預期的錯誤。body 只有一句「系統發生錯誤，請稍後再試」與 `traceId`，不含堆疊、類別名、SQL（0.6.5） |

> 📌 注意「存在但不屬於你」回 **404 不是 403**。
> 回 403 等於告訴攻擊者「這個 id 存在」—— 對方就可以逐一枚舉訂單 id，知道你一天有幾張訂單。
> 這條在 [09-spring-security/](../09-spring-security/) 講過，這裡把它寫成需求。

### 0.4.2 帳號（ACC）

**US-ACC-1 註冊**
作為訪客，我想要用 email 與密碼註冊為買家，以便下單。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | email 未被使用 | 註冊 `{email, password, displayName}` | 201；角色為 `BUYER`；密碼以 **BCrypt**（cost 10）雜湊儲存，資料庫查不到明文 |
| 2 | email 已被使用（**不分大小寫**：`A@x.com` 與 `a@x.com` 視為相同） | 註冊 | 409 `/problems/email-unavailable`，訊息**不透露**該 email 已註冊（統一寫「無法以此 email 註冊」） |
| 3 | —— | 密碼少於 8 字元，或超過 72 bytes | 400，`errors[0].field = "password"` |
| 4 | —— | 註冊請求帶了 `"role": "ADMIN"` | 忽略該欄位，仍建立 `BUYER`（**不可**由客戶端指定角色） |

> 📌 AC-3 的「72 bytes」不是隨便寫的：BCrypt 只取前 72 bytes，超過的部分**默默被忽略**。
> 不擋的話，兩個前 72 bytes 相同的密碼會被當成同一個密碼。中文一個字 3 bytes，24 個中文字就到上限了。

> 📌 AC-4 是**大量指派**（mass assignment）漏洞的需求版。
> 如果你的 DTO 直接是 Entity，或者 DTO 裡有 `role` 欄位，這條 AC 就會紅。

**US-ACC-2 登入**
作為使用者，我想要登入取得 token，以便呼叫需要身分的 API。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | 帳密正確 | 登入 | 200，回傳 `accessToken`（JWT，**15 分鐘**）與 `refreshToken`（不透明字串，**7 天**，資料庫只存雜湊） |
| 2 | 密碼錯誤 | 登入 | 401；訊息與「帳號不存在」**完全相同**；回應時間差異 < 50 ms（防帳號列舉） |
| 3 | 同一帳號 15 分鐘內連續失敗 5 次 | 第 6 次登入（即使密碼正確） | 429，`Retry-After` 為剩餘鎖定秒數 |
| 4 | refresh token 有效 | 呼叫 refresh | 回傳新的 access + refresh，**舊的 refresh token 立即失效**（rotation） |
| 5 | 一個**已經用過**的 refresh token 被再次使用 | 呼叫 refresh | 401，**並撤銷該使用者所有 refresh token**（重放偵測：代表 token 被偷了） |
| 6 | 帳號被管理員停權 | 用停權前拿到的 access token 呼叫任何 API | **最遲 15 分鐘後**開始回 401（access token 自然過期；第 05 章把 JWT 驗證的時鐘誤差設成 5 秒，實際上限是 15 分鐘 + 5 秒，5.5.4）；refresh 立即失敗 |

> 📌 AC-6 是一個**明確寫下的妥協**：停權不是即時的，最多有 15 分鐘（加上第 05 章設的 5 秒時鐘誤差）的空窗。
> 要做到即時，就要每個請求查一次 Redis 黑名單（[10-redis/11](../10-redis/11-session-and-token-revocation.md)）。
> 本專題**選擇接受 15 分鐘**，並把它寫在需求裡 —— 這樣三個月後有人問「為什麼停權了還能下單」，答案在文件裡，不在某個人的記憶裡。

**US-ACC-3 賣家與管理員帳號**
作為管理員，我想要把一個帳號升級為賣家，以便該帳號上架商品。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | 一個 `BUYER` 帳號 | 管理員授予 `SELLER` | 該帳號同時具有 `BUYER` 與 `SELLER`；`audit_logs` 記錄是誰、何時、授予誰 |
| 2 | —— | 非管理員呼叫授權 API | 403 |
| 3 | 系統首次啟動 | —— | 管理員帳號由**環境變數**建立（`SHOP_BOOTSTRAP_ADMIN_EMAIL` / `..._PASSWORD`），**不存在任何預設帳密** |

### 0.4.3 商品（PRD）

**US-PRD-1 上架商品**
作為賣家，我想要建立商品並上架，以便買家購買。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | 已登入的賣家 | 建立 `{name, description, price, categoryId, initialStock}` | 201；狀態 `DRAFT`；`sellerId` 為**目前使用者**（不可由 body 指定）；`inventory.onHand = initialStock`；`inventory_ledger` 一筆 `reason=INITIAL` |
| 2 | —— | `price` ≤ 0、小數超過 2 位、或 > 1,000,000 | 400 |
| 3 | `DRAFT` 商品 | 賣家上架 | 狀態 `ON_SALE`；出現在搜尋結果中 |
| 4 | 賣家 A 的商品 | 賣家 B 嘗試修改 | **404**（不是 403，理由同 0.4.1） |

**US-PRD-2 搜尋與瀏覽**
作為買家（或訪客），我想要依關鍵字、分類、價格區間搜尋商品，以便找到想買的東西。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | —— | `GET /api/products?q=耳機&categoryId=11&minPrice=100&maxPrice=2000&page=0&size=20&sort=price,asc` | 200；只含 `ON_SALE` 商品；回應帶 `page`、`size`、`totalElements`（`categoryId` 只比對**葉分類**：商品只掛在葉分類上，傳頂層分類會得到 0 筆，3.5.4） |
| 2 | —— | `size=500` | 以 **100** 處理（上限），**不回 400**（[06-repository/04](../06-repository/04-pagination-sorting-and-dynamic-query.md)） |
| 3 | —— | `sort=sellerPassword,asc`（不存在的欄位） | 400，**訊息不包含任何類別名或欄位名**（白名單排序：`price`、`createdAt`、`name`） |
| 4 | —— | `q=%` 或 `q=_` | 視為字面字元搜尋，**不是萬用字元**（跳脫 `LIKE`） |
| 5 | 訪客（未登入） | 搜尋 | 200（瀏覽不需登入） |

**US-PRD-3 商品詳情**
作為買家，我想要看商品詳情與可售庫存，以便決定要不要買。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | `ON_SALE` 商品 | `GET /api/products/{id}` | 200；含 `available`（**不含** `onHand` 與 `reserved`） |
| 2 | `DRAFT` 或 `OFF_SHELF` 商品 | 買家請求 | 404；**賣家本人**請求仍為 200 |
| 3 | 賣家改價 | 之後 **1 秒內**的詳情請求 | 回傳新價格（快取失效的需求，第 06 章） |
| 4 | —— | `available` 的顯示 | 可以是「約略值」：**允許最多 5 秒的延遲**；真正的判斷在下單時（US-ORD-1 AC-3） |

> 📌 AC-3 與 AC-4 對快取的要求**不一樣**，而且是刻意的：
> **價格錯了是法律問題**（顯示 100 元、結帳 120 元），所以要 1 秒；
> **庫存顯示錯了只是體驗問題**（顯示還有 3 件、下單時說沒了），所以可以 5 秒。
> 第 06 章的快取設計會直接從這兩條推出來：價格在寫入時主動失效，庫存用短 TTL。

**US-PRD-4 下架**
作為賣家，我想要下架商品，以便暫停銷售。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | `ON_SALE` 商品 | 下架 | 狀態 `OFF_SHELF`；搜尋結果中消失（**1 秒內**） |
| 2 | 該商品在某些買家的購物車裡 | 下架 | 購物車項目**保留**，但標記 `unavailable: true`；結帳時被擋（US-CART-2 AC-2） |
| 3 | 該商品有未完成的訂單 | 下架 | **不影響**已成立的訂單；它們照常付款、出貨 |
| 4 | —— | 刪除商品 | **不提供硬刪除**。已被訂單引用的商品永遠保留（訂單明細需要它） |

**US-PRD-5 補貨**
作為賣家，我想要增加實體庫存，以便繼續銷售。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | —— | `POST /api/seller/products/{id}/restock {quantity: 50, note}` | `onHand += 50`；`inventory_ledger` 一筆 `reason=RESTOCK` |
| 2 | —— | `quantity` ≤ 0 | 400（**減少**庫存不走這支 API —— 報損要另外申請，不在範圍內） |
| 3 | 同時有人在下單 | 補貨 | 兩者都成功，最終 `onHand` 與 `reserved` 正確（不能「補貨覆蓋掉預留」—— 見第 04 章的 lost update） |

### 0.4.4 購物車（CART）

**US-CART-1 管理購物車**
作為買家，我想要把商品加入購物車、改數量、移除，以便一次結帳。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | —— | 加入 `{productId, quantity: 2}` | 200；若已存在則**數量相加** |
| 2 | —— | 數量 < 1 或 > 99 | 400 |
| 3 | —— | 加入超過 50 種不同商品 | 400 `/problems/validation`（購物車上限；已在車裡的商品照樣可以相加） |
| 4 | —— | 加入購物車 | **不佔庫存**。可售庫存不變 |
| 5 | 可售庫存 = 3 | 加入 5 件 | **允許**，但回應帶 `warnings: ["INSUFFICIENT_STOCK"]`（真正的擋在下單） |

> 📌 AC-3 的測試 `CatalogCartApiTest.cartDistinctItemLimit` 不在 03～09 章裡，補在第 09 章結束時的程式碼上。它先加滿 50 種，再加第 51 種，實測回應是
> `HTTP 400 {"type":"/problems/validation","title":"請求內容不正確","status":400,"detail":"購物車最多 50 種商品",…}`，購物車仍然是 50 列。
> 已經在車裡的第 50 種商品再加一件，回 200。

> 📌 AC-4 就是 0.2.1 的讀法 B 的教訓：**加入購物車就佔庫存 = 讓「永遠不會結帳的人」佔住貨。**
> 購物車的放棄率比下單後不付款高得多（業界常見數字是 70% 左右）。

**US-CART-2 結帳前檢查**
作為買家，我想要在結帳前看到最新的價格與可購買狀態，以便不會被意外收費。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | 加入購物車時單價 100，之後賣家改成 120 | 查看購物車 | 顯示 **120**，並帶 `priceChanged: true, previousPrice: 100` |
| 2 | 購物車內有已下架商品 | 結帳 | 該商品被排除並提示；若排除後為空，409 `/problems/product-unavailable` |
| 3 | 購物車內含兩位賣家的商品 | 查看購物車 | 回應**依賣家分組**；結帳 API 一次只接受**一個賣家**的品項（0.3.5） |

### 0.4.5 訂單（ORD）—— 這個專題的核心

**US-ORD-1 下單**
作為買家，我想要把購物車中同一位賣家的商品下單，以便購買。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | 購物車有 A×2、B×1，可售庫存充足 | `POST /api/orders`，header `Idempotency-Key: <uuid>`，body 帶品項與**客戶端看到的單價** | 201；訂單狀態 `PENDING_PAYMENT`；`orderNo` 格式 `yyyyMMdd-nnnnnn`；回應帶 `paymentDeadline`（= 建立時間 + 15 分鐘） |
| 2 | 同上 | 同上 | 每個 `OrderItem` 存下單當下的 `unitPrice`；訂單 `totalAmount` = Σ(unitPrice × quantity)，**以 `BigDecimal` 計算、四捨五入到小數 2 位** |
| 3 | 同上 | 同上 | 對每個品項建立 `HELD` 預留；`reserved` 增加；**`onHand` 不變**；`inventory_ledger` 每個品項一筆 `reason=RESERVE` |
| 4 | 同上 | 同上 | 下單成功的品項**從購物車移除**；未下單的（其他賣家的）保留 |
| 5 | B 的可售庫存 = 0 | 下單 | 409 `/problems/insufficient-stock`，body 列出**哪些品項不足**；**A 也不會被預留**（全有或全無） |
| 6 | 客戶端帶的單價 100，資料庫目前 120 | 下單 | 409 `/problems/price-changed`，帶最新價格；**不建立訂單** |
| 7 | 沒帶 `Idempotency-Key` | 下單 | 400 |
| 8 | 同一買家 1 分鐘內下單超過 10 次（以**不同的 `Idempotency-Key`** 計：同一個鍵的重送不算新的一次，第 06 章 6.7.1） | 第 11 次 | 429 |

> 📌 AC-5 的「全有或全無」是**交易邊界**的需求（驗收 Q1）。第 04 章的整個交易設計從這一條開始。

> 📌 AC-6 為什麼要客戶端帶價格？因為**使用者同意付的是自己看到的那個價格**。
> 如果後端默默用新價格成立訂單，你就是在使用者不知情的情況下多收錢。
> 這一條也順便擋掉了「前端被改、送一個很低的價格」—— 後端**永遠用資料庫的價格計算**，客戶端的價格只用來**比對**。

**US-ORD-1a 冪等下單**（驗收 Q3）

| AC | Given | When | Then |
|---|---|---|---|
| 1 | 冪等鍵 K 的請求已成功（201，訂單 #123） | 同一買家以 K 與**相同 body** 再送一次 | **200**（不是 201），回傳**同一張訂單 #123**；不建立新訂單、不重複預留 |
| 2 | 冪等鍵 K 已使用 | 同一買家以 K 與**不同 body** 送出 | 422 `/problems/idempotency-key-reused` |
| 3 | 冪等鍵 K 的第一個請求還在處理中 | 第二個請求以 K 到達 | 409 `/problems/idempotency-in-progress`，帶 `Retry-After: 1` |
| 4 | 冪等鍵 K 的第一個請求**失敗**（例如 409 庫存不足） | 以 K 再送一次 | **重新執行**（失敗不會被快取；使用者補貨後重試應該要能成功） |
| 5 | 買家 A 用了鍵 K | 買家 B 用同一個鍵 K | 視為**不同的鍵**（冪等鍵的範圍是「每個使用者」） |
| 6 | —— | 冪等鍵保存時間 | **24 小時**；之後同一個鍵視為新請求 |

> 📌 AC-4 常常被寫錯。「冪等」的直覺是「同一個鍵永遠回同一個結果」，但**對失敗結果這樣做是錯的**：
> 使用者因為庫存不足下單失敗，賣家補貨之後再按一次 —— 如果你快取了那個 409，這位使用者永遠下不了單。
> 規則是：**成功結果要快取；「業務性失敗」（4xx）不快取；「處理中」要擋。** [03-rest-api/08](../03-rest-api/08-idempotency-caching-and-rate-limit.md) 與 [10-redis/10](../10-redis/10-rate-limit-and-idempotency.md) 講過機制，這裡定下規則。

**US-ORD-1b 搶購**（驗收 Q2）

| AC | Given | When | Then |
|---|---|---|---|
| 1 | 商品 X 可售庫存 = 1 | 100 個不同買家**同時**下單 X×1 | **恰好 1 筆** 201；**99 筆** 409 `/problems/insufficient-stock`；最終 `available = 0`；**0 筆** 500 |
| 2 | 商品 X 可售庫存 = 500 | 2,000 個買家在 10 秒內各下單 1 件 | 恰好 500 筆成立；p99 回應時間 < **500 ms**；`inventory_ledger` 的 `RESERVE` 筆數 = 500 |
| 3 | 同上 | 活動結束後 | `onHand - reserved` 與 Σ(`HELD` + `CONFIRMED` 預留) 的**對帳差異為 0** |

> ⚠️ AC-1 的「**0 筆 500**」跟「恰好 1 筆成功」一樣重要。
> 用悲觀鎖實作時，最常見的失敗不是超賣，而是 99 個請求裡有十幾個**等鎖逾時**，回了 500 —— 使用者看到的是「系統錯誤」而不是「已售完」。
> 第 04 章會量出這個數字。

> 📌 AC-2 的「500 ms」從哪裡來？0.6.1 的容量估算 + 0.11 的實測。**先有估算和實測，才有這個數字**，不是反過來。

**US-ORD-2 付款**

| AC | Given | When | Then |
|---|---|---|---|
| 1 | `PENDING_PAYMENT` 訂單 | 買家 `POST /api/orders/{orderNo}/payments`（0.8 的 ⚠️） | 201；建立 `Payment(status=PENDING)`，回傳模擬金流的付款頁網址 |
| 2 | 同上 | 金流回呼「成功」（帶 `providerTxnId`、金額、**HMAC 簽章**） | 訂單 → `PAID`；該訂單所有預留 `HELD → CONFIRMED`；`payments` 記錄 `SUCCEEDED` |
| 3 | 同上 | 回呼的**簽章錯誤** | 401；訂單與付款**完全不變**；`audit_logs` 記錄 `PAYMENT_SIGNATURE_INVALID` |
| 4 | 同上 | 回呼的**金額與訂單金額不符** | 400；訂單不變；**告警**（這代表有人在攻擊或金流有 bug） |
| 5 | 訂單已是 `PAID` | 同一個 `providerTxnId` 的成功回呼再到一次 | **200**，不做任何事（冪等） |
| 6 | 訂單已是 `CANCELLED`（逾時或買家取消） | 成功回呼到達（**晚到的付款**） | 200（對金流而言通知已收到）；訂單**維持 `CANCELLED`**；自動發起**全額退款**；`payments` 記錄 `SUCCEEDED` 後接一筆 `refunds` |
| 7 | `PENDING_PAYMENT` 訂單 | 金流回呼「失敗」 | 訂單**維持** `PENDING_PAYMENT`（買家可以在期限內重試）；`payments` 記錄 `FAILED` |
| 8 | —— | 任何回呼 | 在 **3 秒內**回應（金流通常 5～10 秒逾時就重送）；耗時的後續動作走非同步 |

> 📌 AC-6 就是 0.2.2 的 `CANCELLED + PAY : 2,042`。它在需求裡只有一行，但它決定了三件事：
> 回呼處理**不能**在訂單已取消時丟例外（那會讓金流一直重送）、
> 退款要是一個**可重試**的非同步動作（金流的退款 API 也會失敗）、
> 以及「錢收了但訂單取消了」這件事要**被記錄**，不是被忽略。

**US-ORD-3 付款逾時自動取消**

| AC | Given | When | Then |
|---|---|---|---|
| 1 | `PENDING_PAYMENT` 訂單，建立已滿 **15 分鐘** | 排程執行 | 訂單 → `CANCELLED`（`cancelReason=PAYMENT_TIMEOUT`）；所有 `HELD` 預留 → `RELEASED`；`reserved` 減回；`inventory_ledger` 每品項一筆 `reason=RELEASE` |
| 2 | 同上 | 排程執行 | 取消在 **15 分鐘 + 60 秒內**發生（排程精度） |
| 3 | 3 台應用程式同時跑排程 | 排程執行 | 每張訂單**只被取消一次**；`inventory_ledger` 的 `RELEASE` **不重複** |
| 4 | 訂單在第 14 分 59 秒付款成功 | 排程在第 15 分鐘執行 | **不取消**（`CONFIRMED` 預留不可被逾時釋放） |
| 5 | 排程取消與付款回呼**同時**發生 | —— | 兩者**只有一個生效**：要嘛 `PAID`、要嘛 `CANCELLED` + 自動退款。**不會**出現 `PAID` 但預留已被釋放 |

> 📌 AC-5 是整個專題最難的一條 AC。
> 它是一個**競態條件**寫成的需求：兩個來源、同一張訂單、同一毫秒。
> 第 04 章會用樂觀鎖（`@Version`）或條件式 UPDATE（`WHERE status = 'PENDING_PAYMENT'`）解決它，並用 `CountDownLatch` 讓兩個執行緒在同一瞬間撞上去，證明它不會壞。

**US-ORD-4 買家取消**

| AC | Given | When | Then |
|---|---|---|---|
| 1 | `PENDING_PAYMENT` | 買家取消 | → `CANCELLED`（`cancelReason=BUYER`）；預留釋放 |
| 2 | `PAID` | 買家取消 | → `CANCELLED`；預留釋放；**自動發起全額退款** |
| 3 | `PICKING` 或之後 | 買家取消 | 409 `/problems/invalid-state`，訊息提示「已進入出貨流程」 |
| 4 | `CANCELLED` | 買家再取消一次 | **200**，回傳目前狀態（冪等，0.2.2 的最後一列） |
| 5 | 別人的訂單 | 買家取消 | 404 |

**US-ORD-5 查詢訂單**（驗收 Q4、Q5）

| AC | Given | When | Then |
|---|---|---|---|
| 1 | 買家有 45 張訂單 | `GET /api/orders?page=0&size=20&status=PAID` | 200；只含**自己的**訂單；依建立時間倒序；每張含明細 |
| 2 | 同上 | 同上 | **執行的 SQL 次數固定**（≤ 3 句），不隨頁內筆數增加（N+1 檢查） |
| 3 | 買家 A | `GET /api/orders/{買家 B 的訂單 id}` | **404**；`audit_logs` 記錄 `ACCESS_DENIED`（含 A 的 id 與被請求的 id） |
| 4 | 同一買家 1 分鐘內觸發 AC-3 超過 20 次 | —— | 告警（疑似枚舉攻擊） |
| 5 | 賣家 | `GET /api/seller/orders` | 只含**自己商品的**訂單 |

**US-ORD-6 出貨與完成**

| AC | Given | When | Then |
|---|---|---|---|
| 1 | `PAID` 訂單 | 賣家「開始撿貨」 | → `PICKING`（從此買家不可取消） |
| 2 | `PICKING` 訂單 | 賣家出貨 `{carrier, trackingNo}` | → `SHIPPED`；預留 `CONFIRMED → CONSUMED`；`onHand` 與 `reserved` **同時**減少；`inventory_ledger` 一筆 `reason=SHIP` |
| 3 | `SHIPPED` 訂單 | 買家確認收貨 | → `COMPLETED` |
| 4 | `SHIPPED` 超過 **7 天**未確認 | 排程 | 自動 → `COMPLETED` |
| 5 | `PAID` 訂單，賣家發現缺貨 | 賣家取消 | → `CANCELLED`（`cancelReason=SELLER_OUT_OF_STOCK`）；自動退款；**通知買家**；`audit_logs` 記錄 |
| 6 | 任一狀態變更 | —— | `order_status_history` 新增一筆（from、to、事件、操作者、時間） |

### 0.4.6 庫存（INV）

庫存沒有「使用者」，它的需求是**不變量**（[05-service/00](../05-service/00-course-map-business-layer-role.md) 講過的概念）：
不管任何時候、任何路徑、任何併發，這幾條都必須成立。

| 編號 | 不變量 | 怎麼驗證 |
|---|---|---|
| INV-1 | `0 ≤ reserved ≤ onHand` | DB `CHECK` 約束 + 每小時對帳 |
| INV-2 | `reserved` = 該商品所有 `HELD` + `CONFIRMED` 預留的數量總和 | 每小時對帳 SQL，差異 ≠ 0 即告警 |
| INV-3 | `onHand` = Σ `inventory_ledger` 中所有影響 `onHand` 的 delta | 同上 |
| INV-4 | 一張訂單對一個商品**最多一筆**預留（含已釋放的：本專題的預留不會重建） | 唯一索引 `(order_id, product_id)`。MySQL 沒有部分索引，寫不出「非 `RELEASED` 才唯一」，所以直接全欄唯一 |
| INV-5 | `inventory_ledger` 只能新增，**不能修改、不能刪除** | 應用程式帳號沒有該表的 `UPDATE` / `DELETE` 權限（第 09 章） |

> 📌 INV-2 與 INV-3 是**對帳**需求。它們承認一件事：**你的程式會有 bug。**
> 不變量被 `CHECK` 擋下的那些 bug 會變成 500；沒被擋下的會變成對帳差異。
> **兩種都要被發現**，而且後者要在「一小時內」被發現，而不是在「月底盤點」時。

### 0.4.7 報表（RPT）

**US-RPT-1 賣家銷售報表**

| AC | Given | When | Then |
|---|---|---|---|
| 1 | 賣家 | `GET /api/seller/reports/daily-sales?from=2026-09-01&to=2026-09-30` | 每日一列：訂單數、**已付款**金額、退款金額、淨額。金額採**現金基礎**：錢在哪一天進來、哪一天出去，就算哪一天（第 03 章 3.7.1 定案；退款目前用的是建立退款請求的時間，見該節的 ⚠️） |
| 2 | —— | 日期的切分 | 以 **Asia/Taipei** 的日曆日為準（資料庫存 UTC，查詢時轉換） |
| 3 | —— | 區間 > 366 天 | 400 |
| 4 | 資料庫有 10 萬張訂單、30 萬筆明細 | 查 90 天 | p95 < **1 秒** |

> 📌 AC-2 是 [04-controller/06](../04-controller/06-cors-content-negotiation-and-json.md) 那個「對帳差 8 小時」的需求版。
> 「9 月 1 日的營收」在 UTC 是 8 月 31 日 16:00 到 9 月 1 日 16:00。需求不寫，就一定有人用 UTC 切。

**US-RPT-2 商品銷售排行**

| AC | Given | When | Then |
|---|---|---|---|
| 1 | 賣家或管理員 | 查詢區間內銷量 Top 20 | 依**已出貨**數量排序 |
| 2 | 任何人（首頁） | `GET /api/products/trending` | 近 24 小時**下單**量 Top 10；允許 **1 分鐘**延遲（Redis 快取，第 06 章；為什麼不是每張訂單 `ZINCRBY` 見 6.8.2） |

**US-RPT-3 管理員全站報表** —— 同 US-RPT-1，但不限賣家，並可依賣家分組。

### 0.4.8 通知（NTF）

**US-NTF-1 訂單通知**

| AC | Given | When | Then |
|---|---|---|---|
| 1 | 訂單成立 / 付款成功 / 已出貨 / 已取消（含退款） | —— | 買家收到對應通知（本專題以寫入 `notifications` 表 + 日誌模擬寄信） |
| 2 | —— | 通知延遲 | 事件發生後 p99 **60 秒**內 |
| 3 | 同一事件的訊息被投遞多次 | —— | 買家**只收到一次**（驗收 Q10 的通知版） |
| 4 | 通知服務（模擬的 SMTP）連續失敗 | —— | 重試 5 次（指數退避）後進死信；**下單不受影響** |
| 5 | 應用程式在訂單 commit 之後、訊息送出之前被 `kill -9` | 重啟 | 通知**仍會送出**（驗收 Q9） |

### 0.4.9 稽核（AUD）

**US-AUD-1 稽核日誌**

以下動作**必須**寫入 `audit_logs`（誰、何時、做了什麼、對象、來源 IP、traceId）：

- 所有管理員動作（授權、停權、強制下架）。
- 賣家改價（含舊價與新價）。
- 所有 `ACCESS_DENIED`（404 型的越權嘗試）。
- 付款回呼簽章錯誤、金額不符。
- 登入失敗鎖定。

| AC | Given | When | Then |
|---|---|---|---|
| 1 | —— | 上述任一動作 | **業務動作**（授權、停權、改價、賣家取消）：`audit_logs` 在**同一個交易**內寫入（業務 rollback，稽核也 rollback）。**被拒絕的動作**（`ACCESS_DENIED`、簽章錯誤、金額不符、登入鎖定）：它們會讓業務交易 rollback，所以**獨立寫入**（第 05 章 5.2.5、5.9） |
| 2 | —— | 稽核內容 | **不含**密碼、token、完整信用卡號 |
| 3 | 管理員 | 查詢稽核日誌 | 可依使用者、動作、時間區間篩選 |

### 0.4.10 數一數

| 模組 | 使用者故事 | 驗收條件 |
|---|---|---|
| ACC | 3 | 13 |
| PRD | 5 | 20 |
| CART | 2 | 8 |
| ORD | 8（含 1a、1b） | 46 |
| INV | —— | 5 條不變量 |
| RPT | 3 | 6 |
| NTF | 1 | 5 |
| AUD | 1 | 3 |
| **合計** | **23** | **101 + 5 條不變量** |

**ORD 一個模組就佔了將近一半的驗收條件。** 這就是為什麼第 04 章與第 07 章是「重頭戲」。

> 📌 101 條 AC 不會每一條都變成一個測試方法 —— 有些會合併，有些會變成 ArchUnit 規則或對帳 SQL。
> 但**每一條都要能指出「它在哪裡被驗證」**。0.12 會建一張追溯表。

---

## 0.5 訂單狀態機（定案）

0.2.2 證明了一件事：**「可以取消」不是一個功能，是一張表。**
這一節就是那張表。它是這個專題**唯一一份不允許「大概」的文件** ——
第 04 章的 `OrderStatus` enum、第 05 章的權限檢查、第 07 章的事件發佈，全部從這裡抄過去。

### 0.5.1 六個狀態

```
                                  PAY_SUCCEEDED
            ┌─────────────────┐ ───────────────▶ ┌──────────┐  START_PICKING  ┌──────────┐
  下單 ───▶ │ PENDING_PAYMENT │                   │   PAID   │ ──────────────▶ │ PICKING  │
            └─────────────────┘                   └──────────┘                 └──────────┘
               │  ▲  │                               │    │                        │   │
    PAY_FAILED │  │  │ BUYER_CANCEL                  │    │ BUYER_CANCEL           │   │ SHIP
   （維持原狀）└──┘  │ PAYMENT_TIMEOUT               │    │ SELLER_CANCEL          │   ▼
                     │                               │    │   ＋退款                │ ┌──────────┐
                     ▼                               │    ▼                        │ │ SHIPPED  │
                ┌───────────┐ ◀──────────────────────┘ ◀──────────────────────────┘ └──────────┘
                │ CANCELLED │                     SELLER_CANCEL ＋退款                │
                └───────────┘                    （撿貨中發現貨損）                    │ CONFIRM_RECEIPT
                     ▲                                                                │ AUTO_COMPLETE（7 天）
                     │ 晚到的 PAY_SUCCEEDED：維持 CANCELLED ＋ 自動退款                ▼
                     └──（不轉移，只觸發退款）                                   ┌───────────┐
                                                                                 │ COMPLETED │
                                                                                 └───────────┘
```

| 狀態 | 意思 | 預留的狀態 | 買家看到的文字 |
|---|---|---|---|
| `PENDING_PAYMENT` | 已成立、等待付款 | `HELD` | 待付款（剩餘 mm:ss） |
| `PAID` | 已付款、等待賣家處理 | `CONFIRMED` | 已付款 |
| `PICKING` | 賣家已開始撿貨 | `CONFIRMED` | 準備出貨中 |
| `SHIPPED` | 已交給物流 | `CONSUMED` | 已出貨（物流單號） |
| `COMPLETED` | 買家確認收貨，或出貨 7 天後自動完成 | `CONSUMED` | 已完成 |
| `CANCELLED` | 已取消（帶 `cancelReason`） | `RELEASED` | 已取消（原因；若有退款，顯示退款狀態） |

**兩個終態**：`COMPLETED` 與 `CANCELLED`。進入終態之後，**沒有任何事件能讓它離開**。

> 📌 為什麼沒有 `REFUNDED` 狀態？
> 因為「退款」是**付款**的狀態，不是**訂單**的狀態。一張 `CANCELLED` 的訂單可能：沒付過款（不用退）、退款中、退款成功、退款失敗待人工處理。
> 把這四種塞進訂單狀態，訂單狀態就會變成 9 個，而且**「訂單流轉」與「錢的流轉」會綁死在一起**。
> 本專題的做法：訂單狀態只管訂單，`refunds` 表有自己的狀態（`PENDING → SUCCEEDED / FAILED`）。
> 這一條就是 [05-service/00](../05-service/00-course-map-business-layer-role.md) 問的「**不變量該守在哪裡**」，本專題的答案是：一個不變量只能有一個主人。

### 0.5.2 九個事件（＋第 07 章的 E10）

| # | 事件 | 誰觸發 | 帶什麼資料 |
|---|---|---|---|
| E1 | `PAY_SUCCEEDED` | 金流回呼 | `providerTxnId`、金額、簽章 |
| E2 | `PAY_FAILED` | 金流回呼 | `providerTxnId`、失敗原因 |
| E3 | `BUYER_CANCEL` | 買家 | —— |
| E4 | `PAYMENT_TIMEOUT` | 排程 | —— |
| E5 | `SELLER_CANCEL` | 賣家（或管理員代為執行，須填原因、寫稽核） | 原因 |
| E6 | `START_PICKING` | 賣家 | —— |
| E7 | `SHIP` | 賣家 | `carrier`、`trackingNo` |
| E8 | `CONFIRM_RECEIPT` | 買家 | —— |
| E9 | `AUTO_COMPLETE` | 排程 | —— |
| E10 | `STOCK_SHORTAGE` | 系統（熱點商品落帳時發現庫存不足；**第 07 章新增**，7.6.3） | —— |

### 0.5.3 完整的 6 × 9 轉移表

**圖例**：

- `→ X`：轉移到 X
- `＝`：**冪等成功**，回 200，不改變任何東西
- `↺`：**不轉移**，但觸發退款（這筆錢不該收）
- `✗`：拒絕，回 409 `/problems/invalid-state`
- `·`：排程類事件掃到不相干的單，**靜默略過**（條件式 UPDATE 影響 0 列，不是錯誤）

| 狀態 ＼ 事件 | E1 付款成功 | E2 付款失敗 | E3 買家取消 | E4 付款逾時 | E5 賣家取消 | E6 開始撿貨 | E7 出貨 | E8 確認收貨 | E9 自動完成 |
|---|---|---|---|---|---|---|---|---|---|
| **PENDING_PAYMENT** | **→ PAID** | ＝（記錄失敗） | **→ CANCELLED** | **→ CANCELLED** | ✗ | ✗ | ✗ | ✗ | · |
| **PAID** | ＝ 同一筆<br>↺ 不同筆 | ＝ | **→ CANCELLED** ＋退款 | · | **→ CANCELLED** ＋退款 | **→ PICKING** | ✗ | ✗ | · |
| **PICKING** | ＝ / ↺ | ＝ | ✗ | · | **→ CANCELLED** ＋退款 | ＝ | **→ SHIPPED** | ✗ | · |
| **SHIPPED** | ＝ / ↺ | ＝ | ✗ | · | ✗ | ✗ | ＝ 同單號<br>✗ 不同單號 | **→ COMPLETED** | **→ COMPLETED** |
| **COMPLETED** | ＝ / ↺ | ＝ | ✗ | · | ✗ | ✗ | ✗ | ＝ | · |
| **CANCELLED** | **↺** 晚到的付款 | ＝ | ＝ | · | ＝ | ✗ | ✗ | ✗ | · |

54 格，**每一格都有答案**。挑幾格講為什麼：

> 📌 **第 07 章補了一欄 E10（`STOCK_SHORTAGE`）**：熱點商品的 MySQL 預留移出下單交易之後（7.6），落帳時才可能發現 Redis 放進了不存在的庫存。那一欄是：`PENDING_PAYMENT` → CANCELLED；`PAID`、`PICKING` → CANCELLED ＋退款；`SHIPPED`、`COMPLETED` → ·（落帳沒完成的訂單出不了貨）；`CANCELLED` → ＝。表變成 6 × 10、60 格，`OrderStateMachineTest` 照著多了 6 個測試。

**`PAID + E1`：「＝ 同一筆 / ↺ 不同筆」**
「同一筆」是金流重送同一個 `providerTxnId` —— 冪等忽略。
「不同筆」是**同一張訂單被付了兩次錢**：買家開了兩個分頁、各付了一次。這種情況真的會發生，而且金流不會幫你擋。
答案是：第二筆**自動退款**，訂單不變。

**`PENDING_PAYMENT + E5`：✗**
賣家不能取消一張還沒付款的訂單。為什麼？因為它 15 分鐘內會自己逾時取消，而且賣家在這時取消只有一個合理動機：**賣家後悔用這個價格賣了**。
如果真的缺貨，等買家付款後走 `PAID + E5`，那條路有退款、有通知、有稽核。

**`PICKING + E3`：✗、`PICKING + E5`：→ CANCELLED**
撿貨中**買家**不能取消（0.2.2 定案），但**賣家**可以（撿貨時發現貨損、找不到貨）。
這兩格不對稱是刻意的：取消權跟「誰能控制那件貨」走。貨在賣家手上，所以只有賣家能中止。

**`SHIPPED + E7`：「＝ 同單號 / ✗ 不同單號」**
賣家的出貨 API 被重送（網路逾時重試）→ 同一個物流單號 → 冪等。
賣家用**另一個**單號再出貨一次 → 這是操作錯誤，不是重試 → 拒絕，請賣家走客服流程修正。

**`CANCELLED + E3 / E5`：＝**
0.2.2 最後一列的定案：使用者的意圖已經達成了，回 200。

**`CANCELLED + E1`：↺**
0.2.2 的 `CANCELLED + PAY : 2,042`。**不要**讓訂單「復活」成 `PAID` —— 預留已經釋放、貨可能已被別人買走。退款，通知買家重新下單。
（第 04 章的實作在這一格也分了「同一筆」：已經退過款的那一筆付款，金流再通知一次，回 ＝，不會退第二次。表上只寫了 ↺，`OrderStateMachineTest` 也只測了「不同筆」的那一種。）

### 0.5.4 每個轉移的副作用

轉移不只是改一個欄位。以下是每一條轉移**必須在同一個交易裡**完成的事，以及**交易提交後**才發生的事：

| 轉移 | 同一個交易內（全有或全無） | 提交後（透過 Outbox，第 07 章） |
|---|---|---|
| 下單 → `PENDING_PAYMENT` | 寫 `orders`、`order_items`；每品項建 `HELD` 預留、`reserved +=`、寫 ledger；清購物車對應項；寫 `idempotency_keys`；寫 `order_status_history`；寫 Outbox `OrderPlaced` | 通知「訂單成立」；排行榜 +1 |
| `PENDING_PAYMENT → PAID` | `orders.status`；`payments` → `SUCCEEDED`；預留 `HELD → CONFIRMED`；history；Outbox `OrderPaid` | 通知「付款成功」；賣家通知「有新訂單」 |
| `PENDING_PAYMENT → CANCELLED` | status + `cancelReason`；預留 → `RELEASED`、`reserved -=`、ledger；history；Outbox `OrderCancelled` | 通知「訂單已取消」 |
| `PAID/PICKING → CANCELLED` | 同上，**加**建立 `refunds(PENDING)` | 通知；**呼叫金流退款 API**（可重試，失敗進死信 + 告警） |
| `PAID → PICKING` | status；history | —— |
| `PICKING → SHIPPED` | status + 物流資訊；預留 `CONFIRMED → CONSUMED`；`onHand -=`、`reserved -=`、ledger；history；Outbox `OrderShipped` | 通知「已出貨」 |
| `SHIPPED → COMPLETED` | status；history；Outbox `OrderCompleted` | —— |
| `CANCELLED + E1`（↺） | `payments` 記錄 `SUCCEEDED`（錢確實收了）；建立 `refunds(PENDING, reason=LATE_PAYMENT)` | 呼叫金流退款；通知買家 |

⚠️ **注意「呼叫金流退款 API」在右欄。**
它是一個外部呼叫，**絕對不能在交易裡**（[05-service/02](../05-service/02-transaction-management-in-depth.md) 的 2.9.3：一個外部 API 變慢，整個連線池被吃光）。
而 0.11 會量給你看，就算只是在交易裡多 5 毫秒，熱點商品的吞吐就從 678 掉到 138。

### 0.5.5 實作上的一條硬規則

> **狀態轉移一律用「條件式更新」：`UPDATE orders SET status = :to, version = version + 1 WHERE id = :id AND status = :from`，
> 並檢查影響列數。影響 0 列 = 狀態已被別人改了 → 重新讀取，依轉移表決定是 ＝、↺、✗ 還是 ·。**

這一條規則**直接解決 US-ORD-3 AC-5**（排程取消與付款回呼同時發生）：
兩個交易都執行 `... WHERE status = 'PENDING_PAYMENT'`，InnoDB 的行鎖保證**只有一個會影響到 1 列**。
另一個影響 0 列，重新讀取後看到對方的結果，查表處理。

第 04 章會把它寫成 `OrderStateMachine` 類別，並用參數化測試覆蓋上面那張表的每一格：54 格，其中 5 格（「＝ / ↺」「＝ 同單號 / ✗ 不同單號」）依情境分兩種各測一次，共 54 + 5 = 59 組；第 07 章加了 E10 之後是 60 + 5 = 65 組。

---

## 0.6 非功能需求

「系統要快、要穩、要安全」—— 這是每一份需求文件都有的一句話，也是**最沒有用**的一句話。
這一節的每一條都有**數字**、**量測方法**、以及**這個數字從哪裡來**。

### 0.6.1 容量估算：先在餐巾紙上算一次

**假設**（這些數字是「一個中小型電商」的合理量級，你的專案可以換掉，但要換成**具體的數字**）：

| 項目 | 假設值 |
|---|---|
| 註冊會員 | 50 萬 |
| 日活躍使用者（DAU） | 5 萬（10%） |
| 每位 DAU 每天的 API 請求 | 40 次（瀏覽為主） |
| 每日訂單 | 5,000 張（DAU 的 10% 下單） |
| 每張訂單平均品項 | 3 |
| 尖峰小時佔全日流量 | 15%（晚上 9～10 點） |
| 尖峰小時內的瞬間尖峰 | 平均的 3 倍 |
| 商品數 | 1 萬（賣家 500 位） |

**一般流量**：

```
每日請求   = 50,000 DAU × 40          = 2,000,000 次/天
平均 QPS   = 2,000,000 / 86,400        ≈ 23 QPS
尖峰小時   = 2,000,000 × 15% / 3,600   ≈ 83 QPS
瞬間尖峰   = 83 × 3                    ≈ 250 QPS

每日下單   = 5,000 張
尖峰小時   = 5,000 × 15% / 3,600       ≈ 0.2 張/秒
```

**0.2 張/秒。** 一般流量下，下單根本不是問題 —— 任何一台 MySQL 都扛得住。
如果只有一般流量，這個專題不需要 Redis、不需要 MQ，一台 Spring Boot + 一台 MySQL 就夠了。

**那為什麼需要後面那些東西？因為有這一行**：

**限量搶購**：

| 項目 | 假設值 |
|---|---|
| 活動 | 每週一次，20:00 開賣，某個熱門商品限量 **500 件** |
| 守候人數 | **2,000 人**，開賣瞬間同時按下「購買」 |
| 集中程度 | 前 **10 秒**內送出全部第一次下單請求 |
| 失敗重試 | 收到錯誤的人平均再按 **2 次** |
| 守候時的頁面刷新 | 每人每 2 秒刷新一次商品頁，持續 3 分鐘 |

```
開賣前 3 分鐘：商品詳情 = 2,000 人 / 2 秒              = 1,000 rps，全部打同一個商品
開賣後前 10 秒：下單請求 = 2,000 / 10 秒                 = 200 次/秒，全部打同一個商品的同一列庫存
加上重試    ：下單請求  = 200 × (1 + 2)                  ≈ 600 次/秒（其中 1,500 人終究會失敗）
```

**對照一般流量**：

| | 一般尖峰 | 搶購 | 倍數 |
|---|---|---|---|
| 下單 | 0.2 張/秒，分散在上千個商品 | **200～600 次/秒，全部在同一個商品** | **1,000～3,000 倍** |
| 商品詳情 | 分散 | **1,000 rps 在同一個 key** | —— |

⚠️ **最危險的不是「600 次/秒」這個數字本身，而是「全部在同一列」。**
0.11 會量給你看：同一台 MySQL，1,000 個商品分散時每秒成立 3,838 筆，**同一個商品時只有 678 筆**，
交易裡多做 5 毫秒的事就剩 **138 筆**。

```
需求：600 次/秒（全在一列）
上限：678 次/秒（交易完美、全在一列）
      138 次/秒（交易裡多 5 ms）
```

**結論直接寫進需求**：

1. 下單交易內**不得有任何外部呼叫**，交易持有熱點行鎖的時間要壓在 **2 ms** 以下。
2. 「一般商品」直接走 MySQL 條件式更新（第 04 章）。
3. 「熱點商品」（由賣家或管理員標記 `hot=true`）走 **Redis 預扣 + MySQL 落帳**（第 06 章）。
   Redis 在同一台機器上量到 **89,334 次/秒**（0.11），是需求的 150 倍。
4. 商品詳情**必須**有快取；熱點商品的詳情快取要防**快取擊穿**（1,000 rps 同時 miss 會全部打進 MySQL）。

**儲存量**（3 年）：

```
訂單       5,000/天 × 365 × 3                = 5,475,000 張    × ~400 B  ≈ 2.2 GB
明細       × 3                               = 16,425,000 筆   × ~200 B  ≈ 3.3 GB
庫存帳     每品項 ~3 筆（預留、出貨或釋放）    ≈ 50,000,000 筆   × ~150 B  ≈ 7.5 GB
狀態歷史   每訂單 ~4 筆                       ≈ 22,000,000 筆   × ~120 B  ≈ 2.6 GB
                                                                  小計    ≈ 15.6 GB
                                                        加上索引（× 2）   ≈ 31 GB
```

**31 GB，一台 MySQL 輕鬆放下。** 這個數字直接回答了「要不要分庫分表」—— **不要**。
這也是為什麼 [13-distributed-systems/](../13-distributed-systems/) 有一半篇幅在說服你不要拆。

> 📌 **餐巾紙估算的價值不在精確，在量級。**
> 如果你估出來是 31 GB，實際是 60 GB，結論一樣（不用分庫）。
> 如果你估出來是 31 GB，實際是 30 TB，那是假設錯了 —— 但你至少**有一個假設可以被推翻**。
> 沒有估算的需求文件，連錯都不知道錯在哪。

### 0.6.2 效能目標（SLO）

| API | 負載條件 | p95 | p99 | 量測方式 |
|---|---|---|---|---|
| `GET /api/products/{id}`（快取命中） | 1,000 rps，同一個商品 | 20 ms | **50 ms** | 第 06 章壓測 |
| `GET /api/products`（搜尋） | 100 rps，隨機關鍵字 | 150 ms | 300 ms | 第 03 章 |
| `POST /api/orders`（一般商品） | 50 rps，分散在 1,000 個商品 | 150 ms | **300 ms** | 第 04 章 |
| `POST /api/orders`（熱點商品） | 200 rps，同一個商品，持續 10 秒 | 250 ms | **500 ms** | 第 04、06 章 |
| `GET /api/orders`（我的訂單） | 100 rps | 100 ms | 200 ms | 第 03、08 章 |
| 付款回呼 | 50 rps | 300 ms | **1 s**（金流 3 秒逾時） | 第 04 章 |
| 賣家日報表（90 天） | 5 rps | **1 s** | 2 s | 第 03 章（MyBatis） |

**量測環境**：本機 `docker compose`（0.10），應用程式 `-Xmx512m`，連線池 20。
**量測工具**：與 0.11 同樣的 Java 壓測程式（固定執行緒數、固定時間、回報 p50 / p99），第 04 章會擴充它。

> 📌 為什麼寫 p99 而不是平均？
> 0.11 的單列 UPDATE：**p50 29 ms、p99 73 ms**。平均大概 32 ms，看起來很好 ——
> 但每 100 個人就有 1 個要等 73 ms 以上。搶購時 2,000 人，**20 個人**會覺得「卡住了」然後狂按重試，
> 而那些重試又讓 p99 更差。**平均值會把這件事藏起來。**

### 0.6.3 可用性與降級矩陣

**可用性目標**：每月 **99.9%**（每月最多約 43 分鐘不可用）。
**但更重要的是：哪個依賴掛掉時，哪個功能該怎樣。** 這張表就是驗收 Q8 的完整版：

| 功能 ＼ 誰掛了 | MySQL | Redis | RabbitMQ | 金流 |
|---|---|---|---|---|
| 商品詳情 | 快取命中 → 200（可能是舊資料）；未命中 → 503 | **200**（走 MySQL） | 200 | 200 |
| 搜尋 | 503 | 200 | 200 | 200 |
| 購物車 | 503 | 200 | 200 | 200 |
| 下單（一般商品） | 503 | **201**（限流改用單機記憶體） | **201**（事件堆在 Outbox） | 201 |
| 下單（熱點商品） | 503 | **503** `/problems/temporarily-unavailable` | 201 | 201 |
| 建立付款 | 503 | 201 | 201 | **503** |
| 付款回呼 | 503（金流會重送） | 200 | 200 | —— |
| 我的訂單 | 503 | 200 | 200 | 200 |
| 登入 | 503 | **200，但暫停「失敗 5 次鎖定」**並告警 | 200 | 200 |
| 熱門排行 | 200（Redis 裡有） | **200 空清單** ＋ `X-Degraded: trending` | 200（不更新） | 200 |
| 通知 | —— | —— | **延遲**，恢復後補送 | —— |
| `/actuator/health/readiness` | **DOWN** | **UP** | **UP** | UP |
| `/actuator/health/liveness` | UP | UP | UP | UP |

**三格要特別解釋**：

**「下單（熱點商品）× Redis」= 503**：為什麼不降級走 MySQL？
因為 0.6.1 算過：搶購 600 次/秒 打同一列，MySQL 的上限是 678（理想）到 138（實際）。
**降級到 MySQL 等於把 MySQL 一起拖垮** —— 然後一般商品的下單、所有的查詢、付款回呼全部一起掛。
一個功能 503，好過整站 503。這就是**艙壁**（bulkhead）的思維。

**「登入 × Redis」= 暫停鎖定**：這是一個**安全性與可用性的取捨**，而且兩個選項都不完美：

- 選「Redis 掛了就不能登入」（fail-closed）：安全，但 Redis 掛 60 秒 = 全站無法登入。
- 選「Redis 掛了就不鎖定」（fail-open）：可用，但這 60 秒內暴力破解不會被擋。

本專題選 **fail-open + 告警 + 仍保留 IP 層級的單機限流**。
理由：暴力破解要成功需要遠多於 60 秒的嘗試，而全站無法登入的損失是立即的。**這個理由要寫下來。**

**readiness 只看 MySQL**：這一格直接對應 0.10.5 的事故。
readiness 是「負載平衡器要不要把流量送給我」—— 如果 Redis 掛了會讓 readiness DOWN，
負載平衡器會把**每一台**都摘掉，上面整張表的「降級」全部白寫。

### 0.6.4 一致性要求

不是所有資料都需要強一致。**把每一份資料「可以錯多久」寫下來**，第 06、07 章的設計就是在滿足這張表：

| 資料 | 一致性 | 「最終」是多久 | 違反時的後果 |
|---|---|---|---|
| 下單時的可售庫存判斷 | **強一致**（熱點商品：判斷在 Redis 的閘門、MySQL 的落帳在 commit 之後，第 07 章 7.6） | —— | 超賣；熱點商品 Redis 偏高時：回了 201、落帳時才取消（7.6.3） |
| 訂單狀態 | **強一致**（條件式更新） | —— | 0.2.2 的非法組合 |
| 付款 ⇄ 訂單狀態 | **強一致**（同一個交易） | —— | 錢收了、單沒成立 |
| 退款執行 | 最終一致 | **5 分鐘**內發起、失敗重試 | 客訴 |
| 庫存帳（ledger）落帳 | 最終一致（第 07 章改成事件驅動後） | **60 秒** | 對帳告警 |
| 通知 | 最終一致 | **60 秒**（p99） | 使用者晚一點收到信 |
| 熱門排行 | 最終一致 | **60 秒** | 排行不準 |
| 商品詳情的價格 | 最終一致 | **1 秒** | 法律風險（顯示價 ≠ 結帳價） |
| 商品詳情的可售數量 | 最終一致 | **5 秒** | 體驗差 |
| 搜尋結果（上下架） | 最終一致 | **1 秒** | 已下架的還搜得到 |
| 報表 | 即時查詢 | —— | —— |
| Redis 預扣庫存 ⇄ MySQL | 最終一致 | **對帳每小時**，差異必須為 0 | 超賣或少賣 |

### 0.6.5 安全

| 項目 | 要求 | 對應 |
|---|---|---|
| 密碼 | BCrypt cost 10；長度 8～72 bytes | US-ACC-1 |
| Token | Access JWT 15 分鐘（HS256，金鑰由環境變數提供，**≥ 256 bits**）；Refresh 7 天、rotation、重放偵測 | US-ACC-2 |
| 越權 | 所有「存在但不屬於你」回 **404**；資料層級權限在 **Service 層**檢查（不只在 Controller） | US-ORD-5、第 05 章 |
| 輸入 | 所有請求 DTO 走 Bean Validation；排序欄位白名單；`LIKE` 跳脫 | US-PRD-2 |
| SQL | MyBatis 禁用 `${}`（由測試掃描 mapper XML 檢查） | 第 03 章 |
| 限流 | 登入：每 IP 每分鐘 20 次；下單：每使用者每分鐘 10 次；全域：每 IP 每秒 50 次 | 第 06 章 |
| 錯誤回應 | **不含**堆疊、類別名、SQL、內部 id 格式 | 第 03 章 |
| 秘密 | 金鑰、密碼一律環境變數；**repo 裡沒有任何正式環境的秘密**；`application.yml` 只有本機預設值 | 第 01、09 章 |
| 日誌 | email 遮罩（`g***@example.com`）；**不記**密碼、token、完整 `Authorization` header | 第 09 章 |
| 付款回呼 | HMAC-SHA256 驗簽；金額比對 | US-ORD-2 |

### 0.6.6 可觀測性

**日誌**：JSON 格式，每一行都有 `traceId`；業務日誌帶 `userId`、`orderNo`（有的話）。

**指標**（Micrometer → `/actuator/prometheus`）：

| 指標 | 型別 | 用途 |
|---|---|---|
| `http.server.requests`（依 uri、status） | histogram | SLO（0.6.2） |
| `shop.orders.placed` | counter | 業務量 |
| `shop.orders.cancelled`（依 reason） | counter | 逾時取消率異常上升 = 金流出問題 |
| `shop.inventory.insufficient`（依 productId 前 N 名） | counter | 搶購觀察 |
| `shop.orders.state_conflict`（依 from、event） | counter | 0.5.5 條件式更新影響 0 列的次數 |
| `shop.outbox.pending`、`shop.outbox.oldest_age_seconds` | gauge | 事件是否卡住 |
| `hikaricp.connections.pending` | gauge | 連線池飢餓（[06-repository/01](../06-repository/01-datasource-and-connection-pool.md)） |
| RabbitMQ 佇列深度、DLQ 深度 | gauge | 消費端是否跟上 |
| `shop.reconciliation.diff`（依類型） | gauge | 對帳差異（INV-2、INV-3） |

**告警**（第 09 章實作）：

| 告警 | 條件 | 為什麼 |
|---|---|---|
| 5xx 比例 | > 1%，持續 5 分鐘 | —— |
| 下單 p99 | > 500 ms，持續 5 分鐘 | SLO |
| Outbox 積壓 | `oldest_age_seconds` > 60 | 0.6.4 的「60 秒」被違反 |
| DLQ | 深度 > 0 | **每一則死信都要有人看** |
| 對帳差異 | ≠ 0 | INV-2、INV-3 |
| 付款回呼簽章錯誤 | 任何一次 | 可能是攻擊 |
| 越權嘗試 | 同一使用者 1 分鐘 > 20 次 | US-ORD-5 AC-4 |

### 0.6.7 資料

| 項目 | 規則 | 理由 |
|---|---|---|
| 金額 | Java `BigDecimal`；MySQL `DECIMAL(12,2)`；單一幣別 TWD | `double` 會讓對帳差幾分錢 |
| 時間 | 儲存一律 **UTC**（`DATETIME(3)`）；API 輸出 ISO-8601 帶 `Z`；報表依 **Asia/Taipei** 切日 | US-RPT-1 AC-2 |
| 主鍵 | `BIGINT AUTO_INCREMENT`；**不對外暴露**連續 id 的業務意義（訂單對外用 `orderNo`） | 防止從 id 推算訂單量 |
| 刪除 | 商品、訂單**不硬刪**；使用者停權用狀態欄位 | 訂單明細與稽核需要它們 |
| 保留期限 | `idempotency_keys` 24 小時；`processed_messages` 7 天；`audit_logs` 1 年；`outbox_events`（已送出）3 天 | 定期清理的排程在第 07、09 章 |
| Schema 變更 | **只能**透過 Flyway；`spring.jpa.hibernate.ddl-auto=validate` | 驗收 Q6 |

### 0.6.8 可維護性

| 項目 | 目標 |
|---|---|
| 建置 | `mvn verify` 在筆電上 **< 5 分鐘**（含 Testcontainers 整合測試） |
| 覆蓋率 | 整體行覆蓋 ≥ 70%；`ordering`、`inventory`、`payment` 三個模組 ≥ **85%** |
| 模組邊界 | ArchUnit 測試：模組只能使用對方**根套件**的公開型別，不能碰 `internal` 子套件（第 01 章） |
| API 文件 | OpenAPI 由程式碼產生，CI 檢查「文件與上一版相比有沒有破壞性變更」 |
| 新人上手 | clone 之後 `docker compose up -d --wait && mvn spring-boot:run` **兩個命令**就能跑起來 |

---

## 0.7 刻意不做什麼

**這張表跟需求一樣重要。** 它回答了三個問題：這個專題的邊界在哪、為什麼邊界在這裡、如果有一天要做，會改到哪裡。

| # | 不做 | 為什麼不做 | 如果要做，會影響哪裡 |
|---|---|---|---|
| 1 | **真實金流串接** | 需要商家帳號、測試環境不穩定；本專題的難點是「回呼晚到、重送、驗簽」，模擬器就能完整重現 | `payment` 模組換一個 adapter；回呼與冪等邏輯不變 |
| 2 | **跨賣家自動拆單** | 一次請求產生多個獨立交易結果，部分失敗時的語意是分散式問題 | `ordering` 要引入「結帳單」上層實體；見 [13-distributed-systems/](../13-distributed-systems/) |
| 3 | **退貨 / 換貨（RMA）** | 它是一個跟訂單一樣大的子系統：退貨申請、審核、寄回、驗貨、部分退款 | 新的 `returns` 模組；訂單狀態機加 `RETURN_REQUESTED` 等狀態 |
| 4 | **優惠券、滿額折、促銷計價** | 計價規則引擎會讓 `totalAmount` 的計算變成一個獨立主題 | `OrderItem` 要存折扣分攤；列在 README 的延伸挑戰（第四項） |
| 5 | **多幣別、稅、發票** | 牽涉法規；單一幣別 TWD、含稅價 | 金額欄位要帶幣別；發票是外部系統整合 |
| 6 | **多倉庫、物流串接** | 庫存會從「一個數字」變成「每倉一個數字 + 分配邏輯」 | `inventory` 加 `warehouseId` 維度 |
| 7 | **部分出貨** | 一張訂單分多次出貨，狀態機要變成品項層級 | 狀態從訂單下放到 `OrderItem` |
| 8 | **前端** | 本課程是後端課程；API 以 OpenAPI 文件 + HTTP 測試檔交付 | —— |
| 9 | **全文搜尋引擎（Elasticsearch 等）** | 1 萬個商品用 MySQL 的 `LIKE` 與索引就夠；多一個需要同步的資料來源 = 多一個一致性問題 | `catalog` 發事件同步到搜尋引擎（第 07 章的模式可以直接套用） |
| 10 | **微服務、Kubernetes** | 0.6.1 算過：31 GB、0.2 張/秒（一般）—— 沒有任何量級上的理由要拆 | 見 [13-distributed-systems/](../13-distributed-systems/) |
| 11 | **資料庫高可用、備份還原** | 屬於維運範疇，[07-mysql/07](../07-mysql/07-backup-replication-and-production.md) 已講過 | 第 09 章上線檢查清單會列出來，但不實作 |
| 12 | **社群登入（OAuth2）** | [09-spring-security/06](../09-spring-security/06-oauth2-and-social-login.md) 已講過；對訂單流程沒有影響 | `account` 模組 |
| 13 | **即時推播（WebSocket）** | 通知以寫表 + 日誌模擬；[04-controller/08](../04-controller/08-websocket-and-stomp.md) 已講過 | `notification` 多一個投遞通道 |

> 📌 注意第三欄。「不做」不是「沒想過」—— **每一個不做的東西，你都要知道它如果要做，會改到哪裡。**
> 如果某一項的答案是「會改到所有地方」，那它就不該被列在「不做」，而是應該在一開始就預留設計。
> 本專題刻意檢查過：13 項裡沒有任何一項需要「改到所有地方」。
> 最接近的是第 7 項（部分出貨）—— 它會改狀態機的顆粒度。這就是為什麼它被**明確**排除，而不是「之後再說」。

---

## 0.8 API 草案

需求階段就定下 API 的**形狀**（路徑、方法、角色），細節（欄位、錯誤）在第 03 章用 OpenAPI 定稿。
路徑設計遵循 [03-rest-api/01](../03-rest-api/01-resource-modeling-and-url-design.md)：**以角色分前綴**，讓權限規則可以用路徑表達。

| 方法 | 路徑 | 角色 | 故事 |
|---|---|---|---|
| `POST` | `/api/auth/register` | 公開 | ACC-1 |
| `POST` | `/api/auth/login` | 公開 | ACC-2 |
| `POST` | `/api/auth/refresh` | 公開 | ACC-2 |
| `GET` | `/api/me` | 登入 | —— |
| `GET` | `/api/products` | 公開 | PRD-2 |
| `GET` | `/api/products/{id}` | 公開 | PRD-3 |
| `GET` | `/api/products/trending` | 公開 | RPT-2 |
| `GET` `POST` `PATCH` `DELETE` | `/api/cart/items[/{productId}]` | BUYER | CART-1 |
| `GET` | `/api/cart` | BUYER | CART-2 |
| `POST` | `/api/orders` | BUYER | ORD-1 |
| `GET` | `/api/orders`、`/api/orders/{id}` | BUYER | ORD-5 |
| `POST` | `/api/orders/{id}/cancel` | BUYER | ORD-4 |
| `POST` | `/api/orders/{id}/confirm-receipt` | BUYER | ORD-6 |
| `POST` | `/api/orders/{id}/payments` | BUYER | ORD-2 |
| `POST` | `/api/payments/callback` | 金流（驗簽） | ORD-2 |
| `GET` `POST` `PATCH` | `/api/seller/products[/{id}]` | SELLER | PRD-1、PRD-4 |
| `POST` | `/api/seller/products/{id}/publish`、`/unpublish` | SELLER | PRD-1、PRD-4 |
| `POST` | `/api/seller/products/{id}/restock` | SELLER | PRD-5 |
| `GET` | `/api/seller/orders` | SELLER | ORD-5 |
| `POST` | `/api/seller/orders/{id}/start-picking`、`/ship`、`/cancel` | SELLER | ORD-6 |
| `GET` | `/api/seller/reports/daily-sales`、`/top-products` | SELLER | RPT-1、RPT-2 |
| `POST` | `/api/admin/users/{id}/roles`、`/suspend` | ADMIN | ACC-3 |
| `POST` | `/api/admin/products/{id}/takedown` | ADMIN | —— |
| `GET` | `/api/admin/reports/daily-sales` | ADMIN | RPT-3 |
| `GET` | `/api/admin/audit-logs` | ADMIN | AUD-1 |

> ⚠️ **這是需求階段的草案，跟第 09 章結束時的實作不完全一樣**（對照 `@*Mapping` 整理）：
> - 訂單路徑的 `{id}` 實作是 **`{orderNo}`**（0.6.7：訂單對外只用單號，不暴露自增 id；第 03 章 3.4 起）。
> - **實作多出的**：`POST /api/seller/products/{id}/hot`（標記熱點商品，0.6.1，第 06 章）、`GET /api/admin/dead-letters`、`POST /api/admin/dead-letters/{consumer}/replay`（第 07 章）、`GET /api/ping`（本章 0.10）；3.7.1 的 US-RPT-2 AC-1 多了 `GET /api/admin/reports/top-products`（管理員看全站或指定賣家的排行）。
> - **沒有實作的**：`POST /api/admin/products/{id}/takedown`（第 05 章留給練習）、`GET /api/seller/products/{id}`（單一商品改用公開的 `GET /api/products/{id}`，賣家本人看得到自己的草稿，3.4）、`GET /api/cart/items`（用 `GET /api/cart`）。
> - US-RPT-2 AC-1（`GET /api/seller/reports/top-products`）與 US-RPT-3（`GET /api/admin/reports/daily-sales`）**03～09 章都沒有做**；設計與實測在 3.7.1，補在第 09 章結束時的程式碼上。

> 📌 狀態轉移用 `POST /orders/{id}/cancel` 而不是 `PATCH /orders/{id} {"status": "CANCELLED"}`。
> 後者等於讓客戶端**直接寫狀態欄位** —— 那就是 0.2.2 的版本一。
> 每一個狀態轉移是一個**動作**（action），有自己的權限、自己的前置條件、自己的副作用。
> [03-rest-api/01](../03-rest-api/01-resource-modeling-and-url-design.md) 1.7 的五種手法裡，這是**手法 3（控制器資源）**，不是該章推薦的手法 2（`POST /orders/{id}/cancellations`）。
> 本專題選手法 3 的理由：取消、出貨、確認收貨都**不產生一筆可以被查詢的獨立紀錄資源** —— 紀錄在 `order_status_history`，以訂單為主體查詢。

---

## 0.9 技術選型

### 0.9.1 版本鎖定

| 元件 | 版本 | 為什麼是這個版本 |
|---|---|---|
| Java | **21**（LTS） | 虛擬執行緒、record、pattern matching、sequenced collections；[01-java-core/](../01-java-core/) 的基準版本 |
| Spring Boot | **3.2.5** | 與 10、11 站相同，避免換版本的變數；Jakarta EE 10 |
| MySQL | **8.0**（image `mysql:8.0`） | 與 07、11 站相同 |
| Redis | **7.2**（image `redis:7.2`） | 與 10 站相同 |
| RabbitMQ | **3.13**（image `rabbitmq:3.13-management`） | 與 11 站相同 |
| Flyway | 由 Boot 管理 | [07-mysql/06](../07-mysql/06-schema-migration-flyway.md) |
| Testcontainers | 由 Boot 管理 | 第 08 章 |
| Maven | 3.9 | —— |

> ⚠️ **「與前面各站相同」是刻意的。**
> 如果你在第 06 章遇到一個 Redis 的怪行為，你應該要能直接翻回 [10-redis/](../10-redis/) 找到它 ——
> 換了版本，你就沒辦法確定那是版本差異還是你的 bug。

### 0.9.2 五個關鍵選擇

**① 模組化單體，不是微服務**
0.6.1：31 GB、一般流量 0.2 張/秒。第 01 章會細講，結論只有一句：**沒有任何需求逼你拆。**
但模組邊界要**像要拆一樣**畫清楚（0.3.4），讓「將來真的要拆」的成本降到最低。

**② 寫入走 JPA，報表走 MyBatis**
[08-jpa-mybatis/09](../08-jpa-mybatis/09-choosing-and-mixing-in-practice.md) 的結論在這裡落地：
訂單、庫存的寫入是「載入聚合 → 改狀態 → 存回去」，JPA 的髒檢查與 `@Version` 正好適合；
報表是「一句 150 行的 SQL」，MyBatis 讓你看得到、調得動那句 SQL。
**兩者共用同一個 `DataSource` 與同一個交易管理器**（第 03 章加入 MyBatis 時設定並驗證）。

**③ 主線用 RabbitMQ，不是 Kafka**
[11-messaging/11](../11-messaging/11-choosing-and-mixing.md) 的選型表在這裡的答案：

| 本專題的訊息需求 | RabbitMQ | Kafka |
|---|---|---|
| 通知失敗的**重試階梯**（等 1 秒、5 秒、30 秒再試） | 每一級一個 TTL 佇列 + DLX，宣告就好 | 要自己做 retry topic 與延遲 |
| 通知失敗要**逐則重試、逐則進死信** | 原生 | 要自己做 retry topic |
| 消費端是**任務**（寄信、落帳），不是分析 | ✅ 派工模型 | 可以，但不是它的強項 |
| 需要**重放**三個月的歷史 | ❌ | ✅ |
| 每秒事件數 | 尖峰幾百 | —— |

前三列 RabbitMQ 佔優、第五列兩者都綽綽有餘；唯一 Kafka 贏的是第四列「重放歷史」—— 而本專題的需求裡沒有這一條。
（「逾時未付款」本專題用的是 DB 排程，不是延遲訊息：理由在 US-ORD-3 與第 04 章。）
**README 的延伸挑戰會讓你用 Kafka 再做一次**，那時候你就會有一份「同一個需求、兩個 broker」的對照。

> 📌 注意驗收 Q11 的要求：**broker 相關的程式碼只能出現在一個 adapter 套件裡。**
> 這條需求的目的就是讓「換 broker」變成一件**局部**的事。

**④ 冪等鍵存 MySQL，不存 Redis**
[10-redis/10](../10-redis/10-rate-limit-and-idempotency.md) 教過用 Redis `SET NX` 做冪等。但本專題的下單冪等鍵存在 MySQL 的 `idempotency_keys` 表，理由是 0.3.3 的那一句：
**Redis 的資料丟了必須可以接受。** 如果冪等鍵只在 Redis 裡，Redis 重啟的那一刻，所有「處理中」的下單請求都失去了保護 ——
而且冪等鍵跟訂單**寫在同一個交易裡**，才能保證「訂單成立 ⇔ 冪等鍵存在」。
（限流計數器則放 Redis —— 丟了頂多放行幾個請求。）

**⑤ 平台執行緒，不開虛擬執行緒**
Java 21 有虛擬執行緒，Boot 3.2 也支援 `spring.threads.virtual.enabled=true`。本專題**預設不開**，理由：
0.6.1 的瓶頸是**熱點行鎖**，不是執行緒數；而虛擬執行緒在 `synchronized` 區塊裡會被**釘住**（pinning），
Boot 3.2.5 帶的 MySQL Connector/J 是 **8.3.0**，它的部分路徑仍在用 `synchronized`（9.0 才全面換成 `ReentrantLock`）。
第 04 章的壓測會把這個選項當成一個**實驗變數**開關一次，用數字決定，而不是用直覺。

---

## 0.10 起環境與會走路的骨架

需求寫完了。在寫任何業務程式碼之前，先做一件事：**讓一個什麼功能都沒有的服務，從頭到尾跑通一次。**

這叫做 **walking skeleton**（會走路的骨架）：

```
它要能：編譯 → 啟動 → 連上 MySQL / Redis / RabbitMQ → 回應一個 HTTP 請求 → 回報健康狀態
它不需要：任何一個業務功能
```

為什麼要先做這個？因為**整合問題越晚發現越貴**。
第 04 章寫到一半才發現 RabbitMQ 的帳號連不上、MySQL 的時區設錯 —— 那時候你不知道問題是在你的交易邏輯還是在環境。
先讓骨架走路，後面每一章出問題時，你就**只需要懷疑那一章新加的東西**。

而且接下來你會看到：**光是這個什麼都沒做的骨架，就藏著一個會讓整站下線的設定。**

**開始之前，先確認三個工具的版本**：

```bash
java -version            # 要 21（本專題用 Temurin 21）
mvn -v                   # 要 3.9 以上，而且「Java version」那一行也要是 21
docker compose version   # 要 v2（`docker compose`，不是舊的 `docker-compose`）；0.10.1 的 `--wait` 需要它
```

### 0.10.1 `compose.yaml`

在專案根目錄建 `compose.yaml`：

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
    volumes: [mysql-data:/var/lib/mysql]
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

volumes:
  mysql-data:
  redis-data:
  rabbit-data:
```

**逐項解釋**（每一項都對應到前面某一條需求）：

**MySQL**

| 設定 | 為什麼 | 對應 |
|---|---|---|
| `MYSQL_USER: shop` | 應用程式**不用 root** 連線。第 09 章會進一步收掉 `shop` 對 `inventory_ledger` 的 `UPDATE` / `DELETE` 權限 | INV-5 |
| `--character-set-server=utf8mb4` | 商品名稱會有 emoji 與中文。MySQL 8.0 預設已經是 utf8mb4，**明寫是為了不依賴預設值** | —— |
| `--default-time-zone=+00:00`、`TZ: UTC` | 資料庫的 `NOW()` 與 `CURRENT_TIMESTAMP` 回傳 UTC | 0.6.7 |
| `--transaction-isolation=REPEATABLE-READ` | InnoDB 預設值，同樣是**明寫**。第 04 章的鎖行為分析以它為前提（[07-mysql/04](../07-mysql/04-transaction-isolation-and-lock.md)） | —— |
| `volumes: mysql-data` | 容器刪了資料還在。要清空重來用 `docker compose down -v` | —— |
| healthcheck 用 `-h 127.0.0.1` | **不是 `localhost`**。下面有實測 | —— |

⚠️ **healthcheck 的 `127.0.0.1` 與 `localhost`：一個字的差別，會讓你的應用程式在第一次啟動時連不上資料庫。**

MySQL 官方映像第一次啟動（空的 volume）時，會先起一個**臨時的 MySQL**（`--skip-networking`，只聽 Unix socket）來執行初始化：
建資料庫、建使用者、跑 `/docker-entrypoint-initdb.d/` 裡的腳本。跑完之後，關掉臨時的，再起正式的。

`mysqladmin ping -h localhost` 走的是 **Unix socket** —— 它會在**臨時的那一台**上就回「alive」。
`mysqladmin ping -h 127.0.0.1` 走的是 **TCP** —— 臨時的那一台不聽 TCP，所以要等正式的那一台起來才會成功。

實測（空 volume，healthcheck 每秒一次，`--wait` 回來的**瞬間**用 `shop` 帳號走 TCP 連線）：

```
healthcheck -h localhost : healthy 花了 4s → 立刻用 shop 帳號連線: ERROR 2003 (HY000): Can't connect to MySQL server on '127.0.0.1:3306' (111)
healthcheck -h 127.0.0.1 : healthy 花了 5s → 立刻用 shop 帳號連線: shop 使用者 TCP 連線成功
```

`localhost` 版**早了 1 秒回報 healthy，而那 1 秒裡 TCP 根本連不上。**
在 CI 裡，這會變成「第一次跑整合測試偶爾失敗、重跑就過」—— 最難查的那一種 flaky test。

**Redis**

| 設定 | 為什麼 | 對應 |
|---|---|---|
| `--appendonly yes` | 開 AOF。雖然 0.3.3 說「Redis 的資料丟了可以接受」，但**重啟就全丟**會讓每次重啟都變成一次快取雪崩 | [10-redis/04](../10-redis/04-memory-eviction-and-persistence.md) |
| `--maxmemory 256mb` | 本機環境給一個上限，讓記憶體問題**在本機就會出現** | —— |
| `--maxmemory-policy noeviction` | ⚠️ 記憶體滿了**拒絕寫入**，而不是默默淘汰 | 見下 |

> 📌 **為什麼是 `noeviction` 而不是 `allkeys-lru`？**
> 如果 Redis 只放快取，`allkeys-lru` 是對的 —— 滿了就淘汰最舊的快取。
> 但本專題的 Redis 還放了**限流計數器**、**分散式鎖**、**熱點商品的預扣庫存**。
> 用 `allkeys-lru` 的話，記憶體一滿，Redis 可能**淘汰掉一把正在被持有的鎖**、或**淘汰掉預扣庫存的 key**
> —— 鎖被淘汰，兩個請求會同時進入臨界區；預扣庫存的 key 被淘汰，下一個請求會從 MySQL 重新載入庫存數字，Redis 與 MySQL 的數字就對不上了。
> （第 06 章的設計裡 MySQL 的條件式 UPDATE 仍然擋著，所以這不會變成超賣，而是「多算或少算、要等對帳修正」，6.5.3。）
> `noeviction` 讓記憶體滿變成一個**明確的錯誤**（`OOM command not allowed`），而不是靜默地丟掉這些 key。
> 第 06 章會回來處理「那快取要怎麼淘汰」—— 答案是**除了預扣庫存，每個 key 都有 TTL**（6.3.2）。

**RabbitMQ**

| 設定 | 為什麼 |
|---|---|
| `hostname: rabbit-shop` | RabbitMQ 把資料存在以**節點名稱**（`rabbit@<hostname>`）命名的目錄。不固定 hostname，每次重建容器 hostname 都不同 → **volume 裡的佇列與訊息全部「不見」**（其實還在，只是在另一個節點名的目錄下） |
| `RABBITMQ_DEFAULT_USER/PASS` | 不用人人都知道的 `guest/guest`。RabbitMQ 本身預設讓 `guest` 只能從 localhost 連，但**官方 Docker 映像把這個限制關掉了**（映像裡的 `/etc/rabbitmq/conf.d/10-defaults.conf` 寫著 `loopback_users.guest = false`）—— 不改帳密，任何連得到 5672 的人都能用 guest 登入 |
| `15672` | 管理介面，<http://localhost:15672>，帳密 `shop` / `shop` |

**起來**：

```bash
docker compose up -d --wait
```

`--wait` 會等到**所有服務的 healthcheck 都通過**才回來。這台機器（Apple M2、Docker Desktop）從空 volume 開始：

```
 Container shop-redis-1 Started
 Container shop-rabbitmq-1 Started
 Container shop-mysql-1 Started
 Container shop-redis-1 Waiting
 Container shop-rabbitmq-1 Waiting
 Container shop-mysql-1 Waiting
 Container shop-redis-1 Healthy
 Container shop-rabbitmq-1 Healthy
 Container shop-mysql-1 Healthy
docker compose up -d --wait  0.09s user 0.04s system 1% cpu 11.088 total
```

**11 秒**。確認：

```bash
docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
```

```
SERVICE    IMAGE                      STATUS
mysql      mysql:8.0                  Up 4 minutes (healthy)
rabbitmq   rabbitmq:3.13-management   Up 6 minutes (healthy)
redis      redis:7.2                  Up 4 minutes (healthy)
```

確認 MySQL 的設定真的生效（**不要相信設定檔，要查執行中的值**）：

```bash
docker compose exec mysql mysql -ushop -pshop -N -e \
  "select @@version, @@transaction_isolation, @@innodb_flush_log_at_trx_commit, @@time_zone, @@character_set_server"
```

```
8.0.46	REPEATABLE-READ	1	+00:00	utf8mb4
```

`innodb_flush_log_at_trx_commit = 1` —— 每次 commit 都 fsync redo log。這是 InnoDB 的預設，也是「commit 成功 = 資料不會丟」的前提。
**0.11 量出來的數字，一部分就是被這個 fsync 限制的。** 記住它。

資源用量（閒置時）：

```bash
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'
```

```
shop-rabbitmq-1 0.36% 145.3MiB / 7.653GiB
shop-redis-1 0.24% 9.664MiB / 7.653GiB
shop-mysql-1 1.39% 455.2MiB / 7.653GiB
```

三台加起來約 **610 MB**。筆電 8 GB 以上就跑得動。

### 0.10.2 專案結構（第 00 章版本）

```
shop/
├── compose.yaml
├── pom.xml
└── src/
    ├── main/
    │   ├── java/com/example/shop/
    │   │   ├── ShopApplication.java
    │   │   └── PingController.java
    │   └── resources/
    │       └── application.yml
    └── test/
        └── java/com/example/shop/
            ├── ch00/                          ← 本章的實驗（0.2、0.11）
            │   ├── A1WhenToDeductTest.java
            │   ├── A2FlagsVsStateMachineTest.java
            │   └── A3HotRowCeilingTest.java
            └── acceptance/
                └── CapstoneAcceptanceTest.java   ← 0.12
```

再加一個 `.gitignore`，內容只有一行 `target/` —— 不要把建置產物 commit 進去。

> 📌 這是**第 00 章的版本**，只有兩個類別。第 01 章會把它重組成 0.3.4 的模組結構（`account`、`catalog`、`inventory`……），
> 並加上 ArchUnit 檢查模組邊界。`ch00/` 底下的實驗會一直留著 —— 它們是需求的**證據**。

### 0.10.3 `pom.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.5</version>
    <relativePath/>
  </parent>

  <groupId>com.example</groupId>
  <artifactId>shop</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <name>shop</name>

  <properties>
    <java.version>21</java.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-jdbc</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-redis</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-amqp</artifactId>
    </dependency>
    <dependency>
      <groupId>com.mysql</groupId>
      <artifactId>mysql-connector-j</artifactId>
      <scope>runtime</scope>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
```

**注意這裡刻意沒有的東西**：

| 沒有 | 為什麼 | 哪一章加 |
|---|---|---|
| `spring-boot-starter-data-jpa` | 第 00 章只需要一個 `DataSource`，還沒有任何 Entity；JPA 要跟 Flyway、`ddl-auto: validate` 一起進來才有意義（第 02 章），提早加只是多一組自動組態 | 02 |
| `mybatis-spring-boot-starter` | 同上 | 03 |
| `flyway-core`、`flyway-mysql` | 還沒有遷移腳本 | 02 |
| `spring-boot-starter-security` | 加了之後**所有端點預設要登入**，骨架就測不了了 | 05 |
| `spring-boot-starter-validation` | 還沒有需要驗證的東西 | 01（先用在 `@ConfigurationProperties` 的啟動驗證） |
| Testcontainers | 本章的測試直接連 compose 起的容器 | 08 |

> 📌 **依賴一次只加一點。** 每一個 starter 都會帶進一組自動組態（[02-spring-boot/02](../02-spring-boot/02-auto-configuration-and-starter.md)），
> 一次加十個，出問題時你不知道是哪一個的自動組態在作怪。
> 這一章剛好會示範：光是 `actuator` + `data-redis` 兩個 starter 的**自動組態組合**，就造成了 0.10.5 的事故。

實際解析出來的關鍵版本（`unzip -l target/shop-0.0.1-SNAPSHOT.jar | grep BOOT-INF/lib`）：

```
BOOT-INF/lib/spring-boot-3.2.5.jar
BOOT-INF/lib/HikariCP-5.0.1.jar
BOOT-INF/lib/lettuce-core-6.3.2.RELEASE.jar
BOOT-INF/lib/amqp-client-5.19.0.jar
BOOT-INF/lib/mysql-connector-j-8.3.0.jar
```

### 0.10.4 `application.yml` 與骨架程式

```yaml
spring:
  application:
    name: shop
  datasource:
    url: jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true
    username: shop
    password: shop
    hikari:
      maximum-pool-size: 20
      connection-timeout: 3000
  data:
    redis:
      host: localhost
      port: 6379
      timeout: 500ms
      connect-timeout: 500ms
  rabbitmq:
    host: localhost
    port: 5672
    username: shop
    password: shop

management:
  endpoints:
    web:
      exposure:
        include: health,info
  endpoint:
    health:
      show-details: always
```

| 設定 | 為什麼 |
|---|---|
| `connectionTimeZone=UTC` | JDBC 驅動與資料庫之間用 UTC 轉換 `DATETIME`。不設的話，驅動會用 **JVM 的時區**（你的筆電是 Asia/Taipei），寫進去的時間會差 8 小時 |
| `rewriteBatchedStatements=true` | 讓 JDBC 批次 INSERT 變成一句多值 INSERT。第 02 章塞種子資料時會快 10 倍以上（[06-repository/05](../06-repository/05-transaction-boundary-and-batch.md)） |
| `allowPublicKeyRetrieval=true` | MySQL 8 預設的 `caching_sha2_password` 在非 SSL 連線時需要它。**只用於本機**，正式環境改用 SSL |
| `maximum-pool-size: 20` | 0.6.2 的量測基準。第 04 章會用數字重新決定它（[06-repository/01](../06-repository/01-datasource-and-connection-pool.md)） |
| `connection-timeout: 3000` | 預設 30 秒。拿不到連線時**等 30 秒才失敗**，使用者早就走了；3 秒後失敗至少能回一個 503 |
| `redis.timeout: 500ms` | Lettuce 預設 **60 秒**。Redis 掛掉時每個請求卡 60 秒 = 執行緒池瞬間被吃光（[10-redis/06](../10-redis/06-spring-data-redis-and-lettuce.md) 的三層逾時） |
| `show-details: always` | 本機方便看。**正式環境改成 `when-authorized`**（第 09 章） |

> ⚠️ 上面的帳密是**本機預設值**。0.6.5 的要求：正式環境一律用環境變數覆蓋（`SPRING_DATASOURCE_PASSWORD` 等），
> repo 裡不能有任何正式環境的秘密。

骨架的兩個類別：

```java
package com.example.shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ShopApplication {
    public static void main(String[] args) {
        SpringApplication.run(ShopApplication.class, args);
    }
}
```

```java
package com.example.shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

@RestController
public class PingController {

    @GetMapping("/api/ping")
    public Map<String, Object> ping() {
        return Map.of("service", "shop", "time", Instant.now().toString());
    }
}
```

**跑起來**：

```bash
mvn -q package -DskipTests
java -jar target/shop-0.0.1-SNAPSHOT.jar
```

```
... INFO 39232 --- [shop] [           main] com.example.shop.ShopApplication         : Started ShopApplication in 1.972 seconds (process running for 2.206)
```

```bash
curl -s localhost:8080/api/ping
```

```json
{"service":"shop","time":"2026-09-23T06:49:30.858811Z"}
```

注意 `time` 是 UTC（`Z` 結尾），而上面啟動日誌的時間是 `+08:00` —— 日誌用的是 JVM 時區，API 輸出用的是 `Instant`。
**這兩者不一致是正常的**，但 API 輸出一定要是 UTC（0.6.7）。第 09 章會把日誌也統一成 UTC。

```bash
curl -s -w '\nHTTP %{http_code}\n' localhost:8080/actuator/health
```

```json
{"status":"UP","components":{
  "db":{"status":"UP","details":{"database":"MySQL","validationQuery":"isValid()"}},
  "diskSpace":{"status":"UP","details":{...}},
  "ping":{"status":"UP"},
  "rabbit":{"status":"UP","details":{"version":"3.13.7"}},
  "redis":{"status":"UP","details":{"version":"7.2.16"}}}}
HTTP 200
```

（輸出已排版；`diskSpace` 的細節省略。）

**骨架會走路了**：編譯、啟動（2 秒）、三個依賴全部 `UP`、HTTP 200。

**我們沒有寫任何一行跟 MySQL、Redis、RabbitMQ 有關的程式碼**，但 `/actuator/health` 已經知道它們三個的狀態了。
這是 Actuator 的自動組態：只要 classpath 上有 `spring-boot-starter-data-redis`，就會自動註冊一個 `RedisHealthIndicator`；
有 `spring-boot-starter-amqp`，就註冊 `RabbitHealthIndicator`；有 `DataSource`，就註冊 `DataSourceHealthIndicator`。
然後 `/actuator/health` 把它們**全部聚合**成一個 `status`。

**聚合的規則是：任何一個 DOWN，整體就是 DOWN。**

### 0.10.5 事故四：Redis 停掉，整站 503 ★★★

0.6.3 的降級矩陣寫著：「Redis 掛掉時，商品詳情走 MySQL、一般商品照常下單、readiness 維持 UP。」

現在把 Redis 停掉：

```bash
docker compose stop redis
curl -s -w '\nHTTP %{http_code}  time %{time_total}s\n' localhost:8080/actuator/health
curl -s -w '\nHTTP %{http_code}  time %{time_total}s\n' localhost:8080/api/ping
```

```json
{"status":"DOWN","components":{
  "db":{"status":"UP","details":{"database":"MySQL","validationQuery":"isValid()"}},
  "diskSpace":{"status":"UP","details":{...}},
  "ping":{"status":"UP"},
  "rabbit":{"status":"UP","details":{"version":"3.13.7"}},
  "redis":{"status":"DOWN","details":{"error":"org.springframework.dao.QueryTimeoutException: Redis command timed out"}}}}
HTTP 503  time 0.624553s
```

```json
{"service":"shop","time":"2026-09-23T06:49:41.037885Z"}
HTTP 200  time 0.010156s
```

**停下來看這兩個回應**：

| | `/actuator/health` | `/api/ping` |
|---|---|---|
| HTTP | **503** | 200 |
| 耗時 | **0.62 秒** | 0.01 秒 |
| 意思 | 「這台機器壞了」 | 「這台機器完全正常」 |

**服務本身完全正常，但它對外宣稱自己壞了。**

這在本機上只是一個 503。在任何有負載平衡器的環境裡（Nginx、雲端的 Load Balancer、Kubernetes 的 readiness probe），
健康檢查端點回 503 的意思是「**不要再把流量送給我**」。那接下來會發生的事是：

```
Redis 掛了
  → 每一台應用程式的 /actuator/health 同時回 503（它們連的是同一台 Redis）
  → 負載平衡器把每一台都摘掉
  → 沒有任何一台可以接流量
  → 整站 503
```

**0.6.3 那張降級矩陣裡的每一格「200（走 MySQL）」「201（限流改用單機）」全部白寫了。**
那些降級邏輯根本沒有機會執行 —— 請求在負載平衡器那一層就被擋掉了。

而且注意那個 **0.62 秒**：健康檢查本身也變慢了。Redis 的 `timeout: 500ms` 讓每一次健康檢查都要等 Redis 逾時。
如果你沒設那個 500ms（Lettuce 預設 60 秒），**健康檢查本身會逾時**，負載平衡器一樣判定這台死了。

> 📌 **這不是 Spring Boot 的 bug。** `/actuator/health` 的設計目的是「告訴你所有依賴的狀態」—— 它做得很好。
> 錯的是**把它當成負載平衡器的健康檢查**。
> 它回答的問題是「**一切都好嗎？**」；負載平衡器要問的是「**我可以接流量嗎？**」。這是兩個不同的問題。

### 0.10.6 修正：liveness 與 readiness 分開

Kubernetes 把健康檢查分成兩種（這個概念不限於 Kubernetes，任何負載平衡器都適用）：

| 探針 | 問的問題 | 失敗時的處置 | 應該看哪些依賴 |
|---|---|---|---|
| **liveness** | 「這個行程還活著嗎？要不要重啟它？」 | **重啟**行程 | **都不看**。只看行程自己（死鎖、OOM 前兆） |
| **readiness** | 「這個行程現在能接流量嗎？」 | **暫時摘掉**，不重啟 | 只看「**沒有它就完全無法服務**」的依賴 |

⚠️ **liveness 絕對不能看外部依賴。**
如果 liveness 看 MySQL，MySQL 掛了 → 所有 Pod 被判定「死了」→ 全部重啟 → 重啟後 MySQL 還是掛的 → 再重啟……
**你把一個資料庫故障，變成了一個全站重啟風暴**，而且 MySQL 恢復的那一刻，所有 Pod 同時啟動、同時建連線池 —— 又把 MySQL 打掛。

**哪些依賴放進 readiness？** 回到 0.6.3 的矩陣，看每一欄：

- **MySQL 欄**：幾乎全部 503 → **沒有它就無法服務** → 放進 readiness。
- **Redis 欄**：大部分 200，只有熱點下單 503 → **有降級方案** → **不放**。
- **RabbitMQ 欄**：全部正常（Outbox 會堆積）→ **不放**。

在 `application.yml` 的 `management.endpoint.health` 底下加：

```yaml
management:
  endpoint:
    health:
      show-details: always
      probes:
        enabled: true
      group:
        liveness:
          include: livenessState,ping
        readiness:
          include: readinessState,db
```

| 設定 | 作用 |
|---|---|
| `probes.enabled: true` | 啟用 `/actuator/health/liveness` 與 `/actuator/health/readiness` 兩個端點（在 Kubernetes 環境會自動啟用，本機要手動開） |
| `liveness.include: livenessState,ping` | liveness 只看應用程式自己的狀態 |
| `readiness.include: readinessState,db` | readiness 看應用程式自己 + **只有** MySQL |

`livenessState` 與 `readinessState` 是 Spring Boot 內建的兩個狀態（`ApplicationAvailability`）：
啟動完成前 readiness 是 `REFUSING_TRAFFIC`、收到 SIGTERM 開始優雅關閉時也會變回 `REFUSING_TRAFFIC` ——
這讓負載平衡器在你關機前就先把流量移走（[02-spring-boot/08](../02-spring-boot/08-packaging-docker-and-deployment.md)）。

**重新驗證**：先停掉正在跑的應用程式（Ctrl+C），**重新打包再啟動** —— `application.yml` 是被打進 jar 裡的，只重啟舊的 jar，新的 health group 不會生效，`/actuator/health/liveness` 會回 404：

```bash
mvn -q package -DskipTests && java -jar target/shop-0.0.1-SNAPSHOT.jar
```

然後在另一個終端機，依序讓 Redis、MySQL 故障：

```bash
h(){ for e in health health/liveness health/readiness; do
       printf '%-28s' "/actuator/$e"; curl -s -o /dev/null -w 'HTTP %{http_code}\n' localhost:8080/actuator/$e; done; }

echo "== 全部正常"; h
docker compose stop redis;  echo "== Redis 停掉"; h
docker compose start redis; docker compose stop mysql; echo "== MySQL 停掉"; h
docker compose up -d --wait; echo "== 全部恢復"; h
```

```
== 全部正常
/actuator/health            HTTP 200
/actuator/health/liveness   HTTP 200
/actuator/health/readiness  HTTP 200
== Redis 停掉
/actuator/health            HTTP 503
/actuator/health/liveness   HTTP 200
/actuator/health/readiness  HTTP 200
== MySQL 停掉
/actuator/health            HTTP 503
/actuator/health/liveness   HTTP 200
/actuator/health/readiness  HTTP 503
== 全部恢復
/actuator/health            HTTP 200
/actuator/health/liveness   HTTP 200
/actuator/health/readiness  HTTP 200
```

Redis 停掉時 readiness 的內容：

```json
{"status":"UP","components":{"db":{"status":"UP","details":{"database":"MySQL","validationQuery":"isValid()"}},"readinessState":{"status":"UP"}}}
```

MySQL 停掉時：

```json
{"status":"DOWN","components":{"db":{"status":"DOWN","details":{"error":"org.springframework.jdbc.CannotGetJdbcConnectionException: Failed to obtain JDBC Connection"}},"readinessState":{"status":"UP"}}}
```

**對照 0.6.3 的最後兩列**：

| | MySQL 掛 | Redis 掛 | RabbitMQ 掛 |
|---|---|---|---|
| 需求：readiness | DOWN | UP | UP |
| 實測：readiness | **503** ✅ | **200** ✅ | 200 ✅（未納入群組） |
| 需求：liveness | UP | UP | UP |
| 實測：liveness | **200** ✅ | **200** ✅ | 200 ✅ |

**完整的 `/actuator/health` 仍然回 503** —— 這是對的。它繼續扮演「儀表板」的角色：**告訴人**哪裡壞了。
只是它**不再**被拿去決定要不要接流量。

> 📌 **這個修正是 0.6.3 那張矩陣的第一個「程式碼證據」。** 也是驗收 Q8 的一部分（「readiness 維持 UP」）。
> 但注意，**它只修好了「負載平衡器會不會把你摘掉」**。
> 「Redis 掛了之後，商品詳情是不是真的走 MySQL」「熱點下單是不是真的回 503 而不是 500」—— 那些是第 06 章的事。
> 如果第 06 章沒做好，readiness 是 UP、流量進得來，然後每一個請求都等 500 ms 的 Redis 逾時、再回 500。
> **readiness UP 不代表服務可用，只代表「可以讓請求進來試試看」。**

> ⚠️ **把 RabbitMQ 排除在 readiness 之外，有一個前提**：下單時不直接呼叫 RabbitMQ，而是寫 Outbox 表。
> 如果你在下單交易裡直接 `rabbitTemplate.convertAndSend()`，RabbitMQ 掛掉時下單會失敗 ——
> 那 RabbitMQ 就**是**「沒有它就無法服務」的依賴，readiness 就該看它。
> **readiness 的內容是由你的架構決定的，而不是由你用了哪些 starter 決定的。**
> 這就是為什麼第 07 章的 Outbox 不只是「可靠性」的需求，也是「可用性」的需求。

---

## 0.11 量出天花板：非功能需求的數字從哪裡來

0.6.1 的容量估算和 0.6.2 的 SLO 引用了幾個數字：678、138、3,838、89,334。這一節就是它們的來源。

**為什麼要在需求階段就量？** 因為「下單 p99 < 500 ms，每秒 200 筆，同一個商品」這一條需求，
**如果在你的硬體上物理上就做不到，那它不是需求，是願望。**
在第 04 章寫了三天程式碼之後才發現做不到，代價是三天；現在量，代價是 30 秒。

### 0.11.1 量什麼

四個問題：

1. 一台 MySQL，**所有人都扣同一個商品**的庫存，每秒最多幾次？
2. 同樣的操作**分散在 1,000 個商品**上，每秒幾次？
3. 把「扣庫存」換成**比較像真的下單交易**（扣庫存 + 寫一筆訂單 + commit），上面兩個數字變多少？
4. 如果交易裡**多做 5 毫秒的事**（算運費、呼叫優惠券服務、寫一行太慢的日誌）呢？

以及一個對照組：Redis 對同一個 key 做 `DECR`，每秒幾次？

### 0.11.2 程式

```java
package com.example.shop.ch00;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 0.11 量出天花板：在「寫非功能需求的數字」之前，先量這台機器的上限。
 * 需要 compose.yaml 裡的 MySQL 與 Redis。
 */
class A3HotRowCeilingTest {

    static final int THREADS = 32;
    static final int SECONDS = 5;
    static HikariDataSource ds;

    @BeforeAll
    static void setUp() throws Exception {
        HikariConfig c = new HikariConfig();
        c.setJdbcUrl("jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true");
        c.setUsername("shop");
        c.setPassword("shop");
        c.setMaximumPoolSize(THREADS);
        ds = new HikariDataSource(c);
        try (Connection conn = ds.getConnection(); Statement st = conn.createStatement()) {
            st.execute("DROP TABLE IF EXISTS ch00_stock");
            st.execute("DROP TABLE IF EXISTS ch00_order");
            st.execute("CREATE TABLE ch00_stock (id INT PRIMARY KEY, qty INT NOT NULL)");
            st.execute("""
                CREATE TABLE ch00_order (
                  id BIGINT AUTO_INCREMENT PRIMARY KEY,
                  product_id INT NOT NULL,
                  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))""");
        }
    }

    @AfterAll
    static void tearDown() { ds.close(); }   // ch00_stock、ch00_order 刻意留著：第 02 章導入 Flyway 時會回來處理（2.9.3）

    static void resetStock(int rows) throws Exception {
        try (Connection conn = ds.getConnection(); Statement st = conn.createStatement()) {
            st.execute("TRUNCATE ch00_stock");
            st.execute("TRUNCATE ch00_order");
            StringBuilder sb = new StringBuilder("INSERT INTO ch00_stock VALUES ");
            for (int i = 0; i < rows; i++) sb.append(i == 0 ? "" : ",").append("(").append(i).append(",100000000)");
            st.execute(sb.toString());
        }
    }

    interface Op { void run(int threadNo) throws Exception; }

    /** 固定時間內，THREADS 條執行緒不停做 op，回傳每秒完成數與 p50 / p99 延遲 */
    static String measure(Op op) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        AtomicBoolean stop = new AtomicBoolean();
        List<Future<long[]>> fs = new ArrayList<>();
        for (int t = 0; t < THREADS; t++) {
            int no = t;
            fs.add(pool.submit(() -> {
                long[] lat = new long[2_000_000];
                int n = 0;
                while (!stop.get()) {
                    long s = System.nanoTime();
                    op.run(no);
                    if (n < lat.length) lat[n++] = System.nanoTime() - s;
                }
                return Arrays.copyOf(lat, n);
            }));
        }
        Thread.sleep(SECONDS * 1000L);
        stop.set(true);
        List<Long> all = new ArrayList<>();
        for (Future<long[]> f : fs) for (long v : f.get()) all.add(v);
        pool.shutdown();
        all.sort(null);
        double tps = all.size() / (double) SECONDS;
        double p50 = all.get(all.size() / 2) / 1e6;
        double p99 = all.get((int) (all.size() * 0.99)) / 1e6;
        return "%,9.0f 次/秒   p50 %6.2f ms   p99 %6.2f ms".formatted(tps, p50, p99);
    }

    /** 只有一句 UPDATE（autocommit） */
    static Op updateOnly(int rows) {
        return no -> {
            int id = rows == 1 ? 0 : ThreadLocalRandom.current().nextInt(rows);
            try (Connection c = ds.getConnection();
                 PreparedStatement ps = c.prepareStatement("UPDATE ch00_stock SET qty = qty - 1 WHERE id = ? AND qty > 0")) {
                ps.setInt(1, id);
                ps.executeUpdate();
            }
        };
    }

    /** 比較接近真實的下單交易：扣庫存 + 寫一筆訂單 + commit */
    static Op orderTx(int rows) {
        return no -> {
            int id = rows == 1 ? 0 : ThreadLocalRandom.current().nextInt(rows);
            try (Connection c = ds.getConnection()) {
                c.setAutoCommit(false);
                try (PreparedStatement up = c.prepareStatement("UPDATE ch00_stock SET qty = qty - 1 WHERE id = ? AND qty > 0");
                     PreparedStatement ins = c.prepareStatement("INSERT INTO ch00_order(product_id) VALUES (?)")) {
                    up.setInt(1, id);
                    up.executeUpdate();
                    ins.setInt(1, id);
                    ins.executeUpdate();
                    c.commit();
                } catch (Exception e) {
                    c.rollback();
                    throw e;
                } finally {
                    c.setAutoCommit(true);
                }
            }
        };
    }

    /** 同上，但交易裡多了 5 ms「別的事」（算運費、呼叫優惠券服務……）——鎖被多握了 5 ms */
    static Op orderTxWithSlowStep(int rows) {
        return no -> {
            int id = rows == 1 ? 0 : ThreadLocalRandom.current().nextInt(rows);
            try (Connection c = ds.getConnection()) {
                c.setAutoCommit(false);
                try (PreparedStatement up = c.prepareStatement("UPDATE ch00_stock SET qty = qty - 1 WHERE id = ? AND qty > 0");
                     PreparedStatement ins = c.prepareStatement("INSERT INTO ch00_order(product_id) VALUES (?)")) {
                    up.setInt(1, id);
                    up.executeUpdate();
                    Thread.sleep(5);                     // ← 鎖已經拿在手上了
                    ins.setInt(1, id);
                    ins.executeUpdate();
                    c.commit();
                } catch (Exception e) {
                    c.rollback();
                    throw e;
                } finally {
                    c.setAutoCommit(true);
                }
            }
        };
    }

    @Test
    void ceilings() throws Exception {
        System.out.printf("═══ 0.11 量出天花板（%d 條執行緒、每項 %d 秒）═══%n", THREADS, SECONDS);

        resetStock(1);
        System.out.println("  [MySQL] 單句 UPDATE，全部打同一個商品     : " + measure(updateOnly(1)));
        resetStock(1000);
        System.out.println("  [MySQL] 單句 UPDATE，分散在 1,000 個商品  : " + measure(updateOnly(1000)));

        resetStock(1);
        System.out.println("  [MySQL] 下單交易，全部打同一個商品         : " + measure(orderTx(1)));
        resetStock(1000);
        System.out.println("  [MySQL] 下單交易，分散在 1,000 個商品      : " + measure(orderTx(1000)));

        resetStock(1);
        System.out.println("  [MySQL] 下單交易 +5ms，同一個商品          : " + measure(orderTxWithSlowStep(1)));
        resetStock(1000);
        System.out.println("  [MySQL] 下單交易 +5ms，分散在 1,000 個商品 : " + measure(orderTxWithSlowStep(1000)));

        RedisClient client = RedisClient.create("redis://localhost:6379");
        try (StatefulRedisConnection<String, String> conn = client.connect()) {
            RedisCommands<String, String> r = conn.sync();
            r.set("ch00:stock:0", "100000000");
            System.out.println("  [Redis] DECR，全部打同一個 key            : " + measure(no -> r.decr("ch00:stock:0")));
            r.del("ch00:stock:0");
        } finally {
            client.shutdown();
        }
    }
}
```

幾個設計上的選擇：

- **庫存設成一億**：讓量測期間永遠不會扣到 0。我們量的是「扣的速度」，不是「扣完的行為」（那是第 04 章）。
- **32 條執行緒、連線池 32**：每條執行緒都有自己的連線，排除「等連線池」的干擾，只量「等行鎖」。
- **每項 5 秒**：夠長到跨過 JIT 暖機與 InnoDB buffer pool 暖機，又不會長到讓整個測試跑太久。
- **量延遲分布，不只量吞吐**：0.6.2 要的是 p99。

### 0.11.3 結果

```bash
mvn -q test -Dtest=A3HotRowCeilingTest
```

```
═══ 0.11 量出天花板（32 條執行緒、每項 5 秒）═══
  [MySQL] 單句 UPDATE，全部打同一個商品     :     1,029 次/秒   p50  29.23 ms   p99  73.42 ms
  [MySQL] 單句 UPDATE，分散在 1,000 個商品  :     8,691 次/秒   p50   3.46 ms   p99   8.12 ms
  [MySQL] 下單交易，全部打同一個商品         :       678 次/秒   p50  45.71 ms   p99  70.76 ms
  [MySQL] 下單交易，分散在 1,000 個商品      :     3,838 次/秒   p50   7.61 ms   p99  21.63 ms
  [MySQL] 下單交易 +5ms，同一個商品          :       138 次/秒   p50 242.88 ms   p99 253.72 ms
  [MySQL] 下單交易 +5ms，分散在 1,000 個商品 :     3,043 次/秒   p50  10.14 ms   p99  20.67 ms
  [Redis] DECR，全部打同一個 key            :    89,334 次/秒   p50   0.32 ms   p99   0.93 ms
```

（同一台機器再跑一次，數字在 ±5% 內：例如下單交易同一商品 703、+5ms 137、Redis 86,748。）

### 0.11.4 讀這張表

**第一組對照：同一列 vs 分散（1,029 vs 8,691；678 vs 3,838）**

同樣的 SQL、同樣的執行緒數、同樣的機器，**只因為大家搶同一列，吞吐掉到 1/6～1/8。**

原因是 InnoDB 的**行鎖**：`UPDATE ... WHERE id = 0` 會對 id=0 那一列加排他鎖，**直到交易 commit 才放**。
32 條執行緒搶同一把鎖，一次只有一條能做事，其他 31 條在排隊。
分散在 1,000 列時，32 條執行緒幾乎不會撞在同一列上，瓶頸變成了**磁碟 fsync**（`innodb_flush_log_at_trx_commit = 1`，0.10.1 查過）。

**第二組對照：交易多 5 ms（678 → 138）**

這是整張表**最重要的一行**。

同一列的吞吐上限，可以用一個很簡單的式子估算：

```
同一列每秒最多幾筆  ≈  1 秒 ÷ 每筆交易「持有行鎖」的時間
```

- 下單交易 678 次/秒 → 每筆持有鎖約 **1.47 ms**（UPDATE 之後的 INSERT 往返 + COMMIT 的 fsync）。
- 多了 5 ms → 1.47 + 5 ≈ 6.5 ms → 估算 **154 次/秒**；實測 **138**（`Thread.sleep(5)` 實際睡得比 5 ms 多一點）。

**估算和實測吻合。** 這代表你可以**不用壓測**就預測：交易裡每多 1 ms 的持鎖時間，熱點商品的吞吐會掉多少。

```
持鎖 1.5 ms → ~670 次/秒
持鎖 2   ms → ~500 次/秒
持鎖 5   ms → ~200 次/秒
持鎖 10  ms → ~100 次/秒
持鎖 50  ms →  ~20 次/秒     ← 在交易裡呼叫一個 50 ms 的外部 API
```

而**分散的情況下**，多 5 ms 只讓吞吐從 3,838 掉到 3,043（-21%）—— 因為大家不搶同一把鎖，延遲是平行累加的。
**所以「交易裡多做一點事」在一般情況下幾乎無感，在搶購時是致命的。** 這就是它為什麼一定會活到正式環境。

⚠️ 看 p50：**242.88 ms**。32 條執行緒輪流拿一把每次持有約 7.2 ms 的鎖，**每個請求都要等其他 31 個人各做完一輪** →
32 × 7.2 ms ≈ **232 ms**。同樣的算法套在沒有 +5ms 的那一行：32 × 1.47 ms ≈ 47 ms，實測 p50 45.71 ms —— 也吻合。

```
同一列的 p50 延遲  ≈  並行請求數 × 每筆持鎖時間
```

這只是 32 個並行請求。0.6.1 的搶購是 **2,000 人** —— 就算每筆只持鎖 1.47 ms，排在最後面的人也要等 **約 3 秒**。
**這就是為什麼熱點商品不能靠「讓 MySQL 排隊」解決**，而要在進到 MySQL 之前先用 Redis 把 1,500 個註定失敗的請求擋掉。

**第三組對照：MySQL vs Redis（678 vs 89,334）**

Redis 對同一個 key 的 `DECR` 是 MySQL 同一列的 **130 倍**，p99 不到 1 ms。
原因不是「Redis 在記憶體裡」這麼簡單 —— MySQL 的資料也大多在 buffer pool 裡。真正的差別是：

| | MySQL 同一列 | Redis 同一個 key |
|---|---|---|
| 並行控制 | 行鎖，**持有到 commit** | 單執行緒，**一個命令做完才做下一個**（[10-redis/03](../10-redis/03-single-thread-and-slow-commands.md)），沒有鎖 |
| 每次操作要 fsync 嗎 | 要（commit） | 不要（AOF 預設每秒 fsync 一次） |
| 一次操作幾個網路往返 | UPDATE + INSERT + COMMIT = 3 次 | 1 次 |

⚠️ **最後一格「不要 fsync」就是 Redis 快的代價**：Redis 在 fsync 之前掛掉，最後那 1 秒的 `DECR` 就丟了。
這就是為什麼 0.3.3 說「Redis 的資料丟了必須可以接受」，以及為什麼第 06 章是「Redis 預扣 + **MySQL 落帳** + **對帳**」，而不是「只用 Redis」。

### 0.11.5 把數字回填到需求

| 需求 | 數字 | 從哪一行來 | 結論 |
|---|---|---|---|
| 0.6.1 搶購下單 200～600 次/秒，同一商品 | 需求 | —— | —— |
| MySQL 同一列上限（理想交易） | **678** | 下單交易，同一個商品 | 200 做得到、600 **勉強** |
| MySQL 同一列上限（交易多 5 ms） | **138** | 下單交易 +5ms | **200 做不到** |
| Redis 同一 key 上限 | **89,334** | DECR | 需求的 150 倍 |
| 一般下單 50 rps 分散 | **3,838** | 下單交易，分散 | 綽綽有餘（77 倍） |

**直接得出三條設計約束，寫進第 04 章與第 06 章的前提**：

1. **下單交易的持鎖時間 ≤ 2 ms**（≈ 500 次/秒的上限）。交易裡**只有** SQL，沒有任何外部呼叫、沒有任何 `Thread.sleep`、沒有任何同步寫日誌到遠端。
2. **一般商品走 MySQL 條件式更新就夠了**（3,838 vs 需求 50，77 倍的餘裕）。不要為了「以防萬一」讓所有商品都走 Redis —— 那只會讓一致性問題變多。
3. **熱點商品必須走 Redis 預扣**。MySQL 在理想狀況下勉強接得住 600，但只要有任何一個人在交易裡加了一行慢的程式碼，就會掉到 138。**不能把正確性押在「沒有人會寫慢的程式碼」上。**

> 📌 **你的數字會跟這裡不一樣。**
> 這台是 Apple M2 + Docker Desktop（MySQL 跑在 Linux VM 裡，fsync 要穿過虛擬化層）。
> 在 Linux 實體機 + NVMe 上，同一列的數字可能是 2～3 倍；在雲端的網路磁碟上可能更低。
> **重要的是比例與結構，不是絕對值**：同一列 vs 分散差 5～8 倍、多 5 ms 掉到 1/5、Redis 是 MySQL 的兩個數量級 ——
> 這三個比例在任何機器上都成立。**但你的需求文件上的數字，要用你自己的機器（或更好：正式環境同規格的機器）量。**

---

## 0.12 驗收測試骨架：先把「完成」寫成程式

README 列了 11 題驗收標準。它們現在是文字，這一節把它們變成**程式** ——
一個 11 個測試方法、全部 `@Disabled` 的類別。

**專題的「完成」定義就是：這個類別裡沒有任何一個 `@Disabled`，而且全部綠燈。**

### 0.12.1 `CapstoneAcceptanceTest`

```java
package com.example.shop.acceptance;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * 專題的十一題驗收標準（見 README）。
 * 第 00 章只立下「題目」，每一章把自己負責的那幾題從 @Disabled 變成綠燈。
 * 全部綠燈 = 專題完成。
 */
@Tag("acceptance")
@DisplayName("期末專題驗收")
class CapstoneAcceptanceTest {

    @Test @Disabled("ch04：交易邊界")
    @DisplayName("Q1 一筆訂單的交易邊界：下單失敗時，訂單、明細、庫存異動三張表都沒有殘留")
    void q1_transactionBoundary() {}

    @Test @Disabled("ch04：防超賣")
    @DisplayName("Q2 100 條執行緒搶最後 1 件：恰好 1 筆成立、99 筆收到 409、庫存 = 0")
    void q2_noOversell() {}

    @Test @Disabled("ch04：冪等下單")
    @DisplayName("Q3 同一個 Idempotency-Key 送兩次：只成立一筆，第二次回傳同一張訂單")
    void q3_idempotentPlaceOrder() {}

    @Test @Disabled("ch03 / ch08：N+1")
    @DisplayName("Q4 訂單列表一頁 20 筆：SQL 次數固定，不隨筆數成長")
    void q4_noNPlusOne() {}

    @Test @Disabled("ch05：資料層級權限")
    @DisplayName("Q5 買家 A 讀買家 B 的訂單：回 404（不是 403），且寫入稽核日誌")
    void q5_idorReturns404() {}

    @Test @Disabled("ch02：Flyway")
    @DisplayName("Q6 空資料庫啟動：Flyway 由 V1 跑到最新版，schema 與 entity 一致（ddl-auto=validate 通過）")
    void q6_migrationFromScratch() {}

    @Test @Disabled("ch09：可觀測性")
    @DisplayName("Q7 任一請求的日誌都帶 traceId，且能以 traceId 串起 HTTP → DB → MQ 消費端")
    void q7_traceIdEverywhere() {}

    @Test @Disabled("ch06：降級")
    @DisplayName("Q8 Redis 停止 60 秒：商品詳情仍回 200（走 DB）、熱點商品下單回 503、一般下單回 201、readiness 維持 UP")
    void q8_redisOutageDegrades() {}

    @Test @Disabled("ch07：Outbox")
    @DisplayName("Q9 訂單 commit 後、訊息送出前程序被殺：重啟後訊息仍送出，庫存最終被扣")
    void q9_outboxSurvivesCrash() {}

    @Test @Disabled("ch07：冪等消費")
    @DisplayName("Q10 同一則 OrderPlaced 投遞 10 次：庫存只扣 1 次")
    void q10_idempotentConsumer() {}

    @Test @Disabled("ch07 / ch11 回顧：選型")
    @DisplayName("Q11 broker 相關程式碼只出現在 messaging adapter 套件（ArchUnit 檢查）")
    void q11_brokerIsolated() {}
}
```

**注意每一個 `@DisplayName` 都比 README 的原題更具體。** README 問的是「你怎麼保證不超賣？」，
測試名稱寫的是「**100 條執行緒搶最後 1 件：恰好 1 筆成立、99 筆收到 409、庫存 = 0**」。
這就是 0.4.1 規則一的應用：**把問題改寫成「可以被觀察到的結果」**。

有幾題改寫時**多了東西**，而多出來的都是這一章寫需求時決定的：

| 題 | README 原題 | 測試名稱多了什麼 | 從哪一節來 |
|---|---|---|---|
| Q2 | 「怎麼保證不超賣」 | 「99 筆收到 **409**」—— 不是 500 | US-ORD-1b AC-1 |
| Q5 | 「會發生什麼事」 | 「回 **404**（不是 403），且寫入**稽核日誌**」 | 0.4.1、US-ORD-5 AC-3 |
| Q8 | 「哪些會降級、哪些會失敗」 | 「**熱點**商品下單回 503、**一般**下單回 201、readiness 維持 UP」 | 0.6.3 |
| Q11 | 「換成另一個要改哪些地方」 | 「broker 程式碼只出現在 **adapter 套件**」—— 用 ArchUnit 檢查 | 0.9.2 ③ |

跑一次整個測試套件：

```bash
mvn test
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 36.33 s -- in com.example.shop.ch00.A3HotRowCeilingTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.083 s -- in com.example.shop.ch00.A2FlagsVsStateMachineTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.004 s -- in com.example.shop.ch00.A1WhenToDeductTest
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 11, Time elapsed: 0.003 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[WARNING] Tests run: 14, Failures: 0, Errors: 0, Skipped: 11
[INFO] BUILD SUCCESS
[INFO] Total time:  38.080 s
```

**`Skipped: 11`**。這個數字就是專題的進度條。每一章結束時跑一次，它應該要變小：

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

> 📌 注意 `A3HotRowCeilingTest` 花了 **36 秒**，佔了整個 `mvn test` 的 95%。
> 它是一個**量測**，不是一個**測試**（它沒有任何 assert）。0.6.8 要求 `mvn verify` < 5 分鐘 ——
> 現在還不是問題，但到第 08 章整合測試變多時就會是。練習八會處理它。

> 📌 **為什麼用 `@Disabled` 而不是乾脆不寫？**
> 因為 `@Disabled("ch04：防超賣")` 會出現在每一次的測試報告裡。它是一個**不會被遺忘的 TODO**，而且帶著「誰負責」。
> 一個沒寫的測試，三個月後沒有人會記得它應該存在。

### 0.12.2 追溯表：每一條需求在哪裡被驗證

11 題驗收標準只是「期末考」。0.4 的 101 條 AC 與 0.6 的非功能需求，每一條也都要能指出「在哪裡被驗證」。
這張表會隨著專題進行一直更新，第 00 章先填好**預定**的位置：

| 需求 | 驗證方式 | 預定章節 | 驗收題 |
|---|---|---|---|
| ACC-1 AC-1～4 | MockMvc + 真 MySQL | 05 | —— |
| ACC-2 AC-1～6 | MockMvc；AC-2 用計時斷言 | 05 | —— |
| ACC-3 | MockMvc + `audit_logs` 查詢 | 05 | —— |
| PRD-1～5 | MockMvc | 03 | —— |
| PRD-2 AC-3、AC-4 | 參數化測試（惡意排序欄位、`%` `_`） | 03 | —— |
| PRD-3 AC-3、AC-4 | 快取失效測試（改價後 1 秒內讀取） | 06 | —— |
| CART-1～2 | MockMvc | 03 | —— |
| ORD-1 AC-5 | 故意讓第二個品項不足，檢查第一個沒被預留 | 04 | **Q1** |
| ORD-1a AC-1～6 | 並行送同一個 key（`CountDownLatch`） | 04 | **Q3** |
| ORD-1b AC-1 | 100 執行緒並行 | 04 | **Q2** |
| ORD-1b AC-2 | 壓測程式（擴充自 0.11） | 04、06 | —— |
| ORD-2 AC-3～6 | 回呼簽章 / 金額 / 重送 / 晚到 | 04 | —— |
| ORD-3 AC-3 | 兩個排程實例並行 | 04 | —— |
| ORD-3 AC-5 | 排程與回呼在同一瞬間撞 | 04 | —— |
| ORD-5 AC-2 | Hibernate `Statistics` 計 SQL 次數 | 03、08 | **Q4** |
| ORD-5 AC-3 | 越權請求 + 稽核查詢 | 05 | **Q5** |
| 0.5.3 轉移表 54 格 | `@ParameterizedTest` 54 + 5 組（5 格依情境各測兩種；第 07 章後 60 + 5） | 04 | —— |
| INV-1、INV-4 | DB 約束測試（直接寫非法資料，預期被擋） | 02 | —— |
| INV-2、INV-3 | 對帳 SQL + 對帳排程測試 | 07 | —— |
| INV-5 | 用應用程式帳號執行 `UPDATE inventory_ledger`，預期被拒 | 09 | —— |
| RPT-1 AC-2 | 跨 UTC 午夜的訂單歸屬到正確的台北日期 | 03 | —— |
| RPT-1 AC-4 | 10 萬張訂單的種子資料 + 計時 | 02、03 | —— |
| RPT-2 AC-1 | `TopProductsApiTest`（台北午夜、並列、Top 20、空區間、權限）＋ `TopProductsRankTest` | 09 之後（3.7.1） | —— |
| RPT-3 | `AdminReportApiTest`（全站、指定賣家等於 RPT-1、依賣家分組、參數、權限）＋ `SiteSalesReportTest` | 09 之後（3.7.1） | —— |
| NTF-1 AC-3 | 同一則訊息投遞 10 次 | 07 | **Q10** |
| NTF-1 AC-5 | commit 後 `kill -9`（Testcontainers + 子行程） | 07 | **Q9** |
| 0.6.3 降級矩陣 | 逐格：停掉容器後呼叫 API | 06 | **Q8** |
| 0.6.3 readiness / liveness | 0.10.6 的腳本 → 改寫成整合測試 | 00 ✅、08 | Q8 的一部分 |
| 0.6.5 MyBatis 禁用 `${}` | 掃描 mapper XML 的單元測試 | 03 | —— |
| 0.6.6 traceId | 日誌擷取 + 斷言 | 09 | **Q7** |
| 0.6.7 schema 只由 Flyway 管理 | 空 DB 啟動 + `ddl-auto=validate` | 02 | **Q6** |
| 0.6.8 模組邊界 | ArchUnit | 01 | **Q11**（broker 部分） |
| 0.6.8 覆蓋率 | JaCoCo 門檻 | 08 | —— |

> 📌 **這張表最有價值的時候，是某一列一直填不上的時候。**
> 如果到了第 07 章，「ORD-3 AC-5」那一列還沒有對應的測試，代表那個最難的競態條件**沒有被驗證過** ——
> 它可能是對的，但你不知道。

---

## 0.13 本專題的地圖

### 0.13.1 十章，每一章交付什麼

| 章 | 主題 | 交付物 | 讓哪些需求變綠 |
|---|---|---|---|
| **00** | 需求與範圍 | 本章：需求文件、狀態機、NFR、環境、骨架、驗收骨架 | readiness / liveness（0.10.6） |
| **01** | 架構設計 | 模組套件結構、模組間介面、ArchUnit 規則、設定管理（Profile 與環境變數） | 0.6.8 模組邊界 |
| **02** | 資料庫設計 | ERD、Flyway `V1__...` 起的遷移腳本、索引規劃、約束、10 萬張訂單的種子資料 | INV-1、INV-4、**Q6** |
| **03** | 核心 API | 商品、購物車、訂單查詢、報表（MyBatis）；DTO 與驗證；Problem Details；OpenAPI | PRD、CART、ORD-5、RPT-1、**Q4** |
| **04** | 訂單交易與併發 ★ | `OrderStateMachine`、下單交易、冪等、付款回呼、逾時排程、樂觀 vs 悲觀鎖壓測 | ORD-1～4、ORD-6、54 格轉移表、**Q1～Q3** |
| **05** | 認證與權限 | JWT 登入、refresh rotation、角色與資料層級權限、稽核 | ACC、AUD、ORD-5 AC-3、**Q5** |
| **06** | 快取與熱點庫存 | 商品快取與失效、熱門排行、Redis 預扣 + DB 落帳、分散式鎖、限流、**Redis 拔掉 60 秒演練** | PRD-3、RPT-2 AC-2、0.6.3、**Q8** |
| **07** | 事件驅動訂單流 ★ | Outbox、五個消費者、冪等消費、死信與重放、對帳 | NTF、INV-2、INV-3、**Q9～Q11** |
| **08** | 測試與品質 | Testcontainers（MySQL + Redis + RabbitMQ）、覆蓋率門檻、CI | 0.6.8 |
| **09** | 部署與可觀測性 | Dockerfile、完整 compose、結構化日誌、指標、告警、上線檢查清單 | 0.6.6、INV-5、**Q7** |

### 0.13.2 四個事故在哪裡被解決

| 事故 | 在本章被寫成什麼需求 | 在哪一章被寫成程式 |
|---|---|---|
| 0.2.1 扣庫存時機（退款 33 / 佔住 30） | US-ORD-1 AC-3、US-ORD-2 AC-2、US-ORD-3 AC-1（預留 → 確認 → 釋放） | 04 |
| 0.2.2 三個 boolean（1,951 / 17 / 703） | 0.5 的 6 × 9 轉移表 | 04 |
| 0.10.5 Redis 停掉整站 503 | 0.6.3 降級矩陣 | **00**（readiness）、06（降級行為） |
| 0.11 熱點行 678 → 138 | 0.6.1 結論、0.11.5 三條設計約束 | 04（交易 ≤ 2 ms）、06（熱點走 Redis） |

### 0.13.3 做每一章之前、之後

**之前**：打開 0.12.2 的追溯表，找出這一章負責的列。**先寫測試（或至少先寫測試的名字），再寫程式。**

**之後**：

```bash
docker compose up -d --wait
mvn test
```

（第 08 章起測試改用 Testcontainers 自己起容器，`mvn test` 前面那一行就不需要了；實驗與種子資料仍然連 compose。）

確認 `Skipped` 數字**比上一章少**，而且**沒有任何一個之前綠的變紅**。

---

## 0.14 常見誤區

**① 「需求等寫程式的時候再想就好」**

0.2.1：三個工程師**都照需求寫了**，結果是退款 33 筆、佔住 30 件、剩 2 件三種結局。
**邊寫邊想的結果不是「沒有需求」，而是「需求藏在程式碼裡」** —— 而且三個人各藏了一份不一樣的。

**② 「用 boolean 比較簡單，狀態機是過度設計」**

0.2.2：三個 boolean、每個方法都有檢查 → 1,951 + 17 + 703 個安靜的錯誤。
狀態機多的只是一個 enum 和一張 5 行的表。**而且那張表讓你發現了「撿貨中」這個本來不存在的狀態。**
「簡單」的定義應該是「容易正確」，不是「程式碼行數少」。

**③ 「非功能需求寫『要快』『要穩』就夠了，數字之後再調」**

0.11：同一個商品，**678 → 138**，只差交易裡多了 5 ms。
沒有數字的需求，就沒有辦法判斷「交易裡多呼叫一個優惠券服務」這個改動能不能接受。
**數字不用精確，但要有；而且要有來源。**

**④ 「`/actuator/health` 就是健康檢查」**

0.10.5：Redis 停掉 → `/actuator/health` 503 → 負載平衡器摘掉所有機器 → 整站下線。
**`/actuator/health` 是給人看的儀表板；負載平衡器要看的是 `/actuator/health/readiness`。**

**⑤ 「liveness 也檢查一下資料庫比較保險」**

反了，這是**最危險**的設定。資料庫掛了 → 所有 Pod 被判定「死了」→ 全部重啟 → 重啟後資料庫還是掛的 → 再重啟。
資料庫恢復的那一刻，所有 Pod 同時啟動、同時建連線池 → **又把資料庫打掛**。
**liveness 只回答「這個行程要不要被重啟」，而重啟解決不了外部依賴的問題。**

**⑥ 「冪等就是同一個 key 永遠回同一個結果」**

US-ORD-1a AC-4：**失敗的結果不能快取。** 庫存不足的 409 被快取了，賣家補貨後使用者按一百次都是 409。
**成功要快取、業務失敗不快取、處理中要擋。**

**⑦ 「Redis 比 MySQL 快 130 倍，所以庫存全部放 Redis」**

0.11.5 第 2 條：一般商品在 MySQL 上有 **77 倍**的餘裕。
每多一個「真相的副本」，就多一個一致性問題、多一條對帳規則、多一種故障模式。
**只在數字證明你需要的地方（熱點商品）用 Redis。**

**⑧ 「管理員什麼都能做，比較方便」**

0.3.2：管理員**看得多、改得少**。「什麼都能做」的帳號是最有價值的攻擊目標，
而且當某張訂單的狀態被改壞了，「是系統改的還是管理員改的」會變成一個查不清楚的問題。

**⑨ 「查不到別人的訂單，回 403 比較誠實」**

0.4.1：403 等於確認「這個 id 存在」。攻擊者可以從 1 掃到 1,000,000，數出你有多少張訂單、每天成長多少。
**「存在但不屬於你」與「不存在」必須長得一模一樣。**

**⑩ 「『不做』清單不重要，反正沒做就是沒做」**

0.7：「不做」清單回答的是「**這個專題的邊界在哪、為什麼**」。沒有它，每一次 code review 都會有人問「那退貨呢？」「那優惠券呢？」。
**而第三欄（如果要做會影響哪裡）是在檢查你的設計有沒有把路堵死。**

**⑪ 「平均回應時間 32 ms，很好」**

0.11 單句 UPDATE：p50 29 ms、**p99 73 ms**。平均值把「每 100 人有 1 人等超過 73 ms」藏起來了。
而那 1 個人會狂按重試，讓 p99 更差。**需求寫 p99。**

---

## 0.15 本章小結

**這一章建立了五件事**：

1. **一個認知**（0.2）：**需求寫不清楚，不會讓程式編譯失敗，只會讓系統「照規格」出錯。**
   「下單後扣庫存」三種讀法三種結局；「可以取消」用 boolean 實作產生 2,671 個安靜的錯誤（1,951 + 17 + 703）。
2. **一份可以寫成測試的需求**（0.3～0.8）：23 個使用者故事、101 條驗收條件、5 條不變量、
   一張 6 × 9 的狀態轉移表、一份帶數字的非功能需求、一張 13 項的「不做」清單。
3. **一組有來源的數字**（0.11）：同一列 678 次/秒、多 5 ms 剩 138、分散 3,838、Redis 89,334 ——
   以及從它們推出的三條設計約束（交易 ≤ 2 ms、一般商品走 MySQL、熱點商品走 Redis）。
4. **一套環境與一個會走路的骨架**（0.10）：`docker compose up -d --wait` 11 秒起三個依賴；
   一個什麼功能都沒有、但 readiness / liveness 已經照需求分好的 Spring Boot 服務。
5. **一個進度條**（0.12）：`Skipped: 11`，以及一張追溯表。

**如果這一章只能記一句話**：

> **每一條需求都要能回答「怎麼知道它被做到了」。答不出來的，就還不是需求。**

### 0.15.1 驗收清單

做得到才往下走：

- [ ] `docker compose up -d --wait` 成功，三個服務都是 `(healthy)`。
- [ ] 說得出 MySQL healthcheck 為什麼用 `127.0.0.1` 而不是 `localhost`，以及用錯時會在哪裡出問題。
- [ ] 說得出 Redis 為什麼用 `noeviction`，以及用 `allkeys-lru` 時預扣庫存會怎麼壞。
- [ ] `curl localhost:8080/actuator/health/readiness` 在 Redis 停掉時回 **200**、MySQL 停掉時回 **503**。
- [ ] 說得出 liveness **不能**包含外部依賴的理由（重啟風暴）。
- [ ] 跑完 0.2.1，**不看課文**說出讀法 A、B、C 各自的代價。
- [ ] 跑完 0.2.2，說出三個 boolean 的 8 種組合裡哪幾種合法，以及「撿貨中」為什麼是事故的根因。
- [ ] 畫出 0.5 的狀態機，並回答：`PAID + E1（不同筆）`、`PICKING + E3`、`CANCELLED + E1` 各是什麼結果。
- [ ] 說出為什麼沒有 `REFUNDED` 狀態。
- [ ] 從 0.6.1 的假設，**自己算一次**搶購時的下單 QPS。
- [ ] 說出 0.6.3 裡「熱點商品下單 × Redis 掛」為什麼是 503 而不是降級走 MySQL。
- [ ] 用「同一列每秒最多幾筆 ≈ 1 秒 ÷ 持鎖時間」解釋 678 與 138，並預測持鎖 10 ms 時的數字。
- [ ] 在自己的機器上跑 0.11，記錄你的數字，**把 0.6.2 的 SLO 用你的數字重新檢查一次**。
- [ ] `mvn test` 顯示 `Skipped: 11`。

### 0.15.2 本章練習

**練習一（15 分鐘）：調整 0.2.1 的參數**

把 `ABANDON_RATE` 改成 0.1 與 0.6，把 `PAY_TIMEOUT_MIN` 改成 5 與 30，四種組合各跑一次策略 C。
**畫一張表：放棄率 × 逾時 → 成交、剩餘。**
然後回答：如果你是產品經理，你會選 5 分鐘還是 30 分鐘？**你需要什麼額外的資料才能決定？**
（提示：付款延遲的分布。本模擬假設 1～10 分鐘均勻分布，真實世界不是。）

**練習二（15 分鐘）：讓 0.2.1 的策略 C 遇到晚到的付款**

把 `payDelay` 從 `1 + r.nextInt(10)` 改成 `1 + r.nextInt(20)`，讓一部分付款晚於 15 分鐘的逾時。
在 `PAY` 事件裡處理 `!open[b.id]` 的情況：記一筆「晚到付款，需退款」。
**策略 C 現在有幾筆退款？跟策略 A 的 33 筆比起來如何？** 這個數字就是 US-ORD-2 AC-6 存在的理由。

**練習三（20 分鐘）：擴充 0.2.2 的狀態機**

產品經理提出新需求：「撿貨中的訂單，買家可以**申請**取消，由賣家決定是否同意。」
在 `A2FlagsVsStateMachineTest` 的狀態機版本裡實作它：
你需要新增幾個狀態？幾個事件？0.5.3 的轉移表會多幾格？
**然後回答**：如果賣家一直不回應呢？（你需要再加一個事件。）

**練習四（15 分鐘）：驗證「p50 ≈ 並行數 × 持鎖時間」**

把 0.11 的 `THREADS` 改成 8、16、64（連線池跟著改），只跑「下單交易，全部打同一個商品」。
記錄吞吐與 p50。**吞吐應該大致不變、p50 應該跟執行緒數成正比** —— 你的數字是這樣嗎？
如果 64 條時吞吐反而下降了，想想為什麼（提示：InnoDB 的鎖等待佇列與死鎖偵測也有成本）。

**練習五（10 分鐘）：親手做一次錯誤的 liveness**

把 `liveness.include` 改成 `livenessState,ping,redis`，重新打包並啟動（`mvn -q package -DskipTests && java -jar target/shop-0.0.1-SNAPSHOT.jar`），停掉 Redis。
**`/actuator/health/liveness` 回什麼？** 如果這是 Kubernetes，接下來 30 秒會發生什麼事？
（改回來之前，把你的答案寫在 commit message 裡。）

**練習六（20 分鐘）：寫一條使用者故事**

用 0.4 的格式，為「**賣家改價**」寫一條完整的使用者故事，至少 5 條 AC。必須涵蓋：
改價對**購物車**的影響、對**已成立未付款訂單**的影響、對**商品詳情快取**的影響、**稽核**、以及**改價幅度的上限**（例如一次不能漲超過 50%，為什麼需要這條？）。
**然後把它加進 0.12.2 的追溯表。**

**練習七（進階，30 分鐘）：`SELECT ... FOR UPDATE` 版本**

在 `A3HotRowCeilingTest` 加一個 `orderTxPessimistic`：先 `SELECT qty FROM ch00_stock WHERE id = ? FOR UPDATE`，
在 Java 裡判斷 `qty > 0`，再 `UPDATE ... SET qty = ?`，再 INSERT，再 commit。
**跟 `orderTx`（條件式 UPDATE）比較同一列的吞吐與 p99。** 差多少？差在哪一個往返？
第 04 章會完整比較四種防超賣寫法 —— 這是預習。

**練習八（進階，15 分鐘）：把量測跟測試分開**

`A3HotRowCeilingTest` 佔了 `mvn test` 的 36 秒。給它加上 `@Tag("benchmark")`，
讓預設的 `mvn test` 不跑它，而另一個指令只跑它。

⚠️ 不要直接在 `maven-surefire-plugin` 寫死 `<excludedGroups>benchmark</excludedGroups>`：
Surefire 的 include 與 exclude **同時生效、exclude 優先**，寫死之後 `mvn test -Dgroups=benchmark` 一個測試都跑不到；
命令列的 `-DexcludedGroups` 也蓋不掉 pom 裡寫死的值。用一個屬性當中介：

```xml
<properties>
  <test.excluded>benchmark</test.excluded>
</properties>
...
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-surefire-plugin</artifactId>
  <configuration>
    <excludedGroups>${test.excluded}</excludedGroups>
  </configuration>
</plugin>
```

```bash
mvn test                                          # 不跑 benchmark
mvn test -Dtest.excluded=none -Dgroups=benchmark  # 只跑 benchmark
```

做完之後，0.11.3 的 `mvn -q test -Dtest=A3HotRowCeilingTest` 也要加上 `-Dtest.excluded=none`，否則它會被排除。
（第 02 章會把這個屬性改成 `experiment,seed`，並用 Maven profile 包起來。）
**確認 `mvn test` 的時間從 38 秒降到幾秒。** 第 08 章的 CI 流程會用到這個分法。

---

## 0.16 下一章預告

下一章（01）回答一個問題：**0.3.4 那張模組表，要怎麼變成套件結構，而且讓它「破不了」？**

「模組化單體」最常見的結局是：第一個月模組邊界很清楚，第六個月 `ordering` 直接 `@Autowired` 了 `InventoryRepository`，
第十二個月每個模組都互相依賴，變成一個**有資料夾的大泥球**。

這一章會回答四個問題：

- **分層（`controller` / `service` / `repository`）和模組（`ordering` / `inventory`）要怎麼疊在一起？**
  先切層再切模組，還是先切模組再切層？兩種都會實際建出來，比較「新增一個功能要改幾個資料夾」。
- **模組之間可以互相看到什麼？**
  `ordering` 要扣庫存，它可以呼叫 `inventory` 的什麼？一個 `InventoryService` 介面？一個 `InventoryApi` facade？還是直接發事件？
- **怎麼讓違反邊界的程式碼編譯得過、但 `mvn test` 過不了？**
  用 ArchUnit 寫下 0.3.4 的每一條規則，然後**故意寫一段違規的程式碼**，看它被抓出來的樣子。
- **設定要怎麼管？** 本機、測試、正式環境三套設定；哪些可以進 repo、哪些一定要走環境變數（0.6.5）；
  以及 `@ConfigurationProperties` 怎麼讓一個打錯字的設定在**啟動時**就失敗，而不是在半夜第一次被用到時。

骨架已經會走路了。下一章讓它長出骨頭。
