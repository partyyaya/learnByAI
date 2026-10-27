# 第 04 章：訂單交易與併發：下單、狀態機、冪等與排程

> 第 03 章結束時，系統可以「看」了：商品、購物車、訂單列表、報表。會寫資料的只有購物車和賣家自己的商品 —— 兩者都是**只影響一個人的寫**。
>
> **這一章讓人開始搶。** 下單要在一個交易裡寫 8 張表，還要預留別人也在搶的庫存。
> 同一張訂單會被買家、賣家、金流回呼、排程**同時**改狀態；同一個請求會被重送、被連點。
>
> 這一章結束時，你手上會有：
>
> - **8 支寫入的 API**（4.3.1）：
>   - 買家：下單（帶 `Idempotency-Key`）、建立付款、取消、確認收貨
>   - 賣家：撿貨、出貨、取消
>   - 金流：付款回呼
> - **`OrderStateMachine`**（4.3.4）：0.5.3 的 6 × 9 轉移表變成一個**沒有任何依賴**的類別。表格原封不動貼進測試裡，一格一個測試，共 **61 個**。
> - **驗收 Q1、Q2、Q3 變綠**（4.4.5、4.5.4）：`Skipped` 從 9 變成 6。
> - **兩個排程**：付款逾時取消、出貨 7 天自動完成。**三台同時跑也不會重複處理**，而且不需要分散式鎖（4.7）。
> - **一組打真 HTTP API 的搶購壓測**，以及一個用數字做出的決定：**虛擬執行緒先不開**（4.8）。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 用 4.2.1 的兩組數字，說明四種扣庫存寫法各自錯在哪裡。
  - 「超賣」、「500」、「少賣」分別是哪一種寫法造成的。
  - 為什麼**樂觀鎖在熱點商品上是錯的選擇** —— 它不會超賣，卻會少賣。
- 說出在 `@Transactional` 方法裡接住下層交易方法的例外時，Spring 做了什麼（`rollback-only`），並寫出不會掉進這個洞的下單流程（4.2.2、4.4.1）。
- 說出多品項預留為什麼要先排序，以及「先 UPDATE 父表、再 INSERT 子表」這條規則從哪裡來（4.2.3、4.4.2）。
- 說出 JavaScript 為什麼送不出 `149.00`，以及價格比對、請求指紋（hash）、簽章各自怎麼處理 `BigDecimal` 的 scale（4.2.4、4.4.3、4.6.3）。
- 把 0.5.3 的轉移表寫成一個**純函式**的狀態機，並讓測試**直接讀表格**（4.3.4、4.3.5）。
- 用「條件式 UPDATE + 影響列數 + 查表」處理同一張訂單上的競態（4.6.1）。
  - 說出 REPEATABLE READ 底下的「重讀」為什麼必須是 locking read（4.6.2）。
- 設計一個冪等鍵，同時滿足 US-ORD-1a 的六條 AC（4.5）：
  - **成功要快取、失敗不快取、處理中要擋**；
  - 行程死掉時，靠租約讓這個鍵能被重新執行；
  - 並說出第一版為什麼會死鎖。
- 寫出驗簽、比對金額、以交易編號冪等的付款回呼，並處理「晚到的付款」與「付了兩次錢」（4.6.3）。
- 說出為什麼多台機器同時跑排程，**不需要分散式鎖**（4.7.2）。
- 讀懂一次搶購壓測的結果：p99、連線池等待數、5xx 的來源；並用數字決定要不要開虛擬執行緒（4.8）。
- 讓**驗收 Q1、Q2、Q3** 變綠。

---

## 4.2 先看見痛：併發的 bug 只在「同時」出現

### 4.2.0 實驗環境

本章有七個實驗。它們都標了 `@Tag("experiment")`，`mvn test` 預設不會跑，要用第 02 章的 `experiments` profile 指定：

```bash
mvn test -Pexperiments -Dtest=E1FourWaysToReserveTest
```

| 實驗 | 放在哪裡 | 用什麼 | 量什麼 |
|---|---|---|---|
| E1 四種扣庫存 | `ch04/` | `shop_lab` 的兩張小表（2.2.0）、裸的 `JdbcTemplate` | 只比較「扣庫存」那一步的寫法 |
| E2 接住例外 | `ch04/` + `lab/ch04/` | 完整的 Spring context、**正式的** `InventoryApi` | 呼叫端看到什麼 |
| E3 鎖順序 | `ch04/` | 正式的 schema、與 `reserve()` 一模一樣的 SQL | 死鎖次數、吞吐 |
| E4 價格的 scale | `ch04/` | 啟動整個應用程式 + **真的 Node 22** 當前端 | `equals` vs `compareTo` |
| E5 排程 × 回呼 | `ordering/internal/` | 正式的 `PaymentCallbackService`、`OrderTransitionService` | 300 回合的結局分布 |
| E6 三個排程實例 | `ordering/internal/` | 正式的 `OrderJobs` | 重複取消、重複釋放 |
| E7 搶購壓測 | `ch04/` | 啟動整個應用程式，**打真的 HTTP** | p99、連線池、5xx |

三個細節：

- **E5、E6 放在 `ordering.internal` 套件裡**，因為它們要直接呼叫 package-private 的 `OrderTransitionService`（1.5.3）。
  這是測試碼唯一能「進到模組裡面」的方式，也是 ArchUnit 不檢查測試碼的原因（`ImportOption.DoNotIncludeTests`，1.6.2）。
- **E2～E7 都帶 `shop.order.jobs-enabled=false`**：本章的排程每 30 秒掃一次過期訂單（4.7）。
  實驗建的「剛好過期」的訂單，如果被背景排程搶先處理，結果就不可重現。4.7.1 會解釋這個開關。
- **E1 用自己的小表，不用正式的 `inventory`**：要比較的只有「確認有貨 → 預留」那一步的寫法。
  正式的 `reserve()` 還會寫預留與庫存帳，那些成本會把寫法之間的差異蓋掉。

**跑這些實驗之前**：

- `docker compose up -d`（0.10.1）：MySQL、Redis、RabbitMQ 都要起來。E2～E7 會啟動完整的應用程式，連的是 `application-local.yml` 的 `shop` 資料庫。
- `shop_lab` 資料庫要存在（2.2.0）：E1 會在裡面自己建、自己刪 `e1_inventory` 與 `e1_orders`。
- **E4 需要 Node 22**，而且 `E4PriceScaleTest` 裡的 `node` 路徑是**寫死的**：`System.getProperty("user.home") + "/.nvm/versions/node/v22.21.1/bin/node"` —— 那是寫這一章的機器上 nvm 裝的版本。跑之前改成你自己的路徑（`which node` 查得到）。它用相對路徑找 `src/test/resources/ch04/js-client.mjs`，所以 `mvn` 要在專案根目錄執行。
- 七個實驗類別的完整內容在 4.10.1。正文只列出每個實驗裡「被比較的那幾行」。

### 4.2.1 事故一：四種扣庫存的寫法 ★★★

0.2.1 問過「**什麼時候**扣庫存」（下單預留、付款確認、逾時釋放），那是需求。這一節問的是「**怎麼**扣」，這是併發。

每一種寫法都是同一件事：**一個交易裡「確認有貨 → 預留 1 件 → 寫一筆訂單」**。

```java
/** 每一種寫法：一個交易裡「確認有貨 → 預留 → 寫訂單」 */
static final Map<String, Way> WAYS = new LinkedHashMap<>();
static {
    WAYS.put("① 讀了再寫（reserved = 讀到的值 + 1）", buyer -> run(() -> {
        Map<String, Object> r = jdbc.queryForMap("SELECT on_hand, reserved FROM e1_inventory WHERE product_id = 1");
        int onHand = (Integer) r.get("on_hand"), reserved = (Integer) r.get("reserved");
        if (onHand - reserved < 1) throw new SoldOut();
        jdbc.update("UPDATE e1_inventory SET reserved = ? WHERE product_id = 1", reserved + 1);
    }, buyer));
    WAYS.put("② 讀了再寫（reserved = reserved + 1）", buyer -> run(() -> {
        Map<String, Object> r = jdbc.queryForMap("SELECT on_hand, reserved FROM e1_inventory WHERE product_id = 1");
        if ((Integer) r.get("on_hand") - (Integer) r.get("reserved") < 1) throw new SoldOut();
        jdbc.update("UPDATE e1_inventory SET reserved = reserved + 1 WHERE product_id = 1");
    }, buyer));
    WAYS.put("③ @Version 樂觀鎖，衝突就放棄", buyer -> run(() -> optimistic(), buyer));
    WAYS.put("④ @Version 樂觀鎖，衝突重試（最多 10 次）", buyer -> {
        for (int attempt = 0; attempt < 10; attempt++) {
            Outcome o = run(E1FourWaysToReserveTest::optimistic, buyer);
            if (o != Outcome.ERROR) return o;
        }
        return Outcome.ERROR;
    });
    WAYS.put("⑤ 悲觀鎖 SELECT ... FOR UPDATE", buyer -> run(() -> {
        Map<String, Object> r = jdbc.queryForMap("SELECT on_hand, reserved FROM e1_inventory WHERE product_id = 1 FOR UPDATE");
        if ((Integer) r.get("on_hand") - (Integer) r.get("reserved") < 1) throw new SoldOut();
        jdbc.update("UPDATE e1_inventory SET reserved = reserved + 1 WHERE product_id = 1");
    }, buyer));
    WAYS.put("⑥ 條件式 UPDATE（本專題）", buyer -> run(() -> {
        if (jdbc.update("UPDATE e1_inventory SET reserved = reserved + 1 WHERE product_id = 1 AND on_hand - reserved >= 1") == 0)
            throw new SoldOut();
    }, buyer));
}

static void optimistic() {
    Map<String, Object> r = jdbc.queryForMap("SELECT on_hand, reserved, version FROM e1_inventory WHERE product_id = 1");
    if ((Integer) r.get("on_hand") - (Integer) r.get("reserved") < 1) throw new SoldOut();
    if (jdbc.update("UPDATE e1_inventory SET reserved = reserved + 1, version = version + 1 WHERE product_id = 1 AND version = ?",
            r.get("version")) == 0) throw new Conflict();                 // 等同 JPA 的 ObjectOptimisticLockingFailureException
}
```

第 03 章的預告說「四種寫法」，這裡有六個：① 和 ② 是「讀了再寫」的兩種變體，③ 和 ④ 是樂觀鎖「不重試」與「重試」。**這兩組的差異，正是這一節最重要的發現。**

③ 是 JPA `@Version` 在 SQL 層的樣子：Hibernate 產生的就是 `UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?`。影響 0 列時，Hibernate 丟 `OptimisticLockException`，Spring 再包成 `ObjectOptimisticLockingFailureException`。
這裡直接寫 SQL，是為了讓六種寫法跑在同一個 `JdbcTemplate` 上，差別只剩寫法本身。
[08-jpa-mybatis/06](../08-jpa-mybatis/06-jpa-performance-and-locking.md) 的 6.8 用 JPA 做過同樣的對照（20 個人搶 10 件）；這裡把規模放大到搶購：100 搶 1、2,000 搶 500。

表上有一個 CHECK，跟正式的 `ck_inventory_reserved`（2.5.1）一樣：

```sql
CREATE TABLE e1_inventory (product_id BIGINT PRIMARY KEY, on_hand INT NOT NULL, reserved INT NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 0, CONSTRAINT ck_e1_reserved CHECK (reserved >= 0 AND reserved <= on_hand))
```

`run()` 把每一次下單歸成三種結果：**成立**、**庫存不足**（寫法自己判斷的「沒貨了」），以及**錯誤**（任何其他例外：CHECK 違反、版本衝突、死鎖……）。
**對使用者來說，「錯誤」就是 500 或「請重試」**，不是「已售完」。

```bash
mvn test -Pexperiments -Dtest=E1FourWaysToReserveTest
```

```
═══ 4.2.1 A：100 個買家同時搶最後 1 件（100 條執行緒）═══
  ① 讀了再寫（reserved = 讀到的值 + 1）        成立  100  庫存不足    0  錯誤    0 │ reserved=   1 訂單= 100 │ p50  122.6 ms  p99   199.6 ms │ ✗ 超賣 99 件
  ② 讀了再寫（reserved = reserved + 1）    成立    1  庫存不足    0  錯誤   99 │ reserved=   1 訂單=   1 │ p50   78.2 ms  p99   105.4 ms │ ✓
                                       └ 錯誤 99 次：UncategorizedSQLException：Check constraint 'ck_e1_reserved' is violated.
  ③ @Version 樂觀鎖，衝突就放棄               成立    1  庫存不足    0  錯誤   99 │ reserved=   1 訂單=   1 │ p50   31.7 ms  p99    51.1 ms │ ✓
                                       └ 錯誤 99 次：version 不符（等同 ObjectOptimisticLockingFailureException）
  ④ @Version 樂觀鎖，衝突重試（最多 10 次）       成立    1  庫存不足   99  錯誤    0 │ reserved=   1 訂單=   1 │ p50   48.5 ms  p99    60.3 ms │ ✓
                                       └ 錯誤 99 次：version 不符（等同 ObjectOptimisticLockingFailureException）
  ⑤ 悲觀鎖 SELECT ... FOR UPDATE        成立    1  庫存不足   99  錯誤    0 │ reserved=   1 訂單=   1 │ p50   37.7 ms  p99    65.3 ms │ ✓
  ⑥ 條件式 UPDATE（本專題）                  成立    1  庫存不足   99  錯誤    0 │ reserved=   1 訂單=   1 │ p50   20.3 ms  p99    40.3 ms │ ✓

═══ 4.2.1 B：2,000 個買家搶 500 件（64 條執行緒）═══
  ① 讀了再寫（reserved = 讀到的值 + 1）        成立 2000  庫存不足    0  錯誤    0 │ reserved=  32 訂單=2000 │ p50  108.4 ms  p99   313.1 ms │ ✗ 超賣 1500 件
                                     總耗時 4.09 秒
  ② 讀了再寫（reserved = reserved + 1）    成立  500  庫存不足 1437  錯誤   63 │ reserved= 500 訂單= 500 │ p50    9.2 ms  p99   428.5 ms │ ✓
                                       └ 錯誤 63 次：UncategorizedSQLException：Check constraint 'ck_e1_reserved' is violated.
                                     總耗時 1.62 秒
  ③ @Version 樂觀鎖，衝突就放棄               成立   32  庫存不足    0  錯誤 1968 │ reserved=  32 訂單=  32 │ p50   23.4 ms  p99    52.2 ms │ △ 少賣 468 件
                                       └ 錯誤 1968 次：version 不符（等同 ObjectOptimisticLockingFailureException）
                                     總耗時 0.79 秒
  ④ @Version 樂觀鎖，衝突重試（最多 10 次）       成立  280  庫存不足    0  錯誤 1720 │ reserved= 280 訂單= 280 │ p50  247.9 ms  p99   432.9 ms │ △ 少賣 220 件
                                       └ 錯誤 17347 次：version 不符（等同 ObjectOptimisticLockingFailureException）
                                     總耗時 7.49 秒
  ⑤ 悲觀鎖 SELECT ... FOR UPDATE        成立  500  庫存不足 1500  錯誤    0 │ reserved= 500 訂單= 500 │ p50   20.1 ms  p99  1412.5 ms │ ✓
                                     總耗時 2.85 秒
  ⑥ 條件式 UPDATE（本專題）                  成立  500  庫存不足 1500  錯誤    0 │ reserved= 500 訂單= 500 │ p50   18.7 ms  p99   137.0 ms │ ✓
                                     總耗時 1.20 秒
```

（④ 的「錯誤 17347 次」是**每一次嘗試**的衝突數；最後放棄的買家是 1,720 位。）

**① 讀了再寫（絕對值）：沒有任何錯誤，卻超賣了 1,500 件**

最可怕的一列：**100% 成功**。100 個交易幾乎同時讀到 `reserved = 0`，各自寫回 `0 + 1` —— 後寫的蓋掉先寫的（lost update）。
結果 `reserved = 1`，卻有 100 張訂單。

B 情境更荒謬：2,000 張訂單，**`reserved` 最後是 32**。庫存表說「只有 32 件被預留」，所以前台還在繼續賣。

這個寫法的 bug **不會出現在任何日誌裡**。它只會出現在倉庫：出貨那天，貨不夠。
0.4.3 PRD-5 AC-3 那條「補貨不能覆蓋掉預留」擋的也是同一個 bug，只是換了一個方向。

**② 讀了再寫（相對值）：沒有超賣，但 CHECK 成了唯一的防線**

把 `SET reserved = ?` 改成 `SET reserved = reserved + 1` —— UPDATE 會讀到**最新提交**的值（current read），所以不會 lost update。
但「有沒有貨」是在 `SELECT` 時判斷的，那個值可能已經過時。99 個人判斷「有貨」、執行了 `+1`，然後撞上 `ck_e1_reserved`。

這就是 3.6.1 預告的那個例外：

```
UncategorizedSQLException：Check constraint 'ck_e1_reserved' is violated.
```

它**不是** `DataIntegrityViolationException`（3.6.1）。所以如果 `GlobalExceptionHandler` 沒有特別處理，這 99 個人看到的是 **500「系統發生錯誤」** —— 而正確的答案是 409「已售完」。

> 📌 **CHECK 是最後一道防線，不是業務邏輯。**
> ② 之所以沒有超賣，完全是因為第 02 章加了那個 CHECK。拿掉 CHECK，② 會超賣（`reserved` 跑到 100，大於 `on_hand` 的 1）。
> 一個「正確性依賴資料庫約束擋下來」的寫法，代表你的程式在搶購時會**大量丟 500**。
> 0.4.6 那段 📌 說過：被 CHECK 擋下的 bug 會變成 500，沒被擋下的會變成對帳差異 —— **兩種都是 bug**。

**③ 樂觀鎖、不重試：不會超賣，但會少賣**

A 情境看起來沒問題：1 筆成立，99 筆失敗。但失敗的原因是「版本不符」，不是「沒貨了」。
使用者看到的是「系統忙碌，請重試」—— 然後他們真的會去按重試。

B 情境才是真相：**500 件只賣出 32 件，468 件賣不掉**。
64 條執行緒同時讀到同一個 `version`，只有一個人的 `UPDATE ... WHERE version = ?` 會成功，其他 63 個全部衝突。
下一輪又是 64 個人讀同一個版本……每一輪只成交 1 筆。那 1,968 個「錯誤」**全部是買得到的人**。

驗收 US-ORD-1b AC-2 寫的是「**恰好** 500 筆成立」—— 少賣跟超賣一樣是失敗。

**④ 樂觀鎖、重試 10 次：更慢，而且還是少賣**

重試看起來是 ③ 的解藥。結果：**賣出 280 件、花了 7.49 秒**（⑥ 的 6 倍），17,347 次交易白做，1,720 個買家重試 10 次後還是放棄了。

在熱點上重試只會讓衝突更多：每一次重試都是一次新的「讀 → 寫」，跟其他 63 個重試的人再撞一次。
**樂觀鎖的前提是「衝突很少」**。一個 2,000 人同時搶的商品，是它最不適合的地方。

> 📌 樂觀鎖在本專題不是沒用 —— 它用在**衝突真的很少**的地方：
> 賣家編輯商品（同一個賣家很少同時在兩個分頁改同一個商品），以及 `orders.version` 作為**偵測**（4.6.1：條件式 UPDATE 同時 `version = version + 1`，任何拿著舊版本 Entity 的 JPA 程式碼都會被擋下）。
> **在熱點上，它是錯的工具。**

**⑤ 悲觀鎖與 ⑥ 條件式 UPDATE：兩個都對**

兩者都恰好成立 500 筆、1,500 筆收到「庫存不足」、**0 個錯誤**。

p99 這一欄**不要拿來選贏家**。同一個 B 情境跑了三次：

| 第幾次 | ⑤ `FOR UPDATE` 的 p99 | ⑥ 條件式 UPDATE 的 p99 | ⑤ 總耗時 | ⑥ 總耗時 |
|---|---|---|---|---|
| 1 | 245 ms | 142 ms | 1.59 s | 1.48 s |
| 2 | 124 ms | 279 ms | 1.37 s | 1.50 s |
| 3 | 1,413 ms | 137 ms | 2.85 s | 1.20 s |

64 條執行緒排隊搶同一列的鎖，誰排在隊尾是隨機的，p99 量到的就是隊尾那幾個人。**三次的排名都不一樣。**

本專題選 ⑥，理由不是這張表，而是三件結構上的事：

1. **少一次來回**。⑤ 是 `SELECT ... FOR UPDATE` → 應用程式判斷 → `UPDATE`，鎖從 SELECT 那一刻就拿著，中間隔一次網路來回。
   ⑥ 只有一句 `UPDATE`，判斷在資料庫裡做完。0.11.5 的第一條設計約束是「**持鎖 ≤ 2 ms**」—— 能少一次來回就少一次。
2. **影響列數就是答案**。`update(...) == 0` = 沒貨了。不需要把 `on_hand`、`reserved` 讀回 Java，也就沒有「讀到的值已經過時」的問題。
3. **多品項時一樣簡單**（4.2.3）。每個品項一句條件式 UPDATE，依 productId 排序執行。任何一句影響 0 列 → 丟例外 → 整個交易 rollback。

> 📌 **⑥ 的條件要寫在 `WHERE` 裡，而不是用 CHECK 代替。**
> 把 ⑥ 的條件拿掉，就退化成 ②：一樣不會超賣（有 CHECK），但沒貨時的回應從「影響 0 列 → 409」變成「CHECK 違反 → 500」。
> 兩者在資料庫裡的結果一樣，**在使用者眼中完全不一樣**。

### 4.2.2 事故二：接住了例外，卻變成 500 ★★★

正式的 `InventoryApi.reserve()`（1.5.2）在庫存不足時丟 `InsufficientStockException`，而且標了 `@Transactional(propagation = MANDATORY)` —— 它一定要在呼叫端的交易裡執行。

一個很自然的想法：**「庫存不足」是預期中的結果，不是錯誤。** 不要用例外控制流程，接住它，回傳一個結果物件，讓 Controller 決定要回 201 還是 409：

```java
package com.example.lab.ch04;

/**
 * 4.2.2「好心」的下單：庫存不足時不要丟例外，回一個結果物件讓 Controller 決定怎麼回應 —— 看起來很乾淨。
 * （不是 @Service：由實驗的 @TestConfiguration 註冊，不會出現在正式的 context 裡）
 */
public class FriendlyPlaceOrder {

    public enum Result { PLACED, OUT_OF_STOCK }

    private final JdbcTemplate jdbc;
    private final InventoryApi inventory;

    public FriendlyPlaceOrder(JdbcTemplate jdbc, InventoryApi inventory) {
        this.jdbc = jdbc;
        this.inventory = inventory;
    }

    @Transactional
    public Result place(long orderId, long productId) {
        try {
            inventory.reserve(orderId, List.of(new ReserveLine(productId, 1)));
            return Result.PLACED;
        } catch (InsufficientStockException e) {
            return Result.OUT_OF_STOCK;                        // 接住了，交易「應該」可以正常結束
        }
    }
}
```

實驗用**正式的** `InventoryApi`（就是 `JdbcInventoryService`），先對一個可售 0 的商品呼叫一次，再讓 100 個買家搶最後 1 件：

```bash
mvn test -Pexperiments -Dtest=E2CaughtExceptionRollbackTest
```

```
═══ 4.2.2 在 @Transactional 裡接住「庫存不足」═══
  丟出：org.springframework.transaction.UnexpectedRollbackException
  訊息：Transaction silently rolled back because it has been marked as rollback-only
  ── 100 個買家同時搶最後 1 件 ──
    丟出 UnexpectedRollbackException                99 次
    回傳 PLACED                                      1 次
    reserved = 1，預留列 1 筆
```

`place()` 的 `catch` 確實執行了，也確實 `return Result.OUT_OF_STOCK` 了。但呼叫端**從來沒有拿到這個回傳值**。它拿到的是一個例外。

**發生了什麼**（[05-service/02](../05-service/02-transaction-management-in-depth.md) 講過機制，這裡是它在真實程式碼裡的樣子）：

```
FriendlyPlaceOrder.place()          ← @Transactional（REQUIRED）：開啟交易 T
  └─ JdbcInventoryService.reserve() ← @Transactional（MANDATORY）：加入 T
       └─ throw InsufficientStockException
     ← TransactionInterceptor 看到 RuntimeException 穿過 reserve() 的代理：
       「這個方法參與的交易必須 rollback」—— 但 T 不是它開的，它不能 rollback，
       只能把 T 標記成 rollback-only
  ← catch：return OUT_OF_STOCK
← place() 正常結束：TransactionInterceptor 要 commit T
  → AbstractPlatformTransactionManager 發現 T 已經是 rollback-only
  → rollback，並丟 UnexpectedRollbackException（「你以為會 commit，但我 rollback 了」）
```

**關鍵在 `reserve()` 是一個有交易代理的方法。** 例外穿過代理的那一刻，交易的命運就決定了。之後怎麼接都沒用。

`UnexpectedRollbackException` 不是 `ShopException`，所以 `GlobalExceptionHandler` 把它當成 bug：**500「系統發生錯誤」**。
搶最後 1 件的 100 個人裡，99 個人本來該看到「已售完」，實際看到的是「系統錯誤」—— 這違反了 US-ORD-1b AC-1 的「**0 筆 500**」。

> ⚠️ **反過來更糟。** 如果 `reserve()` **沒有**交易代理（例如它是同一個類別裡的 private 方法，或是有人把 `@Transactional` 拿掉了），`catch` 會「成功」：
> 交易正常 commit —— **連同已經預留成功的前幾個品項**。
> 一張三個品項的訂單，第三個品項不足，前兩個品項的 `reserved` 已經加上去了，卻沒有訂單。**這就是驗收 Q1 在防的殘留。**
> 兩種結局，一個是 500、一個是髒資料。**「在交易裡接住下層的例外、然後繼續」沒有正確的版本。**

**本專題的規則**：

1. **業務失敗用例外往上丟，讓整個交易 rollback。** `InsufficientStockException extends ShopException`（3.4.2），一路穿過 `PlaceOrderService`、Controller，由 `GlobalExceptionHandler` 轉成 **409 `/problems/insufficient-stock`**，body 裡帶是哪個 `productId` 不足（US-ORD-1 AC-5）。
2. **「要不要重試」、「要不要換個方式」這種決定，放在交易的外面。** 4.4.1 的 `PlaceOrderService.placeOrder()` 自己沒有 `@Transactional`。
   它用 `TransactionTemplate` 開交易，撞到訂單編號重複時，在**交易外面**換一個號碼重來一次（4.4.4）。
3. **`noRollbackFor = InsufficientStockException.class` 不是解藥。** 它要加在**參與交易的那一層**（`reserve()` 的 `@Transactional`）才有作用。
   加在 `place()` 上什麼都不會改變：把 T 標成 rollback-only 的是 `reserve()` 的代理，`place()` 的代理根本沒看到這個例外。
   加對了地方，交易就可以 commit —— 但就會 commit 那些已經預留的品項，就是上面的 ⚠️。

### 4.2.3 事故三：兩個品項、相反的順序 ★★

4.2.1 只有一個商品。真實的訂單有好幾個品項，每個品項都是一句條件式 UPDATE，每一句都會鎖住一列 `inventory`，**一直鎖到交易結束**。

兩張訂單同時買 A 和 B：

- 買家甲的購物車是 [A, B]：先鎖 A、再要 B；
- 買家乙的購物車是 [B, A]：先鎖 B、再要 A。

實驗讓 16 條執行緒各自不斷下單，一半的訂單是 [A, B]、另一半是 [B, A]，跑 5 秒。SQL 與正式的 `JdbcInventoryService.reserve()` 一模一樣（UPDATE → INSERT 預留 → INSERT 庫存帳），**唯一的差別是有沒有先排序**：

```java
/** 跟 JdbcInventoryService.reserve() 一模一樣的 SQL；sorted = false 時照傳進來的順序 */
void reserve(long orderId, List<ReserveLine> lines, boolean sorted) {
    List<ReserveLine> ordered = sorted ? lines.stream().sorted(java.util.Comparator.comparingLong(ReserveLine::productId)).toList() : lines;
    for (ReserveLine l : ordered) {
        int n = jdbc.update("UPDATE inventory SET reserved = reserved + ? WHERE product_id = ? AND on_hand - reserved >= ?",
                l.quantity(), l.productId(), l.quantity());
        if (n == 0) throw new IllegalStateException("insufficient");
        jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (?, ?, ?, 'HELD')",
                orderId, l.productId(), l.quantity());
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 0, ?, 'RESERVE', ?)",
                l.productId(), l.quantity(), "order:" + orderId);
        try { Thread.sleep(1); } catch (InterruptedException e) { throw new RuntimeException(e); }   // 兩個品項之間的 1 ms（算運費、寫快照……）
    }
}
```

兩個版本在品項之間**都**停 1 ms。這 1 ms 代表兩個品項之間真的會發生的事：一次網路來回、一次 Hibernate flush、一次運費計算。
沒有它，死鎖會少很多，但不會消失 —— 只是從「每秒幾百次」變成「每天幾次」，**更難重現**。

```bash
mvn test -Pexperiments -Dtest=E3LockOrderDeadlockTest
```

```
═══ 4.2.3 一半的訂單是 [A, B]、另一半是 [B, A]（16 條執行緒 × 5 秒）═══
  照購物車的順序預留     : 成立    832 筆（  166 筆/秒）  死鎖   832 次
  先依 productId 排序   : 成立    773 筆（  155 筆/秒）  死鎖     0 次
```

**每成立一筆，就有一筆死鎖。** 死鎖的那一筆，交易被 InnoDB 挑出來 rollback，Spring 把它包成 `CannotAcquireLockException`（`PessimisticLockingFailureException` 的子類別），`GlobalExceptionHandler` 回 500。
在真實的系統裡，**每兩個買這兩件商品的人，就有一個看到「系統錯誤」**。

InnoDB 自己記下了最後一次死鎖（`SHOW ENGINE INNODB STATUS` 的 `LATEST DETECTED DEADLOCK`，節錄）：

```
*** (1) TRANSACTION:
TRANSACTION 1014494, ACTIVE 0 sec starting index read
LOCK WAIT 5 lock struct(s), heap size 1128, 2 row lock(s), undo log entries 3
UPDATE inventory SET reserved = reserved + 1 WHERE product_id = 900602 AND on_hand - reserved >= 1

*** (1) HOLDS THE LOCK(S):
RECORD LOCKS ... index PRIMARY of table `shop`.`inventory` trx id 1014494 lock_mode X locks rec but not gap
 0: len 8; hex 80000000000dbdf9; asc         ;;          ← 0xdbdf9 = 900601（A）

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS ... index PRIMARY of table `shop`.`inventory` trx id 1014494 lock_mode X locks rec but not gap waiting
 0: len 8; hex 80000000000dbdfa; asc         ;;          ← 0xdbdfa = 900602（B）

*** (2) TRANSACTION:
TRANSACTION 1014496, ACTIVE 0 sec starting index read
LOCK WAIT 5 lock struct(s), heap size 1128, 2 row lock(s), undo log entries 3
UPDATE inventory SET reserved = reserved + 1 WHERE product_id = 900601 AND on_hand - reserved >= 1

*** (2) HOLDS THE LOCK(S):        ... hex 80000000000dbdfa  ← B
*** (2) WAITING FOR THIS LOCK ...  ... hex 80000000000dbdf9  ← A

*** WE ROLL BACK TRANSACTION (2)
```

讀法：

- 交易 (1) 拿著 A、等 B；交易 (2) 拿著 B、等 A。一個完美的環。
- `undo log entries 3`：兩個交易都已經做完第一個品項的三句寫入（UPDATE、兩句 INSERT）。InnoDB 選 undo 量比較小的那個 rollback —— 這裡兩個一樣大，選了 (2)。
- `lock_mode X locks rec but not gap`：主鍵上的等值 UPDATE 只鎖那一列、不鎖間隙（[07-mysql/04](../07-mysql/04-transaction-isolation-and-lock.md)）。死鎖跟間隙鎖無關，純粹是順序。

**修正只有一行**：在加任何鎖之前，先依 `productId` 排序。所有交易都「先 A 後 B」，就不可能有人拿著 B 等 A。

> 📌 **排序沒有讓它變快，只讓它不失敗。** 兩個版本的吞吐幾乎一樣（166 vs 155 筆/秒，另外兩次是 153 vs 164、166 vs 156）。
> 這很合理：兩個版本都在搶同樣兩列的鎖，排隊的長度一樣。差別只在「沒排序」的那一半人排到最後被踢出去。

這條規則的另一半，是第 02 章 2.6.2 的「**先 UPDATE 父表、再 INSERT 子表**」：`inventory_reservations` 有指向 `inventory` 的外鍵（同一個模組，允許外鍵），
INSERT 子表時 InnoDB 會對父表那一列加 **S 鎖**。如果先 INSERT 子表、再 UPDATE 父表，兩個交易會各自拿著 S 鎖、各自等對方放掉去升級成 X —— 2.6.2 量過，那是另一種死鎖。
正式的 `reserve()` 兩條規則都遵守（4.4.2）。

### 4.2.4 事故四：前端送來的 `149` ★★

US-ORD-1 AC-6：客戶端要帶「**它看到的單價**」，後端拿去跟資料庫的價格比，不一樣就回 409 `/problems/price-changed`。
3.5.2 預告過 `299` 與 `299.00` 是兩個不相等的 `BigDecimal`。這一節量一次，如果比錯了會怎樣。

實驗寫了一個「前端」—— 12 行的 JavaScript，做的事跟瀏覽器裡的前端一模一樣：拿商品詳情，把價格放進下單請求。

```javascript
// 4.2.4 一個「前端」：拿商品詳情 API 回來的價格，組成下單請求 —— 就像瀏覽器裡的 JavaScript 會做的那樣。
// 用法：node js-client.mjs <baseUrl> <productId...>
const [base, ...ids] = process.argv.slice(2);
for (const id of ids) {
  const res = await fetch(`${base}/api/products/${id}`);
  const product = await res.json();                              // JSON.parse：149.00 → 149（JavaScript 只有一種數字）
  const body = { items: [{ productId: product.id, quantity: 1, unitPrice: product.price }] };
  console.log(JSON.stringify(body));                             // JSON.stringify：送出去的是 "unitPrice":149
}
```

測試啟動整個應用程式，讓 Node 22 對 500 個上架商品各跑一次，再用 Jackson 把 Node 印出的請求讀成 `BigDecimal`（跟 Spring MVC 讀 `@RequestBody` 的方式一樣），跟資料庫的價格比：

```bash
mvn test -Pexperiments -Dtest=E4PriceScaleTest
```

```
═══ 4.2.4 JavaScript 前端送來的價格 vs 資料庫的價格（500 個上架商品）═══
  前 3 個請求：
    {"items":[{"productId":1,"quantity":1,"unitPrice":149}]}
    {"items":[{"productId":3,"quantity":1,"unitPrice":99}]}
    {"items":[{"productId":5,"quantity":1,"unitPrice":1290}]}
  資料庫裡的價格：[149.00, 99.00, 1290.00]
  送來的單價的 scale 分布：{scale 0=443, scale 1=57}
  用 equals 比較   → 500 / 500 個被判定「價格已變動」
  用 compareTo 比較 → 0 / 500 個被判定「價格已變動」
```

**`equals` 比較：500 個商品，全部「價格已變動」。** 這不是「偶爾會錯」—— 是一個前端也下不了單。

發生了什麼：

1. 商品詳情 API 回傳 `"price":149.00`。Jackson 寫 `BigDecimal` 時保留 scale，這在 JSON 裡是合法的數字。
2. JavaScript 只有一種數字型別（IEEE 754 double）。`JSON.parse` 把 `149.00` 變成 `149`，**scale 資訊在這一步就消失了**。
3. `JSON.stringify(149)` 送出去的是 `149`；`1290.50` 送出去的是 `1290.5`（那 57 個 scale 1 的就是這種價格）。
4. 後端 Jackson 把 `149` 讀成 `BigDecimal("149")`，scale 0。資料庫的 `DECIMAL(12,2)` 讀出來是 `149.00`，scale 2。
5. `BigDecimal.equals` **同時比較數值與 scale**：`new BigDecimal("149").equals(new BigDecimal("149.00"))` 是 `false`。`compareTo` 只比數值：`0`。

你用 Postman 或 `curl` 測，**永遠測不到這個 bug** —— 因為你手打的 JSON 會照抄 `149.00`。它只在真的前端出現。

**本專題的處理**：同一個 `BigDecimal`，三個地方有三種不同的需求。

| 用途 | 在哪裡 | 做法 | 為什麼 |
|---|---|---|---|
| 比對價格有沒有變 | `PlaceOrderService`（4.4.3） | `compareTo(...) != 0` | 只關心數值 |
| 請求的「指紋」（冪等鍵比對內容） | `PlaceOrderService.hash()`（4.4.3） | `stripTrailingZeros().toPlainString()` | `149` 與 `149.00` 必須是同一個請求（驗收 Q3 會送這兩種寫法） |
| 金流回呼的簽章 | `CallbackSignature.canonical()`（4.6.3） | `setScale(2, RoundingMode.UNNECESSARY)` | 雙方要簽出**同一個字串**，格式是跟金流約好的 |

> 📌 **另一條路：API 的金額一律用字串**（`"price":"149.00"`）。很多金流、會計系統這樣做，因為它讓 scale 能穿過 JavaScript。
> 本專題**不**這樣做：第 03 章的 API（以及它的 OpenAPI 快照，3.8.2）已經用數字，而且前端要拿價格做運算（小計、折扣）。
> 用字串的話，每個前端都要自己引入十進位函式庫；用數字的話，後端要記得 `compareTo`。**後者只需要記得一次。**

### 4.2.5 事故五：排程與回呼在同一毫秒 ★★★

US-ORD-3 AC-5，0.4.5 說它是「整個專題最難的一條 AC」：**付款逾時的排程**與**金流的付款成功回呼**，同時打到同一張訂單。

情境：一張訂單的付款期限剛好到了。買家在最後一秒按了付款，金流的「成功」回呼**跟**排程的「逾時取消」同時到達。

先寫一個「天真」的版本，兩邊都是「先讀狀態，是待付款才動手」：

```java
// ───────── 天真的版本：先讀狀態，再決定要不要寫（不帶條件的 UPDATE） ─────────
void naivePay(Setup s) {
    tx.executeWithoutResult(t -> {
        jdbc.update("UPDATE payments SET status = 'SUCCEEDED', provider_txn_id = ? WHERE id = ?", "tx-" + s.paymentId(), s.paymentId());
        String status = jdbc.queryForObject("SELECT status FROM orders WHERE id = ?", String.class, s.orderId());
        if (status.equals("PENDING_PAYMENT")) {
            jdbc.update("UPDATE orders SET status = 'PAID', paid_at = NOW(3), cancel_reason = NULL WHERE id = ?", s.orderId());
            jdbc.update("UPDATE inventory_reservations SET status = 'CONFIRMED' WHERE order_id = ? AND status = 'HELD'", s.orderId());
        } else if (status.equals("CANCELLED")) {
            jdbc.update("INSERT INTO refunds (payment_id, order_id, amount, reason) VALUES (?, ?, 100, 'LATE_PAYMENT')", s.paymentId(), s.orderId());
        }
    });
}

void naiveTimeout(Setup s) {
    tx.executeWithoutResult(t -> {
        String status = jdbc.queryForObject("SELECT status FROM orders WHERE id = ?", String.class, s.orderId());
        if (status.equals("PENDING_PAYMENT")) {
            jdbc.update("UPDATE orders SET status = 'CANCELLED', cancel_reason = 'PAYMENT_TIMEOUT', cancelled_at = NOW(3) WHERE id = ?", s.orderId());
            jdbc.update("UPDATE inventory SET reserved = reserved - 1 WHERE product_id = ?", PRODUCT);
            jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED' WHERE order_id = ?", s.orderId());
        }
    });
}
```

它看起來甚至考慮得很周到：回呼時如果訂單已經取消，就建一筆退款（0.5.3 的 `CANCELLED + E1 = ↺`）。

每一回合建一張「剛好過期、還沒付款」的訂單（1 個品項、1 筆 `HELD` 預留、1 筆 `PENDING` 付款），兩條執行緒用 `CountDownLatch` 同時出發，跑 300 回合，最後把每一張訂單的樣子歸類：

```java
/** 每一張訂單最後的樣子，歸類成「一致」或某一種不一致 */
String classify(long orderId) {
    Map<String, Object> o = jdbc.queryForMap("""
            SELECT o.status, r.status AS reservation, p.status AS payment,
                   (SELECT COUNT(*) FROM refunds f WHERE f.order_id = o.id) AS refunds
              FROM orders o JOIN inventory_reservations r ON r.order_id = o.id JOIN payments p ON p.order_id = o.id
             WHERE o.id = ?""", orderId);
    String key = o.get("status") + " / 預留 " + o.get("reservation") + " / 付款 " + o.get("payment") + " / 退款 " + o.get("refunds");
    boolean ok = key.equals("PAID / 預留 CONFIRMED / 付款 SUCCEEDED / 退款 0")
              || key.equals("CANCELLED / 預留 RELEASED / 付款 SUCCEEDED / 退款 1");
    return (ok ? "✓ " : "✗ ") + key;
}
```

**合法的結局只有兩種**（US-ORD-3 AC-5）：要嘛回呼贏了（`PAID`、預留 `CONFIRMED`），要嘛排程贏了（`CANCELLED`、預留 `RELEASED`、**錢收了所以要退款**）。

```bash
mvn test -Pexperiments -Dtest=E5TimeoutVsPaymentRaceTest
```

```
═══ 4.2.5 付款逾時排程 × 付款成功回呼，同一瞬間 ═══
── 天真的版本：先 SELECT 狀態，再 UPDATE（300 回合）──
  ✗ CANCELLED / 預留 RELEASED / 付款 SUCCEEDED / 退款 0                 4 張
  ✗ PAID / 預留 RELEASED / 付款 SUCCEEDED / 退款 0                    296 張
  例外 0 次；INV-2：reserved = 0、Σ 有效預留 = 0

── 本專題：條件式 UPDATE + 狀態機（300 回合）──
  ✓ CANCELLED / 預留 RELEASED / 付款 SUCCEEDED / 退款 1               300 張
  例外 0 次；INV-2：reserved = 0、Σ 有效預留 = 0
```

**天真的版本：300 張訂單，300 張都是錯的。0 個例外。**

**`PAID / 預留 RELEASED`（296 張）**：兩邊都讀到 `PENDING_PAYMENT`。排程先 commit：訂單取消、`reserved - 1`、預留釋放。
回呼接著執行它的 `UPDATE orders SET status = 'PAID' WHERE id = ?` —— **沒有條件**，直接把 `CANCELLED` 蓋成 `PAID`。
然後 `UPDATE ... SET status = 'CONFIRMED' WHERE status = 'HELD'` 影響 0 列（已經是 `RELEASED`），**沒有人檢查影響列數**。

結果是一張「已付款」的訂單，**它的那件貨已經放回可售庫存了**。那件貨會被下一個人買走。出貨那天，兩張訂單搶一件貨。

**`CANCELLED / 退款 0`（4 張）**：反過來，回呼先 commit 成 `PAID`，排程在回呼 commit **之前**就已經讀到了 `PENDING_PAYMENT`，接著無條件把 `PAID` 蓋成 `CANCELLED`。
**錢收了、訂單取消了、沒有退款。** 這是客訴，在某些地方是違法的。

> ⚠️ **最危險的是最後一行：`INV-2：reserved = 0、Σ 有效預留 = 0`。**
> 0.4.6 的 INV-2 對帳（`reserved` = Σ `HELD` + `CONFIRMED`）**完全正常**。庫存模組自己的帳是平的 —— 釋放時 `reserved` 減了 1，預留也標成 `RELEASED`，兩邊一致。
> 壞掉的是**訂單與預留之間**的關係（「`PAID` 的訂單，預留一定是 `CONFIRMED`」），而那條規則不在任何一張表的對帳裡。
> **每小時的對帳一張都看不出來。** 它會在出貨時被發現，或者在客服電話裡。

「本專題」那一段是 4.6 寫出來的版本：300 回合全部合法（這一次全部是排程贏；另一次跑的結果是 299 張排程贏、1 張回呼贏 —— 兩種都合法）。

但它**不是第一次就對的**。第一版的「本專題」跑出來是這樣：

```
── 本專題：條件式 UPDATE + 狀態機（300 回合）──
  第一個例外：com.example.shop.shared.error.ShopException: 訂單狀態正在變動，請稍後再試
  ✗ CANCELLED / 預留 RELEASED / 付款 PENDING / 退款 0                 300 張
  例外 300 次；INV-2：reserved = 0、Σ 有效預留 = 0
```

**300 個付款回呼全部失敗。** 訂單的結局是對的（排程贏了），但錢的紀錄不見了：付款還是 `PENDING`、沒有退款。
回呼收到 409，金流會重送 —— 重送的那一次會成功，所以這個 bug 在真實環境裡**會自己好**，然後永遠不會被發現。
原因是 REPEATABLE READ 的快照，4.6.2 會完整拆解。

---

## 4.3 本章的形狀

### 4.3.1 8 支寫入的 API

| 方法 | 路徑 | 角色 | 故事 | 成功時 |
|---|---|---|---|---|
| `POST` | `/api/orders`（header `Idempotency-Key`） | BUYER | ORD-1、1a、1b | **201**；同一個鍵重送 → **200** 與同一張訂單 |
| `POST` | `/api/orders/{orderNo}/payments` | BUYER | ORD-2 AC-1 | 201，回傳模擬金流的付款頁 |
| `POST` | `/api/payments/callback` | 金流（HMAC 簽章） | ORD-2 | 200 `{"status":"received"}` |
| `POST` | `/api/orders/{orderNo}/cancel` | BUYER | ORD-4 | 200，回傳訂單 |
| `POST` | `/api/orders/{orderNo}/confirm-receipt` | BUYER | ORD-6 AC-3 | 200 |
| `POST` | `/api/seller/orders/{orderNo}/start-picking` | SELLER | ORD-6 AC-1 | 200 |
| `POST` | `/api/seller/orders/{orderNo}/ship` | SELLER | ORD-6 AC-2 | 200 |
| `POST` | `/api/seller/orders/{orderNo}/cancel` | SELLER | ORD-6 AC-5 | 200 |

幾個跟第 03 章一致的決定：

- **每個狀態轉移是一個動作**（0.8 的 📌）：沒有 `PATCH /orders/{orderNo} {"status": ...}`。客戶端表達的是意圖（「取消」），不是結果（「狀態 = CANCELLED」）。
- **角色在 interceptor 檢查**（3.4.4）：`/api/orders/**` 要 BUYER、`/api/seller/**` 要 SELLER。
  `/api/payments/callback` 不在任何一條規則裡 —— 它沒有使用者，**靠簽章證明身分**（4.6.3）。
- **別人的訂單一律 404**（US-ORD-4 AC-5）：「找訂單」一律是 `WHERE order_no = ? AND buyer_id = ?`（或 `seller_id`），找不到就是 404，不區分「不存在」與「不是你的」。
- **路徑用 `orderNo`**（3.3.1 的 📌）。

`OpenApiContractTest`（3.8.2）在第一次跑的時候紅了，並列出了 8 個新的 operation —— **這正是它存在的目的**：

```
  △ 新增 POST /api/orders
  △ 新增 POST /api/orders/{orderNo}/cancel
  △ 新增 POST /api/orders/{orderNo}/confirm-receipt
  △ 新增 POST /api/orders/{orderNo}/payments
  △ 新增 POST /api/payments/callback
  △ 新增 POST /api/seller/orders/{orderNo}/cancel
  △ 新增 POST /api/seller/orders/{orderNo}/ship
  △ 新增 POST /api/seller/orders/{orderNo}/start-picking
```

確認這 8 個都是刻意的之後，用 `-Dopenapi.update=true` 更新快照（3.8.2），快照的 diff 跟著這一章的 PR 一起被 review。

### 4.3.2 模組之間：四個新的公開介面

下單是第一個**橫跨五個模組**的操作。0.3.4 的依賴表早就寫了 `ordering` 會呼叫 `cart`、`catalog`、`inventory`、`payment`，1.6.2 也已經把它寫進 `ModuleBoundaryTest`，所以這一章不用改規則。
要改的是這幾個模組的**公開介面** —— 它們是 `ordering` 唯一看得到的東西（1.5）：

```java
package com.example.shop.cart;

/** 購物車模組的對外入口（給 ordering 用）。 */
public interface CartApi {

    /** US-ORD-1 AC-4：下單成功的品項從購物車移除。在呼叫端的交易裡執行 —— 下單失敗，購物車不變。 */
    void removeItems(long buyerId, Collection<Long> productIds);
}
```

```java
package com.example.shop.inventory;

public interface InventoryApi {
    // …第 01～03 章的 available、initialize、restock…

    /**
     * 為一張訂單預留庫存（每個品項一筆 HELD 預留）。全有或全無：任何一個品項不足就丟例外，呼叫端的交易應該 rollback。
     * 內部會依 productId 排序後才加鎖（4.2.3：避免兩張訂單以相反的順序鎖同樣兩個商品而死鎖）。
     * 必須在呼叫端既有的交易內呼叫（Propagation.MANDATORY）。
     */
    void reserve(long orderId, List<ReserveLine> lines);

    /** 付款成功：這張訂單的預留 HELD → CONFIRMED（不再能被逾時釋放）。數量不變，不記帳。MANDATORY。 */
    void confirm(long orderId);

    /** 取消：這張訂單的預留 → RELEASED，reserved 減回，每個品項一筆 RELEASE。已釋放的不重複釋放（冪等）。MANDATORY。 */
    void release(long orderId);

    /** 出貨：CONFIRMED → CONSUMED，onHand 與 reserved 同時減少，每個品項一筆 SHIP。MANDATORY。 */
    void consume(long orderId);
}
```

```java
package com.example.shop.payment;

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

    /** 為一筆成功的付款建立全額退款（PENDING）。同一筆付款重複呼叫不會建第二筆（uk_refunds_payment）。MANDATORY。 */
    void requestRefund(long paymentId, RefundReason reason);

    /** 這張訂單「讓它變成已付款」的那一筆付款（最早成功、而且還沒退款的） */
    Optional<Long> succeededPaymentOf(long orderId);
}
```

```java
package com.example.shop.payment;

/** refunds.reason 的四個值（V6 的 ck_refunds_reason） */
public enum RefundReason { BUYER_CANCEL, SELLER_CANCEL, LATE_PAYMENT, DUPLICATE_PAYMENT }
```

這四個介面有一個共同的形狀：**給下單與狀態轉移用的寫入方法，全部是 `MANDATORY`**（`removeItems`、`reserve`、`confirm`、`release`、`consume`、`record`、`requestRefund`）。
例外是兩種「自己就是一件完整的事」的寫入：`PaymentApi.create()`（建立一次付款嘗試，由 `OrderCommands.startPayment()` 呼叫）與第 01～03 章的 `InventoryApi.restock()`、`restockBatch()`，它們是一般的 `@Transactional`（`REQUIRED`）。
（實作端的 `CartService.removeItems()`、`JdbcPaymentService` 的 `create()` 與 `succeededPaymentOf()`，以及 `InventoryApi` 的全文，在 4.10.1。）

`MANDATORY` 的意思是「我**必須**在你的交易裡執行，沒有交易就丟 `IllegalTransactionStateException`」。
它把 0.5.4 表格左欄那句「**同一個交易內（全有或全無）**」變成程式碼層級的保證：
`cart.removeItems()` 不可能在下單交易之外被呼叫，然後在下單失敗時留下一個「購物車被清空、訂單卻沒成立」的狀態。

> 📌 **為什麼不是 `REQUIRED`（預設值）？** `REQUIRED` 在沒有交易時會**自己開一個**。
> 如果有人在一個沒有交易的地方呼叫 `inventory.reserve()`，`REQUIRED` 會讓它「成功」—— 每個品項各自在自己的交易裡 commit，全有或全無就沒了。
> `MANDATORY` 讓這個錯誤在**第一次執行**時就炸開，而不是在第一次有品項不足時才出現髒資料。

`payment` 模組的介面刻意**不知道訂單狀態**：`record()` 只回答「這筆錢是第一次成功、重送、還是失敗」，要不要把訂單變成 `PAID`、要不要退款，由 `ordering` 查狀態機決定。
這讓 0.5.1 那段 📌 的「訂單流轉與錢的流轉不綁死」落實在模組邊界上。

### 4.3.3 交易邊界地圖

這一章的每一個寫入操作，交易從哪裡開始、到哪裡結束：

```
POST /api/orders（PlaceOrderService，4.4）
  ① 冪等鍵 claim ───────── 自己的短交易（REQUIRES_NEW）
  │    INSERT idempotency_keys (PROCESSING, 租約 30 秒)
  ② 下單交易 ─────────────── TransactionTemplate；只有 SQL，沒有任何外部呼叫
  │    SELECT products（catalog.snapshots）
  │    INSERT orders、order_items
  │    每個品項，依 productId 排序：UPDATE inventory（條件式）→ INSERT inventory_reservations → INSERT inventory_ledger
  │    INSERT order_status_history
  │    UPDATE idempotency_keys → SUCCEEDED
  │    DELETE cart_items
  ③ 失敗時：冪等鍵 release ── 自己的短交易：DELETE 那一列 PROCESSING

POST /api/payments/callback（PaymentCallbackService，4.6.3）── 一個交易
       SELECT payments ... FOR UPDATE → UPDATE payments
       UPDATE orders（條件式）→ UPDATE inventory_reservations（CONFIRMED）或 INSERT refunds
       INSERT order_status_history

POST .../cancel、/start-picking、/ship、/confirm-receipt（OrderCommands，4.6）── 一個交易
       SELECT orders.id（確認是你的）→ UPDATE orders（條件式）→ 副作用 → INSERT order_status_history → 讀回訂單

排程（OrderJobs，4.7）
       SELECT 過期訂單的 id（不在交易裡）
       每一張訂單：各自一個交易，跟「買家取消」走同一條路
```

下單交易寫了 **8 張表**：`orders`、`order_items`、`inventory`、`inventory_reservations`、`inventory_ledger`、`order_status_history`、`idempotency_keys`、`cart_items`。
這就是 0.5.4 表格第一列的左欄，少了一個 —— **Outbox**，第 07 章補上。

三條貫穿全章的規則：

1. **交易裡只有 SQL**（0.11.5 的第一條設計約束）。沒有 HTTP 呼叫、沒有 `Thread.sleep`、沒有「順便寄一封信」。
   退款的**實際呼叫**金流 API 不在這一章：這一章只建立 `refunds(PENDING)`，第 07 章由消費者非同步執行。
2. **狀態轉移一律是條件式 UPDATE**（0.5.5 的硬規則）。這一章的每一個轉移都會回到這條規則，4.6 是它的實作。
3. **冪等鍵的「取得」與「失敗釋放」在下單交易之外**，「完成」在下單交易之內（4.5）。
   這是這一章唯一刻意把一件事拆到三個交易的地方，4.5.1 解釋為什麼。

### 4.3.4 `OrderStateMachine`：0.5.3 那張表，變成一個純函式

0.5.2 的九個事件，一個 enum：

```java
package com.example.shop.ordering.internal;

/** 0.5.2 的九個事件 */
enum OrderEvent {
    PAY_SUCCEEDED,    // E1 金流回呼
    PAY_FAILED,       // E2 金流回呼
    BUYER_CANCEL,     // E3 買家
    PAYMENT_TIMEOUT,  // E4 排程
    SELLER_CANCEL,    // E5 賣家
    START_PICKING,    // E6 賣家
    SHIP,             // E7 賣家
    CONFIRM_RECEIPT,  // E8 買家
    AUTO_COMPLETE     // E9 排程
}
```

0.5.3 的 54 格，一個方法：

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;

import static com.example.shop.ordering.OrderStatus.*;
import static com.example.shop.ordering.internal.OrderEvent.*;

/**
 * 0.5.3 的 6 × 9 轉移表。這個類別沒有任何依賴、不碰資料庫 —— 它只回答「在這個狀態收到這個事件，該怎麼辦」。
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
            };
            case PAID -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;   // 同一筆重送 / 付了兩次錢
                case PAY_FAILED -> Decision.SAME;
                case BUYER_CANCEL, SELLER_CANCEL -> Decision.toWithRefund(CANCELLED);
                case PAYMENT_TIMEOUT, AUTO_COMPLETE -> Decision.IGNORE;
                case START_PICKING -> Decision.to(PICKING);
                case SHIP, CONFIRM_RECEIPT -> Decision.REJECT;
            };
            case PICKING -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;
                case PAY_FAILED, START_PICKING -> Decision.SAME;
                case BUYER_CANCEL, CONFIRM_RECEIPT -> Decision.REJECT; // 撿貨中買家不能取消（0.2.2 定案）
                case PAYMENT_TIMEOUT, AUTO_COMPLETE -> Decision.IGNORE;
                case SELLER_CANCEL -> Decision.toWithRefund(CANCELLED);
                case SHIP -> Decision.to(SHIPPED);
            };
            case SHIPPED -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;
                case PAY_FAILED -> Decision.SAME;
                case BUYER_CANCEL, SELLER_CANCEL, START_PICKING -> Decision.REJECT;
                case PAYMENT_TIMEOUT -> Decision.IGNORE;
                case SHIP -> same ? Decision.SAME : Decision.REJECT;    // 同單號重送 / 換了單號（操作錯誤）
                case CONFIRM_RECEIPT, AUTO_COMPLETE -> Decision.to(COMPLETED);
            };
            case COMPLETED -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;
                case PAY_FAILED, CONFIRM_RECEIPT -> Decision.SAME;
                case BUYER_CANCEL, SELLER_CANCEL, START_PICKING, SHIP -> Decision.REJECT;
                case PAYMENT_TIMEOUT, AUTO_COMPLETE -> Decision.IGNORE;
            };
            case CANCELLED -> switch (event) {
                case PAY_SUCCEEDED -> same ? Decision.SAME : Decision.REFUND;   // 晚到的付款（0.2.2 的 2,042 筆）
                case PAY_FAILED, BUYER_CANCEL, SELLER_CANCEL -> Decision.SAME;
                case PAYMENT_TIMEOUT, AUTO_COMPLETE -> Decision.IGNORE;
                case START_PICKING, SHIP, CONFIRM_RECEIPT -> Decision.REJECT;
            };
        };
    }
}
```

**四個設計決定**：

**① 它是一個純函式。** 輸入是（狀態、事件、`same`），輸出是一個 `Decision`。不讀資料庫、不看時間、不注入任何東西。
0.5 那張表是「這個專題唯一一份不允許『大概』的文件」—— 它的程式碼版本也應該是**最容易驗證**的程式碼：不用 Spring、不用資料庫，0.07 秒跑完 61 個測試。

**② 巢狀的 `switch` 表達式，而不是 `Map<(狀態, 事件), 決定>`。**
Java 21 對 enum 的 `switch` 表達式要求**窮舉**：少寫一個 case 就編譯失敗。假設產品經理加了一個事件「申請退貨」：

```java
enum OrderEvent {
    // …
    AUTO_COMPLETE,    // E9 排程
    REQUEST_RETURN    // 假設：產品經理新增了「申請退貨」
}
```

```
[ERROR] .../OrderStateMachine.java:[38,37] the switch expression does not cover all possible input values
[ERROR] .../OrderStateMachine.java:[45,26] the switch expression does not cover all possible input values
[ERROR] .../OrderStateMachine.java:[53,29] the switch expression does not cover all possible input values
[ERROR] .../OrderStateMachine.java:[61,29] the switch expression does not cover all possible input values
[ERROR] .../OrderStateMachine.java:[69,31] the switch expression does not cover all possible input values
[ERROR] .../OrderStateMachine.java:[75,31] the switch expression does not cover all possible input values
```

**六個錯誤，每個狀態一個** —— 編譯器逼你為這個新事件在每一個狀態下各做一次決定，也就是把表格多出來的那一欄填滿。
用 `Map` 的話，漏掉的格子會在執行時回傳 `null`，然後在某個凌晨三點變成 `NullPointerException`。

> ⚠️ 這個保證有一個前提：**不要寫 `default ->`。** 一旦寫了 `default`，編譯器就不再檢查窮舉，新的事件會默默落進 `default`。
> 本專題的 `OrderStateMachine` 裡沒有任何一個 `default`。

**③ `same` 參數處理「依情境而定」的那 5 格。** 0.5.3 有些格子寫著「＝ 同一筆 / ↺ 不同筆」、「＝ 同單號 / ✗ 不同單號」。
狀態機不知道「同一筆」是什麼意思 —— 那要查資料庫。所以由呼叫端判斷，傳一個 `boolean` 進來（4.6.1）。

**④ 五種結果，而不是 `boolean canTransition()`。** 0.2.2 的教訓是「能不能取消」不是一個 yes/no：
`CANCELLED` 再取消一次是**成功**（＝），`PICKING` 取消是**拒絕**（✗），排程掃到已付款的單是**略過**（·）。
這五種結果對應到五種不同的 HTTP 行為與日誌等級，混成 `boolean` 就回到 0.2.2 的三個 `boolean` 了。

### 4.3.5 一格一個測試：讓測試直接讀表格

0.5.5 預告了「54 個參數化測試」。最直接的寫法是 54 個 `@CsvSource` 列，但那樣測試跟 0.5.3 的表格**長得完全不一樣**，review 的人要在兩種格式之間來回翻譯。

本專題把 0.5.3 的表格**照抄**進測試：

```java
/**
 * 0.5.3 的轉移表，一格一個測試。表格就照抄 0.5.3（圖例：→X 轉移、＝ 冪等、↺ 退款、✗ 拒絕、· 略過、+R 轉移並退款）。
 * 「＝/↺」與「＝/✗」這種依情境而定的格子，兩種情境各測一次。
 */
class OrderStateMachineTest {

    static final List<OrderEvent> COLUMNS = List.of(OrderEvent.values());   // E1～E9，順序同 0.5.2

    /** 0.5.3，逐字對照 */
    static final String TABLE = """
            #                 E1       E2  E3             E4  E5             E6         E7          E8           E9
            PENDING_PAYMENT   →PAID    ＝   →CANCELLED     →CANCELLED ✗     ✗          ✗           ✗            ·
            PAID              ＝/↺     ＝   →CANCELLED+R   ·   →CANCELLED+R   →PICKING   ✗           ✗            ·
            PICKING           ＝/↺     ＝   ✗              ·   →CANCELLED+R   ＝          →SHIPPED    ✗            ·
            SHIPPED           ＝/↺     ＝   ✗              ·   ✗              ✗          ＝/✗        →COMPLETED   →COMPLETED
            COMPLETED         ＝/↺     ＝   ✗              ·   ✗              ✗          ✗           ＝            ·
            CANCELLED         ↺        ＝   ＝              ·   ＝              ✗          ✗           ✗            ·
            """;

    record Cell(OrderStatus from, OrderEvent event, boolean same, String expected) {
        @Override public String toString() { return from + " + " + event + (same ? "（同一筆 / 同單號）" : "") + " ⇒ " + expected; }
    }

    static Stream<Cell> cells() {
        List<Cell> out = new ArrayList<>();
        for (String line : TABLE.strip().lines().skip(1).toList()) {
            String[] cols = line.trim().split("\\s+");
            OrderStatus from = OrderStatus.valueOf(cols[0]);
            for (int i = 0; i < COLUMNS.size(); i++) {
                String cell = cols[i + 1];
                if (cell.contains("/")) {                                   // 「同一筆」一種、「不同筆」一種
                    out.add(new Cell(from, COLUMNS.get(i), true, cell.split("/")[0]));
                    out.add(new Cell(from, COLUMNS.get(i), false, cell.split("/")[1]));
                } else {
                    out.add(new Cell(from, COLUMNS.get(i), false, cell));
                }
            }
        }
        return out.stream();
    }

    static String render(Decision d) {
        return switch (d.kind()) {
            case TRANSITION -> "→" + d.to() + (d.refund() ? "+R" : "");
            case IDEMPOTENT -> "＝";
            case REFUND_ONLY -> "↺";
            case REJECT -> "✗";
            case IGNORE -> "·";
        };
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("cells")
    void everyCellOfTheTable(Cell c) {
        // .as(c)：Maven 的輸出只會寫「everyCellOfTheTable(Cell)[23]」，看不到是哪一格（4.3.5）
        assertThat(render(OrderStateMachine.decide(c.from(), c.event(), c.same()))).as(c.toString()).isEqualTo(c.expected());
    }

    @Test
    void theTableHas54CellsAnd5ContextDependentOnes() {
        assertThat(cells().count()).isEqualTo(54 + 5);
    }

    @Test
    void terminalStatesNeverLeave() {                                        // 0.5.1：進入終態之後，沒有任何事件能讓它離開
        for (OrderStatus terminal : List.of(OrderStatus.COMPLETED, OrderStatus.CANCELLED))
            for (OrderEvent e : OrderEvent.values())
                for (boolean same : new boolean[]{true, false})
                    assertThat(OrderStateMachine.decide(terminal, e, same).kind()).isNotEqualTo(Kind.TRANSITION);
    }
}
```

**61 個測試** = 54 格 + 5 格「依情境而定」的另一種情境（`PAID`、`PICKING`、`SHIPPED`、`COMPLETED` 的 E1，以及 `SHIPPED` 的 E7）+ 2 個結構性的測試。

- `theTableHas54CellsAnd5ContextDependentOnes`：防止有人在表格裡**少打一格**（`split` 之後欄數不對，某一格就不會被測到）。
- `terminalStatesNeverLeave`：0.5.1 的「終態不可離開」。它跟表格重複，但它是從**另一個角度**寫的同一條規則 —— 如果有人同時改錯了表格和程式碼（兩邊一致地錯），這個測試還會紅。

`CANCELLED` 的 E1 只寫了 `↺`，沒有 `＝/↺`：取消的訂單不可能有「讓它變成已付款的那一筆」，所以不存在「同一筆」的情境。

**把一格改錯**，看看測試怎麼說。假設有人覺得「撿貨中也應該讓買家取消，反正會退款」，把 `PICKING + BUYER_CANCEL` 改成 `toWithRefund(CANCELLED)`：

```
[ERROR] com.example.shop.ordering.internal.OrderStateMachineTest.everyCellOfTheTable(Cell)[23] -- Time elapsed: 0.007 s <<< FAILURE!
org.opentest4j.AssertionFailedError: 
[PICKING + BUYER_CANCEL ⇒ ✗] 
expected: "✗"
 but was: "→CANCELLED+R"
```

如果測試沒有 `.as(c.toString())`，Maven 的輸出只有 `everyCellOfTheTable(Cell)[23]` 和 `expected: "✗" but was: "→CANCELLED+R"` ——
`@ParameterizedTest(name = "{0}")` 設定的名字**只有 IDE 看得到**，surefire 的純文字報告只印索引。
你得自己數到第 23 格才知道是哪裡錯了。**一個失敗的測試，要讓看 CI 日誌的人不用打開 IDE 就知道錯在哪。**

> 📌 **這個測試守的是「程式碼 = 表格」，不守「表格是對的」。** 表格對不對，是 0.5 跟產品經理一起定案的事。
> 當需求改了（例如真的決定撿貨中可以取消），正確的流程是：**先改 0.5.3、再改測試的 `TABLE`、最後改程式碼** —— 三個地方的 diff 會出現在同一個 PR 裡，而且長得一樣。

---

## 4.4 下單交易

### 4.4.1 `PlaceOrderService`：交易在方法裡面，不在方法上面

1.5.4 定義了 `OrderingApi` 的樣子。這一章改了它的簽章：`placeOrder()` 多了 `idempotencyKey` 參數、回傳 `PlacedOrder`（訂單 id、訂單編號、是不是重送），`OrderLine` 多了 `clientUnitPrice`（US-ORD-1 AC-6）。新的介面全文在 4.10.1。

它的實作：

```java
package com.example.shop.ordering.internal;

/**
 * 4.4 下單。交易邊界：
 *   ① IdempotencyKeys.claim()   —— 短交易，取得這個鍵
 *   ② placeInTransaction()      —— 下單交易：訂單、明細、預留、庫存帳、狀態歷史、冪等鍵完成、清購物車。全有或全無（Q1）
 *   ③ 失敗時 IdempotencyKeys.release() —— 短交易，讓重試可以重新執行
 * ② 裡「只有 SQL」：沒有外部呼叫、沒有 sleep、沒有遠端日誌（0.11.5 的第一條設計約束：持鎖 ≤ 2 ms）
 */
@Service
class PlaceOrderService implements OrderingApi {

    static final int MAX_LINES = 50;
    static final int ORDER_NO_ATTEMPTS = 3;

    private final CatalogApi catalog;
    private final InventoryApi inventory;
    private final CartApi cart;
    private final OrderRepository orders;
    private final OrderHistory history;
    private final IdempotencyKeys keys;
    private final TransactionTemplate tx;
    private final Clock clock;
    private final Duration paymentTimeout;

    PlaceOrderService(CatalogApi catalog, InventoryApi inventory, CartApi cart, OrderRepository orders, OrderHistory history,
                      IdempotencyKeys keys, PlatformTransactionManager tm, Clock clock, ShopProperties props) {
        this.catalog = catalog;
        this.inventory = inventory;
        this.cart = cart;
        this.orders = orders;
        this.history = history;
        this.keys = keys;
        this.tx = new TransactionTemplate(tm);
        this.clock = clock;
        this.paymentTimeout = props.order().paymentTimeout();
    }

    @Override
    public PlacedOrder placeOrder(long buyerId, String idempotencyKey, List<OrderLine> lines) {
        validate(lines);
        IdempotencyKeys.Claim claim = keys.claim(buyerId, idempotencyKey, hash(lines));
        if (claim instanceof IdempotencyKeys.Existing e) {
            Order o = orders.findById(e.orderId()).orElseThrow();
            return new PlacedOrder(o.getId(), o.getOrderNo(), true);
        }
        if (claim instanceof IdempotencyKeys.InProgress)
            throw new ShopException(ProblemType.IDEMPOTENCY_IN_PROGRESS, "相同的下單請求正在處理中").with("retryAfter", 1);
        try {
            for (int attempt = 1; ; attempt++) {
                try {
                    return tx.execute(s -> placeInTransaction(buyerId, idempotencyKey, lines));
                } catch (DataIntegrityViolationException e) {
                    // 2.4.4：訂單編號撞號（一天約 12 次）。整個交易已經 rollback，換一個號碼重來
                    if (attempt >= ORDER_NO_ATTEMPTS || !ConstraintViolations.isViolationOf(e, "uk_orders_order_no")) throw e;
                }
            }
        } catch (RuntimeException e) {
            keys.release(buyerId, idempotencyKey);                          // AC-4：失敗的結果不快取
            throw e;
        }
    }
```

（`validate()` 在進任何交易之前，擋掉品項數不在 1～50、或同一個商品出現兩次的請求。`PlaceOrderService` 全文在 4.10.1。）

**`placeOrder()` 自己沒有 `@Transactional`**。這是整個下單流程最重要的一個決定，理由有三個：

1. **冪等鍵的 claim 與 release 必須在下單交易之外。** 如果 claim 在下單交易裡面，「處理中」這個狀態在下單交易 commit 之前，**別的請求看不到**
   （未提交的列，在 READ UNCOMMITTED 以外的任何隔離等級下都看不到，[07-mysql/04](../07-mysql/04-transaction-isolation-and-lock.md)）。
   第二個請求的 INSERT 會撞上那一列還沒提交的主鍵、**卡在鎖等待裡**，而不是立刻知道「有人在處理」—— 那就做不到 AC-3 的「立刻回 409」了（4.5.1）。
2. **撞號重試需要一個全新的交易。** `uk_orders_order_no` 違反時，那個交易已經不能用了：MySQL 只是那一句失敗，但 Hibernate 的規則是「flush 丟出例外之後，這個 Session 的狀態就不可信，必須 rollback 並丟棄」。
   重試必須在 `tx.execute()` 的**外面**：舊交易 rollback，新交易重來。
3. **例外要穿過交易邊界再被接住。** 4.2.2 的教訓是「在交易裡接住例外沒有正確的版本」。這裡所有的 `catch` 都在 `tx.execute()` 之外：
   例外穿出來的時候，交易已經 rollback 乾淨了，接住它只是為了**決定下一步**（重試、或 release 之後再往上丟）。

`TransactionTemplate` 用的是同一個 `PlatformTransactionManager`（`JpaTransactionManager`），所以裡面的 JPA 與 `JdbcTemplate` 共用同一條連線、同一個交易（3.7.2）。

> 📌 **`keys.release()` 本身也可能失敗**（例如資料庫在這一刻斷線）。那時冪等鍵會停在 `PROCESSING`。
> 這不會讓買家永遠卡住：`PROCESSING` 帶著 30 秒的**租約**（4.5.1），租約到期之後，同一個鍵的下一個請求會接手重新執行。
> **任何「失敗時清理」的步驟都要假設清理本身會失敗**，並準備好一條不靠它的復原路徑。

### 4.4.2 交易裡面：順序就是設計

```java
    private PlacedOrder placeInTransaction(long buyerId, String key, List<OrderLine> lines) {
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

        Instant now = clock.instant();
        Order order = Order.place(OrderNumbers.next(now), buyerId, sellers.iterator().next(), now, now.plus(paymentTimeout));
        for (OrderLine l : lines) {
            ProductSnapshot p = products.get(l.productId());
            order.addItem(p.id(), p.name(), p.price(), l.quantity());      // 快照：下單當下的名稱與價格（1.5.5）
        }
        orders.saveAndFlush(order);                                         // IDENTITY：這裡就 INSERT 了，撞號也在這裡炸

        inventory.reserve(order.getId(), lines.stream().map(l -> new ReserveLine(l.productId(), l.quantity())).toList());
        history.record(order.getId(), null, order.getStatus(), "PLACE_ORDER", OrderHistory.Actor.buyer(buyerId), now);
        keys.complete(buyerId, key, order.getId());
        cart.removeItems(buyerId, ids);                                     // AC-4
        return new PlacedOrder(order.getId(), order.getOrderNo(), false);
    }
```

（`OrderHistory` 是一個很小的 `@Component`：`record()` 是 `MANDATORY`，往 `order_status_history` 寫一筆；`Actor` 有 `buyer`、`seller`、`system`、`paymentProvider` 四種。全文在 4.10.1。）

順序是刻意的：**先做所有「只讀」的檢查，再開始寫；寫的時候，先寫不會被搶的，最後才碰會被搶的。**

| 步驟 | 鎖了什麼 | 為什麼在這個位置 |
|---|---|---|
| 讀商品快照、檢查可購買、單一賣家、價格 | 什麼都不鎖（一般的 SELECT） | 失敗的話，一列都還沒寫、一個鎖都還沒拿 |
| `saveAndFlush(order)`（含明細） | 新的列（別人看不到） | 需要 `order.getId()` 給預留用；撞號在這裡發生 |
| `inventory.reserve()` | **`inventory` 的熱點列**（X 鎖，直到 commit） | 唯一會跟別人搶的步驟，所以放在後面 —— **從這裡到 commit 的時間，就是熱點的持鎖時間** |
| history、冪等鍵完成、清購物車 | 自己的列 | 幾句很快的單列寫入 |

最後一條是 0.11.5 的約束在程式碼裡的樣子。如果把 `reserve()` 放在第一步、再去讀商品、比價格、寫訂單，**熱點商品的那一列會被鎖住整個交易的長度**，而不是只有最後幾句。
0.11 量過：交易多 5 ms，熱點的上限從 678 掉到 138。

> 📌 **價格比對為什麼不鎖商品列？** 在 SELECT 價格與 commit 之間，賣家可能剛好改了價。這時訂單會以**舊價格**成立 —— 那是使用者看到、同意付的價格。
> 這是 US-ORD-1 AC-6 的精神：比對的目的是「不要在使用者不知情的情況下多收錢」，不是「保證成交價 = 這一毫秒的標價」。
> 為了這個去鎖 `products`，等於讓每一次下單都跟賣家改價互相阻塞，不值得。

**預留**（`JdbcInventoryService.reserve()`，4.2.3 的兩條規則都在這裡）：

```java
@Override
@Transactional(propagation = Propagation.MANDATORY)
public void reserve(long orderId, List<ReserveLine> lines) {
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
```

- **排序**（4.2.3）：所有交易都以同樣的順序鎖 `inventory` 的列。
- **條件式 UPDATE**（4.2.1 ⑥）：影響 0 列 → `InsufficientStockException`（帶 `productId`，US-ORD-1 AC-5 要「列出哪個品項不足」）。
- **先 UPDATE 父表、再 INSERT 子表**（2.6.2）。
- 預留列是**每個品項一筆**，而不是整張訂單一筆：`confirm`、`release`、`consume` 都以「這張訂單的所有預留」為單位，但每一筆記著自己的 `product_id` 與數量，釋放時才知道要減回哪一列的 `reserved`。

### 4.4.3 價格、指紋、與 `BigDecimal` 的 scale

**金額**由伺服器用資料庫的價格算（US-ORD-1 AC-2）：

```java
void addItem(long productId, String productName, BigDecimal unitPrice, int quantity) {
    items.add(new OrderItem(this, productId, productName, unitPrice, quantity));
    totalAmount = totalAmount.add(unitPrice.multiply(BigDecimal.valueOf(quantity))).setScale(2, java.math.RoundingMode.HALF_UP);
}
```

（`Order.place()` 建立一張 `PENDING_PAYMENT`、金額 `0.00` 的訂單；`OrderItem` 多了一個建構子，`getLineAmount()` 在剛 INSERT、還沒讀回產生欄位時自己算。`Order`、`OrderItem` 全文在 4.10.1。）

客戶端的 `unitPrice` **只拿來比對**，永遠不拿來計算。前端被改成送 `0.01`，結果只會是 409 `price-changed`，不會是一張 0.01 元的訂單。

**請求的指紋**（給冪等鍵比對「是不是同一個請求」用，4.5）：

```java
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
```

兩個正規化：

- **依 `productId` 排序**：前端重送時品項順序可能不同（例如從 `Map` 組出來的陣列），那仍然是同一個請求。
- **`stripTrailingZeros().toPlainString()`**：`149`、`149.0`、`149.00` 都變成 `"149"`。
  `toPlainString()` 不能省：`new BigDecimal("1000").stripTrailingZeros()` 是 `1E+3`，`toString()` 會印出 `"1E+3"`。

驗收 Q3 的第二個請求**刻意**把 `100` 寫成 `100.00`，確認這兩個正規化真的有效（4.5.4）。

### 4.4.4 訂單編號撞號，與一行嚇人的 ERROR

2.4.4 決定訂單編號是「台北日期 + 隨機 6 碼」，撞號由 `uk_orders_order_no` 擋下：

```java
/** 2.4.4：台北日期 + 隨機 6 碼。撞號由 uk_orders_order_no 擋下，下單時重試 */
final class OrderNumbers {

    static final ZoneId TAIPEI = ZoneId.of("Asia/Taipei");
    static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("yyyyMMdd");

    private OrderNumbers() {}

    static String next(Instant now) {
        return now.atZone(TAIPEI).format(DAY) + "-%06d".formatted(ThreadLocalRandom.current().nextInt(1_000_000));
    }
}
```

2.4.4 寫的是「在 `DuplicateKeyException` 時重試」。**實際上接到的不是它。** 用 JPA `saveAndFlush` 一張編號重複的訂單：

```
WARN  o.h.engine.jdbc.spi.SqlExceptionHelper   : SQL Error: 1062, SQLState: 23000
ERROR o.h.engine.jdbc.spi.SqlExceptionHelper   : Duplicate entry '20260702-000822' for key 'orders.uk_orders_order_no'
EXC org.springframework.dao.DataIntegrityViolationException
  cause org.hibernate.exception.ConstraintViolationException: could not execute statement [Duplicate entry '20260702-000822' for key 'orders.uk_orders_order_no'] ...
  cause java.sql.SQLIntegrityConstraintViolationException: Duplicate entry '20260702-000822' for key 'orders.uk_orders_order_no'
```

`DuplicateKeyException` 是 Spring 的 **JDBC** 例外轉換器（`SQLErrorCodeSQLExceptionTranslator`，用 MySQL 錯誤碼 1062 判斷）給的。
走 **JPA** 的路徑時，Hibernate 先把它包成自己的 `ConstraintViolationException`，Spring 的 `HibernateJpaDialect` 再轉成比較籠統的 `DataIntegrityViolationException`。
所以 `PlaceOrderService` 接的是 `DataIntegrityViolationException`，再用 3.6.1 的 `ConstraintViolations.isViolationOf(e, "uk_orders_order_no")` 確認是**這個**約束。
其他的完整性違反（例如某個 CHECK）不重試，直接往上丟。

**第二件事是那兩行日誌。** Hibernate 在把例外往上丟**之前**，就已經用 WARN 與 **ERROR** 等級印出來了 —— 不管呼叫端有沒有處理。
4.8 的搶購壓測的某一次執行（暖機加 4 輪、共 10,000 個請求；那時的 E7 還沒有 4.8.1 的開放式負載，這一次的輸出也不是 4.8.1 列出的那幾次），日誌裡出現了 4 次這樣的 ERROR。撞號被重試接住了 —— 它是一行看起來像 bug 的日誌，不是一個失敗的請求。

它不是 bug，但它**看起來**像 bug。第 09 章的告警規則如果寫「任何 ERROR 就告警」，這一行每天會叫醒人 12 次。三個選擇：

| 做法 | 代價 |
|---|---|
| 把 `org.hibernate.engine.jdbc.spi.SqlExceptionHelper` 的等級調成 OFF | **所有** SQL 錯誤的原始訊息都不見了，包括真正的 bug |
| 先 `SELECT` 看編號存不存在，再 INSERT | 多一句查詢，而且兩句之間還是會撞（檢查與寫入不是原子的） |
| **保留日誌，告警規則排除 `uk_orders_order_no`**，另外用指標數撞號次數 | 規則多一條例外 |

本專題選第三個：**日誌照實記錄，告警規則負責判斷哪些值得叫醒人**（第 09 章）。

### 4.4.5 Controller 與驗收 Q1、Q2

```java
/** 買家的訂單指令（US-ORD-1、2、4、6） */
@RestController
@RequestMapping("/api/orders")
class OrderCommandController {

    // …建構子注入 OrderingApi、OrderCommands、OrderQueryService…

    /** US-ORD-1a AC-1：第一次 201；同一個鍵、同樣內容再送一次 → 200 與同一張訂單 */
    @PostMapping
    ResponseEntity<OrderView> place(CurrentUser user,
                                    @RequestHeader("Idempotency-Key") @NotBlank(message = "Idempotency-Key 不可空白")
                                    @Size(max = 64, message = "Idempotency-Key 最多 64 字") String key,
                                    @Valid @RequestBody PlaceOrderRequest req) {
        OrderingApi.PlacedOrder placed = ordering.placeOrder(user.require(Role.BUYER).id(), key, req.items().stream()
                .map(l -> new OrderingApi.OrderLine(l.productId(), l.quantity(), l.unitPrice())).toList());
        return ResponseEntity.status(placed.replayed() ? HttpStatus.OK : HttpStatus.CREATED).body(queries.byId(placed.orderId()));
    }
```

```java
/** US-ORD-1：客戶端送來「它看到的單價」，只用來比對（AC-6） */
public record PlaceOrderRequest(
        @NotEmpty(message = "至少要有一個品項") @Size(max = 50, message = "最多 50 個品項") List<@Valid Line> items) {
    public record Line(
            @NotNull(message = "商品必填") Long productId,
            @NotNull(message = "數量必填") @Min(value = 1, message = "數量 1～99") @Max(value = 99, message = "數量 1～99") Integer quantity,
            @NotNull(message = "單價必填") @DecimalMin(value = "0.01", message = "單價必須大於 0") BigDecimal unitPrice) {}
}
```

- **請求 DTO 裡沒有 `buyerId`、`sellerId`、`status`、`totalAmount`**（3.5.1 的大量指派）。買家是誰由身分決定，賣家由商品決定，金額由伺服器算。
- 回應是 `OrderView`（3.6.2 的同一個 DTO），用 `queries.byId()`（`OrderQueryService` 新增的方法）在下單交易 **commit 之後**另外讀一次 —— 回應裡的東西保證是資料庫裡真的有的。
- 買家另外三個指令（取消、確認收貨、建立付款）與賣家的 `SellerOrderCommandController`（撿貨、出貨、取消）都只是把 `CurrentUser` 與路徑變數轉給 `OrderCommands`（4.6.5）。兩個 Controller、`OrderDtos`（含 `ShipRequest`、`PaymentStarted`）與 `OrderQueryService` 的全文在 4.10.1。

**沒帶 `Idempotency-Key`**（US-ORD-1 AC-7）時，Spring MVC 丟 `MissingRequestHeaderException`。它預設會回一個 Spring 自己的 400，格式跟 0.4.1 的 Problem Details 不一樣。`GlobalExceptionHandler` 覆寫了它：

```java
/** 缺少必要的 header（例如 Idempotency-Key，US-ORD-1 AC-7）或 path 變數 */
@Override
protected ResponseEntity<Object> handleServletRequestBindingException(org.springframework.web.bind.ServletRequestBindingException ex,
                                                                      HttpHeaders headers, HttpStatusCode status, WebRequest request) {
    String detail = ex instanceof org.springframework.web.bind.MissingRequestHeaderException m
            ? "缺少必要的 header：" + m.getHeaderName() : "請求缺少必要的參數";
    return ResponseEntity.badRequest().body(problem(ProblemType.VALIDATION, detail));
}
```

用 `curl` 走一次（`application-local.yml`，3.3.4 的 `X-Debug-User-Id`）：

```bash
curl -s -X POST -H "X-Debug-User-Id: 1001" -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
     -d '{"items":[{"productId":1,"quantity":2,"unitPrice":149}]}' localhost:8080/api/orders
```

```
--- 下單
{"orderNo":"20260930-663500","status":"PENDING_PAYMENT","totalAmount":298.00,"createdAt":"2026-09-30T03:09:54.280Z","paymentDeadline":"2026-09-30T03:24:54.280Z","items":[{"productId":1,"productName":"濾掛咖啡 #1","unitPrice":149.00,"quantity":2,"lineAmount":298.00}]} [201]
--- 沒帶 Idempotency-Key
{"type":"/problems/validation","title":"請求內容不正確","status":400,"detail":"缺少必要的 header：Idempotency-Key","instance":"/api/orders"} [400]
--- 客戶端看到的價格是 100
{"type":"/problems/price-changed","title":"價格已變動","status":409,"detail":"價格已變動，請確認後重新下單","instance":"/api/orders","changes":[{"productId":1,"yourPrice":100,"currentPrice":149.00}]} [409]
```

- 送的是 `"unitPrice":149`（JavaScript 會送的樣子），資料庫是 `149.00` —— **成立了**（4.2.4 的 `compareTo`）。
- `paymentDeadline` = `createdAt` + 15 分鐘（US-ORD-1 AC-1）。
- `price-changed` 帶回 `currentPrice`，前端可以直接顯示「價格已從 100 變成 149，要繼續嗎？」

**驗收 Q1：交易邊界**

0.12 的 Q1 是「下單失敗時，訂單、明細、庫存異動都沒有殘留」。測試的設計重點在**讓失敗發生在「已經寫了一些東西」之後**：

```java
@Test
@DisplayName("Q1 一筆訂單的交易邊界：下單失敗時，訂單、明細、庫存異動三張表都沒有殘留")
void q1_transactionBoundary() throws Exception {
    long buyer = 990_001, a = 9_900_101, b = 9_900_102;
    try (var ctx = startApp()) {
        JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
        int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
        try {
            product(jdbc, a, 5);
            product(jdbc, b, 0);                                         // B 沒有庫存
            jdbc.update("INSERT INTO cart_items (buyer_id, product_id, quantity, unit_price_at_add) VALUES (?, ?, 1, 100), (?, ?, 1, 100)", buyer, a, buyer, b);
            String ledgerBefore = jdbc.queryForObject("SELECT CONCAT(COUNT(*), '/', SUM(delta_reserved)) FROM inventory_ledger WHERE product_id = ?", String.class, a);

            // US-ORD-1 AC-5：A 有貨、B 沒貨 —— 先預留的 A（product_id 較小）必須跟著 rollback
            Http r = placeOrder(port, buyer, "q1-key", "[{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}, {\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]".formatted(a, b));
            Map<String, Object> residue = jdbc.queryForMap("""
                    SELECT (SELECT COUNT(*) FROM orders WHERE buyer_id = ?)                                  AS orders,
                           (SELECT COUNT(*) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?) AS items,
                           (SELECT COUNT(*) FROM inventory_reservations WHERE product_id IN (?, ?))          AS reservations,
                           (SELECT reserved FROM inventory WHERE product_id = ?)                              AS reserved_a,
                           (SELECT CONCAT(COUNT(*), '/', SUM(delta_reserved)) FROM inventory_ledger WHERE product_id = ?) AS ledger_a,
                           (SELECT COUNT(*) FROM idempotency_keys WHERE buyer_id = ?)                         AS idem_keys,
                           (SELECT COUNT(*) FROM cart_items WHERE buyer_id = ?)                               AS cart""",
                    buyer, buyer, a, b, a, a, buyer, buyer);
            // …斷言：409 insufficient-stock、七個殘留都是 0（購物車保持 2 項）、A 的庫存帳跟下單前一樣…

            // AC-4：失敗不快取。補貨之後，用同一個鍵再送一次，要能成功
            jdbc.update("UPDATE inventory SET on_hand = 3 WHERE product_id = ?", b);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 3, 0, 'RESTOCK', 'acceptance')", b);
            Http retry = placeOrder(port, buyer, "q1-key", /* 同樣的內容 */ …);
            assertThat(retry.status()).isEqualTo(201);
        } finally {
            cleanupBuyersAndProducts(jdbc, List.of(buyer), List.of(a, b));
        }
    }
}
```

（`startApp()`、`placeOrder()`、`product()`、`cleanupBuyersAndProducts()` 這幾個小工具，以及 Q1～Q3 沒有省略的完整版本，在 4.10.1。）

**`a = 9_900_101`、`b = 9_900_102` 的大小是刻意的。** `reserve()` 依 `productId` 排序，所以 A（有貨）**先**被預留成功 —— `reserved_a` 變成 1、寫了一筆 `RESERVE` 帳、一筆 `HELD` 預留 —— 然後 B 不足、丟例外。
如果反過來讓 B 的 id 比較小，B 第一個就失敗，A 根本沒被碰過，這個測試**不管交易邊界對不對都會通過**。
**一個驗收交易邊界的測試，要確定失敗發生在「已經寫了東西」之後。**

測試檢查了七個地方：訂單、明細、預留、`reserved`、庫存帳、**冪等鍵**（AC-4：失敗不快取）、**購物車**（AC-4：失敗時不清空）。

**驗收 Q2：100 條執行緒搶最後 1 件**

```java
@Test
@DisplayName("Q2 100 條執行緒搶最後 1 件：恰好 1 筆成立、99 筆收到 409、庫存 = 0")
void q2_noOversell() throws Exception {
    long hot = 9_900_201;
    List<Long> buyers = java.util.stream.LongStream.range(0, 100).map(i -> 990_200 + i).boxed().toList();
    try (var ctx = startApp()) {
        // …建立商品 hot，庫存 1…
        var pool = java.util.concurrent.Executors.newFixedThreadPool(100);
        var go = new java.util.concurrent.CountDownLatch(1);
        List<java.util.concurrent.Future<Http>> fs = new java.util.ArrayList<>();
        for (long buyer : buyers) fs.add(pool.submit(() -> {
            go.await();
            return placeOrder(port, buyer, "q2-" + buyer, "[{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]".formatted(hot));
        }));
        go.countDown();
        Map<String, Integer> outcomes = new java.util.TreeMap<>();
        for (var f : fs) { Http h = f.get(); outcomes.merge(h.status() + " " + (h.type() == null ? "" : h.type()), 1, Integer::sum); }
        Integer available = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, hot);
        assertThat(outcomes).containsEntry("201 ", 1).containsEntry("409 /problems/insufficient-stock", 99).hasSize(2);
        assertThat(available).isZero();
    }
}
```

`.hasSize(2)` 是 US-ORD-1b AC-1 的「**0 筆 500**」：結果只能有兩種，201 與 409 `insufficient-stock`。任何一個 500、503、或其他 409 都會讓它紅。

```bash
mvn test -Dtest='CapstoneAcceptanceTest#q1*+q2*'
```

```
Q1：HTTP 409 /problems/insufficient-stock，productId=9900102；殘留：{orders=0, items=0, reservations=0, reserved_a=0, ledger_a=1/0, idem_keys=0, cart=2}（庫存帳下單前 1/0）
Q1：補貨後用同一個鍵重送 → HTTP 201 20260930-205204；購物車剩 0 項
Q2：{201 =1, 409 /problems/insufficient-stock=99}；available = 0
```

- Q1 的 `ledger_a=1/0`：A 的庫存帳在下單前是「1 筆（期初）、`delta_reserved` 合計 0」，失敗之後**還是 1/0** —— 那筆 `RESERVE` 帳跟著 rollback 了。
- Q1 的重送：同一個鍵 `q1-key`，補貨之後成功，購物車被清空。**失敗不快取**（AC-4）。
- Q2：1 筆 201、99 筆 409，**沒有第三種結果**。

---

## 4.5 冪等下單

### 4.5.1 六條 AC，一張表，三個交易

US-ORD-1a 的六條 AC（0.4.5）：

| AC | 情境 | 要的結果 | 機制 |
|---|---|---|---|
| 1 | 同一個鍵、同樣內容，第一次已成功 | **200**、同一張訂單 | 鍵的狀態 `SUCCEEDED` + `order_id` |
| 2 | 同一個鍵、不同內容 | **422** | `request_hash`（4.4.3 的指紋） |
| 3 | 同一個鍵，第一個請求還在處理 | **409** + `Retry-After: 1` | 鍵的狀態 `PROCESSING` + 租約 `locked_until` |
| 4 | 同一個鍵，第一次失敗了 | **重新執行** | 失敗時刪掉 `PROCESSING` 的列 |
| 5 | 不同買家用同一個鍵 | 不同的鍵 | 主鍵是 `(buyer_id, idem_key)` |
| 6 | 24 小時之後 | 當成新的鍵 | `expires_at`；過期的列可以被重新取得 |

第 02 章的 `idempotency_keys`（V5）有 1、2、5、6 需要的欄位，但**沒有辦法表達「處理中」**：一列存在，就代表成功了。
V11 補上兩個欄位：

```sql
-- 4.5：冪等鍵要能表達「處理中」（US-ORD-1a AC-3：同一個鍵的第一個請求還在處理 → 409）。
-- PROCESSING 的列帶一個租約（locked_until）：行程在處理到一半時死掉，租約到期後同一個鍵可以被重新執行。
-- 既有的列都是「已完成」的，所以預設值是 SUCCEEDED。一句 DDL（2.2.2 規則二）。
ALTER TABLE idempotency_keys
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'SUCCEEDED',
  ADD COLUMN locked_until DATETIME(3) NULL,
  ADD CONSTRAINT ck_idem_status CHECK (status IN ('PROCESSING', 'SUCCEEDED'));
```

- **只有 `ALTER TABLE` 一句**（2.2.2 的「一個 migration 一句 DDL」）：兩個欄位和一個約束在同一句裡，要嘛全部成功、要嘛全部沒發生。
- **預設值 `SUCCEEDED`**：已經存在的列（第 02 章的種子資料、之前的測試）都是成功的下單留下來的。
- 驗收 Q6 的數字跟著變了：**11 個 migration、CHECK 25 / 25**（第 02 章是 10 個、24 / 24）。Q6 的斷言是從 migration 檔**數**出來的，不是寫死的數字，所以不用改測試（2.10）。

**一個鍵的一生**：

```
            claim()：INSERT 成功（自己的短交易，立刻 commit）
  （不存在）─────────────────────────────▶ PROCESSING（locked_until = 現在 + 30 秒）
      ▲                                         │
      │ release()：DELETE                        │ complete()：在「下單交易」裡 UPDATE
      │（自己的短交易；下單失敗時）                  ▼（跟訂單一起 commit）
      └──────────────────────────────────  SUCCEEDED（order_id = 那張訂單）
                                                 │
                                                 │ 24 小時後：過期，可以被重新 claim
```

**為什麼要拆成三個交易？** 把整件事放進下單交易裡，看起來比較簡單。但：

- **「處理中」必須讓別人看得到。** 下單交易還沒 commit 時，它 INSERT 的那一列對別的交易是**看不到**的。
  第二個請求的 INSERT 會撞上那一列還沒提交的主鍵 —— InnoDB 的處理方式是**等**：等第一個交易 commit 或 rollback。
  這代表連點 10 次，就有 9 個請求各自佔著一條連線、卡在鎖等待裡，一直到第一個請求做完。在搶購時，那就是連線池被使用者的連點吃光。
  AC-3 要的是「**立刻**回 409，請你一秒後再來」，不是「讓你等」。
- **行程死掉要能復原。** 如果 claim 跟訂單在同一個交易裡，行程死掉時交易 rollback，鍵也消失了 —— 這樣其實沒問題。
  但**把 claim 拆出來**之後，行程死掉時 `PROCESSING` 的列會留下來，這時就需要一個**租約**：30 秒之後，這個鍵可以被別人接手。
- **`complete()` 必須在下單交易裡。** 訂單 commit、鍵就是 `SUCCEEDED`；訂單 rollback、鍵就還是 `PROCESSING`（接著被 `release()` 刪掉）。
  放在交易外面的話，會有一個「訂單已經存在、鍵還是 `PROCESSING`」的窗口 —— 在這個窗口裡重送的請求，會在租約到期後**再建一張訂單**。

```java
package com.example.shop.ordering.internal;

/**
 * 4.5 下單的冪等鍵（US-ORD-1a）。三個動作，各在不同的交易裡：
 *   claim()    —— 自己的短交易（REQUIRES_NEW）：插入一列 PROCESSING，帶 30 秒租約。插入成功 = 這個請求取得了這個鍵
 *   complete() —— 在「下單交易」裡：PROCESSING → SUCCEEDED 並記下訂單 id。跟訂單一起 commit，一起 rollback
 *   release()  —— 自己的短交易：下單失敗時刪掉 PROCESSING 的列，讓重試可以重新執行（AC-4：失敗不快取）
 */
@Component
class IdempotencyKeys {

    static final Duration LEASE = Duration.ofSeconds(30);
    static final Duration RETENTION = Duration.ofHours(24);             // AC-6

    sealed interface Claim permits Claimed, Existing, InProgress {}
    record Claimed() implements Claim {}
    record Existing(long orderId) implements Claim {}
    record InProgress() implements Claim {}

    private final JdbcTemplate jdbc;
    private final TransactionTemplate newTx;
    private final Clock clock;

    IdempotencyKeys(JdbcTemplate jdbc, PlatformTransactionManager tm, Clock clock) {
        this.jdbc = jdbc;
        this.newTx = new TransactionTemplate(tm);
        this.newTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.clock = clock;
    }
```

`Claim` 是一個 **sealed interface**（[01-java-core/12](../01-java-core/12-modern-java-records-sealed-pattern.md)）：取得鍵的結果只有三種，`PlaceOrderService` 用 `instanceof` 模式比對逐一處理。
`REQUIRES_NEW` 讓 `claim()` 與 `release()` 永遠開**自己的**交易，不管呼叫端有沒有交易 —— 它們必須立刻 commit，讓別的請求看見。

`complete()` 與 `release()`：

```java
    @Transactional(propagation = Propagation.MANDATORY)
    void complete(long buyerId, String key, long orderId) {
        int n = jdbc.update("""
                UPDATE idempotency_keys SET status = 'SUCCEEDED', order_id = ?, locked_until = NULL
                 WHERE buyer_id = ? AND idem_key = ? AND status = 'PROCESSING'""", orderId, buyerId, key);
        if (n == 0) throw new ShopException(ProblemType.IDEMPOTENCY_IN_PROGRESS, "這個請求的處理權已被另一個請求接手").with("retryAfter", 1);
    }

    void release(long buyerId, String key) {
        newTx.executeWithoutResult(s -> jdbc.update(
                "DELETE FROM idempotency_keys WHERE buyer_id = ? AND idem_key = ? AND status = 'PROCESSING'", buyerId, key));
    }
```

`complete()` 的 `if (n == 0)` 守著一個很少發生、但一定要處理的情境：**下單交易跑得比租約還久**。

InnoDB 的 `innodb_lock_wait_timeout` 預設是 50 秒，比 30 秒的租約長。假設請求甲的下單交易卡在某個鎖上 35 秒：

1. 第 30 秒，同一個鍵的請求乙到達，發現租約過期 → 接手，開始自己的下單交易。
2. 甲和乙現在**都在建訂單**。
3. 誰先執行 `complete()`，誰就把鍵從 `PROCESSING` 改成 `SUCCEEDED`。
4. 後到的那個 `complete()` 影響 0 列 → 丟例外 → **它的整個下單交易 rollback**。

所以就算租約設錯了，**最多也只會成立一張訂單**。租約決定的是「多久之後可以重試」，正確性由 `complete()` 的條件式 UPDATE 保證 —— 又是 0.5.5 那條規則。

**`Retry-After` header 從哪裡來？** `PlaceOrderService` 與 `IdempotencyKeys` 丟的是 `ShopException(...).with("retryAfter", 1)` —— 一個普通的 Problem Details 屬性。
把它變成 HTTP header 的是 `GlobalExceptionHandler.handleShop()`（3.4.3 的那個方法；本章把它改成先拿 `BodyBuilder`，屬性裡有 `retryAfter` 就加上 header）：

```java
    @ExceptionHandler(ShopException.class)
    ResponseEntity<ProblemDetail> handleShop(ShopException e) {
        ProblemDetail pd = problem(e.type(), e.getMessage());
        e.properties().forEach(pd::setProperty);
        ResponseEntity.BodyBuilder b = ResponseEntity.status(e.type().status());
        Object retryAfter = e.properties().get("retryAfter");              // US-ORD-1a AC-3、限流（第 06 章）
        if (retryAfter != null) b.header(HttpHeaders.RETRY_AFTER, retryAfter.toString());
        return b.body(pd);
    }
```

所以 409 的回應同時有 `Retry-After: 1` header 與 body 裡的 `"retryAfter":1`。US-ORD-1a AC-3 要的是 header；驗收 Q3 讀的也是 header（`r.headers().firstValue("Retry-After")`）。
少了這一步，回應裡就只有 body 的屬性、沒有 header，Q3 印出的狀態碼後面就不會有 `（Retry-After: 1）`。`GlobalExceptionHandler` 全文在 4.10.1。

### 4.5.2 第一版，和第一個 500：`LocalDateTime`

`claim()` 的第一版，把「INSERT 撞到重複鍵之後的處理」放在同一個交易裡：

```java
Claim claim(long buyerId, String key, String requestHash) {
    return newTx.execute(s -> {
        Instant now = clock.instant();
        try {
            jdbc.update("""
                    INSERT INTO idempotency_keys (buyer_id, idem_key, request_hash, status, locked_until, expires_at)
                    VALUES (?, ?, ?, 'PROCESSING', ?, ?)""",
                    buyerId, key, requestHash, Timestamp.from(now.plus(LEASE)), Timestamp.from(now.plus(RETENTION)));
            return new Claimed();
        } catch (DuplicateKeyException e) {
            return existing(buyerId, key, requestHash, now);
        }
    });
}
```

`existing()` 讀出那一列來判斷 AC-1、2、3、6。它的第一版用 `queryForList`，把時間欄位轉成 `Timestamp`：

```java
Map<String, Object> r = jdbc.queryForList("""
        SELECT request_hash, status, order_id, locked_until, expires_at FROM idempotency_keys
         WHERE buyer_id = ? AND idem_key = ? FOR UPDATE""", buyerId, key).get(0);
Instant expiresAt = ((Timestamp) r.get("expires_at")).toInstant();
```

第一次用 `curl` 走完整個流程，**重送**和**同鍵不同內容**都回了 500：

```
--- replay
 [500]
--- reuse key diff body
{"type":"/problems/internal","title":"系統發生錯誤","status":500,"detail":"系統發生錯誤，請稍後再試","instance":"/api/orders"} [500]
```

日誌：

```
java.lang.ClassCastException: class java.time.LocalDateTime cannot be cast to class java.sql.Timestamp (java.time.LocalDateTime is in module java.base of loader 'bootstrap'; java.sql.Timestamp is in module java.sql of loader 'platform')
```

`queryForList` 用 `ColumnMapRowMapper`，它對每一欄呼叫 `ResultSet.getObject()`。**MySQL Connector/J 8 對 `DATETIME` 欄位的 `getObject()` 回傳 `java.time.LocalDateTime`**，不是 `Timestamp`。
（這是 Connector/J 8.0.23 改的預設對應；`TIMESTAMP` 欄位的 `getObject()` 仍然是 `java.sql.Timestamp`。本專題的時間欄位全是 `DATETIME(3)`，所以這裡拿到的全部是 `LocalDateTime`。）

更麻煩的是 `LocalDateTime` **沒有時區**。就算把轉型改成 `(LocalDateTime)`，你還得知道驅動程式是用哪個時區把 `DATETIME` 解讀成 `LocalDateTime` 的 —— 那取決於 `connectionTimeZone`（2.4.3）。

修正：**不要讓驅動程式猜型別**。用 `RowMapper` 明確呼叫 `getTimestamp()`，它會照 `connectionTimeZone=UTC` 轉成正確的時間點：

```java
// 用 RowMapper + getTimestamp()，不用 queryForList：Connector/J 8 的 getObject() 把 DATETIME 給成 LocalDateTime（4.5.2）
List<Row> rows = jdbc.query("""
        SELECT request_hash, status, order_id, locked_until, expires_at FROM idempotency_keys
         WHERE buyer_id = ? AND idem_key = ?""",
        (rs, i) -> new Row(rs.getString(1), rs.getString(2), (Long) rs.getObject(3, Long.class),
                rs.getTimestamp(4) == null ? null : rs.getTimestamp(4).toInstant(), rs.getTimestamp(5).toInstant()),
        buyerId, key);
```

> 📌 **這個 bug 為什麼單元測試抓不到？** 因為它需要「**第二次**用同一個鍵」—— 只有重送、連點才會走進 `existing()`。
> 第一次下單的路徑（INSERT 成功）完全沒碰到這段程式碼。**冪等的程式碼，大部分時間都不會被執行**，所以它需要專門的測試（驗收 Q3、4.9 的流程測試）。

### 4.5.3 驗收 Q3 紅了：同一個鍵同時送 10 次，死鎖

修好 `LocalDateTime` 之後，先後送兩次都對了。驗收 Q3 的第二部分是**連點**：10 個請求帶同一個鍵，用 `CountDownLatch` 同時送出：

```java
// 使用者連點：10 個請求帶同一個鍵，同時送出
var pool = java.util.concurrent.Executors.newFixedThreadPool(10);
var go = new java.util.concurrent.CountDownLatch(1);
List<java.util.concurrent.Future<Http>> fs = new java.util.ArrayList<>();
for (int i = 0; i < 10; i++) fs.add(pool.submit(() -> { go.await(); return placeOrder(port, buyer, "q3-burst", items); }));
go.countDown();
// …統計每種狀態碼、出現過的訂單編號、資料庫裡的訂單數…
assertThat(orderNos).hasSize(1);
assertThat(orders).isEqualTo(2);                             // q3-seq 一張 + q3-burst 一張
assertThat(outcomes.keySet()).allMatch(k -> k.startsWith("200") || k.startsWith("201") || k.startsWith("409"));
```

用第一版跑了四次：

```
Q3：同一個鍵同時送 10 次 → {201=1, 409（Retry-After: 1）=5, 500=4}；出現過的訂單編號 [20260929-295443]；資料庫裡這位買家的訂單 2 張
Q3：同一個鍵同時送 10 次 → {201=1, 409（Retry-After: 1）=2, 500=7}；出現過的訂單編號 [20260930-860355]；資料庫裡這位買家的訂單 2 張
Q3：同一個鍵同時送 10 次 → {201=1, 409（Retry-After: 1）=1, 500=8}；出現過的訂單編號 [20260930-049663]；資料庫裡這位買家的訂單 2 張
Q3：同一個鍵同時送 10 次 → {201=1, 409（Retry-After: 1）=1, 500=8}；出現過的訂單編號 [20260930-145010]；資料庫裡這位買家的訂單 2 張
```

**冪等本身是對的**：只成立一張訂單（`orderNos` 只有一個）。但 10 個請求裡有 4～8 個是 **500**。日誌：

```
org.springframework.dao.CannotAcquireLockException: PreparedStatementCallback; SQL [SELECT request_hash, status, order_id, locked_until, expires_at FROM idempotency_keys
 WHERE buyer_id = ? AND idem_key = ? FOR UPDATE]; Deadlock found when trying to get lock; try restarting transaction
```

一個只有一列的表、每個交易只碰那一列 —— **怎麼會死鎖？** InnoDB 的死鎖紀錄（節錄）：

```
*** (1) TRANSACTION:
TRANSACTION 1060425, ACTIVE 0 sec starting index read
LOCK WAIT 3 lock struct(s), heap size 1128, 2 row lock(s)
SELECT request_hash, status, order_id, locked_until, expires_at FROM idempotency_keys
 WHERE buyer_id = 990003 AND idem_key = 'q3-burst' FOR UPDATE

*** (1) HOLDS THE LOCK(S):
RECORD LOCKS ... index PRIMARY of table `shop`.`idempotency_keys` trx id 1060425 lock mode S locks rec but not gap

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS ... index PRIMARY of table `shop`.`idempotency_keys` trx id 1060425 lock_mode X locks rec but not gap waiting

*** (2) TRANSACTION:
TRANSACTION 1060428, ACTIVE 0 sec starting index read
SELECT request_hash, status, order_id, locked_until, expires_at FROM idempotency_keys
 WHERE buyer_id = 990003 AND idem_key = 'q3-burst' FOR UPDATE

*** (2) HOLDS THE LOCK(S):
RECORD LOCKS ... trx id 1060428 lock mode S locks rec but not gap

*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS ... trx id 1060428 lock_mode X locks rec but not gap waiting

*** WE ROLL BACK TRANSACTION (2)
```

**兩個交易都拿著同一列的 S 鎖，都在等 X 鎖。** S 鎖從哪裡來？從那句**失敗的 INSERT**。

MySQL 手冊對 INSERT 的鎖行為有一句話：**INSERT 遇到重複鍵錯誤時，會在那個重複的索引記錄上設一把共享鎖（S）。**
（這是為了讓「檢查重複」這件事在交易結束前都成立：拿著 S 鎖，別人就不能刪掉那一列。）

所以第一版的每一個「後到」的請求：

1. `INSERT` → 重複鍵 → **拿到那一列的 S 鎖**（交易還沒結束，鎖不會放）；
2. 接著 `SELECT ... FOR UPDATE` → 要**同一列的 X 鎖** → 但別的後到請求也拿著 S 鎖 → 等；
3. 兩個以上的請求都在第 2 步 → 每一個都在等別人放掉 S 鎖 → 環 → 死鎖。

這就是 2.7.4 那段 📌 預告的「UNIQUE 那把鎖的另一面」，也是 2.6.2 的形狀（S 鎖升級成 X 鎖）。
**它只在「同一個鍵、同一瞬間、三個以上的請求」時發生** —— 一般的重送（隔幾秒）永遠碰不到，只有使用者狂按「送出」時才會。

### 4.5.4 修正：讓 S 鎖跟著失敗的 INSERT 一起消失

修正的想法是：**那把 S 鎖是失敗的 INSERT 留下的，那就讓 INSERT 自己的交易結束，把 S 鎖一起帶走**。之後在另一個新的交易裡，用**不加鎖**的方式讀，用**條件式 UPDATE** 接手：

```java
    Claim claim(long buyerId, String key, String requestHash) {
        for (int attempt = 0; attempt < 3; attempt++) {
            // ① 自己的短交易：插入成功 = 取得這個鍵。撞到既有的列 → 這個交易結束，連同它對那一列的 S 鎖一起放掉
            Boolean inserted = newTx.execute(s -> {
                Instant now = clock.instant();
                try {
                    jdbc.update("""
                            INSERT INTO idempotency_keys (buyer_id, idem_key, request_hash, status, locked_until, expires_at)
                            VALUES (?, ?, ?, 'PROCESSING', ?, ?)""",
                            buyerId, key, requestHash, Timestamp.from(now.plus(LEASE)), Timestamp.from(now.plus(RETENTION)));
                    return true;
                } catch (DuplicateKeyException e) {
                    return false;
                }
            });
            if (inserted) return new Claimed();
            // ② 另一個新的短交易：一般的讀取（不是 FOR UPDATE），再用條件式 UPDATE 接手。
            //    第一版在同一個交易裡接著 SELECT ... FOR UPDATE —— 重複鍵的 INSERT 已經拿了 S 鎖，
            //    同時撞進來的幾個請求都拿著 S、都在等 X → 死鎖（2.6.2 的形狀，4.5.3）
            Claim c = newTx.execute(s -> existing(buyerId, key, requestHash, clock.instant()));
            if (c != null) return c;                                        // null：那一列剛好被刪掉了（前一個請求失敗），再搶一次
        }
        return new InProgress();
    }

    record Row(String requestHash, String status, Long orderId, Instant lockedUntil, Instant expiresAt) {}

    private Claim existing(long buyerId, String key, String requestHash, Instant now) {
        // 用 RowMapper + getTimestamp()，不用 queryForList：Connector/J 8 的 getObject() 把 DATETIME 給成 LocalDateTime（4.5.2）
        List<Row> rows = jdbc.query("""
                SELECT request_hash, status, order_id, locked_until, expires_at FROM idempotency_keys
                 WHERE buyer_id = ? AND idem_key = ?""",
                (rs, i) -> new Row(rs.getString(1), rs.getString(2), (Long) rs.getObject(3, Long.class),
                        rs.getTimestamp(4) == null ? null : rs.getTimestamp(4).toInstant(), rs.getTimestamp(5).toInstant()),
                buyerId, key);
        if (rows.isEmpty()) return null;
        Row r = rows.get(0);
        if (r.expiresAt().isBefore(now)) {                                 // AC-6：超過 24 小時，當成新的鍵（條件式：只有一個請求接得到）
            int n = jdbc.update("""
                    UPDATE idempotency_keys SET request_hash = ?, status = 'PROCESSING', order_id = NULL, locked_until = ?, expires_at = ?
                     WHERE buyer_id = ? AND idem_key = ? AND expires_at < ?""",
                    requestHash, Timestamp.from(now.plus(LEASE)), Timestamp.from(now.plus(RETENTION)), buyerId, key, Timestamp.from(now));
            return n == 1 ? new Claimed() : new InProgress();
        }
        if (!requestHash.equals(r.requestHash()))
            throw new ShopException(ProblemType.IDEMPOTENCY_KEY_REUSED, "這個 Idempotency-Key 已經用於另一個內容不同的請求");  // AC-2
        if ("SUCCEEDED".equals(r.status())) return new Existing(r.orderId());   // AC-1
        if (r.lockedUntil().isAfter(now)) return new InProgress();          // AC-3
        // 租約過期：前一個處理者死掉了（行程被殺、交易逾時）。接手 —— 同樣是條件式，只有一個請求接得到
        int n = jdbc.update("""
                UPDATE idempotency_keys SET locked_until = ?
                 WHERE buyer_id = ? AND idem_key = ? AND status = 'PROCESSING' AND locked_until <= ?""",
                Timestamp.from(now.plus(LEASE)), buyerId, key, Timestamp.from(now));
        return n == 1 ? new Claimed() : new InProgress();
    }
```

三個改變：

1. **INSERT 在自己的交易裡**，撞到重複鍵就結束那個交易（`return false`）。S 鎖隨著交易結束而釋放。
2. **讀取改成一般的 SELECT**（不加鎖）。讀到的值可能在下一瞬間就過時了 —— 沒關係，因為：
3. **所有「接手」都是條件式 UPDATE**。第一版的「過期接手」與「租約接手」是無條件的 `UPDATE ... WHERE buyer_id = ? AND idem_key = ?`：
   兩個請求同時看到租約過期，**兩個都會接手**。現在的 `AND locked_until <= ?` 讓只有一個人的 UPDATE 影響 1 列，另一個拿到 `InProgress`（409）。

第一版靠 `FOR UPDATE` 讓「讀 → 判斷 → 寫」變成原子的，代價是死鎖。修正版放棄了原子的讀，**把原子性移到寫的那一句**：這就是 4.2.1 ⑥ 與 0.5.5 用的同一招。

`rows.isEmpty()` 的那個 `null` 處理一個很窄的窗口：INSERT 撞到重複鍵的時候那一列還在，到 SELECT 的時候它**已經被 `release()` 刪掉了**（前一個請求失敗）。這時再搶一次 INSERT。

```bash
mvn test -Dtest='CapstoneAcceptanceTest#q3*'
```

```
Q3：先後送兩次 → 201 20260930-115890、200 20260930-115890；同鍵不同內容 → 422 /problems/idempotency-key-reused
Q3：同一個鍵同時送 10 次 → {201=1, 409（Retry-After: 1）=9}；出現過的訂單編號 [20260930-392945]；資料庫裡這位買家的訂單 2 張
```

- **先後送兩次**：201、200，**同一個訂單編號**。第二次送的價格是 `100.00`（第一次是 `100`）—— 4.4.3 的正規化讓它們是同一個請求。
- **同鍵不同內容**：422 `/problems/idempotency-key-reused`。
- **連點 10 次**：1 個 201、9 個 409 並帶 `Retry-After: 1`、**0 個 500**。前端照 `Retry-After` 等一秒再送，會拿到 200 與同一張訂單。

用 `curl` 看一次重送與不同內容（接著 4.4.5 那張訂單）：

```
--- 同一個鍵再送一次
{"orderNo":"20260930-663500","status":"PENDING_PAYMENT","t… [200]
--- 同一個鍵、不同內容
{"type":"/problems/idempotency-key-reused","title":"冪等鍵已用於不同的請求","status":422,"detail":"這個 Idempotency-Key 已經用於另一個內容不同的請求","instance":"/api/orders"} [422]
```

> 📌 **Redis 也能做冪等鍵**（`SET key value NX PX 30000`，[10-redis/10](../10-redis/10-rate-limit-and-idempotency.md)），而且更快。本專題放在 MySQL，理由是 `complete()`：
> 「鍵變成 `SUCCEEDED`」必須跟「訂單 commit」**在同一個交易裡**，而 Redis 不參與 MySQL 的交易。
> 用 Redis 的話，「訂單已 commit、Redis 還沒寫」的那個窗口要另外處理 —— 那是第 07 章 Outbox 在解決的同一類問題。
> 下單不是熱點操作（熱點在 `inventory` 那一列），多一次主鍵的 INSERT 不是瓶頸。

---

## 4.6 狀態轉移與付款回呼

### 4.6.1 `OrderTransitionService`：0.5.5 的硬規則

下單之後，訂單的每一次狀態改變 —— 付款、取消、撿貨、出貨、收貨、逾時、自動完成 —— 都走同一個方法：

```java
package com.example.shop.ordering.internal;

/**
 * 4.6 把一個事件套用到一張訂單上。0.5.5 的硬規則：
 *   UPDATE orders SET status = :to, ..., version = version + 1 WHERE id = :id AND status = :from
 * 影響 0 列 = 狀態已經被別人改了 → 重新讀取，再問一次狀態機（最多 3 次）。
 * 同一個交易裡完成 0.5.4 表格左欄的所有副作用（預留、歷史、退款單）。
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

    record Current(OrderStatus status, String trackingNo) {}

    // …建構子注入 JdbcTemplate、InventoryApi、PaymentApi、OrderHistory、Clock…

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
                            cur.status() == OrderStatus.CANCELLED ? RefundReason.LATE_PAYMENT : RefundReason.DUPLICATE_PAYMENT);
                    return cur.status();
                }
                case TRANSITION -> {
                    Instant now = clock.instant();
                    if (update(orderId, cur.status(), d.to(), event, data, now) == 1) {
                        sideEffects(orderId, cur.status(), d, event, data);
                        history.record(orderId, cur.status(), d.to(), event.name(), actor, now);
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
        List<Map<String, Object>> rows = jdbc.queryForList("SELECT status, tracking_no FROM orders WHERE id = ?" + lock, orderId);
        if (rows.isEmpty()) throw ShopException.notFound("訂單");
        return new Current(OrderStatus.valueOf((String) rows.get(0).get("status")), (String) rows.get(0).get("tracking_no"));
    }
```

（建構子、`cancelReason()`（事件 → `cancel_reason` 的值，對應 V5 的 `ck_orders_cancel_reason_values`）與 `rejectMessage()`（US-ORD-4 AC-3 指定的那句訊息）沒有列出來。`OrderTransitionService` 全文在 4.10.1。）

一次 `apply()` 的流程：

1. **讀**目前的狀態。
2. **問狀態機**（4.3.4）。`same` 只有 E7 需要在這裡判斷（物流單號跟已出貨的一樣嗎）；E1 的「同一筆」在更早的地方就被處理掉了（4.6.3）。
3. **照答案做**：
   - ✗ → 409，帶目前的狀態與事件；
   - ＝ 或 · → 什麼都不做，回傳目前的狀態；
   - ↺ → 建一筆退款；
   - → X → **條件式 UPDATE**。
4. UPDATE **影響 1 列** → 做副作用、寫歷史、結束。**影響 0 列** → 回到第 1 步。

第 4 步是 0.5.5 那條規則的全部：**不相信第 1 步讀到的值。** 讀到 `PENDING_PAYMENT` 不代表寫的時候還是 `PENDING_PAYMENT`；
`WHERE status = ?` 讓資料庫在寫的那一刻再檢查一次，而 InnoDB 的行鎖保證兩個同時寫的交易**只有一個**會影響到那一列。

條件式 UPDATE 依目標狀態多寫幾個欄位 —— 照 V5 的 CHECK（`ck_orders_paid`：`PAID` 以後的狀態 `paid_at` 不可為空；`ck_orders_shipment`；`ck_orders_cancel_reason`）：

```java
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
```

- **`version = version + 1`**：`Order` Entity 有 `@Version`（2.4.2）。JDBC 改了狀態也要跟著加版本號，否則任何一段拿著舊 Entity 的 JPA 程式碼 `save()` 回去時，會**默默蓋掉**這次的轉移。
  維護版本號，讓那種寫入變成 `ObjectOptimisticLockingFailureException`，而不是一個看不見的 lost update（[08-jpa-mybatis/06](../08-jpa-mybatis/06-jpa-performance-and-locking.md) 6.6.10「非 JPA 的寫入路徑」）。
- **為什麼用 JDBC、不用 JPA 改狀態？** JPA 的 dirty checking 產生的是 `UPDATE ... WHERE id = ? AND version = ?`，它能偵測「有人改過」，但不能表達「**只有在狀態是 X 的時候才改**」。
  版本衝突時，JPA 只告訴你「有人改了」—— 你還是得重讀、重新判斷。條件式 UPDATE 把判斷直接寫進 `WHERE`，結果就是影響列數。
- **`PENDING_PAYMENT` 那一行是給編譯器看的**：`switch` 表達式要窮舉（4.3.4），而狀態機保證不會有任何 `Decision` 的目標是它。

「重讀」為什麼第一次用一般的 SELECT、之後用 `FOR UPDATE` —— 那是 4.2.5 最後那 300 個失敗的回呼，下一節。

### 4.6.2 REPEATABLE READ：重讀讀到的，還是同一個快照

`apply()` 的第一版，每一次迴圈都用同一個 `current(orderId)`（一般的 SELECT）：

```java
for (int attempt = 0; attempt < 3; attempt++) {
    Current cur = current(orderId);                              // 第一版：每次都是一般的讀取
    ...
```

邏輯看起來無懈可擊：UPDATE 影響 0 列 → 狀態被改了 → 重讀 → 看到新的狀態 → 查表。4.2.5 的實驗跑出來卻是：

```
── 本專題：條件式 UPDATE + 狀態機（300 回合）──
  第一個例外：com.example.shop.shared.error.ShopException: 訂單狀態正在變動，請稍後再試
  ✗ CANCELLED / 預留 RELEASED / 付款 PENDING / 退款 0                 300 張
  例外 300 次；INV-2：reserved = 0、Σ 有效預留 = 0
```

「訂單狀態正在變動」是迴圈跑完 3 次都沒成功才會丟的例外。**300 個回呼，每一個都重讀了 3 次，每一次都讀到 `PENDING_PAYMENT`** —— 可是資料庫裡那張訂單早就是 `CANCELLED` 了。

把回呼那個交易的時間線攤開：

```
回呼的交易（REPEATABLE READ）                          排程的交易
──────────────────────────────                        ─────────────────────
BEGIN
SELECT ... FROM payments WHERE id = ? FOR UPDATE      BEGIN
  （locking read：不建立快照）
SELECT status FROM orders WHERE id = ?                SELECT status FROM orders → PENDING_PAYMENT
  → PENDING_PAYMENT                                   UPDATE orders SET status = 'CANCELLED'
  ★ 這是這個交易的第一個一般讀取：快照在這一刻建立          WHERE id = ? AND status = 'PENDING_PAYMENT' → 1 列（拿到行鎖）
狀態機：PENDING_PAYMENT + E1 → PAID
UPDATE orders SET status = 'PAID'
  WHERE id = ? AND status = 'PENDING_PAYMENT'
  → 等排程的行鎖……                                     釋放預留、寫歷史
                                                       COMMIT
  → 拿到鎖。UPDATE 讀的是「最新提交的版本」（current read）：
    status = CANCELLED，條件不成立 → 0 列
重讀：SELECT status FROM orders WHERE id = ?
  → 一般讀取，讀★的快照 → PENDING_PAYMENT          ← 問題在這裡
狀態機：→ PAID；UPDATE → 0 列
重讀 → PENDING_PAYMENT；UPDATE → 0 列
throw「訂單狀態正在變動」→ 整個回呼交易 rollback
```

InnoDB 在 REPEATABLE READ 下有兩種讀（[07-mysql/04](../07-mysql/04-transaction-isolation-and-lock.md)）：

- **一般的 SELECT 是快照讀（consistent read）**：讀的是交易裡**第一次一般讀取**時建立的快照。之後別人 commit 了什麼，這個交易都看不到 —— 這正是「可重複讀」的定義。
- **UPDATE、DELETE、`SELECT ... FOR UPDATE` 是當前讀（current read / locking read）**：讀最新提交的版本，並加鎖。

所以同一個交易裡，**UPDATE 看到了 `CANCELLED`（影響 0 列），接下來的 SELECT 卻看到 `PENDING_PAYMENT`**。兩句話對同一列說了不同的事，而且兩句都是對的。
「影響 0 列就重讀」這個模式，在 REPEATABLE READ 底下，**重讀必須是 locking read**，否則它永遠讀不到讓你影響 0 列的那個值。

> ⚠️ **這個 bug 的結局比它看起來的嚴重。** 訂單的狀態是對的（排程贏了、已取消），但回呼的交易整個 rollback —— **`payments` 的 `SUCCEEDED` 沒寫進去，退款也沒建**。
> 錢在金流那一端已經扣了，我們這裡的紀錄是「付款 `PENDING`」。
> 金流收到 409，過幾秒重送；重送那一次是新的交易、新的快照，會正確地走到 `CANCELLED + E1 = ↺`、建立退款。
> 所以在真實環境裡，**這個 bug 會自己好** —— 日誌裡多了幾行 409，沒有人會去看。它只在「金流沒有重送」的那一天變成一筆消失的錢。

**修正**（就是 4.6.1 的版本）：

```java
Current cur = attempt == 0 ? current(orderId) : currentForUpdate(orderId);
```

- **第一次**用一般讀取：沒有衝突的時候（絕大多數），不多拿一次鎖。
- **UPDATE 影響 0 列之後**用 `FOR UPDATE`：當前讀，看到最新提交的狀態（`CANCELLED`），**而且鎖住那一列** —— 接下來的決定不會再被別人改掉。

也可以在第一次就用 `FOR UPDATE`（悲觀的做法），一樣正確，只是每一次轉移都在讀的那一刻就開始持鎖。兩種都對；**錯的只有「重讀用快照讀」這一種**。

> 📌 **另一個修法是把這個交易改成 `READ COMMITTED`**（`@Transactional(isolation = Isolation.READ_COMMITTED)`）：每一句 SELECT 都讀最新提交的版本。
> 本專題不這樣做：全專題統一 REPEATABLE READ（0.10.1 的 `compose.yaml` 明寫），**一個交易的行為不應該取決於它被標了哪個隔離等級**。
> 而且 READ COMMITTED 下，重讀與下一次 UPDATE 之間狀態還是可能再變一次 —— 迴圈還是要有，只是機率變小。`FOR UPDATE` 讓第二次的 UPDATE 一定成功。

修正之後的 E5：

```
── 本專題：條件式 UPDATE + 狀態機（300 回合）──
  ✓ CANCELLED / 預留 RELEASED / 付款 SUCCEEDED / 退款 1               300 張
  例外 0 次；INV-2：reserved = 0、Σ 有效預留 = 0
```

另一次的結果是「299 張 `CANCELLED` + 退款、1 張 `PAID` + `CONFIRMED`」。**兩種結局都是 US-ORD-3 AC-5 允許的**，而且每一張都是其中之一：

- 排程先拿到行鎖 → 訂單取消、預留釋放；回呼的 UPDATE 影響 0 列 → `FOR UPDATE` 重讀看到 `CANCELLED` → 狀態機：`CANCELLED + E1 = ↺` → 建立 `LATE_PAYMENT` 退款。
- 回呼先拿到行鎖 → 訂單 `PAID`、預留 `CONFIRMED`；排程的 UPDATE 影響 0 列 → 重讀看到 `PAID` → 狀態機：`PAID + E4 = ·` → 什麼都不做。

排程贏的比例特別高，是因為回呼的交易多做了一件事（先鎖 `payments`、寫 `SUCCEEDED`），晚一步才碰到 `orders`。

> ⚠️ **重讀修好了，重讀**之後**的那一句讀沒有。** E5 比的是「逾時排程 vs 回呼」：`PAID + E4` 什麼都不做，不需要退款。換成「**買家取消** vs 回呼」，`PAID + 取消` 要退款 —— 而「要退哪一筆」是 `sideEffects()` 裡的 `payments.succeededPaymentOf(orderId)` 查的，一句**一般的 SELECT**。它跟上面那一句重讀在同一個交易裡，用的是同一個快照：交易的第一句一般讀取建立的那一個（第 05 章之後，那一句是 `OrderAccess.buyers()`：查這張訂單是不是你的，5.8.1）。
>
> 回呼的交易如果整個落在「取消的第一句讀」與「取消的 UPDATE」之間：UPDATE 影響 0 列 → `FOR UPDATE` 重讀看到 `PAID` → 狀態機說可以取消、要退款 → `succeededPaymentOf()` 用舊快照，看不到那一筆 `SUCCEEDED` → **不建退款單**。這不是推測：`CancelRefundSnapshotTest` 用一個外層交易先做那一句讀、等另一條執行緒把回呼整個做完，再在同一個交易裡呼叫 `cancelByBuyer()`：
>
> ```
> 取消的第一句讀到 PENDING_PAYMENT；回呼 200；取消 →
>   訂單 CANCELLED、付款 SUCCEEDED、退款單 []
> [已付款、已取消：錢要退]
> Expected size: 1 but was: 0 in:
> ```
>
> **錢收了、訂單取消了、沒有退款單，而且沒有任何錯誤。** 修法跟上面那一句重讀同一個道理 —— 要看最新提交的版本，就用當前讀：`succeededPaymentOf()` 的 SQL 結尾加 `FOR SHARE`。同一個測試：
>
> ```
> 取消的第一句讀到 PENDING_PAYMENT；回呼 200；取消 →
>   訂單 CANCELLED、付款 SUCCEEDED、退款單 [BUYER_CANCEL]
> ```
>
> **加鎖讀會不會帶來死鎖？** 看起來會：回呼拿著付款列的鎖、還沒改到訂單時，取消已經改了訂單、又要 `FOR SHARE` 讀那一列付款 —— 兩邊互等。**但對照狀態機，這個交錯不會發生。** `FOR SHARE` 那一句只在狀態機說「要退款」時才執行（`sideEffects()` 裡的 `d.refund()`），而要退款的取消，訂單一定已經是 `PAID` 或 `PICKING`（`OrderStateMachine`：`PENDING_PAYMENT` 的取消是 `Decision.to(CANCELLED)`，不帶退款；`PAID`、`PICKING` 的取消才是 `toWithRefund`）—— 也就是讓它變成已付款的那個回呼**早就 commit 了**，鎖也放了。
>
> 最接近的情境是**同一張訂單付了兩次錢**：第二筆的回呼鎖住第二筆付款、還沒套用到訂單，取消這時 `FOR SHARE` 掃這張訂單的付款，一定會撞到第二筆。`CancelVsSecondPaymentTest` 把它釘住：回呼鎖住第二筆之後停 500 ms，取消在這段時間裡進來：
>
> ```
> 第二筆的回呼：ok
> 取消：ok
> 訂單 CANCELLED、退款單 [{payment_id=2, reason=BUYER_CANCEL}, {payment_id=3, reason=DUPLICATE_PAYMENT}]
> ```
>
> 沒有死鎖。取消等第二筆的鎖；回呼那一邊，訂單是 `PAID`，`PAID + PAY_SUCCEEDED（另一筆）` 是 `REFUND_ONLY`（「付了兩次錢」）—— 只建一張退款單，**不改訂單那一列**，不需要等取消手上的鎖，互等不成立。（第二筆的退款原因是 `DUPLICATE_PAYMENT`，不是 `LATE_PAYMENT`，因為回呼讀到的訂單還是 `PAID` —— 兩種都是全額退款。）這個測試留在測試組裡，守住「加鎖讀不會讓這個交錯死鎖」。參考實作的 `ch04` 分支上還是改之前的寫法。

### 4.6.3 付款回呼：驗簽、金額、冪等、晚到的錢

**誰接這個回呼？** 0.3.4 寫 `payment` 模組「處理回呼」。但回呼的結果要改訂單狀態，而 `payment` **不能**依賴 `ordering`（依賴表，1.6.2；反過來會形成環）。
0.6.4 又要求「付款 ⇄ 訂單狀態」**強一致、同一個交易** —— 所以不能用事件把兩邊拆開（那是第 07 章「最終一致」的做法）。

結論：**HTTP 入口與協調者在 `ordering`**，「錢」的邏輯在 `payment`：

```java
package com.example.shop.ordering.internal;

/**
 * 4.6.3 金流回呼（US-ORD-2）。payment 模組記錄「錢」，ordering 決定「訂單」—— 同一個交易。
 * 回呼的整個處理只有幾句 SQL，遠小於金流的 3 秒逾時（AC-8）；退款的實際呼叫在第 07 章改成非同步。
 */
@Service
public class PaymentCallbackService {

    private final PaymentApi payments;
    private final OrderTransitionService transitions;

    PaymentCallbackService(PaymentApi payments, OrderTransitionService transitions) {
        this.payments = payments;
        this.transitions = transitions;
    }

    @Transactional
    public void handle(PaymentApi.Callback cb) {
        PaymentApi.Recorded r = payments.record(cb);                       // 驗簽、比對金額、以交易編號冪等
        switch (r.kind()) {
            case DUPLICATE -> { }                                          // AC-5：同一個 providerTxnId 再來一次，什麼都不做
            case FAILED -> transitions.apply(r.orderId(), OrderEvent.PAY_FAILED, OrderHistory.Actor.paymentProvider(),
                    OrderTransitionService.EventData.payment(r.paymentId()));
            case FIRST_SUCCESS -> transitions.apply(r.orderId(), OrderEvent.PAY_SUCCEEDED, OrderHistory.Actor.paymentProvider(),
                    OrderTransitionService.EventData.payment(r.paymentId()));
        }
    }
}
```

```java
/** US-ORD-2：金流回呼。沒有使用者身分 —— 靠 HMAC 簽章證明是金流送來的（AC-3） */
@RestController
class PaymentCallbackController {

    record CallbackRequest(@NotNull Long paymentId, @NotBlank String providerTxnId, @NotNull BigDecimal amount,
                           @NotBlank String result, @NotBlank String signature) {}

    private final PaymentCallbackService service;

    PaymentCallbackController(PaymentCallbackService service) { this.service = service; }

    @PostMapping("/api/payments/callback")
    Map<String, String> callback(@jakarta.validation.Valid @RequestBody CallbackRequest req) {
        service.handle(new PaymentApi.Callback(req.paymentId(), req.providerTxnId(), req.amount(),
                "SUCCEEDED".equals(req.result()), req.signature()));
        return Map.of("status", "received");                   // AC-6：就算訂單已取消，對金流也是「收到了」
    }
}
```

`PaymentCallbackService` 與 `OrderCommands` 是 `public` 的，因為 Controller 在 `ordering.internal.web` —— 另一個套件。它們仍然在 `internal` 底下，**別的模組碰不到**（1.6.2 的 `internals_are_private_to_their_module`）。

**簽章**：

```java
/** US-ORD-2 AC-3：回呼的 HMAC-SHA256 簽章。模擬金流與本服務共用同一把金鑰。 */
public final class CallbackSignature {

    /** 被簽的內容：paymentId|providerTxnId|金額（兩位小數）|結果。金額固定格式，避免 "100" 與 "100.00" 簽出不同的值 */
    public static String canonical(long paymentId, String providerTxnId, BigDecimal amount, boolean succeeded) {
        return paymentId + "|" + providerTxnId + "|" + amount.setScale(2, RoundingMode.UNNECESSARY).toPlainString()
                + "|" + (succeeded ? "SUCCEEDED" : "FAILED");
    }

    public static String sign(String secret, String canonical) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** 固定時間比較：用 equals 比較簽章，比對失敗的「早晚」會洩漏有幾個字元是對的（timing attack） */
    static boolean matches(String expected, String actual) {
        return actual != null && MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII), actual.getBytes(StandardCharsets.US_ASCII));
    }
}
```

- **被簽的內容是一個「正規化」的字串**，不是整個 JSON body。JSON 的欄位順序、空白、數字寫法（`100` / `100.00`，4.2.4）都可能不同，簽 body 的話雙方很容易簽出不一樣的值。
  `setScale(2, RoundingMode.UNNECESSARY)`：金額如果有三位小數，不偷偷四捨五入 —— 那代表對方送來的東西不對。
  但它丟的是 `ArithmeticException`，不是 `ShopException`。`record()` 在驗簽之前就呼叫 `canonical()`，這個例外一路穿到 `GlobalExceptionHandler` 的最後一個處理器：**目前會變成 500**，並記一行「未預期的例外」。
  正確的回應是 400 —— 這是本章留下的已知問題，見練習九。
- **`MessageDigest.isEqual`**：`String.equals` 在第一個不同的字元就返回，比對花的時間洩漏了「前面有幾個字元是對的」—— 攻擊者可以一個字元一個字元地猜出正確的簽章（timing attack）。`isEqual` 不管哪裡不同，都比完全部的位元組。
- **金鑰從設定來**：`ShopProperties.Payment.callbackSecret`，`@Size(min = 32)`；`application-local.yml` 有一把本機用的（`shop.payment.callback-secret: local-dev-only-payment-callback-secret-0123`），`application-prod.yml` 是 `${SHOP_PAYMENT_CALLBACK_SECRET}`（1.7.6：正式環境的祕密只從環境變數來，不進 repo）。
  `ShopProperties.payment` 是 `@NotNull`：少了這個設定，應用程式啟動就會失敗。`ShopProperties` 與兩個 yml 的全文在 4.10.1。

> 📌 **三位小數的金額，修在 `canonical()` 自己身上。**
> 下面的測試類別 `OrderHttpFlowTest` 是第 08 章才有的 HTTP 流程測試；改的地方從本章起就沒動過，在這一章的程式碼上一樣適用：
>
> ```java
> public static String canonical(long paymentId, String providerTxnId, BigDecimal amount, boolean succeeded) {
>     return paymentId + "|" + providerTxnId + "|" + twoDecimals(amount) + "|" + (succeeded ? "SUCCEEDED" : "FAILED");
> }
>
> private static String twoDecimals(BigDecimal amount) {
>     try {
>         return amount.setScale(2, RoundingMode.UNNECESSARY).toPlainString();
>     } catch (ArithmeticException moreThanTwoDecimals) {
>         throw new ShopException(ProblemType.VALIDATION, "金額最多兩位小數");
>     }
> }
> ```
>
> 練習九問「改在哪一層」，三個選項擋得住的路徑不一樣：
>
> | 改在哪 | 擋得住 | 擋不住／副作用 |
> |---|---|---|
> | `CallbackRequest` 上的 `@Digits(integer = 10, fraction = 2)` | HTTP（經過 `@Valid`） | 直接呼叫 `PaymentCallbackService`、`PaymentApi.record()` 的路徑（`OrderFlowTest`、之後各章的工作負載）；`298.000` 也會被擋 —— 原本的 `setScale` 是接受它的 |
> | `record()` 裡接住 `ArithmeticException` | 所有經過 `record()` 的路徑 | 「兩位小數」的規則與檢查分在兩個地方；別的地方再呼叫 `canonical()`（例如簽章的那一邊）還是會 500 |
> | **`canonical()` 自己檢查** | HTTP、直接呼叫、簽章端，全部同一個 400；`298.000` 照樣接受 | —— |
>
> 一個三種做法都避不開的代價：檢查在驗簽**之前**，所以「簽章錯、金額也錯」的請求拿到的是 400，不是 401。
>
> 守住它的測試送 `200.001`、簽章隨便填，斷言 400、`/problems/validation`、付款仍是 `PENDING`、訂單仍是 `PENDING_PAYMENT`。先把測試放到**還沒修**的程式碼上跑：
>
> ```
> 練習九 HTTP：金額 200.001 → 500 {"type":"/problems/internal","title":"系統發生錯誤","status":500,"detail":"系統發生錯誤，請稍後再試","instance":"/api/payments/callback",...}
> [ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 2.427 s <<< FAILURE! -- in com.example.shop.api.OrderHttpFlowTest
> ```
>
> 修了之後：
>
> ```
> 練習九 HTTP：金額 200.001 → 400 {"type":"/problems/validation","title":"請求內容不正確","status":400,"detail":"金額最多兩位小數","instance":"/api/payments/callback",...}
> [INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.323 s -- in com.example.shop.api.OrderHttpFlowTest
> ```
>
> （輸出裡的 `traceId` 省略了。）練習九建議把測試放在 `OrderFlowTest`，這裡放在 `OrderHttpFlowTest`：`OrderFlowTest` 直接呼叫 Service，驗不到 HTTP 的 400。另外加了一個不起 Spring 的 `CallbackSignatureTest`（`100`、`100.0`、`100.00`、`100.000` 簽出同一個值；`298.001` 是 `VALIDATION`）。參考實作的 `ch04` 分支上還是改之前的寫法。

**記錄**（`JdbcPaymentService.record()`）：

```java
@Override
@Transactional(propagation = Propagation.MANDATORY)
public Recorded record(Callback cb) {
    String expected = CallbackSignature.sign(secret, CallbackSignature.canonical(cb.paymentId(), cb.providerTxnId(), cb.amount(), cb.succeeded()));
    if (!CallbackSignature.matches(expected, cb.signature())) {
        log.warn("PAYMENT_SIGNATURE_INVALID paymentId={}", cb.paymentId());       // 第 05 章寫進 audit_logs
        throw new ShopException(ProblemType.UNAUTHENTICATED, "簽章不正確");
    }
    List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT order_id, amount, status, provider_txn_id FROM payments WHERE id = ? FOR UPDATE", cb.paymentId());
    if (rows.isEmpty()) throw ShopException.notFound("付款");
    Map<String, Object> p = rows.get(0);
    long orderId = ((Number) p.get("order_id")).longValue();
    if (((BigDecimal) p.get("amount")).compareTo(cb.amount()) != 0) {
        log.error("PAYMENT_AMOUNT_MISMATCH paymentId={} expected={} actual={}", cb.paymentId(), p.get("amount"), cb.amount());   // AC-4：告警
        throw new ShopException(ProblemType.VALIDATION, "金額與付款不符");
    }
    String status = (String) p.get("status");
    if ("SUCCEEDED".equals(status)) {
        if (cb.providerTxnId().equals(p.get("provider_txn_id"))) return new Recorded(cb.paymentId(), orderId, Recorded.Kind.DUPLICATE);  // AC-5
        throw new ShopException(ProblemType.VALIDATION, "這筆付款已經以另一個交易編號成功");
    }
    if (!cb.succeeded()) {
        jdbc.update("UPDATE payments SET status = 'FAILED', provider_txn_id = ?, failure_reason = 'provider', updated_at = CURRENT_TIMESTAMP(3), version = version + 1 WHERE id = ?",
                cb.providerTxnId(), cb.paymentId());
        return new Recorded(cb.paymentId(), orderId, Recorded.Kind.FAILED);
    }
    jdbc.update("""
            UPDATE payments SET status = 'SUCCEEDED', provider_txn_id = ?, failure_reason = NULL,
                   updated_at = CURRENT_TIMESTAMP(3), version = version + 1
             WHERE id = ?""", cb.providerTxnId(), cb.paymentId());
    return new Recorded(cb.paymentId(), orderId, Recorded.Kind.FIRST_SUCCESS);
}
```

順序的理由：

1. **先驗簽，再碰資料庫。** 偽造的請求連一句 SQL 都不會觸發 —— 不會拿任何鎖，也不會透過「404 vs 401」洩漏哪些 `paymentId` 存在。
2. **`SELECT ... FOR UPDATE` 鎖住那一筆付款。** 金流的重送可能**並行**到達（第一次還沒回應、金流逾時就重送了）。鎖住之後，同一筆付款的回呼一個一個來，第二個會看到 `SUCCEEDED` → `DUPLICATE`。
3. **金額用 `compareTo`**（4.2.4）。
4. **冪等的單位是 `providerTxnId`**（0.3.5 名詞表：「金流交易編號，付款回呼的冪等鍵」）。同一個交易編號再來 → `DUPLICATE`，`ordering` 什麼都不做（AC-5）。

這也是為什麼 `OrderTransitionService` 裡 `PAY_SUCCEEDED` 的 `same` 永遠是 `false`：0.5.3 的「＝ 同一筆」**在 `payment` 模組就被攔下來了**，根本不會變成一個事件。
能走到狀態機的 E1，一定是「**這筆付款第一次成功**」。它碰到的訂單如果已經是 `PAID`，就是**另一筆**付款讓它變成 `PAID` 的 —— 買家付了兩次錢 → ↺。

用 `curl` 試一次（簽章用 `openssl` 算）：

```bash
SECRET=local-dev-only-payment-callback-secret-0123          # application-local.yml 的 shop.payment.callback-secret
NO=20260930-663500                                          # 4.4.5 那張訂單的 orderNo（換成你自己的）
# 建立付款（買家）：回應的 paymentId 就是回呼要帶的 PID
PID=$(curl -s -X POST -H "X-Debug-User-Id: 1001" localhost:8080/api/orders/$NO/payments | sed -E 's/.*"paymentId":([0-9]+).*/\1/')
SIG=$(printf '%s' "$PID|txn-$PID|298.00|SUCCEEDED" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')
curl -s -X POST -H "Content-Type: application/json" \
     -d "{\"paymentId\":$PID,\"providerTxnId\":\"txn-$PID\",\"amount\":298.00,\"result\":\"SUCCEEDED\",\"signature\":\"$SIG\"}" \
     localhost:8080/api/payments/callback
```

```
--- 建立付款
{"paymentId":99050358,"amount":298.00,"payUrl":"https://pay.example.test/simulated/99050358"} [201]
--- 簽章錯誤的回呼
{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"簽章不正確","instance":"/api/payments/callback"} [401]
--- 金額被改成 1.00
{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"簽章不正確","instance":"/api/payments/callback"} [401]
--- 付款成功的回呼
[200] 0.021620s
--- 金流重送同一個回呼
[200] 0.007829s
```

**「金額被改成 1.00」回的是 401，不是 AC-4 寫的 400。** 這不是 bug：金額是被簽的內容之一，改了金額，簽章就不對了。
那 AC-4 的 400 什麼時候會發生？只有在**簽章正確、金額卻不符**的時候 —— 也就是金流**用正確的金鑰簽了一個錯的金額**。那只有兩種可能：金流的 bug，或是**金鑰外洩了**。
所以這一行是 `log.error` 而不是 `warn`，而且第 09 章會為它設告警。`OrderFlowTest`（4.9）用正確的金鑰簽一個錯的金額，確認這條路徑真的回 400、訂單不變。

回呼的處理時間：第一次 **22 ms**、重送 **8 ms**，遠低於 AC-8 的「3 秒內回應」。交易裡只有 SQL：驗簽（CPU）、鎖付款、改付款、條件式改訂單、確認預留、寫歷史。

> 📌 **`paymentId` 是一個會出現在回應裡的內部流水號**，這跟 3.3.1「內部 `id` 不出現在回應裡」的原則不一致。
> 這是刻意的例外：它是要傳給金流的「商店端參考編號」，而回呼**必須**帶正確的簽章才有效 —— 知道 `paymentId` 本身不能拿來做任何事。
> 真實的金流通常要求商店提供自己的 `merchantTradeNo`，練習七會把它換成一個隨機編號。

**退款單**：

```java
@Override
@Transactional(propagation = Propagation.MANDATORY)
public void requestRefund(long paymentId, RefundReason reason) {
    // INSERT ... SELECT：金額與訂單從付款那一列來。uk_refunds_payment 讓重複呼叫只留下一筆：
    // 撞到這個鍵時什麼都不做（ON DUPLICATE KEY UPDATE 一個 no-op）。
    // 不用 INSERT IGNORE —— 它會把「所有」錯誤降級成警告，包括 CHECK 違反（那一列會被默默跳過）。
    jdbc.update("""
            INSERT INTO refunds (payment_id, order_id, amount, reason, status)
            SELECT id, order_id, amount, ?, 'PENDING' FROM payments WHERE id = ? AND status = 'SUCCEEDED'
            ON DUPLICATE KEY UPDATE payment_id = refunds.payment_id""",
            reason.name(), paymentId);
}
```

- **金額從付款那一列來**，不從呼叫端傳。退款永遠是**那一筆付款的全額**（0.7：退貨與部分退款不在範圍內）。
- **一筆付款最多一筆退款**：`uk_refunds_payment`（V6）。同一筆付款被要求退兩次（例如取消的回呼重送），第二次撞到唯一鍵，`ON DUPLICATE KEY UPDATE payment_id = refunds.payment_id` 什麼都不改。
- **不用 `INSERT IGNORE`**。它看起來是同一件事，但它會把**所有**錯誤降級成警告：`reason` 違反了 `ck_refunds_reason`、`amount` 違反了 CHECK —— 那一列會被**默默跳過**，退款就這樣不見了。
  `ON DUPLICATE KEY UPDATE` 只處理重複鍵，其他錯誤照常丟出來。

**退款的「執行」不在這一章。** 這裡只建立 `refunds(PENDING)`。呼叫金流退款 API 是一個外部呼叫，**不能在交易裡**（0.5.4 的 ⚠️），第 07 章由 Outbox 的消費者非同步執行、失敗重試。

### 4.6.4 副作用：預留的三個動作

0.5.4 表格的左欄，在 `OrderTransitionService.sideEffects()` 裡：

```java
    /** 0.5.4 表格的左欄：必須跟狀態一起 commit 的事 */
    private void sideEffects(long orderId, OrderStatus from, Decision d, OrderEvent event, EventData data) {
        switch (d.to()) {
            case PAID -> inventory.confirm(orderId);                        // HELD → CONFIRMED：從此不能被逾時釋放（US-ORD-3 AC-4）
            case SHIPPED -> inventory.consume(orderId);                     // onHand、reserved 同時減少（US-ORD-6 AC-2）
            case CANCELLED -> {
                inventory.release(orderId);
                if (d.refund()) payments.succeededPaymentOf(orderId).ifPresent(pid -> payments.requestRefund(pid,
                        event == OrderEvent.BUYER_CANCEL ? RefundReason.BUYER_CANCEL : RefundReason.SELLER_CANCEL));
            }
            default -> { }
        }
    }
```

`inventory` 那一邊（`JdbcInventoryService`）：

```java
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
    for (Held h : held(orderId, "'HELD', 'CONFIRMED'")) {
        jdbc.update("UPDATE inventory SET reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = ?",
                h.quantity(), h.productId());
        jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
        ledger(h.productId(), 0, -h.quantity(), "RELEASE", "order:" + orderId);
    }
}

@Override
@Transactional(propagation = Propagation.MANDATORY)
public void consume(long orderId) {
    for (Held h : held(orderId, "'CONFIRMED'")) {
        jdbc.update("""
                UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3)
                 WHERE product_id = ?""", h.quantity(), h.quantity(), h.productId());
        jdbc.update("UPDATE inventory_reservations SET status = 'CONSUMED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
        ledger(h.productId(), -h.quantity(), -h.quantity(), "SHIP", "order:" + orderId);
    }
}

record Held(long id, long productId, int quantity) {}

/**
 * 這張訂單還佔著庫存的預留，依 productId 排序。先鎖預留列（FOR UPDATE），再依序改 inventory：
 * 同一張訂單的兩個釋放（例如兩個排程實例）會在第一句就排隊，第二個進來時看到的已經是 RELEASED —— 不會重複減。
 * 註：這裡的 statuses 只會是程式裡的常數，不是使用者輸入。
 */
private List<Held> held(long orderId, String statuses) {
    return jdbc.query("""
            SELECT id, product_id, quantity FROM inventory_reservations
             WHERE order_id = ? AND status IN (%s) ORDER BY product_id FOR UPDATE""".formatted(statuses),
            (rs, i) -> new Held(rs.getLong(1), rs.getLong(2), rs.getInt(3)), orderId);
}
```

- **`release()` 釋放 `HELD` 與 `CONFIRMED`**：待付款的取消釋放 `HELD`，已付款的取消（買家、賣家）釋放 `CONFIRMED`。已經 `RELEASED` 或 `CONSUMED` 的不碰 —— 所以 `release()` 是**冪等**的。
- **`held()` 用 `FOR UPDATE` 鎖住預留列**，而且依 `product_id` 排序（4.2.3 的規則，這次用在預留列上）。這是這個模組**唯一**防止「同一張訂單被釋放兩次」的地方：
  兩個交易同時釋放同一張訂單，第二個會卡在這句 SELECT，等第一個 commit 之後再讀 —— `FOR UPDATE` 是當前讀（4.6.2），它看到的已經是 `RELEASED`，回傳空清單。
- **`consume()` 同時減 `on_hand` 與 `reserved`**（US-ORD-6 AC-2），庫存帳記 `SHIP (−n, −n)`。
- **`confirm()` 不記庫存帳**：`HELD → CONFIRMED` 不改變任何數量，只改變「能不能被逾時釋放」。
- `InventoryApi` 與 `JdbcInventoryService` 的全文（含第 01～03 章就有的方法）在 4.10.1。

> 📌 **`OrderTransitionService` 的條件式 UPDATE 已經保證「一張訂單只會被取消一次」了，`held()` 的 `FOR UPDATE` 是不是多餘的？**
> 對 `ordering` 來說是。但 `InventoryApi.release()` 是一個**公開介面**，它的正確性不應該依賴「呼叫端剛好有做對」。
> 一個模組的不變量（INV-2）由那個模組自己守 —— 0.5.1 的 📌「一個不變量只能有一個主人」。

### 4.6.5 走完一張訂單：兩個在回應裡的坑

`OrderCommands` 是買家與賣家「對自己的訂單下指令」的入口：

```java
/** 買家與賣家對「自己的」訂單下的指令。別人的訂單一律 404（US-ORD-4 AC-5）。 */
@Service
public class OrderCommands {

    // …建構子注入 OrderRepository、OrderTransitionService、OrderQueryService、PaymentApi…

    /**
     * 只查 id，不載入 Entity（4.6.5）：狀態轉移用 JDBC 的條件式 UPDATE 改資料庫，
     * 如果這裡把 Order 載進了 persistence context，之後同一個交易裡的 queries.byId() 會拿到那個「改之前」的 Entity。
     */
    private long buyers(long buyerId, String orderNo) {
        return orders.findIdByOrderNoAndBuyerId(orderNo, buyerId).orElseThrow(() -> ShopException.notFound("訂單"));
    }

    private long sellers(long sellerId, String orderNo) {
        return orders.findIdByOrderNoAndSellerId(orderNo, sellerId).orElseThrow(() -> ShopException.notFound("訂單"));
    }

    @Transactional
    public OrderView cancelByBuyer(long buyerId, String orderNo) {                     // US-ORD-4
        long id = buyers(buyerId, orderNo);
        transitions.apply(id, OrderEvent.BUYER_CANCEL, OrderHistory.Actor.buyer(buyerId), EventData.cancel("BUYER"));
        return queries.byId(id);
    }

    @Transactional
    public OrderView confirmReceipt(long buyerId, String orderNo) {                    // US-ORD-6 AC-3
        long id = buyers(buyerId, orderNo);
        transitions.apply(id, OrderEvent.CONFIRM_RECEIPT, OrderHistory.Actor.buyer(buyerId), EventData.NONE);
        return queries.byId(id);
    }

    @Transactional
    public PaymentStarted startPayment(long buyerId, String orderNo) {                 // US-ORD-2 AC-1
        long id = buyers(buyerId, orderNo);
        Order o = orders.findById(id).orElseThrow();
        if (o.getStatus() != OrderStatus.PENDING_PAYMENT)
            throw new ShopException(ProblemType.INVALID_STATE, "這張訂單不是待付款狀態").with("orderStatus", o.getStatus());
        PaymentApi.CreatedPayment p = payments.create(id, o.getTotalAmount());
        return new PaymentStarted(p.paymentId(), p.amount(), p.payUrl());
    }

    // startPicking、ship、cancelBySeller：同樣的形狀，用 sellers(sellerId, orderNo)
}
```

```java
@Query("select o.id from Order o where o.orderNo = :orderNo and o.buyerId = :buyerId")
Optional<Long> findIdByOrderNoAndBuyerId(@Param("orderNo") String orderNo, @Param("buyerId") long buyerId);
```

（賣家版 `findIdByOrderNoAndSellerId` 同形狀。`OrderCommands`（含賣家的三個方法：`startPicking`、`ship`、`cancelBySeller` —— 賣家取消固定記 `SELLER_OUT_OF_STOCK`，US-ORD-6 AC-5）與 `OrderRepository` 的全文在 4.10.1。）

第一次用 `curl` 走完一張訂單的一生（下單 → 付款 → 撿貨 → 出貨 → 收貨），有兩個回應是錯的。

**坑一：一個回應裡有兩個 `status`**

撿貨中的買家取消（US-ORD-4 AC-3），第一版的回應：

```
{"type":"/problems/invalid-state","title":"目前的狀態不允許這個動作","status":409,"detail":"訂單已進入出貨流程，無法取消；請於收貨後申請退貨","instance":"/api/orders/20260929-941271/cancel","status":"PICKING","event":"BUYER_CANCEL"} [409]
```

`"status":409` 是 Problem Details 的標準欄位（RFC 9457：HTTP 狀態碼）；`"status":"PICKING"` 是第一版 `.with("status", cur.status())` 加上去的「目前的訂單狀態」。
Spring 的 `ProblemDetail` 把額外的屬性放在一個 `Map` 裡、用 `@JsonAnyGetter` 攤平 —— **它不檢查名字有沒有跟標準欄位撞**。

JSON 規格（RFC 8259）說物件的鍵「應該」唯一，但沒有規定重複時怎麼辦。實際上的行為：

```javascript
// Node 22
const p = JSON.parse('{"type":"/problems/invalid-state","status":409,"status":"PICKING"}');
console.log(p.status, typeof p.status, p.status >= 400)
```

```
PICKING string false
```

JavaScript 的 `JSON.parse` 與 Python 的 `json.loads` 都是**後面的蓋掉前面的**。前端寫的 `if (problem.status >= 500) showRetryButton()` —— `"PICKING" >= 500` 是 `false`；
任何依 `status` 分流的錯誤處理，拿到的都是一個字串。

修正是改名（`orderStatus`、`event`；第 03 章 `ProductService.unpublish()` 的 `"status"` 也一起改成 `productStatus`），並且讓這件事**不能再發生**：

```java
public class ShopException extends RuntimeException {

    /** RFC 9457 的標準欄位。額外的屬性跟它們同名，JSON 裡就會出現兩個同名的鍵（4.6.5：前端讀到 "status": "PICKING"） */
    static final Set<String> RESERVED = Set.of("type", "title", "status", "detail", "instance");

    // …

    public ShopException with(String key, Object value) {
        if (RESERVED.contains(key)) throw new IllegalArgumentException("「" + key + "」是 Problem Details 的標準欄位，請換一個名字（例如 orderStatus）");
        properties.put(key, value);
        return this;
    }
```

`ShopExceptionTest` 對五個保留名各測一次（`ShopException` 與 `ShopExceptionTest` 的全文在 4.10.1）。用錯名字的那一行，會在**第一次執行**時就丟 `IllegalArgumentException`（500）—— 比一個安靜地蓋掉 `status` 的 409 容易發現得多。

**坑二：確認收貨之後，回應說「已出貨」**

第一版的 `buyers()` 是「載入 Entity、檢查是不是你的」：

```java
private Order buyers(long buyerId, String orderNo) {
    return orders.findByOrderNo(orderNo).filter(o -> o.getBuyerId() == buyerId)
            .orElseThrow(() -> ShopException.notFound("訂單"));
}
```

確認收貨的回應與資料庫：

```
--- confirm
{"orderNo":"20260929-941271","status":"SHIPPED","totalAmount":298.00,"createdAt":"2026-09-29T10:45:5…
event	from_status	to_status	actor_type
…
SHIP	PICKING	SHIPPED	SELLER
CONFIRM_RECEIPT	SHIPPED	COMPLETED	BUYER
```

**資料庫說 `COMPLETED`，回應說 `SHIPPED`。** 同一個交易裡發生了這些事：

1. `findByOrderNo()` 把 `Order` 載進 persistence context（一級快取，[08-jpa-mybatis/03](../08-jpa-mybatis/03-persistence-context-and-lifecycle.md)），`status = SHIPPED`。
2. `transitions.apply()` 用 **JDBC** 把資料庫裡的 `status` 改成 `COMPLETED`。JPA 完全不知道這件事。
3. `queries.byId(id)` 呼叫 `orders.findById(id)` —— 同一個交易、同一個 persistence context、同一個 id → **直接回傳第 1 步那個 Entity**，不會再查資料庫。

這是 3.7.2「JPA 與 MyBatis 在同一個交易裡」的另一個方向：3.7.2 是 JPA 寫了、MyBatis 讀不到；這裡是 JDBC 寫了、JPA 讀到舊的。

修正是**不讓 Entity 進入 persistence context**：`findIdByOrderNoAndBuyerId` 只查一個 `Long`（JPQL 的純量查詢不會產生受管理的 Entity）。
之後的 `queries.byId()` 是這個交易裡第一次載入 `Order`，讀到的就是 JDBC 改過的值。

其他修法：`entityManager.refresh(order)`、`entityManager.clear()`。它們都對，但都要求寫程式的人**記得**在 JDBC 寫入之後做一件事。只查 id 讓「忘記」變成不可能。

`startPayment()` 仍然載入了 Entity（要讀 `status` 與 `totalAmount`），但它之後沒有任何 JDBC 寫入 `orders`，所以沒有這個問題。

**修正之後，完整走一次**（4.4.5 那張訂單接著走）。賣家的指令把身分換成那個商品的賣家 —— 種子資料的商品 1 屬於賣家 `2` —— 並帶 `X-Debug-Roles: SELLER`：

```bash
NO=20260930-663500                                          # 換成你自己的 orderNo
# 賣家：開始撿貨、出貨、取消（取消要換一張已付款、還沒出貨的訂單才會成功）
curl -s -X POST -H "X-Debug-User-Id: 2" -H "X-Debug-Roles: SELLER" localhost:8080/api/seller/orders/$NO/start-picking
curl -s -X POST -H "X-Debug-User-Id: 2" -H "X-Debug-Roles: SELLER" -H "Content-Type: application/json" \
     -d '{"carrier":"黑貓","trackingNo":"T123456789"}' localhost:8080/api/seller/orders/$NO/ship
curl -s -X POST -H "X-Debug-User-Id: 2" -H "X-Debug-Roles: SELLER" localhost:8080/api/seller/orders/$NO/cancel
# 買家：取消、確認收貨
curl -s -X POST -H "X-Debug-User-Id: 1001" localhost:8080/api/orders/$NO/cancel
curl -s -X POST -H "X-Debug-User-Id: 1001" localhost:8080/api/orders/$NO/confirm-receipt
```

「同一個單號再出貨一次」就是把出貨那一支原封不動再送一次；「換一個單號出貨」把 `trackingNo` 改掉。

```
--- 賣家開始撿貨
status=PICKING [200]
--- 撿貨中買家取消
{"type":"/problems/invalid-state","title":"目前的狀態不允許這個動作","status":409,"detail":"訂單已進入出貨流程，無法取消；請於收貨後申請退貨","instance":"/api/orders/20260930-663500/cancel","orderStatus":"PICKING","event":"BUYER_CANCEL"} [409]
--- 出貨
status=SHIPPED [200]
--- 同一個單號再出貨一次
status=SHIPPED [200]
--- 換一個單號出貨
{"type":"/problems/invalid-state","title":"目前的狀態不允許這個動作","status":409,"detail":"訂單目前的狀態（SHIPPED）不允許這個動作","instance":"/api/seller/orders/20260930-663500/ship","orderStatus":"SHIPPED","event":"SHIP"} [409]
--- 確認收貨
status=COMPLETED [200]
--- 資料庫
event	from_status	to_status	actor_type
PLACE_ORDER	NULL	PENDING_PAYMENT	BUYER
PAY_SUCCEEDED	PENDING_PAYMENT	PAID	PAYMENT_PROVIDER
START_PICKING	PAID	PICKING	SELLER
SHIP	PICKING	SHIPPED	SELLER
CONFIRM_RECEIPT	SHIPPED	COMPLETED	BUYER
reservation
CONSUMED
reason	delta_on_hand	delta_reserved
RESERVE	0	2
SHIP	-2	-2
status	provider_txn_id
SUCCEEDED	txn-99050358
```

對照 0.5 與 0.5.4：

- **歷史**：五個事件、五筆紀錄，每一筆都有 from、to、事件、操作者（US-ORD-6 AC-6）。金流的重送、同單號的重複出貨都是 ＝，**沒有**寫歷史。
- **預留**：`HELD → CONFIRMED → CONSUMED`（0.3.5 名詞表的預留生命週期）。
- **庫存帳**：`RESERVE (0, +2)`、`SHIP (−2, −2)`。INV-3 的 `onHand` = Σ `delta_on_hand` 仍然成立。
- **付款**：`SUCCEEDED`，交易編號記下來了。
- `PICKING + E3 = ✗` 回的是 0.4.5 指定的訊息「已進入出貨流程」；`SHIPPED + E7` 同單號 ＝、不同單號 ✗（0.5.3）。

---

## 4.7 排程：付款逾時與自動完成

### 4.7.1 `OrderJobs`

```java
package com.example.shop.ordering.internal;

/**
 * 4.7 兩個排程：付款逾時取消（US-ORD-3）、出貨 7 天自動完成（US-ORD-6 AC-4）。
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

    OrderJobs(JdbcTemplate jdbc, OrderTransitionService transitions, Clock clock, ShopProperties props) {
        this.jdbc = jdbc;
        this.transitions = transitions;
        this.clock = clock;
        this.interval = props.order().timeoutScanInterval();
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(this::cancelExpired, interval);
        registrar.addFixedDelayTask(this::autoComplete, interval);
    }

    /** 走 idx_orders_status_deadline（2.7.2：covering index range scan） */
    int cancelExpired() {
        List<Long> ids = jdbc.queryForList("""
                SELECT id FROM orders WHERE status = 'PENDING_PAYMENT' AND payment_deadline < ?
                 ORDER BY payment_deadline LIMIT ?""", Long.class, Timestamp.from(clock.instant()), BATCH);
        return applyEach(ids, OrderEvent.PAYMENT_TIMEOUT);
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
            }
        }
        if (!ids.isEmpty()) log.info("排程 {}：掃到 {} 張，轉移 {} 張", event, ids.size(), changed);   // 其他實例搶先處理的，算在「掃到」不算在「轉移」
        return changed;
    }
}
```

**五個決定**：

**① 撈 id 不在交易裡，每一張訂單各自一個交易。**
一個交易取消 100 張訂單，任何一張失敗，另外 99 張都會 rollback。而且那個交易會拿著 100 張訂單、以及它們所有商品的 `inventory` 列的鎖，**一直拿到最後一張處理完** —— 一個熱點商品的 15 分鐘前的訂單，會讓那個商品在排程執行的這段時間裡都下不了單。
每張一個交易：每個交易只鎖一張訂單和它自己的幾個商品，持鎖時間是毫秒等級。

> ⚠️ **「一張失敗不影響其他張」只對了一半。** 每張訂單各自一個交易是對的 —— 一張 rollback 不會帶走別張。但 `applyEach()` 只接 `ShopException`（業務上的拒絕：狀態不允許、訂單不存在）。資料庫錯誤 —— 死鎖、鎖等待逾時（4.2.3、4.5.3 都量過它們會發生）—— 是 Spring 的 `DataAccessException`，不在裡面：它會**跳出整個迴圈**，同一批後面的訂單這一輪都不處理。
>
> 在單體裡，後果通常只是「晚 30 秒」：下一輪會再撈到它們。除非失敗的那一張**每一輪都失敗** —— 它排在最前面（`ORDER BY payment_deadline`），後面的就一直等。庫存切成另一個服務之後（第 13 站），`release()` 變成一次遠端呼叫，遠端呼叫的每一種失敗（逾時、連不上、對方 500）都是這一種例外。
>
> `OrderJobsIsolationTest`（`ordering.internal`）把它釘住：兩張過期的訂單，用一個 trigger 讓第一張的取消在資料庫裡失敗（寫狀態歷史的那一句被拒絕），看第二張。修正前：
>
> ```
> [ERROR]   OrderJobsIsolationTest.oneFailureDoesNotStopTheBatch:53 » UncategorizedSQL PreparedStatementCallback; uncategorized SQLException for SQL [INSERT INTO order_status_history (order_id, from_status, to_status, event, actor_type, actor_id, created_at)
> VALUES (?, ?, ?, ?, ?, ?, ?)]; SQL state [45000]; error code [1644]; jobs-isolation: injected failure
> ```
>
> 例外從 `cancelExpired()` 跳了出來 —— 第二張沒有被處理。修法是多接一層：
>
> ```diff
>              } catch (ShopException e) {
>                  log.warn("排程 {} 處理訂單 {} 失敗：{}", event, id, e.getMessage());
> +            } catch (RuntimeException e) {
> +                // 4.7.1 ① 的追記：資料庫錯誤（死鎖、鎖等待逾時）也只算這一張 —— 第一版只接 ShopException，
> +                // 這一種例外會跳出迴圈，同一批後面的訂單這一輪都不處理（OrderJobsIsolationTest）。下一輪會再撈到它
> +                log.error("排程 {} 處理訂單 {} 發生錯誤（下一輪再試）", event, id, e);
>              }
> ```
>
> ```
> 4.7.1 ①：取消了 1 張；第一張（注入失敗）PENDING_PAYMENT、第二張 CANCELLED
> ```
>
> 業務上的拒絕記 WARN、其他的記 ERROR：前者是「這張單現在不能取消」（正常），後者是「有東西壞了」（要有人看）。參考實作的 `ch04` 分支上還是改之前的寫法。

**② 走的是跟「買家取消」同一條路**（`transitions.apply()`）。排程沒有自己的 `UPDATE`，所以 4.6 的每一條規則 —— 條件式 UPDATE、locking read 重讀、狀態機、副作用、歷史 —— 自動適用。
`OrderHistory.Actor.system()` 讓歷史記下「是排程做的」。

**③ 間隔從 `ShopProperties` 來，而不是 `@Scheduled(fixedDelayString = "${...}")`。**
`timeoutScanInterval` 是一個 `Duration`，有 `@DurationMin(seconds = 10)`（1.7.3）。啟動時就會驗證它，寫成 `3` 或 `30ms` 都會啟動失敗。
`@Scheduled` 的字串不經過這個驗證，打錯了要等到排程跑起來才知道。`SchedulingConfigurer` 讓排程的設定跟其他設定走同一條路。

**④ 精度**：US-ORD-3 AC-2 要求「15 分鐘 + 60 秒內」取消。`timeout-scan-interval: 30s`，加上撈 100 張、逐張處理的時間，最壞情況大約 30 秒多一點。

**⑤ `shop.order.jobs-enabled` 開關**：

```java
/** US-ORD-3：付款期限 */
public record Order(
        @NotNull @DurationMin(minutes = 1, message = "付款期限至少 1 分鐘")
        @DurationMax(minutes = 60, message = "付款期限不可超過 60 分鐘（US-ORD-3）") Duration paymentTimeout,
        @NotNull @DurationMin(seconds = 10, message = "逾時掃描間隔至少 10 秒") Duration timeoutScanInterval,
        /** 逾時取消與自動完成的排程（4.7）。實驗需要可重現的資料時關掉它 */
        @DefaultValue("true") boolean jobsEnabled) {}
```

預設是**開**的（`@DefaultValue("true")` 與 `matchIfMissing = true`）。正式環境不需要設定任何東西，排程就會跑。
關掉它的只有測試與實驗：4.2.5 的 E5 要建「剛好過期」的訂單，如果背景排程在 30 秒內搶先把它取消了，那一回合的結果就不是實驗設計的那個競態。

> 📌 **「預設開、測試關」而不是「預設關、正式開」**，理由跟 3.3.4 的 fail-closed 是同一個方向，只是反過來用：
> 排程如果沒跑，**逾時訂單會永遠佔著庫存** —— 那是一個安靜的故障，沒有任何錯誤訊息。
> 讓「忘記設定」的結果是「排程照常執行」，而不是「排程默默消失」。

啟動一次（`local` profile，排程開著），第一次掃描就處理了種子資料裡 15 張出貨超過 7 天的訂單：

```
INFO 47523 --- [shop] [   scheduling-1] c.e.shop.ordering.internal.OrderJobs     : 排程 AUTO_COMPLETE：掃到 15 張，轉移 15 張
```

**AC-4（第 14 分 59 秒付款成功，排程不取消）怎麼保證的？** 兩層：

1. 付款成功的訂單是 `PAID`，`cancelExpired()` 的 `WHERE status = 'PENDING_PAYMENT'` 撈不到它。
2. 就算排程在付款 commit **之前**撈到了這張單（4.2.5 的競態），它的條件式 UPDATE 會影響 0 列，重讀看到 `PAID`，狀態機：`PAID + E4 = ·`。預留保持 `CONFIRMED`。

### 4.7.2 三台機器同時跑：不需要分散式鎖

US-ORD-3 AC-3：「3 台應用程式同時跑排程，每張訂單只被取消一次；`RELEASE` 帳不重複。」

在單體裡，`@Scheduled` 在**每一個**應用程式實例裡都會跑。部署三台，就有三個排程在同一時刻撈同一批過期訂單。

實驗建 300 張過期訂單、每張 2 個品項，讓三個「排程」用 `CountDownLatch` 同時出發。先是天真的版本：

```java
/** 天真的排程：撈出過期的單，逐張「讀狀態 → 是待付款就取消並釋放」 */
void naiveJob() {
    List<Long> ids = jdbc.queryForList("SELECT id FROM orders WHERE buyer_id = ? AND status = 'PENDING_PAYMENT' AND payment_deadline < NOW(3)", Long.class, BUYER);
    for (long id : ids) tx.executeWithoutResult(s -> {
        String status = jdbc.queryForObject("SELECT status FROM orders WHERE id = ?", String.class, id);
        if (!status.equals("PENDING_PAYMENT")) return;
        jdbc.update("UPDATE orders SET status = 'CANCELLED', cancel_reason = 'PAYMENT_TIMEOUT', cancelled_at = NOW(3) WHERE id = ?", id);
        for (var r : jdbc.queryForList("SELECT product_id, quantity FROM inventory_reservations WHERE order_id = ?", id)) {
            jdbc.update("UPDATE inventory SET reserved = reserved - ? WHERE product_id = ?", r.get("quantity"), r.get("product_id"));
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 0, ?, 'RELEASE', ?)",
                    r.get("product_id"), -((Integer) r.get("quantity")), "order:" + id);
        }
        jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED' WHERE order_id = ?", id);
        jdbc.update("INSERT INTO order_status_history (order_id, from_status, to_status, event, actor_type) VALUES (?, 'PENDING_PAYMENT', 'CANCELLED', 'PAYMENT_TIMEOUT', 'SYSTEM')", id);
    });
}
```

它有檢查狀態（`if (!status.equals("PENDING_PAYMENT")) return;`），每張訂單也是各自一個交易。本專題的版本則是 `new OrderJobs(...)` 三個、各自 `while (jobs.cancelExpired() > 0)`：

```bash
mvn test -Pexperiments -Dtest=E6ThreeSchedulersTest
```

```
═══ 4.7.2 三個排程實例同時處理 300 張過期訂單（每張 2 個品項）═══
── 天真的排程 ──
  取消 120 張、還是待付款 180 張；「逾時取消」歷史 300 筆；RELEASE 帳 600 筆（取消的每張應該 2 筆）
  INV-2：兩個商品的 reserved = [0, 0]，Σ 有效預留 = 360
  例外 3 次，第一個：org.springframework.jdbc.UncategorizedSQLException: PreparedStatementCallback; uncategorized SQLException for SQL [UPDATE inventory SET reserved = reserved - ? WHERE product_id = ?]; SQL state [HY000]; error code [3819]; Check constraint 'ck_inventory_reserved' is violated.
── 本專題的 OrderJobs ──
  取消 300 張、還是待付款 0 張；「逾時取消」歷史 300 筆；RELEASE 帳 600 筆（取消的每張應該 2 筆）
  INV-2：兩個商品的 reserved = [0, 0]，Σ 有效預留 = 0
```

**天真的版本，一步一步拆：**

1. 三個排程撈到同樣的 300 個 id，同時開始處理同一張訂單。三個交易的 `SELECT status` 都讀到 `PENDING_PAYMENT`（一般讀取，4.6.2）。
2. 三個都執行 `UPDATE orders SET status = 'CANCELLED' WHERE id = ?`。行鎖讓它們**排隊**，但不會讓後兩個**放棄** —— 它們早就決定好要做了。
3. 於是同一張訂單被取消了 **2～3 次**：`reserved` 被減了 2～3 次、`RELEASE` 帳寫了 2～3 次、歷史寫了 2～3 次。
4. 每個商品一開始 `reserved = 300`。重複的減法讓它在處理完 **120 張**訂單時就減到 0（120 張 × 平均 2.5 次 = 300 次）。
5. 下一次減法：`reserved = -1` → **`ck_inventory_reserved` 擋下來**（3.6.1 預告的那個例外，error code 3819）→ 例外穿出排程的迴圈 → **三個排程全部死掉**。
6. 剩下 **180 張**訂單沒有被處理。它們的 360 筆預留還是 `HELD`，但 `reserved` 已經是 0。

**INV-2 差了 360。** `reserved = 0` 代表庫存系統認為這 360 件**可以賣** —— 而它們其實被 180 張還在等付款的訂單預留著。
那 180 位買家如果在接下來付款成功，他們的貨可能已經被別人買走了。

CHECK 又一次救了場（`reserved` 沒有變成負數），又一次用「讓程式崩潰」的方式救的（4.2.1 ②）。**而且這次崩潰的是背景排程**：沒有使用者看到 500，只有日誌裡三行 ERROR。

**本專題的版本：** 300 張、每張只被取消一次、600 筆 `RELEASE`（300 張 × 2 個品項）、INV-2 為 0。

**為什麼不需要分散式鎖？** 因為**每一張訂單**都有自己的「鎖」—— 條件式 UPDATE：

- 三個排程同時處理訂單 #42，三個交易都執行 `UPDATE orders ... WHERE id = 42 AND status = 'PENDING_PAYMENT'`。
- 第一個影響 1 列，做完副作用、commit。
- 另外兩個等到行鎖後重新檢查條件，影響 **0 列** → `FOR UPDATE` 重讀，看到 `CANCELLED` → 狀態機：`CANCELLED + E4 = ·` → 什麼都不做。

分散式鎖（ShedLock、Redis 鎖，[10-redis/09](../10-redis/09-distributed-lock.md)）解決的是「**同一時間只有一台在跑**」。
這裡要的是「**每張訂單只被處理一次**」—— 後者比前者弱，也更容易做對。而且分散式鎖有自己的失敗模式：鎖過期了但持有者還在跑、Redis 掛了排程就停了。

**代價是重複的工作**：三台都撈了同樣的 100 個 id、都對每一張做了一次讀取與一次（失敗的）UPDATE。這些工作都很便宜：主鍵查詢、影響 0 列的 UPDATE。
量大到在意這個成本的時候，可以改用 `SELECT ... FOR UPDATE SKIP LOCKED` 讓三台各撈不同的訂單（練習五）—— 那是**效能最佳化**，不是正確性的前提。

> 📌 **`applyEach` 只接 `ShopException`**。狀態機的 ✗ 或「訂單狀態正在變動」會被記一行 WARN，然後繼續處理下一張。
> 其他例外（例如資料庫斷線）會穿出迴圈，這一輪結束；Spring 的排程器記下錯誤，30 秒後的下一輪照常執行。
> 天真的版本死掉，是因為 CHECK 違反穿出了迴圈 —— 在本專題的版本裡，**同樣的例外根本不會發生**，因為重複的釋放在更前面就被擋掉了。

---

## 4.8 搶購壓測：打真的 HTTP

### 4.8.1 E7：2,000 個買家、500 件、真的 `POST /api/orders`

4.2.1 的 E1 只量了「扣庫存」那一句。驗收 Q2 量的是 100 個請求的正確性。US-ORD-1b AC-2 要的是：

> 商品 X 可售庫存 = 500，2,000 個買家在 10 秒內各下單 1 件 → 恰好 500 筆成立；p99 < **500 ms**；`RESERVE` 帳 = 500。

E7 啟動整個應用程式，讓 2,000 個不同的買家打**完整的**下單 API：身分、驗證、冪等鍵、商品快照、價格比對、訂單與明細、預留、庫存帳、歷史、清購物車、讀回回應。
兩種負載各跑兩次、平台執行緒與虛擬執行緒各一半（0.9.2 ⑤ 說過，虛擬執行緒是「用數字決定」的實驗變數）：

```java
/**
 * @param rps 0：封閉式負載（CLIENTS 個客戶端各自「送完一個、馬上送下一個」，量的是飽和時的樣子）。
 *            > 0：開放式負載（0.6.2 的寫法：每秒 rps 個請求，不管前面的回來了沒有）。延遲從「預定送出的時間」算起，
 *            否則系統變慢時送出的時間也跟著延後，p99 會被低估（coordinated omission）。
 */
static Run flashSale(boolean virtualThreads, int rps) throws Exception {
    try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0",
            "--shop.order.jobs-enabled=false", "--spring.threads.virtual.enabled=" + virtualThreads,
            "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
        // …建立熱點商品（庫存 500）…
        sampler.scheduleAtFixedRate(() -> {                               // 連線池的使用狀況（0.6.6 的 hikaricp.connections.pending）
            maxActive.accumulateAndGet(hikari.getHikariPoolMXBean().getActiveConnections(), Math::max);
            maxPending.accumulateAndGet(hikari.getHikariPoolMXBean().getThreadsAwaitingConnection(), Math::max);
        }, 0, 5, TimeUnit.MILLISECONDS);
        for (int i = 0; i < BUYERS; i++) {
            // …第 i 個買家：開放式負載時，等到 start + i / rps 秒才送…
            long s = rps > 0 ? due : System.nanoTime();
            int status = http.send(req, HttpResponse.BodyHandlers.discarding()).statusCode();
            lat.add(System.nanoTime() - s);
            statuses.computeIfAbsent(status, k -> new AtomicInteger()).incrementAndGet();
            if (status == 503) unavailable.add(req);                  // 照 Retry-After 的意思：之後用同一個鍵再送一次
        }
        // …全部回來之後…
        Map<Integer, Integer> retried = new TreeMap<>();                   // 503 的那些請求，一秒後用同一個 Idempotency-Key 重送
        if (!unavailable.isEmpty()) Thread.sleep(1000);
        for (HttpRequest req : unavailable) retried.merge(http.send(req, HttpResponse.BodyHandlers.discarding()).statusCode(), 1, Integer::sum);
        // …統計 p50 / p95 / p99、reserved、明細數、RESERVE 帳數…
    }
}
```

**兩種負載的差別很重要。** 0.6.2 寫的是「200 rps，持續 10 秒」—— 那是**開放式**負載：請求照時間表到達，不管系統回應得多慢。
「200 個客戶端各自送完馬上送下一個」是**封閉式**負載：系統變慢，客戶端也跟著變慢，它量的是「系統全速運轉時」的樣子。
開放式的延遲要從「**預定**送出的時間」算起。如果從「實際送出」算，系統卡住的那幾秒裡根本沒有請求被送出，那段等待就從 p99 裡消失了（coordinated omission）。

```bash
mvn test -Pexperiments -Dtest=E7FlashSaleLoadTest
```

```
═══ 4.8 搶購：2,000 個買家搶 500 件，200 個並行的客戶端，打真的 POST /api/orders ═══
  平台執行緒    HTTP {201=494, 409=1488, 503=18} │ 12.19 秒 │ p50   883  p95  3128  p99  4166  最慢  6034 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180
             └ 503 的 18 個請求，1 秒後用同一個 Idempotency-Key 重送 → HTTP {200=6, 409=12}
  虛擬執行緒    HTTP {201=500, 409=1500} │ 12.85 秒 │ p50   906  p95  2092  p99  2190  最慢  2219 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 9、等待最多 0
  平台執行緒    HTTP {201=500, 409=1498, 503=2} │ 7.39 秒 │ p50   534  p95  1821  p99  2822  最慢  4511 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180
             └ 503 的 2 個請求，1 秒後用同一個 Idempotency-Key 重送 → HTTP {409=2}
  虛擬執行緒    HTTP {201=500, 409=1500} │ 8.58 秒 │ p50   708  p95  1330  p99  1410  最慢  1450 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 11、等待最多 0
═══ 4.8 同樣 2,000 個買家，改成 0.6.2 的負載：每秒 200 個請求、10 秒（開放式）═══
  平台執行緒    HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    27  p95   445  p99   659  最慢  1150 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 90
  虛擬執行緒    HTTP {201=500, 409=1500} │ 10.18 秒 │ p50    66  p95   513  p99   523  最慢   544 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 8、等待最多 0
  平台執行緒    HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    22  p95   262  p99   366  最慢   744 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 43
  虛擬執行緒    HTTP {201=500, 409=1500} │ 10.14 秒 │ p50  1229  p95  1724  p99  1783  最慢  1793 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 9、等待最多 1
```

**先看正確性：八輪全部對。** `reserved=500`、明細 500 筆、`RESERVE` 帳 500 筆，沒有超賣、沒有少賣、沒有多寫一筆帳。
4.2 的五個事故、4.5 和 4.6 的兩個 bug，在完整的 HTTP 路徑上都沒有再出現。

**再看延遲：SLO 沒有達成。** US-ORD-1b AC-2 要 p99 < 500 ms：

- **封閉式**：p99 1.4～4.2 秒。
- **開放式**（0.6.2 真正的負載條件）：四輪裡只有一輪（366 ms）達成。另外三輪是 523 ms、659 ms、1,783 ms。

同一台機器、同樣的程式，200 rps 時 p99 從 366 ms 跳到 1,783 ms：**這台機器在 200 rps 正好站在懸崖邊**。
0.11.5 的預測是「理想的下單交易，同一列 678 次/秒；200 做得到、600 勉強」。本章的交易比 0.11 的「理想交易」重得多（十幾句 SQL、8 張表），所以懸崖來得更早。

這正是 0.11.5 第三條設計約束寫的：「**熱點商品必須走 Redis 預扣**。不能把正確性押在『沒有人會寫慢的程式碼』上。」
這一章做完的是**正確性**，第 06 章接手**延遲**：熱點商品在 Redis 預扣，MySQL 只負責落帳。

> 📌 **你的數字會不一樣**（0.11.5 的 📌）。這台是 8 核的 Mac + Docker Desktop，**壓測的客戶端跟應用程式在同一個 JVM 裡**，搶同樣的 CPU。
> 重要的是結構：正確性在任何負載下都成立；延遲在某個負載開始斷崖式變差；那個負載離需求有多遠。

### 4.8.2 503，以及一個「已經成立」的 503

**第一版的 E7，平台執行緒那兩輪出現了 500**：

```
  平台執行緒    HTTP {201=500, 409=1482, 500=18} │ 10.80 秒 │ p50   933  p95  2536  p99  3225  最慢  4794 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 181
  平台執行緒    HTTP {201=500, 409=1459, 500=41} │ 10.88 秒 │ p50   869  p95  2760  p99  3302  最慢  4537 ms │ reserved=500 明細=5…
```

日誌：

```
org.springframework.transaction.CannotCreateTransactionException: Could not open JPA EntityManager for transaction
Caused by: org.hibernate.exception.JDBCConnectionException: Unable to acquire JDBC Connection [HikariPool-2 - Connection is not available, request timed out after 3001ms.] [n/a]
Caused by: java.sql.SQLTransientConnectionException: HikariPool-2 - Connection is not available, request timed out after 3001ms.
```

`連線池：同時使用最多 20、等待最多 181`：Tomcat 預設 200 條執行緒，每一條都在處理一個請求，連線池只有 20 條（`maximum-pool-size: 20`，0.10.4）。
181 個請求排隊等連線，等超過 `connection-timeout: 3000` 的就拿到例外。

`CannotCreateTransactionException` 不是 `ShopException`，所以 `GlobalExceptionHandler` 把它當成 bug：**500**。但它不是 bug，它是**過載** —— 0.6.3 的降級矩陣說，MySQL 拿不到的時候回 **503**；US-ORD-1b AC-1 說搶購時「**0 筆 500**」。

第一版的修正：

```java
@ExceptionHandler({org.springframework.transaction.CannotCreateTransactionException.class,
                   org.springframework.jdbc.CannotGetJdbcConnectionException.class})
ResponseEntity<ProblemDetail> handleNoConnection(Exception e) { … }
```

`mvn clean test`：

```
[ERROR] Tests run: 6, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.135 s <<< FAILURE! -- in com.example.shop.architecture.ModuleBoundaryTest
ModuleBoundaryTest.persistence_only_in_internal -- Time elapsed: 0.002 s <<< FAILURE!
java.lang.AssertionError: 
Architecture Violation [Priority: MEDIUM] - Rule '資料存取只能出現在模組的 internal 套件' was violated (1 times):
Method <com.example.shop.shared.web.GlobalExceptionHandler.handleNoConnection(java.lang.Exception)> has annotation member of type <org.springframework.jdbc.CannotGetJdbcConnectionException> in (GlobalExceptionHandler.java:0)
```

**1.6.2 的規則擋下了這個修正。** `shared.web` 不准依賴 `org.springframework.jdbc`（資料存取只能在模組的 `internal` 裡），**連 annotation 裡的一個 class 參照都不行**。
正確的修正是往上找一層抽象：`CannotGetJdbcConnectionException` 的父類別是 `org.springframework.dao.DataAccessResourceFailureException`，它在 Spring 的**資料存取抽象**（`dao`）裡，不屬於任何一種特定技術：

```java
/**
 * 拿不到資料庫連線（連線池在 connection-timeout 內沒有空的連線、或資料庫掛了）：不是 bug，是過載或依賴故障。
 * 0.6.3：MySQL 掛掉時回 503；US-ORD-1b AC-1：搶購時「0 筆 500」（4.8.2）
 * 不直接寫 jdbc 的 CannotGetJdbcConnectionException：shared.web 不准依賴 org.springframework.jdbc（ModuleBoundaryTest），
 * 改接它的父類別 DataAccessResourceFailureException，第 06 章 Redis 連不上的 RedisConnectionFailureException 也是它的子類別
 */
@ExceptionHandler({org.springframework.transaction.CannotCreateTransactionException.class,
                   org.springframework.dao.DataAccessResourceFailureException.class})
ResponseEntity<ProblemDetail> handleNoConnection(Exception e) {
    log.warn("拿不到資料庫連線：{}", e.getMessage());
    return ResponseEntity.status(ProblemType.TEMPORARILY_UNAVAILABLE.status()).header(HttpHeaders.RETRY_AFTER, "1")
            .body(problem(ProblemType.TEMPORARILY_UNAVAILABLE, "系統忙碌中，請稍後再試"));
}
```

副作用是好的：第 06 章 Redis 連不上時丟的 `RedisConnectionFailureException` 也是 `DataAccessResourceFailureException`，同一個處理器會把它變成 503 —— 正好是 0.6.3「熱點商品 × Redis 掛了 = 503」那一格。

**然後是這一節的標題。** 看 4.8.1 的第一輪：

```
  平台執行緒    HTTP {201=494, 409=1488, 503=18} │ … │ reserved=500 明細=500 RESERVE 帳=500 │ …
             └ 503 的 18 個請求，1 秒後用同一個 Idempotency-Key 重送 → HTTP {200=6, 409=12}
```

**`reserved=500`、明細 500 筆，但只有 494 個 201。** 有 6 張訂單成立了，它們的買家卻收到 503「系統忙碌中」。

原因在 4.4.5 的 Controller：

```java
OrderingApi.PlacedOrder placed = ordering.placeOrder(...);                    // 下單交易：拿一次連線、commit、還回去
return ResponseEntity.status(...).body(queries.byId(placed.orderId()));      // 讀回訂單：再拿一次連線 ← 這裡逾時
```

一個下單請求要拿**三次**連線（claim、下單交易、讀回）。下單交易已經 commit 了，讀回訂單時排不到連線 → 503。
**對買家來說，503 的意思是「沒成功，請重試」—— 但訂單其實成立了。**

`└` 那一行就是冪等鍵存在的理由：那 18 個 503 的買家照 `Retry-After: 1` 等一秒，用**同一個 `Idempotency-Key`** 重送：

- **6 個拿到 200 與自己的訂單** —— 494 + 6 = 500，一張都沒有少；
- **12 個拿到 409** —— 它們的 503 發生在訂單成立**之前**（claim 或下單交易本身拿不到連線），所以沒有訂單可以回傳。
  這個 409 是兩種之一（E7 只記了狀態碼）：已售完（`insufficient-stock`），或是那個鍵還停在 `PROCESSING` 的租約裡（`idempotency-in-progress`）——
  下單失敗時 `release()` 自己也要一條連線，它也拿不到的話，鍵會留到 30 秒租約到期（4.4.1 的 📌）。兩種都是正確的回應，都不會多建一張訂單。

**沒有冪等鍵的話，那 6 個買家重試會怎樣？** 他們會各自再下一張新的訂單 —— 如果那時還有貨，就是一個人兩張訂單、付兩次錢；如果沒貨了，他們會看到「已售完」，而他們其實買到了。
**503 + `Retry-After` + 冪等鍵是一組**：伺服器說「我不確定，請用同一個鍵再問一次」，客戶端照做就一定會得到正確的答案。

「讀回訂單要第二條連線」這件事本身可以改善（練習八）—— 但就算改善了，網路也可能在 commit 之後、回應送達之前斷掉。**冪等鍵要處理的正是這種「做完了，但對方不知道」的情況**，它不能被任何最佳化取代。

### 4.8.3 虛擬執行緒：數字比較好看，但還不開

同一組數字，只看平台 vs 虛擬：

| 負載 | 平台執行緒 p99 | 虛擬執行緒 p99 | 平台的 5xx | 虛擬的 5xx | 連線池「同時使用」 |
|---|---|---|---|---|---|
| 封閉式（第 1、2 輪） | 4,166 / 2,822 ms | 2,190 / 1,410 ms | 18 / 2 | 0 / 0 | 平台 20、虛擬 9～11 |
| 開放式 200 rps（第 1、2 輪） | 659 / **366** ms | **523** / 1,783 ms | 0 / 0 | 0 / 0 | 平台 20、虛擬 8～9 |

更早幾次跑的結果（修正 503 之前與之後）也是同樣的形狀：**封閉式**負載下，虛擬執行緒的 p99 每一次都比較好（1.1～2.8 秒 vs 2.2～3.8 秒），而且**從來沒有 5xx**；**開放式**負載下互有勝負。

最奇怪的一欄是**連線池**：虛擬執行緒版本同時使用的連線只有 8～11 條（這台機器 8 核），等待數是 0。平台執行緒版本永遠是 20 條用滿、180 個在排隊。

0.9.2 ⑤ 預期的風險是 **pinning**：Connector/J 8.3.0 的部分路徑用 `synchronized`，虛擬執行緒在裡面做 I/O 會把載體執行緒一起卡住。
用 `-Djdk.tracePinnedThreads=short` 跑虛擬執行緒的版本，**沒有印出任何一個被釘住的堆疊**。而且同時使用的連線偶爾會超過 8（11、13、14），如果每一次 JDBC 呼叫都被釘住，它不會超過載體執行緒的數量。

比較可能的解釋是：虛擬執行緒只有 8 條載體執行緒，**跟同一個 JVM 裡的 400 條壓測客戶端執行緒搶 CPU**。應用程式能同時推進的請求變少，同時碰資料庫的也變少 ——
它變成了一個意外的**併發限制器**，熱點列的鎖佇列變短，於是 p99 變好、連線池不會被排爆。

**這一章的決定：不開，維持 0.9.2 的預設。** 理由：

1. **我們不確定為什麼它比較好。** 最可能的解釋是一個**量測環境的偏差**（客戶端與伺服器在同一個 JVM）。在正式環境，壓測客戶端不會跟你搶 CPU。
2. **它沒有解決這一章真正的問題。** 開放式負載下兩者都在懸崖邊，SLO 要靠第 06 章的 Redis，不是靠執行緒模型。
3. **如果要的是「併發限制」，應該明寫。** 例如限制下單 API 同時處理的請求數（第 06 章的限流），而不是依賴一個剛好的副作用。

第 08 章會用**獨立行程**的壓測工具重跑這一組。那時如果虛擬執行緒還是明顯比較好，再用數字翻轉這個決定 —— 0.9.2 說的「用數字決定」包括「**數字不夠乾淨時，不決定**」。

---

## 4.9 流程測試與追溯表

### 4.9.1 `OrderFlowTest`：每一條 AC 一個測試

驗收 Q1～Q3 守的是三個最難的性質。0.4.5 的其他 AC 由 `OrderFlowTest` 逐條驗證 —— 直接呼叫 Service，不經過 HTTP，一個測試不到 0.1 秒：

```java
/**
 * 0.12.2 追溯表：ORD-1（下單）、ORD-1a（冪等）、ORD-2（付款回呼）、ORD-3（逾時）、ORD-4（買家取消）、ORD-6（出貨）。
 * 不用 @Transactional：下單會開自己的短交易（冪等鍵，REQUIRES_NEW），包在測試的交易裡反而測不到真的行為。改成每個測試結束時清掉自己的資料。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=false")
class OrderFlowTest {

    static final long BUYER = 990_401, OTHER_BUYER = 990_402, SELLER = 2, PRODUCT = 9_900_401;
    // …@BeforeEach 建一個價格 100.00、庫存 10 的商品；@AfterEach 清掉這兩位買家的所有資料…

    long pay(String orderNo, String txn, String amount, boolean ok, boolean goodSignature) {
        long pid = commands.startPayment(BUYER, orderNo).paymentId();
        callback(pid, txn, amount, ok, goodSignature);
        return pid;
    }

    void callback(long pid, String txn, String amount, boolean ok, boolean goodSignature) {
        BigDecimal a = new BigDecimal(amount);
        String sig = goodSignature ? CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(pid, txn, a, ok)) : "0".repeat(64);
        callbacks.handle(new PaymentApi.Callback(pid, txn, a, ok, sig));
    }

    @Test @DisplayName("ORD-2 AC-3、AC-4：簽章錯誤 → 401、金額不符 → 400；訂單與付款完全不變")
    void badCallbacks() {
        String no = place(1);
        long pid = commands.startPayment(BUYER, no).paymentId();
        assertThatThrownBy(() -> callback(pid, "tx-x", "100", true, false)).isInstanceOf(ShopException.class)
                .extracting(e -> ((ShopException) e).type()).isEqualTo(ProblemType.UNAUTHENTICATED);
        assertThatThrownBy(() -> callback(pid, "tx-x", "1", true, true)).isInstanceOf(ShopException.class)   // 簽章正確、金額錯（4.6.3）
                .extracting(e -> ((ShopException) e).type()).isEqualTo(ProblemType.VALIDATION);
        assertThat(status(no)).isEqualTo("PENDING_PAYMENT");
        assertThat(jdbc.queryForObject("SELECT status FROM payments WHERE id = ?", String.class, pid)).isEqualTo("PENDING");
    }

    @Test @DisplayName("0.5.3 PAID + 不同筆 E1：同一張訂單付了兩次錢 → 第二筆自動退款")
    void paidTwice() {
        String no = place(1);
        long p1 = commands.startPayment(BUYER, no).paymentId();             // 買家開了兩個分頁，各按一次「付款」
        long p2 = commands.startPayment(BUYER, no).paymentId();
        callback(p1, "tx-1", "100", true, true);
        callback(p2, "tx-2", "100", true, true);
        assertThat(status(no)).isEqualTo("PAID");
        assertThatThrownBy(() -> commands.startPayment(BUYER, no)).isInstanceOf(ShopException.class)   // 已付款就不能再開付款
                .extracting(e -> ((ShopException) e).type()).isEqualTo(ProblemType.INVALID_STATE);
        assertThat(refunds(no)).containsExactly("DUPLICATE_PAYMENT");
    }

    // …另外 12 個…
}
```

（`OrderFlowTest` 的 14 個測試全文在 4.10.1。）

`paidTwice` 如果寫成先付一次、訂單變成 `PAID`，再呼叫 `startPayment()` 開第二筆付款 —— **測試自己會紅**：

```
com.example.shop.shared.error.ShopException: 這張訂單不是待付款狀態
```

**那不是 bug，是規則**：已付款的訂單不能再建立付款（`startPayment` 檢查 `PENDING_PAYMENT`）。
所以「付了兩次錢」只有一種發生方式：**兩筆付款都在待付款時就建立了**（兩個分頁），然後兩筆都成功。上面的測試照這個順序寫，也順便把「已付款不能再開付款」寫成了斷言。
一個寫錯的測試讓你重新讀了一次需求 —— 這種紅燈跟抓到 bug 一樣有價值。

14 個測試：

```
ORD-1 AC-1～3：待付款、付款期限 = 建立 + 15 分鐘、HELD 預留、reserved 增加、onHand 不變
ORD-1 AC-6：客戶端看到的是 90、資料庫是 100 → 409 price-changed，不建立訂單
ORD-1a AC-5：兩位買家用同一個鍵 → 兩張不同的訂單
ORD-1a AC-6：鍵超過 24 小時 → 當成新的鍵，建立新的訂單
ORD-2 AC-2、AC-5：付款成功 → PAID、預留 CONFIRMED；同一個交易編號再來一次什麼都不做
ORD-2 AC-3、AC-4：簽章錯誤 → 401、金額不符 → 400；訂單與付款完全不變
ORD-2 AC-6：取消之後才到的付款 → 維持 CANCELLED、建立 LATE_PAYMENT 退款
ORD-2 AC-7：付款失敗 → 訂單維持待付款，可以重試
0.5.3 PAID + 不同筆 E1：同一張訂單付了兩次錢 → 第二筆自動退款
ORD-4 AC-2、AC-4、AC-5：已付款取消 → 釋放 + BUYER_CANCEL 退款；再取消一次 200；別人的訂單 404
ORD-6 AC-1、AC-2、AC-3：撿貨 → 出貨（CONSUMED、onHand 與 reserved 同時減少、SHIP 帳）→ 確認收貨
ORD-6 AC-4：出貨超過 7 天未確認 → 排程自動完成
ORD-6 AC-5：賣家取消已付款的訂單 → SELLER_CANCEL 退款
ORD-3 AC-1、AC-4：過期未付款 → 排程取消並釋放；已付款的不會被逾時取消
```

另外兩個新的測試類別：

- **`OrderApiTest`**（MockMvc，4 個）：沒帶 `Idempotency-Key` → 400（US-ORD-1 AC-7）、鍵超過 64 字 → 400、品項驗證、買家呼叫賣家的出貨 API → 403。
  這些請求都在進入 Service **之前**就被擋下，所以可以用 MockMvc；**會真的下單的測試不能用 `@Transactional` 的 MockMvc** —— 冪等鍵的 claim 是 `REQUIRES_NEW`，會在測試交易之外 commit，測試結束時 rollback 不掉。
- **`OrderRaceRegressionTest`**（2 個）：4.2.5 與 4.7.2 的「本專題」那一半，縮小規模放進每次的 `mvn test`。

`OrderApiTest` 與 `OrderRaceRegressionTest` 的全文在 4.10.1。

```
ORD-3 AC-3：取消 60 張、歷史 60 筆、RELEASE 60 筆；INV-2 {reserved=0, held=0}
ORD-3 AC-5：{CANCELLED/RELEASED/SUCCEEDED/1=50}；例外 0；INV-2 {reserved=0, held=0}
```

> 📌 **為什麼 E5、E6 已經有了，還要 `OrderRaceRegressionTest`？** E5、E6 是**實驗**：它們比較兩種寫法、跑 300 回合、印出一張表給人讀，標了 `@Tag("experiment")`，CI 不跑。
> 0.12.2 那段 📌 說「ORD-3 AC-5 那一列一直填不上，代表那個競態沒有被驗證過」。一個只有在有人手動執行時才會跑的實驗，**不算驗證**。
> 回歸測試不需要天真的版本做對照，只需要在有人改壞 `currentForUpdate` 或條件式 UPDATE 的那一天變紅。

### 4.9.2 追溯表更新

| 需求 | 驗證方式 | 狀態 |
|---|---|---|
| ORD-1 AC-1～3 | `OrderFlowTest`；4.4.5 的 `curl` | ✅ 04 |
| ORD-1 AC-4 | 驗收 **Q1**（失敗保留、成功清空） | ✅ 04 |
| ORD-1 AC-5 | 驗收 **Q1** | ✅ 04 |
| ORD-1 AC-6 | `OrderFlowTest`；E4（`compareTo`，真的 JS 前端） | ✅ 04 |
| ORD-1 AC-7 | `OrderApiTest` | ✅ 04 |
| ORD-1 AC-8（429 限流） | —— | ⏳ 06 |
| ORD-1a AC-1～4 | 驗收 **Q3**（先後、不同內容、同時 10 次）；Q1 第二段（AC-4） | ✅ 04 |
| ORD-1a AC-5、AC-6 | `OrderFlowTest` | ✅ 04 |
| ORD-1b AC-1 | 驗收 **Q2**（`.hasSize(2)`：0 筆 500） | ✅ 04 |
| ORD-1b AC-2 | E7：正確性 ✅、p99 < 500 ms ✗（4.8.1） | **部分**，延遲在 06 |
| ORD-1b AC-3 | E7（`reserved` = `RESERVE` 帳 = 500）；`InvariantReconciliationTest`（2.5.5）在全部測試後仍為 0 | ✅ 04（每小時對帳在 07） |
| ORD-2 AC-1、2、5、6、7 | `OrderFlowTest`；4.6.3 的 `curl` | ✅ 04 |
| ORD-2 AC-3 | 401 ✅；`audit_logs` 在 05 | 部分 |
| ORD-2 AC-4 | 400 ✅；告警在 09 | 部分 |
| ORD-2 AC-8（3 秒內） | 4.6.3：22 ms；負載下在 08 | ✅ 04（單次） |
| ORD-3 AC-1、AC-4 | `OrderFlowTest` | ✅ 04 |
| ORD-3 AC-2（15 分 + 60 秒） | `timeout-scan-interval: 30s`，`ShopProperties` 驗證 | ✅ 04 |
| ORD-3 AC-3 | `OrderRaceRegressionTest`；E6 | ✅ 04 |
| ORD-3 AC-5 | `OrderRaceRegressionTest`；E5 | ✅ 04 |
| ORD-4 AC-1～5 | `OrderFlowTest`；4.6.5 的 `curl`（AC-3） | ✅ 04 |
| ORD-6 AC-1～4、6 | `OrderFlowTest` | ✅ 04 |
| ORD-6 AC-5 | 取消與退款 ✅；通知在 07、稽核在 05 | 部分 |
| 0.5.3 轉移表 54 格 | `OrderStateMachineTest`（61 個） | ✅ 04 |
| 0.6.3 MySQL 拿不到連線 → 503 | `handleNoConnection`；E7 | ✅ 04（逐格演練在 06） |

**這一章讓 0.13.1 答應的「ORD-1～4、ORD-6、54 格轉移表、Q1～Q3」全部有了對應的測試**。沒有打勾的每一格，都指向一個具體的章節與理由。

---

## 4.10 本章完成後的專案

```
shop/
└── src/
    ├── main/
    │   ├── java/com/example/shop/
    │   │   ├── cart/
    │   │   │   ├── CartApi.java                                   ← 新增：removeItems（MANDATORY）
    │   │   │   └── internal/CartService.java                      ← implements CartApi
    │   │   ├── inventory/
    │   │   │   ├── InventoryApi.java                              ← + confirm、release、consume；reserve 排序
    │   │   │   └── internal/JdbcInventoryService.java             ← 預留列、held() FOR UPDATE
    │   │   ├── ordering/
    │   │   │   ├── OrderingApi.java                               ← OrderLine 帶 clientUnitPrice
    │   │   │   └── internal/
    │   │   │       ├── OrderEvent.java、OrderStateMachine.java    ← 新增：0.5.2、0.5.3
    │   │   │       ├── PlaceOrderService.java、OrderNumbers.java  ← 新增：下單（4.4）
    │   │   │       ├── IdempotencyKeys.java                       ← 新增：冪等鍵（4.5）
    │   │   │       ├── OrderTransitionService.java、OrderHistory.java  ← 新增：狀態轉移（4.6）
    │   │   │       ├── PaymentCallbackService.java、OrderCommands.java ← 新增
    │   │   │       ├── OrderJobs.java                             ← 新增：兩個排程（4.7）
    │   │   │       ├── OrderRepository.java                       ← + findIdByOrderNoAnd{Buyer,Seller}Id
    │   │   │       └── web/{OrderCommandController,SellerOrderCommandController,PaymentCallbackController}.java
    │   │   ├── payment/
    │   │   │   ├── PaymentApi.java、RefundReason.java             ← 新增
    │   │   │   └── internal/{CallbackSignature,JdbcPaymentService}.java
    │   │   └── shared/
    │   │       ├── config/ShopProperties.java                     ← + payment.callbackSecret、order.jobsEnabled
    │   │       ├── error/ShopException.java                       ← 保留名檢查（4.6.5）
    │   │       └── web/GlobalExceptionHandler.java                ← Retry-After、缺 header、503
    │   └── resources/
    │       ├── application-local.yml、application-prod.yml       ← + shop.payment.callback-secret
    │       └── db/migration/V11__ordering_idempotency_processing_lease.sql
    └── test/
        ├── java/com/example/
        │   ├── lab/ch04/FriendlyPlaceOrder.java                    ← 4.2.2 的「好心」寫法
        │   └── shop/
        │       ├── acceptance/CapstoneAcceptanceTest               ← Q1、Q2、Q3 變綠
        │       ├── api/OrderApiTest.java                           ← 新增
        │       ├── ch04/E1～E4、E7                                 ← 本章的實驗
        │       ├── ordering/internal/
        │       │   ├── OrderStateMachineTest.java                  ← 新增：61 個
        │       │   ├── OrderFlowTest.java、OrderRaceRegressionTest.java ← 新增
        │       │   └── E5TimeoutVsPaymentRaceTest.java、E6ThreeSchedulersTest.java
        │       └── shared/error/ShopExceptionTest.java             ← 新增
        └── resources/
            ├── ch04/js-client.mjs                                  ← 4.2.4 的前端
            └── openapi/shop-api.json                               ← + 8 個 operation
```

在本章結束時的程式碼上、用一套全新的 compose（空的資料庫，Flyway 從第一個 migration 開始）跑 `mvn clean verify`：

```bash
mvn clean verify
```

```
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.052 s -- in com.example.shop.shared.error.ShopExceptionTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 4.182 s -- in com.example.shop.schema.SchemaConstraintTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.015 s -- in com.example.shop.schema.EntitySchemaDriftTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.011 s -- in com.example.shop.schema.InvariantReconciliationTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.038 s -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.005 s -- in com.example.shop.architecture.MigrationOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.002 s -- in com.example.shop.architecture.MapperXmlSafetyTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.031 s -- in com.example.shop.architecture.ConfigKeyGuardTest
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 6, Time elapsed: 53.38 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 61, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.031 s -- in com.example.shop.ordering.internal.OrderStateMachineTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.850 s -- in com.example.shop.ordering.internal.OrderRaceRegressionTest
[INFO] Tests run: 14, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.595 s -- in com.example.shop.ordering.internal.OrderFlowTest
[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.649 s -- in com.example.shop.api.OrderApiTest
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.701 s -- in com.example.shop.api.CatalogCartApiTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.284 s -- in com.example.shop.api.OpenApiContractTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.698 s -- in com.example.shop.architecture.EntityTableOwnershipTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.096 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 120, Failures: 0, Errors: 0, Skipped: 6
[INFO] ...
[INFO] Building jar: …/target/shop-0.0.1-SNAPSHOT.jar
[INFO] ...
[INFO] BUILD SUCCESS
[INFO] ...
[INFO] Total time:  01:07 min
```

`verify` 比 `test` 多做的是打包 jar（`spring-boot:repackage`）；覆蓋率門檻要到第 08 章才有。

**120 個測試、`Skipped: 6`**（第 03 章是 34 個、9 個 skipped）。Q1、Q2、Q3 變綠；Q6 的數字跟著 V11 變成 11 個 migration、25 個 CHECK。
驗收測試花了 53 秒 —— Q1～Q4、Q6 各自啟動一個完整的應用程式。第 08 章會處理這件事。

### 4.10.1 本章其餘檔案的完整內容

正文為了讓重點清楚，很多檔案只列了關鍵的幾行。這一節把它們逐檔貼出 `ch04` 的完整內容。照著正文與這一節，從第 03 章的專案就能做出本章的專案。（例外：`CartService` 兩行註解的節號，這裡已依正文改成 3.6.1；參考實作的 `ch04` 分支裡仍是舊的「3.2.5」與「3.5.3」。）

正文已經完整列出、這裡不重貼的：`CartApi`、`OrderEvent`、`OrderNumbers`、`OrderStateMachine`、`IdempotencyKeys`（4.5.1 與 4.5.4 兩段合起來）、`PaymentCallbackService`、`PaymentCallbackController`、`OrderJobs`、`PaymentApi`、`RefundReason`、`CallbackSignature`（另有一個 `private CallbackSignature() {}`）、V11、`FriendlyPlaceOrder`、`OrderStateMachineTest`、`js-client.mjs`。它們在正文裡省略了 `import`，IDE 補得出來。

另外三個不貼的：`ProductService` 只有 4.6.5 說的那一行（`.with("status", p.getStatus())` → `.with("productStatus", p.getStatus())`）；`openapi/shop-api.json` 用 `-Dopenapi.update=true` 重新產生（4.3.1）；`.gitignore` 多一行 `full-test.log`。

**正式程式碼**

**`src/main/java/com/example/shop/ordering/OrderingApi.java`**

```java
package com.example.shop.ordering;

import java.math.BigDecimal;
import java.util.List;

/** 訂單模組的對外入口。 */
public interface OrderingApi {

    /**
     * US-ORD-1 下單。寫訂單、明細、預留庫存、清購物車，同一個交易（4.4）。
     * 同一位買家、同一個 idempotencyKey、同樣的內容再送一次，回傳同一張訂單（replayed = true）。
     */
    PlacedOrder placeOrder(long buyerId, String idempotencyKey, List<OrderLine> lines);

    /** 1.5.4 預告過的：訂單的 DTO 多了客戶端看到的單價（US-ORD-1 AC-6）。庫存模組的 ReserveLine 不需要它 */
    record OrderLine(long productId, int quantity, BigDecimal clientUnitPrice) {}

    record PlacedOrder(long orderId, String orderNo, boolean replayed) {}
}
```

**`src/main/java/com/example/shop/ordering/internal/PlaceOrderService.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.cart.CartApi;
import com.example.shop.catalog.CatalogApi;
import com.example.shop.catalog.ProductSnapshot;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ConstraintViolations;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
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
 * 4.4 下單。交易邊界：
 *   ① IdempotencyKeys.claim()   —— 短交易，取得這個鍵
 *   ② placeInTransaction()      —— 下單交易：訂單、明細、預留、庫存帳、狀態歷史、冪等鍵完成、清購物車。全有或全無（Q1）
 *   ③ 失敗時 IdempotencyKeys.release() —— 短交易，讓重試可以重新執行
 * ② 裡「只有 SQL」：沒有外部呼叫、沒有 sleep、沒有遠端日誌（0.11.5 的第一條設計約束：持鎖 ≤ 2 ms）
 */
@Service
class PlaceOrderService implements OrderingApi {

    static final int MAX_LINES = 50;
    static final int ORDER_NO_ATTEMPTS = 3;

    private final CatalogApi catalog;
    private final InventoryApi inventory;
    private final CartApi cart;
    private final OrderRepository orders;
    private final OrderHistory history;
    private final IdempotencyKeys keys;
    private final TransactionTemplate tx;
    private final Clock clock;
    private final Duration paymentTimeout;

    PlaceOrderService(CatalogApi catalog, InventoryApi inventory, CartApi cart, OrderRepository orders, OrderHistory history,
                      IdempotencyKeys keys, PlatformTransactionManager tm, Clock clock, ShopProperties props) {
        this.catalog = catalog;
        this.inventory = inventory;
        this.cart = cart;
        this.orders = orders;
        this.history = history;
        this.keys = keys;
        this.tx = new TransactionTemplate(tm);
        this.clock = clock;
        this.paymentTimeout = props.order().paymentTimeout();
    }

    @Override
    public PlacedOrder placeOrder(long buyerId, String idempotencyKey, List<OrderLine> lines) {
        validate(lines);
        IdempotencyKeys.Claim claim = keys.claim(buyerId, idempotencyKey, hash(lines));
        if (claim instanceof IdempotencyKeys.Existing e) {
            Order o = orders.findById(e.orderId()).orElseThrow();
            return new PlacedOrder(o.getId(), o.getOrderNo(), true);
        }
        if (claim instanceof IdempotencyKeys.InProgress)
            throw new ShopException(ProblemType.IDEMPOTENCY_IN_PROGRESS, "相同的下單請求正在處理中").with("retryAfter", 1);
        try {
            for (int attempt = 1; ; attempt++) {
                try {
                    return tx.execute(s -> placeInTransaction(buyerId, idempotencyKey, lines));
                } catch (DataIntegrityViolationException e) {
                    // 2.4.4：訂單編號撞號（一天約 12 次）。整個交易已經 rollback，換一個號碼重來
                    if (attempt >= ORDER_NO_ATTEMPTS || !ConstraintViolations.isViolationOf(e, "uk_orders_order_no")) throw e;
                }
            }
        } catch (RuntimeException e) {
            keys.release(buyerId, idempotencyKey);                          // AC-4：失敗的結果不快取
            throw e;
        }
    }

    private PlacedOrder placeInTransaction(long buyerId, String key, List<OrderLine> lines) {
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

        Instant now = clock.instant();
        Order order = Order.place(OrderNumbers.next(now), buyerId, sellers.iterator().next(), now, now.plus(paymentTimeout));
        for (OrderLine l : lines) {
            ProductSnapshot p = products.get(l.productId());
            order.addItem(p.id(), p.name(), p.price(), l.quantity());      // 快照：下單當下的名稱與價格（1.5.5）
        }
        orders.saveAndFlush(order);                                         // IDENTITY：這裡就 INSERT 了，撞號也在這裡炸

        inventory.reserve(order.getId(), lines.stream().map(l -> new ReserveLine(l.productId(), l.quantity())).toList());
        history.record(order.getId(), null, order.getStatus(), "PLACE_ORDER", OrderHistory.Actor.buyer(buyerId), now);
        keys.complete(buyerId, key, order.getId());
        cart.removeItems(buyerId, ids);                                     // AC-4
        return new PlacedOrder(order.getId(), order.getOrderNo(), false);
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

**`src/main/java/com/example/shop/ordering/internal/OrderHistory.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Instant;

/** US-ORD-6 AC-6：每一次狀態變更一筆 order_status_history（跟那次變更在同一個交易裡） */
@Component
class OrderHistory {

    record Actor(String type, Long id) {
        static Actor buyer(long id) { return new Actor("BUYER", id); }
        static Actor seller(long id) { return new Actor("SELLER", id); }
        static Actor system() { return new Actor("SYSTEM", null); }
        static Actor paymentProvider() { return new Actor("PAYMENT_PROVIDER", null); }
    }

    private final JdbcTemplate jdbc;

    OrderHistory(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Transactional(propagation = Propagation.MANDATORY)
    void record(long orderId, OrderStatus from, OrderStatus to, String event, Actor actor, Instant at) {
        jdbc.update("""
                INSERT INTO order_status_history (order_id, from_status, to_status, event, actor_type, actor_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                orderId, from == null ? null : from.name(), to.name(), event, actor.type(), actor.id(), Timestamp.from(at));
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/Order.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;
import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "orders")                            // ORDER 是 SQL 保留字：表名用複數
class Order {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 15, updatable = false)
    private String orderNo;

    @Column(nullable = false, updatable = false)
    private long buyerId;

    @Column(nullable = false, updatable = false)
    private long sellerId;

    @Enumerated(EnumType.STRING)
    @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 20)
    private OrderStatus status;

    @Column(nullable = false, precision = 12, scale = 2, updatable = false)
    private BigDecimal totalAmount;

    @Column(nullable = false)
    private Instant paymentDeadline;

    @Column(length = 30)
    private String cancelReason;

    @Column(length = 30)
    private String carrier;

    @Column(length = 50)
    private String trackingNo;

    private Instant paidAt;
    private Instant shippedAt;
    private Instant completedAt;
    private Instant cancelledAt;

    @Column(nullable = false, updatable = false)
    private Instant createdAt;

    @Column(nullable = false)
    private Instant updatedAt;

    @Version
    private int version;

    @OneToMany(mappedBy = "order", cascade = CascadeType.PERSIST)
    @OrderBy("id")
    private List<OrderItem> items = new ArrayList<>();   // 同一個模組、同一個聚合：可以用關聯

    protected Order() {}

    /** US-ORD-1：建立一張待付款的訂單。金額由伺服器用資料庫的價格算（AC-2），客戶端的價格只拿來比對（AC-6） */
    static Order place(String orderNo, long buyerId, long sellerId, Instant now, Instant paymentDeadline) {
        Order o = new Order();
        o.orderNo = orderNo;
        o.buyerId = buyerId;
        o.sellerId = sellerId;
        o.status = OrderStatus.PENDING_PAYMENT;
        o.totalAmount = BigDecimal.ZERO.setScale(2);
        o.paymentDeadline = paymentDeadline;
        o.createdAt = now;
        o.updatedAt = now;
        return o;
    }

    void addItem(long productId, String productName, BigDecimal unitPrice, int quantity) {
        items.add(new OrderItem(this, productId, productName, unitPrice, quantity));
        totalAmount = totalAmount.add(unitPrice.multiply(BigDecimal.valueOf(quantity))).setScale(2, java.math.RoundingMode.HALF_UP);
    }

    Long getId() { return id; }
    String getOrderNo() { return orderNo; }
    long getBuyerId() { return buyerId; }
    long getSellerId() { return sellerId; }
    OrderStatus getStatus() { return status; }
    BigDecimal getTotalAmount() { return totalAmount; }
    Instant getPaymentDeadline() { return paymentDeadline; }
    Instant getCreatedAt() { return createdAt; }
    List<OrderItem> getItems() { return items; }
}
```

**`src/main/java/com/example/shop/ordering/internal/OrderItem.java`**

```java
package com.example.shop.ordering.internal;

import jakarta.persistence.*;

import java.math.BigDecimal;

@Entity
@Table(name = "order_items")
class OrderItem {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id")
    private Order order;

    @Column(nullable = false)
    private long productId;                        // 跨模組：只存 id（1.5.5）

    @Column(nullable = false, length = 200)
    private String productName;                    // 快照

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal unitPrice;                  // 快照

    @Column(nullable = false)
    private int quantity;

    @Column(precision = 12, scale = 2, insertable = false, updatable = false)
    private BigDecimal lineAmount;                 // 資料庫的產生欄位（unit_price * quantity），唯讀

    protected OrderItem() {}

    OrderItem(Order order, long productId, String productName, BigDecimal unitPrice, int quantity) {
        this.order = order;
        this.productId = productId;
        this.productName = productName;
        this.unitPrice = unitPrice;
        this.quantity = quantity;
    }

    Long getId() { return id; }
    Long orderId() { return order.getId(); }       // 對 proxy 取 id 不會觸發載入
    long getProductId() { return productId; }
    String getProductName() { return productName; }
    BigDecimal getUnitPrice() { return unitPrice; }
    int getQuantity() { return quantity; }
    /** line_amount 是資料庫的產生欄位：剛 INSERT 的 Entity 在記憶體裡還是 null（Hibernate 不會讀回來），這時候自己算 */
    BigDecimal getLineAmount() { return lineAmount != null ? lineAmount : unitPrice.multiply(BigDecimal.valueOf(quantity)); }
}
```

**`src/main/java/com/example/shop/ordering/internal/OrderDtos.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

public final class OrderDtos {

    private OrderDtos() {}

    /** 訂單對外只用 orderNo 識別，不暴露內部 id（0.6.7） */
    public record OrderView(String orderNo, OrderStatus status, BigDecimal totalAmount, Instant createdAt,
                            Instant paymentDeadline, List<OrderLineView> items) {}

    public record OrderLineView(long productId, String productName, BigDecimal unitPrice, int quantity, BigDecimal lineAmount) {}

    /** US-ORD-1：客戶端送來「它看到的單價」，只用來比對（AC-6） */
    public record PlaceOrderRequest(
            @NotEmpty(message = "至少要有一個品項") @Size(max = 50, message = "最多 50 個品項") List<@Valid Line> items) {
        public record Line(
                @NotNull(message = "商品必填") Long productId,
                @NotNull(message = "數量必填") @Min(value = 1, message = "數量 1～99") @Max(value = 99, message = "數量 1～99") Integer quantity,
                @NotNull(message = "單價必填") @DecimalMin(value = "0.01", message = "單價必須大於 0") BigDecimal unitPrice) {}
    }

    public record ShipRequest(
            @NotBlank(message = "物流商必填") @Size(max = 30, message = "物流商最多 30 字") String carrier,
            @NotBlank(message = "物流單號必填") @Size(max = 50, message = "物流單號最多 50 字") String trackingNo) {}

    public record PaymentStarted(long paymentId, BigDecimal amount, String payUrl) {}
}
```

**`src/main/java/com/example/shop/ordering/internal/OrderRepository.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Optional;

interface OrderRepository extends JpaRepository<Order, Long> {

    Page<Order> findByBuyerId(long buyerId, Pageable pageable);

    Page<Order> findByBuyerIdAndStatus(long buyerId, OrderStatus status, Pageable pageable);

    Page<Order> findBySellerId(long sellerId, Pageable pageable);

    Page<Order> findBySellerIdAndStatus(long sellerId, OrderStatus status, Pageable pageable);

    Optional<Order> findByOrderNo(String orderNo);

    @Query("select o.id from Order o where o.orderNo = :orderNo and o.buyerId = :buyerId")
    Optional<Long> findIdByOrderNoAndBuyerId(@Param("orderNo") String orderNo, @Param("buyerId") long buyerId);

    @Query("select o.id from Order o where o.orderNo = :orderNo and o.sellerId = :sellerId")
    Optional<Long> findIdByOrderNoAndSellerId(@Param("orderNo") String orderNo, @Param("sellerId") long sellerId);
}
```

**`src/main/java/com/example/shop/ordering/internal/OrderQueryService.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;
import com.example.shop.ordering.internal.OrderDtos.OrderLineView;
import com.example.shop.ordering.internal.OrderDtos.OrderView;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.web.PageResponse;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 訂單的查詢面（US-ORD-5）。寫入面（下單、狀態轉移）在第 04 章。
 * 一頁訂單固定 3 句 SQL：訂單、總數、這一頁所有訂單的明細（驗收 Q4）。
 */
@Service
public class OrderQueryService {

    static final Sort NEWEST_FIRST = Sort.by(Sort.Direction.DESC, "createdAt");

    private final OrderRepository orders;
    private final OrderItemRepository items;

    OrderQueryService(OrderRepository orders, OrderItemRepository items) {
        this.orders = orders;
        this.items = items;
    }

    @Transactional(readOnly = true)
    public PageResponse<OrderView> buyerOrders(long buyerId, OrderStatus status, int page, int size) {
        PageRequest pr = PageRequest.of(page, size, NEWEST_FIRST);
        return withItems(status == null ? orders.findByBuyerId(buyerId, pr) : orders.findByBuyerIdAndStatus(buyerId, status, pr));
    }

    @Transactional(readOnly = true)
    public PageResponse<OrderView> sellerOrders(long sellerId, OrderStatus status, int page, int size) {
        PageRequest pr = PageRequest.of(page, size, NEWEST_FIRST);
        return withItems(status == null ? orders.findBySellerId(sellerId, pr) : orders.findBySellerIdAndStatus(sellerId, status, pr));
    }

    /** US-ORD-5 AC-3：別人的訂單 → 404，跟「不存在」一模一樣（稽核日誌在第 05 章加上） */
    @Transactional(readOnly = true)
    public OrderView buyerOrder(long buyerId, String orderNo) {
        Order o = orders.findByOrderNo(orderNo).filter(x -> x.getBuyerId() == buyerId)
                .orElseThrow(() -> ShopException.notFound("訂單"));
        return view(o, items.findByOrderIds(List.of(o.getId())));
    }

    @Transactional(readOnly = true)
    public OrderView byId(long orderId) {
        Order o = orders.findById(orderId).orElseThrow(() -> ShopException.notFound("訂單"));
        return view(o, items.findByOrderIds(List.of(o.getId())));
    }

    private PageResponse<OrderView> withItems(Page<Order> page) {
        List<Long> ids = page.getContent().stream().map(Order::getId).toList();
        Map<Long, List<OrderItem>> byOrder = ids.isEmpty() ? Map.of()
                : items.findByOrderIds(ids).stream().collect(Collectors.groupingBy(OrderItem::orderId));
        return PageResponse.of(page, page.getContent().stream()
                .map(o -> view(o, byOrder.getOrDefault(o.getId(), List.of()))).toList());
    }

    private static OrderView view(Order o, List<OrderItem> lines) {
        return new OrderView(o.getOrderNo(), o.getStatus(), o.getTotalAmount(), o.getCreatedAt(), o.getPaymentDeadline(),
                lines.stream().map(i -> new OrderLineView(i.getProductId(), i.getProductName(), i.getUnitPrice(),
                        i.getQuantity(), i.getLineAmount())).toList());
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/OrderTransitionService.java`**

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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * 4.6 把一個事件套用到一張訂單上。0.5.5 的硬規則：
 *   UPDATE orders SET status = :to, ..., version = version + 1 WHERE id = :id AND status = :from
 * 影響 0 列 = 狀態已經被別人改了 → 重新讀取，再問一次狀態機（最多 3 次）。
 * 同一個交易裡完成 0.5.4 表格左欄的所有副作用（預留、歷史、退款單）。
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

    record Current(OrderStatus status, String trackingNo) {}

    private final JdbcTemplate jdbc;
    private final InventoryApi inventory;
    private final PaymentApi payments;
    private final OrderHistory history;
    private final Clock clock;

    OrderTransitionService(JdbcTemplate jdbc, InventoryApi inventory, PaymentApi payments, OrderHistory history, Clock clock) {
        this.jdbc = jdbc;
        this.inventory = inventory;
        this.payments = payments;
        this.history = history;
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
                            cur.status() == OrderStatus.CANCELLED ? RefundReason.LATE_PAYMENT : RefundReason.DUPLICATE_PAYMENT);
                    return cur.status();
                }
                case TRANSITION -> {
                    Instant now = clock.instant();
                    if (update(orderId, cur.status(), d.to(), event, data, now) == 1) {
                        sideEffects(orderId, cur.status(), d, event, data);
                        history.record(orderId, cur.status(), d.to(), event.name(), actor, now);
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
        List<Map<String, Object>> rows = jdbc.queryForList("SELECT status, tracking_no FROM orders WHERE id = ?" + lock, orderId);
        if (rows.isEmpty()) throw ShopException.notFound("訂單");
        return new Current(OrderStatus.valueOf((String) rows.get(0).get("status")), (String) rows.get(0).get("tracking_no"));
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
    private void sideEffects(long orderId, OrderStatus from, Decision d, OrderEvent event, EventData data) {
        switch (d.to()) {
            case PAID -> inventory.confirm(orderId);                        // HELD → CONFIRMED：從此不能被逾時釋放（US-ORD-3 AC-4）
            case SHIPPED -> inventory.consume(orderId);                     // onHand、reserved 同時減少（US-ORD-6 AC-2）
            case CANCELLED -> {
                inventory.release(orderId);
                if (d.refund()) payments.succeededPaymentOf(orderId).ifPresent(pid -> payments.requestRefund(pid,
                        event == OrderEvent.BUYER_CANCEL ? RefundReason.BUYER_CANCEL : RefundReason.SELLER_CANCEL));
            }
            default -> { }
        }
    }

    private static String cancelReason(OrderEvent event, EventData data) {
        return switch (event) {
            case BUYER_CANCEL -> "BUYER";
            case PAYMENT_TIMEOUT -> "PAYMENT_TIMEOUT";
            case SELLER_CANCEL -> data.cancelReason() == null ? "SELLER_OUT_OF_STOCK" : data.cancelReason();
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

**`src/main/java/com/example/shop/ordering/internal/OrderCommands.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;
import com.example.shop.ordering.internal.OrderDtos.OrderView;
import com.example.shop.ordering.internal.OrderDtos.PaymentStarted;
import com.example.shop.ordering.internal.OrderTransitionService.EventData;
import com.example.shop.payment.PaymentApi;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 買家與賣家對「自己的」訂單下的指令。別人的訂單一律 404（US-ORD-4 AC-5）。 */
@Service
public class OrderCommands {

    private final OrderRepository orders;
    private final OrderTransitionService transitions;
    private final OrderQueryService queries;
    private final PaymentApi payments;

    OrderCommands(OrderRepository orders, OrderTransitionService transitions, OrderQueryService queries, PaymentApi payments) {
        this.orders = orders;
        this.transitions = transitions;
        this.queries = queries;
        this.payments = payments;
    }

    /**
     * 只查 id，不載入 Entity（4.6.5）：狀態轉移用 JDBC 的條件式 UPDATE 改資料庫，
     * 如果這裡把 Order 載進了 persistence context，之後同一個交易裡的 queries.byId() 會拿到那個「改之前」的 Entity。
     */
    private long buyers(long buyerId, String orderNo) {
        return orders.findIdByOrderNoAndBuyerId(orderNo, buyerId).orElseThrow(() -> ShopException.notFound("訂單"));
    }

    private long sellers(long sellerId, String orderNo) {
        return orders.findIdByOrderNoAndSellerId(orderNo, sellerId).orElseThrow(() -> ShopException.notFound("訂單"));
    }

    @Transactional
    public OrderView cancelByBuyer(long buyerId, String orderNo) {                     // US-ORD-4
        long id = buyers(buyerId, orderNo);
        transitions.apply(id, OrderEvent.BUYER_CANCEL, OrderHistory.Actor.buyer(buyerId), EventData.cancel("BUYER"));
        return queries.byId(id);
    }

    @Transactional
    public OrderView confirmReceipt(long buyerId, String orderNo) {                    // US-ORD-6 AC-3
        long id = buyers(buyerId, orderNo);
        transitions.apply(id, OrderEvent.CONFIRM_RECEIPT, OrderHistory.Actor.buyer(buyerId), EventData.NONE);
        return queries.byId(id);
    }

    @Transactional
    public PaymentStarted startPayment(long buyerId, String orderNo) {                 // US-ORD-2 AC-1
        long id = buyers(buyerId, orderNo);
        Order o = orders.findById(id).orElseThrow();
        if (o.getStatus() != OrderStatus.PENDING_PAYMENT)
            throw new ShopException(ProblemType.INVALID_STATE, "這張訂單不是待付款狀態").with("orderStatus", o.getStatus());
        PaymentApi.CreatedPayment p = payments.create(id, o.getTotalAmount());
        return new PaymentStarted(p.paymentId(), p.amount(), p.payUrl());
    }

    @Transactional
    public OrderView startPicking(long sellerId, String orderNo) {                     // US-ORD-6 AC-1
        long id = sellers(sellerId, orderNo);
        transitions.apply(id, OrderEvent.START_PICKING, OrderHistory.Actor.seller(sellerId), EventData.NONE);
        return queries.byId(id);
    }

    @Transactional
    public OrderView ship(long sellerId, String orderNo, String carrier, String trackingNo) {   // US-ORD-6 AC-2
        long id = sellers(sellerId, orderNo);
        transitions.apply(id, OrderEvent.SHIP, OrderHistory.Actor.seller(sellerId), EventData.shipment(carrier, trackingNo));
        return queries.byId(id);
    }

    @Transactional
    public OrderView cancelBySeller(long sellerId, String orderNo) {                   // US-ORD-6 AC-5
        long id = sellers(sellerId, orderNo);
        transitions.apply(id, OrderEvent.SELLER_CANCEL, OrderHistory.Actor.seller(sellerId), EventData.cancel("SELLER_OUT_OF_STOCK"));
        return queries.byId(id);
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/web/OrderCommandController.java`**

```java
package com.example.shop.ordering.internal.web;

import com.example.shop.ordering.OrderingApi;
import com.example.shop.ordering.internal.OrderCommands;
import com.example.shop.ordering.internal.OrderDtos.*;
import com.example.shop.ordering.internal.OrderQueryService;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.Role;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/** 買家的訂單指令（US-ORD-1、2、4、6） */
@RestController
@RequestMapping("/api/orders")
class OrderCommandController {

    private final OrderingApi ordering;
    private final OrderCommands commands;
    private final OrderQueryService queries;

    OrderCommandController(OrderingApi ordering, OrderCommands commands, OrderQueryService queries) {
        this.ordering = ordering;
        this.commands = commands;
        this.queries = queries;
    }

    /** US-ORD-1a AC-1：第一次 201；同一個鍵、同樣內容再送一次 → 200 與同一張訂單 */
    @PostMapping
    ResponseEntity<OrderView> place(CurrentUser user,
                                    @RequestHeader("Idempotency-Key") @NotBlank(message = "Idempotency-Key 不可空白")
                                    @Size(max = 64, message = "Idempotency-Key 最多 64 字") String key,
                                    @Valid @RequestBody PlaceOrderRequest req) {
        OrderingApi.PlacedOrder placed = ordering.placeOrder(user.require(Role.BUYER).id(), key, req.items().stream()
                .map(l -> new OrderingApi.OrderLine(l.productId(), l.quantity(), l.unitPrice())).toList());
        return ResponseEntity.status(placed.replayed() ? HttpStatus.OK : HttpStatus.CREATED).body(queries.byId(placed.orderId()));
    }

    @PostMapping("/{orderNo}/cancel")
    OrderView cancel(CurrentUser user, @PathVariable String orderNo) {
        return commands.cancelByBuyer(user.require(Role.BUYER).id(), orderNo);
    }

    @PostMapping("/{orderNo}/confirm-receipt")
    OrderView confirmReceipt(CurrentUser user, @PathVariable String orderNo) {
        return commands.confirmReceipt(user.require(Role.BUYER).id(), orderNo);
    }

    @PostMapping("/{orderNo}/payments")
    @ResponseStatus(HttpStatus.CREATED)
    PaymentStarted pay(CurrentUser user, @PathVariable String orderNo) {
        return commands.startPayment(user.require(Role.BUYER).id(), orderNo);
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/web/SellerOrderCommandController.java`**

```java
package com.example.shop.ordering.internal.web;

import com.example.shop.ordering.internal.OrderCommands;
import com.example.shop.ordering.internal.OrderDtos.OrderView;
import com.example.shop.ordering.internal.OrderDtos.ShipRequest;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.Role;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

/** 賣家的出貨流程（US-ORD-6） */
@RestController
@RequestMapping("/api/seller/orders/{orderNo}")
class SellerOrderCommandController {

    private final OrderCommands commands;

    SellerOrderCommandController(OrderCommands commands) { this.commands = commands; }

    @PostMapping("/start-picking")
    OrderView startPicking(CurrentUser user, @PathVariable String orderNo) {
        return commands.startPicking(user.require(Role.SELLER).id(), orderNo);
    }

    @PostMapping("/ship")
    OrderView ship(CurrentUser user, @PathVariable String orderNo, @Valid @RequestBody ShipRequest req) {
        return commands.ship(user.require(Role.SELLER).id(), orderNo, req.carrier().strip(), req.trackingNo().strip());
    }

    @PostMapping("/cancel")
    OrderView cancel(CurrentUser user, @PathVariable String orderNo) {
        return commands.cancelBySeller(user.require(Role.SELLER).id(), orderNo);
    }
}
```

**`src/main/java/com/example/shop/cart/internal/CartService.java`**

```java
package com.example.shop.cart.internal;

import com.example.shop.cart.CartApi;
import com.example.shop.cart.internal.CartDtos.*;
import org.springframework.transaction.annotation.Propagation;
import com.example.shop.catalog.CatalogApi;
import com.example.shop.catalog.ProductSnapshot;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.error.ConstraintViolations;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.*;

/**
 * 購物車。只有一張表、沒有關聯、寫入需要「不存在就新增、存在就相加」—— 這正是 JPA 表達不好的東西，
 * 所以這個模組直接用 JdbcTemplate（08-jpa-mybatis/09 的選型：用最能表達這個操作的工具）。
 */
@Service
public class CartService implements CartApi {

    static final int MAX_DISTINCT_ITEMS = 50;          // US-CART-1 AC-3

    private final JdbcTemplate jdbc;
    private final CatalogApi catalog;
    private final InventoryApi inventory;

    CartService(JdbcTemplate jdbc, CatalogApi catalog, InventoryApi inventory) {
        this.jdbc = jdbc;
        this.catalog = catalog;
        this.inventory = inventory;
    }

    record Row(long productId, int quantity, BigDecimal priceAtAdd) {}

    List<Row> rows(long buyerId) {
        return jdbc.query("SELECT product_id, quantity, unit_price_at_add FROM cart_items WHERE buyer_id = ? ORDER BY added_at, product_id",
                (rs, i) -> new Row(rs.getLong(1), rs.getInt(2), rs.getBigDecimal(3)), buyerId);
    }

    /** US-CART-1 AC-1：已存在就數量相加。一句 SQL，沒有「先查再寫」的競態（3.6.1） */
    @Transactional
    public CartView add(long buyerId, AddItemRequest req) {
        ProductSnapshot p = catalog.snapshots(List.of(req.productId())).get(req.productId());
        if (p == null || !p.purchasable()) throw new ShopException(ProblemType.PRODUCT_UNAVAILABLE, "商品目前無法購買").with("productId", req.productId());
        Integer distinct = jdbc.queryForObject("SELECT COUNT(*) FROM cart_items WHERE buyer_id = ? AND product_id <> ?",
                Integer.class, buyerId, req.productId());
        if (distinct >= MAX_DISTINCT_ITEMS)
            throw new ShopException(ProblemType.VALIDATION, "購物車最多 " + MAX_DISTINCT_ITEMS + " 種商品");
        try {
            jdbc.update("""
                    INSERT INTO cart_items (buyer_id, product_id, quantity, unit_price_at_add) VALUES (?, ?, ?, ?) AS new
                    ON DUPLICATE KEY UPDATE quantity = cart_items.quantity + new.quantity, updated_at = CURRENT_TIMESTAMP(3)""",
                    buyerId, req.productId(), req.quantity(), p.price());
        } catch (DataAccessException e) {
            // 相加之後超過 99：由 ck_cart_items_quantity 在資料庫裡原子地判斷（兩個請求同時加，也只會有一個成功）。
            // 注意接的是 DataAccessException：CHECK 違反在 Spring 眼中是 UncategorizedSQLException，不是 DataIntegrityViolationException（3.6.1）
            if (!ConstraintViolations.isViolationOf(e, "ck_cart_items_quantity")) throw e;
            throw new ShopException(ProblemType.VALIDATION, "同一個商品最多 99 件").with("productId", req.productId());
        }
        return view(buyerId);
    }

    @Transactional
    public CartView change(long buyerId, long productId, ChangeQuantityRequest req) {
        int n = jdbc.update("UPDATE cart_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE buyer_id = ? AND product_id = ?",
                req.quantity(), buyerId, productId);
        if (n == 0) throw ShopException.notFound("購物車品項");
        return view(buyerId);
    }

    @Transactional
    public CartView remove(long buyerId, long productId) {
        jdbc.update("DELETE FROM cart_items WHERE buyer_id = ? AND product_id = ?", buyerId, productId);   // 冪等：刪不存在的也回 200
        return view(buyerId);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void removeItems(long buyerId, Collection<Long> productIds) {
        if (productIds.isEmpty()) return;
        String in = String.join(",", productIds.stream().map(x -> "?").toList());
        List<Object> args = new ArrayList<>();
        args.add(buyerId);
        args.addAll(productIds);
        jdbc.update("DELETE FROM cart_items WHERE buyer_id = ? AND product_id IN (" + in + ")", args.toArray());
    }

    /** US-CART-2：最新的價格、可購買狀態、庫存提示，依賣家分組 */
    @Transactional(readOnly = true)
    public CartView view(long buyerId) {
        List<Row> rows = rows(buyerId);
        List<Long> ids = rows.stream().map(Row::productId).toList();
        Map<Long, ProductSnapshot> products = catalog.snapshots(ids);      // 一句 SQL（不是每個品項一句）
        Map<Long, Integer> available = inventory.available(ids);          // 一句 SQL
        Map<Long, List<CartLine>> bySeller = new LinkedHashMap<>();
        for (Row r : rows) {
            ProductSnapshot p = products.get(r.productId());
            if (p == null) continue;                                       // 商品不存在（本專題不硬刪，理論上不會發生）
            boolean changed = p.price().compareTo(r.priceAtAdd()) != 0;    // compareTo，不是 equals（第 04 章會看到為什麼）
            List<String> warnings = new ArrayList<>();
            if (available.getOrDefault(p.id(), 0) < r.quantity()) warnings.add("INSUFFICIENT_STOCK");   // AC-5：提醒，不擋
            bySeller.computeIfAbsent(p.sellerId(), k -> new ArrayList<>()).add(new CartLine(p.id(), p.name(), p.price(), r.quantity(),
                    changed, changed ? r.priceAtAdd() : null, !p.purchasable(), warnings));
        }
        List<SellerGroup> groups = bySeller.entrySet().stream().map(e -> new SellerGroup(e.getKey(), e.getValue(),
                e.getValue().stream().filter(l -> !l.unavailable())
                        .map(l -> l.unitPrice().multiply(BigDecimal.valueOf(l.quantity()))).reduce(BigDecimal.ZERO, BigDecimal::add))).toList();
        return new CartView(groups, rows.size());
    }
}
```

**`src/main/java/com/example/shop/inventory/InventoryApi.java`**

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

    /**
     * 建立一個商品的庫存列（US-PRD-1 AC-1），並記一筆 INITIAL。
     * 必須在呼叫端既有的交易內呼叫（Propagation.MANDATORY）：商品沒建成，庫存列也不能存在。
     */
    void initialize(long productId, int onHand, String note);

    /**
     * 為一張訂單預留庫存（每個品項一筆 HELD 預留）。全有或全無：任何一個品項不足就丟例外，呼叫端的交易應該 rollback。
     * 內部會依 productId 排序後才加鎖（4.2.3：避免兩張訂單以相反的順序鎖同樣兩個商品而死鎖）。
     * 必須在呼叫端既有的交易內呼叫（Propagation.MANDATORY）。
     */
    void reserve(long orderId, List<ReserveLine> lines);

    /** 付款成功：這張訂單的預留 HELD → CONFIRMED（不再能被逾時釋放）。數量不變，不記帳。MANDATORY。 */
    void confirm(long orderId);

    /** 取消：這張訂單的預留 → RELEASED，reserved 減回，每個品項一筆 RELEASE。已釋放的不重複釋放（冪等）。MANDATORY。 */
    void release(long orderId);

    /** 出貨：CONFIRMED → CONSUMED，onHand 與 reserved 同時減少，每個品項一筆 SHIP。MANDATORY。 */
    void consume(long orderId);

    /** 補貨：onHand 增加，並記一筆 RESTOCK。自己開交易。 */
    void restock(long productId, int quantity, String note);

    /** 批次補貨：一個交易、兩句 batch（UPDATE + ledger INSERT）。給匯入功能用。 */
    void restockBatch(List<RestockLine> lines, String note);

    record RestockLine(long productId, int quantity) {}

    /** 可售庫存 = onHand - reserved。 */
    int available(long productId);

    /** 一次查多個商品的可售庫存（一句 SQL）。沒有庫存列的商品不會出現在結果裡。 */
    Map<Long, Integer> available(Collection<Long> productIds);
}
```

**`src/main/java/com/example/shop/inventory/internal/JdbcInventoryService.java`**

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
class JdbcInventoryService implements InventoryApi {

    private final JdbcTemplate jdbc;

    JdbcInventoryService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void initialize(long productId, int onHand, String note) {
        if (onHand < 0) throw new IllegalArgumentException("onHand must not be negative");
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", productId, onHand);
        if (onHand > 0) ledger(productId, onHand, 0, "INITIAL", note);     // ck_ledger_delta：數量為 0 就不記帳
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void reserve(long orderId, List<ReserveLine> lines) {
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
        for (Held h : held(orderId, "'HELD', 'CONFIRMED'")) {
            jdbc.update("UPDATE inventory SET reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = ?",
                    h.quantity(), h.productId());
            jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
            ledger(h.productId(), 0, -h.quantity(), "RELEASE", "order:" + orderId);
        }
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void consume(long orderId) {
        for (Held h : held(orderId, "'CONFIRMED'")) {
            jdbc.update("""
                    UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE product_id = ?""", h.quantity(), h.quantity(), h.productId());
            jdbc.update("UPDATE inventory_reservations SET status = 'CONSUMED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
            ledger(h.productId(), -h.quantity(), -h.quantity(), "SHIP", "order:" + orderId);
        }
    }

    record Held(long id, long productId, int quantity) {}

    /**
     * 這張訂單還佔著庫存的預留，依 productId 排序。先鎖預留列（FOR UPDATE），再依序改 inventory：
     * 同一張訂單的兩個釋放（例如兩個排程實例）會在第一句就排隊，第二個進來時看到的已經是 RELEASED —— 不會重複減。
     * 註：這裡的 statuses 只會是程式裡的常數，不是使用者輸入。
     */
    private List<Held> held(long orderId, String statuses) {
        return jdbc.query("""
                SELECT id, product_id, quantity FROM inventory_reservations
                 WHERE order_id = ? AND status IN (%s) ORDER BY product_id FOR UPDATE""".formatted(statuses),
                (rs, i) -> new Held(rs.getLong(1), rs.getLong(2), rs.getInt(3)), orderId);
    }

    @Override
    @Transactional
    public void restock(long productId, int quantity, String note) {
        if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
        jdbc.update("UPDATE inventory SET on_hand = on_hand + ? WHERE product_id = ?", quantity, productId);
        ledger(productId, quantity, 0, "RESTOCK", note);
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
    }

    @Override
    @Transactional(readOnly = true)
    public int available(long productId) {
        Integer v = jdbc.queryForObject(
                "SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, productId);
        return v == null ? 0 : v;
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

    private void ledger(long productId, int deltaOnHand, int deltaReserved, String reason, String ref) {
        jdbc.update("""
                INSERT INTO inventory_ledger(product_id, delta_on_hand, delta_reserved, reason, ref)
                VALUES (?, ?, ?, ?, ?)""", productId, deltaOnHand, deltaReserved, reason, ref);
    }
}
```

**`src/main/java/com/example/shop/payment/internal/JdbcPaymentService.java`**

```java
package com.example.shop.payment.internal;

import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.RefundReason;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Service
class JdbcPaymentService implements PaymentApi {

    private static final Logger log = LoggerFactory.getLogger(JdbcPaymentService.class);

    private final JdbcTemplate jdbc;
    private final String secret;

    JdbcPaymentService(JdbcTemplate jdbc, ShopProperties props) {
        this.jdbc = jdbc;
        this.secret = props.payment().callbackSecret();
    }

    @Override
    @Transactional
    public CreatedPayment create(long orderId, BigDecimal amount) {
        GeneratedKeyHolder key = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(
                    "INSERT INTO payments (order_id, amount, status, provider) VALUES (?, ?, 'PENDING', 'SIMULATED')",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setLong(1, orderId);
            ps.setBigDecimal(2, amount);
            return ps;
        }, key);
        long id = key.getKey().longValue();
        return new CreatedPayment(id, amount, "https://pay.example.test/simulated/" + id);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public Recorded record(Callback cb) {
        String expected = CallbackSignature.sign(secret, CallbackSignature.canonical(cb.paymentId(), cb.providerTxnId(), cb.amount(), cb.succeeded()));
        if (!CallbackSignature.matches(expected, cb.signature())) {
            log.warn("PAYMENT_SIGNATURE_INVALID paymentId={}", cb.paymentId());       // 第 05 章寫進 audit_logs
            throw new ShopException(ProblemType.UNAUTHENTICATED, "簽章不正確");
        }
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT order_id, amount, status, provider_txn_id FROM payments WHERE id = ? FOR UPDATE", cb.paymentId());
        if (rows.isEmpty()) throw ShopException.notFound("付款");
        Map<String, Object> p = rows.get(0);
        long orderId = ((Number) p.get("order_id")).longValue();
        if (((BigDecimal) p.get("amount")).compareTo(cb.amount()) != 0) {
            log.error("PAYMENT_AMOUNT_MISMATCH paymentId={} expected={} actual={}", cb.paymentId(), p.get("amount"), cb.amount());   // AC-4：告警
            throw new ShopException(ProblemType.VALIDATION, "金額與付款不符");
        }
        String status = (String) p.get("status");
        if ("SUCCEEDED".equals(status)) {
            if (cb.providerTxnId().equals(p.get("provider_txn_id"))) return new Recorded(cb.paymentId(), orderId, Recorded.Kind.DUPLICATE);  // AC-5
            throw new ShopException(ProblemType.VALIDATION, "這筆付款已經以另一個交易編號成功");
        }
        if (!cb.succeeded()) {
            jdbc.update("UPDATE payments SET status = 'FAILED', provider_txn_id = ?, failure_reason = 'provider', updated_at = CURRENT_TIMESTAMP(3), version = version + 1 WHERE id = ?",
                    cb.providerTxnId(), cb.paymentId());
            return new Recorded(cb.paymentId(), orderId, Recorded.Kind.FAILED);
        }
        jdbc.update("""
                UPDATE payments SET status = 'SUCCEEDED', provider_txn_id = ?, failure_reason = NULL,
                       updated_at = CURRENT_TIMESTAMP(3), version = version + 1
                 WHERE id = ?""", cb.providerTxnId(), cb.paymentId());
        return new Recorded(cb.paymentId(), orderId, Recorded.Kind.FIRST_SUCCESS);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void requestRefund(long paymentId, RefundReason reason) {
        // INSERT ... SELECT：金額與訂單從付款那一列來。uk_refunds_payment 讓重複呼叫只留下一筆：
        // 撞到這個鍵時什麼都不做（ON DUPLICATE KEY UPDATE 一個 no-op）。
        // 不用 INSERT IGNORE —— 它會把「所有」錯誤降級成警告，包括 CHECK 違反（那一列會被默默跳過）。
        jdbc.update("""
                INSERT INTO refunds (payment_id, order_id, amount, reason, status)
                SELECT id, order_id, amount, ?, 'PENDING' FROM payments WHERE id = ? AND status = 'SUCCEEDED'
                ON DUPLICATE KEY UPDATE payment_id = refunds.payment_id""",
                reason.name(), paymentId);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<Long> succeededPaymentOf(long orderId) {
        return jdbc.queryForList("""
                SELECT p.id FROM payments p
                 WHERE p.order_id = ? AND p.status = 'SUCCEEDED'
                   AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id)
                 ORDER BY p.updated_at, p.id LIMIT 1""", Long.class, orderId).stream().findFirst();
    }
}
```

**`src/main/java/com/example/shop/payment/package-info.java`**

```java
/** 付款模組。擁有：payments、refunds。對外只提供 {@link com.example.shop.payment.PaymentApi}。 */
package com.example.shop.payment;
```

**`src/main/java/com/example/shop/shared/config/ShopProperties.java`**

```java
package com.example.shop.shared.config;

import jakarta.validation.Valid;
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
public record ShopProperties(@Valid @NotNull Order order, @Valid @NotNull Security security, @Valid @NotNull Payment payment) {

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

    /** 0.6.5：JWT 金鑰至少 256 bits（32 bytes） */
    public record Security(
            @NotBlank @Size(min = 32, message = "JWT 金鑰至少 32 bytes（256 bits，0.6.5）") String jwtSecret,
            /** 第 03 章：用 X-Debug-User-Id header 當身分。只能在本機打開；第 05 章換成 JWT 後刪除 */
            boolean debugHeaders) {}
}
```

**`src/main/java/com/example/shop/shared/error/ShopException.java`**

```java
package com.example.shop.shared.error;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * 所有「業務上可預期」的失敗的共同父類別。每一個都帶著一個 ProblemType。
 *
 * 放在 shared（而不是 shared.web）：模組的例外是業務概念，不應該依賴 Web 層。
 * 模組依賴 shared 是允許的（1.6.2 規則一），所以 inventory 的 InsufficientStockException 可以繼承它，
 * 而 shared.web 的全域例外處理器只需要認識這一個類別 —— 不需要認識任何模組。
 */
public class ShopException extends RuntimeException {

    /** RFC 9457 的標準欄位。額外的屬性跟它們同名，JSON 裡就會出現兩個同名的鍵（4.6.5：前端讀到 "status": "PICKING"） */
    static final Set<String> RESERVED = Set.of("type", "title", "status", "detail", "instance");

    private final ProblemType type;
    private final Map<String, Object> properties = new LinkedHashMap<>();

    public ShopException(ProblemType type, String detail) {
        super(detail);
        this.type = type;
    }

    public ShopException with(String key, Object value) {
        if (RESERVED.contains(key)) throw new IllegalArgumentException("「" + key + "」是 Problem Details 的標準欄位，請換一個名字（例如 orderStatus）");
        properties.put(key, value);
        return this;
    }

    public ProblemType type() { return type; }
    public Map<String, Object> properties() { return Collections.unmodifiableMap(properties); }

    public static ShopException notFound(String what) {
        return new ShopException(ProblemType.NOT_FOUND, what + "不存在");
    }
}
```

**`src/main/java/com/example/shop/shared/web/GlobalExceptionHandler.java`**

```java
package com.example.shop.shared.web;

import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mapping.PropertyReferenceException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

import java.util.List;
import java.util.Map;

/**
 * 3.4 全站唯一的錯誤出口。三條規則：
 *  ① 每一個錯誤回應都是 Problem Details，type 來自 ProblemType（0.4.1）
 *  ② 回應裡「不含」堆疊、類別名、SQL、表名（0.6.5）—— 例外的 getMessage() 只能進日誌，不能進回應
 *  ③ 業務例外（ShopException）照它自己說的回；其他任何例外一律 500，而且一定要記日誌
 */
@RestControllerAdvice
class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    static ProblemDetail problem(ProblemType type, String detail) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(type.status(), detail);
        pd.setType(type.type());
        pd.setTitle(type.title());
        return pd;
    }

    @ExceptionHandler(ShopException.class)
    ResponseEntity<ProblemDetail> handleShop(ShopException e) {
        ProblemDetail pd = problem(e.type(), e.getMessage());
        e.properties().forEach(pd::setProperty);
        ResponseEntity.BodyBuilder b = ResponseEntity.status(e.type().status());
        Object retryAfter = e.properties().get("retryAfter");              // US-ORD-1a AC-3、限流（第 06 章）
        if (retryAfter != null) b.header(HttpHeaders.RETRY_AFTER, retryAfter.toString());
        return b.body(pd);
    }

    /** 缺少必要的 header（例如 Idempotency-Key，US-ORD-1 AC-7）或 path 變數 */
    @Override
    protected ResponseEntity<Object> handleServletRequestBindingException(org.springframework.web.bind.ServletRequestBindingException ex,
                                                                          HttpHeaders headers, HttpStatusCode status, WebRequest request) {
        String detail = ex instanceof org.springframework.web.bind.MissingRequestHeaderException m
                ? "缺少必要的 header：" + m.getHeaderName() : "請求缺少必要的參數";
        return ResponseEntity.badRequest().body(problem(ProblemType.VALIDATION, detail));
    }

    /** @RequestBody 的 Bean Validation 失敗：列出每一個欄位 */
    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(MethodArgumentNotValidException ex, HttpHeaders headers,
                                                                  HttpStatusCode status, WebRequest request) {
        ProblemDetail pd = problem(ProblemType.VALIDATION, "有 %d 個欄位不正確".formatted(ex.getErrorCount()));
        pd.setProperty("errors", ex.getFieldErrors().stream()
                .map(f -> Map.of("field", f.getField(), "message", String.valueOf(f.getDefaultMessage())))
                .toList());
        return ResponseEntity.badRequest().body(pd);
    }

    /** @RequestParam / @PathVariable 上的約束（Spring 6.1 起由 MVC 自己驗證） */
    @Override
    protected ResponseEntity<Object> handleHandlerMethodValidationException(HandlerMethodValidationException ex, HttpHeaders headers,
                                                                            HttpStatusCode status, WebRequest request) {
        ProblemDetail pd = problem(ProblemType.VALIDATION, "請求參數不正確");
        pd.setProperty("errors", ex.getAllValidationResults().stream()
                .flatMap(r -> r.getResolvableErrors().stream().map(err -> Map.of(
                        "field", String.valueOf(r.getMethodParameter().getParameterName()),
                        "message", String.valueOf(err.getDefaultMessage()))))
                .toList());
        return ResponseEntity.badRequest().body(pd);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    ResponseEntity<ProblemDetail> handleConstraintViolation(ConstraintViolationException e) {
        ProblemDetail pd = problem(ProblemType.VALIDATION, "請求參數不正確");
        pd.setProperty("errors", e.getConstraintViolations().stream()
                .map(v -> Map.of("field", v.getPropertyPath().toString(), "message", v.getMessage())).toList());
        return ResponseEntity.badRequest().body(pd);
    }

    /** JSON 格式錯誤、型別不符。預設的 detail 是 "Failed to read request"，這裡改成中文，但一樣不帶 Jackson 的原始訊息 */
    @Override
    protected ResponseEntity<Object> handleHttpMessageNotReadable(HttpMessageNotReadableException ex, HttpHeaders headers,
                                                                  HttpStatusCode status, WebRequest request) {
        log.debug("無法解析的請求內容", ex);
        return ResponseEntity.badRequest().body(problem(ProblemType.VALIDATION, "請求內容無法解析（JSON 格式或欄位型別不正確）"));
    }

    /** 排序欄位不存在（US-PRD-2 AC-3）。原始訊息會帶 Entity 的類別名，絕對不能回給客戶端 */
    @ExceptionHandler(PropertyReferenceException.class)
    ResponseEntity<ProblemDetail> handleBadSort(PropertyReferenceException e) {
        ProblemDetail pd = problem(ProblemType.VALIDATION, "不支援的排序欄位");
        pd.setProperty("errors", List.of(Map.of("field", "sort", "message", "不支援的排序欄位")));
        return ResponseEntity.badRequest().body(pd);
    }

    /**
     * 拿不到資料庫連線（連線池在 connection-timeout 內沒有空的連線、或資料庫掛了）：不是 bug，是過載或依賴故障。
     * 0.6.3：MySQL 掛掉時回 503；US-ORD-1b AC-1：搶購時「0 筆 500」（4.8.2）
     * 不直接寫 jdbc 的 CannotGetJdbcConnectionException：shared.web 不准依賴 org.springframework.jdbc（ModuleBoundaryTest），
     * 改接它的父類別 DataAccessResourceFailureException，第 06 章 Redis 連不上的 RedisConnectionFailureException 也是它的子類別
     */
    @ExceptionHandler({org.springframework.transaction.CannotCreateTransactionException.class,
                       org.springframework.dao.DataAccessResourceFailureException.class})
    ResponseEntity<ProblemDetail> handleNoConnection(Exception e) {
        log.warn("拿不到資料庫連線：{}", e.getMessage());
        return ResponseEntity.status(ProblemType.TEMPORARILY_UNAVAILABLE.status()).header(HttpHeaders.RETRY_AFTER, "1")
                .body(problem(ProblemType.TEMPORARILY_UNAVAILABLE, "系統忙碌中，請稍後再試"));
    }

    /** 其他所有例外：這是 bug。回 500、不帶任何細節，但一定要進日誌 */
    @ExceptionHandler(Exception.class)
    ResponseEntity<ProblemDetail> handleUnexpected(Exception e) {
        log.error("未預期的例外", e);
        return ResponseEntity.internalServerError().body(problem(ProblemType.INTERNAL, "系統發生錯誤，請稍後再試"));
    }
}
```

**`src/main/resources/application-local.yml`**

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true
    username: shop
    password: shop
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
    debug-headers: true            # 3.3.4：只有本機可以用 header 冒充任何人

management:
  endpoint:
    health:
      show-details: always
```

**`src/main/resources/application-prod.yml`**

```yaml
spring:
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

management:
  endpoint:
    health:
      show-details: when-authorized
```

**測試**

`CapstoneAcceptanceTest` 只列出本章新增的部分（`import`、Q1～Q3 共用的小工具、Q1～Q3）；Q4 以後與第 03 章相同。

**`src/test/java/com/example/shop/acceptance/CapstoneAcceptanceTest.java`**

```java
package com.example.shop.acceptance;

import com.example.shop.ShopApplication;
import jakarta.persistence.EntityManagerFactory;
import org.flywaydb.core.Flyway;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.flywaydb.core.api.MigrationInfo;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

@Tag("acceptance")
@DisplayName("期末專題驗收")
class CapstoneAcceptanceTest {

    // ───────── 第 04 章：Q1～Q3 共用的小工具 ─────────

    static ConfigurableApplicationContext startApp() {
        return new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--shop.order.jobs-enabled=false",
                "--spring.main.banner-mode=off", "--logging.level.root=WARN");
    }

    record Http(int status, String body, String retryAfter) {
        String orderNo() { return between("\"orderNo\":\"", "\""); }
        String type() { return between("\"type\":\"", "\""); }
        String between(String a, String b) { int i = body.indexOf(a); return i < 0 ? null : body.substring(i + a.length(), body.indexOf(b, i + a.length())); }
    }

    static Http placeOrder(int port, long buyer, String key, String itemsJson) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/orders"))
                .header("X-Debug-User-Id", String.valueOf(buyer)).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{\"items\": " + itemsJson + "}"));
        if (key != null) b.header("Idempotency-Key", key);
        HttpResponse<String> r = HttpClient.newHttpClient().send(b.build(), HttpResponse.BodyHandlers.ofString());
        return new Http(r.statusCode(), r.body(), r.headers().firstValue("Retry-After").orElse(null));
    }

    /** 直接用 SQL 建一個上架中的商品與它的庫存列（期初量 = stock） */
    static void product(JdbcTemplate jdbc, long id, int stock) {
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, ?, 100.00, 'ON_SALE')", id, "驗收商品 " + id);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", id, stock);
        if (stock > 0) jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, 0, 'INITIAL', 'acceptance')", id, stock);
    }

    static void cleanupBuyersAndProducts(JdbcTemplate jdbc, List<Long> buyers, List<Long> products) {
        for (long b : buyers) {
            jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ?", b);
            jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", b);
            jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", b);
            jdbc.update("DELETE FROM orders WHERE buyer_id = ?", b);
            jdbc.update("DELETE FROM cart_items WHERE buyer_id = ?", b);
        }
        for (long p : products) {
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", p);
            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", p);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", p);
            jdbc.update("DELETE FROM products WHERE id = ?", p);
        }
    }

    @Test
    @DisplayName("Q1 一筆訂單的交易邊界：下單失敗時，訂單、明細、庫存異動三張表都沒有殘留")
    void q1_transactionBoundary() throws Exception {
        long buyer = 990_001, a = 9_900_101, b = 9_900_102;
        try (var ctx = startApp()) {
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            try {
                product(jdbc, a, 5);
                product(jdbc, b, 0);                                         // B 沒有庫存
                jdbc.update("INSERT INTO cart_items (buyer_id, product_id, quantity, unit_price_at_add) VALUES (?, ?, 1, 100), (?, ?, 1, 100)", buyer, a, buyer, b);
                String ledgerBefore = jdbc.queryForObject("SELECT CONCAT(COUNT(*), '/', SUM(delta_reserved)) FROM inventory_ledger WHERE product_id = ?", String.class, a);

                // US-ORD-1 AC-5：A 有貨、B 沒貨 —— 先預留的 A（product_id 較小）必須跟著 rollback
                Http r = placeOrder(port, buyer, "q1-key", "[{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}, {\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]".formatted(a, b));
                Map<String, Object> residue = jdbc.queryForMap("""
                        SELECT (SELECT COUNT(*) FROM orders WHERE buyer_id = ?)                                  AS orders,
                               (SELECT COUNT(*) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?) AS items,
                               (SELECT COUNT(*) FROM inventory_reservations WHERE product_id IN (?, ?))          AS reservations,
                               (SELECT reserved FROM inventory WHERE product_id = ?)                              AS reserved_a,
                               (SELECT CONCAT(COUNT(*), '/', SUM(delta_reserved)) FROM inventory_ledger WHERE product_id = ?) AS ledger_a,
                               (SELECT COUNT(*) FROM idempotency_keys WHERE buyer_id = ?)                         AS idem_keys,
                               (SELECT COUNT(*) FROM cart_items WHERE buyer_id = ?)                               AS cart""",
                        buyer, buyer, a, b, a, a, buyer, buyer);
                System.out.println("Q1：HTTP " + r.status() + " " + r.type() + "，productId=" + r.between("\"productId\":", "}") + "；殘留：" + residue
                        + "（庫存帳下單前 " + ledgerBefore + "）");
                assertThat(r.status()).isEqualTo(409);
                assertThat(r.type()).isEqualTo("/problems/insufficient-stock");
                assertThat(residue).containsEntry("orders", 0L).containsEntry("items", 0L).containsEntry("reservations", 0L)
                        .containsEntry("reserved_a", 0).containsEntry("idem_keys", 0L).containsEntry("cart", 2L);
                assertThat(residue.get("ledger_a")).isEqualTo(ledgerBefore);

                // AC-4：失敗不快取。補貨之後，用同一個鍵再送一次，要能成功
                jdbc.update("UPDATE inventory SET on_hand = 3 WHERE product_id = ?", b);
                jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 3, 0, 'RESTOCK', 'acceptance')", b);
                Http retry = placeOrder(port, buyer, "q1-key", "[{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}, {\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]".formatted(a, b));
                System.out.println("Q1：補貨後用同一個鍵重送 → HTTP " + retry.status() + " " + retry.orderNo()
                        + "；購物車剩 " + jdbc.queryForObject("SELECT COUNT(*) FROM cart_items WHERE buyer_id = ?", Long.class, buyer) + " 項");
                assertThat(retry.status()).isEqualTo(201);
            } finally {
                cleanupBuyersAndProducts(jdbc, List.of(buyer), List.of(a, b));
            }
        }
    }

    @Test
    @DisplayName("Q2 100 條執行緒搶最後 1 件：恰好 1 筆成立、99 筆收到 409、庫存 = 0")
    void q2_noOversell() throws Exception {
        long hot = 9_900_201;
        List<Long> buyers = java.util.stream.LongStream.range(0, 100).map(i -> 990_200 + i).boxed().toList();
        try (var ctx = startApp()) {
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            try {
                product(jdbc, hot, 1);
                var pool = java.util.concurrent.Executors.newFixedThreadPool(100);
                var go = new java.util.concurrent.CountDownLatch(1);
                List<java.util.concurrent.Future<Http>> fs = new java.util.ArrayList<>();
                for (long buyer : buyers) fs.add(pool.submit(() -> {
                    go.await();
                    return placeOrder(port, buyer, "q2-" + buyer, "[{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]".formatted(hot));
                }));
                go.countDown();
                Map<String, Integer> outcomes = new java.util.TreeMap<>();
                for (var f : fs) { Http h = f.get(); outcomes.merge(h.status() + " " + (h.type() == null ? "" : h.type()), 1, Integer::sum); }
                pool.shutdown();
                Integer available = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, hot);
                System.out.println("Q2：" + outcomes + "；available = " + available);
                assertThat(outcomes).containsEntry("201 ", 1).containsEntry("409 /problems/insufficient-stock", 99).hasSize(2);
                assertThat(available).isZero();
            } finally {
                cleanupBuyersAndProducts(jdbc, buyers, List.of(hot));
            }
        }
    }

    @Test
    @DisplayName("Q3 同一個 Idempotency-Key 送兩次：只成立一筆，第二次回傳同一張訂單")
    void q3_idempotentPlaceOrder() throws Exception {
        long buyer = 990_003, p = 9_900_301;
        try (var ctx = startApp()) {
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            String items = "[{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]".formatted(p);
            try {
                product(jdbc, p, 100);
                Http first = placeOrder(port, buyer, "q3-seq", items);
                Http second = placeOrder(port, buyer, "q3-seq", items.replace("100}", "100.00}"));   // 同樣的內容（價格寫法不同）
                Http other = placeOrder(port, buyer, "q3-seq", items.replace("\"quantity\": 1", "\"quantity\": 2"));
                System.out.printf("Q3：先後送兩次 → %d %s、%d %s；同鍵不同內容 → %d %s%n",
                        first.status(), first.orderNo(), second.status(), second.orderNo(), other.status(), other.type());
                assertThat(first.status()).isEqualTo(201);
                assertThat(second.status()).isEqualTo(200);
                assertThat(second.orderNo()).isEqualTo(first.orderNo());
                assertThat(other.status()).isEqualTo(422);

                // 使用者連點：10 個請求帶同一個鍵，同時送出
                var pool = java.util.concurrent.Executors.newFixedThreadPool(10);
                var go = new java.util.concurrent.CountDownLatch(1);
                List<java.util.concurrent.Future<Http>> fs = new java.util.ArrayList<>();
                for (int i = 0; i < 10; i++) fs.add(pool.submit(() -> { go.await(); return placeOrder(port, buyer, "q3-burst", items); }));
                go.countDown();
                Map<String, Integer> outcomes = new java.util.TreeMap<>();
                java.util.Set<String> orderNos = new java.util.TreeSet<>();
                for (var f : fs) {
                    Http h = f.get();
                    outcomes.merge(h.status() + (h.retryAfter() != null ? "（Retry-After: " + h.retryAfter() + "）" : ""), 1, Integer::sum);
                    if (h.orderNo() != null) orderNos.add(h.orderNo());
                }
                pool.shutdown();
                Long orders = jdbc.queryForObject("SELECT COUNT(*) FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.buyer_id = ? AND i.product_id = ?", Long.class, buyer, p);
                System.out.println("Q3：同一個鍵同時送 10 次 → " + outcomes + "；出現過的訂單編號 " + orderNos + "；資料庫裡這位買家的訂單 " + orders + " 張");
                assertThat(orderNos).hasSize(1);
                assertThat(orders).isEqualTo(2);                             // q3-seq 一張 + q3-burst 一張
                assertThat(outcomes.keySet()).allMatch(k -> k.startsWith("200") || k.startsWith("201") || k.startsWith("409"));
            } finally {
                cleanupBuyersAndProducts(jdbc, List.of(buyer), List.of(p));
            }
        }
    }

    // …Q4～Q11：與第 03 章相同…
}
```

**`src/test/java/com/example/shop/ordering/internal/OrderFlowTest.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderingApi;
import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Clock;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 0.12.2 追溯表：ORD-1（下單）、ORD-1a（冪等）、ORD-2（付款回呼）、ORD-3（逾時）、ORD-4（買家取消）、ORD-6（出貨）。
 * 不用 @Transactional：下單會開自己的短交易（冪等鍵，REQUIRES_NEW），包在測試的交易裡反而測不到真的行為。改成每個測試結束時清掉自己的資料。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=false")
class OrderFlowTest {

    static final long BUYER = 990_401, OTHER_BUYER = 990_402, SELLER = 2, PRODUCT = 9_900_401;

    @Autowired OrderingApi ordering;
    @Autowired OrderCommands commands;
    @Autowired PaymentCallbackService callbacks;
    @Autowired OrderTransitionService transitions;
    @Autowired JdbcTemplate jdbc;
    @Autowired Clock clock;
    @Autowired ShopProperties props;

    @BeforeEach
    void setUp() {
        cleanup();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '流程測試', 100.00, 'ON_SALE')", PRODUCT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'flow')", PRODUCT);
    }

    @AfterEach
    void cleanup() {
        for (long b : List.of(BUYER, OTHER_BUYER)) {
            jdbc.update("DELETE f FROM refunds f JOIN orders o ON o.id = f.order_id WHERE o.buyer_id = ?", b);
            jdbc.update("DELETE p FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", b);
            jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ?", b);
            jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", b);
            jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", b);
            jdbc.update("DELETE FROM orders WHERE buyer_id = ?", b);
        }
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
    }

    String place(int qty) {
        return ordering.placeOrder(BUYER, "flow-" + System.nanoTime(),
                List.of(new OrderingApi.OrderLine(PRODUCT, qty, new BigDecimal("100")))).orderNo();   // 100 vs 資料庫的 100.00（4.2.4）
    }

    OrderingApi.PlacedOrder place(long buyer, String key, String price) {
        return ordering.placeOrder(buyer, key, List.of(new OrderingApi.OrderLine(PRODUCT, 1, new BigDecimal(price))));
    }

    long historyCount(String orderNo) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM order_status_history WHERE order_id = ?", Long.class, id(orderNo));
    }

    long id(String orderNo) { return jdbc.queryForObject("SELECT id FROM orders WHERE order_no = ?", Long.class, orderNo); }

    String status(String orderNo) { return jdbc.queryForObject("SELECT status FROM orders WHERE order_no = ?", String.class, orderNo); }

    String reservation(String orderNo) {
        return jdbc.queryForObject("SELECT status FROM inventory_reservations WHERE order_id = ?", String.class, id(orderNo));
    }

    List<String> refunds(String orderNo) {
        return jdbc.queryForList("SELECT reason FROM refunds WHERE order_id = ?", String.class, id(orderNo));
    }

    long pay(String orderNo, String txn, String amount, boolean ok, boolean goodSignature) {
        long pid = commands.startPayment(BUYER, orderNo).paymentId();
        callback(pid, txn, amount, ok, goodSignature);
        return pid;
    }

    void callback(long pid, String txn, String amount, boolean ok, boolean goodSignature) {
        BigDecimal a = new BigDecimal(amount);
        String sig = goodSignature ? CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(pid, txn, a, ok)) : "0".repeat(64);
        callbacks.handle(new PaymentApi.Callback(pid, txn, a, ok, sig));
    }

    int available() { return jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, PRODUCT); }

    @Test @DisplayName("ORD-1 AC-1～3：待付款、付款期限 = 建立 + 15 分鐘、HELD 預留、reserved 增加、onHand 不變")
    void placeOrder() {
        String no = place(2);
        Map<String, Object> o = jdbc.queryForMap("SELECT status, total_amount, TIMESTAMPDIFF(SECOND, created_at, payment_deadline) AS secs FROM orders WHERE order_no = ?", no);
        assertThat(o.get("status")).isEqualTo("PENDING_PAYMENT");
        assertThat((BigDecimal) o.get("total_amount")).isEqualByComparingTo("200");
        assertThat(((Number) o.get("secs")).longValue()).isEqualTo(props.order().paymentTimeout().toSeconds());
        assertThat(reservation(no)).isEqualTo("HELD");
        assertThat(jdbc.queryForMap("SELECT on_hand, reserved FROM inventory WHERE product_id = ?", PRODUCT)).containsEntry("on_hand", 10).containsEntry("reserved", 2);
    }

    @Test @DisplayName("ORD-1 AC-6：客戶端看到的是 90、資料庫是 100 → 409 price-changed，不建立訂單")
    void priceChanged() {
        assertThatThrownBy(() -> place(BUYER, "flow-price", "90")).isInstanceOf(ShopException.class)
                .satisfies(e -> assertThat(((ShopException) e).type()).isEqualTo(ProblemType.PRICE_CHANGED))
                .satisfies(e -> assertThat(((ShopException) e).properties()).containsKey("changes"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE buyer_id = ?", Long.class, BUYER)).isZero();
        assertThat(available()).isEqualTo(10);
    }

    @Test @DisplayName("ORD-1a AC-5：兩位買家用同一個鍵 → 兩張不同的訂單")
    void sameKeyDifferentBuyers() {
        var a = place(BUYER, "shared-key", "100");
        var b = place(OTHER_BUYER, "shared-key", "100");
        assertThat(a.replayed()).isFalse();
        assertThat(b.replayed()).isFalse();
        assertThat(a.orderNo()).isNotEqualTo(b.orderNo());
    }

    @Test @DisplayName("ORD-1a AC-6：鍵超過 24 小時 → 當成新的鍵，建立新的訂單")
    void expiredKeyIsNew() {
        var first = place(BUYER, "old-key", "100");
        jdbc.update("UPDATE idempotency_keys SET expires_at = NOW(3) - INTERVAL 1 SECOND WHERE buyer_id = ? AND idem_key = 'old-key'", BUYER);
        var second = place(BUYER, "old-key", "100");
        assertThat(second.replayed()).isFalse();
        assertThat(second.orderNo()).isNotEqualTo(first.orderNo());
        var third = place(BUYER, "old-key", "100");                         // 新的一輪：重送回傳第二張
        assertThat(third.replayed()).isTrue();
        assertThat(third.orderNo()).isEqualTo(second.orderNo());
    }

    @Test @DisplayName("ORD-2 AC-2、AC-5：付款成功 → PAID、預留 CONFIRMED；同一個交易編號再來一次什麼都不做")
    void paymentSucceeded() {
        String no = place(1);
        long pid = pay(no, "tx-ok", "100", true, true);
        callback(pid, "tx-ok", "100", true, true);                           // 金流重送
        assertThat(status(no)).isEqualTo("PAID");
        assertThat(reservation(no)).isEqualTo("CONFIRMED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM order_status_history WHERE order_id = ? AND event = 'PAY_SUCCEEDED'", Long.class, id(no))).isEqualTo(1);
    }

    @Test @DisplayName("ORD-2 AC-3、AC-4：簽章錯誤 → 401、金額不符 → 400；訂單與付款完全不變")
    void badCallbacks() {
        String no = place(1);
        long pid = commands.startPayment(BUYER, no).paymentId();
        assertThatThrownBy(() -> callback(pid, "tx-x", "100", true, false)).isInstanceOf(ShopException.class)
                .extracting(e -> ((ShopException) e).type()).isEqualTo(ProblemType.UNAUTHENTICATED);
        assertThatThrownBy(() -> callback(pid, "tx-x", "1", true, true)).isInstanceOf(ShopException.class)
                .extracting(e -> ((ShopException) e).type()).isEqualTo(ProblemType.VALIDATION);
        assertThat(status(no)).isEqualTo("PENDING_PAYMENT");
        assertThat(jdbc.queryForObject("SELECT status FROM payments WHERE id = ?", String.class, pid)).isEqualTo("PENDING");
    }

    @Test @DisplayName("ORD-2 AC-6：取消之後才到的付款 → 維持 CANCELLED、建立 LATE_PAYMENT 退款")
    void latePayment() {
        String no = place(1);
        long pid = commands.startPayment(BUYER, no).paymentId();
        commands.cancelByBuyer(BUYER, no);
        callback(pid, "tx-late", "100", true, true);
        assertThat(status(no)).isEqualTo("CANCELLED");
        assertThat(refunds(no)).containsExactly("LATE_PAYMENT");
        assertThat(available()).isEqualTo(10);
    }

    @Test @DisplayName("ORD-2 AC-7：付款失敗 → 訂單維持待付款，可以重試")
    void paymentFailed() {
        String no = place(1);
        pay(no, "tx-fail", "100", false, true);
        assertThat(status(no)).isEqualTo("PENDING_PAYMENT");
        pay(no, "tx-retry", "100", true, true);
        assertThat(status(no)).isEqualTo("PAID");
    }

    @Test @DisplayName("0.5.3 PAID + 不同筆 E1：同一張訂單付了兩次錢 → 第二筆自動退款")
    void paidTwice() {
        String no = place(1);
        long p1 = commands.startPayment(BUYER, no).paymentId();             // 買家開了兩個分頁，各按一次「付款」
        long p2 = commands.startPayment(BUYER, no).paymentId();
        callback(p1, "tx-1", "100", true, true);
        callback(p2, "tx-2", "100", true, true);
        assertThat(status(no)).isEqualTo("PAID");
        assertThatThrownBy(() -> commands.startPayment(BUYER, no)).isInstanceOf(ShopException.class)   // 已付款就不能再開付款
                .extracting(e -> ((ShopException) e).type()).isEqualTo(ProblemType.INVALID_STATE);
        assertThat(refunds(no)).containsExactly("DUPLICATE_PAYMENT");
    }

    @Test @DisplayName("ORD-4 AC-2、AC-4、AC-5：已付款取消 → 釋放 + BUYER_CANCEL 退款；再取消一次 200；別人的訂單 404")
    void buyerCancel() {
        String no = place(3);
        pay(no, "tx-c", "300", true, true);
        commands.cancelByBuyer(BUYER, no);
        commands.cancelByBuyer(BUYER, no);                                   // 冪等
        assertThat(status(no)).isEqualTo("CANCELLED");
        assertThat(reservation(no)).isEqualTo("RELEASED");
        assertThat(refunds(no)).containsExactly("BUYER_CANCEL");
        assertThat(available()).isEqualTo(10);
        assertThatThrownBy(() -> commands.cancelByBuyer(OTHER_BUYER, no)).isInstanceOf(ShopException.class)
                .extracting(e -> ((ShopException) e).type()).isEqualTo(ProblemType.NOT_FOUND);
    }

    @Test @DisplayName("ORD-6 AC-1、AC-2、AC-3：撿貨 → 出貨（CONSUMED、onHand 與 reserved 同時減少、SHIP 帳）→ 確認收貨")
    void shipping() {
        String no = place(2);
        pay(no, "tx-s", "200", true, true);
        commands.startPicking(SELLER, no);
        assertThatThrownBy(() -> commands.cancelByBuyer(BUYER, no)).isInstanceOf(ShopException.class)
                .extracting(e -> ((ShopException) e).type()).isEqualTo(ProblemType.INVALID_STATE);   // ORD-4 AC-3
        commands.ship(SELLER, no, "黑貓宅急便", "TW-1");
        assertThat(reservation(no)).isEqualTo("CONSUMED");
        assertThat(jdbc.queryForMap("SELECT on_hand, reserved FROM inventory WHERE product_id = ?", PRODUCT)).containsEntry("on_hand", 8).containsEntry("reserved", 0);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM inventory_ledger WHERE product_id = ? AND reason = 'SHIP'", Long.class, PRODUCT)).isEqualTo(1);
        commands.confirmReceipt(BUYER, no);
        assertThat(status(no)).isEqualTo("COMPLETED");
        assertThat(historyCount(no)).isEqualTo(5);                           // ORD-6 AC-6：下單、付款、撿貨、出貨、收貨
    }

    @Test @DisplayName("ORD-6 AC-4：出貨超過 7 天未確認 → 排程自動完成")
    void autoComplete() {
        String no = place(1);
        pay(no, "tx-ac", "100", true, true);
        commands.startPicking(SELLER, no);
        commands.ship(SELLER, no, "黑貓宅急便", "TW-2");
        OrderJobs jobs = new OrderJobs(jdbc, transitions, clock, props);
        while (jobs.autoComplete() > 0) { }                                  // 種子資料裡也可能有該完成的單：做到沒有為止
        assertThat(status(no)).isEqualTo("SHIPPED");                         // 還沒滿 7 天
        jdbc.update("UPDATE orders SET shipped_at = NOW(3) - INTERVAL 8 DAY WHERE order_no = ?", no);
        while (jobs.autoComplete() > 0) { }
        assertThat(status(no)).isEqualTo("COMPLETED");
        assertThat(jdbc.queryForObject("SELECT actor_type FROM order_status_history WHERE order_id = ? AND event = 'AUTO_COMPLETE'", String.class, id(no)))
                .isEqualTo("SYSTEM");
    }

    @Test @DisplayName("ORD-6 AC-5：賣家取消已付款的訂單 → SELLER_CANCEL 退款")
    void sellerCancel() {
        String no = place(1);
        pay(no, "tx-sc", "100", true, true);
        commands.cancelBySeller(SELLER, no);
        assertThat(jdbc.queryForObject("SELECT cancel_reason FROM orders WHERE order_no = ?", String.class, no)).isEqualTo("SELLER_OUT_OF_STOCK");
        assertThat(refunds(no)).containsExactly("SELLER_CANCEL");
    }

    @Test @DisplayName("ORD-3 AC-1、AC-4：過期未付款 → 排程取消並釋放；已付款的不會被逾時取消")
    void paymentTimeout() {
        String unpaid = place(1), paid = place(1);
        pay(paid, "tx-t", "100", true, true);
        jdbc.update("UPDATE orders SET payment_deadline = NOW(3) - INTERVAL 1 SECOND WHERE buyer_id = ?", BUYER);
        OrderJobs jobs = new OrderJobs(jdbc, transitions, clock, props);
        while (jobs.cancelExpired() > 0) { }
        assertThat(status(unpaid)).isEqualTo("CANCELLED");
        assertThat(jdbc.queryForObject("SELECT cancel_reason FROM orders WHERE order_no = ?", String.class, unpaid)).isEqualTo("PAYMENT_TIMEOUT");
        assertThat(reservation(unpaid)).isEqualTo("RELEASED");
        assertThat(status(paid)).isEqualTo("PAID");
        assertThat(reservation(paid)).isEqualTo("CONFIRMED");
    }
}
```

**`src/test/java/com/example/shop/api/OrderApiTest.java`**

```java
package com.example.shop.api;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 0.12.2 追溯表：US-ORD-1 AC-7 與請求驗證。這些請求都在進入 Service 之前就被擋下，不會寫任何資料。
 * （會真的下單的測試不能用 MockMvc + @Transactional：冪等鍵的 claim 是 REQUIRES_NEW，會在測試交易之外 commit —— 見 OrderFlowTest）
 */
@SpringBootTest(properties = "shop.order.jobs-enabled=false")
@AutoConfigureMockMvc
class OrderApiTest {

    static final String ITEMS = """
            {"items": [{"productId": 1, "quantity": 1, "unitPrice": 149}]}""";

    @Autowired MockMvc mvc;

    @Test @DisplayName("ORD-1 AC-7：沒帶 Idempotency-Key → 400，detail 指出缺哪個 header")
    void missingKey() throws Exception {
        mvc.perform(post("/api/orders").header("X-Debug-User-Id", 1001).contentType(MediaType.APPLICATION_JSON).content(ITEMS))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value("/problems/validation"))
                .andExpect(jsonPath("$.detail").value("缺少必要的 header：Idempotency-Key"));
    }

    @Test @DisplayName("Idempotency-Key 超過 64 字 → 400（欄位是 VARCHAR(64)）")
    void keyTooLong() throws Exception {
        mvc.perform(post("/api/orders").header("X-Debug-User-Id", 1001).header("Idempotency-Key", "k".repeat(65))
                        .contentType(MediaType.APPLICATION_JSON).content(ITEMS))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value("/problems/validation"));
    }

    @Test @DisplayName("數量 0、沒有單價 → 400，列出每一個欄位")
    void invalidLines() throws Exception {
        mvc.perform(post("/api/orders").header("X-Debug-User-Id", 1001).header("Idempotency-Key", "api-test")
                        .contentType(MediaType.APPLICATION_JSON).content("""
                                {"items": [{"productId": 1, "quantity": 0}]}"""))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors.length()").value(2));
    }

    @Test @DisplayName("賣家的出貨 API，買家呼叫 → 403（角色在 interceptor 檢查，3.4.4）")
    void buyerCannotShip() throws Exception {
        mvc.perform(post("/api/seller/orders/20260930-000001/ship").header("X-Debug-User-Id", 1001)
                        .contentType(MediaType.APPLICATION_JSON).content("""
                                {"carrier": "黑貓", "trackingNo": "T1"}"""))
                .andExpect(status().isForbidden());
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/OrderRaceRegressionTest.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.*;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 0.12.2 追溯表的 ORD-3 AC-3 與 AC-5，放進每次都會跑的 mvn test。
 * 4.2.5（E5）與 4.7.2（E6）是「對照實驗」：天真的版本 vs 本專題的版本、300 回合。這裡只留本專題的版本、縮小規模，
 * 讓「之後有人改壞了條件式 UPDATE 或 locking read」會在 CI 裡紅，而不是在搶購那天。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=false")
class OrderRaceRegressionTest {

    static final long PRODUCT = 9_900_501, BUYER = 990_501;
    static final long FIRST_ID = 99_070_000L;

    @Autowired JdbcTemplate jdbc;
    @Autowired PaymentCallbackService callbacks;
    @Autowired OrderTransitionService transitions;
    @Autowired Clock clock;
    @Autowired ShopProperties props;

    @BeforeEach
    void setUp() {
        cleanup();
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 100000, 0, 'INITIAL', 'race')", PRODUCT);
    }

    @AfterEach
    void cleanup() {
        jdbc.update("DELETE f FROM refunds f JOIN orders o ON o.id = f.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE p FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
    }

    /** 一張剛好過了付款期限的訂單：1 個品項、1 筆 HELD 預留、1 筆 PENDING 付款（付款 id = 訂單 id） */
    long expiredOrder(int i) {
        long id = FIRST_ID + i;
        jdbc.update("""
                INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline, created_at)
                VALUES (?, ?, ?, 2, 'PENDING_PAYMENT', 100, NOW(3) - INTERVAL 1 SECOND, NOW(3) - INTERVAL 15 MINUTE)""",
                id, "20990107-%06d".formatted(i), BUYER);
        jdbc.update("INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (?, ?, 'race', 100, 1)", id, PRODUCT);
        jdbc.update("UPDATE inventory SET reserved = reserved + 1 WHERE product_id = ?", PRODUCT);
        jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (?, ?, 1, 'HELD')", id, PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 0, 1, 'RESERVE', ?)", PRODUCT, "order:" + id);
        jdbc.update("INSERT INTO payments (id, order_id, amount, status, provider) VALUES (?, ?, 100, 'PENDING', 'SIMULATED')", id, id);
        return id;
    }

    void pay(long id) {
        BigDecimal amount = new BigDecimal("100.00");
        String sig = CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(id, "tx-" + id, amount, true));
        callbacks.handle(new PaymentApi.Callback(id, "tx-" + id, amount, true, sig));
    }

    Map<String, Object> inv2() {
        return jdbc.queryForMap("""
                SELECT i.reserved, (SELECT COALESCE(SUM(quantity), 0) FROM inventory_reservations r
                                     WHERE r.product_id = i.product_id AND r.status IN ('HELD', 'CONFIRMED')) AS held
                  FROM inventory i WHERE product_id = ?""", PRODUCT);
    }

    @Test
    @DisplayName("ORD-3 AC-5：付款回呼與逾時排程同時撞上同一張訂單（50 回合）→ 每一張都是兩種合法結局之一，0 個例外")
    void timeoutVsPayment() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        Map<String, Integer> outcomes = new TreeMap<>();
        List<Throwable> errors = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            long id = expiredOrder(i);
            CountDownLatch go = new CountDownLatch(1);
            Future<?> a = pool.submit(() -> { go.await(); pay(id); return null; });
            Future<?> b = pool.submit(() -> { go.await(); transitions.apply(id, OrderEvent.PAYMENT_TIMEOUT, OrderHistory.Actor.system(),
                    OrderTransitionService.EventData.NONE); return null; });
            go.countDown();
            for (Future<?> f : List.of(a, b)) { try { f.get(); } catch (ExecutionException e) { errors.add(e.getCause()); } }
            outcomes.merge(jdbc.queryForObject("""
                    SELECT CONCAT(o.status, '/', r.status, '/', p.status, '/', (SELECT COUNT(*) FROM refunds f WHERE f.order_id = o.id))
                      FROM orders o JOIN inventory_reservations r ON r.order_id = o.id JOIN payments p ON p.order_id = o.id
                     WHERE o.id = ?""", String.class, id), 1, Integer::sum);
        }
        pool.shutdown();
        System.out.println("ORD-3 AC-5：" + outcomes + "；例外 " + errors.size() + "；INV-2 " + inv2());
        assertThat(errors).isEmpty();
        assertThat(outcomes.keySet()).allMatch(k -> k.equals("PAID/CONFIRMED/SUCCEEDED/0") || k.equals("CANCELLED/RELEASED/SUCCEEDED/1"));
        assertThat(inv2().get("reserved")).isEqualTo(((Number) inv2().get("held")).intValue());
    }

    @Test
    @DisplayName("ORD-3 AC-3：三個排程實例同時處理 60 張過期訂單 → 每張只取消一次、RELEASE 不重複、INV-2 為 0")
    void threeSchedulers() throws Exception {
        for (int i = 0; i < 60; i++) expiredOrder(i);
        ExecutorService pool = Executors.newFixedThreadPool(3);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<?>> fs = new ArrayList<>();
        for (int i = 0; i < 3; i++) fs.add(pool.submit(() -> {
            go.await();
            OrderJobs jobs = new OrderJobs(jdbc, transitions, clock, props);
            while (jobs.cancelExpired() > 0) { }
            return null;
        }));
        go.countDown();
        for (Future<?> f : fs) f.get();
        pool.shutdown();
        Long cancelled = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE buyer_id = ? AND status = 'CANCELLED'", Long.class, BUYER);
        Long histories = jdbc.queryForObject("""
                SELECT COUNT(*) FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ? AND h.event = 'PAYMENT_TIMEOUT'""",
                Long.class, BUYER);
        Long releases = jdbc.queryForObject("SELECT COUNT(*) FROM inventory_ledger WHERE product_id = ? AND reason = 'RELEASE'", Long.class, PRODUCT);
        System.out.println("ORD-3 AC-3：取消 " + cancelled + " 張、歷史 " + histories + " 筆、RELEASE " + releases + " 筆；INV-2 " + inv2());
        assertThat(cancelled).isEqualTo(60);
        assertThat(histories).isEqualTo(60);
        assertThat(releases).isEqualTo(60);
        assertThat(inv2()).containsEntry("reserved", 0);
    }
}
```

**`src/test/java/com/example/shop/shared/error/ShopExceptionTest.java`**

```java
package com.example.shop.shared.error;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 4.6.5：額外屬性不可以跟 Problem Details 的標準欄位同名 */
class ShopExceptionTest {

    @ParameterizedTest
    @ValueSource(strings = {"type", "title", "status", "detail", "instance"})
    void reservedNamesAreRejected(String name) {
        assertThatThrownBy(() -> new ShopException(ProblemType.INVALID_STATE, "x").with(name, "PICKING"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining(name);
    }
}
```

**實驗**（`@Tag("experiment")`，用 `mvn test -Pexperiments -Dtest=<類別名>` 執行；前置條件見 4.2.0）

**`src/test/java/com/example/shop/ch04/E1FourWaysToReserveTest.java`**

```java
package com.example.shop.ch04;

import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 4.2.1 四種「扣庫存」的寫法，同一個情境：
 *   A. 100 個買家「同時」搶最後 1 件（CountDownLatch 讓 100 條執行緒在同一瞬間出發）
 *   B. 2,000 個買家搶 500 件（64 條執行緒，US-ORD-1b AC-2 的規模）
 * 每一筆下單 = 一個交易：預留 1 件 + 寫一筆訂單。在 shop_lab 的兩張小表上跑，只比較「扣庫存」那一步的寫法。
 */
@Tag("experiment")
class E1FourWaysToReserveTest {

    static HikariDataSource ds;
    static JdbcTemplate jdbc;
    static TransactionTemplate tx;

    @BeforeAll
    static void setUp() {
        ds = new HikariDataSource();
        ds.setJdbcUrl("jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC");
        ds.setUsername("shop");
        ds.setPassword("shop");
        ds.setMaximumPoolSize(100);
        jdbc = new JdbcTemplate(ds);
        tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
        jdbc.execute("DROP TABLE IF EXISTS e1_orders");
        jdbc.execute("DROP TABLE IF EXISTS e1_inventory");
        jdbc.execute("""
            CREATE TABLE e1_inventory (product_id BIGINT PRIMARY KEY, on_hand INT NOT NULL, reserved INT NOT NULL DEFAULT 0,
              version INT NOT NULL DEFAULT 0, CONSTRAINT ck_e1_reserved CHECK (reserved >= 0 AND reserved <= on_hand))""");
        jdbc.execute("CREATE TABLE e1_orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, buyer INT NOT NULL)");
    }

    @AfterAll
    static void tearDown() { ds.close(); }

    enum Outcome { PLACED, INSUFFICIENT, ERROR }

    static class SoldOut extends RuntimeException {}
    static class Conflict extends RuntimeException {}

    interface Way { Outcome order(int buyer); }

    static final Map<String, AtomicInteger> ERRORS = new ConcurrentHashMap<>();

    /** 每一種寫法：一個交易裡「確認有貨 → 預留 → 寫訂單」 */
    static final Map<String, Way> WAYS = new LinkedHashMap<>();
    static {
        WAYS.put("① 讀了再寫（reserved = 讀到的值 + 1）", buyer -> run(() -> {
            Map<String, Object> r = jdbc.queryForMap("SELECT on_hand, reserved FROM e1_inventory WHERE product_id = 1");
            int onHand = (Integer) r.get("on_hand"), reserved = (Integer) r.get("reserved");
            if (onHand - reserved < 1) throw new SoldOut();
            jdbc.update("UPDATE e1_inventory SET reserved = ? WHERE product_id = 1", reserved + 1);
        }, buyer));
        WAYS.put("② 讀了再寫（reserved = reserved + 1）", buyer -> run(() -> {
            Map<String, Object> r = jdbc.queryForMap("SELECT on_hand, reserved FROM e1_inventory WHERE product_id = 1");
            if ((Integer) r.get("on_hand") - (Integer) r.get("reserved") < 1) throw new SoldOut();
            jdbc.update("UPDATE e1_inventory SET reserved = reserved + 1 WHERE product_id = 1");
        }, buyer));
        WAYS.put("③ @Version 樂觀鎖，衝突就放棄", buyer -> run(() -> optimistic(), buyer));
        WAYS.put("④ @Version 樂觀鎖，衝突重試（最多 10 次）", buyer -> {
            for (int attempt = 0; attempt < 10; attempt++) {
                Outcome o = run(E1FourWaysToReserveTest::optimistic, buyer);
                if (o != Outcome.ERROR) return o;
            }
            return Outcome.ERROR;
        });
        WAYS.put("⑤ 悲觀鎖 SELECT ... FOR UPDATE", buyer -> run(() -> {
            Map<String, Object> r = jdbc.queryForMap("SELECT on_hand, reserved FROM e1_inventory WHERE product_id = 1 FOR UPDATE");
            if ((Integer) r.get("on_hand") - (Integer) r.get("reserved") < 1) throw new SoldOut();
            jdbc.update("UPDATE e1_inventory SET reserved = reserved + 1 WHERE product_id = 1");
        }, buyer));
        WAYS.put("⑥ 條件式 UPDATE（本專題）", buyer -> run(() -> {
            if (jdbc.update("UPDATE e1_inventory SET reserved = reserved + 1 WHERE product_id = 1 AND on_hand - reserved >= 1") == 0)
                throw new SoldOut();
        }, buyer));
    }

    static void optimistic() {
        Map<String, Object> r = jdbc.queryForMap("SELECT on_hand, reserved, version FROM e1_inventory WHERE product_id = 1");
        if ((Integer) r.get("on_hand") - (Integer) r.get("reserved") < 1) throw new SoldOut();
        if (jdbc.update("UPDATE e1_inventory SET reserved = reserved + 1, version = version + 1 WHERE product_id = 1 AND version = ?",
                r.get("version")) == 0) throw new Conflict();                 // 等同 JPA 的 ObjectOptimisticLockingFailureException
    }

    static Outcome run(Runnable reserve, int buyer) {
        try {
            tx.executeWithoutResult(s -> {
                reserve.run();
                jdbc.update("INSERT INTO e1_orders (buyer) VALUES (?)", buyer);
            });
            return Outcome.PLACED;
        } catch (SoldOut e) {
            return Outcome.INSUFFICIENT;
        } catch (RuntimeException e) {                                        // Conflict、CHECK 違反、鎖等待逾時、死鎖……
            Throwable root = e;
            while (root.getCause() != null) root = root.getCause();
            String why = e instanceof Conflict ? "version 不符（等同 ObjectOptimisticLockingFailureException）"
                    : e.getClass().getSimpleName() + "：" + root.getMessage();
            ERRORS.computeIfAbsent(why, k -> new AtomicInteger()).incrementAndGet();
            return Outcome.ERROR;
        }
    }

    record Result(int placed, int insufficient, int errors, int reserved, int orders, double p50, double p99, double seconds) {}

    static Result scenario(Way way, int stock, int buyers, int threads) throws Exception {
        jdbc.update("DELETE FROM e1_orders");
        jdbc.update("DELETE FROM e1_inventory");
        ERRORS.clear();
        jdbc.update("INSERT INTO e1_inventory (product_id, on_hand) VALUES (1, ?)", stock);
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch go = new CountDownLatch(1);
        AtomicInteger next = new AtomicInteger();
        ConcurrentLinkedQueue<Long> lat = new ConcurrentLinkedQueue<>();
        Map<Outcome, AtomicInteger> count = new EnumMap<>(Outcome.class);
        for (Outcome o : Outcome.values()) count.put(o, new AtomicInteger());
        List<Future<?>> fs = new ArrayList<>();
        for (int t = 0; t < threads; t++) fs.add(pool.submit(() -> {
            go.await();
            int b;
            while ((b = next.getAndIncrement()) < buyers) {
                long s = System.nanoTime();
                count.get(way.order(b)).incrementAndGet();
                lat.add(System.nanoTime() - s);
            }
            return null;
        }));
        long t0 = System.nanoTime();
        go.countDown();
        for (Future<?> f : fs) f.get();
        double secs = (System.nanoTime() - t0) / 1e9;
        pool.shutdown();
        long[] a = lat.stream().mapToLong(Long::longValue).sorted().toArray();
        return new Result(count.get(Outcome.PLACED).get(), count.get(Outcome.INSUFFICIENT).get(), count.get(Outcome.ERROR).get(),
                jdbc.queryForObject("SELECT reserved FROM e1_inventory", Integer.class),
                jdbc.queryForObject("SELECT COUNT(*) FROM e1_orders", Integer.class),
                a[a.length / 2] / 1e6, a[(int) (a.length * 0.99)] / 1e6, secs);
    }

    static void print(String name, Result r, int stock) {
        String verdict = r.orders() > stock ? "✗ 超賣 %d 件".formatted(r.orders() - stock)
                : r.orders() < Math.min(stock, r.orders() + r.insufficient() + r.errors()) && r.orders() < stock ? "△ 少賣 %d 件".formatted(stock - r.orders())
                : "✓";
        System.out.printf("  %-34s 成立 %4d  庫存不足 %4d  錯誤 %4d │ reserved=%4d 訂單=%4d │ p50 %6.1f ms  p99 %7.1f ms │ %s%n",
                name, r.placed(), r.insufficient(), r.errors(), r.reserved(), r.orders(), r.p50(), r.p99(), verdict);
        ERRORS.forEach((why, n) -> System.out.printf("  %-34s   └ 錯誤 %d 次：%s%n", "", n.get(), why));
    }

    @Test
    void fourWaysToReserve() throws Exception {
        for (Way w : WAYS.values()) scenario(w, 50, 200, 32);                // 暖機
        System.out.println("═══ 4.2.1 A：100 個買家同時搶最後 1 件（100 條執行緒）═══");
        for (var e : WAYS.entrySet()) print(e.getKey(), scenario(e.getValue(), 1, 100, 100), 1);
        System.out.println("\n═══ 4.2.1 B：2,000 個買家搶 500 件（64 條執行緒）═══");
        for (var e : WAYS.entrySet()) {
            Result r = scenario(e.getValue(), 500, 2000, 64);
            print(e.getKey(), r, 500);
            System.out.printf("  %-34s 總耗時 %.2f 秒%n", "", r.seconds());
        }
    }
}
```

**`src/test/java/com/example/shop/ch04/E2CaughtExceptionRollbackTest.java`**

```java
package com.example.shop.ch04;

import com.example.lab.ch04.FriendlyPlaceOrder;
import com.example.shop.inventory.InventoryApi;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 4.2.2 在 @Transactional 方法裡接住 InsufficientStockException —— 呼叫端看到的是什麼？
 * 用正式的 InventoryApi（JdbcInventoryService，reserve() 是 @Transactional(MANDATORY)）與正式的 schema。
 */
@Tag("experiment")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=false")
class E2CaughtExceptionRollbackTest {

    @TestConfiguration
    static class Config {
        @Bean FriendlyPlaceOrder friendlyPlaceOrder(JdbcTemplate jdbc, InventoryApi inventory) { return new FriendlyPlaceOrder(jdbc, inventory); }
    }

    @Autowired FriendlyPlaceOrder friendly;
    @Autowired JdbcTemplate jdbc;

    @Test
    void caughtExceptionStillRollsBack() {
        long productId = 900_402;
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", productId);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", productId);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", productId);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 0, 0)", productId);   // 可售 0
        System.out.println("═══ 4.2.2 在 @Transactional 裡接住「庫存不足」═══");
        try {
            System.out.println("  回傳值：" + friendly.place(424_242, productId));
        } catch (Exception e) {
            System.out.println("  丟出：" + e.getClass().getName());
            System.out.println("  訊息：" + e.getMessage());
        }

        // 100 個買家搶最後 1 件，走同一個「好心」的方法
        jdbc.update("UPDATE inventory SET on_hand = 1 WHERE product_id = ?", productId);
        java.util.Map<String, java.util.concurrent.atomic.AtomicInteger> outcomes = new java.util.concurrent.ConcurrentHashMap<>();
        var pool = java.util.concurrent.Executors.newFixedThreadPool(100);
        var go = new java.util.concurrent.CountDownLatch(1);
        var futures = new java.util.ArrayList<java.util.concurrent.Future<?>>();
        for (int i = 0; i < 100; i++) {
            long orderId = 424_300 + i;
            futures.add(pool.submit(() -> {
                go.await();
                String k;
                try { k = "回傳 " + friendly.place(orderId, productId); }
                catch (Exception e) { k = "丟出 " + e.getClass().getSimpleName(); }
                outcomes.computeIfAbsent(k, x -> new java.util.concurrent.atomic.AtomicInteger()).incrementAndGet();
                return null;
            }));
        }
        go.countDown();
        for (var f : futures) { try { f.get(); } catch (Exception ignored) { } }
        pool.shutdown();
        System.out.println("  ── 100 個買家同時搶最後 1 件 ──");
        new java.util.TreeMap<>(outcomes).forEach((k, v) -> System.out.printf("    %-44s %3d 次%n", k, v.get()));
        System.out.println("    reserved = " + jdbc.queryForObject("SELECT reserved FROM inventory WHERE product_id = ?", Integer.class, productId)
                + "，預留列 " + jdbc.queryForObject("SELECT COUNT(*) FROM inventory_reservations WHERE product_id = ?", Integer.class, productId) + " 筆");
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", productId);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", productId);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", productId);
    }
}
```

**`src/test/java/com/example/shop/ch04/E3LockOrderDeadlockTest.java`**

```java
package com.example.shop.ch04;

import com.example.shop.inventory.ReserveLine;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BiConsumer;

/**
 * 4.2.3 多品項訂單的鎖順序：一半的買家買 [A, B]、另一半買 [B, A]，16 條執行緒各跑 5 秒。
 * 兩個版本的 SQL 與 JdbcInventoryService.reserve() 一模一樣，品項之間都停 1 ms；唯一的差別是「有沒有先依 productId 排序」。
 */
@Tag("experiment")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=false")
class E3LockOrderDeadlockTest {

    static final long A = 900_601, B = 900_602;

    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;

    /** 跟 JdbcInventoryService.reserve() 一模一樣的 SQL；sorted = false 時照傳進來的順序 */
    void reserve(long orderId, List<ReserveLine> lines, boolean sorted) {
        List<ReserveLine> ordered = sorted ? lines.stream().sorted(java.util.Comparator.comparingLong(ReserveLine::productId)).toList() : lines;
        for (ReserveLine l : ordered) {
            int n = jdbc.update("UPDATE inventory SET reserved = reserved + ? WHERE product_id = ? AND on_hand - reserved >= ?",
                    l.quantity(), l.productId(), l.quantity());
            if (n == 0) throw new IllegalStateException("insufficient");
            jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (?, ?, ?, 'HELD')",
                    orderId, l.productId(), l.quantity());
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 0, ?, 'RESERVE', ?)",
                    l.productId(), l.quantity(), "order:" + orderId);
            try { Thread.sleep(1); } catch (InterruptedException e) { throw new RuntimeException(e); }   // 兩個品項之間的 1 ms（算運費、寫快照……）
        }
    }

    void reset() {
        for (long id : new long[]{A, B}) {
            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", id);
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10000000, 0)", id);
        }
    }

    record Stat(int ok, int deadlocks, double tps) {}

    Stat measure(BiConsumer<Long, List<ReserveLine>> reserve) throws Exception {
        reset();
        ExecutorService pool = Executors.newFixedThreadPool(16);
        AtomicBoolean stop = new AtomicBoolean();
        AtomicInteger ok = new AtomicInteger(), dead = new AtomicInteger();
        AtomicLong orderIds = new AtomicLong(90_000_000);
        for (int t = 0; t < 16; t++) {
            boolean ab = t % 2 == 0;
            pool.submit(() -> {
                while (!stop.get()) {
                    long orderId = orderIds.incrementAndGet();
                    List<ReserveLine> lines = ab ? List.of(new ReserveLine(A, 1), new ReserveLine(B, 1))
                                                 : List.of(new ReserveLine(B, 1), new ReserveLine(A, 1));
                    try { tx.executeWithoutResult(s -> reserve.accept(orderId, lines)); ok.incrementAndGet(); }
                    catch (PessimisticLockingFailureException e) { dead.incrementAndGet(); }
                }
                return null;
            });
        }
        Thread.sleep(5000);
        stop.set(true);
        pool.shutdown();
        pool.awaitTermination(10, TimeUnit.SECONDS);
        return new Stat(ok.get(), dead.get(), ok.get() / 5.0);
    }

    @Test
    void lockOrder() throws Exception {
        System.out.println("═══ 4.2.3 一半的訂單是 [A, B]、另一半是 [B, A]（16 條執行緒 × 5 秒）═══");
        measure((id, lines) -> reserve(id, lines, true));                  // 暖機
        Stat unsorted = measure((id, lines) -> reserve(id, lines, false));
        Stat sorted = measure((id, lines) -> reserve(id, lines, true));
        System.out.printf("  照購物車的順序預留     : 成立 %,6d 筆（%,5.0f 筆/秒）  死鎖 %,5d 次%n", unsorted.ok, unsorted.tps, unsorted.deadlocks);
        System.out.printf("  先依 productId 排序   : 成立 %,6d 筆（%,5.0f 筆/秒）  死鎖 %,5d 次%n", sorted.ok, sorted.tps, sorted.deadlocks);
        for (long id : new long[]{A, B}) {
            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", id);
        }
    }
}
```

**`src/test/java/com/example/shop/ch04/E4PriceScaleTest.java`**

```java
package com.example.shop.ch04;

import com.example.shop.ShopApplication;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * 4.2.4 價格比對用 equals 還是 compareTo：讓一個真的 JavaScript 客戶端（Node 22）去拿 500 個上架商品的詳情，
 * 印出它「會送出」的下單請求，再用 Jackson 把那些請求讀成 BigDecimal，跟資料庫的價格比。
 */
@Tag("experiment")
class E4PriceScaleTest {

    static final String NODE = System.getProperty("user.home") + "/.nvm/versions/node/v22.21.1/bin/node";

    @Test
    void priceScale() throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0",
                "--shop.order.jobs-enabled=false", "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            Map<Long, BigDecimal> dbPrice = new LinkedHashMap<>();
            jdbc.query("SELECT id, price FROM products WHERE status = 'ON_SALE' ORDER BY id LIMIT 500",
                    rs -> { dbPrice.put(rs.getLong(1), rs.getBigDecimal(2)); });

            List<String> cmd = new ArrayList<>(List.of(NODE, "src/test/resources/ch04/js-client.mjs", "http://localhost:" + port));
            dbPrice.keySet().forEach(id -> cmd.add(String.valueOf(id)));
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            List<String> bodies = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8)).lines().toList();
            p.waitFor();

            ObjectMapper json = new ObjectMapper();
            int equalsRejects = 0, compareRejects = 0;
            Map<String, Integer> sentScales = new TreeMap<>();
            for (String body : bodies) {
                JsonNode item = json.readTree(body).get("items").get(0);
                BigDecimal sent = json.treeToValue(item.get("unitPrice"), BigDecimal.class);   // Spring MVC 讀 @RequestBody 的方式
                BigDecimal db = dbPrice.get(item.get("productId").asLong());
                sentScales.merge("scale " + sent.scale(), 1, Integer::sum);
                if (!db.equals(sent)) equalsRejects++;
                if (db.compareTo(sent) != 0) compareRejects++;
            }
            System.out.println("═══ 4.2.4 JavaScript 前端送來的價格 vs 資料庫的價格（" + bodies.size() + " 個上架商品）═══");
            System.out.println("  前 3 個請求：");
            bodies.stream().limit(3).forEach(b -> System.out.println("    " + b));
            System.out.println("  資料庫裡的價格：" + dbPrice.values().stream().limit(3).toList());
            System.out.println("  送來的單價的 scale 分布：" + sentScales);
            System.out.printf("  用 equals 比較   → %d / %d 個被判定「價格已變動」%n", equalsRejects, bodies.size());
            System.out.printf("  用 compareTo 比較 → %d / %d 個被判定「價格已變動」%n", compareRejects, bodies.size());
        }
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/E5TimeoutVsPaymentRaceTest.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.util.*;
import java.util.concurrent.*;

/**
 * 4.2.5 US-ORD-3 AC-5：付款逾時的排程，與金流的「付款成功」回呼，在同一瞬間撞上同一張訂單。
 * 每一回合：一張剛好過了付款期限、還沒付款的訂單，兩條執行緒用 CountDownLatch 同時出發 —— 一條是回呼、一條是排程。
 * 放在 ordering.internal 套件裡，才能直接呼叫 package-private 的 OrderTransitionService。
 */
@Tag("experiment")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=false")
class E5TimeoutVsPaymentRaceTest {

    static final long PRODUCT = 900_701, BUYER = 990_005;
    static final int ROUNDS = 300;

    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;
    @Autowired PaymentCallbackService callbacks;
    @Autowired OrderTransitionService transitions;
    @Autowired ShopProperties props;

    record Setup(long orderId, long paymentId) {}

    /** 一張「已經過了付款期限、還沒付款」的訂單：1 個品項、1 筆 HELD 預留、1 筆 PENDING 付款 */
    Setup newExpiredOrder(int i) {
        long orderId = 99_050_000L + i;
        jdbc.update("""
                INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline, created_at)
                VALUES (?, ?, ?, 2, 'PENDING_PAYMENT', 100, NOW(3) - INTERVAL 1 SECOND, NOW(3) - INTERVAL 15 MINUTE)""",
                orderId, "20990105-%06d".formatted(i), BUYER);
        jdbc.update("INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (?, ?, 'race', 100, 1)", orderId, PRODUCT);
        jdbc.update("UPDATE inventory SET reserved = reserved + 1 WHERE product_id = ?", PRODUCT);
        jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (?, ?, 1, 'HELD')", orderId, PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 0, 1, 'RESERVE', ?)", PRODUCT, "order:" + orderId);
        jdbc.update("INSERT INTO payments (id, order_id, amount, status, provider) VALUES (?, ?, 100, 'PENDING', 'SIMULATED')", orderId, orderId);
        return new Setup(orderId, orderId);
    }

    // ───────── 天真的版本：先讀狀態，再決定要不要寫（不帶條件的 UPDATE） ─────────
    void naivePay(Setup s) {
        tx.executeWithoutResult(t -> {
            jdbc.update("UPDATE payments SET status = 'SUCCEEDED', provider_txn_id = ? WHERE id = ?", "tx-" + s.paymentId(), s.paymentId());
            String status = jdbc.queryForObject("SELECT status FROM orders WHERE id = ?", String.class, s.orderId());
            if (status.equals("PENDING_PAYMENT")) {
                jdbc.update("UPDATE orders SET status = 'PAID', paid_at = NOW(3), cancel_reason = NULL WHERE id = ?", s.orderId());
                jdbc.update("UPDATE inventory_reservations SET status = 'CONFIRMED' WHERE order_id = ? AND status = 'HELD'", s.orderId());
            } else if (status.equals("CANCELLED")) {
                jdbc.update("INSERT INTO refunds (payment_id, order_id, amount, reason) VALUES (?, ?, 100, 'LATE_PAYMENT')", s.paymentId(), s.orderId());
            }
        });
    }

    void naiveTimeout(Setup s) {
        tx.executeWithoutResult(t -> {
            String status = jdbc.queryForObject("SELECT status FROM orders WHERE id = ?", String.class, s.orderId());
            if (status.equals("PENDING_PAYMENT")) {
                jdbc.update("UPDATE orders SET status = 'CANCELLED', cancel_reason = 'PAYMENT_TIMEOUT', cancelled_at = NOW(3) WHERE id = ?", s.orderId());
                jdbc.update("UPDATE inventory SET reserved = reserved - 1 WHERE product_id = ?", PRODUCT);
                jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED' WHERE order_id = ?", s.orderId());
            }
        });
    }

    // ───────── 本專題：PaymentCallbackService + OrderTransitionService（條件式 UPDATE） ─────────
    void realPay(Setup s) {
        String txn = "tx-" + s.paymentId();
        BigDecimal amount = new BigDecimal("100.00");
        String sig = CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(s.paymentId(), txn, amount, true));
        callbacks.handle(new PaymentApi.Callback(s.paymentId(), txn, amount, true, sig));
    }

    void realTimeout(Setup s) {
        transitions.apply(s.orderId(), OrderEvent.PAYMENT_TIMEOUT, OrderHistory.Actor.system(), OrderTransitionService.EventData.NONE);
    }

    /** 每一張訂單最後的樣子，歸類成「一致」或某一種不一致 */
    String classify(long orderId) {
        Map<String, Object> o = jdbc.queryForMap("""
                SELECT o.status, r.status AS reservation, p.status AS payment,
                       (SELECT COUNT(*) FROM refunds f WHERE f.order_id = o.id) AS refunds
                  FROM orders o JOIN inventory_reservations r ON r.order_id = o.id JOIN payments p ON p.order_id = o.id
                 WHERE o.id = ?""", orderId);
        String key = o.get("status") + " / 預留 " + o.get("reservation") + " / 付款 " + o.get("payment") + " / 退款 " + o.get("refunds");
        boolean ok = key.equals("PAID / 預留 CONFIRMED / 付款 SUCCEEDED / 退款 0")
                  || key.equals("CANCELLED / 預留 RELEASED / 付款 SUCCEEDED / 退款 1");
        return (ok ? "✓ " : "✗ ") + key;
    }

    void cleanup() {
        jdbc.update("DELETE f FROM refunds f JOIN orders o ON o.id = f.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE p FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
    }

    void race(String title, java.util.function.Consumer<Setup> pay, java.util.function.Consumer<Setup> timeout) throws Exception {
        cleanup();
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 100000, 0, 'INITIAL', 'race')", PRODUCT);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        Map<String, Integer> outcomes = new TreeMap<>();
        int errors = 0;
        for (int i = 0; i < ROUNDS; i++) {
            Setup s = newExpiredOrder(i);
            CountDownLatch go = new CountDownLatch(1);
            Future<?> a = pool.submit(() -> { go.await(); pay.accept(s); return null; });
            Future<?> b = pool.submit(() -> { go.await(); timeout.accept(s); return null; });
            go.countDown();
            for (Future<?> f : List.of(a, b)) {
                try { f.get(); }
                catch (ExecutionException e) { if (errors++ == 0) System.out.println("  第一個例外：" + e.getCause()); }
            }
            outcomes.merge(classify(s.orderId()), 1, Integer::sum);
        }
        pool.shutdown();
        Map<String, Object> inv = jdbc.queryForMap("""
                SELECT i.reserved, (SELECT COALESCE(SUM(quantity), 0) FROM inventory_reservations r
                                     WHERE r.product_id = i.product_id AND r.status IN ('HELD', 'CONFIRMED')) AS held
                  FROM inventory i WHERE product_id = ?""", PRODUCT);
        System.out.println("── " + title + "（" + ROUNDS + " 回合）──");
        outcomes.forEach((k, v) -> System.out.printf("  %-60s %4d 張%n", k, v));
        System.out.printf("  例外 %d 次；INV-2：reserved = %s、Σ 有效預留 = %s%n%n", errors, inv.get("reserved"), inv.get("held"));
        cleanup();
    }

    @Test
    void timeoutVsPayment() throws Exception {
        System.out.println("═══ 4.2.5 付款逾時排程 × 付款成功回呼，同一瞬間 ═══");
        race("天真的版本：先 SELECT 狀態，再 UPDATE", this::naivePay, this::naiveTimeout);
        race("本專題：條件式 UPDATE + 狀態機", this::realPay, this::realTimeout);
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/E6ThreeSchedulersTest.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.shared.config.ShopProperties;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.List;
import java.util.concurrent.*;

/**
 * 4.7.2 US-ORD-3 AC-3：三台應用程式同時跑「付款逾時」排程。300 張過期的訂單、每張 2 個品項。
 * 天真的版本（先 SELECT 狀態、再 UPDATE）vs 本專題的 OrderJobs（條件式 UPDATE）。
 */
@Tag("experiment")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=false")
class E6ThreeSchedulersTest {

    static final long P1 = 900_801, P2 = 900_802, BUYER = 990_006;
    static final int ORDERS = 300;

    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;
    @Autowired OrderTransitionService transitions;
    @Autowired Clock clock;
    @Autowired ShopProperties props;

    void setUp() {
        cleanup();
        for (long p : new long[]{P1, P2}) {
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, ?)", p, ORDERS);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 100000, 0, 'INITIAL', 'e6')", p);
        }
        for (int i = 0; i < ORDERS; i++) {
            long id = 99_060_000L + i;
            jdbc.update("""
                    INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline, created_at)
                    VALUES (?, ?, ?, 2, 'PENDING_PAYMENT', 200, NOW(3) - INTERVAL 1 MINUTE, NOW(3) - INTERVAL 16 MINUTE)""",
                    id, "20990106-%06d".formatted(i), BUYER);
            for (long p : new long[]{P1, P2}) {
                jdbc.update("INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (?, ?, 'e6', 100, 1)", id, p);
                jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (?, ?, 1, 'HELD')", id, p);
                jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 0, 1, 'RESERVE', ?)", p, "order:" + id);
            }
        }
    }

    void cleanup() {
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        for (long p : new long[]{P1, P2}) {
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", p);
            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", p);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", p);
        }
    }

    /** 天真的排程：撈出過期的單，逐張「讀狀態 → 是待付款就取消並釋放」 */
    void naiveJob() {
        List<Long> ids = jdbc.queryForList("SELECT id FROM orders WHERE buyer_id = ? AND status = 'PENDING_PAYMENT' AND payment_deadline < NOW(3)", Long.class, BUYER);
        for (long id : ids) tx.executeWithoutResult(s -> {
            String status = jdbc.queryForObject("SELECT status FROM orders WHERE id = ?", String.class, id);
            if (!status.equals("PENDING_PAYMENT")) return;
            jdbc.update("UPDATE orders SET status = 'CANCELLED', cancel_reason = 'PAYMENT_TIMEOUT', cancelled_at = NOW(3) WHERE id = ?", id);
            for (var r : jdbc.queryForList("SELECT product_id, quantity FROM inventory_reservations WHERE order_id = ?", id)) {
                jdbc.update("UPDATE inventory SET reserved = reserved - ? WHERE product_id = ?", r.get("quantity"), r.get("product_id"));
                jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 0, ?, 'RELEASE', ?)",
                        r.get("product_id"), -((Integer) r.get("quantity")), "order:" + id);
            }
            jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED' WHERE order_id = ?", id);
            jdbc.update("INSERT INTO order_status_history (order_id, from_status, to_status, event, actor_type) VALUES (?, 'PENDING_PAYMENT', 'CANCELLED', 'PAYMENT_TIMEOUT', 'SYSTEM')", id);
        });
    }

    void report(String title, List<Throwable> errors) {
        Long cancelled = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE buyer_id = ? AND status = 'CANCELLED'", Long.class, BUYER);
        Long histories = jdbc.queryForObject("""
                SELECT COUNT(*) FROM order_status_history h JOIN orders o ON o.id = h.order_id
                 WHERE o.buyer_id = ? AND h.event = 'PAYMENT_TIMEOUT'""", Long.class, BUYER);
        Long releases = jdbc.queryForObject("SELECT COUNT(*) FROM inventory_ledger WHERE product_id IN (?, ?) AND reason = 'RELEASE'", Long.class, P1, P2);
        List<Integer> reserved = jdbc.queryForList("SELECT reserved FROM inventory WHERE product_id IN (?, ?) ORDER BY product_id", Integer.class, P1, P2);
        Long held = jdbc.queryForObject("SELECT COALESCE(SUM(quantity), 0) FROM inventory_reservations WHERE product_id IN (?, ?) AND status IN ('HELD', 'CONFIRMED')",
                Long.class, P1, P2);
        Long pending = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE buyer_id = ? AND status = 'PENDING_PAYMENT'", Long.class, BUYER);
        System.out.printf("── %s ──%n", title);
        System.out.printf("  取消 %d 張、還是待付款 %d 張；「逾時取消」歷史 %d 筆；RELEASE 帳 %d 筆（取消的每張應該 2 筆）%n",
                cancelled, pending, histories, releases);
        System.out.printf("  INV-2：兩個商品的 reserved = %s，Σ 有效預留 = %d%n", reserved, held);
        if (!errors.isEmpty()) System.out.println("  例外 " + errors.size() + " 次，第一個：" + errors.get(0));
    }

    void threeAtOnce(Runnable job) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(3);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<?>> fs = new java.util.ArrayList<>();
        for (int i = 0; i < 3; i++) fs.add(pool.submit(() -> { go.await(); job.run(); return null; }));
        go.countDown();
        List<Throwable> errors = new java.util.ArrayList<>();
        for (Future<?> f : fs) { try { f.get(); } catch (ExecutionException e) { errors.add(e.getCause()); } }
        pool.shutdown();
        lastErrors = errors;
    }

    List<Throwable> lastErrors = List.of();

    @Test
    void threeSchedulers() throws Exception {
        System.out.println("═══ 4.7.2 三個排程實例同時處理 300 張過期訂單（每張 2 個品項）═══");
        setUp();
        threeAtOnce(this::naiveJob);
        report("天真的排程", lastErrors);
        setUp();
        OrderJobs jobs = new OrderJobs(jdbc, transitions, clock, props);
        threeAtOnce(() -> { while (jobs.cancelExpired() > 0) { } });      // 每次最多 100 張，做到沒有為止
        report("本專題的 OrderJobs", lastErrors);
        cleanup();
    }
}
```

**`src/test/java/com/example/shop/ch04/E7FlashSaleLoadTest.java`**

```java
package com.example.shop.ch04;

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
class E7FlashSaleLoadTest {

    static final long HOT = 9_900_701;
    static final int STOCK = 500, BUYERS = 2_000, CLIENTS = 200;
    static final long FIRST_BUYER = 3_000_000;

    record Run(Map<Integer, Integer> statuses, double p50, double p95, double p99, double max, double seconds,
               int reserved, long orders, long ledger, int maxActive, int maxPending, Map<Integer, Integer> retried) {}

    /**
     * @param rps 0：封閉式負載（CLIENTS 個客戶端各自「送完一個、馬上送下一個」，量的是飽和時的樣子）。
     *            > 0：開放式負載（0.6.2 的寫法：每秒 rps 個請求，不管前面的回來了沒有）。延遲從「預定送出的時間」算起，
     *            否則系統變慢時送出的時間也跟著延後，p99 會被低估（coordinated omission）。
     */
    static Run flashSale(boolean virtualThreads, int rps) throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0",
                "--shop.order.jobs-enabled=false", "--spring.threads.virtual.enabled=" + virtualThreads,
                "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            var hikari = (com.zaxxer.hikari.HikariDataSource) ctx.getBean(javax.sql.DataSource.class);
            cleanup(jdbc);
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '限量商品', 1990.00, 'ON_SALE', TRUE)", HOT);
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
                            .header("X-Debug-User-Id", String.valueOf(buyer)).header("Content-Type", "application/json")
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
            long[] a = lat.stream().mapToLong(Long::longValue).sorted().toArray();
            Map<Integer, Integer> st = new TreeMap<>();
            statuses.forEach((k, v) -> st.put(k, v.get()));
            Run r = new Run(st, a[a.length / 2] / 1e6, a[(int) (a.length * 0.95)] / 1e6, a[(int) (a.length * 0.99)] / 1e6, a[a.length - 1] / 1e6, secs,
                    jdbc.queryForObject("SELECT reserved FROM inventory WHERE product_id = ?", Integer.class, HOT),
                    jdbc.queryForObject("SELECT COUNT(*) FROM order_items WHERE product_id = ?", Long.class, HOT),
                    jdbc.queryForObject("SELECT COUNT(*) FROM inventory_ledger WHERE product_id = ? AND reason = 'RESERVE'", Long.class, HOT),
                    maxActive.get(), maxPending.get(), retried);
            cleanup(jdbc);
            return r;
        }
    }

    static void cleanup(JdbcTemplate jdbc) {
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        jdbc.update("DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM products WHERE id = ?", HOT);
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

---

## 4.11 常見誤區

**① 「扣庫存先 `SELECT` 看夠不夠，夠了再 `UPDATE`」**

4.2.1 ①：100 個人搶 1 件，成立 100 張、**0 個錯誤**。改成相對值（②）不會超賣，但只是把工作丟給 CHECK，99 個人拿到 500。
**判斷和寫入要在同一句 SQL 裡**：`UPDATE ... WHERE on_hand - reserved >= ?`，影響 0 列就是沒貨。

**② 「樂觀鎖比悲觀鎖快，搶購用樂觀鎖」**

4.2.1 ③④：2,000 人搶 500 件，不重試只賣出 32 件，重試 10 次賣出 280 件、花 7.5 秒。**樂觀鎖的前提是衝突很少** —— 熱點商品正好相反。

**③ 「預期中的失敗不要用例外，在交易裡接住、回傳結果物件」**

4.2.2：下層的交易方法丟出例外的那一刻，交易已經被標成 rollback-only。接住它 → `UnexpectedRollbackException` → 500。
下層沒有代理的話更糟：交易 commit，**連同已經預留的品項**。**讓例外穿出交易邊界，在外面決定下一步。**

**④ 「死鎖是資料庫的問題，加重試就好」**

4.2.3：5 秒 832 次死鎖，**每兩張訂單就有一張失敗**。排序之後是 0 次。重試只是把 500 變成更慢的 201；**先修順序，再考慮重試**。

**⑤ 「`BigDecimal` 用 `equals` 比較」**

4.2.4：真的 JavaScript 前端送來 `149`，資料庫是 `149.00`，500 個商品全部「價格已變動」。**比數值用 `compareTo`；做指紋先正規化；簽章用雙方約定的固定格式。**

**⑥ 「先查狀態，是對的狀態才更新」**

4.2.5、4.7.2：300 張訂單 300 張錯、三個排程把 120 張訂單各取消了 2～3 次。**讀到的狀態在你寫的時候可能已經不是那樣了**。
狀態轉移一律 `WHERE status = :from`，看影響列數。

**⑦ 「影響 0 列就重新讀一次」**

4.6.2：在 REPEATABLE READ 底下，重讀用一般的 `SELECT` 會讀到**同一個快照**。300 個回呼全部失敗、錢的紀錄消失。**重讀要用 `FOR UPDATE`。**

**⑧ 「INSERT 撞到唯一鍵之後，`SELECT ... FOR UPDATE` 看看是誰」**

4.5.3：失敗的 INSERT 留下一把 S 鎖，幾個同時撞進來的請求都要升級成 X 鎖 → 死鎖，10 個請求 4～8 個 500。
**讓 INSERT 的交易先結束，再用一般讀取 + 條件式 UPDATE。**

**⑨ 「冪等 = 同一個鍵永遠回同一個結果」**

US-ORD-1a AC-4：失敗的結果**不能**快取，否則補貨之後同一個買家永遠下不了單（驗收 Q1 的第二段）。
**成功快取、失敗刪掉、處理中擋住 —— 而且處理中要有租約**，行程死掉時才不會永遠卡住。

**⑩ 「JDBC 改了資料，之後用 JPA 讀一下確認」**

4.6.5：同一個交易裡已經載入過的 Entity，`findById` 直接從一級快取回傳 —— 資料庫是 `COMPLETED`，回應說 `SHIPPED`。**混用時，JDBC 寫入之前不要讓那個 Entity 進入 persistence context。**

**⑪ 「Problem Details 的額外欄位愛叫什麼就叫什麼」**

4.6.5：`status` 跟標準欄位撞名，JSON 裡出現兩個 `status`，前端讀到 `"PICKING"`。**`type`、`title`、`status`、`detail`、`instance` 是保留字** —— 讓程式碼拒絕它們。

**⑫ 「多台機器跑排程，要加分散式鎖」**

4.7.2：需要的是「每張訂單只被處理一次」，不是「同一時間只有一台在跑」。**每一張訂單的條件式 UPDATE 就是它自己的鎖。**

**⑬ 「壓測沒有 500 就是通過了」**

4.8：正確性全部對（500 張、`reserved=500`、帳 500 筆），但 **p99 是 SLO 的 5 倍以上**。而且 5xx 不一定代表「沒成立」—— 503 的請求裡有些訂單已經 commit 了，只有同一個冪等鍵的重送能讓買家拿回自己的訂單。

---

## 4.12 本章小結

**這一章建立了六件事**：

1. **一條防超賣的寫法**（4.2.1、4.4.2）：條件式 UPDATE，依 `productId` 排序，先 UPDATE 父表再 INSERT 子表。**驗收 Q2 變綠。**
2. **一個交易邊界**（4.3.3、4.4.1）：下單交易裡只有 SQL，寫 8 張表、全有或全無；例外穿出交易邊界之後才被接住。**驗收 Q1 變綠。**
3. **一張表變成一個純函式**（4.3.4、4.3.5）：`OrderStateMachine`，編譯器保證每一格都有答案，61 個測試直接讀 0.5.3 的表格。
4. **一條處理競態的規則**（4.6.1、4.6.2）：`WHERE status = :from` + 影響列數 + locking read 重讀 + 查表。付款回呼、買家取消、賣家出貨、排程，全部走這一條。
5. **一個冪等鍵**（4.5）：三個交易、一個租約、條件式的接手。**驗收 Q3 變綠。**
6. **一組用數字做的判斷**（4.8）：搶購時的正確性 MySQL 守得住，延遲守不住 —— 那是第 06 章的事；虛擬執行緒的數字比較好看，但這次的量測不足以改掉 0.9.2 的預設。

**如果這一章只能記一句話**：

> **不要相信你讀到的值。** 讀到「有貨」、「待付款」、「這個鍵還沒用過」的下一瞬間，它可能就不是真的了。
> **把判斷寫進會拿鎖的那一句 SQL 裡，然後看它影響了幾列。**

### 4.12.1 驗收清單

做得到才往下走：

- [ ] 跑完 4.2.1，說出 ①～⑥ 各自的「成立 / 庫存不足 / 錯誤」，以及 ③ 為什麼只賣出 32 件。
- [ ] 說出 4.2.2 的 `UnexpectedRollbackException` 是在哪一行被決定的，以及「下層沒有交易代理」時會發生什麼。
- [ ] 讀懂 4.2.3 的 `LATEST DETECTED DEADLOCK`：兩個交易各拿著哪一列、各在等哪一列。
- [ ] 用 Node 跑一次 4.2.4 的 `js-client.mjs`，確認 `149.00` 送出去變成 `149`。
- [ ] 說出 4.2.5 天真版本的兩種錯誤結局各是怎麼發生的，以及為什麼 INV-2 對帳看不出來。
- [ ] 在 `OrderStateMachine` 裡改錯一格，看 `OrderStateMachineTest` 紅在哪一格；加一個 enum 值，看編譯器報幾個錯。
- [ ] 說出 `placeOrder()` 為什麼沒有 `@Transactional`，以及驗收 Q1 的兩個商品 id 為什麼要一大一小。
- [ ] 畫出一個冪等鍵的生命週期，並說出 `complete()` 的 `n == 0` 在防什麼。
- [ ] 把 `IdempotencyKeys.claim()` 改回 4.5.2 的第一版，跑驗收 Q3，看到 500 與 InnoDB 的 S / X 鎖。
- [ ] 把 `currentForUpdate` 改回一般讀取，跑 E5，看到 300 個「訂單狀態正在變動」。
- [ ] 用 `openssl` 算簽章，手動送一次付款回呼；把金額改掉再送一次，說出為什麼是 401 而不是 400。
- [ ] 說出三台機器同時跑 `OrderJobs` 為什麼不會重複取消。
- [ ] 跑完 E7，說出 503 從哪裡來、為什麼有些 503 的訂單其實已經成立、以及買家怎麼拿回它。
- [ ] `mvn clean verify` 顯示 `Tests run: 120, Failures: 0, Errors: 0, Skipped: 6`。

### 4.12.2 本章練習

**練習一（15 分鐘）：沒有代理的 `catch`**

把 4.2.2 的 `FriendlyPlaceOrder` 改成直接用 `JdbcTemplate` 執行 `reserve()` 的 SQL（不經過 `InventoryApi` 的代理），並讓它一次預留兩個商品，第二個不足。
呼叫一次之後，查 `inventory.reserved` 與 `inventory_reservations`：**第一個商品的預留還在嗎？** 這就是 4.2.2 那段 ⚠️。

**練習二（20 分鐘）：Q1 的反例**

把驗收 Q1 的 `a`、`b` 對調（讓沒貨的商品 id 比較小），再把 `PlaceOrderService` 改成**不用交易**（直接呼叫 `placeInTransaction`）。
Q1 還會綠嗎？再對調回來呢？寫下你從中學到的「怎麼寫一個會失敗的測試」。

**練習三（20 分鐘）：鎖等待逾時**

把 `innodb_lock_wait_timeout` 設成 1 秒（`SET GLOBAL`），用 E1 的 ⑤（`FOR UPDATE`）在 B 情境跑 256 條執行緒。
**出現了幾個錯誤？是什麼例外？** 這是 US-ORD-1b AC-1 那段 ⚠️ 說的「等鎖逾時回 500」。⑥ 在同樣的設定下呢？

**練習四（15 分鐘）：狀態機的一個新事件**

產品經理提出：「賣家可以在出貨後 24 小時內**更正物流單號**」。在 0.5.3 的表格加一欄，在 `OrderEvent` 加一個值，讓編譯器告訴你要改哪些地方。
**`OrderTransitionService` 需要改嗎？** 更正單號算不算一個「狀態轉移」？

**練習五（30 分鐘）：`SKIP LOCKED`**

把 `cancelExpired()` 改成：在一個交易裡 `SELECT id ... FOR UPDATE SKIP LOCKED LIMIT 20`，逐張處理，commit。
用 E6 比較三個排程實例的總耗時與「白做的工作」（影響 0 列的 UPDATE 次數）。**它的交易變長了 —— 這對同時在下單的熱點商品有什麼影響？**

**練習六（20 分鐘）：清理過期的冪等鍵**

`idempotency_keys` 只會變多，不會變少（過期的列只有在同一個鍵再來時才被重用）。寫一個排程，每小時刪除 `expires_at` 早於 24 小時前的列，每次最多 1,000 列。
**為什麼要分批？** 用 2.7.2 的方法確認它走 `idx_idem_expires`。它跟 `OrderJobs` 一樣需要處理多台同時跑的問題嗎？

**練習七（30 分鐘）：不暴露 `paymentId`**

在 `payments` 加一個 `payment_no`（`VARCHAR(32)`，隨機、唯一），`POST /payments` 回傳它而不是 `id`，回呼的簽章也改用它。
寫一個 V12 migration（記得 2.2.2 的「一句 DDL」與 2.9.6 的上線關卡）。`OpenApiContractTest` 會紅在哪裡？

**練習八（進階，40 分鐘）：回應不需要第二條連線**

4.8.2 發現：有些 503 發生在訂單 commit **之後** —— Controller 讀回訂單時拿不到第二條連線。
讓 `placeOrder()` 在下單交易裡就組好 `OrderView` 回傳（注意 `lineAmount` 是資料庫的產生欄位，剛 INSERT 的 `OrderItem` 在記憶體裡是 `null` —— 看 `OrderItem.getLineAmount()` 的註解），重跑 E7。
**503 變少了嗎？p99 呢？** 這個改變讓 `OrderingApi` 多依賴了什麼？值得嗎？

**練習九（20 分鐘）：三位小數的金額**

4.6.3 留下的已知問題：回呼的 `amount` 如果是 `298.001`，`CallbackSignature.canonical()` 的 `setScale(2, RoundingMode.UNNECESSARY)` 會丟 `ArithmeticException`，目前變成 500。
先用 `curl` 送一次確認（簽章隨便填 —— `canonical()` 在驗簽之前就執行了），再把它改成 400 `/problems/validation`，並在 `OrderFlowTest` 加一個測試守住它。（做完再對照 4.6.3：修法、三個選項的比較，以及為什麼測試最後沒有放在 `OrderFlowTest`。）
**改在哪一層最好？** `CallbackRequest` 上的 `@Digits(integer = 10, fraction = 2)`、`record()` 裡接住例外、還是 `canonical()` 自己檢查？各自擋得住哪些呼叫路徑？

**練習十（30 分鐘）：`held()` 的 `FOR UPDATE` 鎖了什麼？**

4.6.4 的 `held()` 用 `WHERE order_id = ? ... FOR UPDATE` 走 `uk_reservations_order_product (order_id, product_id)` 的**前綴** —— 這不是對整個唯一鍵的等值查找，而是一段範圍掃描。
在 REPEATABLE READ 底下，InnoDB 會在掃到的記錄上加什麼鎖？取消**最新的**那張訂單時，鎖住的範圍延伸到哪裡？
同一瞬間有人下單同一個商品（`reserve()`：先拿 `inventory` 那一列的 X 鎖，再 INSERT `inventory_reservations`），會不會被擋住？會不會死鎖？
寫一個實驗驗證：一條執行緒取消最新的訂單、一條下單同一個商品，用 `CountDownLatch` 對齊，看 `performance_schema.data_locks` 與 `SHOW ENGINE INNODB STATUS`。
如果真的會互等，提出一個修法，並說明它還能不能防止「同一張訂單被釋放兩次」。

**練習十一（15 分鐘）：`Idempotency-Key` 上的 `@NotBlank` 是誰在驗？**

`OrderCommandController.place()` 的 `@RequestHeader` 上直接掛了 `@NotBlank`、`@Size(max = 64)`，類別上沒有 `@Validated` —— 這是 Spring 6.1 內建的方法驗證，錯誤由 `handleHandlerMethodValidationException` 處理。
送一個 `"quantity": 0` 的下單請求：回應是 `handleMethodArgumentNotValid` 的「有 N 個欄位不正確」，還是 `handleHandlerMethodValidationException` 的「請求參數不正確」？**為什麼？**
跟第 03 章同一種錯誤（例如購物車的數量）的回應比較：前端需要處理兩種格式嗎？

---

## 4.13 下一章預告

這一章的每一個 API 都有一行 `CurrentUser user` —— 而它背後是 3.3.4 那個「本機才打開的 `X-Debug-User-Id`」。**任何人都可以說自己是任何人**，這一章所有的 404、403 都建立在這個假設上。

下一章（05）把它換成真的身分：

- **JWT 登入與 refresh token rotation**（US-ACC-2）：`X-Debug-User-Id` 刪掉，`CurrentUser` 的型別不變 —— 這一章的 Controller 一行都不用改。
- **資料層級權限**：「別人的訂單一律 404」從 `WHERE buyer_id = ?` 的慣例，變成一條有測試守著的規則（**驗收 Q5**）。
- **稽核**：這一章留下的三個「第 05 章寫進 `audit_logs`」—— 付款簽章錯誤（US-ORD-2 AC-3）、賣家取消（US-ORD-6 AC-5）、越權讀取（US-ORD-5 AC-3）。
- **登入失敗鎖定**：0.6.3 那個「Redis 掛了要不要鎖」的取捨，第一次寫成程式。

門窗裝好了，人也開始搶了。下一章決定誰可以進門。
