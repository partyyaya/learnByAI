# 第 06 章：快取與熱點庫存：商品快取、Redis 閘門、限流與降級演練

> 第 05 章結束時，門鎖裝好了：每一個身分都是真的登入產生的，每一次越權都有測試守著。
> 但每一次看商品、每一次下單，都還是直接打 MySQL —— 0.6.1 算過，搶購那 10 秒，**同一列 MySQL 撐不住**；第 04 章 4.8.1 量到了：正確性守得住，p99 守不住。
>
> **這一章把 Redis 放到 MySQL 前面。** 商品頁讀快取，熱點商品在 Redis 先擋一次，限流在 Redis 裡數。
> 然後把 Redis 拔掉 60 秒，看每一個功能是不是照 0.6.3 那張表降級。
>
> 這一章結束時，你手上會有：
>
> - **一個商品快取**（6.4）：commit 之後寫入新值、帶版本號；寫入失敗會修復；同一個商品同一時間只讀一次 MySQL；Redis 不在時有 1 秒的本機副本。
> - **一個熱點商品的 Redis 閘門**（6.5）：2,000 個人搶 500 件，搶不到的 1,500 人連 MySQL 都不碰；MySQL 的條件式 UPDATE 仍然是最後一道防線。
> - **一個用 CAS 的對帳**（6.6）與一條原則：**Redis 的數字只能偏高、不能偏低**。
> - **限流**（6.7）：每 IP 每秒 50 次、每位買家每分鐘 10 張 —— 以「不同的冪等鍵」計。
> - **熱門排行**（6.8）：每分鐘一句有索引的 SQL，存在 Redis 1 分鐘。
> - **2 支新的 API**（6.3.1）、**1 個 migration**（V12）。
> - **驗收 Q8 變綠**（6.9.3）：`Skipped` 從 5 變成 4。
>
> 快取的 bug 跟前兩章的 bug 都不一樣：**它不會讓任何請求失敗**。每一個請求都回 200，格式正確、商品存在 —— 只是價格是 10 分鐘前的，或者「已售完」其實還有 100 件。
> 所以這一章的每一個事故，都是量「回應正確，但內容錯了」的次數：
>
> - **刪快取的時機**（6.2.1）：改價的交易裡刪快取 → **200 次有 199 次**，1 秒後快取裡還是舊價格，而且會留 10 分鐘。
>   教科書的「commit 之後刪」在 200 次裡都對 —— 但在「快取剛好過期」的那一刻改價，**100 次有 2 次**一樣留下舊價格。
> - **快取擊穿**（6.2.2）：200 個請求同時讀一個剛過期的商品，MySQL 收到 **22～200 次**一模一樣的查詢；single-flight 之後每台機器 1 次。
> - **快取命中了，MySQL 還是收到 5 句**（6.2.3）：方法上一個 `@Transactional(readOnly = true)`，1,000 次快取命中 = **5,005 句、拿 1,000 次連線**，一句真正的查詢都沒有。
> - **閘門過了，訂單沒成立**（6.2.4）：100 個買家帶著舊價格搶購，Redis 減了 100、訂單一張都沒成立。第二波 100 個帶對價格的買家全部看到「已售完」—— **100 件商品一件都沒賣出去**。沒有錯誤日誌，MySQL 的每一條不變量都成立。
> - **鎖在 commit 之前放掉**（6.2.5）：`@Transactional` 方法裡 `finally { unlock(); }`，對帳讀到還沒 commit 的庫存 —— **20 輪裡 2～3 輪少賣**。
>
> ⚠️ **還有四個，是寫這一章的途中被這一章自己的實驗抓到的**：
>
> - **版本號擋不住的那一次**（6.4.2）：本專題的寫法在「過期瞬間」的 100 次裡也有 **1 次**留下舊價格。版本號只保證「舊的蓋不掉新的」—— commit 之後那一次寫入碰上了 Redis 逾時，新的根本沒寫進去。
> - **斷路器把一次卡頓放大成洪水**（6.4.5、6.9.2）：Redis 一批指令逾時 → 斷路器跳開 → 5 秒內每秒 1,000 個請求全部改讀 MySQL，**每秒 1,272 句、p95 2～4 秒**。演練裡 Redis 掛 60 秒，MySQL 是平常的 **5.4～5.5 倍**。每一格的狀態碼都對 —— 照 Q8 的標準，這是綠燈。
> - **降級路徑自己的 500**（6.9.2）：`docker pause` 的演練裡，**7 次出現 5 個 500**。第一個猜測（`CompletionException`）是一條真的路，但不是那一條；保留完整日誌之後抓到的是 `RedisGuard` 裡的一個競態 —— 專門負責「Redis 失敗了改走降級」的那個類別，在幾十個執行緒**同時**失敗時丟出 NPE。
> - **一個第 02 章的測試紅了**（6.11）：驗收 Q4 插的種子訂單一插進去就已經付款逾時，第 04 章的排程剛好在那 14 秒裡掃到它們。這個 bug 從第 04 章就在，這一章讓它現形。
>
> 另外還有幾個比較小、但一樣是實測到的坑：
>
> - **限流把連點算成 10 次**（6.7.1）：數請求的版本，買家連點一次（同一個冪等鍵送 10 次），接下來 5 張新訂單**全部 429** —— 第 04 章叫客戶端「用同一個鍵重試」，重試的人被懲罰。
> - **Redis 掛了，限流就變成 N 倍**（6.7.3）：兩台機器，Redis 正常時放行 10 張，Redis 停掉時 **20 張**。
> - **熱點退回 MySQL**（6.9.1）：Redis 掛了，熱點商品每秒 600 個下單改走 MySQL —— 跟搶購無關的一般商品下單，p50 從 **11～16 ms**（熱點回 503 的做法）**變成 2.3～6.9 秒**。
> - **改了 migration 的一行註解**（6.8.1）：checksum 變了，**每一個應用程式都起不來**。
> - **測試用 SQL 建商品**（6.4.1）：同一個 id 重建，`version` 又是 0，快取裡上一次的名稱、價格一直留著。
>
> 以及一個**沒有達成**的目標：熱點搶購的 p99 < 500 ms（6.5.4）。閘門讓搶不到的人快了兩個數量級，p99 還是 3.7～4.9 秒 —— 搶到的那 500 人仍然排在同一列 MySQL 後面。第 07 章會回來處理它。

---

## 6.1 學習目標

完成本章後，你應該可以：

- 說出「改了資料之後，快取該在什麼時候動」：在交易裡刪、commit 之後刪、commit 之後寫入新值，三種各錯在哪裡，並用版本號讓「舊的值蓋不掉新的值」（6.2.1、6.4.1）。
- 說出快取擊穿的成因，以及為什麼本機的 single-flight 就夠了、不需要分散式的版本（6.2.2、6.4.3）。
- 說出「快取命中了，MySQL 還是收到 5 句」是怎麼來的（6.2.3）。
- 寫出熱點商品的 Redis 閘門，並說出它的一條原則：**MySQL 仍然是最後一道防線，Redis 的數字只能偏高、不能偏低**（6.5）。
  - 閘門過了之後，每一條失敗的路徑都要把減掉的加回去（6.2.4）。
- 說出「分散式鎖要包住交易」是什麼意思，以及為什麼這一章最後沒有用鎖、而是用 CAS 做對帳（6.2.5、6.6）。
- 為限流選對「什麼算一次」：同一個冪等鍵的重送為什麼不能算（6.7.1）。
- 說出斷路器「跳開之後做什麼」跟「什麼時候跳開」一樣重要（6.4.5、6.9.2）。
- 用一次真的降級演練回答驗收 Q8：Redis 掛掉 60 秒，哪些 API 降級、哪些失敗、MySQL 的 QPS 漲幾倍（6.9）。

---

## 6.2 先看見痛：快取的 bug 會「慢慢地」錯

### 6.2.0 實驗環境

本章有十個實驗，命名接著第 05 章的 F1～F8：G1～G10。一樣標 `@Tag("experiment")`：

```bash
mvn test -Pexperiments -Dtest=G1CacheInvalidationTest
```

| 實驗 | 放在哪裡 | 用什麼 | 量什麼 |
|---|---|---|---|
| G1 刪快取的時機 | `catalog/internal/` | 正式的 `ProductService` vs「照教科書寫」的 cache-aside | 改價 1 秒後，快取裡還是舊價格的次數 |
| G2 快取擊穿 | `catalog/internal/` | 正式的 `ProductCache` | 200 個請求同時沒命中，MySQL 被讀幾次 |
| G3 快取命中的代價 | `catalog/internal/` | 正式的 `ProductService.detail()` | MySQL 收到幾句、拿了幾次連線 |
| G4 閘門漏了補償 | `ordering/internal/` | 正式的 `PlaceOrderService` | 100 件熱點商品，最後賣出幾件 |
| G5 鎖與對帳 | `inventory/internal/` | 正式的 `HotStock` 的 Lua 腳本、`DistributedLock` | Redis 與 MySQL 的可售量差多少 |
| G6 搶購壓測 | `ch06/` | 第 04 章的 E7，只改「是不是熱點」 | p99、5xx、連線池 |
| G7 艙壁 | `ordering/internal/` | 正式的 `PlaceOrderService`，**真的停掉 Redis** | 熱點退回 MySQL 時，一般商品的延遲 |
| G8 降級演練 | `ch06/` | 啟動整個應用程式、打真的 HTTP、**真的停掉 Redis 60 秒** | 每 5 秒的 MySQL QPS 與各 API 的狀態碼 |
| G9 限流 | `ch06/` | 正式的 `RateLimiter`，兩個應用程式 | 連點算不算、Redis 掛了之後的上限 |
| G10 商品詳情的 SLO | `ch06/` | 啟動整個應用程式、打真的 HTTP | 同一個商品每秒 1,000 次的 p95、p99 |

四個細節：

- **這一章的實驗會真的停掉 Redis**（`docker stop` / `docker pause`，5.6.4 學到兩種都要做）。實驗結束時會把它啟動回來；如果你中途中斷了實驗，記得 `docker unpause shop-redis-1; docker start shop-redis-1` —— `pause` 模式中斷時，Redis 停在凍結的狀態，`start` 救不回來，要 `unpause`。
- **這一章的延遲數字，一律是「同一段時間、交錯執行」的比較。** 寫這一章時，這台機器比第 04 章量 E7 的時候忙得多（背景有好幾個桌面程式，閒置時 load average 也有 7 左右）：同一份第 05 章的程式碼，第 04 章時 E7 的開放式 p99（平台執行緒）是 366～659 ms，這一章重跑是 3,765～10,471 ms（6.5.4）。**不要拿這一章的數字跟第 04 章的直接比。**
- **一次只跑一個實驗。** 寫這一章時我犯過一次錯：上一組實驗還在背景跑，就啟動了下一組，兩個 JVM 同時改同一個商品 —— 那一次的數字全部作廢（6.4.2 會提到）。
- **跑之前要知道的前置條件、時間與開關。** 每一個實驗類別的完整程式碼都在 6.11.1。G3、G8、G10 用 `root`／`root`（0.10 的 compose）直連 MySQL 讀 `Questions`；G7、G8、G9 與驗收 Q8 會真的對名為 `shop-redis-1` 的容器下 `docker stop`／`pause`。驗收 Q8 的「登入」那一格用的是 2.8.3 種子資料的帳號 `buyer00001@example.com`：資料庫裡沒有種子資料，`mvn clean test` 會在 Q8 紅（登入 401）—— 專題寫完之後在空的資料庫上重跑才發現，第 08 章 8.2.1 的事故一是同一件事。幾個實驗的長度由程式裡的固定等待決定：G1 的兩個方法一共改價 800 次、每次等 1 秒，**至少 13～14 分鐘**；G7 是暖機 1 輪加 10 輪、每輪 10 秒，每一輪之間還要停、啟 Redis；G8 每種模式 100 秒，預設 `stop`、`pause` 兩種都跑；G10 是 6 輪、每輪 10 秒。只想跑一個方法，用 `-Dtest='類別#方法'`。另外有四個只出現在程式裡的開關：`-Donly3=true`（G1 的「過期瞬間」只跑 ③，6.4.2）、`-Donly600=true`（G7 只跑每秒 600 個那一組）、`-Dg8.modes=pause`（G8 只跑一種）、`-Dg8.log=WARN`（G8 裡應用程式的日誌層級，預設 `ERROR`，看不到 `RedisGuard` 的跳開警告）。

### 6.2.1 事故一：刪快取的時機 ★★★

US-PRD-3 AC-3：「賣家改價 → 之後 **1 秒內**的詳情請求回傳新價格」。0.4.3 那段 📌 說這條是「快取失效的需求」：**價格錯了是法律問題**。

商品詳情有快取，改價就要讓快取知道。最常見的三種寫法：

- **①「在交易裡刪」**：`@Transactional void update() { repo.save(p); cache.evict(id); }`。看起來最自然 —— 改完就刪。
- **②「commit 之後刪」**：cache-aside 的教科書寫法：先改資料庫、commit，再刪快取。
- **③ 本專題**：commit 之後**寫入新值**，而且帶著版本號（`products.version`），讓「舊的值蓋不掉新的值」（6.4.1）。

G1 讓 32 個讀者不停讀同一個商品，同時改價 200 次。每一次改價 commit 之後等 1 秒，看快取裡的價格是不是新的。①② 的讀者用「照教科書寫」的 cache-aside：

```java
/** 教科書的 cache-aside：GET → 沒有 → 讀 MySQL → SET（TTL 10 分鐘，沒有版本比較） */
static void naiveRead(JdbcTemplate jdbc, StringRedisTemplate redis) {
    String k = ProductCache.key(PRODUCT);
    if (redis.opsForValue().get(k) != null) return;
    BigDecimal price = jdbc.queryForObject("SELECT price FROM products WHERE id = ?", BigDecimal.class, PRODUCT);
    redis.opsForValue().set(k, "{\"id\":" + PRODUCT + ",\"price\":" + price + "}", Duration.ofMinutes(10));
}
```

寫入端：

```java
switch (way.charAt(0)) {
    case '①' -> tx.executeWithoutResult(s -> {                         // @Transactional 方法裡的 cache.evict()
        redis.delete(ProductCache.key(PRODUCT));
        jdbc.update("UPDATE products SET price = ?, version = version + 1 WHERE id = ?", price, PRODUCT);
    });
    case '②' -> {
        tx.executeWithoutResult(s -> jdbc.update("UPDATE products SET price = ?, version = version + 1 WHERE id = ?", price, PRODUCT));
        redis.delete(ProductCache.key(PRODUCT));
    }
    default -> service.update(SELLER, PRODUCT, new UpdateProductRequest(null, null, price, null));   // ③ 正式的 ProductService
}
```

① 把刪除放在 `UPDATE` **之前**，是因為 JPA 的寫法本來就是這個順序：`repo.save()` 只是把 Entity 標成髒的，真正的 `UPDATE` 在 commit 前的 flush 才送出，`cache.evict()` 早就執行完了。

```bash
mvn test -Pexperiments -Dtest=G1CacheInvalidationTest
```

```
═══ 6.2.1 改價 200 次，32 個讀者同時在讀；每次 commit 之後 1 秒，快取裡的價格還是舊的嗎？═══
  ① 交易裡刪               1 秒後仍是舊價格：199 / 200 次  [第 1 次：MySQL 1001.00、快取 1000.00, 第 2 次：MySQL 1002.00、快取 1001.00]
  ② commit 之後刪         1 秒後仍是舊價格：  0 / 200 次  []
  ③ commit 之後寫入新值 + 版本號 1 秒後仍是舊價格：  0 / 200 次  []
```

**① 在交易裡刪：200 次有 199 次，1 秒後快取裡還是舊價格。** 而且不是「晚一點會好」：TTL 是 10 分鐘，舊價格會留 10 分鐘。

原因是時間差。刪除發生在 commit **之前**，從刪除到 commit 之間（`UPDATE`、flush、commit），32 個讀者裡總有人沒命中、去讀 MySQL —— 讀到的是**還沒 commit 的那一刻**，也就是舊價格（REPEATABLE READ 讀不到別人未提交的資料）—— 然後把舊價格寫回快取。等交易 commit，快取裡已經又是舊的了，而且再也沒有人會去刪它。

**② commit 之後刪：200 次都對。** 教科書沒有騙人 —— 至少在這個實驗裡是這樣。

② 也有一個競態：讀者在 commit **之前**讀到舊值，在**刪除之後**才寫回快取。但它需要一個前提：改價的那一刻，快取是空的（讀者才會去讀 MySQL）。在上面的實驗裡，每次改價前快取都已經被填好了，那個前提從來沒有成立。

什麼時候快取會剛好是空的？**TTL 到期的那一刻。** 正常情況下很少見（10 分鐘才過期一次），但商品一多、改價一頻繁，總會撞上。G1 的第二個測試讓它每一次都發生：改價前先刪掉 key（等於 TTL 剛好到期），再改價：

```
═══ 6.2.1 同上，但每次改價前快取剛好過期（100 次）═══
  ② commit 之後刪         1 秒後仍是舊價格：  2 / 100 次
  ③ commit 之後寫入新值 + 版本號 1 秒後仍是舊價格：  1 / 100 次
```

**② 的競態是真的：100 次有 2 次**，舊價格留了下來（直到 10 分鐘後 TTL 到期）。

**③ 也有 1 次。** 這是這一章的第一個設計漏洞 —— 本專題的寫法照理說不會有這種事（版本號會擋下舊值），6.4.2 會追出原因：那一次，「commit 之後寫入新值」**碰上了一次 Redis 逾時，沒有寫進去**。

> 📌 **快取的 bug 不會讓任何請求失敗。** 每一個請求都回了 200，價格格式正確、商品存在 —— 只是那個價格是 10 分鐘前的。
> 它不會出現在錯誤日誌裡，只會出現在客訴裡：「頁面上寫 1,000 元，結帳變成 1,200 元」。這是 0.4.3 說「價格錯了是法律問題」的意思。

### 6.2.2 事故二：快取過期的那一瞬間 ★★

0.6.1 的第 4 條：「熱點商品的詳情快取要防**快取擊穿**（1,000 rps 同時 miss 會全部打進 MySQL）」。

快取裡沒有這個商品（剛過期、剛重啟、剛被改過），這時候 200 個請求同時進來：

- **naive**：每一個請求都 `GET` → 沒有 → 讀 MySQL → `SET`。
- **ours**：`ProductCache.get()`：同一台機器、同一個商品，同一時間只有一個請求去讀 MySQL，其他的等它的結果（single-flight，6.4.3）。
- **ours，3 台**：3 個各自獨立的 `ProductCache`（各有自己的 single-flight），共用同一個 Redis —— 模擬 3 台機器。

```bash
mvn test -Pexperiments -Dtest=G2StampedeTest
```

```
═══ 6.2.2 快取裡沒有商品 1，200 個請求同時讀（每種 5 輪）═══
  naive（各自讀）     MySQL 200 次、最慢 162.5 ms │ MySQL 108 次、最慢  37.5 ms │ MySQL  39 次、最慢  19.6 ms │ MySQL  22 次、最慢  14.1 ms │ MySQL 112 次、最慢  38.6 ms
  ours，1 台       MySQL   1 次、最慢  34.6 ms │ MySQL   1 次、最慢   8.0 ms │ MySQL   1 次、最慢  10.6 ms │ MySQL   1 次、最慢  13.4 ms │ MySQL   1 次、最慢   9.5 ms
  ours，3 台       MySQL   3 次、最慢  10.9 ms │ MySQL   3 次、最慢  10.0 ms │ MySQL   3 次、最慢  11.1 ms │ MySQL   3 次、最慢   5.6 ms │ MySQL   3 次、最慢  10.9 ms
```

**naive：每一輪 22～200 次。** 波動很大，因為「同時」的程度每一輪都不一樣：第一個讀者讀完、`SET` 之前到達的請求都會再讀一次；第一輪 JVM 還沒暖機，每個請求都慢，200 個全部擠在那個窗口裡。

**ours：每一台機器剛好 1 次。** 3 台就是 3 次。

0.6.1 擔心的是「1,000 rps 同時 miss 會全部打進 MySQL」—— 200 個並行的請求已經能打出 200 次。一個熱點商品的快取過期一次，MySQL 就要在幾毫秒內吃下幾百句一樣的查詢；如果它剛好也在處理那個熱點商品的下單（第 04 章的熱點列），這幾百句就會排在同一批鎖後面。

> 📌 **3 台是 3 次，要不要做成 1 次？** 那需要分散式的 single-flight：用 Redis 的鎖，讓 3 台機器裡只有一台去讀。
> 它把 3 次 MySQL 讀取變成 1 次，代價是每一次 miss 都多一次 Redis 往返、多一種失敗模式（拿鎖的那台掛了，其他兩台要等鎖過期）。
> **3 次一樣的主鍵查詢，MySQL 根本感覺不到。** 這一章不做。擊穿的危險在於「N 跟請求數成正比」，single-flight 把它變成「N 跟機器數成正比」，就已經解決了。

### 6.2.3 事故三：快取命中了，MySQL 還是收到 5 句 ★★

快取接上去之後，`ProductService.detail()` 的第一版長這樣 —— 沿用第 03 章的寫法，方法上有 `@Transactional(readOnly = true)`：

```java
@Transactional(readOnly = true)
public ProductDetail detail(long productId, Long viewerId) {
    ProductCache.Core c = cache.get(productId, this::load).orElseThrow(() -> ShopException.notFound("商品"));
    // ……可見性檢查、可售量……
}
```

快取命中的時候，這個方法一句 SQL 都不會送出 —— 照理說。G3 先讀一次填好快取，再依序讀 1,000 次，量 MySQL 的 `Questions`（伺服器收到的每一句指令都算，包括 `SET`、`COMMIT`）與 Hikari 的「拿連線」次數：

```bash
mvn test -Pexperiments -Dtest=G3CacheHitConnectionTest
```

```
═══ 6.2.3 商品 3 已在快取裡，依序讀 1,000 次 ═══
  ① 外層有 @Transactional(readOnly = true)    MySQL 收到  5005 句（每次 5.01）│ 拿連線  1000 次 │ 平均 4.444 ms
  ② 沒有外層交易（現在的 detail）                     MySQL 收到     5 句（每次 0.01）│ 拿連線     1 次 │ 平均 0.571 ms
  ① 的一次請求，MySQL 的 general log 長這樣：
    set session transaction read only
    SET autocommit=0
    commit
    SET autocommit=1
    set session transaction read write
```

（另一次執行：① 每次 5.01 句、平均 1.94 ms；② 每次 0.00 句、平均 0.52 ms。② 那 5 句與 1 次連線，是可售量的 5 秒快取（6.4.4）在這段期間到期、重讀了一次。）

**快取命中，MySQL 一樣收到 5 句，每一次都拿一條連線。** general log 說出了那 5 句是什麼：Spring 的 `JpaTransactionManager` 開一個唯讀交易，要先告訴 MySQL「這是唯讀的」、「關掉 autocommit」，結束時 `commit`、再把兩個設定改回去。**一句真正的查詢都沒有，但交易的開與關就是 5 句、5 次來回、一條連線。**

> ⚠️ **專題寫完之後的更正**：這一句原本寫的是「5 句、**一次**來回」—— 錯了，當時沒有量。JDBC 的這幾個呼叫各自是一次「送出、等回答」：用 Connector/J 在同一條連線上把五個呼叫各自計時 2,000 輪（MySQL 是 0.10 的 compose，load average 3.5）：
>
> ```
> ═══ 唯讀交易的開與關，2,000 輪（Connector/J，同一條連線）═══
>   setReadOnly(true)      平均 0.147 ms
>   setAutoCommit(false)   平均 0.144 ms
>   commit()               平均 0.142 ms
>   setAutoCommit(true)    平均 0.149 ms
>   setReadOnly(false)     平均 0.144 ms
>   對照：SELECT 1            平均 0.176 ms
>   MySQL Questions 增加 12,000（每輪 6.00；含對照的 SELECT 1）
> ```
>
> 每一個都跟一句 `SELECT 1` 差不多貴 —— **5 句就是 5 次來回**。這讓下面的結論更站得住：快取命中時，那 5 次來回就是全部的成本。（這支量測是一次性的探查程式，不在 shop repo 裡。）

延遲是 4～8 倍的差距（1.94 vs 0.52 ms、4.44 vs 0.57 ms）。更重要的是連線：0.6.1 的搶購情境是商品頁每秒 1,000 次，每一次都拿一條連線 —— 連線池只有 20 條（0.6.2、0.10.4），快取的目的之一就是讓那 1,000 次**不需要**資料庫，結果它們每一次都在跟下單搶連線。

修法：方法上**不要** `@Transactional`。只有快取沒命中時的 `load()` 需要交易（`Category` 是 LAZY，讀它的 id 要在 session 裡），它自己開：

```java
/** 快取沒有的時候才從 MySQL 載入 —— 只有這一步需要交易（Category 是 LAZY，讀它的 id 要在 session 裡） */
private Optional<ProductCache.Core> load(long id) {
    return readOnly.execute(s -> products.findById(id).map(ProductService::core));
}
```

（這個 `load()` 本身也是一次修正的結果：第一次把熱點判斷 `hotProducts()` 接上快取時，那個方法上沒有交易，快取沒命中 → `products.findById()` → 讀 `category.getId()` → `LazyInitializationException`，`OrderFlowTest` 的 14 個測試有 13 個因此失敗。）

> 📌 **`@Transactional(readOnly = true)` 不是免費的。** 它在第 03 章是對的：那時候每一次讀都要查資料庫，多 4 句交易控制的指令只是小小的額外成本。
> 加上快取之後，「每一次讀都要查資料庫」不成立了，那 5 句就變成全部的成本。**交易的範圍應該跟著「真的會碰資料庫的那一段」走，而不是跟著方法走。**

### 6.2.4 事故四：閘門過了，訂單沒成立 ★★★

0.6.1 的第 3 條：「熱點商品（`hot = true`）走 **Redis 預扣 + MySQL 落帳**」。這一章的做法（6.5）是讓 Redis 當**閘門**：下單之前先在 Redis 減 1，減不下去就直接 409，2,000 個人裡搶不到的 1,500 個人完全不碰 MySQL；減下去的才進入第 04 章的下單交易。

閘門在下單交易**之前**。所以有一種情況：Redis 已經減了，下單交易卻失敗了 —— 價格變了（409 price-changed）、商品剛下架、資料庫錯誤……減掉的那一件要加回去。

G4 的熱點商品有 100 件，Redis 與 MySQL 一致。第一波 100 個買家帶**舊的價格**下單（全部 409 price-changed —— 價格比對在 MySQL 的交易裡，閘門已經減過了），第二波 100 個買家帶正確的價格：

- **naive**：閘門 → 下單；失敗就讓例外丟出去。
- **ours**：`PlaceOrderService.placeOrder()`，每一條失敗的路徑都把減掉的加回去（6.5.2）。

最後再跑兩輪對帳（6.6）。

```bash
mvn test -Pexperiments -Dtest=G4HotGateLeakTest
```

```
═══ 6.2.4 熱點商品庫存 100 件：100 個帶舊價格的 409 之後，100 個帶正確價格的買家能買到幾件？═══
  naive  第一波 {409 /problems/price-changed=100} → Redis 0、MySQL 可售 100
         第二波 {409 /problems/insufficient-stock=100} → Redis 0、MySQL 可售 100
         對帳兩輪：修正 1 個商品 → Redis 100、MySQL 可售 100
  ours   第一波 {409 /problems/price-changed=100} → Redis 100、MySQL 可售 100
         第二波 {201=100}                → Redis 0、MySQL 可售 0
         對帳兩輪：修正 0 個商品 → Redis 0、MySQL 可售 0
```

**naive：100 件商品，一件都沒賣出去。** 第一波的 100 個 409 沒有任何一張訂單成立，MySQL 的可售量還是 100 —— 但 Redis 已經是 0 了。第二波 100 個帶正確價格的買家，全部在閘門被擋下：**「已售完」**。

這比超賣還難發現：

- 沒有任何錯誤日誌。409 是「正常」的業務回應。
- MySQL 的每一條不變量都成立（INV-1～INV-4），對帳 SQL（2.5.5）一筆差異都找不到 —— 因為 MySQL 根本沒被動過。
- 買家看到的是「已售完」，賣家看到的是「一件都沒賣」。

**ours：第一波之後 Redis 還是 100，第二波 100 件全部賣出。**

naive 的那一列最後一行是 Redis 對帳（6.6）：連續兩輪看到「Redis 0、MySQL 100」，用 CAS 修正成 100。**對帳是安全網，不是正常的路徑** —— 對帳每分鐘跑一次，在那一分鐘裡，100 件商品賣不出去；搶購的那 10 秒早就過了。

> 📌 價格不符只是其中一條路。閘門之後還有：冪等鍵的「處理中」（409 in-progress）與「重送」（200，訂單早就成立了，這次減的要還）、商品下架、一位賣家以外的品項、訂單編號撞號用完重試、資料庫連線逾時……
> `PlaceOrderService` 用一個 `try / catch` 包住閘門之後的**全部**，而不是在每一條路上各自記得加回去（6.5.2）。**漏掉一條，就是少賣。**

### 6.2.5 事故五：鎖在 commit 之前放掉 ★★

Redis 裡的庫存只是 MySQL 的「快速副本」（0.3.3），兩邊總有對不上的時候（6.2.4 就是一種），所以要對帳：讀 MySQL 的可售量、寫進 Redis。

但對帳的同時，賣家可能正在補貨（MySQL `on_hand + 1`，commit 之後 Redis 也 `+1`）。對帳讀 MySQL 時補貨還沒 commit、寫 Redis 時補貨的 `+1` 已經加上去了 —— 對帳的 `SET` 會蓋掉那個 `+1`，Redis 從此少了 1 件。

教科書的答案是**分散式鎖**：補貨與對帳拿同一把鎖，不讓它們交錯。G5 比較三種寫法：

```java
case "V1" -> tx.executeWithoutResult(s -> {                       // 「照直覺寫」：@Transactional 方法裡 lock / finally unlock
    var h = lock();
    try {
        jdbc.update("UPDATE inventory SET on_hand = on_hand + 1 WHERE product_id = ?", P);
        incr();
    } finally {
        locks.unlock(h);
    }
});
case "V2" -> tx.executeWithoutResult(s -> {
    var h = lock();
    jdbc.update("UPDATE inventory SET on_hand = on_hand + 1 WHERE product_id = ?", P);
    afterCommit(this::incr);
    locks.unlockAfterTransaction(h);                              // afterCompletion：在 afterCommit 的 incr 之後
});
default -> tx.executeWithoutResult(s -> {
    jdbc.update("UPDATE inventory SET on_hand = on_hand + 1 WHERE product_id = ?", P);
    afterCommit(this::incr);                                      // 正式的 HotStock.giveBackAfterCommit
});
```

- **V1 鎖在 commit 之前放掉**：最常見的寫法。`@Transactional` 方法裡 `lock()`、`finally { unlock() }` —— `finally` 在方法 return 之前執行，**而交易在方法 return 之後才 commit**。
- **V2 鎖包住交易**：commit 之後才加 Redis，`afterCompletion`（commit 或 rollback 之後）才放鎖。
- **V3 不用鎖**：對帳改用 CAS —— 「讀 Redis → 讀 MySQL → 只有在 Redis 的值從頭到尾沒變的時候才寫入」（6.6）。

V1、V2 的對帳：拿鎖 → 讀 MySQL → `SET` Redis → 放鎖。

兩種情境：A 只有補貨；B 補貨之外還有取消（`reserved − 1`，commit 之後 Redis `+1`，**不拿鎖** —— 取消在訂單的交易裡，6.6 會說為什麼它不該拿鎖）。

**這個實驗的第一版量錯了。** 第一版讓對帳一直跑到所有操作結束，最後一次對帳在沒有任何操作的時候執行，把之前造成的偏差全部抹平了 —— 三種寫法幾乎都是 0。真實的對帳是每分鐘一次，兩次對帳之間，它弄出來的偏差會一直留著。所以改成：每一輪補貨 200 次，**對帳只在前 2/3 的期間跑**，看結束時 Redis − MySQL 是多少；每種跑 20 輪。

```bash
mvn test -Pexperiments -Dtest=G5LockAroundTransactionTest
```

```
═══ 6.6 每輪：補貨（與取消）各 200 次，前 2/3 的期間同時對帳；看結束時 Redis − MySQL，每種 20 輪 ═══
  A 補貨         V1 鎖在 commit 前放掉     {一致=17, 少賣（-1）=3}
  A 補貨         V2 鎖包住交易             {一致=20}
  A 補貨         V3 不用鎖，對帳用 CAS       {一致=18, 多算（+1）=2}
  B 補貨 + 取消    V1 鎖在 commit 前放掉     {一致=18, 少賣（-1）=2}
  B 補貨 + 取消    V2 鎖包住交易             {一致=20}
  B 補貨 + 取消    V3 不用鎖，對帳用 CAS       {一致=20}
```

（每一輪的結果只會是 −1、0、+1：更早的偏差都被下一次對帳抹平了，留下來的只是「最後一次對帳」造成的。所以這張表量的是「**一次對帳出錯的機率**」。）

**V1：20 輪裡有 3 輪、2 輪以少賣結束。** 鎖保護了「改 MySQL、加 Redis」這兩件事不被對帳插隊 —— 但 MySQL 的改動在鎖放掉的時候**還沒有 commit**。對帳拿到鎖、讀 MySQL，讀到的是補貨之前的值（REPEATABLE READ 讀不到未提交的資料），然後 `SET` 進 Redis，蓋掉了補貨剛剛加上去的 `+1`。

**V2：兩種情境都 20 輪全部一致。** 鎖包住了交易。

**V3：沒有任何一輪少賣**，有 2 輪多算 1 —— 那是安全的方向（6.5.3）。

**我原本預測 V2 在情境 B 會出錯**：取消不拿鎖，對帳在「取消 commit 之前」讀 MySQL、在「取消的 `+1` 之後」`SET`，一樣會蓋掉一次 `+1`。**這 20 輪沒有量到。** 那個窗口在推理上存在，但它要求取消的 commit 與 `+1` 兩件事都剛好落在對帳「讀」與「寫」之間的幾百微秒裡，這個實驗量不出來。所以這一章最後選 V3 的理由不是「V2 量到了錯」—— 6.6 會說明。

> 📌 **「鎖要包住交易」：拿鎖可以在交易裡，放鎖一定要在 commit 之後。**
> `@Transactional` 的方法裡 `try { ... } finally { unlock(); }` 是錯的 —— `finally` 比 commit 早。要嘛在交易**外面**拿鎖、放鎖（`lock → TransactionTemplate.execute → unlock`），要嘛把放鎖登記在 `afterCompletion`（`DistributedLock.unlockAfterTransaction`，6.3.3）。

---

## 6.3 本章的形狀

### 6.3.1 2 支新的 API

| 方法 | 路徑 | 角色 | 故事 | 成功時 |
|---|---|---|---|---|
| `GET` | `/api/products/trending` | 公開 | RPT-2 AC-2 | 200，近 24 小時下單量 Top 10；Redis 不能用時 200 空清單 + `X-Degraded: trending` |
| `POST` | `/api/seller/products/{id}/hot` | SELLER | 0.6.1 第 3 條 | 200，回傳商品詳情（`ProductDetail`）。請求 body `{"hot": true}` 標成熱點商品（下單走 Redis 閘門），`{"hot": false}` 取消 |

其他的改變都在**既有的 API 後面**：`GET /api/products/{id}` 走快取（6.4）、`POST /api/orders` 多了閘門與每位買家的限流（6.5、6.7）、所有請求多了一個每 IP 的限流（6.7.2）。

`OpenApiContractTest` 列出這兩支新的 operation 與 `components` 的變動（`HotRequest`、`TrendingService.Item`），既有的 operation 一個都沒有變。`SecurityRouteCoverageTest`（5.5.5）在 `PUBLIC` 加上 `GET /api/products/trending` 之前是紅的 —— 它是新的公開 API，表上必須寫明；`IdorMatrixTest`（5.8.2）在 `MATRIX` 加上 `POST /api/seller/products/{id}/hot` 之前也是紅的 —— 它帶著商品 id，別的賣家打它要 404。**兩個覆蓋掃描在第一次新增 API 時，就各自做了它們該做的事。**

確認 `OpenApiContractTest` 列出來的只有新增、沒有變更之後，照第 05 章的做法更新快照：

```bash
mvn test -Dtest=OpenApiContractTest -Dopenapi.update=true
```

`src/test/resources/openapi/shop-api.json` 的 diff 應該只有四塊新增，沒有任何一行刪除：`components.schemas` 多了 `HotRequest`（必填的 boolean `hot`）與 `Item`（`productId`、`name`、`quantity`；schema 的名字是類別的簡單名稱 `Item`，不是 `TrendingService.Item`）；`paths` 多了 `/api/products/trending`（`get`，回應是 `Item` 的陣列）與 `/api/seller/products/{id}/hot`（`post`，請求是 `HotRequest`、回應是 `ProductDetail`）。完整的 diff 在 6.11.1。

### 6.3.2 Redis 裡有什麼

| key | 型別 | 內容 | TTL | 誰寫、什麼時候 | Redis 掛了 |
|---|---|---|---|---|---|
| `product:v1:{id}` | string（JSON） | 商品頁的欄位 + `version` | 10 分鐘 + 亂數 | 讀的人（沒命中時）；改商品的交易 commit 之後 | 讀 MySQL，本機記憶體留 1 秒（6.9.2） |
| `available:{id}` | string | 一般商品的可售量 | 5 秒 | 讀的人 | 讀 MySQL，本機記憶體留 5 秒 |
| `stock:{id}` | string（整數） | 熱點商品可以預扣的量 | 無 | 閘門（減）；取消、補貨 commit 之後（加）；對帳（CAS） | 熱點下單 503 |
| `lock:stock:{id}` | string | 分散式鎖的 token | 2 秒 | 建立 `stock:{id}` 的那一個請求 | —— |
| `rl:orders:{buyerId}` | ZSET | 1 分鐘內下過的冪等鍵 | 1 分鐘 | 下單 API | 單機記憶體 |
| `rl:ip:{ip}:{秒}` | string（整數） | 這一秒的請求數 | 1 秒 | 所有請求 | 單機記憶體 |
| `trending:24h:top10` | string（JSON） | 熱門排行 | 1 分鐘 | 讀的人（沒命中時） | 空清單 |
| `login:fail:{email}` | string（整數） | 登入失敗計數 | 15 分鐘 | 登入（5.6.2） | 暫停鎖定（5.6.4） |

最後一欄就是 0.6.3 降級矩陣的「Redis」那一欄，逐格落實。只有 `stock:{id}` 那一列是「失敗」而不是「降級」—— 6.9.1 說明為什麼。

0.3.3 說「Redis 的資料丟了可以接受，所有資料都能從 MySQL 重建」。這張表的每一列都成立：前兩列與最後四列本來就是快取或計數，`lock:stock:{id}` 是一把 2 秒就到期的鎖；`stock:{id}` 不存在時，下一個熱點下單會從 MySQL 的可售量重建它（6.5.1）。

**記憶體滿了怎麼辦？** 0.10 的 compose 用的是 `--maxmemory 256mb --maxmemory-policy noeviction`：記憶體滿了不淘汰任何 key，而是拒絕寫入新資料的指令（`OOM command not allowed when used memory > 'maxmemory'`）。所以上面那一欄 TTL 就是本專題的「淘汰策略」：除了 `stock:{id}`，每一種 key 都有 TTL，記憶體靠到期回收，不靠淘汰；`stock:{id}` 沒有 TTL，但它的個數就是熱點商品的個數。

真的滿了會怎樣：Lettuce 收到的是一個指令錯誤，Spring 把它轉成 `RedisSystemException` —— 它也是 `DataAccessException`，所以 `RedisGuard`（6.3.3）把它當成一次 Redis 失敗，1 秒內 3 次就跳開，**整欄一起降級**：熱點下單 503、商品詳情走 MySQL，跟 Redis 掛掉的樣子一樣。這一章沒有實測記憶體滿的情境。

> 📌 **專題寫完之後的追記：實測了。** 一台 `redis:7.2 --maxmemory 2mb --maxmemory-policy noeviction`，用 Spring Data Redis 3.2.5（Lettuce 6.3.2）一直塞 100 KB 的 key，滿了之後各試一種指令：
>
> ```
> ═══ 塞了 8 個 100 KB 的 key 之後，SET 失敗 ═══
>   第 9 個 SET 的例外：org.springframework.data.redis.RedisSystemException：Error in execution
>         ← io.lettuce.core.RedisCommandExecutionException：OOM command not allowed when used memory > 'maxmemory'.
>       DataAccessException? true
>   used_memory / maxmemory：1.92M / 2.00M（noeviction）
>   SET product:1（快取寫入）                → 成功：OK
>   GET stock:1（讀）                     → 成功：100
>   DECRBY stock:1 1                   → 成功：99
>   EVAL（閘門那種 Lua，會寫）                  → org.springframework.data.redis.RedisSystemException：Error in execution
>         ← io.lettuce.core.RedisCommandExecutionException：OOM command not allowed when used memory > 'maxmemory'. script: 84c238d…, on @user_script:1.
>       DataAccessException? true；訊息：Error in execution
>   DEL fill:0（刪）                      → 成功：true
> ```
>
> 上面那段說法成立：是 `RedisSystemException`，是 `DataAccessException`，`RedisGuard` 接得到。多看到一件事：**在上限邊緣（1.92M／2.00M），一般的 SET、DECRBY 還過得去，閘門那種會寫的 Lua 已經被拒絕了** —— 熱點下單會比商品快取的寫入更早開始 503。為什麼腳本在這個時候就被判定超過上限，我沒有往下查。（這支量測是一次性的探查程式，不在 shop repo 裡。）

反過來想：如果改用會淘汰的策略，`stock:{id}` 被淘汰掉，會怎樣？下一個熱點下單發現 key 不存在，從 MySQL 的可售量重建（6.5.1）。那一刻還在「Redis 已減、MySQL 還沒 commit」的訂單，會在重建的數字裡被多算一次 —— Redis **偏高**，多放一些請求進 MySQL，由條件式 UPDATE 擋下（6.5.3）。在這一章的設計裡，丟掉 `stock:{id}` 的後果是浪費與等對帳，不是超賣；練習二用 `FLUSHALL` 驗證的是同一件事。

### 6.3.3 `RedisGuard`：所有 Redis 呼叫的共同入口

第 05 章的 `LoginAttempts` 自己做了一份「Redis 失敗之後 5 秒內不再碰它」（5.6.4）。這一章有快取、熱點庫存、限流、排行四個使用者，把這個做法抽成 `shared.redis` 的一個類別（`LoginAttempts` 本身保持第 05 章的版本，沒有改用它）：

```java
/**
 * 執行一個 Redis 動作。成功 → 結果；失敗或正在退避 → empty（呼叫端決定降級路徑）。
 * 只接 DataAccessException：Lettuce 的連線失敗、逾時都會被 Spring 轉成它。其他例外（程式的 bug）照常丟出去。
 */
public <T> Optional<T> call(String what, Supplier<T> action) {
    if (!available()) { skipped.increment(); return Optional.empty(); }
    try {
        return Optional.ofNullable(action.get());
    } catch (DataAccessException e) {
        tripped(what, e);
        return Optional.empty();
    }
}
```

每一個呼叫端都寫成 `guard.call(...).orElseGet(降級路徑)` 的形狀：**降級路徑寫在呼叫的地方**，讀程式碼的人一眼就看得到「Redis 不在的時候，這裡會發生什麼事」。

`tripped()` 的第一版是「失敗一次就跳開 5 秒」，跟 `LoginAttempts` 一樣。6.4.5 會量出這個「一次就跳開」在每秒 1,000 個請求時造成了什麼，以及為什麼最後改成「1 秒內失敗 3 次才跳開」還不夠。最終版 `RedisGuard` 與 `DistributedLock` 的全文在 6.11.1。

`DistributedLock` 也在 `shared.redis`：`SET key token NX PX ttl` 拿鎖，Lua 比對 token 放鎖（只能放自己的鎖，[10-redis/09](../10-redis/09-distributed-lock.md)），外加一個 `unlockAfterTransaction()`：

```java
/**
 * 有交易 → 等交易結束（commit 或 rollback）之後才放鎖；沒有交易 → 現在就放。
 * afterCompletion 在 afterCommit 之後執行：登記在 afterCommit 的 Redis 更新會先做完，鎖才放掉。
 */
public void unlockAfterTransaction(Handle h) {
    if (!TransactionSynchronizationManager.isSynchronizationActive()) { unlock(h); return; }
    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override
        public void afterCompletion(int status) { unlock(h); }
    });
}
```

這是 6.2.5 V2 的寫法。它最後只用在一個地方（6.5.1），理由在 6.6。

---

## 6.4 商品快取

### 6.4.1 commit 之後寫入新值，帶著版本號

```java
/**
 * 6.4 商品詳情的快取（US-PRD-3）。只放「不常變、變了要立刻生效」的部分；可售數量另外處理（AC-4 的 5 秒，6.4.4）。
 *
 * 三條規則：
 *  ① 寫入之後「在 commit 之後」把新值寫進快取，而不是在交易裡刪掉（6.2.1：刪在 commit 之前，讀的人會把舊值填回去）
 *  ② 寫進快取一律帶版本號（products.version），Lua 比較：舊的版本蓋不掉新的版本（6.2.1：讀的人慢了一步，一樣會把舊值填回去）
 *  ③ 同一台機器、同一個商品，同一時間只有一個請求去 MySQL 讀（6.2.2：快取過期的瞬間 200 個請求一起打進來）
 */
@Component
class ProductCache {

    /** 商品頁需要的欄位（不含可售數量）。version 是 products.version */
    record Core(long id, long sellerId, String name, String description, BigDecimal price, long categoryId,
                ProductStatus status, boolean hot, int version) {}

    /** 只有在「沒有值」或「現有的版本比較舊」時才寫入。ARGV: 版本、JSON、TTL 毫秒 */
    static final RedisScript<Long> SET_IF_NEWER = RedisScript.of("""
            local cur = redis.call('GET', KEYS[1])
            if cur then
              local v = tonumber(string.match(cur, '"version":(%d+)'))
              if v and v >= tonumber(ARGV[1]) then return 0 end
            end
            redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
            return 1""", Long.class);
    // ……
}
```

（`ProductCache` 的全文，包括 `put()`、`putAfterCommit()`，以及 6.4.2、6.4.3、6.9.2 加上去的部分，在 6.11.1。）

**規則 ①：寫入新值，而不是刪除。** 刪除會留下一個「快取是空的」窗口，讀的人會在那個窗口裡把舊值填回去 —— 6.2.1 的 ①、② 都是這樣錯的。commit 之後直接寫入新值，快取從舊值變成新值，中間沒有空窗。

**規則 ②：帶著版本號，只接受比較新的。** 寫入新值之後，還是可能有一個「慢了一步」的讀者：它在 commit **之前**從 MySQL 讀到舊值（版本 7），在 commit **之後**才回來寫快取。沒有版本號的話，它會蓋掉剛寫進去的新值（版本 8）。有了版本號，Lua 腳本拿快取裡的版本（8）跟要寫入的版本（7）比：`8 >= 7` 成立，拒絕寫入，版本 7 寫不進去。

`ProductCacheTest.olderVersionCannotOverwrite`（`ProductCacheTest` 的全文在 6.11.1）把這件事寫成測試：拿著改價前的 `Core` 去寫，指令執行成功（回傳 `true`），但讀出來的還是新價格。

版本號是 `products.version`，第 02 章就有了（2.4.2：每張可以被編輯的表都有 `version`，`Product` 上是 JPA 的 `@Version`）。`@Version` 在 **flush 時**才加 1 —— 交易裡讀到的 `version` 還是舊的。所以「commit 之後寫入」傳的是一個 `Supplier`，在 `afterCommit` 裡才組出 `Core`：

```java
/** 6.4.1 每一個改商品的方法最後都呼叫它：commit 之後，把新的值（新的版本）寫進快取 */
private void refreshCacheAfterCommit(Product p) {
    cache.putAfterCommit(() -> core(p));
}
```

`update`（改價）、`publish`、`unpublish`（US-PRD-4 AC-1：下架 1 秒內從詳情頁消失）、`setHot` 四個方法都呼叫它。`ProductCacheTest` 的兩個測試：改價之後**下一次**讀就是新價格；下架之後買家立刻 404、賣家本人還看得到（US-PRD-3 AC-2）。

> ⚠️ **繞過 `ProductService` 改資料庫的人，快取不會知道。** 寫這一章時，這件事先咬了測試：第 04 章的 `OrderFlowTest`、驗收 Q1～Q5 都用 SQL 直接建商品（`INSERT INTO products ...`）、測完刪掉，下一個測試再用**同一個 id** 建一次。
> 新插入的那一列 `version = 0`，快取裡上一次留下的也是 `version = 0` —— `0 >= 0`，新的值寫不進去，舊的名稱、價格、狀態一直留著。
> 測試的修法是 `TestRedis.forgetProducts()`：用 SQL 建、刪商品的測試，清理時一併刪掉那個商品的 `product:v1:`、`stock:`、`available:` 三個 key，另外也刪掉熱門排行的 `trending:24h:top10`（全文在 6.11.1）。
> **正式環境一樣**：維運用 SQL 修資料（改錯的價格、補一個下架），快取裡的值會留到 TTL 到期（最多 10 分鐘多）。修資料的 SOP 要加一步：刪掉那幾個商品的快取 key。

### 6.4.2 ⚠️ 寫入失敗的那一次

回到 6.2.1 的那 1 次：③（本專題的寫法）在「改價那一刻快取剛好過期」的情境下，100 次裡有 1 次在 1 秒後仍是舊價格。版本號應該讓這種事不可能發生 —— 除非新值根本沒有寫進去。

**第一次追查：重跑，印出現場。** 只跑 ③、100 次，把每一次不一致時 MySQL 與快取裡的版本號都印出來：**0 / 100**。重現不了。

**第二次：重跑兩次，記下 Redis 失敗的次數。** 第一次執行在第 22 秒就中止了，例外是：

```
org.springframework.dao.QueryTimeoutException: Redis command timed out
	at com.example.shop.catalog.internal.G1CacheInvalidationTest.expiryAtTheMomentOfWrite(G1CacheInvalidationTest.java:123)
Caused by: io.lettuce.core.RedisCommandTimeoutException: Command timed out after 500 millisecond(s)
```

逾時的是**實驗自己**的 `redis.delete()`（模擬 TTL 到期的那一行）。這是一個重要的線索：**32 條執行緒不停讀同一個 key 的時候，這個環境裡的 Redis 指令真的會偶爾超過 500 ms**（0.10.4 設的逾時）。

讓實驗自己的 Redis 操作在逾時時重試，再跑兩次 —— 這一次是我犯了 6.2.0 說的那個錯：前一組重跑還在背景執行，兩個 JVM 同時在改同一個商品，第 1 次的資料全部作廢（MySQL 的版本號每一輪跳 2）。確認沒有重疊之後的那一次：

```
  ② commit 之後刪         1 秒後仍是舊價格：  0 / 100 次（累計 Redis 失敗 0 次）
REDIS_DEGRADED product-cache.get 失敗，5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
  ③ commit 之後寫入新值 + 版本號 1 秒後仍是舊價格：  0 / 100 次（累計 Redis 失敗 2 次）
```

這一次有逾時，但發生在**讀的人**身上（`product-cache.get`），所以沒有留下舊價格。

**推測的機制**：那 1 次，逾時剛好發生在**寫的人**身上：

1. 讀者在 commit 之前從 MySQL 讀到舊值（版本 7），寫進快取 —— 這一步成功了。
2. 改價 commit（版本 8），`afterCommit` 要寫入新值 —— **這一步逾時了**，`RedisGuard` 回傳失敗，新值沒有寫進去。
3. 之後沒有任何人會再寫這個 key：讀的人都命中了快取裡的版本 7。**舊價格留到 TTL 到期，10 分鐘多。**

我沒有辦法讓那 1 次重現，所以這是推測。但第 2 步是**一定會發生的事**：Redis 會逾時、會重啟、網路會斷，`afterCommit` 的寫入不可能每一次都成功。版本號只保證「舊的蓋不掉新的」，**不保證「新的一定寫得進去」**。

修法：寫入失敗的商品記下來，背景每 200 ms 檢查一次，Redis 能用了就**刪掉**那個 key —— 下一次讀取會從 MySQL 讀到新的：

```java
/** 6.4.2：commit 之後寫入失敗的商品。Redis 恢復之後先刪掉它們的 key —— 在那之前，讀取都走 MySQL（RedisGuard），讀到的是新的 */
private final Set<Long> pendingEvictions = ConcurrentHashMap.newKeySet();

/** 商品改了、新值卻寫不進去：快取裡可能還是舊的那一份（讀的人先前填的）。記下來，Redis 一恢復就刪掉 */
private void putOrRemember(Core c) {
    degraded.remove(c.id());                                            // 這台機器的降級副本：改了就丟掉
    if (!put(c)) pendingEvictions.add(c.id());
}

void retryEvictions() {                                                 // 每 200 ms 一次
    if (pendingEvictions.isEmpty() || !guard.available()) return;
    for (Long id : pendingEvictions)
        if (guard.run("product-cache.evict", () -> redis.delete(key(id)))) pendingEvictions.remove(id);
}
```

（註解裡「在那之前，讀取都走 MySQL」是 `RedisGuard` 第一版「失敗一次就跳開」時的情況。6.4.5 改成「1 秒內失敗 3 次才跳開」之後，單一次寫入失敗不會跳開：在背景重試刪掉它之前（最多約 200 ms），讀者讀到的是快取裡的舊值 —— 仍在 AC-3 的 1 秒內，`failedWriteAfterCommitIsRepaired` 斷言的就是「1 秒內被刪掉」。）

為什麼是「刪除」而不是「重試寫入」？重試寫入要再讀一次 MySQL 才知道最新的值是什麼；刪除不需要 —— 下一個讀的人會去讀。而且到了重試的時候，「在 commit 之前讀到舊值的讀者」早就寫完了，不會再有人把舊值填回來。

`ProductCacheTest.failedWriteAfterCommitIsRepaired` 用一個「指定時刻丟逾時」的 `StringRedisTemplate` 把這三步做出來：讀者先寫入版本 1 → 改價、寫入版本 2 時丟逾時 → 1 秒內（US-PRD-3 AC-3）舊值被刪掉 → 下一次讀到版本 2。

用最終的程式碼再跑一次 G1 的 ③（`-Donly3=true` 讓「過期瞬間」那個方法跳過 ②）：

```bash
mvn test -Pexperiments -Dtest='G1CacheInvalidationTest#expiryAtTheMomentOfWrite' -Donly3=true
```

```
═══ 6.2.1 同上，但每次改價前快取剛好過期（100 次）═══
  ③ commit 之後寫入新值 + 版本號 1 秒後仍是舊價格：  0 / 100 次（累計 Redis 失敗 0 次）
```

> ⚠️ **這個修法還有一個洞：行程在「寫入失敗」到「重試成功」之間死掉。** `pendingEvictions` 只在記憶體裡，重啟就沒了，舊價格會留到 TTL 到期。
> 要把它補起來，「商品改了」這件事就要跟改價**在同一個交易裡**留下紀錄，由別的程式在 commit 之後可靠地處理 —— 那正是第 07 章 Outbox 的形狀。這一章接受這個洞，並用 TTL（10 分鐘）當最後的上限。

### 6.4.3 single-flight，以及一個藏在 `join()` 裡的 500

```java
/** 快取 → 沒有的話用 loader 從 MySQL 讀（同一個 id 同一時間只讀一次）→ 寫回快取 */
Optional<Core> get(long id, LongFunction<Optional<Core>> loader) {
    Optional<String> cached = guard.call("product-cache.get", () -> redis.opsForValue().get(key(id)));
    if (cached.isPresent()) return Optional.of(parse(cached.get()));
    if (!guard.available()) {                                           // Redis 不能用：本機的 1 秒副本（6.9.2）
        Local l = degraded.get(id);
        if (l != null && l.expiresAt() > System.currentTimeMillis()) return l.core();
    }
    CompletableFuture<Optional<Core>> mine = new CompletableFuture<>();
    CompletableFuture<Optional<Core>> running = loading.putIfAbsent(id, mine);
    if (running != null) {                                              // 別人正在讀：等它的結果
        try {
            return running.join();
        } catch (java.util.concurrent.CompletionException e) {          // join() 會包一層：拆開，讓 GlobalExceptionHandler 認得原本的例外
            if (e.getCause() instanceof RuntimeException r) throw r;
            throw e;
        }
    }
    try {
        Optional<Core> loaded = loader.apply(id);
        if (guard.available()) loaded.ifPresent(this::put);             // 讀的人寫入失敗沒關係：下一個讀的人會再試
        else degraded.put(id, new Local(loaded, System.currentTimeMillis() + DEGRADED_TTL_MS));
        mine.complete(loaded);
        return loaded;
    } catch (RuntimeException e) {
        mine.completeExceptionally(e);
        throw e;
    } finally {
        loading.remove(id, mine);
    }
}
```

`loading` 是一個 `ConcurrentHashMap<Long, CompletableFuture>`：第一個沒命中的請求放進一個 future、自己去讀；之後到達的人看到 future 已經在了，就等它（`join()`）。讀完之後從 map 移除 —— **single-flight 只合併「同時」的讀取，不是另一層快取**。

> ⚠️ **專題寫完之後的追記：`ProductCacheTest.singleFlight` 偶發地讀了 2 次。** 在 13 站第 00 章的分支上（這個類別與它的測試都沒有改）連跑三次整套 `mvn clean verify`，第二次這一題紅了：`expected: 1 but was: 2`，另外兩次是綠的。用同樣的情境在一個 JVM 裡重複 200 輪、再在 8 個 `yes` 佔滿 CPU（load 33）時重複 200 輪：400 輪都是 1 次，沒有重現。
> 讀上面這段程式碼，看得到一個窗口：一個請求讀 Redis 沒命中之後、`putIfAbsent` 之前，如果負責讀的那一個剛好讀完、寫進 Redis、從 `loading` 移除，它就會成為新的讀取者，再讀一次 MySQL（多讀一次，資料不會錯）。在「搶到讀取權之後再看一次 Redis」可以關掉這個窗口 —— 但我沒有重現它，**不能確定這就是那一次的原因**，所以程式碼沒有改，只記在這裡。
>
> 📌 **再追記（13 站第 01 章）：把那個窗口用 latch 釘住，重現了，也修了。** 400 輪重跑等不到它，就不要等：讓它**一定**發生。`ProductCacheTest.singleFlightLateMiss` 用一個 `RedisGuard` 的子類別，讓「慢的那個請求」讀 Redis 沒命中之後停在 latch 上；等負責讀的那個請求**整個做完**（讀 MySQL、寫進 Redis、從 `loading` 移除、`get()` 回來），再放它走：
>
> ```java
> RedisGuard pausing = new RedisGuard(java.time.Clock.systemUTC(), new io.micrometer.core.instrument.simple.SimpleMeterRegistry()) {
>     final AtomicBoolean paused = new AtomicBoolean();
>     @Override
>     public <T> Optional<T> call(String what, java.util.function.Supplier<T> action) {
>         Optional<T> r = super.call(what, action);
>         if (Thread.currentThread() == late[0] && what.equals("product-cache.get") && paused.compareAndSet(false, true)) {
>             missed.countDown();                                       // ① 沒有命中……
>             try { loaderDone.await(); } catch (InterruptedException e) { throw new IllegalStateException(e); }
>         }
>         return r;
>     }
> };
> // ……
> Future<?> slow = pool.submit(() -> { late[0] = Thread.currentThread(); return c.get(PRODUCT, loader); });
> missed.await();
> pool.submit(() -> c.get(PRODUCT, loader)).get();                      // ② 讀的人整個做完
> loaderDone.countDown();                                               // ③ 慢的請求醒來
> slow.get();
> assertThat(loads.get()).isEqualTo(1);
> ```
>
> 修正前：
>
> ```
> 6.4.3 追記：慢的請求醒來之後，MySQL 一共被讀了 2 次
> [ERROR] com.example.shop.catalog.internal.ProductCacheTest.singleFlightLateMiss -- Time elapsed: 0.049 s <<< FAILURE!
> expected: 1
>  but was: 2
> ```
>
> 修法就是上面說的那一句。把「讀快取」抽成 `peek()`，搶到讀取權之後再 `peek()` 一次：
>
> ```java
> Optional<Core> get(long id, LongFunction<Optional<Core>> loader) {
>     Optional<Optional<Core>> hit = peek(id);
>     if (hit.isPresent()) return hit.get();
>     CompletableFuture<Optional<Core>> mine = new CompletableFuture<>();
>     CompletableFuture<Optional<Core>> running = loading.putIfAbsent(id, mine);
>     if (running != null) { /* 別人正在讀：等它的結果（跟原本一樣） */ }
>     try {
>         // 「讀快取沒有」與「搶讀取權」之間，上一個讀的人可能剛好做完。搶到之後再看一次快取
>         Optional<Optional<Core>> late = peek(id);
>         if (late.isPresent()) {
>             mine.complete(late.get());
>             return late.get();
>         }
>         Optional<Core> loaded = loader.apply(id);
>         // ……（跟原本一樣）
> ```
>
> 為什麼再看一次就夠：上一個讀的人是**先**寫快取、**才**從 `loading` 移除的；搶到讀取權（`putIfAbsent` 成功）的人，一定在那次移除之後 —— 它寫的值一定看得到。（它寫入失敗的話看不到，那就再讀一次 MySQL，跟以前一樣。）代價：真的沒命中的那一個請求多一次 Redis 的 GET；等別人結果的請求不受影響。修正後同一個測試是 `MySQL 一共被讀了 1 次`，`ProductCacheTest` 8 個全綠，整套 `mvn clean verify` 227 個測試全綠、四道覆蓋率門檻都過（4:16）。
>
> **這證明了「這個交錯會讀 2 次」，沒有證明「13 站那一次就是它」** —— 那一次的日誌裡沒有分辨得出來的資訊。但讀程式碼只找得到這一條路，而修正之後它不存在了。

**`join()` 那一段的 `catch` 是後來加的。** 6.9.2 的降級演練裡出現了 1 個商品詳情的 500。那一次的日誌被我的過濾條件濾掉了，我沒辦法確認是哪一個例外，就去讀程式碼 —— 找到一條**一定會**產生 500 的路：負責讀 MySQL 的那個請求失敗了（例如連線池逾時，`CannotCreateTransactionException`），等它的人從 `join()` 拿到的不是那個例外，而是包了一層的 `CompletionException`。`GlobalExceptionHandler` 認得前者（503，4.8.2），不認得後者 —— 500。

`ProductCacheTest.waitersSeeTheOriginalException` 先證明這條路存在（修正前是紅的）：

```
Expecting a throwable with cause being an instance of:
  java.util.concurrent.CompletionException
java.util.concurrent.ExecutionException: java.util.concurrent.CompletionException: org.springframework.transaction.CannotCreateTransactionException: 模擬：連線池逾時
```

拆開之後，等待者拿到的就是原本的 `CannotCreateTransactionException`，跟讀 MySQL 的那個人一樣變成 503。

> ⚠️ **但那個 500 不是它造成的。** 修完之後重跑演練，500 還在（2 個）。保留完整日誌再跑，抓到的是另一個例外，在 `RedisGuard` 裡 —— 6.9.2。這條 `CompletionException` 的路是真的（測試證明了），只是不是那一次走的路。**讀程式碼找到「一個」可能的原因，不等於找到了「那一個」原因**；要等修完之後量不到了，才算數。

### 6.4.4 可售量：5 秒，另外存

US-PRD-3 AC-4：可售量「可以是約略值：允許最多 5 秒的延遲；真正的判斷在下單時」。0.4.3 的 📌：**庫存顯示錯了只是體驗問題**。

可售量變得比商品資料頻繁得多（每一張訂單、每一次取消），如果它跟商品資料放在同一個快取裡，每一次下單都要讓商品快取失效 —— 熱點商品搶購的時候，商品頁的快取一秒失效幾百次，等於沒有快取。所以它另外存：

```java
@Override
public int availableForDisplay(long productId, boolean isHot) {
    if (isHot) {
        Optional<Integer> v = hot.display(productId);                   // 熱點商品：直接讀閘門的數字（6.5）
        if (v.isPresent()) return Math.max(0, v.get());
    }
    String key = "available:" + productId;
    Optional<String> cached = guard.call("available.get", () -> redis.opsForValue().get(key));
    if (cached.isPresent()) return Integer.parseInt(cached.get());
    // ……Redis 不能用：本機記憶體的 5 秒副本（6.9.2）……
    int v = available(productId);
    if (guard.available()) guard.run("available.put", () -> redis.opsForValue().set(key, String.valueOf(v), DISPLAY_TTL));
    // ……
    return v;
}
```

- **一般商品**：`available:{id}`，TTL 5 秒，**不主動失效**。5 秒就是 AC-4 的上限，一個 TTL 就滿足了，不需要任何寫入端的程式碼。
- **熱點商品**：直接讀 `stock:{id}` —— 閘門用來擋人的那個數字（6.5）。它比 MySQL 更新（下單在 Redis 先減），也永遠不會因為「快取」而延遲。

**價格用主動失效（1 秒）、庫存用 TTL（5 秒）**，正是 0.4.3 那段 📌 預告的設計：「第 06 章的快取設計會直接從這兩條推出來」。

### 6.4.5 SLO：同一個商品每秒 1,000 次

0.6.2 的第一列：`GET /api/products/{id}`（快取命中），**同一個商品每秒 1,000 次 → p95 20 ms、p99 50 ms**。

G10 啟動整個應用程式，用開放式負載（延遲從預定送出的時間算起，4.8.1）打同一個商品 10 秒，一般商品（3）與熱點商品（1，可售量讀 `stock:1`）交錯各 3 輪；另外記這段期間 MySQL 每秒收到幾句、Redis 失敗幾次。這個實驗前後跑了三次，中間改了兩次程式碼 —— 三次都列出來，因為它們各自說明了一件事。

**第一次**（`RedisGuard` 是「失敗一次就跳開 5 秒」；那時印的「跳開」其實是失敗次數；前兩次標題的 `6.3.2` 是寫這一章途中的舊編號）：

```
═══ 6.3.2 同一個商品，每秒 1,000 次 GET /api/products/{id}，10 秒（開放式）═══
    [-auto-1-exec-63] REDIS_DEGRADED ratelimit 失敗，5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
  商品 3（一般）HTTP {0=41, 200=9959} │ p50   8.1  p95 4074.6  p99 6168.0  最慢 6410.6 ms │ MySQL 1272 句/秒 │ RedisGuard 跳開 20 次
  商品 1（熱點）HTTP {200=10000} │ p50   2.7  p95 287.1  p99  548.9  最慢  660.1 ms │ MySQL    1 句/秒 │ RedisGuard 跳開 0 次
  商品 3（一般）HTTP {200=10000} │ p50   1.3  p95  37.1  p99  273.7  最慢  372.6 ms │ MySQL    2 句/秒 │ RedisGuard 跳開 0 次
    [-auto-1-exec-23] REDIS_DEGRADED product-cache.get 失敗，5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
  商品 1（熱點）HTTP {200=10000} │ p50   1.4  p95 2170.2  p99 2608.1  最慢 3274.7 ms │ MySQL  896 句/秒 │ RedisGuard 跳開 40 次
  商品 3（一般）HTTP {200=10000} │ p50   2.1  p95 170.9  p99  432.9  最慢  498.1 ms │ MySQL  851 句/秒 │ RedisGuard 跳開 0 次
  商品 1（熱點）HTTP {200=10000} │ p50   1.7  p95  21.7  p99  109.2  最慢  163.2 ms │ MySQL    1 句/秒 │ RedisGuard 跳開 0 次
```

沒有出事的四輪：p99 109～549 ms。出事的兩輪：Redis 有一批指令逾時（20 次、40 次）→ `RedisGuard` 跳開 → **5 秒內每秒 1,000 個請求全部改讀 MySQL**：每秒 1,272 句、896 句，p95 變成 2～4 秒，還有 41 個請求在客戶端失敗（`0`）。

**斷路器把一次 Redis 的卡頓，放大成 5 秒的 MySQL 洪水。** 我的第一個修法是「1 秒內失敗 3 次才跳開」：偶發的一次逾時只影響那一次呼叫。

```java
private void tripped(String what, DataAccessException e) {
    long now = clock.millis();
    failures.increment();
    recentFailures.addLast(now);
    while (!recentFailures.isEmpty() && recentFailures.peekFirst() < now - WINDOW_MS) recentFailures.pollFirst();
    if (recentFailures.size() < TRIP_AFTER) return;                     // 偶發的一次：只有這一次走降級路徑
    // ……跳開 5 秒……
}
```

（這個方法在 6.9.2 還會再改一次：它有一個競態，要在演練裡才看得到。）

**第二次**（加上門檻之後）：

```
═══ 6.3.2 同一個商品，每秒 1,000 次 GET /api/products/{id}，10 秒（開放式）═══
  商品 3（一般）HTTP {200=10000} │ p50   5.7  p95 295.1  p99  449.8  最慢  592.3 ms │ MySQL    1 句/秒 │ Redis 失敗 0 次、跳開 0 次
  商品 1（熱點）HTTP {200=10000} │ p50   3.1  p95 147.5  p99  267.4  最慢  361.8 ms │ MySQL    4 句/秒 │ Redis 失敗 0 次、跳開 0 次
  商品 3（一般）HTTP {200=10000} │ p50   1.2  p95   9.3  p99   38.2  最慢   81.1 ms │ MySQL    3 句/秒 │ Redis 失敗 0 次、跳開 0 次
  商品 1（熱點）HTTP {200=10000} │ p50   1.7  p95  22.9  p99   81.1  最慢  166.7 ms │ MySQL    2 句/秒 │ Redis 失敗 0 次、跳開 0 次
  商品 3（一般）HTTP {200=10000} │ p50   1.2  p95   9.7  p99   34.2  最慢   61.7 ms │ MySQL    1 句/秒 │ Redis 失敗 0 次、跳開 0 次
  商品 1（熱點）HTTP {200=10000} │ p50   1.7  p95 235.3  p99  488.1  最慢  583.3 ms │ MySQL    1 句/秒 │ Redis 失敗 0 次、跳開 0 次
```

這一次 Redis 一次都沒有失敗，所以它**看不出門檻的效果**。它量到的是「沒有出事」時的樣子：p99 34～488 ms，只有兩輪（一般商品的 38.2、34.2 ms）達到 50 ms 的 SLO。

而且回頭看第一次：出事的那兩輪是**一整批**逾時（20、40 次），「1 秒內 3 次」照樣會跳開。**這個門檻沒有解決觀察到的那個情境** —— 問題不在「什麼時候跳開」，在「跳開之後做什麼」：`ProductCache.get()` 在 Redis 不能用時直接 `return loader.apply(id)`，連 single-flight 都跳過了，每秒 1,000 個請求就是 1,000 次 MySQL。我當時的註解寫的是「不要排隊，大家各自讀 MySQL」—— 那個判斷是錯的。修法在 6.9.2：降級時 single-flight 照常，結果在本機記憶體放 1 秒。

**第三次**（門檻 + 本機降級快取，也就是最終的程式碼）：

```
═══ 6.4.5 同一個商品，每秒 1,000 次 GET /api/products/{id}，10 秒（開放式）═══
    [-auto-1-exec-25] REDIS_DEGRADED ratelimit 失敗（1 秒內第 3 次），5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
    [-auto-1-exec-99] REDIS_DEGRADED ratelimit 失敗（1 秒內第 3 次），5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
    [-auto-1-exec-14] REDIS_DEGRADED available.get 失敗（1 秒內第 3 次），5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
  商品 3（一般）HTTP {0=260, 200=9740} │ p50 433.6  p95 2530.7  p99 2983.2  最慢 3366.3 ms │ MySQL    9 句/秒 │ Redis 失敗 163 次、跳開 54 次
    [auto-1-exec-125] REDIS_DEGRADED ratelimit 失敗（1 秒內第 3 次），5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
    [-auto-1-exec-72] REDIS_DEGRADED ratelimit 失敗（1 秒內第 3 次），5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
  商品 1（熱點）HTTP {0=194, 200=9806} │ p50 2063.7  p95 8730.4  p99 10497.0  最慢 10979.4 ms │ MySQL   14 句/秒 │ Redis 失敗 338 次、跳開 113 次
    [auto-1-exec-117] REDIS_DEGRADED available.get 失敗（1 秒內第 3 次），5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
    [auto-1-exec-200] REDIS_DEGRADED available.get 失敗（1 秒內第 3 次），5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
  商品 3（一般）HTTP {200=10000} │ p50 155.8  p95 2676.1  p99 3343.1  最慢 3683.9 ms │ MySQL   15 句/秒 │ Redis 失敗 171 次、跳開 59 次
    [-auto-1-exec-90] REDIS_DEGRADED ratelimit 失敗（1 秒內第 3 次），5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
  商品 1（熱點）HTTP {200=10000} │ p50   7.7  p95 2051.8  p99 2318.7  最慢 2834.6 ms │ MySQL    4 句/秒 │ Redis 失敗 200 次、跳開 69 次
  商品 3（一般）HTTP {200=10000} │ p50   3.9  p95 1200.2  p99 1436.8  最慢 1819.3 ms │ MySQL    4 句/秒 │ Redis 失敗 0 次、跳開 0 次
  商品 1（熱點）HTTP {200=10000} │ p50  10.4  p95 284.8  p99  385.3  最慢  487.4 ms │ MySQL    2 句/秒 │ Redis 失敗 0 次、跳開 0 次
```

這一次碰上了這一章最嚴重的 Redis 逾時：四輪各失敗 163～338 次（「跳開」的次數偏高，是因為跳開的那一刻還有很多指令在等，它們逾時之後又各自觸發了一次門檻）。

- **MySQL：每秒 4～15 句。** 第一次同樣是 Redis 出事，MySQL 收到每秒 896～1,272 句。降級快取守住了 MySQL。
- **延遲：沒有守住。** 前兩輪的 p50 到了 0.4～2 秒，四輪的 p99 是 2.3～10.5 秒，還有 194～260 個客戶端失敗。每一個商品詳情最多碰 Redis 3 次（每 IP 限流、商品快取、可售量），在跳開之前，每一次逾時都是 500 ms。

**這說明的是逾時的設定，而不是快取的設計。** 0.10.4 把 Redis 的指令逾時設成 500 ms，理由是「Lettuce 預設 60 秒，Redis 掛掉時每個請求卡 60 秒」。500 ms 比 60 秒好得多，但它是商品詳情 SLO（p99 50 ms）的 **10 倍** —— 只要 Redis 卡一下，商品頁的延遲就由逾時決定，而不是由 Redis 或 MySQL 決定。

為什麼這個環境的 Redis 會卡？我沒有追到根因。可以確定的是：Redis 容器本身的 CPU 很低（`docker stats` 0.2%），而這台機器在這段時間 load average 一直在 7～11，壓測的客戶端、Tomcat 的 200 條執行緒、Lettuce 共用的那一條連線的 I/O 執行緒全部在同一個 JVM 裡搶 CPU。比較可能的是客戶端這一側的排隊，不是 Redis 慢。**這需要第 08 章用獨立行程的壓測工具重量**，跟 4.8.3 的虛擬執行緒是同一個問題。

**這一節的結論：**

- **SLO（p99 50 ms）在這個環境下沒有穩定達成**：沒出事的時候 6 輪裡 2 輪達成，出事的時候差了兩個數量級。
- **快取命中時的路徑本身是快的**：p50 1.2～10 ms，MySQL 每秒個位數的指令。
- **Redis 的逾時要配合 SLO 重新設定**：讀快取是「可以失敗」的動作，它的逾時應該比 SLO 短（例如 50 ms），失敗就降級；寫入、閘門這種「不能隨便失敗」的動作才用長的逾時。Spring Data Redis 的逾時是全域的一個值，要分開設定需要兩個連線工廠 —— 練習五。

---

## 6.5 熱點庫存：Redis 當閘門，MySQL 仍然是最後一道防線

### 6.5.1 閘門

0.6.1 算過：搶購時每秒 200～600 個下單請求打同一個商品，**同一列 MySQL 理想上限 678 次/秒、交易稍微重一點就剩 138**。第 04 章的 4.8.1 量到：正確性守得住，p99 守不住。

0.6.1 的第 3 條結論是「熱點商品走 Redis 預扣 + MySQL 落帳」。這一章的落實方式，從一個問題開始：**2,000 個人搶 500 件，其中 1,500 個人注定搶不到 —— 他們需要碰 MySQL 嗎？**

不需要。所以 Redis 在這裡的角色是**閘門**：

```java
/** 全有或全無：每一個品項都夠才一起減。回傳 {0,0} = 成功；{-1,i} = 第 i 個 key 不存在；{-2,i} = 第 i 個不夠 */
static final RedisScript<List> GATE = RedisScript.of("""
        for i, k in ipairs(KEYS) do
          local v = redis.call('GET', k)
          if not v then return {-1, i} end
          if tonumber(v) < tonumber(ARGV[i]) then return {-2, i} end
        end
        for i, k in ipairs(KEYS) do redis.call('DECRBY', k, ARGV[i]) end
        return {0, 0}""", List.class);

/**
 * 下單前（交易外）：在 Redis 減掉這些熱點品項。不夠 → 409；Redis 不能用 → 503（0.6.3：熱點商品 × Redis 掛了 = 503，艙壁）。
 */
void gate(List<ReserveLine> lines) {
    List<ReserveLine> sorted = lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList();
    List<String> keys = sorted.stream().map(l -> key(l.productId())).toList();
    Object[] qty = sorted.stream().map(l -> String.valueOf(l.quantity())).toArray();
    for (int attempt = 0; attempt < 3; attempt++) {
        List<?> r = guard.call("hot-stock.gate", () -> redis.execute(GATE, keys, qty)).orElseThrow(HotStock::unavailable);
        int code = ((Number) r.get(0)).intValue(), i = ((Number) r.get(1)).intValue();
        if (code == 0) return;
        long productId = sorted.get(i - 1).productId();
        if (code == -2) throw new InsufficientStockException(productId);
        initialize(productId);                                          // -1：key 不存在 → 從 MySQL 建，再試一次
    }
    throw unavailable();
}
```

一個 Lua 腳本、一次往返，**先檢查全部、再一起減**：一張訂單有兩個熱點品項，第二個不夠時，第一個也不會被減（第 04 章的「全有或全無」，在 Redis 這一側重做一次）。Lua 在 Redis 裡是原子的 —— 檢查與減之間不會有別人插進來，這是 4.2.1 ⑥「判斷寫在會拿鎖的那一句裡」的 Redis 版。（`HotStock` 的全文在 6.11.1。）

（多 key 的 Lua 腳本在 Redis Cluster 上要求所有 key 在同一個 slot，否則 `CROSSSLOT` 錯誤；本專題的 Redis 是單一節點（0.10 的 compose）。真的要上 Cluster 時，key 要加 hash tag，或者一次只閘一個品項。）

**閘門過了之後，照常走第 04 章的下單交易** —— 包括 `inventory.reserve()` 那句條件式 UPDATE：

```sql
UPDATE inventory SET reserved = reserved + ? WHERE product_id = ? AND on_hand - reserved >= ?
```

閘門沒有取代它。**MySQL 的條件式 UPDATE 仍然是最後一道防線**，這一條原則決定了 `HotStock` 的每一個方法（6.5.3）。

**key 不存在**：剛被標成熱點（`POST /api/seller/products/{id}/hot`）、或 Redis 的資料丟了（0.3.3：可以接受）。第一個發現的請求從 MySQL 的可售量建立它：

```java
/**
 * key 不存在（剛標成熱點、或 Redis 的資料丟了）：從 MySQL 的可售量建立。
 * 鎖不是為了正確性（SET NX 只會有一個人成功），是為了「100 個請求同時發現 key 不存在」時，只有一個去讀 MySQL。
 */
void initialize(long productId) {
    Optional<DistributedLock.Handle> lock = guard.call("hot-stock.lock", () -> locks.tryLock("lock:" + key(productId), Duration.ofSeconds(2)).orElse(null));
    if (lock.isEmpty()) { sleep(20); return; }                          // 別人在建：等一下再試
    try {
        Integer available = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, productId);
        guard.run("hot-stock.init", () -> redis.opsForValue().setIfAbsent(key(productId), String.valueOf(available)));
    } finally {
        guard.run("hot-stock.unlock", () -> locks.unlock(lock.get()));
    }
}
```

這是這一章**唯一**用到 `DistributedLock` 的地方，而且它的註解先說了：**鎖不是為了正確性**。`setIfAbsent`（`SET NX`）保證只有一個值會被寫進去；鎖只是讓那一瞬間的 100 個請求裡只有一個去讀 MySQL —— 6.2.2 的擊穿，換了一個 key。

`HotStockFlowTest.gateThenSoldOut`（`HotStockFlowTest` 的全文在 6.11.1）：庫存 3 件，前 3 張訂單成立後 Redis 是 0、MySQL 可售 0；第 4 張 409 —— **而且那個買家的冪等鍵都沒有建**（`idempotency_keys` 裡 0 筆），證明它完全沒碰 MySQL。

### 6.5.2 每一條失敗的路徑

閘門放在 `PlaceOrderService.placeOrder()` 的最前面 —— **冪等鍵之前**。冪等鍵的 `claim()` 是一句 `INSERT`（4.5），放在閘門之後，搶不到的 1,500 人才真的一句 SQL 都不送：

```java
/**
 * 6.5.2 熱點商品的品項先過 Redis 的閘門 —— 在冪等鍵與下單交易「之前」：搶不到的人（2,000 人裡的 1,500 人）完全不碰 MySQL。
 * 閘門過了之後，任何一條失敗的路徑都要把減掉的加回去（6.2.4：漏了一條 = 少賣）。
 */
@Override
public PlacedOrder placeOrder(long buyerId, String idempotencyKey, List<OrderLine> lines) {
    validate(lines);
    Set<Long> hotIds = catalog.hotProducts(lines.stream().map(OrderLine::productId).toList());
    List<ReserveLine> hot = lines.stream().filter(l -> hotIds.contains(l.productId()))
            .map(l -> new ReserveLine(l.productId(), l.quantity())).toList();
    inventory.gateHot(hot);                                             // 不夠 → 409；Redis 不能用 → 503
    try {
        return placeGated(buyerId, idempotencyKey, lines, hot);
    } catch (InsufficientStockException e) {
        // Redis 說有、MySQL 說沒有：Redis 的數字偏高了（6.5.3）。那一個品項不加回去 —— 剛剛減掉的那一件本來就不存在
        inventory.returnHot(hot.stream().filter(l -> l.productId() != e.productId()).toList());
        throw e;
    } catch (RuntimeException e) {
        inventory.returnHot(hot);
        throw e;
    }
}
```

`placeGated()` 是第 04 章原本的 `placeOrder()` 的內容（冪等鍵、下單交易、撞號重試），只多了一件事：冪等鍵是 `Existing`（重送，訂單早就成立了）時，把這一次減掉的還回去 —— 那條路是**正常回傳**，不會進 `catch`：

```java
if (claim instanceof IdempotencyKeys.Existing e) {
    inventory.returnHot(hot);                                       // 重送：訂單早就成立了，這一次減掉的要還回去
    Order o = orders.findById(e.orderId()).orElseThrow();
    return new PlacedOrder(o.getId(), o.getOrderNo(), true);
}
```

**為什麼用一個 `try / catch` 包住全部？** 6.2.4 的 📌 列了七、八條失敗的路，而且以後還會更多。在每一條路上各自記得 `returnHot`，漏一條就是少賣；**在閘門的下一行就開始 `try`**，之後不管哪裡丟了例外，都會經過同一個 `catch`。

**`hotProducts()` 從哪裡知道哪些是熱點？** 商品快取（6.4）的 `hot` 欄位。這讓閘門之前的那一步也不碰 MySQL —— 代價是剛被標成熱點的商品，最多 1 秒內（快取更新之前）還會走一般的路徑。那條路一樣正確，只是慢。

`HotStockFlowTest` 的另外三個測試：價格錯了 → 409，Redis 不變（`wrongPriceGivesBack`）；同一個冪等鍵重送 → 200，Redis 只減了一次（`replayGivesBack`）；取消與補貨在 commit 之後加回 Redis（`cancelAndRestockAddBack`，6.6）。

### 6.5.3 偏高可以，偏低不行

`HotStock` 的類別註解只寫了一條原則：

```java
/**
 * 一條原則決定了這個類別的每一個方法：**MySQL 的條件式 UPDATE 仍然是最後一道防線（4.2.1 ⑥），Redis 只是擋在前面的閘門。**
 *  - Redis 的數字「偏高」：多放一些請求進 MySQL，MySQL 會擋下（409）—— 浪費，但不會超賣。
 *  - Redis 的數字「偏低」：該賣的沒賣出去（少賣）—— 這才是要避免、而且要被對帳抓到的方向。
 *
 * 所以：
 *  - 減（下單）在 MySQL 之前：Redis 先減，MySQL 失敗再加回來（6.2.4：漏了加回來 = 少賣）。
 *  - 加（取消、補貨）在 MySQL commit 之後：commit 失敗就不加。
 *  - 修正（對帳）只在「Redis 的值從頭到尾沒變」時才寫入（CAS，6.6）：只可能多算，不可能少算。
 */
```

Redis 與 MySQL 是兩個系統，沒有分散式交易（第 13 章才會碰到那個問題）。兩邊**一定**會在某些時刻不一致。能選的只有「不一致的時候，往哪一邊偏」。

- **超賣**是不可接受的：賣出了不存在的東西。
- **少賣**是不好的：該賣的沒賣出去，但沒有人收到不存在的東西。
- **多放一些請求進 MySQL** 只是浪費。

所以每一個寫 Redis 的地方，都排成「出錯的時候，Redis 偏高」的順序：

| 動作 | 順序 | 中間失敗了 | Redis 會 |
|---|---|---|---|
| 下單 | Redis 減 → MySQL 預留 | MySQL 失敗 → 加回來；加回來也失敗 | 偏低（少賣，等對帳） |
| 下單：MySQL 說沒貨 | 那一個品項**不**加回來 | —— | 買 1 件：修正了一次偏高；買 2 件以上：可能**偏低**（見下面的 ⚠️） |
| 取消、逾時、補貨 | MySQL commit → Redis 加 | commit 之後、加之前行程死掉 | 偏低（少賣，等對帳） |
| 對帳 | 讀 Redis → 讀 MySQL → CAS | 有人在中間動過 → CAS 失敗，不改 | 不變 |

表上兩個「偏低」都是「Redis 呼叫失敗」或「行程死掉」才會發生。它們不會超賣，而且會被對帳（6.6）在下一分鐘修正。（第二列在買 2 件以上時是例外，見下面的 ⚠️。）

第三列的「Redis 加」是怎麼接上的：`JdbcInventoryService` 的 `release()`（取消、付款逾時）、`restock()`、`restockBatch()` 三個方法的最後一行，都是 `hot.giveBackAfterCommit(...)`，**不分是不是熱點商品**。inventory 模組不知道哪些商品是熱點（`hot` 在 catalog 的 `products` 表上），所以它對每一個品項都登記「commit 之後加回」，由 Redis 那一側決定要不要加：

```java
/** 加回去，但只加「存在的」key：不存在代表 Redis 的資料丟了，下一次用到時會從 MySQL 重建（6.5.3） */
static final RedisScript<Long> RETURN = RedisScript.of("""
        for i, k in ipairs(KEYS) do
          if redis.call('EXISTS', k) == 1 then redis.call('INCRBY', k, ARGV[i]) end
        end
        return 1""", Long.class);
```

一般商品沒有 `stock:{id}`，`EXISTS` 是 0，什麼都不做。**不能寫成直接 `INCRBY`**：`INCRBY` 遇到不存在的 key 會從 0 開始加，一次取消就替一般商品造出一個 `stock:{id}` —— 對熱點商品則更糟：key 剛好丟了的時候，加回去的 1 會變成「可售 1」，下一次閘門看到 key 存在就不會從 MySQL 重建。

標成熱點的那一刻也一樣在 commit 之後：`InventoryApi.setHot()` 是 `MANDATORY`（在 `ProductService.setHot` 的交易裡），`hot = true` 時登記「commit 之後 `initialize()`」（commit 之後才讀 MySQL，讀到的是這次之後的可售量），`hot = false` 時登記「commit 之後刪掉 `stock:{id}`」。`HotStock`、`JdbcInventoryService` 的全文與 diff 在 6.11.1。

第二列是 `catch (InsufficientStockException e)` 那一段的理由：Redis 說有、MySQL 說沒有，代表 Redis 的數字**偏高**了（例如 6.2.5 V3 那 2 輪的「多算 1」）。剛剛減掉的那一件本來就不存在 —— 不加回去，Redis 就自己修正了一次。

> ⚠️ **這一段只在「那個品項買 1 件」時成立。** 閘門放行代表 Redis 的數字 R ≥ q（q 是這個品項的數量）；MySQL 說沒貨代表可售量 M < q。不加回去，Redis 剩 R − q。
> q = 1 時 M 只能是 0，R − 1 ≥ 0 = M，確實是修正了一次偏高。但 q > 1 時不一定：Redis 3、MySQL 可售 2、一張買 3 件的訂單 —— 閘門放行（3 ≥ 3）、MySQL 擋下（2 < 3）、不加回去，Redis 變成 0，MySQL 還有 2 件。**Redis 偏低，少賣 2 件**，要等對帳連續兩輪看到它（至少 1 分鐘）才修回來。
> 這是 6.5.3 自己那條原則的反例。這一章的測試與實驗沒有抓到它：`HotStockFlowTest`、G4、G6（E7）、G7、G8、驗收 Q8 的每一張熱點訂單都只買 1 件。程式碼這一章沒有改，列為已知問題；修法是練習九。

> 📌 **專題寫完之後的追記：問題跟著第 07 章搬了家，修在落帳那裡。**
> 第 07 章（7.6）把熱點商品的 MySQL 落帳移出了下單交易：下單時熱點品項只寫一筆還沒計入的預留列，上面這個 `catch` 對熱點品項再也不會觸發 —— 「MySQL 說不夠」變成落帳的 `settleHot()` 發現的事。
> 但它照樣把那一列設成 `RELEASED`、不加回 Redis，取消時的 `release()` 只找 `HELD`／`CONFIRMED` 的列，看不到它 —— **這個 ⚠️ 在第 09 章結束時的程式碼上仍然成立**，只是換了地方。
>
> 先寫測試把它重現出來（`HotSettlementTest`：`on_hand = 2`、`stock:{id}` 設 3、一張買 3 件，把事件交付完，斷言 Redis ≥ MySQL 的可售量），放在**還沒修**的程式碼上跑：
>
> ```
> 練習九 買 3 件、MySQL 可售 2：閘門之後 Redis 0 → 落帳失敗、CANCELLED 之後 Redis 0、MySQL 可售 2；{reserved=0, reservation=RELEASED, counted=0, ledger=0}
> [ERROR] Tests run: 6, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 18.85 s <<< FAILURE! -- in com.example.shop.ordering.internal.HotSettlementTest
> ```
>
> 修法是練習九的第二個選項 —— **只加回「真的存在」的那一部分**，不是一律加回 q：
>
> ```java
> // settleHot() 發現不夠的那一段，RELEASED 與 hot-settlement-failed 之後：
> Integer base = jdbc.queryForObject(HotStock.GATE_BASE_SQL, Integer.class, h.productId());   // 閘門該有的值，已經不含這一列
> int giveBack = base == null ? 0 : Math.max(0, Math.min(h.quantity(), base));
> if (giveBack > 0) returnToHotStock(orderId, List.of(new ReserveLine(h.productId(), giveBack)));   // 7.6.5 的 stock-returned，跟這個交易一起 commit
> ```
>
> - **為什麼不會偏低**：閘門放行代表 R ≥ q，減完剩 R − q；加回 min(q, base) 之後至少是 base —— 不需要讀 Redis。
> - **為什麼不一律加回 q**：第 07 章之後，Redis 偏高的代價不再只是多一個 409，而是「回了 201 之後取消」（7.6.3）。能不放出去的就不放。
> - **多讀的那一次 MySQL**：只發生在「不夠」這條很少走到的路上。`GATE_BASE_SQL` 是一致性讀，快照可能比 `FOR UPDATE` 舊：那段時間 commit 的取消、補貨各有自己的加回；那段時間成立、還沒計入的新訂單沒有被扣到 → 偏高，安全的方向。
> - `PlaceOrderService` 那個特別的 `catch (InsufficientStockException e)` 一併拿掉了：7.6 之後它只可能接到一般品項的例外，而那時熱點品項本來就全部加回。
>
> 修了之後：
>
> ```
> 練習九 買 3 件、MySQL 可售 2：閘門之後 Redis 0 → 落帳失敗、CANCELLED 之後 Redis 2、MySQL 可售 2；{reserved=0, reservation=RELEASED, counted=0, ledger=0}
> [INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.537 s -- in com.example.shop.ordering.internal.HotSettlementTest
> ```
>
> 同一次執行，7.6.3 的另外兩個「不夠」測試（`shortageBlocksShipThenCancels`、`EventFlowTest.shortageCancels`，每張都只買 1 件）照樣綠。H8 等大量走到這條路的實驗沒有重跑：它們的每一張熱點訂單都只買 1 件，q = 1 時 base 只會是 0 或負數，不會加回任何東西。
>
> 在**本章**的程式碼上（熱點品項還在下單交易裡預留），同樣的修法要放在上面那個 `catch` 裡：知道 MySQL 現在的可售量，才知道「多減的那一部分」是多少 —— 條件式 UPDATE 失敗只回 0 列，所以要多讀一次。

> 📌 **為什麼不在 Redis 減完就算成功，MySQL 之後再慢慢落帳？** 那會讓 Redis 變成「真相」—— 0.3.3 說 Redis 的資料丟了必須可以接受。Redis 重啟、資料丟了，就不知道誰買到了。
> 這一章的閘門讓 MySQL 繼續當真相，Redis 只是讓搶不到的人早一點知道。**「MySQL 之後再慢慢落帳」是第 07 章的事**，而那需要 Outbox 保證「Redis 減了、訂單成立了」這件事不會遺失。

### 6.5.4 搶購壓測：閘門讓誰變快了

第 04 章 4.8.1 的 E7 原封不動（2,000 個買家搶 500 件、打真的 `POST /api/orders`），只改一件事：商品是不是熱點。G6 把兩種**交錯**跑：

```java
@Test
void sameLoadHotVersusNot() throws Exception {
    E7FlashSaleLoadTest.flashSale(false, 0, true);                        // 暖機
    for (boolean hot : new boolean[]{false, true, false, true, false, true}) print(hot, E7FlashSaleLoadTest.flashSale(false, 200, hot));
    for (boolean hot : new boolean[]{false, true, false, true}) print(hot, E7FlashSaleLoadTest.flashSale(false, 0, hot));
}
```

（E7 多了一個 `hot` 參數；E7 自己的測試用 `hot = false`，第 04 章的結果不受影響。）

E7 要改的不只那個參數。G6 在 `ch06` 套件、E7 在 `ch04` 套件，所以類別、`Run` 與新的 `flashSale` 都要 `public`；第 04 章的 E7 建商品時 `hot` 寫死成 `TRUE`（那時候這個欄位還沒有任何作用），現在改成參數；清理時也要一併清掉 Redis（6.4.1 的 ⚠️）。對第 05 章的 diff：

```diff
-class E7FlashSaleLoadTest {
+public class E7FlashSaleLoadTest {

-    record Run(Map<Integer, Integer> statuses, double p50, double p95, double p99, double max, double seconds,
+    public record Run(Map<Integer, Integer> statuses, double p50, double p95, double p99, double max, double seconds,
                int reserved, long orders, long ledger, int maxActive, int maxPending, Map<Integer, Integer> retried) {}

+    /** 第 04 章：商品不是熱點（hot = false），下單走 MySQL 的條件式 UPDATE。第 06 章的 G6 用 hot = true 重跑 */
     static Run flashSale(boolean virtualThreads, int rps) throws Exception {
+        return flashSale(virtualThreads, rps, false);
+    }
+
+    public static Run flashSale(boolean virtualThreads, int rps, boolean hot) throws Exception {
         try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0",
             ……
             JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
+            redis = ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class);
             ……
-            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '限量商品', 1990.00, 'ON_SALE', TRUE)", HOT);
+            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '限量商品', 1990.00, 'ON_SALE', ?)", HOT, hot);
             ……
+    static org.springframework.data.redis.core.StringRedisTemplate redis;
+
     static void cleanup(JdbcTemplate jdbc) {
         ……
         jdbc.update("DELETE FROM products WHERE id = ?", HOT);
+        if (redis != null) com.example.shop.support.TestRedis.forgetProducts(redis, HOT);
     }
```

```bash
mvn test -Pexperiments -Dtest=G6HotFlashSaleTest
```

```
═══ 6.5.4 2,000 個買家搶 500 件；0.6.2 的負載：每秒 200 個請求、10 秒（開放式）═══
  一般       HTTP {201=497, 409=1489, 503=14} │ 12.78 秒 │ p50  3255  p95  4687  p99  5509  最慢  6782 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180
           └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {200=3, 409=11}
  熱點       HTTP {201=499, 409=1497, 503=4} │ 10.00 秒 │ p50    15  p95  3149  p99  3812  最慢  5104 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180
           └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=4}
  一般       HTTP {201=496, 409=1467, 503=37} │ 13.62 秒 │ p50  3203  p95  4974  p99  5772  最慢  7654 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 181
           └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {200=4, 409=33}
  熱點       HTTP {201=496, 409=1486, 503=18} │ 10.00 秒 │ p50    29  p95  3005  p99  3778  最慢  4620 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180
           └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=18}
  一般       HTTP {201=499, 409=1464, 503=37} │ 13.19 秒 │ p50  3683  p95  5416  p99  6179  最慢  7558 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 181
           └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {200=1, 409=36}
  熱點       HTTP {201=497, 409=1492, 503=11} │ 10.00 秒 │ p50    19  p95  3080  p99  3936  最慢  4965 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180
           └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {409=11}
═══ 6.5.4 同樣 2,000 個買家；200 個並行的客戶端（封閉式）═══
  一般       HTTP {201=500, 409=1500} │  8.38 秒 │ p50   634  p95  2255  p99  3126  最慢  4093 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180
  熱點       HTTP {201=486, 409=1454, 503=60} │  7.56 秒 │ p50    22  p95  3658  p99  4922  最慢  7402 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180
           └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {201=7, 409=53}
  一般       HTTP {201=499, 409=1498, 503=3} │  8.43 秒 │ p50   609  p95  2406  p99  3405  最慢  5243 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 181
           └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {200=1, 409=2}
  熱點       HTTP {201=493, 409=1500, 503=7} │  4.96 秒 │ p50    20  p95  2508  p99  3653  最慢  4696 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 180
           └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {200=4, 201=3}
```

**先看正確性：十輪全部對。** `reserved=500`、明細 500、`RESERVE` 帳 500，閘門沒有讓任何一件超賣或少賣。

**再看延遲：閘門讓「搶不到的人」快了兩個數量級。** 開放式負載的 p50：一般商品 3.2～3.7 **秒**，熱點商品 15～29 **毫秒**。2,000 人裡的 1,500 人在 Redis 就被擋下，連 MySQL 都沒碰。

**但 p99 沒有達成。** US-ORD-1b AC-2 要 p99 < 500 ms：

- 開放式：熱點 3.8～3.9 秒，一般 5.5～6.2 秒。快了約 35%，離 500 ms 還很遠。
- 封閉式：熱點 4.9、3.7 秒，一般 3.1、3.4 秒 —— **熱點沒有比較好**。

最後一欄說出了原因：**兩種都是「連線池同時使用 20、等待 180」**。搶到的那 500 人，每一個都還是要走完第 04 章的下單交易：冪等鍵、八張表、二十幾句 SQL —— 其中一句是那個熱點商品的 `UPDATE inventory`，**500 個交易排在同一列的鎖後面**。p99 落在那 500 個人身上，而閘門沒有改變他們的任何一件事。

**這一章前後跑了兩次 G6**（中間改了 `RedisGuard` 與降級快取）。第一次的開放式：一般 p99 8,194／6,901／3,876 ms、熱點 3,423／3,977／1,999 ms；封閉式：一般 3,588／3,294 ms、熱點 2,832／2,734 ms。形狀一樣：熱點的 p50 是毫秒級，p99 仍然是秒級。

**這一章有沒有讓一般商品變慢？** 下單的路徑上多了三次 Redis 呼叫（每 IP 限流、每位買家限流、熱點判斷），第一次 G6 的「一般」又特別慢（8.2 秒），值得確認。用 git worktree 取出第 05 章結束時的程式碼，跟這一章的程式碼**交錯**各跑 3 次（每次暖機一輪、量兩輪，開放式 200 rps）：

```
### ch05 第 1 次
  一般 HTTP {201=500, 409=1479, 503=21} │ p50 1181 p99 3765 ms │ 等待最多 181
  一般 HTTP {201=489, 409=1467, 503=44} │ p50 1917 p99 4663 ms │ 等待最多 181
### ch06 第 1 次
  一般 HTTP {201=498, 409=1495, 503=7} │ p50 2095 p99 4408 ms │ 等待最多 181
  一般 HTTP {201=498, 409=1496, 503=6} │ p50 697 p99 3143 ms │ 等待最多 181
### ch05 第 2 次
  一般 HTTP {201=499, 409=1433, 503=68} │ p50 1255 p99 5064 ms │ 等待最多 180
  一般 HTTP {201=473, 409=1336, 503=191} │ p50 5498 p99 8351 ms │ 等待最多 181
### ch06 第 2 次
  一般 HTTP {201=497, 409=1453, 503=50} │ p50 4195 p99 6573 ms │ 等待最多 181
  一般 HTTP {201=496, 409=1485, 503=19} │ p50 1669 p99 4190 ms │ 等待最多 180
### ch05 第 3 次
  一般 HTTP {201=467, 409=1342, 503=191} │ p50 7662 p99 10471 ms │ 等待最多 181
  一般 HTTP {201=491, 409=1269, 503=240} │ p50 3236 p99 6645 ms │ 等待最多 181
### ch06 第 3 次
  一般 HTTP {201=498, 409=1494, 503=8} │ p50 2566 p99 4957 ms │ 等待最多 181
  一般 HTTP {201=499, 409=1484, 503=17} │ p50 2026 p99 4284 ms │ 等待最多 181
```

第 05 章：p99 3,765／4,663／5,064／8,351／10,471／6,645 ms。這一章：4,408／3,143／6,573／4,190／4,957／4,284 ms。**沒有證據顯示這一章讓一般路徑變慢**；兩邊的波動都遠大於兩邊的差。

這組數字也說明了 6.2.0 的那段提醒：同一份第 05 章的程式碼，第 04 章時量的 p99（平台執行緒，4.8.1）是 366～659 ms，這一次是 3.7～10.5 秒，而且越跑越慢（第 3 次比第 1 次慢一倍）。我檢查過 MySQL 本身（InnoDB 的 History list length 是 0、沒有積壓的 purge），是整台機器在忙 —— 這也是為什麼這一章的每一個延遲比較都交錯執行。

> 📌 **閘門解決的是「搶不到的人」，不是「搶到的人」。** 0.6.1 的估算說熱點列的上限是 678（理想）～138（交易重一點）次/秒；第 04 章的下單交易比「理想」重得多。500 個人在 2.5 秒內到達（每秒 200 個），就已經超過那一列能處理的量。
> 要讓搶到的人也快，下單交易就不能再碰那一列 —— 第 07 章把熱點商品的 MySQL 預留移到交易之外，由消費者在幾秒內完成（0.6.4：「庫存帳落帳 | 最終一致 | 60 秒」）。

---

## 6.6 對帳：鎖，還是 CAS

0.6.4：「Redis 預扣庫存 ⇄ MySQL | 最終一致 | **對帳每小時，差異必須為 0**」。6.5.3 的表裡有兩種「偏低」，都要靠對帳修正。

```java
/**
 * 6.6 對帳（0.6.4：Redis 預扣 ⇄ MySQL，差異必須為 0）：每一個 stock:* 讀一次 Redis、讀一次 MySQL，不一樣就用 CAS 改成 MySQL 的值。
 * CAS 失敗 = 這段期間有人動過它（下單、取消、補貨）—— 不改，下一輪再看。
 * 同一組不一致要「連續兩輪」都看到才改：搶購進行中，一張訂單在「Redis 已減、MySQL 還沒 commit」的那幾毫秒裡，兩邊本來就不一樣。
 */
int reconcile() {
    // ……SCAN stock:* ……
    for (long id : ids) {
        Optional<String> before = guard.call("hot-stock.read", () -> redis.opsForValue().get(key(id)));
        if (before.isEmpty()) continue;
        Integer db = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, id);
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
```

```lua
-- CAS：只有在值還是 ARGV[1]（讀的時候看到的那個）才改成 ARGV[2]
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end
return 0
```

三個設計決定：

**① 用 CAS，不用鎖。** 6.2.5 量到：V2（鎖包住交易）與 V3（CAS）在那 40 輪裡都沒有少賣。最後選 V3，理由有兩個，都不是「V2 量到了錯」：

- **鎖要「每一個」寫入者都拿，才保護得了。** 補貨可以拿鎖（賣家的操作，一天幾次）。但取消與付款逾時也會把 Redis 加回去 —— 它們發生在 `OrderTransitionService` 的交易**裡面**（`inventory.release()` 是 `MANDATORY`，4.3.2）。要讓它們拿鎖，就要在一個持有訂單列鎖、預留列鎖的 MySQL 交易裡，去呼叫 Redis 拿另一把鎖 —— 違反第 04 章「**交易裡只有 SQL**」（4.3.3 的規則一）。Redis 卡住的時候（5.6.4 的 `pause`），每一個取消都會在交易裡等 500 ms。
- **而熱點下單本身永遠不可能拿鎖**：它是那每秒 200 個請求。

CAS 把問題倒過來：**寫入者都不拿鎖，對帳自己確認「我讀的時候到我寫的時候，沒有人動過」**。有人動過就放棄，下一輪再看。它的失敗模式只有「多算」—— 6.2.5 V3 那 2 輪的 `+1`：對帳讀 MySQL 時取消已經 commit、但取消的 `+1` 在 CAS 之後才加上去，於是加了兩次。偏高是安全的方向（6.5.3）。

**② 連續兩輪看到「同一組」不一致才修正。** 搶購進行中，每一張訂單都會有幾毫秒是「Redis 已經減了、MySQL 還沒 commit」—— 那一瞬間讀到的「不一致」是正常的。只看一輪就修，會在每一次搶購時把 Redis 改來改去（還會造成 6.2.5 那種多算）。兩輪看到的是**同一組**數字（`redis/mysql` 一模一樣），才代表它停在那裡了。`HotStockFlowTest.reconcileNeedsTwoRounds`：第一輪不改，第二輪改。

**③ 多台機器同時跑，不需要分散式鎖。** 4.7.2 的同一個理由：每一個 key 的修正都是 CAS，兩台同時改，只有一台會成功，另一台的 CAS 回傳 0。

排程每分鐘一次（`shop.inventory.hot-reconcile-interval: 1m`，`InventoryJobs`），比 0.6.4 要求的「每小時」頻繁得多 —— 因為 6.2.4 那種「少賣」的代價是以秒計的。修正的時候寫一行 `HOT_STOCK_DRIFT` 的 WARN，計數器 `shop.inventory.hot.drift` 加 1：**正常的系統，這個計數器應該永遠是 0**；它不是 0，就代表 6.5.3 的表上某一條路出事了（第 09 章接告警）。

這個間隔放在 `ShopProperties` 新增的 `Inventory` record 裡，同一個 record 還有一個 `jobsEnabled`（`shop.inventory.jobs-enabled`，預設 `true`）：`InventoryJobs` 上有 `@ConditionalOnProperty`，測試與實驗用 `--shop.inventory.jobs-enabled=false` 關掉這個排程，跟第 04 章的 `shop.order.jobs-enabled` 同一個理由 —— 背景的排程會改動實驗正在量的數字。`ShopProperties` 是 `ignoreUnknownFields = false`：record 裡少了 `jobsEnabled`，帶著這個參數啟動就會直接失敗。限流的三個數字在另一個新的 record `RateLimit`（`ordersPerBuyerPerMinute`、`requestsPerIpPerSecond`、`enabled`）。`ShopProperties` 的 diff 與 `InventoryJobs` 的全文在 6.11.1。

---

## 6.7 限流

### 6.7.1 什麼算「一次」

US-ORD-1 AC-8：「同一買家 1 分鐘內下單超過 10 次 → 第 11 次 429」。0.6.5 還有兩條：全域每 IP 每秒 50 次、登入每 IP 每分鐘 20 次（第 05 章已經用單機的版本做了，5.6.4）。

限流的演算法在 [10-redis/10](../10-redis/10-rate-limit-and-idempotency.md) 量過四種（固定窗、滑動窗的兩種、令牌桶）。這一章要決定的是另一件事：**「下單一次」是什麼？**

第 04 章給了兩個「同一張訂單、很多個請求」的情境：使用者連點送出鈕（驗收 Q3：同一個 `Idempotency-Key` 同時送 10 次），以及 4.8.2 的「503 + `Retry-After` + 用同一個鍵重送」。如果每一個請求都算一次：

```bash
mvn test -Pexperiments -Dtest=G9RateLimitTest
```

```
═══ 6.7.1 連點 10 次（同一個鍵），接著再下 5 張不同的訂單 ═══
  per-request  連點 10 次：放行 10 │ 接下來 5 張新訂單：[429, 429, 429, 429, 429]
  distinct     連點 10 次：放行 10 │ 接下來 5 張新訂單：[放行, 放行, 放行, 放行, 放行]
```

**per-request：連點一次，接下來 1 分鐘都不能下單。** 10 次連點用光了額度 —— 而它們只成立了一張訂單。更糟的是 4.8.2 的情境：伺服器回 503、要客戶端「用同一個鍵再問一次」，客戶端照做，結果被 429 —— **伺服器叫你重試，然後懲罰你重試**。

**distinct：只數「不同的冪等鍵」。** 連點的 10 次是同一個鍵，算一次。

```lua
-- ARGV：現在（毫秒）、窗（毫秒）、上限、member。同一個 member 已經在窗裡 → 放行、不加一
local now, window, limit = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZSCORE', KEYS[1], ARGV[4]) then return {1, 0} end
if redis.call('ZCARD', KEYS[1]) >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, tonumber(oldest[2]) + window - now}
end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return {1, 0}
```

（`RateLimiter` 的全文，包括每 IP 用的固定窗 `perRequest` 與 Redis 不能用時的單機版本，在 6.11.1。）

一個 ZSET，member 是冪等鍵、score 是時間：這是 10-redis/10 的「滑動窗（log 版）」，多了一條「已經在窗裡的 member 不算新的」。log 版的缺點是記憶體（每一次請求一筆），在這裡不是問題：一位買家一分鐘最多 10 筆。回傳的第二個數字是「最早那一筆滿 1 分鐘還要多久」，變成 `Retry-After`。

```java
// US-ORD-1 AC-8：每位買家每分鐘 10 張「不同的」訂單。同一個 Idempotency-Key 的重送不算新的一次（6.7.1）
RateLimiter.Decision d = limiter.distinct("orders:" + user.id(), key, limits.ordersPerBuyerPerMinute(), Duration.ofMinutes(1));
if (limits.enabled() && !d.allowed())
    throw new ShopException(ProblemType.RATE_LIMITED, "下單太頻繁，請稍後再試").with("retryAfter", d.retryAfterSeconds());
```

它在 Controller 裡（`OrderCommandController.place`），不在 `PlaceOrderService` 裡：限流是 API 的需求（「每位買家每分鐘」），不是下單這個業務動作的規則 —— `OrderFlowTest` 這種直接呼叫 Service 的測試一分鐘下幾十張單，也不該被擋。

`RateLimitTest`（全文在 6.11.1）把兩個情境寫成測試：同一位買家的第 11 張 → 429，`Retry-After` 在 50～60 秒之間，別的買家不受影響；同一個鍵重送 15 次都是 200，之後還能再下 9 張，第 11 張才 429。

> 📌 **這一條在需求裡沒有寫清楚。** AC-8 寫的是「下單超過 10 次」，沒有說「次」是請求還是訂單。0.4.5 寫 AC-8 的時候，冪等鍵（AC-1a）就在下面幾行，但兩條 AC 從來沒有被放在一起讀過。
> 這種「兩條各自正確的需求，放在一起才出問題」的情況，只有在實作時才看得到。**看到了，就回去改需求的文字**（0.4.5 的 AC-8 已經照這個說法改寫）。

### 6.7.2 每 IP 每秒 50 次：放在 Spring Security 之前

```java
/**
 * 6.7.2 0.6.5 的全域限流：每個 IP 每秒 50 次。放在 Spring Security 之前：沒有登入的洪水也要擋（登入 API 本身就是公開的）。
 * health 不限流：負載平衡器的探測如果被 429，攻擊者就能讓負載平衡器把每一台都摘掉（5.2.1 的同一種後果）。
 */
@Bean
FilterRegistrationBean<OncePerRequestFilter> perIpRateLimit(RateLimiter limiter, ShopProperties props, ProblemWriter problems) {
    // ……shouldNotFilter：/actuator/health 開頭的不限流……
    // ……doFilterInternal：limiter.perRequest("ip:" + req.getRemoteAddr(), limit, Duration.ofSeconds(1))，超過就寫 429 的 Problem Details……
    reg.setOrder(-200);                                                 // Spring Security 的 filter chain 是 -100
    return reg;
}
```

（`RateLimitFilter` 的全文在 6.11.1。）

三個重點：

- **順序 -200，比 Spring Security（-100）早。** 一個每秒送一萬個請求的攻擊者，不應該讓伺服器為每一個請求驗一次 JWT。
- **health 不限流。** 5.2.1 的教訓：負載平衡器看到的 health 只要不是 200，就把機器摘掉 —— 攻擊者只要從負載平衡器同一個網段的位址送請求，就能讓 health 被 429。
- **429 也是 Problem Details**（`ProblemWriter`，5.5.3）。

`RateLimitTest.perIpPerSecond`：同一個 IP 同時送 70 個 `/api/ping` → 50 個 200、20 個 429；70 個 health → 全部 200。

```
0.6.5：同一個 IP 70 次 /api/ping → {200=50, 429=20}；70 次 health → {200=70}
```

這個測試的第一版是**依序**送 70 個請求，結果是 70 個全部 200：MockMvc 依序送 70 個要將近 1 秒，跨過了兩個固定窗（每個窗 50 次，兩個窗加起來最多 100 次）。改成 70 個同時送出、從一秒的開頭開始，才量到 50 / 20。這正是 10-redis/10 的 10.2.3 量過的「固定窗的邊界放進 2 倍流量」—— 在每秒 50 次這種短窗上，它可以接受。

**測試環境的例外。** 所有測試的請求都從 127.0.0.1 來：驗收 Q2 的 100 個買家同時下單、E7 的 2,000 個買家 —— 每 IP 每秒 50 次會讓它們自己打到限流。所以 `src/test/resources/config/application.yml`（全文在 6.11.1）把這個上限拉高。放在 `config/` 底下是刻意的：Spring Boot 預設也會讀 `classpath:/config/application.yml`，而且它的優先順序比 `classpath:/application.yml` 高，所以這個檔案只**覆蓋**它寫到的那一個鍵，主設定照常載入；如果寫成 `src/test/resources/application.yml`，它在 classpath 上跟主程式的 `application.yml` 同名而且排在前面，整份主設定會被它蓋掉。`RateLimitTest` 再用 `@SpringBootTest(properties = "shop.rate-limit.requests-per-ip-per-second=50")` 改回需求的值來測它。這是 5.6.4「`X-Forwarded-For` 可不可信」的同一個問題的另一面：**「IP」這個概念，在測試環境、負載平衡器後面、正式環境裡各是什麼，要分開想。**

### 6.7.3 Redis 掛了：每台機器各算各的

0.6.3：「下單（一般商品）× Redis 掛了 = **201（限流改用單機記憶體）**」。`RateLimiter` 的每一個方法都是 `guard.call(Redis 的版本).orElseGet(單機的版本)`。

單機的代價，G9 的第二部分直接量：一位買家輪流打兩台機器，送 30 張不同的訂單：

```
═══ 6.7.3 一位買家輪流打兩台機器，送 30 張不同的訂單（上限 10）═══
  Redis 正常   放行 10 張（A 台 5、B 台 5）
  Redis 停掉   放行 20 張（A 台 10、B 台 10）
```

Redis 正常時，兩台共用 Redis 的計數，放行 10 張。**Redis 停掉時，每台各自數到 10，放行 20 張** —— N 台機器就是 N 倍。

這是 0.6.3 選擇的取捨：Redis 掛掉的那幾十秒裡，限流變寬鬆，但下單照常（201）。另一個選擇是 Redis 掛了就拒絕所有下單（fail-closed）—— 為了限流，讓所有人都不能下單。**限流是保護系統的手段，不是要保護的東西本身。**

---

## 6.8 熱門排行

### 6.8.1 每分鐘最多算一次，以及一個索引

US-RPT-2 AC-2：「`GET /api/products/trending`：近 24 小時**下單**量 Top 10；允許 **1 分鐘**延遲」。

做法：**不在每一張訂單成立時更新 Redis**，而是每分鐘最多用 SQL 算一次，結果在 Redis 存 1 分鐘：

```java
public Result top10() {
    if (!guard.available()) return new Result(List.of(), true);
    Optional<String> cached = guard.call("trending.get", () -> redis.opsForValue().get(KEY));
    if (cached.isPresent()) return new Result(parse(cached.get()), false);
    if (!guard.available()) return new Result(List.of(), true);         // 剛剛那一次 GET 失敗了
    List<Item> items = compute();
    guard.run("trending.put", () -> redis.opsForValue().set(KEY, write(items), FRESH_FOR));
    return new Result(items, false);
}
```

```xml
<!--
  US-RPT-2 AC-2：近 24 小時「下單」量（不是出貨量；取消的也算 —— 它代表的是熱度）。
  只列 ON_SALE 的商品：首頁不推一個已經下架的東西。
  o.created_at >= #{since}：V12 的 idx_orders_created（6.8.1）
-->
<select id="top" resultMap="row">
  SELECT i.product_id, p.name, SUM(i.quantity) AS quantity
    FROM orders o
    JOIN order_items i ON i.order_id = o.id
    JOIN products p ON p.id = i.product_id
   WHERE o.created_at >= #{since}
     AND p.status = 'ON_SALE'
   GROUP BY i.product_id, p.name
   ORDER BY quantity DESC, i.product_id
   LIMIT #{limit}
</select>
```

（`<resultMap>`、`TrendingMapper` 介面、`TrendingService` 與 `TrendingController` 的全文在 6.11.1。`TrendingMapper.Row` 是 record，XML 要用 `<constructor>` 把欄位對到建構子的參數，只貼上面那段 `<select>` 會因為找不到 `resultMap="row"` 而起不來。）

它在 `reporting` 模組：0.3.4 說 `reporting` 是唯一可以跨模組讀表的模組（3.7），它讀 `orders`、`order_items`、`products`，不寫任何一張。查詢用 MyBatis，跟 3.7 的日報表一樣。

**這句 SQL 每分鐘跑一次（每台機器），它要多快？** 種子資料有 10 萬張訂單，`orders` 上沒有 `created_at` 的單欄索引（第 02 章的索引都是從 API 反推的，2.7.1，那時候沒有「全站近 24 小時」這支 API）。V12 之前的樣子，用同一句加上 `IGNORE INDEX (idx_orders_created)` 重現（`EXPLAIN ANALYZE`，節錄 `orders` 那兩行）：

```
-> Filter: (o.created_at >= <cache>((@since)))  (cost=3557 rows=32919) (actual time=2.43..92.5 rows=1 loops=1)
    -> Covering index scan on o using idx_orders_buyer_created  (cost=3557 rows=98768) (actual time=1.21..75.4 rows=100005 loops=1)
```

MySQL 把整個 `idx_orders_buyer_created`（100,005 列）讀一遍，過濾完只剩 **1 列**。整句跑 5 次：92.9 ms（第一次，冷的）、27.7、28.7、32.6、32.4 ms。0.6.1 估 3 年有 550 萬張訂單，是現在的 55 倍 —— 照比例這句會變成 1.5 秒以上，每分鐘一次、每台機器一次。

所以這一章有一個 migration：

```sql
-- 6.8.1 US-RPT-2 AC-2：熱門排行的「近 24 小時」。沒有這個索引時，查詢要掃完整張 orders（10 萬張 → 3 年 550 萬張）
-- 一句 DDL、ALGORITHM=INPLACE, LOCK=NONE：建索引的期間仍然可以下單（2.2.2、2.9.6）
ALTER TABLE orders ADD INDEX idx_orders_created (created_at), ALGORITHM=INPLACE, LOCK=NONE;
```

檔名是 `V12__ordering_orders_created_index.sql`：`orders` 是 `ordering` 的表（`MigrationOwnershipTest`，2.9.4），索引為誰服務都一樣，**表的主人負責它的索引**。

```
-> Filter: (o.created_at >= <cache>((@since)))  (cost=0.606 rows=1) (actual time=0.0255..0.0282 rows=1 loops=1)
    -> Covering index range scan on o using idx_orders_created over ('2026-09-30 11:06:59.266' <= created_at)  (cost=0.606 rows=1) (actual time=0.0217..0.0243 rows=1 loops=1)
```

有索引，同一句跑 5 次：0.356、0.085、0.065、0.042、0.047 ms —— 只讀近 24 小時的那 1 列。（種子資料的「近 24 小時」只有 1 張訂單，因為種子是寫第 02 章那幾天產生的。正式環境每天 5,000 張，range scan 讀的就是那 5,000 列；沒有索引的那句，讀的永遠是**全部**。）

> ⚠️ **這個 migration 讓我自己掉進了第 02 章的坑。** 寫完這一章統一章節編號時，我改了 V12 裡的**一行註解**（`6.7.1` → `6.8.1`）。本機的 `shop` 已經套用過 V12，檔案內容一變，checksum 對不上，Flyway 的 validate 讓**每一個**應用程式都起不來 —— 背景正在重跑的 7 個實驗全部失敗：
> ```
> Caused by: org.flywaydb.core.api.exception.FlywayValidateException: Validate failed: Migrations have failed validation
> ```
> 已套用的 migration 不能改，連註解都不行（2.2.2 的坑一）。這一次 V12 還沒有提交給任何人，所以正確的做法是在本機把它撤掉（`DROP INDEX`、從 `flyway_schema_history` 刪掉那一列），讓 Flyway 用新的內容重新套用。**一旦 V12 被合併、被別人的資料庫套用過，就只能新增 V13。**

`TrendingTest`（全文在 6.11.1）：三張訂單各買 50 個 A、60 個 B（B 已下架）→ 排行第一是 A、150 個，B 不出現；把資料改掉再讀一次，讀到的還是同一份（1 分鐘內）。

### 6.8.2 為什麼不是每一張訂單 `ZINCRBY`

0.4.7 這一條最初寫的是「Redis ZSET」，想的是每一張訂單成立時 `ZINCRBY trending <數量> <商品>`。寫這一章時我把它改成了現在的「Redis 快取」，理由有三個：

1. **兩個寫入。** 「訂單成立」在 MySQL，「排行 +1」在 Redis —— 下單 commit 之後、`ZINCRBY` 之前行程死掉，那一筆就永遠不會被算進排行。要做對，需要第 07 章的 Outbox。
2. **24 小時是滑動窗。** ZSET 只會一直加，要「近 24 小時」得按小時分桶、每次查詢 `ZUNIONSTORE` 最近 24 個桶 —— 比一句 SQL 複雜得多。
3. **AC-2 允許 1 分鐘的延遲。** 每分鐘算一次，就已經滿足了。

ZSET 是「每秒幾千次更新、要求即時」的排行的工具。這一條需求兩個條件都沒有。**需求寫「用 ZSET」的時候，它在描述的其實是「排行要快」**—— 而一句有索引的 SQL 加 1 分鐘的快取，已經比需求快了。

---

## 6.9 Redis 掛了

0.6.3 的降級矩陣，「Redis 掛了」那一欄：

| 功能 | Redis 掛了 | 這一章的落實 |
|---|---|---|
| 瀏覽商品 | 200，走 DB | `ProductCache` → MySQL，本機 1 秒副本（6.9.2） |
| 下單（一般商品） | 201，限流改用單機記憶體 | `RateLimiter` 的 local fallback（6.7.3） |
| 下單（熱點商品） | **503** | `HotStock.gate` → `unavailable()`，`Retry-After: 5` |
| 熱門排行 | 200，空清單 | `TrendingService` → `X-Degraded: trending` |
| 登入 | 200，暫停失敗鎖定 | `LoginAttempts`（5.6.4） |

只有一格是「失敗」。這一節先回答那一格為什麼不是「降級」（6.9.1），再把整欄放進同一個流量裡跑 100 秒（6.9.2），最後是驗收 Q8（6.9.3）。

### 6.9.1 艙壁：為什麼熱點下單寧可 503

直覺的寫法是：Redis 不能用，就跳過閘門，直接走第 04 章的下單交易 —— 反正 MySQL 的條件式 UPDATE 本來就是最後一道防線（6.5.1），不會超賣。**正確性確實沒問題**；問題是其他人。

熱點商品的請求量是一般商品的幾十倍（0.6.1：每秒 200～600 個下單打同一個商品）。閘門在的時候，其中四分之三在 Redis 就被擋下（6.5.4）；閘門不在，**每一個**都要進 MySQL：拿一條連線、開交易、排在同一列的鎖後面。連線池只有 20 條，Tomcat 只有 200 條執行緒 —— **一般商品的下單跟它們搶的是同一批資源**。熱點商品的問題，會變成整個網站的問題。

船的艙壁就是為了這件事：一個艙進水，關上艙門，水不會淹到隔壁。**503 就是那道艙門**：熱點商品的買家這段時間買不到（用 `Retry-After: 5` 告訴他們等一下），其他所有人照常。

G7 把這件事量出來。熱點商品每秒 200 個下單（10 秒，500 件庫存）＋一般商品每秒 20 個下單（50 個不同的商品），三種情境：

```java
/**
 * 6.9.1 0.6.3「下單（熱點商品）× Redis 掛了 = 503」的理由：艙壁（bulkhead）。
 *   ① Redis 正常：熱點走閘門（6.5）
 *   ② Redis 停掉，熱點「退回 MySQL」：跳過閘門，直接走下單交易（第 04 章的路徑）
 *   ③ Redis 停掉，熱點回 503（本專題）
 * 在 Service 層呼叫：200 條共用的執行緒（= Tomcat 的 maxThreads）、同一個連線池 20 條。開放式負載：延遲從「預定送出的時間」算起（4.8.1），包含排隊。
 */
```

② 是用反射直接呼叫 `placeGated`（閘門之後的那一半，6.5.2），模擬「沒有閘門」的版本 —— 正式的程式碼裡沒有這條路。**量的是一般商品的延遲**：它跟 Redis 一點關係都沒有，它變慢，就是被熱點商品拖累的。

```bash
mvn test -Pexperiments -Dtest=G7BulkheadTest
```

```
═══ 6.9.1 熱點每秒 200 個下單 + 一般商品每秒 20 個下單，各 10 秒 ═══
  ① Redis 正常               熱點 {201=500, 409=1500}                │ 一般 {201=200}      p50    15  p95   609  p99  1002 ms
  ② Redis 停掉，熱點退回 MySQL    熱點 {201=500, 409=1500}                │ 一般 {201=200}      p50    29  p95  1582  p99  1981 ms
  ③ Redis 停掉，熱點回 503       熱點 {503=2000}                         │ 一般 {201=200}      p50    16  p95    44  p99   139 ms
  ① Redis 正常               熱點 {201=500, 409=1500}                │ 一般 {201=200}      p50    23  p95   692  p99  1058 ms
  ② Redis 停掉，熱點退回 MySQL    熱點 {201=500, 409=1500}                │ 一般 {201=200}      p50    48  p95  1410  p99  2196 ms
  ③ Redis 停掉，熱點回 503       熱點 {503=2000}                         │ 一般 {201=200}      p50    20  p95   829  p99  1117 ms
═══ 6.9.1 熱點每秒 600 個下單（0.6.1：200 個 × 失敗後平均再按 2 次）+ 一般商品每秒 20 個下單，各 10 秒 ═══
  ② Redis 停掉，熱點退回 MySQL    熱點 {201=500, 409=5484, 503（連線池）=16}   │ 一般 {201=200}      p50  4599  p95  6227  p99  7110 ms
  ③ Redis 停掉，熱點回 503       熱點 {503=6000}                         │ 一般 {201=200}      p50    14  p95    45  p99   213 ms
  ② Redis 停掉，熱點退回 MySQL    熱點 {201=500, 409=5498, 503（連線池）=2}    │ 一般 {201=200}      p50  2278  p95  3601  p99  4160 ms
  ③ Redis 停掉，熱點回 503       熱點 {503=6000}                         │ 一般 {201=200}      p50    15  p95  1036  p99  1358 ms
```

**每秒 200 個：差別不明顯。** 一般商品的 p99，② 是 1,981／2,196 ms，比 ① 的 1,002／1,058 慢一倍；③ 是 139／1,117 ms。但這個實驗跑過兩次，第一次（同一份程式碼，降級快取加上之前）的數字是：

| 情境（每秒 200 個） | 第一次 p99 | 第二次 p99 |
|---|---|---|
| ① Redis 正常 | 2,016／203 ms | 1,002／1,058 ms |
| ② 退回 MySQL | 1,703／109 ms | 1,981／2,196 ms |
| ③ 回 503 | 238／178 ms | 139／1,117 ms |

第一次的 ② 裡有一輪是 **109 ms** —— 全部 12 輪裡最快的一輪。每秒 200 個下單、500 件庫存，搶到的 500 人在前 2.5 秒就結束了，之後 1,500 個 409 都只是一句 `UPDATE ... WHERE on_hand - reserved >= ?` 不成立就回來；這個量，20 條連線勉強撐得住。**在這個量之下，我沒有辦法從數字上區分 ② 和 ③。**

**每秒 600 個：差別是兩個數量級。** 0.6.1 的估算是「200 個人 × 失敗之後平均再按 2 次」。② 的一般商品 p50 是 **4,599／2,278 ms**、p99 7,110／4,160 ms —— 一個跟搶購毫無關係的人，買一包濾掛咖啡要等 2～5 秒；熱點那一側也開始有連線池逾時的 503（16、2 個）。③ 的一般商品 p50 是 **14／15 ms**。第一次的數字形狀相同：② p50 2,586／6,868 ms（後者還有 7 個**一般商品**的 503）、③ p50 11／16 ms。

③ 第二輪的 p99 1,358 ms（第一次 780 ms）比 p50 高得多，6.2.0 提過的環境雜訊在這裡一樣存在 —— 但 p50 從秒級回到毫秒級，是這一節唯一需要的結論。

**② 的正確性一直都對**：四輪都正好 500 張成立，沒有超賣。艙壁保護的不是正確性，是**隔壁的人**。

> 📌 **「降級」要問：降級之後，壓力去了哪裡？** 商品詳情降級成「讀 MySQL」，是因為讀一個商品很便宜，而且 6.9.2 會用本機副本把量壓到 1.2 倍。熱點下單降級成「走 MySQL」，等於把每秒 600 個交易倒進一個只有 20 條連線的池子。**一個會把壓力轉嫁給所有人的降級，不是降級，是擴散。**

> ⚠️ **這個實驗的第一版自己先爆了。** 第一版每一個請求開一條執行緒（每秒 600 個 × 10 秒 = 6,000 條），量到的是 4,550 個 `Connection is not available, request timed out after 3005ms`，最後 `unable to create native thread`。那量的不是伺服器：Tomcat 最多 200 條執行緒，第 201 個請求在 accept queue 裡等，不會搶連線池。改成「200 條共用的執行緒，照時間表把請求放進佇列、延遲從預定時間算起」之後，才是伺服器實際的樣子 —— **壓測的模型錯了，量到的就是另一個系統**（4.8.1 的開放式／封閉式是同一件事）。

### 6.9.2 降級演練：100 秒、混合流量、Redis 掛 60 秒

驗收 Q8（6.9.3）是「一次一個請求，逐格檢查」。它回答「每一格的行為對不對」，回答不了「**在真實的流量下**，降級之後系統撐不撐得住」。G8 是 Q8 的完整版：

```java
/**
 * 6.9.2 降級演練（驗收 Q8 的完整版）：固定的混合流量跑 100 秒，第 20 秒把 Redis 停掉（stop 或 pause），第 80 秒恢復。
 * 流量（開放式）：商品詳情每秒 300 次（100 個商品）、熱門排行每秒 20 次、熱點商品下單每秒 20 次、一般商品下單每秒 5 次。
 * 每 5 秒一列：MySQL 每秒收到的指令數（Questions）、各 API 的狀態碼與 p99。
 */
```

兩種「掛了」都做（5.6.4 學到的）：

- **`docker stop`**：Redis 的行程不在了，連線被關掉。Lettuce 立刻知道，指令**馬上**失敗（日誌裡是 `Redis exception`）。
- **`docker pause`**：行程被凍結，TCP 連線還在。指令送出去之後沒有回應，**每一個都等滿 500 ms** 的逾時（`Redis command timed out`）。這是比較難的那一種：網路分割、Redis 卡在一個慢指令、主機被搶走 CPU，看起來都是這樣。

「MySQL 指令/秒」是 `SHOW GLOBAL STATUS LIKE 'Questions'` 每 5 秒的差 —— 它數的是所有用戶端送來的語句，包括 `SET autocommit`、`COMMIT` 這種交易控制。

```bash
mvn test -Pexperiments -Dtest=G8RedisOutageDrillTest
```

只跑其中一種、並看得到 `RedisGuard` 的跳開警告：

```bash
mvn test -Pexperiments -Dtest=G8RedisOutageDrillTest -Dg8.modes=pause -Dg8.log=WARN
```

**第一次：降級快取加上之前。** 6.4.5 第二次的程式碼：`RedisGuard` 已經是「1 秒內 3 次才跳開」，但 `ProductCache.get()` 在 Redis 不能用時直接讀 MySQL、不經過 single-flight：

```
═══ 6.8 降級演練：docker stop shop-redis-1（第 20～80 秒）═══
  秒      Redis │ MySQL 指令/秒 │ 詳情 p99（ms） 狀態                │ 排行 狀態        │ 熱點下單 狀態            │ 一般下單 狀態
    0-5   正常    │      595      │     34.4   {200=1839}             │ {200=100}        │ {201=100}                │ {201=24}
    5-10  正常    │      557      │    216.7   {200=1816}             │ {200=91}         │ {201=94}                 │ {201=23}
   10-15  正常    │      594      │     80.5   {200=1851}             │ {200=102}        │ {201=100}                │ {201=25}
   15-20  正常    │      559      │    152.7   {200=1849}             │ {200=91}         │ {201=93}                 │ {201=25}
   20-25  掛了    │     3180      │    128.5   {200=1843}             │ {200=102}        │ {201=3, 503=97}          │ {201=26}
   25-30  掛了    │     2991      │    630.0   {200=1819}             │ {200=91}         │ {503=103}                │ {201=21}
   30-35  掛了    │     3404      │    136.0   {200=1832}             │ {200=99}         │ {503=99}                 │ {201=25}
   35-40  掛了    │     3221      │     81.0   {200=1826}             │ {200=97}         │ {503=99}                 │ {201=24}
   40-45  掛了    │     2806      │   2454.1   {200=1803}             │ {200=87}         │ {503=88}                 │ {201=22}
   45-50  掛了    │     3506      │   1422.8   {200=1800}             │ {200=97}         │ {503=98}                 │ {201=26}
   50-55  掛了    │     3241      │     90.3   {200=1837}             │ {200=102}        │ {503=99}                 │ {201=26}
   55-60  掛了    │     3228      │     97.2   {200=1839}             │ {200=100}        │ {503=98}                 │ {201=25}
   60-65  掛了    │     3225      │     80.9   {200=1827}             │ {200=102}        │ {503=98}                 │ {201=26}
   65-70  掛了    │     3221      │     38.3   {200=1835}             │ {200=100}        │ {503=101}                │ {201=25}
   70-75  掛了    │     3215      │    186.9   {200=1827}             │ {200=100}        │ {503=99}                 │ {201=26}
   75-80  掛了    │     3257      │   1241.5   {200=1846}             │ {200=100}        │ {503=96}                 │ {201=28}
   80-85  正常    │     3188      │    698.4   {200=1819}             │ {200=94}         │ {503=91}                 │ {201=25}
   85-90  正常    │      964      │     69.2   {200=1836}             │ {200=100}        │ {201=85, 503=14}         │ {201=25}
   90-95  正常    │      629      │    170.6   {200=1837}             │ {200=100}        │ {201=110}                │ {201=24}
   95-100 正常    │      578      │     46.4   {200=1820}             │ {200=93}         │ {201=99}                 │ {201=21}
```

（標題的 `6.8` 是寫這一章途中的舊編號。）

**每一格的狀態碼都對**：詳情 200、排行 200、熱點 503、一般 201 —— 照 Q8 的標準，這是綠燈。

**但 MySQL 從每秒約 595 句變成約 3,225 句：5.4 倍。** `pause` 那一次一樣（583 → 3,213，5.5 倍）。每秒多出來的約 2,600 句，除以每秒 300 個商品詳情，**每一個詳情請求約 9 句** —— 它們全部繞過了快取。

這台機器的 MySQL 吃得下 3,200 句/秒，是因為這個演練的流量很小（每秒 345 個請求）。0.6.2 的商品詳情是**同一個商品每秒 1,000 次**；每次 9 句，就是每秒 9,000 句，而且查的是同一個商品 —— 跟熱點下單搶同一批連線。**Redis 掛了，MySQL 跟著被拖下水**，6.9.1 的艙壁白做了。

還有一件事：`stop` 的那一次，Redis 在第 80 秒就啟動了，**80～85 秒 MySQL 還是 3,188 句、熱點還是 503**，85～90 秒才慢慢回來。Redis 回來之後，Lettuce 要重新連上（`ConnectionWatchdog` 的重連間隔會隨著失敗次數拉長），`RedisGuard` 還要等它的 5 秒退避結束 —— **「Redis 恢復」與「系統恢復」之間有 5～10 秒的落差**。

**修法：降級的時候，一樣要有快取 —— 只是放在本機記憶體、而且很短。**

```java
/** Redis 不能用時的本機副本：1 秒（US-PRD-3 AC-3 的「1 秒內」）。只在降級時讀寫，Redis 恢復之後就不再用 */
static final long DEGRADED_TTL_MS = 1000;
record Local(Optional<Core> core, long expiresAt) {}
private final ConcurrentHashMap<Long, Local> degraded = new ConcurrentHashMap<>();
```

`get()` 裡的兩處（6.4.3 的程式碼）：

1. Redis 不能用 → 先看本機副本，還沒過期就直接回傳。
2. 副本沒有或過期 → **照常走 single-flight**，讀完之後放進本機副本（而不是寫 Redis）。

可售量（6.4.4）同樣有一份本機副本，5 秒。

**兩個數字都不是調出來的，是需求給的：** US-PRD-3 AC-3 說改價之後 **1 秒內**要看到新價格，AC-4 說可售量**允許 5 秒**的延遲。本機副本活得比這兩個數字短，就不會違反需求 —— 即使 Redis 不在。

**多台機器呢？** A 機器上改價，B 機器的本機副本不會知道。但它最多活 1 秒，1 秒之後 B 會去 MySQL 讀新的 —— 仍然在 AC-3 之內。改價的那一台（A）在 `putOrRemember()` 裡直接丟掉自己的副本（6.4.2）。

**為什麼不在 Redis 正常的時候也用本機快取（兩層快取）？** 可以，而且很多系統這樣做。代價是：Redis 正常時，改價也只能保證「1 秒內」，而不是「下一次讀」（6.4.1 的 `ProductCacheTest` 斷言的是後者）；而且兩層快取的失效要再想一次 6.2.1 的那三種競態。這一章只在降級時用它：**平常的路徑不變，降級的路徑多一層保護。**

**第二次：降級快取之後。** 同樣的演練，跑了很多次（理由在下面）。最後一次、程式碼全部定案之後的結果：

```
═══ 6.9.2 降級演練：docker stop shop-redis-1（第 20～80 秒）═══
  秒      Redis │ MySQL 指令/秒 │ 詳情 p99（ms） 狀態                │ 排行 狀態        │ 熱點下單 狀態            │ 一般下單 狀態
    0-5   正常    │      541      │    659.5   {200=1814}             │ {200=94}         │ {201=113}                │ {201=25}
    5-10  正常    │      677      │    478.0   {200=1821}             │ {200=100}        │ {201=105}                │ {201=26}
   10-15  正常    │      667      │    321.7   {200=1815}             │ {200=97}         │ {201=98}                 │ {201=26}
   15-20  正常    │      668      │    246.5   {200=1815}             │ {200=91}         │ {201=115}                │ {201=22}
   20-25  掛了    │      725      │    517.1   {200=1837}             │ {200=100}        │ {201=3, 503=96}          │ {201=23}
   25-30  掛了    │      701      │     42.4   {200=1836}             │ {200=100}        │ {503=98}                 │ {201=25}
   30-35  掛了    │      663      │    534.7   {200=1824}             │ {200=86}         │ {503=100}                │ {201=21}
   35-40  掛了    │      655      │     64.7   {200=1835}             │ {200=92}         │ {503=103}                │ {201=20}
   40-45  掛了    │      698      │     33.5   {200=1839}             │ {200=100}        │ {503=101}                │ {201=25}
   45-50  掛了    │      620      │   3915.9   {200=1777}             │ {200=81}         │ {503=98}                 │ {201=21}
   50-55  掛了    │      415      │   2982.1   {200=1738}             │ {200=70}         │ {503=99}                 │ {201=14}
   55-60  掛了    │      681      │    338.8   {200=1822}             │ {200=97}         │ {503=108}                │ {201=24}
   60-65  掛了    │      655      │   1127.2   {200=1837}             │ {200=122}        │ {503=92}                 │ {201=31}
   65-70  掛了    │      696      │     94.2   {200=1848}             │ {200=110}        │ {503=97}                 │ {201=25}
   70-75  掛了    │      691      │    182.1   {200=1846}             │ {200=99}         │ {503=102}                │ {201=25}
   75-80  掛了    │      671      │    402.3   {200=1841}             │ {200=93}         │ {503=98}                 │ {201=22}
   80-85  正常    │      687      │     34.3   {200=1839}             │ {200=98}         │ {503=99}                 │ {201=24}
   85-90  正常    │      289      │   3729.5   {0=48, 200=1682}       │ {0=3, 200=53}    │ {0=4, 503=92}            │ {201=16}
   90-95  正常    │      739      │    226.2   {200=1832}             │ {200=96}         │ {201=18, 503=83}         │ {201=25}
   95-100 正常    │      608      │    232.3   {200=1850}             │ {200=103}        │ {201=107}                │ {201=27}
═══ 6.9.2 降級演練：docker pause shop-redis-1（第 20～80 秒）═══
  秒      Redis │ MySQL 指令/秒 │ 詳情 p99（ms） 狀態                │ 排行 狀態        │ 熱點下單 狀態            │ 一般下單 狀態
    0-5   正常    │      555      │    166.6   {200=1818}             │ {200=96}         │ {201=102}                │ {201=21}
    5-10  正常    │      647      │    106.2   {200=1826}             │ {200=99}         │ {201=108}                │ {201=25}
   10-15  正常    │      600      │    178.1   {200=1831}             │ {200=96}         │ {201=100}                │ {201=25}
   15-20  正常    │      593      │    211.5   {200=1831}             │ {200=99}         │ {201=99}                 │ {201=24}
   20-25  掛了    │      689      │    568.5   {200=1832}             │ {200=98}         │ {201=5, 503=92}          │ {201=24}
   25-30  掛了    │      411      │   3352.3   {200=1624}             │ {200=88}         │ {503=92}                 │ {201=13}
   30-35  掛了    │      677      │    514.2   {200=1833}             │ {200=100}        │ {503=98}                 │ {201=25}
   35-40  掛了    │      710      │    529.1   {200=1833}             │ {200=100}        │ {503=100}                │ {201=25}
   40-45  掛了    │      656      │    358.3   {200=1833}             │ {200=96}         │ {503=92}                 │ {201=25}
   45-50  掛了    │      622      │   1311.8   {200=1816}             │ {200=99}         │ {503=99}                 │ {201=23}
   50-55  掛了    │      682      │    523.8   {200=1827}             │ {200=100}        │ {503=102}                │ {201=26}
   55-60  掛了    │      671      │    559.3   {200=1828}             │ {200=99}         │ {503=101}                │ {201=24}
   60-65  掛了    │      682      │    555.4   {200=1824}             │ {200=98}         │ {503=99}                 │ {201=24}
   65-70  掛了    │      724      │    547.8   {200=1827}             │ {200=97}         │ {503=115}                │ {201=31}
   70-75  掛了    │      690      │     43.4   {200=1829}             │ {200=99}         │ {503=101}                │ {201=25}
   75-80  掛了    │      686      │    529.1   {200=1833}             │ {200=100}        │ {503=99}                 │ {201=25}
   80-85  正常    │      620      │     23.7   {200=1825}             │ {200=100}        │ {201=74, 503=23}         │ {201=25}
   85-90  正常    │      599      │     63.7   {200=1826}             │ {200=98}         │ {201=101}                │ {201=24}
   90-95  正常    │      584      │     84.6   {200=1843}             │ {200=99}         │ {201=99}                 │ {201=24}
   95-100 正常    │      594      │     29.8   {200=1830}             │ {200=99}         │ {201=100}                │ {201=25}
```

**MySQL：中位數 668 → 681 句/秒（`stop`）、599 → 682 句/秒（`pause`），1.0～1.1 倍。** 第一次是 5.4～5.5 倍。

每一次跑的結果（只看「掛了」那 60 秒）：

| 第幾次 | 程式碼 | `stop`：MySQL 句/秒（中位數）| `pause`：MySQL 句/秒（中位數）| `pause` 的 500 |
|---|---|---|---|---|
| 1 | 沒有本機副本 | 595 → **3,225**（5.4 倍） | 583 → **3,213**（5.5 倍） | 0 |
| 2 | ＋ 本機副本 | 612 → 700 | 598 → 674 | **1**（詳情） |
| 3 | ＋ 拆開 `CompletionException`（6.4.3） | 608 → 695 | 592 → 688 | **2**（詳情） |
| 4～7 | 同上，只跑 `pause`，保留完整日誌 | —— | 603 → 681、563 → 693、580 → 691、597 → 685 | 0、**1**（詳情）、0、**1**（排行） |
| 8 | ＋ 修正 `RedisGuard`（見下面） | 626 → 691 | 601 → 683 | 0 |
| 9 | 同上（上面那兩張表） | 668 → 681 | 599 → 682 | 0 |

**第 8 次的延遲數字不能用**：跑到一半，這台筆電進入了閒置睡眠（`pmset -g log`：19:23:38 `Entering Sleep state due to 'Idle Sleep'`），之後反覆 DarkWake，一個 100 秒的實驗跑了 9,402 秒。表裡只留它的 MySQL 中位數與 500 的次數；第 9 次是用 `caffeinate -i` 防止睡眠重跑的。

#### 那幾個 500

第 2 次出現了 1 個商品詳情的 500。我那時用 `grep` 過濾日誌，只留了 `Caused by` 的行 —— 這個例外沒有 cause，被濾掉了。讀程式碼找到了 6.4.3 那條 `CompletionException` 的路，寫測試證明它存在、修掉。

**第 3 次，500 變成 2 個。** 6.4.3 那條路是真的，但不是這一次走的路。

第 4～7 次只跑 `pause`、保留完整的日誌。7 次裡有 2 次各出現 1 個 500，日誌是這樣：

```
ERROR 20751 --- [shop] [auto-1-exec-138] o.a.c.c.C.[.[.[/].[dispatcherServlet]    : Servlet.service() for servlet [dispatcherServlet] in context with path [] threw exception

java.lang.NullPointerException: Cannot invoke "java.lang.Long.longValue()" because the return value of "java.util.concurrent.ConcurrentLinkedDeque.peekFirst()" is null
	at com.example.shop.shared.redis.RedisGuard.tripped(RedisGuard.java:72) ~[classes/:na]
	at com.example.shop.shared.redis.RedisGuard.call(RedisGuard.java:58) ~[classes/:na]
	at com.example.shop.shared.ratelimit.RateLimiter.perRequest(RateLimiter.java:68) ~[classes/:na]
	at com.example.shop.shared.web.RateLimitFilter$1.doFilterInternal(RateLimitFilter.java:37) ~[classes/:na]
```

兩個 500（一個詳情、一個排行）都是這一個。**它在 `RedisGuard` 裡 —— 那個專門負責「Redis 失敗了，改走降級路徑」的類別：**

```java
private final ConcurrentLinkedDeque<Long> recentFailures = new ConcurrentLinkedDeque<>();

private void tripped(String what, DataAccessException e) {
    long now = clock.millis();
    failures.increment();
    recentFailures.addLast(now);
    while (!recentFailures.isEmpty() && recentFailures.peekFirst() < now - WINDOW_MS) recentFailures.pollFirst();   // ← 72 行
    if (recentFailures.size() < TRIP_AFTER) return;
    // ……
    recentFailures.clear();
    // ……
}
```

`ConcurrentLinkedDeque` 的每一個方法各自是執行緒安全的，**組合起來不是**：執行緒 A 看到 `isEmpty()` 是 `false`，在它呼叫 `peekFirst()` 之前，執行緒 B 達到門檻、`clear()` 了 —— A 的 `peekFirst()` 拿到 `null`，自動拆箱成 `long` 的那一刻 NPE。這是 4.2.1 ①「讀了再寫」的同一種錯：讀到的狀態，在動作的那一刻已經不是真的了 —— 只是換了一個資料結構。

為什麼只有 `pause` 會遇到？`stop` 的時候，指令是**一個一個**立刻失敗的，`tripped()` 幾乎不會同時有兩個人在跑。`pause` 的時候，在那 500 ms 裡送出的指令**會在同一個瞬間一起逾時** —— 幾十個執行緒同時進到 `tripped()`。

為什麼是 500 而不是 503？這個 NPE 從 `RedisGuard.call()` 丟出去（它只接 `DataAccessException`，6.3.3），穿過 `RateLimitFilter`。那個 filter 在 Spring Security 之前（6.7.2），也在 Spring MVC 之前 —— `GlobalExceptionHandler` 根本看不到它，回 500 的是 Servlet 容器的錯誤處理（日誌的 logger 是 Tomcat 的 `dispatcherServlet`）。**不是 503、也不是我們的 Problem Details。**

**`RedisGuardTest` 把它重現出來**（全文在 6.11.1）：64 條執行緒，用 `CyclicBarrier` 讓它們同時呼叫一個「一定逾時」的動作，2,000 輪（12.8 萬次呼叫），計算有多少例外從 `call()` 丟出去。修正前跑 3 次：

```
RedisGuard：2000 輪 × 64 條執行緒同時逾時 → 丟出去的例外 {NullPointerException=2}
RedisGuard：2000 輪 × 64 條執行緒同時逾時 → 丟出去的例外 {NullPointerException=3}
RedisGuard：2000 輪 × 64 條執行緒同時逾時 → 丟出去的例外 {NullPointerException=7}
```

修法是一把鎖：

```java
/**
 * synchronized：Redis 卡住（docker pause）時，幾百個指令會在同一個瞬間一起逾時、一起進來。
 * 第一版用 ConcurrentLinkedDeque、沒有鎖：「isEmpty() 不是空的 → peekFirst()」之間被別的執行緒 clear()，peekFirst() 回 null → NPE，
 * 而這個 NPE 從 call() 丟出去 —— 降級路徑自己變成了 500（6.9.2）。失敗的路徑不是熱路徑，一把鎖就夠了。
 */
private synchronized void tripped(String what, DataAccessException e) {
```

（`recentFailures` 改成普通的 `ArrayDeque`，只在 `tripped()` 裡讀寫。）

最終版還有兩個小改變。一是多了計數器 `shop.redis.trips`（跳開的次數，G10 印的「跳開」與 6.10.2 的告警都是它）。二是建構子從 package-private 改成 `public`：`ProductCacheTest`（在 `catalog.internal` 套件）的 `tripsOnlyAfterThreeFailures` 要自己 `new` 一個 `RedisGuard` 來測門檻，不能用 Spring 容器裡那一個 —— 那一個的 1 秒窗裡可能還留著別的測試造成的失敗。`RedisGuardTest` 也是自己 `new`，塞一個可以手動往前撥的 `Clock`。最終版 `RedisGuard` 的全文在 6.11.1。`tripped()` 只在 Redis **失敗**的時候執行，平常的路徑（`available()`、成功的 `call()`）完全不經過這把鎖。修正後跑 3 次：`{}`、`{}`、`{}`。

修正後的兩次演練（第 8、9 次）都是 0 個 500。**兩次 0 不能證明什麼**（修正前的 7 次裡也有 3 次是 0）—— 證明它的是 `RedisGuardTest`：同樣的 12.8 萬次同時逾時，修正前每次都有，修正後每次都沒有。

> ⚠️ **降級路徑是最少被執行的程式碼。** `RedisGuard` 在 Redis 正常的時候一行都不會跑到 `tripped()`。單元測試、整合測試、驗收 Q8（一次一個請求，見 6.9.3）全部是綠的 —— 因為它們都沒有讓幾十個執行緒**同時**失敗。這個 bug 要在「Redis 卡住 + 真實的併發」兩個條件同時成立時才會出現，**而那正是降級路徑存在的理由**。
> 這也是為什麼要做演練，而不只是逐格檢查：Q8 證明了「每一格的行為是對的」，只有 G8 能證明「它在流量下還是對的」。

#### 演練的其他觀察

**`pause` 的詳情 p99 大多落在 509～569 ms**（上面那一次「掛了」的 12 個區間裡有 8 個，第 3 次有 9 個）。這就是那 500 ms 的逾時：`RedisGuard` 每 5 秒重新試一次 Redis，在那一刻送出的請求都要等 500 ms、湊滿 3 次失敗才再次跳開；每秒 300 多個請求，那 500 ms 裡就有一百多個，超過每 5 秒 1,830 個的 1%。`stop` 的失敗是立刻的，沒有這個下限：第 2、3 次與上面那一次的 `stop`，最低的區間分別是 9.2、10.6、33.5 ms。**`pause` 的成本是逾時的長度乘以「每 5 秒一次」** —— 6.4.5 說逾時要配合 SLO 重新設定，這裡是同一件事的另一面。

**熱點下單：掛掉的那一刻就是 503，恢復的時候不是。**
- `stop`：Redis 在第 80 秒啟動，80～85 秒仍然全部 503，85～90 秒全部 503，90～95 秒才有 18 個 201。日誌顯示 Redis 啟動之後約 1 秒仍然是 `Redis exception`（還沒重新連上），約 7 秒時是一次逾時，之後才正常 —— 這一次，**系統比 Redis 晚了約 10 秒才恢復**。第 1～3 次是 5～7 秒（85～90 秒那一列已經有 59～85 個 201）。
- `pause`：TCP 連線一直在，`unpause` 之後下一次試就成功了，80～85 秒已經有 74 個 201。

這段時間的熱點買家拿到的是 503 + `Retry-After: 5`（4.8.2）—— 照著重試的客戶端會在幾秒後成功。

**一般下單：全程 201。** 每 IP 與每位買家的限流在 Redis 掛掉的這 60 秒裡改用單機記憶體（6.7.3）。

**有幾個 5 秒的區間，所有 API 一起變少、變慢**：`stop` 的 45～55 秒（詳情 1,777、1,738 個，p99 3.9、3.0 秒，MySQL 415 句），`pause` 的 25～30 秒（1,624 個，3.4 秒）。注意是**送出去的請求數**變少了（平常每 5 秒約 1,830 個）：請求是壓測程式的計時執行緒照時間表送的，那條執行緒不碰 Redis —— 它也慢了，代表停頓的是整個 JVM 或整台機器，不只是處理請求的那一側（壓測的客戶端跟伺服器在同一個 JVM 裡，6.4.5 提過；這台機器的 load average 一直在 7～11）。
它們每一次出現的位置都不一樣，但都落在 Redis 掛掉的期間或剛恢復的時候，所以**我不能說它們跟 Redis 無關**。原因我沒有找到。

**`stop` 的 85～90 秒有 48 個詳情的客戶端逾時**（`0`：10 秒沒有回應）、MySQL 掉到 289 句 —— 這一次演練裡唯一的 `0`。它發生在 Redis 恢復之後 5～10 秒，送出去的請求數一樣變少了（1,730 個），跟上一段那幾次停頓的形狀一樣，但更嚴重。日誌裡那段時間只有 `RedisGuard` 的跳開警告，沒有錯誤；第 1～3 次的 `stop` 在同一個位置都沒有發生。**我把它記在這裡，而不是解釋掉它** —— 第 08 章用獨立行程的壓測工具重跑這個演練時，要特別看這個位置。

### 6.9.3 驗收 Q8

```java
@Test
@DisplayName("Q8 Redis 停止 60 秒：商品詳情仍回 200（走 DB）、熱點商品下單回 503、一般下單回 201、readiness 維持 UP")
void q8_redisOutageDegrades() throws Exception {
    // ……建一個一般商品、一個熱點商品……
    System.out.println("Q8：Redis 正常       → " + degradationColumn(port, normal, hot, buyer, 0));

    docker("stop", "shop-redis-1");
    for (int i = 1; i <= 6; i++) {                                     // 停掉後第 5、15、25、35、45、55 秒
        // ……等到那個時間點……
        List<Check> c = degradationColumn(port, normal, hot, buyer, i);
        during.add(c);
        System.out.printf("Q8：停掉後第 %2d 秒   → %s%n", (System.nanoTime() - start) / 1_000_000_000L, c);
    }
    // ……等滿 60 秒……
    docker("start", "shop-redis-1");
    // ……等 /api/ping 回 200，再等 RedisGuard 的退避（5 秒）+ 1 秒……
    System.out.println("Q8：Redis 恢復之後   → " + degradationColumn(port, normal, hot, buyer, 9));

    for (List<Check> c : during) {
        assertThat(c.get(0).status()).as("商品詳情").isEqualTo(200);
        assertThat(c.get(1).status()).as("熱點商品詳情").isEqualTo(200);
        assertThat(c.get(2).status()).as("熱點下單").isEqualTo(503);
        assertThat(c.get(2).note()).contains("/problems/temporarily-unavailable");
        assertThat(c.get(3).status()).as("一般下單").isEqualTo(201);
        assertThat(c.get(4).note()).as("readiness").isEqualTo("UP");
        assertThat(c.get(5).status()).isEqualTo(200);
        assertThat(c.get(5).note()).isEqualTo("[] X-Degraded: trending");
        assertThat(c.get(6).status()).as("登入").isEqualTo(200);
    }
}
```

`degradationColumn()`、`docker()` 與這個測試的其他部分在 6.11.1 的 `CapstoneAcceptanceTest` diff 裡。`degradationColumn()` 就是 0.6.3 那張表的「Redis」欄，一格一個請求：商品詳情、熱點商品的詳情、熱點下單、一般下單、readiness、熱門排行、登入。

```
Q8：Redis 正常       → [商品詳情 200, 熱點商品詳情 200, 熱點下單 201, 一般下單 201, readiness 200（UP）, 熱門排行 200（[{"productId":1,"name":"濾掛咖啡 #1","quantity":2},{"productId":9900851,"name":"驗收商品 9900851","quantity":1},{"productId":9900852,"name":"驗收商品 9900852","quantity":1}] X-Degraded: —）, 登入 200]
Q8：停掉後第  5 秒   → [商品詳情 200, 熱點商品詳情 200, 熱點下單 503（/problems/temporarily-unavailable，Retry-After 5）, 一般下單 201, readiness 200（UP）, 熱門排行 200（[] X-Degraded: trending）, 登入 200]
Q8：停掉後第 15 秒   → [商品詳情 200, 熱點商品詳情 200, 熱點下單 503（/problems/temporarily-unavailable，Retry-After 5）, 一般下單 201, readiness 200（UP）, 熱門排行 200（[] X-Degraded: trending）, 登入 200]
Q8：停掉後第 25 秒   → [商品詳情 200, 熱點商品詳情 200, 熱點下單 503（/problems/temporarily-unavailable，Retry-After 5）, 一般下單 201, readiness 200（UP）, 熱門排行 200（[] X-Degraded: trending）, 登入 200]
Q8：停掉後第 35 秒   → [商品詳情 200, 熱點商品詳情 200, 熱點下單 503（/problems/temporarily-unavailable，Retry-After 5）, 一般下單 201, readiness 200（UP）, 熱門排行 200（[] X-Degraded: trending）, 登入 200]
Q8：停掉後第 45 秒   → [商品詳情 200, 熱點商品詳情 200, 熱點下單 503（/problems/temporarily-unavailable，Retry-After 5）, 一般下單 201, readiness 200（UP）, 熱門排行 200（[] X-Degraded: trending）, 登入 200]
Q8：停掉後第 55 秒   → [商品詳情 200, 熱點商品詳情 200, 熱點下單 503（/problems/temporarily-unavailable，Retry-After 5）, 一般下單 201, readiness 200（UP）, 熱門排行 200（[] X-Degraded: trending）, 登入 200]
Q8：Redis 恢復之後   → [商品詳情 200, 熱點商品詳情 200, 熱點下單 201, 一般下單 201, readiness 200（UP）, 熱門排行 200（[{"productId":9900851,"name":"驗收商品 9900851","quantity":8},{"productId":1,"name":"濾掛咖啡 #1","quantity":2},{"productId":9900852,"name":"驗收商品 9900852","quantity":2}] X-Degraded: —）, 登入 200]
```

0.6.3 那一欄，**逐格對上**：

| 功能 | 0.6.3 要求 | Q8 量到 |
|---|---|---|
| 商品詳情 | 200（走 MySQL） | 200（一般商品與熱點商品都是） |
| 下單（一般商品） | 201，限流改用單機記憶體 | 201 |
| 下單（熱點商品） | 503 `/problems/temporarily-unavailable` | 503，同一個 type，`Retry-After: 5` |
| 登入 | 200，暫停失敗鎖定 | 200（日誌：`LOGIN_LOCKOUT_DEGRADED`，5.6.4） |
| 熱門排行 | 200 空清單 ＋ `X-Degraded: trending` | `[]`、`X-Degraded: trending` |
| readiness | UP | UP |

**readiness 維持 UP 是這一欄最重要的一格**（0.6.3 的第三個解釋）。如果 Redis 的健康檢查被算進 readiness，Redis 一掛，負載平衡器會把**每一台**都摘掉，上面的每一格降級都沒有機會發生。0.10.6 把 readiness 設成 `include: readinessState,db` —— **只有** MySQL；這一章沒有改它，Q8 證明它在 Redis 真的掛掉時還是對的。

恢復之後的那一行：熱點下單回到 201。排行裡多出來的訂單（`9900851` 從 1 變成 8）是停掉期間那 6 張一般下單，加上恢復之後那一次檢查下的 1 張 —— **排行在 Redis 掛掉的時候「不顯示」，但訂單沒有少算**：排行是用 SQL 算的（6.8.1），Redis 只是那一分鐘的快取。

`CapstoneAcceptanceTest` 的 `Skipped` 從 5 變成 4：剩下 Q9～Q11（第 07 章）與 Q7（第 09 章）。

---

## 6.10 流程測試與追溯表

### 6.10.1 這一章新增的測試

| 測試 | 幾個 | 守什麼 |
|---|---|---|
| `ProductCacheTest` | 7 | PRD-3 AC-2、AC-3、PRD-4 AC-1；版本號擋住舊值；single-flight；寫入失敗的修復（6.4.2）；`RedisGuard` 的門檻；等待者拿到原本的例外（6.4.3） |
| `HotStockFlowTest` | 5 | 閘門與售完（不碰 MySQL）；價格不符、重送要加回去；取消與補貨在 commit 之後加回；對帳要連續兩輪 |
| `RateLimitTest` | 3 | ORD-1 AC-8 的 429 與 `Retry-After`；同一個冪等鍵的重送不算；每 IP 每秒 50 次、health 不限流 |
| `TrendingTest` | 1 | RPT-2 AC-2：近 24 小時、已下架的不上榜、1 分鐘內讀同一份 |
| `RedisGuardTest` | 1 | 64 條執行緒同時逾時 × 2,000 輪：沒有任何例外從 `call()` 丟出去（6.9.2） |
| 驗收 **Q8** | 1 | 從 `@Disabled` 變成綠燈 |

改了的既有測試：`SecurityRouteCoverageTest`（`PUBLIC` 加上 trending）、`IdorMatrixTest`（`MATRIX` 加上 `/hot`）、`OpenApiContractTest` 的快照（6.3.1）；`OrderFlowTest`、`AuditPlacementTest`、驗收 Q1～Q5 這些「用 SQL 建商品」的測試，清理時呼叫 `TestRedis.forgetProducts()`（6.4.1 的 ⚠️）；E7 多了 `hot` 參數（6.5.4）；驗收 Q4 的種子訂單把付款期限設在明天（6.11）。

`src/test/resources/config/application.yml` 把每 IP 每秒的上限調到 1,000,000：驗收 Q2 的 100 個買家、E7 的 2,000 個買家都從 `127.0.0.1` 來，0.6.5 的「每 IP 每秒 50 次」會讓它們打到自己的限流 —— 那不是它們要測的東西。限流本身由 `RateLimitTest` 用 `@SpringBootTest(properties = ...)` 改回 50 來測。

**實驗**（`-Pexperiments`，不在 `mvn clean test` 裡）：

| 實驗 | 節 | 量什麼 |
|---|---|---|
| G1 | 6.2.1、6.4.2 | 刪快取的三種時機 × 「快取剛好過期」 |
| G2 | 6.2.2 | 擊穿：naive、single-flight 1 台、3 台 |
| G3 | 6.2.3 | 快取命中時，外層交易送給 MySQL 的指令數 |
| G4 | 6.2.4 | 閘門之後的失敗路徑：naive 少賣 100 件 |
| G5 | 6.2.5 | 鎖在 commit 前放掉、鎖包住交易、CAS |
| G6、G6b | 6.5.4 | 搶購：熱點與一般交錯；連線池的診斷 |
| G7 | 6.9.1 | 艙壁：熱點退回 MySQL vs 503，量一般商品 |
| G8 | 6.9.2 | 降級演練：100 秒混合流量，`stop` 與 `pause` |
| G9 | 6.7 | 限流：兩種計數、兩台機器、Redis 掛了 |
| G10 | 6.4.5 | 商品詳情的 SLO：每秒 1,000 次同一個商品 |

### 6.10.2 追溯表更新

| 需求 | 驗證方式 | 狀態 |
|---|---|---|
| PRD-3 AC-2 | ✅ 03；快取之後仍成立：`ProductCacheTest.unpublishedIsGoneImmediately` | ✅ 03、06 |
| PRD-3 AC-3 | `ProductCacheTest.priceChangeVisibleImmediately`、`failedWriteAfterCommitIsRepaired`；G1（最終程式碼：200 次 0 次、過期瞬間 100 次 0 次） | ✅ 06 |
| PRD-3 AC-4 | `available:{id}` 的 TTL 5 秒、降級時本機 5 秒、熱點直接讀 `stock:{id}`（6.4.4）—— 由 TTL 保證，沒有專門的計時測試 | ✅ 06 |
| PRD-4 AC-1 | 搜尋不經過快取（第 03 章的 SQL）；詳情：`ProductCacheTest.unpublishedIsGoneImmediately` | ✅ 06 |
| RPT-2 AC-2 | `TrendingTest.top10`；V12 的索引（6.8.1：30 ms → 0.05 ms） | ✅ 06 |
| ORD-1 AC-8 | `RateLimitTest.eleventhOrderIs429`、`replaysDoNotCount`；G9 | ✅ 06 |
| ORD-1b AC-1 | 驗收 Q2（沒有變） | ✅ 04 |
| ORD-1b AC-2 | G6：十輪都恰好 500 筆、`RESERVE` 500 筆；**p99 < 500 ms 沒有達成**（熱點 3.7～4.9 秒） | 部分 → 07 |
| ORD-1b AC-3 | G6 每一輪 `reserved=500 明細=500 RESERVE 帳=500`；`InvariantReconciliationTest` | ✅ 04、06 |
| 0.6.1 第 3 條（熱點 Redis 預扣 + MySQL 落帳） | `HotStockFlowTest`；G4、G6 | ✅ 06（落帳移出交易在 07） |
| 0.6.1 第 4 條（擊穿） | `ProductCacheTest.singleFlight`；G2 | ✅ 06 |
| 0.6.2 商品詳情 p99 50 ms | G10：沒出事時 6 輪裡 2 輪達成；Redis 卡住時差兩個數量級 | ❌ 練習五、08 重量 |
| 0.6.2 熱點下單 p99 500 ms | 同 ORD-1b AC-2 | ❌ 07 |
| 0.6.3「Redis」那一欄 | 驗收 **Q8**（逐格）；G8（流量下）；G7（艙壁的理由） | ✅ 06 |
| 0.6.3 登入 × Redis 的告警 | 計數器 `shop.login.lockout.degraded`（5.6.4）、`shop.redis.trips`；告警在 09 | 部分 |
| 0.6.4 價格 1 秒、可售量 5 秒 | 同 PRD-3 AC-3、AC-4；降級時的本機副本也守著這兩個數字（6.9.2） | ✅ 06 |
| 0.6.4 熱門排行 60 秒 | `TrendingTest`（結果存 1 分鐘） | ✅ 06 |
| 0.6.4 Redis 預扣 ⇄ MySQL | `HotStockFlowTest.reconcileNeedsTwoRounds`；G4、G5；對帳每分鐘（比要求的每小時頻繁）；`shop.inventory.hot.drift` 的告警在 09 | ✅ 06 |
| 0.6.5 限流：全域每 IP 每秒 50 次 | `RateLimitTest.perIpPerSecond` | ✅ 06 |
| 0.6.5 限流：下單每使用者每分鐘 10 次 | 同 ORD-1 AC-8 | ✅ 06 |
| 0.6.5 限流：登入每 IP 每分鐘 20 次 | 仍是第 05 章的單機版（`IpLoginLimiter`）—— 這一章沒有改它 | 部分 → 練習八 |

**這一章讓 0.13.1 答應的「PRD-3、RPT-2、0.6.3、Q8」全部有了對應的測試。** 兩個 ❌ 都是 SLO：一個指向第 07 章（熱點的交易本身要變輕），一個指向第 08 章（用獨立行程的壓測工具重量）與練習五（讀快取的逾時要比 SLO 短）。

第 05 章的追溯表說「全站限流在 06」。全域的每 IP 每秒 50 次、下單的每位買家每分鐘 10 次做了；**登入的那一條沒有** —— 它在第 05 章已經是單機的版本，這一章沒有把它搬到 `RateLimiter` 上。我把它寫成練習八，而不是假裝它做完了。

---

## 6.11 本章完成後的專案

```
shop/
└── src/
    ├── main/
    │   ├── java/com/example/shop/
    │   │   ├── catalog/
    │   │   │   ├── CatalogApi.java                            ← + hotProducts()
    │   │   │   └── internal/
    │   │   │       ├── ProductCache.java                      ← 新增：版本號、single-flight、寫入失敗重試、降級副本（6.4、6.9.2）
    │   │   │       ├── ProductService.java                    ← detail() 沒有交易（6.2.3）；commit 之後寫快取；setHot
    │   │   │       ├── Product.java                           ← + markHot()、getVersion()
    │   │   │       ├── ProductDtos.java                       ← + HotRequest
    │   │   │       └── web/SellerProductController.java       ← + POST /api/seller/products/{id}/hot
    │   │   ├── inventory/
    │   │   │   ├── InventoryApi.java                          ← + gateHot、returnHot、setHot、availableForDisplay
    │   │   │   └── internal/
    │   │   │       ├── HotStock.java                          ← 新增：閘門、加回、建立、對帳（CAS、兩輪）（6.5、6.6）
    │   │   │       ├── InventoryJobs.java                     ← 新增：每分鐘對帳
    │   │   │       └── JdbcInventoryService.java              ← 取消、補貨 commit 之後加回 Redis；可售量的快取
    │   │   ├── ordering/internal/
    │   │   │   ├── PlaceOrderService.java                     ← 閘門 → placeGated；每一條失敗路徑都 returnHot（6.5.2）
    │   │   │   └── web/OrderCommandController.java            ← + 每位買家的限流（6.7.1）
    │   │   ├── reporting/internal/
    │   │   │   ├── TrendingMapper.java、TrendingService.java  ← 新增：SQL + 1 分鐘快取（6.8）
    │   │   │   └── web/TrendingController.java                ← 新增：GET /api/products/trending
    │   │   └── shared/
    │   │       ├── redis/{RedisGuard,DistributedLock}.java    ← 新增（6.3.3）
    │   │       ├── ratelimit/RateLimiter.java                 ← 新增：perRequest、distinct、單機退路（6.7）
    │   │       ├── web/RateLimitFilter.java                   ← 新增：每 IP 每秒，在 Spring Security 之前
    │   │       └── config/ShopProperties.java                 ← + Inventory、RateLimit
    │   └── resources/
    │       ├── db/migration/V12__ordering_orders_created_index.sql   ← 新增（6.8.1）
    │       └── mapper/reporting/TrendingMapper.xml            ← 新增
    └── test/
        ├── java/com/example/shop/
        │   ├── support/TestRedis.java                         ← 新增：forgetProducts()
        │   ├── acceptance/CapstoneAcceptanceTest.java         ← Q8 變綠；Q4 的付款期限
        │   ├── api/RateLimitTest.java                         ← 新增
        │   ├── api/{SecurityRouteCoverageTest,IdorMatrixTest}.java    ← + 兩支新的 API
        │   ├── catalog/internal/ProductCacheTest.java         ← 新增
        │   ├── catalog/internal/{G1CacheInvalidation,G2Stampede,G3CacheHitConnection}Test.java
        │   ├── inventory/internal/G5LockAroundTransactionTest.java
        │   ├── ordering/internal/HotStockFlowTest.java        ← 新增
        │   ├── ordering/internal/{OrderFlow,AuditPlacement}Test.java   ← 清理時 forgetProducts()
        │   ├── ordering/internal/{G4HotGateLeak,G7Bulkhead}Test.java
        │   ├── reporting/internal/TrendingTest.java           ← 新增
        │   ├── shared/redis/RedisGuardTest.java               ← 新增
        │   ├── ch04/E7FlashSaleLoadTest.java                  ← + hot 參數
        │   └── ch06/{G6HotFlashSale,G6bDiagnose,G8RedisOutageDrill,G9RateLimit,G10DetailSlo}Test.java
        └── resources/
            ├── config/application.yml                         ← 新增：測試環境的每 IP 上限
            └── openapi/shop-api.json                          ← + 2 個 operation
```

**只有一個 migration（V12），沒有新的模組依賴。** `reporting` 本來就可以讀 `orders`、`order_items`、`products`（0.3.4）；`catalog` → `inventory`（可售量）、`ordering` → `catalog`、`inventory`（下單）都是既有的依賴，這一章只是在上面多了幾個方法。`ModuleBoundaryTest` 的 6 條規則沒有改。

```bash
mvn clean test
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 4.843 s -- in com.example.shop.reporting.internal.TrendingTest
[INFO] Tests run: 7, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.715 s -- in com.example.shop.catalog.internal.ProductCacheTest
RedisGuard：2000 輪 × 64 條執行緒同時逾時 → 丟出去的例外 {}
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.130 s -- in com.example.shop.shared.redis.RedisGuardTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.002 s -- in com.example.shop.shared.audit.internal.JdbcAuditLogTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.037 s -- in com.example.shop.shared.error.ShopExceptionTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.973 s -- in com.example.shop.schema.SchemaConstraintTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.013 s -- in com.example.shop.schema.EntitySchemaDriftTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.700 s -- in com.example.shop.schema.InvariantReconciliationTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.069 s -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.006 s -- in com.example.shop.architecture.MigrationOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.001 s -- in com.example.shop.architecture.MapperXmlSafetyTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.031 s -- in com.example.shop.architecture.ConfigKeyGuardTest
Q3：先後送兩次 → 201 20261001-748990、200 20261001-748990；同鍵不同內容 → 422 /problems/idempotency-key-reused
Q3：同一個鍵同時送 10 次 → {201=1, 409（Retry-After: 1）=9}；出現過的訂單編號 [20261001-254497]；資料庫裡這位買家的訂單 2 張
Q1：HTTP 409 /problems/insufficient-stock，productId=9900102；殘留：{orders=0, items=0, reservations=0, reserved_a=0, ledger_a=1/0, idem_keys=0, cart=2}（庫存帳下單前 1/0）
Q1：補貨後用同一個鍵重送 → HTTP 201 20261001-153994；購物車剩 0 項
Q5：B 讀自己的 → 200；A 讀 B 的 → 404；A 讀不存在的 → 404；兩個 404 的 body 相同 = true；稽核 {actor_id=21182, actor_role=BUYER, target_type=ORDER, target_id=20261001-452764, ip=127.0.0.1}
Q6：從空資料庫套用 12 個 migration → 20 張表（含 flyway_schema_history）、CHECK 25 / 25、具名索引 32 / 32；validate 通過
Q8：Redis 正常       → [商品詳情 200, 熱點商品詳情 200, 熱點下單 201, 一般下單 201, readiness 200（UP）, 熱門排行 200（[…] X-Degraded: —）, 登入 200]
Q8：停掉後第  5 秒   → [商品詳情 200, 熱點商品詳情 200, 熱點下單 503（/problems/temporarily-unavailable，Retry-After 5）, 一般下單 201, readiness 200（UP）, 熱門排行 200（[] X-Degraded: trending）, 登入 200]
  ……（第 15～55 秒同上，6.9.3）……
Q8：Redis 恢復之後   → [商品詳情 200, 熱點商品詳情 200, 熱點下單 201, 一般下單 201, readiness 200（UP）, 熱門排行 200（[…] X-Degraded: —）, 登入 200]
Q4：size=5   → HTTP 200，5 張訂單、15 個明細，SQL 3 句
Q4：size=20  → HTTP 200，20 張訂單、60 個明細，SQL 3 句
Q4：size=45  → HTTP 200，45 張訂單、135 個明細，SQL 3 句
Q2：{201 =1, 409 /problems/insufficient-stock=99}；available = 0
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 4, Time elapsed: 116.6 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 61, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.045 s -- in com.example.shop.ordering.internal.OrderStateMachineTest
AUD：簽章錯誤 → 401；PAYMENT_SIGNATURE_INVALID 1 筆
AUD：賣家取消 PAID → 成功；ORDER_CANCELLED_BY_SELLER 1 筆
AUD：賣家取消 SHIPPED → 409；ORDER_CANCELLED_BY_SELLER 0 筆（訂單狀態 SHIPPED）
AUD：別人的訂單（查詢 + 取消）→ 404；ACCESS_DENIED 2 筆；不存在的訂單 → 404；ACCESS_DENIED 0 筆
AUD：金額不符 → 400；PAYMENT_AMOUNT_MISMATCH 1 筆
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.664 s -- in com.example.shop.ordering.internal.AuditPlacementTest
ORD-3 AC-3：取消 60 張、歷史 60 筆、RELEASE 60 筆；INV-2 {reserved=0, held=0}
ORD-3 AC-5：{CANCELLED/RELEASED/SUCCEEDED/1=50}；例外 0；INV-2 {reserved=0, held=0}
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.207 s -- in com.example.shop.ordering.internal.OrderRaceRegressionTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.431 s -- in com.example.shop.ordering.internal.HotStockFlowTest
[INFO] Tests run: 14, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.300 s -- in com.example.shop.ordering.internal.OrderFlowTest
[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.469 s -- in com.example.shop.api.OrderApiTest
[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 5.902 s -- in com.example.shop.api.RateLimitTest
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 4.685 s -- in com.example.shop.api.CatalogCartApiTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.805 s -- in com.example.shop.api.IdorMatrixTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.202 s -- in com.example.shop.api.JwtGuardTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.583 s -- in com.example.shop.api.SecurityRouteCoverageTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.888 s -- in com.example.shop.api.OpenApiContractTest
ACC-2 AC-2：密碼錯誤 p50 96.4 ms、帳號不存在 p50 97.6 ms、差 1.1 ms
[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 10.27 s -- in com.example.shop.api.AuthApiTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.925 s -- in com.example.shop.architecture.EntityTableOwnershipTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.499 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 160, Failures: 0, Errors: 0, Skipped: 4
[INFO] BUILD SUCCESS
[INFO] Total time:  02:51 min
```

> 📌 **專題寫完之後重跑：`mvn clean verify`。** 上面是寫這一章時跑的 `mvn clean test`。專題寫完之後（2026-10-12），在本章結束時的程式碼上、用一套全新的 compose（空的資料庫，Flyway 從第一個 migration 開始）重跑 `mvn clean verify`。（上面那段輸出，在參考實作的分支整理之後沒有在同一個版本上重跑過：測試數是照程式碼推算的。這一次是實跑。）第一次在空的資料庫上跑，驗收 Q8 紅了（「登入」那一格 401：Q8 用 2.8.3 種子資料的帳號 `buyer00001@example.com` 登入 —— 第 08 章 8.2.1 的事故一）；先跑 `mvn test -Pseed -Dtest=SeedData`（2.8.3）再跑，全綠。下面是第二次（load average 7.43 → 6.98）：

```bash
mvn clean verify
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 4.288 s -- in com.example.shop.reporting.internal.TrendingTest
[INFO] Tests run: 7, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.693 s -- in com.example.shop.catalog.internal.ProductCacheTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.948 s -- in com.example.shop.shared.redis.RedisGuardTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.001 s -- in com.example.shop.shared.audit.internal.JdbcAuditLogTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.015 s -- in com.example.shop.shared.error.ShopExceptionTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.797 s -- in com.example.shop.schema.SchemaConstraintTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.015 s -- in com.example.shop.schema.EntitySchemaDriftTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 4.926 s -- in com.example.shop.schema.InvariantReconciliationTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.058 s -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.008 s -- in com.example.shop.architecture.MigrationOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.002 s -- in com.example.shop.architecture.MapperXmlSafetyTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.030 s -- in com.example.shop.architecture.ConfigKeyGuardTest
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 4, Time elapsed: 148.3 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 61, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.033 s -- in com.example.shop.ordering.internal.OrderStateMachineTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.975 s -- in com.example.shop.ordering.internal.AuditPlacementTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.167 s -- in com.example.shop.ordering.internal.OrderRaceRegressionTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.188 s -- in com.example.shop.ordering.internal.HotStockFlowTest
[INFO] Tests run: 14, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 8.561 s -- in com.example.shop.ordering.internal.OrderFlowTest
[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.786 s -- in com.example.shop.api.OrderApiTest
[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.940 s -- in com.example.shop.api.RateLimitTest
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.559 s -- in com.example.shop.api.CatalogCartApiTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.544 s -- in com.example.shop.api.IdorMatrixTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.044 s -- in com.example.shop.api.JwtGuardTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.161 s -- in com.example.shop.api.SecurityRouteCoverageTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.336 s -- in com.example.shop.api.OpenApiContractTest
[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 6.250 s -- in com.example.shop.api.AuthApiTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.951 s -- in com.example.shop.architecture.EntityTableOwnershipTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.174 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 160, Failures: 0, Errors: 0, Skipped: 4
[INFO] ...
[INFO] Building jar: …/target/shop-0.0.1-SNAPSHOT.jar
[INFO] ...
[INFO] BUILD SUCCESS
[INFO] ...
[INFO] Total time:  03:14 min
```

160 個測試、跳過 4 個 —— 跟上面一樣。`verify` 比 `test` 多做的是打包 jar（`spring-boot:repackage`）；覆蓋率門檻要到第 08 章才有。

（Q8 那幾行的排行內容與中間五次檢查，完整的版本在 6.9.3。）

**160 個測試、`Skipped: 4`**（第 05 章是 143 個、5 個 skipped）。新增的 17 個：`ProductCacheTest` 7、`HotStockFlowTest` 5、`RateLimitTest` 3、`TrendingTest` 1、`RedisGuardTest` 1。Q8 本來就算在那 143 個裡，變成通過只讓 `Skipped` 少 1。

驗收測試 116.6 秒（第 05 章是 68 秒）：Q8 真的把 Redis 停 60 秒，再等它恢復。Q6 的輸出多了一個 migration（12 個）與一個具名索引（32 個，V12 的 `idx_orders_created`）。

> ⚠️ **這份輸出的前一次，`mvn clean test` 是紅的 —— 而且紅在一個第 02 章就寫好的測試。**
> ```
> [ERROR] com.example.shop.acceptance.CapstoneAcceptanceTest.q4_noNPlusOne -- Time elapsed: 14.27 s <<< ERROR!
> org.springframework.dao.DataIntegrityViolationException: PreparedStatementCallback; SQL [DELETE FROM orders WHERE buyer_id = ?]; Cannot delete or update a parent row: a foreign key constraint fails (`shop`.`order_status_history`, CONSTRAINT `fk_history_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`))
> ```
> Q4 用 SQL 插 45 張 `PENDING_PAYMENT` 的訂單測列表的 SQL 次數，付款期限寫的是 `NOW(3)` —— **一插進去就已經逾時了**。第 04 章的付款逾時排程（4.7）在這 14 秒裡剛好掃了一次，把 45 張全部取消、寫了 45 筆 `order_status_history`；測試結束時只刪 `order_items` 與 `orders`，外鍵擋住了。
> 這個測試從第 04 章加上排程開始就是這樣，只是排程的掃描以前都沒有落在這 14 秒裡。為什麼這一次落進去了，我沒有追（排程每 `timeout-scan-interval` 掃一次，第一次在啟動完成時；跟測試的插入是兩條執行緒在賽跑）。**這一章沒有製造這個 bug，只是讓它現形。**
> 兩個修正：付款期限改成 `NOW(3) + INTERVAL 1 DAY`（這些訂單只是用來被列出來的，不應該逾時）、清理時一併刪掉 `order_status_history`。庫存沒有被動到：取消會釋放預留，而這 45 張是用 SQL 直接插的，沒有任何 `inventory_reservations`。

`ModuleBoundaryTest`、`TableOwnershipTest`、`EntityTableOwnershipTest`、`MigrationOwnershipTest`（V12 是 `ordering` 的）、`ConfigKeyGuardTest`（`shop.inventory.*`、`shop.rate-limit.*` 都在 `ShopProperties` 裡）全綠。`InvariantReconciliationTest` 仍然是 0：這一章的每一個實驗都在自己的商品上跑，結束時清掉。

### 6.11.1 本章其餘檔案的完整內容

前面各節為了說清楚一件事，只列出每個檔案的重點片段。這一節補齊：**新增的檔案給全文，修改的檔案給對第 05 章的 diff**（`git diff` 的格式，`+` 是新增的行、`-` 是刪掉的行）。正文已經完整列出的不再重複：V12（6.8.1）、`PlaceOrderService`（6.5.2）、E7 的 diff（6.5.4）。

程式碼註解裡有三處節號是寫程式當時的編號，這裡已依定稿的課文更正：`G4HotGateLeakTest`、`G7BulkheadTest` 的「閘門（6.4）」→ 6.5，`ProductCache` 的「（6.9.2）」→ 6.4.3。參考實作的 `ch06` 分支裡仍是舊的寫法。

#### 主程式：catalog

**`src/main/java/com/example/shop/catalog/CatalogApi.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/main/java/com/example/shop/catalog/CatalogApi.java
+++ b/src/main/java/com/example/shop/catalog/CatalogApi.java
@@ -2,10 +2,17 @@ package com.example.shop.catalog;
 
 import java.util.Collection;
 import java.util.Map;
+import java.util.Set;
 
 /** 商品模組的對外入口（給 cart、ordering 用）。 */
 public interface CatalogApi {
 
     /** 一次取多個商品的快照（一句 SQL）。不存在的 id 不會出現在結果裡。 */
     Map<Long, ProductSnapshot> snapshots(Collection<Long> productIds);
+
+    /**
+     * 6.5 這些商品裡，哪些是熱點商品。讀商品快取（6.4），不保證跟 MySQL 同一瞬間：
+     * 剛被標成熱點的商品，最多 1 秒內還會走一般的路徑 —— 那條路徑一樣正確，只是比較慢。
+     */
+    Set<Long> hotProducts(Collection<Long> productIds);
 }
```

**`src/main/java/com/example/shop/catalog/internal/Product.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/main/java/com/example/shop/catalog/internal/Product.java
+++ b/src/main/java/com/example/shop/catalog/internal/Product.java
@@ -90,6 +90,14 @@ class Product {
 
     boolean ownedBy(long userId) { return sellerId == userId; }
 
+    /** 6.5 熱點商品（0.6.1 第 3 條：由賣家標記）。@return true = 這次真的改變了 */
+    boolean markHot(boolean hot, Instant now) {
+        if (this.hot == hot) return false;
+        this.hot = hot;
+        updatedAt = now;
+        return true;
+    }
+
     /** 金額一律兩位小數：299 與 299.00 在 BigDecimal 裡是兩個「不相等」的值（equals 會比 scale，第 04 章） */
     private static BigDecimal money(BigDecimal v) { return v.setScale(2, java.math.RoundingMode.UNNECESSARY); }
 
@@ -103,4 +111,6 @@ class Product {
     boolean isHot() { return hot; }
     Instant getCreatedAt() { return createdAt; }
     Instant getUpdatedAt() { return updatedAt; }
+    /** 6.4.1：快取用它判斷「哪一個值比較新」。flush 之後才是新的版本 */
+    int getVersion() { return version; }
 }
```

**`src/main/java/com/example/shop/catalog/internal/ProductCache.java`**（新增）

```java
package com.example.shop.catalog.internal;

import com.example.shop.catalog.ProductStatus;
import com.example.shop.shared.redis.RedisGuard;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.LongFunction;
import java.util.function.Supplier;

/**
 * 6.4 商品詳情的快取（US-PRD-3）。只放「不常變、變了要立刻生效」的部分；可售數量另外處理（AC-4 的 5 秒，6.4.4）。
 *
 * 三條規則：
 *  ① 寫入之後「在 commit 之後」把新值寫進快取，而不是在交易裡刪掉（6.2.1：刪在 commit 之前，讀的人會把舊值填回去）
 *  ② 寫進快取一律帶版本號（products.version），Lua 比較：舊的版本蓋不掉新的版本（6.2.1：讀的人慢了一步，一樣會把舊值填回去）
 *  ③ 同一台機器、同一個商品，同一時間只有一個請求去 MySQL 讀（6.2.2：快取過期的瞬間 200 個請求一起打進來）
 * Redis 不能用的時候（RedisGuard）：讀 MySQL（0.6.3：商品詳情 × Redis 掛了 = 200），但不是每一個請求都讀 ——
 * 結果在這台機器的記憶體裡放 1 秒（US-PRD-3 AC-3 允許的延遲），single-flight 照常（6.9.2：第一版每個請求都讀，MySQL 漲 5.5 倍）。
 */
@Component
class ProductCache {

    /** 商品頁需要的欄位（不含可售數量）。version 是 products.version */
    record Core(long id, long sellerId, String name, String description, BigDecimal price, long categoryId,
                ProductStatus status, boolean hot, int version) {}

    static final Duration TTL = Duration.ofMinutes(10);
    /** Redis 不能用的時候，本機記憶體裡的副本放多久（US-PRD-3 AC-3：改價後 1 秒內要讀到新價格） */
    static final long DEGRADED_TTL_MS = 1000;

    record Local(Optional<Core> core, long expiresAt) {}

    /** 只有在「沒有值」或「現有的版本比較舊」時才寫入。ARGV: 版本、JSON、TTL 毫秒 */
    static final RedisScript<Long> SET_IF_NEWER = RedisScript.of("""
            local cur = redis.call('GET', KEYS[1])
            if cur then
              local v = tonumber(string.match(cur, '"version":(%d+)'))
              if v and v >= tonumber(ARGV[1]) then return 0 end
            end
            redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
            return 1""", Long.class);

    private final StringRedisTemplate redis;
    private final RedisGuard guard;
    private final ObjectMapper json;
    private final ConcurrentHashMap<Long, CompletableFuture<Optional<Core>>> loading = new ConcurrentHashMap<>();
    /** 6.4.2：commit 之後寫入失敗的商品。Redis 恢復之後先刪掉它們的 key —— 在那之前，讀取都走 MySQL（RedisGuard），讀到的是新的 */
    private final Set<Long> pendingEvictions = ConcurrentHashMap.newKeySet();
    private final ConcurrentHashMap<Long, Local> degraded = new ConcurrentHashMap<>();

    ProductCache(StringRedisTemplate redis, RedisGuard guard, ObjectMapper json) {
        this.redis = redis;
        this.guard = guard;
        this.json = json;
        ScheduledExecutorService retry = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "product-cache-retry");
            t.setDaemon(true);
            return t;
        });
        retry.scheduleWithFixedDelay(this::retryEvictions, 200, 200, TimeUnit.MILLISECONDS);
    }

    void retryEvictions() {
        if (pendingEvictions.isEmpty() || !guard.available()) return;
        for (Long id : pendingEvictions)
            if (guard.run("product-cache.evict", () -> redis.delete(key(id)))) pendingEvictions.remove(id);
    }

    int pendingEvictions() { return pendingEvictions.size(); }

    static String key(long id) { return "product:v1:" + id; }

    /** 快取 → 沒有的話用 loader 從 MySQL 讀（同一個 id 同一時間只讀一次）→ 寫回快取 */
    Optional<Core> get(long id, LongFunction<Optional<Core>> loader) {
        Optional<String> cached = guard.call("product-cache.get", () -> redis.opsForValue().get(key(id)));
        if (cached.isPresent()) return Optional.of(parse(cached.get()));
        if (!guard.available()) {                                           // Redis 不能用：本機的 1 秒副本
            Local l = degraded.get(id);
            if (l != null && l.expiresAt() > System.currentTimeMillis()) return l.core();
        }
        CompletableFuture<Optional<Core>> mine = new CompletableFuture<>();
        CompletableFuture<Optional<Core>> running = loading.putIfAbsent(id, mine);
        if (running != null) {                                              // 別人正在讀：等它的結果
            try {
                return running.join();
            } catch (java.util.concurrent.CompletionException e) {          // join() 會包一層：拆開，讓 GlobalExceptionHandler 認得原本的例外（6.4.3）
                if (e.getCause() instanceof RuntimeException r) throw r;
                throw e;
            }
        }
        try {
            Optional<Core> loaded = loader.apply(id);
            if (guard.available()) loaded.ifPresent(this::put);             // 讀的人寫入失敗沒關係：下一個讀的人會再試
            else degraded.put(id, new Local(loaded, System.currentTimeMillis() + DEGRADED_TTL_MS));
            mine.complete(loaded);
            return loaded;
        } catch (RuntimeException e) {
            mine.completeExceptionally(e);
            throw e;
        } finally {
            loading.remove(id, mine);
        }
    }

    /** 寫入：版本比快取裡的新才寫。TTL 加一點亂數，避免同一批商品在同一秒一起過期。@return false = Redis 失敗或正在退避 */
    boolean put(Core c) {
        long ttl = TTL.toMillis() + ThreadLocalRandom.current().nextLong(60_000);
        return guard.run("product-cache.put", () -> redis.execute(SET_IF_NEWER, List.of(key(c.id())), String.valueOf(c.version()), write(c), String.valueOf(ttl)));
    }

    /** 商品改了、新值卻寫不進去：快取裡可能還是舊的那一份（讀的人先前填的）。記下來，Redis 一恢復就刪掉 */
    private void putOrRemember(Core c) {
        degraded.remove(c.id());                                            // 這台機器的降級副本：改了就丟掉
        if (!put(c)) pendingEvictions.add(c.id());
    }

    /**
     * 商品改了：登記在 commit 之後寫入新值（沒有交易就現在寫）。
     * 傳 Supplier 而不是值：@Version 在 flush 時才加 1，交易裡讀到的 version 還是舊的 —— 要在 commit 之後才組出 Core
     */
    void putAfterCommit(Supplier<Core> after) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) { putOrRemember(after.get()); return; }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() { putOrRemember(after.get()); }
        });
    }

    private Core parse(String s) {
        try { return json.readValue(s, Core.class); } catch (JsonProcessingException e) { throw new IllegalStateException(e); }
    }

    private String write(Core c) {
        try { return json.writeValueAsString(c); } catch (JsonProcessingException e) { throw new IllegalStateException(e); }
    }
}
```

**`src/main/java/com/example/shop/catalog/internal/ProductDtos.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/main/java/com/example/shop/catalog/internal/ProductDtos.java
+++ b/src/main/java/com/example/shop/catalog/internal/ProductDtos.java
@@ -46,6 +46,9 @@ public final class ProductDtos {
             Long categoryId) {}
 
     /** US-PRD-5：減少庫存不走這支 API（AC-2） */
+    /** 6.5 */
+    public record HotRequest(@NotNull(message = "hot 必填") Boolean hot) {}
+
     public record RestockRequest(
             @NotNull(message = "數量必填") @Min(value = 1, message = "補貨數量必須大於 0") @Max(value = 100_000, message = "一次最多補 100,000") Integer quantity,
             @Size(max = 80, message = "備註最多 80 字") String note) {}
```

**`src/main/java/com/example/shop/catalog/internal/ProductService.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/main/java/com/example/shop/catalog/internal/ProductService.java
+++ b/src/main/java/com/example/shop/catalog/internal/ProductService.java
@@ -16,7 +16,9 @@ import org.springframework.data.domain.Page;
 import org.springframework.data.domain.Pageable;
 import org.springframework.data.jpa.domain.Specification;
 import org.springframework.stereotype.Service;
+import org.springframework.transaction.PlatformTransactionManager;
 import org.springframework.transaction.annotation.Transactional;
+import org.springframework.transaction.support.TransactionTemplate;
 
 import java.math.BigDecimal;
 import java.time.Clock;
@@ -36,13 +38,34 @@ public class ProductService implements CatalogApi {
     private final InventoryApi inventory;
     private final Clock clock;
     private final AuditLog audit;
+    private final ProductCache cache;
+    private final TransactionTemplate readOnly;
 
-    ProductService(ProductRepository products, CategoryRepository categories, InventoryApi inventory, Clock clock, AuditLog audit) {
+    ProductService(ProductRepository products, CategoryRepository categories, InventoryApi inventory, Clock clock, AuditLog audit,
+                   ProductCache cache, PlatformTransactionManager tm) {
         this.products = products;
         this.categories = categories;
         this.inventory = inventory;
         this.clock = clock;
         this.audit = audit;
+        this.cache = cache;
+        this.readOnly = new TransactionTemplate(tm);
+        this.readOnly.setReadOnly(true);
+    }
+
+    /** 快取沒有的時候才從 MySQL 載入 —— 只有這一步需要交易（Category 是 LAZY，讀它的 id 要在 session 裡） */
+    private Optional<ProductCache.Core> load(long id) {
+        return readOnly.execute(s -> products.findById(id).map(ProductService::core));
+    }
+
+    static ProductCache.Core core(Product p) {
+        return new ProductCache.Core(p.getId(), p.getSellerId(), p.getName(), p.getDescription(), p.getPrice(), p.getCategory().getId(),
+                p.getStatus(), p.isHot(), p.getVersion());
+    }
+
+    /** 6.4.1 每一個改商品的方法最後都呼叫它：commit 之後，把新的值（新的版本）寫進快取 */
+    private void refreshCacheAfterCommit(Product p) {
+        cache.putAfterCommit(() -> core(p));
     }
 
     @Transactional
@@ -64,6 +87,7 @@ public class ProductService implements CatalogApi {
         if (p.getPrice().compareTo(before) != 0)                                      // 299 與 299.00 不算改價（3.5.2、4.2.4）
             audit.record(AuditEntry.of(AuditAction.PRODUCT_PRICE_CHANGED, sellerId, Role.SELLER.name(), "PRODUCT", productId,
                     Map.of("oldPrice", before, "newPrice", p.getPrice())));
+        refreshCacheAfterCommit(p);                                          // US-PRD-3 AC-3：改價後 1 秒內讀到新價格
         return detailOf(p, inventory.available(productId));
     }
 
@@ -71,6 +95,7 @@ public class ProductService implements CatalogApi {
     public ProductDetail publish(long sellerId, long productId) {
         Product p = owned(sellerId, productId);
         p.publish(clock.instant());
+        refreshCacheAfterCommit(p);
         return detailOf(p, inventory.available(productId));
     }
 
@@ -79,6 +104,21 @@ public class ProductService implements CatalogApi {
         Product p = owned(sellerId, productId);
         if (!p.unpublish(clock.instant()))
             throw new ShopException(ProblemType.INVALID_STATE, "草稿狀態的商品不能下架").with("productStatus", p.getStatus());
+        refreshCacheAfterCommit(p);                                          // US-PRD-4 AC-1：下架 1 秒內從詳情頁消失
+        return detailOf(p, inventory.available(productId));
+    }
+
+    /**
+     * 6.5 標記熱點商品（0.6.1 第 3 條：由賣家標記 hot=true）。熱點商品的下單先過 Redis 的閘門。
+     * 庫存的 Redis 副本由 inventory 在 commit 之後建立（InventoryApi.setHot）
+     */
+    @Transactional
+    public ProductDetail setHot(long sellerId, long productId, boolean hot) {
+        Product p = owned(sellerId, productId);
+        if (p.markHot(hot, clock.instant())) {
+            inventory.setHot(productId, hot);
+            refreshCacheAfterCommit(p);
+        }
         return detailOf(p, inventory.available(productId));
     }
 
@@ -99,13 +139,19 @@ public class ProductService implements CatalogApi {
         return PageResponse.of(page, p -> new ProductSummary(p.getId(), p.getName(), p.getPrice(), p.getCategory().getId()));
     }
 
-    /** US-PRD-3 AC-2：非 ON_SALE 的商品，只有賣家本人看得到；其他人一律 404（跟「不存在」長得一模一樣） */
-    @Transactional(readOnly = true)
+    /**
+     * US-PRD-3：商品詳情。先讀快取（6.4），沒有才讀 MySQL；可售量另外讀（熱點商品讀 Redis 的副本，其他商品快取 5 秒，AC-4）。
+     * AC-2：非 ON_SALE 的商品，只有賣家本人看得到；其他人一律 404（跟「不存在」長得一模一樣）
+     * 方法上「沒有」@Transactional（6.2.3）：有的話，快取命中時 MySQL 一樣收到 5 句（SET autocommit、commit……）、拿一條連線。
+     * 只有快取沒命中時的 load() 需要交易，它自己開。
+     */
     public ProductDetail detail(long productId, Long viewerId) {
-        Product p = products.findById(productId).orElseThrow(() -> ShopException.notFound("商品"));
-        boolean visible = p.getStatus() == ProductStatus.ON_SALE || (viewerId != null && p.ownedBy(viewerId));
+        ProductCache.Core c = cache.get(productId, this::load)
+                .orElseThrow(() -> ShopException.notFound("商品"));
+        boolean visible = c.status() == ProductStatus.ON_SALE || (viewerId != null && c.sellerId() == viewerId);
         if (!visible) throw ShopException.notFound("商品");
-        return detailOf(p, inventory.available(productId));
+        return new ProductDetail(c.id(), c.sellerId(), c.name(), c.description(), c.price(), c.categoryId(), c.status(),
+                inventory.availableForDisplay(productId, c.hot()));
     }
 
     @Transactional(readOnly = true)
@@ -116,6 +162,14 @@ public class ProductService implements CatalogApi {
                 p.getCategory().getId(), available.getOrDefault(p.getId(), 0), p.getUpdatedAt()));
     }
 
+    @Override
+    public Set<Long> hotProducts(Collection<Long> productIds) {
+        Set<Long> hot = new HashSet<>();
+        for (long id : productIds)
+            cache.get(id, this::load).filter(ProductCache.Core::hot).ifPresent(c -> hot.add(id));
+        return hot;
+    }
+
     @Override
     @Transactional(readOnly = true)
     public Map<Long, ProductSnapshot> snapshots(Collection<Long> productIds) {
```

**`src/main/java/com/example/shop/catalog/internal/web/SellerProductController.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/main/java/com/example/shop/catalog/internal/web/SellerProductController.java
+++ b/src/main/java/com/example/shop/catalog/internal/web/SellerProductController.java
@@ -46,6 +46,12 @@ class SellerProductController {
         return service.unpublish(user.require(Role.SELLER).id(), id);
     }
 
+    /** 6.5 標記（或取消）熱點商品：{"hot": true} */
+    @PostMapping("/{id}/hot")
+    ProductDetail hot(CurrentUser user, @PathVariable long id, @Valid @RequestBody HotRequest req) {
+        return service.setHot(user.require(Role.SELLER).id(), id, req.hot());
+    }
+
     @PostMapping("/{id}/restock")
     ProductDetail restock(CurrentUser user, @PathVariable long id, @Valid @RequestBody RestockRequest req) {
         return service.restock(user.require(Role.SELLER).id(), id, req);
```

#### 主程式：inventory

**`src/main/java/com/example/shop/inventory/InventoryApi.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/main/java/com/example/shop/inventory/InventoryApi.java
+++ b/src/main/java/com/example/shop/inventory/InventoryApi.java
@@ -40,6 +40,24 @@ public interface InventoryApi {
 
     record RestockLine(long productId, int quantity) {}
 
+    // ───────── 第 06 章：熱點商品（6.5）─────────
+
+    /**
+     * 熱點商品的閘門：在下單交易「之前」、交易「之外」呼叫，先在 Redis 減掉這些品項。
+     * 不夠 → InsufficientStockException（409，連 MySQL 都不碰）；Redis 不能用 → 503（0.6.3 的艙壁）。
+     * 之後的下單交易仍然會做 reserve() 的條件式 UPDATE —— MySQL 才是最後一道防線。
+     */
+    void gateHot(List<ReserveLine> hotLines);
+
+    /** 閘門過了、下單卻失敗了（價格變了、資料庫錯誤……）：把減掉的加回去（6.2.4） */
+    void returnHot(List<ReserveLine> hotLines);
+
+    /** 商品被標成（或取消）熱點：commit 之後建立（或刪除）Redis 的庫存副本。MANDATORY */
+    void setHot(long productId, boolean hot);
+
+    /** 商品頁顯示用的可售量（US-PRD-3 AC-4：最多 5 秒的延遲）。熱點商品讀 Redis 的副本；其他商品快取 5 秒 */
+    int availableForDisplay(long productId, boolean hot);
+
     /** 可售庫存 = onHand - reserved。 */
     int available(long productId);
 
```

**`src/main/java/com/example/shop/inventory/internal/HotStock.java`**（新增）

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
        List<ReserveLine> sorted = lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList();
        List<String> keys = sorted.stream().map(l -> key(l.productId())).toList();
        Object[] qty = sorted.stream().map(l -> String.valueOf(l.quantity())).toArray();
        for (int attempt = 0; attempt < 3; attempt++) {
            List<?> r = guard.call("hot-stock.gate", () -> redis.execute(GATE, keys, qty)).orElseThrow(HotStock::unavailable);
            int code = ((Number) r.get(0)).intValue(), i = ((Number) r.get(1)).intValue();
            if (code == 0) return;
            long productId = sorted.get(i - 1).productId();
            if (code == -2) throw new InsufficientStockException(productId);
            initialize(productId);                                          // -1：key 不存在 → 從 MySQL 建，再試一次
        }
        throw unavailable();
    }

    /** 下單失敗（價格變了、商品下架、資料庫錯誤……）：把減掉的加回去。失敗就只能等對帳（少賣，6.2.4） */
    void giveBack(List<ReserveLine> lines) {
        if (lines.isEmpty()) return;
        List<String> keys = lines.stream().map(l -> key(l.productId())).toList();
        Object[] qty = lines.stream().map(l -> String.valueOf(l.quantity())).toArray();
        if (!guard.run("hot-stock.give-back", () -> redis.execute(RETURN, keys, qty)))
            log.warn("HOT_STOCK_GIVE_BACK_FAILED {}（等對帳修正：在那之前這些數量賣不出去）", lines);
    }

    /** 取消、補貨：MySQL commit 之後才加。沒有交易 → 現在加 */
    void giveBackAfterCommit(List<ReserveLine> lines) {
        if (lines.isEmpty()) return;
        if (!TransactionSynchronizationManager.isSynchronizationActive()) { giveBack(lines); return; }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() { giveBack(lines); }
        });
    }

    /**
     * key 不存在（剛標成熱點、或 Redis 的資料丟了）：從 MySQL 的可售量建立。
     * 鎖不是為了正確性（SET NX 只會有一個人成功），是為了「100 個請求同時發現 key 不存在」時，只有一個去讀 MySQL。
     */
    void initialize(long productId) {
        Optional<DistributedLock.Handle> lock = guard.call("hot-stock.lock", () -> locks.tryLock("lock:" + key(productId), Duration.ofSeconds(2)).orElse(null));
        if (lock.isEmpty()) { sleep(20); return; }                          // 別人在建：等一下再試
        try {
            Integer available = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, productId);
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
            Integer db = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, id);
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

**`src/main/java/com/example/shop/inventory/internal/InventoryJobs.java`**（新增）

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
    private final ShopProperties props;

    InventoryJobs(HotStock hot, ShopProperties props) {
        this.hot = hot;
        this.props = props;
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(() -> {
            int fixed = hot.reconcile();
            if (fixed > 0) log.warn("熱點庫存對帳：修正了 {} 個商品", fixed);
        }, props.inventory().hotReconcileInterval());
    }
}
```

**`src/main/java/com/example/shop/inventory/internal/JdbcInventoryService.java`**（修改：`setHot`、`availableForDisplay`，以及 `release()`、`restock()`、`restockBatch()` 最後一行的 `giveBackAfterCommit`；對第 05 章的 diff）

```diff
--- a/src/main/java/com/example/shop/inventory/internal/JdbcInventoryService.java
+++ b/src/main/java/com/example/shop/inventory/internal/JdbcInventoryService.java
@@ -3,12 +3,18 @@ package com.example.shop.inventory.internal;
 import com.example.shop.inventory.InsufficientStockException;
 import com.example.shop.inventory.InventoryApi;
 import com.example.shop.inventory.ReserveLine;
+import com.example.shop.shared.redis.RedisGuard;
+import org.springframework.data.redis.core.StringRedisTemplate;
 import org.springframework.jdbc.core.JdbcTemplate;
+import org.springframework.transaction.support.TransactionSynchronization;
+import org.springframework.transaction.support.TransactionSynchronizationManager;
 import org.springframework.stereotype.Service;
 import org.springframework.transaction.annotation.Propagation;
 import org.springframework.transaction.annotation.Transactional;
 
+import java.time.Duration;
 import java.util.ArrayList;
+import java.util.Optional;
 import java.util.Collection;
 import java.util.Comparator;
 import java.util.HashMap;
@@ -18,10 +24,65 @@ import java.util.Map;
 @Service
 class JdbcInventoryService implements InventoryApi {
 
+    /** US-PRD-3 AC-4：一般商品的可售量顯示，允許 5 秒的延遲 */
+    static final Duration DISPLAY_TTL = Duration.ofSeconds(5);
+
     private final JdbcTemplate jdbc;
+    private final HotStock hot;
+    private final StringRedisTemplate redis;
+    private final RedisGuard guard;
+    /** 6.9.2 Redis 不能用的時候，可售量在本機記憶體裡放 5 秒（AC-4 允許的延遲）：不然每一次看商品頁都是一句 MySQL */
+    private final java.util.concurrent.ConcurrentHashMap<Long, long[]> degradedAvailable = new java.util.concurrent.ConcurrentHashMap<>();
 
-    JdbcInventoryService(JdbcTemplate jdbc) {
+    JdbcInventoryService(JdbcTemplate jdbc, HotStock hot, StringRedisTemplate redis, RedisGuard guard) {
         this.jdbc = jdbc;
+        this.hot = hot;
+        this.redis = redis;
+        this.guard = guard;
+    }
+
+    @Override
+    public void gateHot(List<ReserveLine> hotLines) {
+        if (!hotLines.isEmpty()) hot.gate(hotLines);
+    }
+
+    @Override
+    public void returnHot(List<ReserveLine> hotLines) {
+        hot.giveBack(hotLines);
+    }
+
+    @Override
+    @Transactional(propagation = Propagation.MANDATORY)
+    public void setHot(long productId, boolean isHot) {
+        if (isHot) {
+            if (!TransactionSynchronizationManager.isSynchronizationActive()) { hot.initialize(productId); return; }
+            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
+                @Override
+                public void afterCommit() { hot.initialize(productId); }       // commit 之後才讀 MySQL：讀到的是這次之後的可售量
+            });
+        } else {
+            hot.removeAfterCommit(productId);
+        }
+    }
+
+    @Override
+    public int availableForDisplay(long productId, boolean isHot) {
+        if (isHot) {
+            Optional<Integer> v = hot.display(productId);
+            if (v.isPresent()) return Math.max(0, v.get());
+        }
+        String key = "available:" + productId;
+        Optional<String> cached = guard.call("available.get", () -> redis.opsForValue().get(key));
+        if (cached.isPresent()) return Integer.parseInt(cached.get());
+        long now = System.currentTimeMillis();
+        if (!guard.available()) {
+            long[] l = degradedAvailable.get(productId);                    // {值, 到期時間}
+            if (l != null && l[1] > now) return (int) l[0];
+        }
+        int v = available(productId);
+        if (guard.available()) guard.run("available.put", () -> redis.opsForValue().set(key, String.valueOf(v), DISPLAY_TTL));
+        else degradedAvailable.put(productId, new long[]{v, now + DISPLAY_TTL.toMillis()});
+        return v;
     }
 
     @Override
@@ -60,12 +121,15 @@ class JdbcInventoryService implements InventoryApi {
     @Override
     @Transactional(propagation = Propagation.MANDATORY)
     public void release(long orderId) {
+        List<ReserveLine> released = new ArrayList<>();
         for (Held h : held(orderId, "'HELD', 'CONFIRMED'")) {
+            released.add(new ReserveLine(h.productId(), h.quantity()));
             jdbc.update("UPDATE inventory SET reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = ?",
                     h.quantity(), h.productId());
             jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
             ledger(h.productId(), 0, -h.quantity(), "RELEASE", "order:" + orderId);
         }
+        hot.giveBackAfterCommit(released);                                  // 熱點商品：commit 之後加回 Redis（不是熱點的 key 不存在，什麼都不做）
     }
 
     @Override
@@ -100,6 +164,7 @@ class JdbcInventoryService implements InventoryApi {
         if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
         jdbc.update("UPDATE inventory SET on_hand = on_hand + ? WHERE product_id = ?", quantity, productId);
         ledger(productId, quantity, 0, "RESTOCK", note);
+        hot.giveBackAfterCommit(List.of(new ReserveLine(productId, quantity)));
     }
 
     @Override
@@ -115,6 +180,7 @@ class JdbcInventoryService implements InventoryApi {
         jdbc.batchUpdate("""
                 INSERT INTO inventory_ledger(product_id, delta_on_hand, delta_reserved, reason, ref)
                 VALUES (?, ?, ?, ?, ?)""", led);
+        hot.giveBackAfterCommit(lines.stream().map(l -> new ReserveLine(l.productId(), l.quantity())).toList());
     }
 
     @Override
```

#### 主程式：ordering、reporting

**`src/main/java/com/example/shop/ordering/internal/web/OrderCommandController.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/main/java/com/example/shop/ordering/internal/web/OrderCommandController.java
+++ b/src/main/java/com/example/shop/ordering/internal/web/OrderCommandController.java
@@ -1,5 +1,11 @@
 package com.example.shop.ordering.internal.web;
 
+import com.example.shop.shared.config.ShopProperties;
+import com.example.shop.shared.error.ProblemType;
+import com.example.shop.shared.error.ShopException;
+import com.example.shop.shared.ratelimit.RateLimiter;
+import java.time.Duration;
+
 import com.example.shop.ordering.OrderingApi;
 import com.example.shop.ordering.internal.OrderCommands;
 import com.example.shop.ordering.internal.OrderDtos.*;
@@ -21,11 +27,15 @@ class OrderCommandController {
     private final OrderingApi ordering;
     private final OrderCommands commands;
     private final OrderQueryService queries;
+    private final RateLimiter limiter;
+    private final ShopProperties.RateLimit limits;
 
-    OrderCommandController(OrderingApi ordering, OrderCommands commands, OrderQueryService queries) {
+    OrderCommandController(OrderingApi ordering, OrderCommands commands, OrderQueryService queries, RateLimiter limiter, ShopProperties props) {
         this.ordering = ordering;
         this.commands = commands;
         this.queries = queries;
+        this.limiter = limiter;
+        this.limits = props.rateLimit();
     }
 
     /** US-ORD-1a AC-1：第一次 201；同一個鍵、同樣內容再送一次 → 200 與同一張訂單 */
@@ -34,6 +44,10 @@ class OrderCommandController {
                                     @RequestHeader("Idempotency-Key") @NotBlank(message = "Idempotency-Key 不可空白")
                                     @Size(max = 64, message = "Idempotency-Key 最多 64 字") String key,
                                     @Valid @RequestBody PlaceOrderRequest req) {
+        // US-ORD-1 AC-8：每位買家每分鐘 10 張「不同的」訂單。同一個 Idempotency-Key 的重送不算新的一次（6.7.1）
+        RateLimiter.Decision d = limiter.distinct("orders:" + user.id(), key, limits.ordersPerBuyerPerMinute(), Duration.ofMinutes(1));
+        if (limits.enabled() && !d.allowed())
+            throw new ShopException(ProblemType.RATE_LIMITED, "下單太頻繁，請稍後再試").with("retryAfter", d.retryAfterSeconds());
         OrderingApi.PlacedOrder placed = ordering.placeOrder(user.require(Role.BUYER).id(), key, req.items().stream()
                 .map(l -> new OrderingApi.OrderLine(l.productId(), l.quantity(), l.unitPrice())).toList());
         return ResponseEntity.status(placed.replayed() ? HttpStatus.OK : HttpStatus.CREATED).body(queries.byId(placed.orderId()));
```

**`src/main/java/com/example/shop/reporting/internal/TrendingMapper.java`**（新增）

```java
package com.example.shop.reporting.internal;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.List;

/** 6.8 US-RPT-2 AC-2：近 24 小時的下單量 Top N。SQL 在 resources/mapper/reporting/TrendingMapper.xml */
@Mapper
interface TrendingMapper {

    record Row(long productId, String name, long quantity) {}

    List<Row> top(@Param("since") Instant since, @Param("limit") int limit);
}
```

**`src/main/resources/mapper/reporting/TrendingMapper.xml`**（新增）

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.shop.reporting.internal.TrendingMapper">

  <resultMap id="row" type="com.example.shop.reporting.internal.TrendingMapper$Row">
    <constructor>
      <arg column="product_id" javaType="_long"/>
      <arg column="name" javaType="java.lang.String"/>
      <arg column="quantity" javaType="_long"/>
    </constructor>
  </resultMap>

  <!--
    US-RPT-2 AC-2：近 24 小時「下單」量（不是出貨量；取消的也算 —— 它代表的是熱度）。
    只列 ON_SALE 的商品：首頁不推一個已經下架的東西。
    o.created_at >= #{since}：V12 的 idx_orders_created（6.8.1）
  -->
  <select id="top" resultMap="row">
    SELECT i.product_id, p.name, SUM(i.quantity) AS quantity
      FROM orders o
      JOIN order_items i ON i.order_id = o.id
      JOIN products p ON p.id = i.product_id
     WHERE o.created_at >= #{since}
       AND p.status = 'ON_SALE'
     GROUP BY i.product_id, p.name
     ORDER BY quantity DESC, i.product_id
     LIMIT #{limit}
  </select>
</mapper>
```

**`src/main/java/com/example/shop/reporting/internal/TrendingService.java`**（新增）

```java
package com.example.shop.reporting.internal;

import com.example.shop.shared.redis.RedisGuard;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Optional;

/**
 * 6.8 US-RPT-2 AC-2：首頁的熱門排行，近 24 小時下單量 Top 10，允許 1 分鐘延遲。
 *
 * 每分鐘最多算一次：Redis 裡有就直接回；沒有（過期了）才用 SQL 算一次，存 60 秒。
 * 不在每一張訂單成立時 ZINCRBY —— 那是「下單成功」與「排行 +1」兩個寫入（6.8.2），而且要處理 24 小時的滑動窗。
 * Redis 不能用：回空清單，「不」退回 MySQL（0.6.3：熱門排行 × Redis 掛了 = 200 空清單 + X-Degraded）。
 */
@Service
public class TrendingService {

    public record Item(long productId, String name, long quantity) {}

    /** degraded = true：Redis 不能用，這是一份空的清單（Controller 會加上 X-Degraded: trending） */
    public record Result(List<Item> items, boolean degraded) {}

    static final String KEY = "trending:24h:top10";
    static final Duration FRESH_FOR = Duration.ofMinutes(1);

    private final TrendingMapper mapper;
    private final StringRedisTemplate redis;
    private final RedisGuard guard;
    private final ObjectMapper json;
    private final Clock clock;

    TrendingService(TrendingMapper mapper, StringRedisTemplate redis, RedisGuard guard, ObjectMapper json, Clock clock) {
        this.mapper = mapper;
        this.redis = redis;
        this.guard = guard;
        this.json = json;
        this.clock = clock;
    }

    public Result top10() {
        if (!guard.available()) return new Result(List.of(), true);
        Optional<String> cached = guard.call("trending.get", () -> redis.opsForValue().get(KEY));
        if (cached.isPresent()) return new Result(parse(cached.get()), false);
        if (!guard.available()) return new Result(List.of(), true);         // 剛剛那一次 GET 失敗了
        List<Item> items = compute();
        guard.run("trending.put", () -> redis.opsForValue().set(KEY, write(items), FRESH_FOR));
        return new Result(items, false);
    }

    List<Item> compute() {
        return mapper.top(clock.instant().minus(Duration.ofHours(24)), 10).stream()
                .map(r -> new Item(r.productId(), r.name(), r.quantity())).toList();
    }

    private List<Item> parse(String s) {
        try { return json.readValue(s, new TypeReference<>() {}); } catch (Exception e) { throw new IllegalStateException(e); }
    }

    private String write(List<Item> items) {
        try { return json.writeValueAsString(items); } catch (Exception e) { throw new IllegalStateException(e); }
    }
}
```

**`src/main/java/com/example/shop/reporting/internal/web/TrendingController.java`**（新增）

```java
package com.example.shop.reporting.internal.web;

import com.example.shop.reporting.internal.TrendingService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** US-RPT-2 AC-2：GET /api/products/trending（公開；路徑比 /api/products/{id} 具體，Spring MVC 會優先選它） */
@RestController
class TrendingController {

    private final TrendingService trending;

    TrendingController(TrendingService trending) { this.trending = trending; }

    @GetMapping("/api/products/trending")
    ResponseEntity<List<TrendingService.Item>> trending() {
        TrendingService.Result r = trending.top10();
        ResponseEntity.BodyBuilder b = ResponseEntity.ok();
        if (r.degraded()) b.header("X-Degraded", "trending");                 // 0.6.3：前端看到這個 header 就隱藏「熱門」區塊
        return b.body(r.items());
    }
}
```

#### 主程式：shared

**`src/main/java/com/example/shop/shared/config/ShopProperties.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/main/java/com/example/shop/shared/config/ShopProperties.java
+++ b/src/main/java/com/example/shop/shared/config/ShopProperties.java
@@ -15,7 +15,19 @@ import java.time.Duration;
 
 @Validated
 @ConfigurationProperties(prefix = "shop", ignoreUnknownFields = false)
-public record ShopProperties(@Valid @NotNull Order order, @Valid @NotNull Security security, @Valid @NotNull Payment payment) {
+public record ShopProperties(@Valid @NotNull Order order, @Valid @NotNull Security security, @Valid @NotNull Payment payment,
+                             @Valid @NotNull @DefaultValue Inventory inventory, @Valid @NotNull @DefaultValue RateLimit rateLimit) {
+
+    /** 第 06 章：熱點庫存的對帳（0.6.4）。jobsEnabled=false 給需要可重現資料的實驗用（同 order.jobsEnabled） */
+    public record Inventory(
+            @NotNull @DefaultValue("1m") @DurationMin(seconds = 5) Duration hotReconcileInterval,
+            @DefaultValue("true") boolean jobsEnabled) {}
+
+    /** 第 06 章：0.6.5 的三條限流。數字是需求，不是調校參數 —— 改它要改 0.6.5 */
+    public record RateLimit(
+            @DefaultValue("10") @Min(1) int ordersPerBuyerPerMinute,     // US-ORD-1 AC-8
+            @DefaultValue("50") @Min(1) int requestsPerIpPerSecond,      // 0.6.5 全域
+            @DefaultValue("true") boolean enabled) {}
 
     /** US-ORD-3：付款期限 */
     public record Order(
```

**`src/main/java/com/example/shop/shared/redis/RedisGuard.java`**（新增；6.9.2 修正之後的最終版）

```java
package com.example.shop.shared.redis;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * 6.3.3 所有 Redis 呼叫的共同入口：失敗之後 5 秒內不再碰 Redis，直接走呼叫端給的降級路徑。
 * 第 05 章的 LoginAttempts 自己做了一份（5.6.4）；這一章有快取、熱點庫存、限流、排行四個使用者，把它抽到 shared。
 *
 * 為什麼要「5 秒內不碰」：Redis「卡住」（不是「停掉」）的時候，每一次呼叫都要等滿 500 ms 的逾時（5.6.4 的 F7）。
 * 商品詳情一個請求碰 Redis 兩次，就是 1 秒 —— 降級成「走 MySQL」之前，先被逾時拖死。
 *
 * 為什麼要「1 秒內失敗 3 次」才跳開（6.4.5）：第一版失敗一次就跳開。每秒 1,000 個請求時，偶發的一次慢指令
 * 讓「全部」的請求改打 MySQL 5 秒 —— MySQL 每秒收到 1,272 句、p95 變成 4 秒。單次的失敗只影響那一次呼叫。
 */
@Component
public class RedisGuard {

    private static final Logger log = LoggerFactory.getLogger(RedisGuard.class);
    public static final Duration BACKOFF = Duration.ofSeconds(5);
    /** 1 秒內失敗這麼多次才跳開 */
    static final int TRIP_AFTER = 3;
    static final long WINDOW_MS = 1000;

    private final Clock clock;
    private final Counter failures, skipped, trips;
    private volatile long skipUntil;
    /** 只在 tripped() 裡讀寫（synchronized） */
    private final java.util.ArrayDeque<Long> recentFailures = new java.util.ArrayDeque<>();

    public RedisGuard(Clock clock, MeterRegistry meters) {
        this.clock = clock;
        this.failures = Counter.builder("shop.redis.failures").description("Redis 呼叫失敗的次數").register(meters);
        this.skipped = Counter.builder("shop.redis.skipped").description("因為 Redis 剛失敗過、直接走降級路徑的次數").register(meters);
        this.trips = Counter.builder("shop.redis.trips").description("跳開（5 秒內不碰 Redis）的次數").register(meters);
    }

    /** Redis 現在可以用嗎？（剛失敗過的 5 秒內 = 不能） */
    public boolean available() { return clock.millis() >= skipUntil; }

    /**
     * 執行一個 Redis 動作。成功 → 結果；失敗或正在退避 → empty（呼叫端決定降級路徑）。
     * 只接 DataAccessException：Lettuce 的連線失敗、逾時都會被 Spring 轉成它。其他例外（程式的 bug）照常丟出去。
     */
    public <T> Optional<T> call(String what, Supplier<T> action) {
        if (!available()) { skipped.increment(); return Optional.empty(); }
        try {
            return Optional.ofNullable(action.get());
        } catch (DataAccessException e) {
            tripped(what, e);
            return Optional.empty();
        }
    }

    /** 沒有回傳值的版本。@return false = 沒有執行成功 */
    public boolean run(String what, Runnable action) {
        return call(what, () -> { action.run(); return Boolean.TRUE; }).isPresent();
    }

    /**
     * synchronized：Redis 卡住（docker pause）時，幾百個指令會在同一個瞬間一起逾時、一起進來。
     * 第一版用 ConcurrentLinkedDeque、沒有鎖：「isEmpty() 不是空的 → peekFirst()」之間被別的執行緒 clear()，peekFirst() 回 null → NPE，
     * 而這個 NPE 從 call() 丟出去 —— 降級路徑自己變成了 500（6.9.2）。失敗的路徑不是熱路徑，一把鎖就夠了。
     */
    private synchronized void tripped(String what, DataAccessException e) {
        long now = clock.millis();
        failures.increment();
        recentFailures.addLast(now);
        while (!recentFailures.isEmpty() && recentFailures.peekFirst() < now - WINDOW_MS) recentFailures.pollFirst();
        if (recentFailures.size() < TRIP_AFTER) return;                     // 偶發的一次：只有這一次走降級路徑
        boolean first = available();
        skipUntil = now + BACKOFF.toMillis();
        recentFailures.clear();
        trips.increment();
        if (first) log.warn("REDIS_DEGRADED {} 失敗（1 秒內第 {} 次），{} 秒內所有 Redis 呼叫改走降級路徑：{}", what, TRIP_AFTER, BACKOFF.toSeconds(), e.getMessage());
    }
}
```

**`src/main/java/com/example/shop/shared/redis/DistributedLock.java`**（新增）

```java
package com.example.shop.shared.redis;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * 6.6 分散式鎖：SET key token NX PX ttl；放鎖用 Lua 比對 token（只能放自己的鎖，10-redis/09）。
 *
 * 這一章只有一條規則：**鎖要包住交易**。拿鎖可以在交易裡面，但放鎖一定要在 commit 之後 ——
 * 在 commit 之前放掉，下一個拿到鎖的人會讀到「還沒提交」之前的資料（6.2.5）。
 * 所以有交易的時候，放鎖登記在 afterCompletion（commit 或 rollback 之後才執行）。
 */
@Component
public class DistributedLock {

    static final RedisScript<Long> RELEASE = RedisScript.of("""
            if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end""", Long.class);

    private final StringRedisTemplate redis;

    DistributedLock(StringRedisTemplate redis) { this.redis = redis; }

    public record Handle(String key, String token) {}

    /** 拿不到（別人拿著，或 Redis 有問題）→ empty。不等待：呼叫端決定要重試、跳過還是回 503 */
    public Optional<Handle> tryLock(String key, Duration ttl) {
        String token = UUID.randomUUID().toString();
        Boolean ok = redis.opsForValue().setIfAbsent(key, token, ttl);
        return Boolean.TRUE.equals(ok) ? Optional.of(new Handle(key, token)) : Optional.empty();
    }

    public void unlock(Handle h) {
        redis.execute(RELEASE, List.of(h.key()), h.token());
    }

    /**
     * 有交易 → 等交易結束（commit 或 rollback）之後才放鎖；沒有交易 → 現在就放。
     * afterCompletion 在 afterCommit 之後執行：登記在 afterCommit 的 Redis 更新會先做完，鎖才放掉。
     */
    public void unlockAfterTransaction(Handle h) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) { unlock(h); return; }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCompletion(int status) { unlock(h); }
        });
    }
}
```

**`src/main/java/com/example/shop/shared/ratelimit/RateLimiter.java`**（新增）

```java
package com.example.shop.shared.ratelimit;

import com.example.shop.shared.redis.RedisGuard;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 6.7 限流（0.6.5）。兩種計數：
 *  - perRequest：每一個請求都算一次（固定窗，INCR）—— 全域的每 IP 每秒 50 次
 *  - distinct：只數「不同的 member」（滑動窗，ZSET）—— 每位買家每分鐘 10 張訂單，member = Idempotency-Key（6.7.1：連點、照 Retry-After 重送都不算新的一次）
 * Redis 不能用（RedisGuard）→ 改用這台機器自己的記憶體（0.6.3：下單 × Redis 掛了 = 201，「限流改用單機記憶體」）。
 * 單機的代價：N 台機器，實際上限是 N 倍（6.7.3 實測）。
 */
@Component
public class RateLimiter {

    public record Decision(boolean allowed, long retryAfterSeconds) {
        static final Decision OK = new Decision(true, 0);
        static Decision denied(long millis) { return new Decision(false, Math.max(1, (millis + 999) / 1000)); }
    }

    static final RedisScript<List> PER_REQUEST = RedisScript.of("""
            local n = redis.call('INCR', KEYS[1])
            if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
            return {n, redis.call('PTTL', KEYS[1])}""", List.class);

    /** ARGV：現在（毫秒）、窗（毫秒）、上限、member。同一個 member 已經在窗裡 → 放行、不加一 */
    static final RedisScript<List> DISTINCT = RedisScript.of("""
            local now, window, limit = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
            redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
            if redis.call('ZSCORE', KEYS[1], ARGV[4]) then return {1, 0} end
            if redis.call('ZCARD', KEYS[1]) >= limit then
              local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
              return {0, tonumber(oldest[2]) + window - now}
            end
            redis.call('ZADD', KEYS[1], now, ARGV[4])
            redis.call('PEXPIRE', KEYS[1], window)
            return {1, 0}""", List.class);

    private final StringRedisTemplate redis;
    private final RedisGuard guard;
    private final Clock clock;
    private final Counter local;
    private final Map<String, long[]> localCounters = new ConcurrentHashMap<>();                  // key → {窗的開始, 次數}
    private final Map<String, LinkedHashMap<String, Long>> localMembers = new ConcurrentHashMap<>();

    RateLimiter(StringRedisTemplate redis, RedisGuard guard, Clock clock, MeterRegistry meters) {
        this.redis = redis;
        this.guard = guard;
        this.clock = clock;
        this.local = Counter.builder("shop.ratelimit.local").description("Redis 不能用、改用單機計數的次數").register(meters);
    }

    public Decision perRequest(String key, int limit, Duration window) {
        long now = clock.millis(), start = now - now % window.toMillis();
        String k = "rl:" + key + ":" + start;
        return guard.call("ratelimit", () -> redis.execute(PER_REQUEST, List.of(k), String.valueOf(window.toMillis())))
                .map(r -> ((Number) r.get(0)).longValue() <= limit ? Decision.OK : Decision.denied(((Number) r.get(1)).longValue()))
                .orElseGet(() -> localPerRequest(k, limit, start, window));
    }

    public Decision distinct(String key, String member, int limit, Duration window) {
        long now = clock.millis();
        String k = "rl:" + key;
        return guard.call("ratelimit", () -> redis.execute(DISTINCT, List.of(k), String.valueOf(now), String.valueOf(window.toMillis()),
                        String.valueOf(limit), member))
                .map(r -> ((Number) r.get(0)).intValue() == 1 ? Decision.OK : Decision.denied(((Number) r.get(1)).longValue()))
                .orElseGet(() -> localDistinct(k, member, limit, now, window));
    }

    private Decision localPerRequest(String k, int limit, long start, Duration window) {
        local.increment();
        long[] c = localCounters.compute(k, (x, old) -> old == null || old[0] != start ? new long[]{start, 0} : old);
        synchronized (c) {
            if (++c[1] <= limit) { prune(); return Decision.OK; }
        }
        return Decision.denied(start + window.toMillis() - clock.millis());
    }

    private Decision localDistinct(String k, String member, int limit, long now, Duration window) {
        local.increment();
        LinkedHashMap<String, Long> m = localMembers.computeIfAbsent(k, x -> new LinkedHashMap<>());
        synchronized (m) {
            m.values().removeIf(t -> t <= now - window.toMillis());
            if (m.containsKey(member)) return Decision.OK;
            if (m.size() >= limit) return Decision.denied(m.values().iterator().next() + window.toMillis() - now);
            m.put(member, now);
            return Decision.OK;
        }
    }

    /** 不讓單機的計數表無限長大（Redis 掛很久、而且攻擊者一直換 IP 的時候） */
    private void prune() {
        if (localCounters.size() < 100_000) return;
        long now = clock.millis();
        for (Iterator<long[]> it = localCounters.values().iterator(); it.hasNext(); ) if (it.next()[0] < now - 60_000) it.remove();
    }
}
```

**`src/main/java/com/example/shop/shared/web/RateLimitFilter.java`**（新增）

```java
package com.example.shop.shared.web;

import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.ratelimit.RateLimiter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Duration;

/**
 * 6.7.2 0.6.5 的全域限流：每個 IP 每秒 50 次。放在 Spring Security 之前：沒有登入的洪水也要擋（登入 API 本身就是公開的）。
 * health 不限流：負載平衡器的探測如果被 429，攻擊者就能讓負載平衡器把每一台都摘掉（5.2.1 的同一種後果）。
 */
@Configuration(proxyBeanMethods = false)
class RateLimitFilter {

    @Bean
    FilterRegistrationBean<OncePerRequestFilter> perIpRateLimit(RateLimiter limiter, ShopProperties props, ProblemWriter problems) {
        int limit = props.rateLimit().requestsPerIpPerSecond();
        boolean enabled = props.rateLimit().enabled();
        OncePerRequestFilter f = new OncePerRequestFilter() {
            @Override
            protected boolean shouldNotFilter(HttpServletRequest req) {
                return !enabled || req.getRequestURI().startsWith("/actuator/health");
            }

            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                RateLimiter.Decision d = limiter.perRequest("ip:" + req.getRemoteAddr(), limit, Duration.ofSeconds(1));
                if (!d.allowed()) {
                    res.setHeader("Retry-After", String.valueOf(d.retryAfterSeconds()));
                    problems.write(req, res, ProblemType.RATE_LIMITED, "請求太頻繁，請稍後再試");
                    return;
                }
                chain.doFilter(req, res);
            }
        };
        FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(f);
        reg.setOrder(-200);                                                 // Spring Security 的 filter chain 是 -100
        return reg;
    }
}
```

#### 測試的設定與支援

**`src/test/resources/config/application.yml`**（新增）

```yaml
# 測試環境：所有請求都從 127.0.0.1 來（驗收 Q2 的 100 個買家、E7 的 2,000 個買家）。
# 0.6.5 的「每 IP 每秒 50 次」會讓它們自己打到限流 —— 那不是被測的東西。
# 這個限制本身由 RateLimitTest 用 @SpringBootTest(properties = ...) 改回 50 來測（6.7.2）。
shop:
  rate-limit:
    requests-per-ip-per-second: 1000000
```

**`src/test/java/com/example/shop/support/TestRedis.java`**（新增）

```java
package com.example.shop.support;

import org.springframework.context.ApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.util.ArrayList;
import java.util.List;

/**
 * 第 06 章：用 SQL 直接建、刪商品的測試，要一併清掉 Redis 裡那個商品的快取（6.4.1）。
 * 不清的話：下一次用同一個 id 建的商品 version 又是 0，跟快取裡那一份「一樣新」，舊的名稱、價格、狀態會一直留著。
 */
public final class TestRedis {
    private TestRedis() {}

    public static void forgetProducts(StringRedisTemplate redis, long... ids) {
        List<String> keys = new ArrayList<>();
        for (long id : ids) keys.addAll(List.of("product:v1:" + id, "stock:" + id, "available:" + id));
        redis.delete(keys);
        redis.delete("trending:24h:top10");
    }

    public static void forgetProducts(ApplicationContext ctx, long... ids) {
        forgetProducts(ctx.getBean(StringRedisTemplate.class), ids);
    }
}
```

**`src/test/resources/openapi/shop-api.json`**（修改；用 `-Dopenapi.update=true` 產生，6.3.1；對第 05 章的 diff）

```diff
--- a/src/test/resources/openapi/shop-api.json
+++ b/src/test/resources/openapi/shop-api.json
@@ -238,6 +238,31 @@
         "required" : [ "role" ],
         "type" : "object"
       },
+      "HotRequest" : {
+        "properties" : {
+          "hot" : {
+            "type" : "boolean"
+          }
+        },
+        "required" : [ "hot" ],
+        "type" : "object"
+      },
+      "Item" : {
+        "properties" : {
+          "name" : {
+            "type" : "string"
+          },
+          "productId" : {
+            "format" : "int64",
+            "type" : "integer"
+          },
+          "quantity" : {
+            "format" : "int64",
+            "type" : "integer"
+          }
+        },
+        "type" : "object"
+      },
       "JsonNode" : {
         "type" : "object"
       },
@@ -1386,6 +1411,27 @@
         "tags" : [ "product-controller" ]
       }
     },
+    "/api/products/trending" : {
+      "get" : {
+        "operationId" : "trending",
+        "responses" : {
+          "200" : {
+            "content" : {
+              "*/*" : {
+                "schema" : {
+                  "items" : {
+                    "$ref" : "#/components/schemas/Item"
+                  },
+                  "type" : "array"
+                }
+              }
+            },
+            "description" : "OK"
+          }
+        },
+        "tags" : [ "trending-controller" ]
+      }
+    },
     "/api/products/{id}" : {
       "get" : {
         "operationId" : "detail",
@@ -1663,6 +1709,43 @@
         "tags" : [ "seller-product-controller" ]
       }
     },
+    "/api/seller/products/{id}/hot" : {
+      "post" : {
+        "operationId" : "hot",
+        "parameters" : [ {
+          "in" : "path",
+          "name" : "id",
+          "required" : true,
+          "schema" : {
+            "format" : "int64",
+            "type" : "integer"
+          }
+        } ],
+        "requestBody" : {
+          "content" : {
+            "application/json" : {
+              "schema" : {
+                "$ref" : "#/components/schemas/HotRequest"
+              }
+            }
+          },
+          "required" : true
+        },
+        "responses" : {
+          "200" : {
+            "content" : {
+              "*/*" : {
+                "schema" : {
+                  "$ref" : "#/components/schemas/ProductDetail"
+                }
+              }
+            },
+            "description" : "OK"
+          }
+        },
+        "tags" : [ "seller-product-controller" ]
+      }
+    },
     "/api/seller/products/{id}/publish" : {
       "post" : {
         "operationId" : "publish",
```

#### 測試：既有的測試改了什麼

**`src/test/java/com/example/shop/acceptance/CapstoneAcceptanceTest.java`**（修改：Q8、Q4 的付款期限與清理、Q1～Q5 的 `forgetProducts`；對第 05 章的 diff）

```diff
--- a/src/test/java/com/example/shop/acceptance/CapstoneAcceptanceTest.java
+++ b/src/test/java/com/example/shop/acceptance/CapstoneAcceptanceTest.java
@@ -44,11 +44,13 @@ class CapstoneAcceptanceTest {
 
     /** 第 05 章：身分是正式的 AccessTokens 簽出來的 JWT（TestTokens）。每一題各自啟動一個應用程式，所以每次啟動都換一個 */
     static AccessTokens tokens;
+    static org.springframework.data.redis.core.StringRedisTemplate redis;
 
     static ConfigurableApplicationContext startApp() {
         ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--shop.order.jobs-enabled=false",
                 "--spring.main.banner-mode=off", "--logging.level.root=WARN");
         tokens = ctx.getBean(AccessTokens.class);
+        redis = ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class);
         return ctx;
     }
 
@@ -87,6 +89,7 @@ class CapstoneAcceptanceTest {
             jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", p);
             jdbc.update("DELETE FROM inventory WHERE product_id = ?", p);
             jdbc.update("DELETE FROM products WHERE id = ?", p);
+            com.example.shop.support.TestRedis.forgetProducts(redis, p);                     // 6.2.3
         }
     }
 
@@ -223,7 +226,7 @@ class CapstoneAcceptanceTest {
                 for (int i = 1; i <= 45; i++) {                             // US-ORD-5 AC-1：一位有 45 張訂單的買家
                     jdbc.update("""
                             INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline, created_at)
-                            VALUES (?, ?, ?, 2, 'PENDING_PAYMENT', 300, NOW(3), NOW(3) - INTERVAL ? MINUTE)""",
+                            VALUES (?, ?, ?, 2, 'PENDING_PAYMENT', 300, NOW(3) + INTERVAL 1 DAY, NOW(3) - INTERVAL ? MINUTE)""",   // 期限設在明天：不然付款逾時排程會在測試途中把它們取消（6.11）
                             9_904_000L + i, "20990104-9%05d".formatted(i), buyer, i);
                     for (int k = 1; k <= 3; k++)
                         jdbc.update("INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (?, ?, 'q4', 100, 1)",
@@ -248,6 +251,7 @@ class CapstoneAcceptanceTest {
                 }
             } finally {
                 jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", buyer);
+                jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ?", buyer);
                 jdbc.update("DELETE FROM orders WHERE buyer_id = ?", buyer);
             }
         }
@@ -377,9 +381,86 @@ class CapstoneAcceptanceTest {
     @DisplayName("Q7 任一請求的日誌都帶 traceId，且能以 traceId 串起 HTTP → DB → MQ 消費端")
     void q7_traceIdEverywhere() {}
 
-    @Test @Disabled("ch06：降級")
+    // ───────── 第 06 章：Q8 ─────────
+
+    static void docker(String... args) throws Exception {
+        List<String> cmd = new java.util.ArrayList<>(List.of("docker"));
+        cmd.addAll(List.of(args));
+        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
+        p.getInputStream().readAllBytes();
+        p.waitFor();
+    }
+
+    record Check(String what, int status, String note) {
+        @Override public String toString() { return what + " " + status + (note.isEmpty() ? "" : "（" + note + "）"); }
+    }
+
+    /** 0.6.3 那一欄（「Redis 掛了」）的每一格 */
+    static List<Check> degradationColumn(int port, long normal, long hot, long buyer, int n) throws Exception {
+        String bearer = TestTokens.bearer(tokens, buyer);
+        HttpResponse<String> detail = http(port, "GET", "/api/products/" + normal, null, null);
+        HttpResponse<String> hotDetail = http(port, "GET", "/api/products/" + hot, null, null);
+        Http hotOrder = placeOrder(port, buyer, "q8-hot-" + n, "[{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]".formatted(hot));
+        Http normalOrder = placeOrder(port, buyer + 1 + n, "q8-normal-" + n, "[{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]".formatted(normal));
+        HttpResponse<String> readiness = http(port, "GET", "/actuator/health/readiness", null, null);
+        HttpResponse<String> trending = http(port, "GET", "/api/products/trending", null, null);
+        HttpResponse<String> login = http(port, "POST", "/api/auth/login", null, "{\"email\": \"buyer00001@example.com\", \"password\": \"password123\"}");
+        return List.of(new Check("商品詳情", detail.statusCode(), ""), new Check("熱點商品詳情", hotDetail.statusCode(), ""),
+                new Check("熱點下單", hotOrder.status(), hotOrder.type() == null ? "" : hotOrder.type() + "，Retry-After " + hotOrder.retryAfter()),
+                new Check("一般下單", normalOrder.status(), ""),
+                new Check("readiness", readiness.statusCode(), readiness.body().contains("\"UP\"") ? "UP" : readiness.body()),
+                new Check("熱門排行", trending.statusCode(), trending.body() + " X-Degraded: " + trending.headers().firstValue("X-Degraded").orElse("—")),
+                new Check("登入", login.statusCode(), ""));
+    }
+
+    @Test
     @DisplayName("Q8 Redis 停止 60 秒：商品詳情仍回 200（走 DB）、熱點商品下單回 503、一般下單回 201、readiness 維持 UP")
-    void q8_redisOutageDegrades() {}
+    void q8_redisOutageDegrades() throws Exception {
+        long normal = 9_900_801L + 50, hot = normal + 1, buyer = 990_800;
+        try (var ctx = startApp()) {
+            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
+            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
+            List<Long> buyers = java.util.stream.LongStream.range(buyer, buyer + 20).boxed().toList();
+            try {
+                cleanupBuyersAndProducts(jdbc, buyers, List.of(normal, hot));
+                product(jdbc, normal, 50);
+                product(jdbc, hot, 50);
+                jdbc.update("UPDATE products SET hot = TRUE WHERE id = ?", hot);
+                System.out.println("Q8：Redis 正常       → " + degradationColumn(port, normal, hot, buyer, 0));
+
+                docker("stop", "shop-redis-1");
+                long start = System.nanoTime();
+                List<List<Check>> during = new java.util.ArrayList<>();
+                for (int i = 1; i <= 6; i++) {
+                    while (System.nanoTime() - start < i * 10_000_000_000L - 5_000_000_000L) Thread.sleep(100);
+                    List<Check> c = degradationColumn(port, normal, hot, buyer, i);
+                    during.add(c);
+                    System.out.printf("Q8：停掉後第 %2d 秒   → %s%n", (System.nanoTime() - start) / 1_000_000_000L, c);
+                }
+                while (System.nanoTime() - start < 60_000_000_000L) Thread.sleep(100);
+                docker("start", "shop-redis-1");
+                for (int i = 0; i < 60 && http(port, "GET", "/api/ping", null, null).statusCode() != 200; i++) Thread.sleep(500);
+                Thread.sleep(com.example.shop.shared.redis.RedisGuard.BACKOFF.toMillis() + 1000);
+                System.out.println("Q8：Redis 恢復之後   → " + degradationColumn(port, normal, hot, buyer, 9));
+
+                for (List<Check> c : during) {
+                    assertThat(c.get(0).status()).as("商品詳情").isEqualTo(200);
+                    assertThat(c.get(1).status()).as("熱點商品詳情").isEqualTo(200);
+                    assertThat(c.get(2).status()).as("熱點下單").isEqualTo(503);
+                    assertThat(c.get(2).note()).contains("/problems/temporarily-unavailable");
+                    assertThat(c.get(3).status()).as("一般下單").isEqualTo(201);
+                    assertThat(c.get(4).note()).as("readiness").isEqualTo("UP");
+                    assertThat(c.get(5).status()).isEqualTo(200);
+                    assertThat(c.get(5).note()).isEqualTo("[] X-Degraded: trending");
+                    assertThat(c.get(6).status()).as("登入").isEqualTo(200);
+                }
+            } finally {
+                docker("start", "shop-redis-1");
+                for (long b : List.of(1001L)) jdbc.update("DELETE FROM refresh_tokens WHERE user_id = ? AND created_at > NOW(3) - INTERVAL 5 MINUTE", b);
+                cleanupBuyersAndProducts(jdbc, buyers, List.of(normal, hot));
+            }
+        }
+    }
 
     @Test @Disabled("ch07：Outbox")
     @DisplayName("Q9 訂單 commit 後、訊息送出前程序被殺：重啟後訊息仍送出，庫存最終被扣")
```

**`src/test/java/com/example/shop/api/IdorMatrixTest.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/test/java/com/example/shop/api/IdorMatrixTest.java
+++ b/src/test/java/com/example/shop/api/IdorMatrixTest.java
@@ -53,7 +53,8 @@ class IdorMatrixTest {
             new Cell("PATCH", "/api/seller/products/{id}", "{\"price\": 1}", true),
             new Cell("POST", "/api/seller/products/{id}/publish", null, true),
             new Cell("POST", "/api/seller/products/{id}/unpublish", null, true),
-            new Cell("POST", "/api/seller/products/{id}/restock", "{\"quantity\": 1000}", true));
+            new Cell("POST", "/api/seller/products/{id}/restock", "{\"quantity\": 1000}", true),
+            new Cell("POST", "/api/seller/products/{id}/hot", "{\"hot\": true}", true));
 
     /** 帶路徑變數、但「不是別人的資源」的 API */
     static final Map<String, String> EXEMPT = Map.of(
@@ -65,6 +66,7 @@ class IdorMatrixTest {
 
     @Autowired MockMvc mvc;
     @Autowired JdbcTemplate jdbc;
+    @Autowired org.springframework.data.redis.core.StringRedisTemplate redis;
     @Autowired AccessTokens tokens;
     @Autowired ObjectMapper json;
     @Autowired @Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping mappings;
@@ -98,6 +100,7 @@ class IdorMatrixTest {
         jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
         jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
         jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
+        com.example.shop.support.TestRedis.forgetProducts(redis, PRODUCT);                  // 6.2.3
     }
 
     MockHttpServletResponse call(Cell c, String id, long actor) throws Exception {
```

**`src/test/java/com/example/shop/api/SecurityRouteCoverageTest.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/test/java/com/example/shop/api/SecurityRouteCoverageTest.java
+++ b/src/test/java/com/example/shop/api/SecurityRouteCoverageTest.java
@@ -34,7 +34,7 @@ class SecurityRouteCoverageTest {
     /** 0.8 的「公開」那幾列 */
     static final Set<String> PUBLIC = Set.of(
             "POST /api/auth/register", "POST /api/auth/login", "POST /api/auth/refresh",
-            "GET /api/products", "GET /api/products/{id}", "POST /api/payments/callback", "GET /api/ping");
+            "GET /api/products", "GET /api/products/{id}", "GET /api/products/trending", "POST /api/payments/callback", "GET /api/ping");
 
     /** 不存在的使用者、商品 id */
     static final long NOBODY = 999_999_999L, ACTOR = 990_901;
```

**`src/test/java/com/example/shop/ordering/internal/OrderFlowTest.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/test/java/com/example/shop/ordering/internal/OrderFlowTest.java
+++ b/src/test/java/com/example/shop/ordering/internal/OrderFlowTest.java
@@ -36,6 +36,7 @@ class OrderFlowTest {
     @Autowired PaymentCallbackService callbacks;
     @Autowired OrderTransitionService transitions;
     @Autowired JdbcTemplate jdbc;
+    @Autowired org.springframework.data.redis.core.StringRedisTemplate redis;
     @Autowired Clock clock;
     @Autowired ShopProperties props;
 
@@ -64,6 +65,7 @@ class OrderFlowTest {
         jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
         jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
         jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
+        com.example.shop.support.TestRedis.forgetProducts(redis, PRODUCT);                  // 6.2.3
     }
 
     String place(int qty) {
```

**`src/test/java/com/example/shop/ordering/internal/AuditPlacementTest.java`**（修改；對第 05 章的 diff）

```diff
--- a/src/test/java/com/example/shop/ordering/internal/AuditPlacementTest.java
+++ b/src/test/java/com/example/shop/ordering/internal/AuditPlacementTest.java
@@ -38,6 +38,7 @@ class AuditPlacementTest {
     @Autowired OrderQueryService queries;
     @Autowired PaymentCallbackService callbacks;
     @Autowired JdbcTemplate jdbc;
+    @Autowired org.springframework.data.redis.core.StringRedisTemplate redis;
     @Autowired ShopProperties props;
 
     @BeforeEach
@@ -63,6 +64,7 @@ class AuditPlacementTest {
         jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
         jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
         jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
+        com.example.shop.support.TestRedis.forgetProducts(redis, PRODUCT);                  // 6.2.3
     }
 
     String place() {
```

#### 測試：新增的測試

**`src/test/java/com/example/shop/catalog/internal/ProductCacheTest.java`**（新增）

```java
package com.example.shop.catalog.internal;

import com.example.shop.catalog.ProductStatus;
import com.example.shop.catalog.internal.ProductDtos.UpdateProductRequest;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.redis.RedisGuard;
import com.example.shop.support.TestRedis;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

/** 0.12.2 追溯表：US-PRD-3 AC-3、US-PRD-4 AC-1（快取失效），0.6.1 第 4 條（擊穿），6.2.1 的寫入失敗 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
class ProductCacheTest {

    static final long PRODUCT = 9_900_601, SELLER = 2;

    @Autowired ProductService service;
    @Autowired ProductCache cache;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired RedisGuard guard;
    @Autowired ObjectMapper json;
    @Autowired RedisConnectionFactory factory;

    @BeforeEach
    void setUp() {
        cleanup();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '快取測試', 100.00, 'ON_SALE')", PRODUCT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", PRODUCT);
    }

    @AfterEach
    void cleanup() {
        jdbc.update("DELETE FROM audit_logs WHERE target_type = 'PRODUCT' AND target_id = ?", String.valueOf(PRODUCT));
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
        TestRedis.forgetProducts(redis, PRODUCT);
    }

    @Test @DisplayName("PRD-3 AC-3：改價之後，下一次讀詳情就是新價格（commit 之後寫入新值，不用等 TTL）")
    void priceChangeVisibleImmediately() {
        assertThat(service.detail(PRODUCT, null).price()).isEqualByComparingTo("100");
        assertThat(redis.opsForValue().get(ProductCache.key(PRODUCT))).contains("\"price\":100.00");
        service.update(SELLER, PRODUCT, new UpdateProductRequest(null, null, new BigDecimal("120"), null));
        assertThat(service.detail(PRODUCT, null).price()).isEqualByComparingTo("120");
        assertThat(redis.opsForValue().get(ProductCache.key(PRODUCT))).contains("\"price\":120.00");
    }

    @Test @DisplayName("PRD-4 AC-1：下架之後，買家讀詳情立刻 404；賣家本人仍然看得到（PRD-3 AC-2）")
    void unpublishedIsGoneImmediately() {
        service.detail(PRODUCT, null);
        service.unpublish(SELLER, PRODUCT);
        assertThatThrownBy(() -> service.detail(PRODUCT, null)).isInstanceOf(ShopException.class).hasMessageContaining("不存在");
        assertThat(service.detail(PRODUCT, SELLER).status()).isEqualTo(ProductStatus.OFF_SHELF);
    }

    @Test @DisplayName("舊的版本蓋不掉新的版本：讀的人慢了一步，帶著改價前的值回來寫，也寫不進去")
    void olderVersionCannotOverwrite() {
        service.detail(PRODUCT, null);
        ProductCache.Core before = cache.get(PRODUCT, id -> Optional.empty()).orElseThrow();
        service.update(SELLER, PRODUCT, new UpdateProductRequest(null, null, new BigDecimal("130"), null));
        assertThat(cache.put(before)).isTrue();                              // 指令成功執行了……
        assertThat(service.detail(PRODUCT, null).price()).isEqualByComparingTo("130");   // ……但快取裡還是新的
    }

    @Test @DisplayName("0.6.1 第 4 條：快取裡沒有、200 個請求同時讀 → MySQL 只被讀 1 次")
    void singleFlight() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        ExecutorService pool = Executors.newFixedThreadPool(200);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<?>> fs = new java.util.ArrayList<>();
        for (int i = 0; i < 200; i++) fs.add(pool.submit(() -> {
            go.await();
            return cache.get(PRODUCT, id -> {
                loads.incrementAndGet();
                sleep(20);                                                    // 讓「同時」夠寬
                return Optional.of(new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("100.00"), 11, ProductStatus.ON_SALE, false, 0));
            });
        }));
        go.countDown();
        for (var f : fs) f.get();
        pool.shutdown();
        assertThat(loads.get()).isEqualTo(1);
    }

    @Test @DisplayName("6.4.2：commit 之後寫入失敗（Redis 逾時）→ 記下來，背景重試把舊值刪掉，不會留到 TTL")
    void failedWriteAfterCommitIsRepaired() throws Exception {
        AtomicBoolean failScripts = new AtomicBoolean();
        StringRedisTemplate flaky = new StringRedisTemplate(factory) {
            @Override
            public <T> T execute(RedisScript<T> script, List<String> keys, Object... args) {
                if (failScripts.get()) throw new QueryTimeoutException("模擬：Redis command timed out");
                return super.execute(script, keys, args);
            }
        };
        ProductCache c = new ProductCache(flaky, guard, json);
        ProductCache.Core v1 = new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("100.00"), 11, ProductStatus.ON_SALE, false, 1);
        ProductCache.Core v2 = new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("200.00"), 11, ProductStatus.ON_SALE, false, 2);
        assertThat(c.put(v1)).isTrue();                                       // 讀的人先填了舊的值
        failScripts.set(true);
        c.putAfterCommit(() -> v2);                                           // 改價 commit 了，新值寫不進去
        failScripts.set(false);
        assertThat(c.pendingEvictions()).isEqualTo(1);
        await().atMost(Duration.ofSeconds(1)).until(() -> c.pendingEvictions() == 0);       // US-PRD-3 AC-3 的 1 秒
        assertThat(redis.opsForValue().get(ProductCache.key(PRODUCT))).isNull();            // 舊值被刪掉了
        assertThat(c.get(PRODUCT, id -> Optional.of(v2)).orElseThrow().price()).isEqualByComparingTo("200");
    }

    @Test @DisplayName("6.4.5：偶發的一次失敗不跳開；1 秒內失敗 3 次才跳開（5 秒內不碰 Redis）")
    void tripsOnlyAfterThreeFailures() {
        RedisGuard g = new RedisGuard(java.time.Clock.systemUTC(), new io.micrometer.core.instrument.simple.SimpleMeterRegistry());
        Runnable fail = () -> g.call("test", () -> { throw new QueryTimeoutException("x"); });
        fail.run();
        assertThat(g.available()).isTrue();
        fail.run();
        assertThat(g.available()).isTrue();
        fail.run();
        assertThat(g.available()).isFalse();
    }

    @Test @DisplayName("single-flight：負責讀 MySQL 的那一個失敗了，等它的人拿到的是「原本的」例外（不是 CompletionException → 500）")
    void waitersSeeTheOriginalException() throws Exception {
        CountDownLatch loading = new CountDownLatch(1), release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        Future<?> leader = pool.submit(() -> cache.get(PRODUCT, id -> {
            loading.countDown();
            try { release.await(); } catch (InterruptedException e) { throw new IllegalStateException(e); }
            throw new org.springframework.transaction.CannotCreateTransactionException("模擬：連線池逾時");
        }));
        loading.await();
        Future<?> waiter = pool.submit(() -> cache.get(PRODUCT, id -> { throw new AssertionError("不應該自己去讀"); }));
        Thread.sleep(100);
        release.countDown();
        assertThatThrownBy(leader::get).hasCauseInstanceOf(org.springframework.transaction.CannotCreateTransactionException.class);
        assertThatThrownBy(waiter::get).hasCauseInstanceOf(org.springframework.transaction.CannotCreateTransactionException.class);
        pool.shutdown();
    }

    static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
}
```

**`src/test/java/com/example/shop/ordering/internal/HotStockFlowTest.java`**（新增）

```java
package com.example.shop.ordering.internal;

import com.example.shop.inventory.InventoryApi;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.support.TestRedis;
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
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 6.5 熱點商品：Redis 的閘門 + MySQL 的落帳。每一個測試都檢查 Redis 與 MySQL 兩邊的數字 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
class HotStockFlowTest {

    static final long HOT = 9_900_651, SELLER = 2, BUYER = 990_651;

    @Autowired OrderingApi ordering;
    @Autowired OrderCommands commands;
    @Autowired InventoryApi inventory;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired ApplicationContext ctx;

    @BeforeEach
    void setUp() {
        cleanup();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '熱點測試', 100.00, 'ON_SALE', TRUE)", HOT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 3, 0)", HOT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 3, 0, 'INITIAL', 'hot-test')", HOT);
    }

    @AfterEach
    void cleanup() {
        for (String t : List.of("order_status_history", "order_items")) jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id BETWEEN ? AND ?", BUYER, BUYER + 99);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 99);
        jdbc.update("DELETE FROM orders WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 99);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM products WHERE id = ?", HOT);
        TestRedis.forgetProducts(redis, HOT);
    }

    OrderingApi.PlacedOrder place(long buyer, String price) {
        return ordering.placeOrder(buyer, "hot-" + buyer + "-" + System.nanoTime(), List.of(new OrderingApi.OrderLine(HOT, 1, new BigDecimal(price))));
    }

    String redisStock() { return redis.opsForValue().get("stock:" + HOT); }

    int mysqlAvailable() { return jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, HOT); }

    long reservations() { return jdbc.queryForObject("SELECT COUNT(*) FROM inventory_reservations WHERE product_id = ?", Long.class, HOT); }

    @Test @DisplayName("第一次下單時從 MySQL 建立 Redis 的副本；賣完之後的請求 409，連 MySQL 都不碰")
    void gateThenSoldOut() {
        for (int i = 0; i < 3; i++) place(BUYER + i, "100");
        assertThat(redisStock()).isEqualTo("0");
        assertThat(mysqlAvailable()).isZero();
        long before = reservations();
        assertThatThrownBy(() -> place(BUYER + 3, "100")).satisfies(e -> assertThat(((ShopException) e).type()).isEqualTo(ProblemType.INSUFFICIENT_STOCK));
        assertThat(reservations()).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM idempotency_keys WHERE buyer_id = ?", Long.class, BUYER + 3)).isZero();   // 冪等鍵也沒建
    }

    @Test @DisplayName("6.2.4：閘門過了、價格比對失敗 → 409 price-changed，Redis 減掉的要加回來")
    void wrongPriceGivesBack() {
        place(BUYER, "100");
        assertThat(redisStock()).isEqualTo("2");
        assertThatThrownBy(() -> place(BUYER + 1, "90")).satisfies(e -> assertThat(((ShopException) e).type()).isEqualTo(ProblemType.PRICE_CHANGED));
        assertThat(redisStock()).isEqualTo("2");
    }

    @Test @DisplayName("取消：MySQL commit 之後才加回 Redis；補貨也一樣")
    void cancelAndRestockAddBack() {
        String no = place(BUYER, "100").orderNo();
        assertThat(redisStock()).isEqualTo("2");
        commands.cancelByBuyer(BUYER, no);
        assertThat(redisStock()).isEqualTo("3");
        inventory.restock(HOT, 5, "hot-test");
        assertThat(redisStock()).isEqualTo("8");
        assertThat(mysqlAvailable()).isEqualTo(8);
    }

    @Test @DisplayName("6.6 對帳：Redis 跟 MySQL 不一樣，要「連續兩輪」都看到同一組才用 CAS 修正")
    void reconcileNeedsTwoRounds() throws Exception {
        place(BUYER, "100");
        redis.opsForValue().set("stock:" + HOT, "0");                                         // 模擬：漏了一次加回（6.2.4）
        Object hot = ctx.getBean(Class.forName("com.example.shop.inventory.internal.HotStock"));
        var reconcile = hot.getClass().getDeclaredMethod("reconcile");
        reconcile.setAccessible(true);
        reconcile.invoke(hot);
        assertThat(redisStock()).isEqualTo("0");                                              // 第一輪：只記下來
        reconcile.invoke(hot);
        assertThat(redisStock()).isEqualTo("2");                                              // 第二輪：修正成 MySQL 的值
    }

    @Test @DisplayName("重送（同一個冪等鍵）：訂單早就成立了，這一次閘門減掉的要還回去")
    void replayGivesBack() {
        List<OrderingApi.OrderLine> lines = List.of(new OrderingApi.OrderLine(HOT, 1, new BigDecimal("100")));
        ordering.placeOrder(BUYER, "same-key", lines);
        var again = ordering.placeOrder(BUYER, "same-key", lines);
        assertThat(again.replayed()).isTrue();
        assertThat(redisStock()).isEqualTo("2");
        assertThat(mysqlAvailable()).isEqualTo(2);
    }
}
```

**`src/test/java/com/example/shop/api/RateLimitTest.java`**（新增）

```java
package com.example.shop.api;

import com.example.shop.shared.security.AccessTokens;
import com.example.shop.support.TestRedis;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * 0.6.5 的限流、US-ORD-1 AC-8。這個類別把每 IP 每秒的上限改回需求的 50（測試環境預設把它拉高，src/test/resources/config/application.yml）
 */
@SpringBootTest(properties = {"shop.order.jobs-enabled=false", "shop.rate-limit.requests-per-ip-per-second=50"})
@AutoConfigureMockMvc
class RateLimitTest {

    static final long PRODUCT = 9_900_671, BUYER = 990_671;

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired AccessTokens tokens;

    @BeforeEach
    void setUp() {
        cleanup();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '限流測試', 100.00, 'ON_SALE')", PRODUCT);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100, 0)", PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 100, 0, 'INITIAL', 'rl')", PRODUCT);
    }

    @AfterEach
    void cleanup() {
        for (String t : java.util.List.of("order_status_history", "order_items")) jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM orders WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM cart_items WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
        TestRedis.forgetProducts(redis, PRODUCT);
        Set<String> keys = redis.keys("rl:orders:99067*");
        if (keys != null && !keys.isEmpty()) redis.delete(keys);
    }

    MockHttpServletResponse order(long buyer, String key) throws Exception {
        return mvc.perform(post("/api/orders").header("Authorization", TestTokens.bearer(tokens, buyer)).header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON).content("{\"items\": [{\"productId\": " + PRODUCT + ", \"quantity\": 1, \"unitPrice\": 100}]}"))
                .andReturn().getResponse();
    }

    @Test @DisplayName("ORD-1 AC-8：同一位買家 1 分鐘內第 11 張訂單 → 429，Retry-After 是到「最早那一張滿 1 分鐘」的秒數")
    void eleventhOrderIs429() throws Exception {
        for (int i = 0; i < 10; i++) assertThat(order(BUYER, "rl-" + i).getStatus()).isEqualTo(201);
        MockHttpServletResponse r = order(BUYER, "rl-10");
        assertThat(r.getStatus()).isEqualTo(429);
        assertThat(r.getContentAsString()).contains("/problems/rate-limited");
        assertThat(Long.parseLong(r.getHeader("Retry-After"))).isBetween(50L, 60L);
        assertThat(order(BUYER + 1, "rl-0").getStatus()).isEqualTo(201);                    // 別的買家不受影響
    }

    @Test @DisplayName("6.7.1：同一個 Idempotency-Key 的重送（連點、照 Retry-After 重送）不算新的一次")
    void replaysDoNotCount() throws Exception {
        assertThat(order(BUYER, "same").getStatus()).isEqualTo(201);
        Map<Integer, Integer> replays = new TreeMap<>();
        for (int i = 0; i < 15; i++) replays.merge(order(BUYER, "same").getStatus(), 1, Integer::sum);
        assertThat(replays).containsOnlyKeys(200);
        for (int i = 1; i < 10; i++) assertThat(order(BUYER, "other-" + i).getStatus()).isEqualTo(201);
        assertThat(order(BUYER, "eleventh").getStatus()).isEqualTo(429);
    }

    /** 70 個請求「同時」送出（依序送要將近 1 秒，會跨過兩個固定窗），從一秒的開頭開始 */
    Map<Integer, Integer> burst(String path) throws Exception {
        while (System.currentTimeMillis() % 1000 > 100) Thread.onSpinWait();
        var pool = java.util.concurrent.Executors.newFixedThreadPool(70);
        var go = new java.util.concurrent.CountDownLatch(1);
        java.util.List<java.util.concurrent.Future<Integer>> fs = new java.util.ArrayList<>();
        for (int i = 0; i < 70; i++) fs.add(pool.submit(() -> {
            go.await();
            return mvc.perform(get(path).with(r -> { r.setRemoteAddr("203.0.113.9"); return r; })).andReturn().getResponse().getStatus();
        }));
        go.countDown();
        Map<Integer, Integer> out = new TreeMap<>();
        for (var f : fs) out.merge(f.get(), 1, Integer::sum);
        pool.shutdown();
        return out;
    }

    @Test @DisplayName("0.6.5：同一個 IP 每秒 50 次；health 不限流（負載平衡器的探測不能被 429）")
    void perIpPerSecond() throws Exception {
        Map<Integer, Integer> ping = burst("/api/ping"), health = burst("/actuator/health/liveness");
        System.out.println("0.6.5：同一個 IP 70 次 /api/ping → " + ping + "；70 次 health → " + health);
        assertThat(ping).containsEntry(200, 50).containsEntry(429, 20);
        assertThat(health).containsOnlyKeys(200);
    }
}
```

**`src/test/java/com/example/shop/reporting/internal/TrendingTest.java`**（新增）

```java
package com.example.shop.reporting.internal;

import com.example.shop.support.TestRedis;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.assertj.core.api.Assertions.assertThat;

/** US-RPT-2 AC-2：近 24 小時下單量 Top 10；1 分鐘內重複讀，不重算 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
class TrendingTest {

    static final long A = 9_900_691, B = 9_900_692, BUYER = 990_691;

    @Autowired TrendingService trending;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;

    @BeforeEach
    void setUp() {
        cleanup();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '排行 A', 1.00, 'ON_SALE'), (?, 2, 11, '排行 B', 1.00, 'OFF_SHELF')", A, B);
        for (int i = 0; i < 3; i++) {
            jdbc.update("""
                    INSERT INTO orders (order_no, buyer_id, seller_id, status, total_amount, payment_deadline)
                    VALUES (?, ?, 2, 'PENDING_PAYMENT', 1.00, NOW(3) + INTERVAL 15 MINUTE)""", "29990101-00000" + i, BUYER);
            long id = jdbc.queryForObject("SELECT id FROM orders WHERE order_no = ?", Long.class, "29990101-00000" + i);
            jdbc.update("INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (?, ?, 'x', 1.00, 50), (?, ?, 'x', 1.00, 60)", id, A, id, B);
        }
        redis.delete(TrendingService.KEY);
    }

    @AfterEach
    void cleanup() {
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM products WHERE id IN (?, ?)", A, B);
        TestRedis.forgetProducts(redis, A, B);
    }

    @Test @DisplayName("RPT-2 AC-2：加總近 24 小時的下單量；已下架的商品不上首頁；第二次讀用 Redis 裡的那一份")
    void top10() {
        var first = trending.top10();
        assertThat(first.degraded()).isFalse();
        assertThat(first.items().get(0)).isEqualTo(new TrendingService.Item(A, "排行 A", 150));
        assertThat(first.items()).noneMatch(i -> i.productId() == B);
        jdbc.update("UPDATE order_items SET quantity = 1 WHERE product_id = ?", A);       // 改了資料……
        assertThat(trending.top10().items().get(0).quantity()).isEqualTo(150);            // ……1 分鐘內讀到的還是同一份（AC-2 允許 1 分鐘延遲）
        assertThat(redis.getExpire(TrendingService.KEY)).isBetween(1L, 60L);
    }
}
```

**`src/test/java/com/example/shop/shared/redis/RedisGuardTest.java`**（新增）

```java
package com.example.shop.shared.redis;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.dao.QueryTimeoutException;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/** 6.9.2 */
class RedisGuardTest {

    /** 可以手動往前撥的時鐘：每一輪撥過退避時間，讓 64 條執行緒都看到「Redis 可以用」 */
    static class ManualClock extends Clock {
        final AtomicLong millis = new AtomicLong(1_000_000);
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.ofEpochMilli(millis.get()); }
    }

    /**
     * docker pause 的樣子：卡住的指令在同一個瞬間一起逾時，64 條執行緒同時進到 tripped()。
     * Redis 失敗只能讓 call() 回傳 empty（降級），絕對不能變成例外（6.9.2：修正前 64 × 2,000 次呼叫裡有例外丟出去，請求變成 500）
     */
    @Test
    void simultaneousTimeoutsNeverEscape() throws Exception {
        ManualClock clock = new ManualClock();
        RedisGuard guard = new RedisGuard(clock, new SimpleMeterRegistry());
        int threads = 64, rounds = 2_000;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        Map<String, Integer> escaped = new ConcurrentHashMap<>();
        try {
            for (int r = 0; r < rounds; r++) {
                clock.millis.addAndGet(RedisGuard.BACKOFF.toMillis() + RedisGuard.WINDOW_MS + 1);
                CyclicBarrier together = new CyclicBarrier(threads);
                List<Future<?>> fs = new ArrayList<>();
                for (int t = 0; t < threads; t++)
                    fs.add(pool.submit(() -> {
                        together.await();
                        try {
                            assertThat(guard.call("test", () -> { throw new QueryTimeoutException("Redis command timed out"); })).isEmpty();
                        } catch (RuntimeException e) {
                            escaped.merge(e.getClass().getSimpleName(), 1, Integer::sum);
                        }
                        return null;
                    }));
                for (var f : fs) f.get();
            }
        } finally {
            pool.shutdownNow();
        }
        System.out.printf("RedisGuard：%d 輪 × %d 條執行緒同時逾時 → 丟出去的例外 %s%n", rounds, threads, escaped);
        assertThat(escaped).isEmpty();
    }
}
```

#### 實驗（`-Pexperiments`）

**`src/test/java/com/example/shop/catalog/internal/G1CacheInvalidationTest.java`**（新增；6.2.1、6.4.2）

```java
package com.example.shop.catalog.internal;

import com.example.shop.ShopApplication;
import com.example.shop.catalog.internal.ProductDtos.UpdateProductRequest;
import com.example.shop.support.TestRedis;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 6.2.1 US-PRD-3 AC-3：改價之後 1 秒內，詳情要讀到新價格。
 * 32 個讀者不停讀同一個商品，同時改價 200 次。每一次改價 commit 之後等 1 秒，看快取裡的價格是不是新的。
 *   ① 在交易裡刪快取（@Transactional 方法裡 cache.evict()：刪在 commit 之前）
 *   ② commit 之後刪快取（cache-aside 的教科書寫法）
 *   ③ 本專題：commit 之後寫入新值，帶版本號（ProductCache.putAfterCommit + SET_IF_NEWER）
 * ①② 的讀者：GET → 沒有 → 讀 MySQL → SET（沒有版本比較）。③ 的讀者：正式的 ProductService.detail()。
 */
@Tag("experiment")
class G1CacheInvalidationTest {

    static final long PRODUCT = 9_900_801, SELLER = 2;
    static final int WRITES = 200, READERS = 32;

    @Test
    void stalePriceAfterOneSecond() throws Exception {
        var app = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=WARN", "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false");
        JdbcTemplate jdbc = app.getBean(JdbcTemplate.class);
        StringRedisTemplate redis = app.getBean(StringRedisTemplate.class);
        TransactionTemplate tx = app.getBean(TransactionTemplate.class);
        ProductService service = app.getBean(ProductService.class);
        try {
            setUp(jdbc, redis);
            System.out.printf("═══ 6.2.1 改價 %d 次，%d 個讀者同時在讀；每次 commit 之後 1 秒，快取裡的價格還是舊的嗎？═══%n", WRITES, READERS);
            for (String way : List.of("① 交易裡刪", "② commit 之後刪", "③ commit 之後寫入新值 + 版本號")) {
                TestRedis.forgetProducts(redis, PRODUCT);
                AtomicBoolean stop = new AtomicBoolean();
                ExecutorService readers = Executors.newFixedThreadPool(READERS);
                for (int i = 0; i < READERS; i++) readers.submit(() -> {
                    while (!stop.get()) {
                        if (way.startsWith("③")) service.detail(PRODUCT, null);
                        else naiveRead(jdbc, redis);
                    }
                    return null;
                });
                int stale = 0;
                List<String> examples = new ArrayList<>();
                for (int i = 1; i <= WRITES; i++) {
                    BigDecimal price = new BigDecimal(1000 + i).setScale(2);
                    switch (way.charAt(0)) {
                        case '①' -> tx.executeWithoutResult(s -> {
                            redis.delete(ProductCache.key(PRODUCT));
                            jdbc.update("UPDATE products SET price = ?, version = version + 1 WHERE id = ?", price, PRODUCT);
                        });
                        case '②' -> {
                            tx.executeWithoutResult(s -> jdbc.update("UPDATE products SET price = ?, version = version + 1 WHERE id = ?", price, PRODUCT));
                            redis.delete(ProductCache.key(PRODUCT));
                        }
                        default -> service.update(SELLER, PRODUCT, new UpdateProductRequest(null, null, price, null));
                    }
                    Thread.sleep(1000);
                    String cached = redis.opsForValue().get(ProductCache.key(PRODUCT));
                    if (cached != null && !cached.contains("\"price\":" + price)) {
                        stale++;
                        if (examples.size() < 2) examples.add("第 " + i + " 次：MySQL " + price + "、快取 " + cached.replaceAll(".*\"price\":([0-9.]+).*", "$1"));
                    }
                }
                stop.set(true);
                readers.shutdown();
                readers.awaitTermination(10, TimeUnit.SECONDS);
                System.out.printf("  %-20s 1 秒後仍是舊價格：%3d / %d 次  %s%n", way, stale, WRITES, examples);
            }
        } finally {
            jdbc.update("DELETE FROM audit_logs WHERE target_type = 'PRODUCT' AND target_id = ?", String.valueOf(PRODUCT));
            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
            jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
            TestRedis.forgetProducts(redis, PRODUCT);
            app.close();
        }
    }

    /**
     * ② 的競態需要「讀的人在 commit 之前讀到舊值、在刪除之後才寫回」—— 也就是改價的那一刻，快取剛好是空的。
     * 正常情況下那很少見（快取 10 分鐘才過期一次），這裡讓它每一次都發生：改價前先刪掉 key（= TTL 剛好到期）。
     */
    @Test
    void expiryAtTheMomentOfWrite() throws Exception {
        var app = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=WARN", "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false");
        JdbcTemplate jdbc = app.getBean(JdbcTemplate.class);
        StringRedisTemplate redis = app.getBean(StringRedisTemplate.class);
        TransactionTemplate tx = app.getBean(TransactionTemplate.class);
        ProductService service = app.getBean(ProductService.class);
        int writes = 100;
        try {
            setUp(jdbc, redis);
            System.out.printf("═══ 6.2.1 同上，但每次改價前快取剛好過期（%d 次）═══%n", writes);
            for (String way : List.of("② commit 之後刪", "③ commit 之後寫入新值 + 版本號")) {
                if (Boolean.getBoolean("only3") && way.startsWith("②")) continue;
                TestRedis.forgetProducts(redis, PRODUCT);
                AtomicBoolean stop = new AtomicBoolean();
                ExecutorService readers = Executors.newFixedThreadPool(READERS);
                for (int i = 0; i < READERS; i++) readers.submit(() -> {
                    while (!stop.get()) {
                        if (way.startsWith("③")) service.detail(PRODUCT, null); else naiveRead(jdbc, redis);
                    }
                    return null;
                });
                int stale = 0;
                for (int i = 1; i <= writes; i++) {
                    BigDecimal price = new BigDecimal(5000 + i).setScale(2);
                    retry(() -> redis.delete(ProductCache.key(PRODUCT)));      // 快取剛好過期
                    if (way.startsWith("②")) {
                        tx.executeWithoutResult(s -> jdbc.update("UPDATE products SET price = ?, version = version + 1 WHERE id = ?", price, PRODUCT));
                        retry(() -> redis.delete(ProductCache.key(PRODUCT)));
                    } else {
                        service.update(SELLER, PRODUCT, new UpdateProductRequest(null, null, price, null));
                    }
                    Thread.sleep(1000);
                    String cached = retry(() -> redis.opsForValue().get(ProductCache.key(PRODUCT)));
                    if (cached != null && !cached.contains("\"price\":" + price)) {
                        stale++;
                        System.out.println("    第 " + i + " 次：MySQL " + jdbc.queryForMap("SELECT price, version FROM products WHERE id = ?", PRODUCT)
                                + "；快取 " + cached.replaceAll(".*(\"price\":[0-9.]+).*(\"version\":[0-9]+).*", "$1 $2").replaceAll("^\\{.*", cached));
                    }
                }
                stop.set(true);
                readers.shutdown();
                readers.awaitTermination(10, TimeUnit.SECONDS);
                double failures = app.getBean(io.micrometer.core.instrument.MeterRegistry.class).get("shop.redis.failures").counter().count();
                System.out.printf("  %-20s 1 秒後仍是舊價格：%3d / %d 次（累計 Redis 失敗 %.0f 次）%n", way, stale, writes, failures);
            }
        } finally {
            jdbc.update("DELETE FROM audit_logs WHERE target_type = 'PRODUCT' AND target_id = ?", String.valueOf(PRODUCT));
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
            jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
            TestRedis.forgetProducts(redis, PRODUCT);
            app.close();
        }
    }

    /** 實驗自己的 Redis 操作（模擬過期、檢查快取）：逾時就再試 —— 它們不是被量的對象 */
    static <T> T retry(java.util.function.Supplier<T> op) {
        for (int i = 0; ; i++) {
            try { return op.get(); } catch (org.springframework.dao.QueryTimeoutException e) { if (i >= 5) throw e; }
        }
    }

    static void setUp(JdbcTemplate jdbc, StringRedisTemplate redis) {
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '改價實驗', 1000.00, 'ON_SALE')", PRODUCT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", PRODUCT);
        TestRedis.forgetProducts(redis, PRODUCT);
    }

    /** 教科書的 cache-aside：GET → 沒有 → 讀 MySQL → SET（TTL 10 分鐘，沒有版本比較） */
    static void naiveRead(JdbcTemplate jdbc, StringRedisTemplate redis) {
        String k = ProductCache.key(PRODUCT);
        if (redis.opsForValue().get(k) != null) return;
        BigDecimal price = jdbc.queryForObject("SELECT price FROM products WHERE id = ?", BigDecimal.class, PRODUCT);
        redis.opsForValue().set(k, "{\"id\":" + PRODUCT + ",\"price\":" + price + "}", Duration.ofMinutes(10));
    }
}
```

**`src/test/java/com/example/shop/catalog/internal/G2StampedeTest.java`**（新增；6.2.2）

```java
package com.example.shop.catalog.internal;

import com.example.shop.ShopApplication;
import com.example.shop.shared.redis.RedisGuard;
import com.example.shop.support.TestRedis;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.LongFunction;

/**
 * 6.2.2 快取擊穿（0.6.1 第 4 條）：熱點商品的快取過期的那一瞬間，200 個請求同時進來。MySQL 被讀了幾次？
 *   naive：GET → 沒有 → 讀 MySQL → SET（每一個請求各自做）
 *   ours ：ProductCache.get（同一台機器、同一個商品，同一時間只有一個去讀）
 * 「3 台機器」= 3 個各自獨立的 ProductCache（各有自己的 single-flight），共用同一個 Redis。
 */
@Tag("experiment")
class G2StampedeTest {

    static final long PRODUCT = 1;
    static final int REQUESTS = 200;

    @Test
    void twoHundredMissesAtOnce() throws Exception {
        var app = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=WARN", "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false");
        try {
            JdbcTemplate jdbc = app.getBean(JdbcTemplate.class);
            StringRedisTemplate redis = app.getBean(StringRedisTemplate.class);
            ProductService service = app.getBean(ProductService.class);
            AtomicInteger loads = new AtomicInteger();
            LongFunction<Optional<ProductCache.Core>> loader = id -> {
                loads.incrementAndGet();
                // 跟正式的 load() 一樣是一次 MySQL 讀取（加上 category 那一次 lazy 載入的代價，這裡用 JOIN 一次讀完）
                return Optional.of(jdbc.queryForObject("""
                        SELECT p.id, p.seller_id, p.name, p.description, p.price, p.category_id, p.status, p.hot, p.version FROM products p WHERE p.id = ?""",
                        (rs, i) -> new ProductCache.Core(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4), rs.getBigDecimal(5),
                                rs.getLong(6), com.example.shop.catalog.ProductStatus.valueOf(rs.getString(7)), rs.getBoolean(8), rs.getInt(9)), id));
            };
            ObjectMapper json = app.getBean(ObjectMapper.class);
            RedisGuard guard = app.getBean(RedisGuard.class);
            System.out.printf("═══ 6.2.2 快取裡沒有商品 %d，%d 個請求同時讀（每種 5 輪）═══%n", PRODUCT, REQUESTS);
            for (String way : List.of("naive（各自讀）", "ours，1 台", "ours，3 台")) {
                List<String> rounds = new ArrayList<>();
                for (int round = 0; round < 5; round++) {
                    TestRedis.forgetProducts(redis, PRODUCT);
                    loads.set(0);
                    int instances = way.endsWith("3 台") ? 3 : 1;
                    List<ProductCache> caches = new ArrayList<>();
                    for (int i = 0; i < instances; i++) caches.add(new ProductCache(redis, guard, json));
                    ExecutorService pool = Executors.newFixedThreadPool(REQUESTS);
                    CountDownLatch go = new CountDownLatch(1);
                    List<Future<Long>> fs = new ArrayList<>();
                    for (int i = 0; i < REQUESTS; i++) {
                        ProductCache c = caches.get(i % instances);
                        fs.add(pool.submit(() -> {
                            go.await();
                            long s = System.nanoTime();
                            if (way.startsWith("naive")) naive(redis, c, loader); else c.get(PRODUCT, loader);
                            return System.nanoTime() - s;
                        }));
                    }
                    go.countDown();
                    long max = 0;
                    for (var f : fs) max = Math.max(max, f.get());
                    pool.shutdown();
                    rounds.add("MySQL %3d 次、最慢 %5.1f ms".formatted(loads.get(), max / 1e6));
                }
                System.out.printf("  %-14s %s%n", way, String.join(" │ ", rounds));
            }
            service.detail(PRODUCT, null);
        } finally {
            TestRedis.forgetProducts(app.getBean(StringRedisTemplate.class), PRODUCT);
            app.close();
        }
    }

    static void naive(StringRedisTemplate redis, ProductCache cache, LongFunction<Optional<ProductCache.Core>> loader) {
        if (redis.opsForValue().get(ProductCache.key(PRODUCT)) != null) return;
        loader.apply(PRODUCT).ifPresent(cache::put);
    }
}
```

**`src/test/java/com/example/shop/catalog/internal/G3CacheHitConnectionTest.java`**（新增；6.2.3）

```java
package com.example.shop.catalog.internal;

import com.example.shop.ShopApplication;
import com.example.shop.inventory.InventoryApi;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Map;

/**
 * 6.2.3 商品詳情「快取命中」的時候，MySQL 收到了什麼？
 * 同一個商品先讀一次（填好快取），再依序讀 1,000 次。量 MySQL 的 Questions（伺服器收到的每一句指令都算，包括 SET、COMMIT）
 * 與 Hikari 的「拿連線」次數（hikaricp.connections.acquire）。
 *   ① 包在一個 @Transactional(readOnly = true) 裡（這一章第一版的 detail() 就是這樣：沿用第 03 章的寫法）
 *   ② 沒有外層交易（現在的 detail()：只有快取沒命中時的 load() 有自己的交易）
 */
@Tag("experiment")
class G3CacheHitConnectionTest {

    static final long PRODUCT = 3, N = 1000;

    @Test
    void whatMysqlSeesOnACacheHit() throws Exception {
        var app = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=WARN", "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false");
        try {
            JdbcTemplate root = new JdbcTemplate(new org.springframework.jdbc.datasource.DriverManagerDataSource(
                    "jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true", "root", "root"));
            ProductService service = app.getBean(ProductService.class);
            ProductCache cache = app.getBean(ProductCache.class);
            InventoryApi inventory = app.getBean(InventoryApi.class);
            MeterRegistry meters = app.getBean(MeterRegistry.class);
            readOnly = new org.springframework.transaction.support.TransactionTemplate(app.getBean(org.springframework.transaction.PlatformTransactionManager.class));
            readOnly.setReadOnly(true);
            service.detail(PRODUCT, null);                                        // 填好快取（商品與 5 秒的可售量）
            System.out.printf("═══ 6.2.3 商品 %d 已在快取裡，依序讀 %,d 次 ═══%n", PRODUCT, N);
            for (String way : List.of("① 外層有 @Transactional(readOnly = true)", "② 沒有外層交易（現在的 detail）")) {
                for (int warm = 0; warm < 100; warm++) read(way, service, cache, inventory);
                long q0 = questions(root), a0 = acquires(meters);
                long s = System.nanoTime();
                for (int i = 0; i < N; i++) read(way, service, cache, inventory);
                double ms = (System.nanoTime() - s) / 1e6 / N;
                long q = questions(root) - q0 - 1, a = acquires(meters) - a0;   // -1：量 Questions 本身那一句
                System.out.printf("  %-40s MySQL 收到 %5d 句（每次 %.2f）│ 拿連線 %5d 次 │ 平均 %.3f ms%n", way, q, q / (double) N, a, ms);
            }
            System.out.println("  ① 的一次請求，MySQL 的 general log 長這樣：");
            root.execute("SET GLOBAL log_output = 'TABLE'");
            root.execute("TRUNCATE TABLE mysql.general_log");
            root.execute("SET GLOBAL general_log = 'ON'");
            read("①", service, cache, inventory);
            root.execute("SET GLOBAL general_log = 'OFF'");
            for (Map<String, Object> r : root.queryForList("SELECT argument FROM mysql.general_log WHERE command_type = 'Query' AND user_host LIKE 'shop%' ORDER BY event_time"))
                System.out.println("    " + new String((byte[]) r.get("argument")));
        } finally {
            app.close();
        }
    }

    static org.springframework.transaction.support.TransactionTemplate readOnly;

    static void read(String way, ProductService service, ProductCache cache, InventoryApi inventory) {
        if (way.startsWith("①")) readOnly.executeWithoutResult(s -> service.detail(PRODUCT, null));
        else service.detail(PRODUCT, null);
    }

    static long questions(JdbcTemplate root) {
        return Long.parseLong(root.queryForMap("SHOW GLOBAL STATUS LIKE 'Questions'").get("Value").toString());
    }

    static long acquires(MeterRegistry meters) {
        return meters.find("hikaricp.connections.acquire").timers().stream().mapToLong(t -> t.count()).sum();
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/G4HotGateLeakTest.java`**（新增；6.2.4）

```java
package com.example.shop.ordering.internal;

import com.example.shop.ShopApplication;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
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
 * 6.2.4 熱點閘門（6.5）的補償。熱點商品庫存 100 件，Redis 與 MySQL 一致。
 *   第一波：100 個買家帶「舊的價格」下單 → 全部 409 price-changed（價格比對在 MySQL 的交易裡，閘門已經減過了）
 *   第二波：100 個買家帶正確的價格下單 → 應該 100 個都成立
 *   naive：閘門 → 下單；失敗就讓例外丟出去（沒有把 Redis 減掉的加回來）
 *   ours ：PlaceOrderService.placeOrder（每一條失敗的路徑都 returnHot）
 * 最後跑兩輪對帳（HotStock.reconcile 要連續兩輪看到才修正），看它能不能把 naive 漏掉的數字補回來。
 */
@Tag("experiment")
class G4HotGateLeakTest {

    static final long HOT = 9_900_901, SELLER = 2, FIRST_BUYER = 3_100_000;

    @Test
    void forgottenGiveBack() throws Exception {
        var app = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=ERROR", "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false");
        JdbcTemplate jdbc = app.getBean(JdbcTemplate.class);
        StringRedisTemplate redis = app.getBean(StringRedisTemplate.class);
        PlaceOrderService orders = app.getBean(PlaceOrderService.class);
        InventoryApi inventory = app.getBean(InventoryApi.class);
        try {
            System.out.println("═══ 6.2.4 熱點商品庫存 100 件：100 個帶舊價格的 409 之後，100 個帶正確價格的買家能買到幾件？═══");
            for (String impl : List.of("naive", "ours")) {
                reset(jdbc, redis);
                Map<String, Integer> first = wave(impl, orders, inventory, FIRST_BUYER, "90");
                String afterFirst = state(jdbc, redis);
                Map<String, Integer> second = wave(impl, orders, inventory, FIRST_BUYER + 1000, "100");
                String afterSecond = state(jdbc, redis);
                var hot = app.getBean(Class.forName("com.example.shop.inventory.internal.HotStock"));
                var reconcile = hot.getClass().getDeclaredMethod("reconcile");
                reconcile.setAccessible(true);
                int fixed = (int) reconcile.invoke(app.getBean(hot.getClass())) + (int) reconcile.invoke(app.getBean(hot.getClass()));
                System.out.printf("  %-6s 第一波 %-24s → %s%n         第二波 %-24s → %s%n         對帳兩輪：修正 %d 個商品 → %s%n",
                        impl, first, afterFirst, second, afterSecond, fixed, state(jdbc, redis));
                cleanup(jdbc);
            }
        } finally {
            cleanup(jdbc);
            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", HOT);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", HOT);
            jdbc.update("DELETE FROM products WHERE id = ?", HOT);
            TestRedis.forgetProducts(redis, HOT);
            app.close();
        }
    }

    static Map<String, Integer> wave(String impl, PlaceOrderService orders, InventoryApi inventory, long firstBuyer, String price) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(20);
        List<Future<String>> fs = new ArrayList<>();
        for (int i = 0; i < 100; i++) {
            long buyer = firstBuyer + i;
            List<OrderingApi.OrderLine> lines = List.of(new OrderingApi.OrderLine(HOT, 1, new BigDecimal(price)));
            fs.add(pool.submit(() -> {
                try {
                    if (impl.equals("naive")) {
                        inventory.gateHot(List.of(new ReserveLine(HOT, 1)));
                        PlaceOrderService.validate(lines);
                        var m = PlaceOrderService.class.getDeclaredMethod("placeGated", long.class, String.class, List.class, List.class);
                        m.setAccessible(true);
                        try { m.invoke(orders, buyer, "g4-" + buyer, lines, List.of()); }
                        catch (java.lang.reflect.InvocationTargetException e) { throw (Exception) e.getCause(); }
                    } else {
                        orders.placeOrder(buyer, "g4-" + buyer, lines);
                    }
                    return "201";
                } catch (ShopException e) {
                    return e.type().status().value() + " " + e.type().type();
                }
            }));
        }
        Map<String, Integer> r = new TreeMap<>();
        for (var f : fs) r.merge(f.get(), 1, Integer::sum);
        pool.shutdown();
        return r;
    }

    static String state(JdbcTemplate jdbc, StringRedisTemplate redis) {
        return "Redis " + redis.opsForValue().get("stock:" + HOT) + "、MySQL 可售 "
                + jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, HOT);
    }

    static void reset(JdbcTemplate jdbc, StringRedisTemplate redis) {
        cleanup(jdbc);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM products WHERE id = ?", HOT);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '熱點商品', 100.00, 'ON_SALE', TRUE)", HOT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100, 0)", HOT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 100, 0, 'INITIAL', 'g4')", HOT);
        TestRedis.forgetProducts(redis, HOT);
        redis.opsForValue().set("stock:" + HOT, "100");
    }

    static void cleanup(JdbcTemplate jdbc) {
        long lo = FIRST_BUYER, hi = FIRST_BUYER + 2000;
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", HOT);
        jdbc.update("UPDATE inventory SET reserved = 0 WHERE product_id = ?", HOT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ? AND reason = 'RESERVE'", HOT);
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/G5LockAroundTransactionTest.java`**（新增；6.2.5）

```java
package com.example.shop.inventory.internal;

import com.example.shop.ShopApplication;
import com.example.shop.shared.redis.DistributedLock;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 6.2.5、6.6 Redis 的庫存副本，要怎麼跟 MySQL 對帳？三種寫法、兩種情境：
 *   情境 A：補貨（+1）× 300 次，同時有一個對帳在跑
 *   情境 B：同上，再加上取消（+1，commit 之後加回 Redis，不拿鎖）× 300 次
 *   V1：補貨拿鎖，@Transactional 方法裡 try { 改 MySQL、加 Redis } finally { 放鎖 } —— 鎖在 commit 之前放掉
 *   V2：補貨拿鎖，commit 之後加 Redis、afterCompletion 才放鎖 —— 鎖包住交易
 *   V3：沒有鎖；對帳用 CAS（只在 Redis 的值從頭到尾沒變時才寫入）
 *   V1、V2 的對帳：拿鎖 → 讀 MySQL → SET Redis → 放鎖。V3 的對帳：讀 Redis → 讀 MySQL → CAS
 * 對帳只在前 2/3 的期間跑（真實的對帳是每分鐘一次：兩次之間被它弄出來的偏差會一直留著），之後補貨、取消繼續做完。
 * 最後比 Redis 與 MySQL 的可售量：Redis 比較少 = 少賣（該賣的賣不出去）；比較多 = 多放一些請求進 MySQL（安全）。
 */
@Tag("experiment")
class G5LockAroundTransactionTest {

    static final long P = 9_900_911;
    static final int OPS = 200, ROUNDS = 20;

    JdbcTemplate jdbc;
    StringRedisTemplate redis;
    TransactionTemplate tx;
    DistributedLock locks;

    @Test
    void reconcileWhileStockChanges() throws Exception {
        var app = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=ERROR", "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false");
        jdbc = app.getBean(JdbcTemplate.class);
        redis = app.getBean(StringRedisTemplate.class);
        tx = app.getBean(TransactionTemplate.class);
        locks = app.getBean(DistributedLock.class);
        try {
            System.out.printf("═══ 6.6 每輪：補貨（與取消）各 %d 次，前 2/3 的期間同時對帳；看結束時 Redis − MySQL，每種 %d 輪 ═══%n", OPS, ROUNDS);
            for (String scenario : List.of("A 補貨", "B 補貨 + 取消")) {
                for (String v : List.of("V1 鎖在 commit 前放掉", "V2 鎖包住交易", "V3 不用鎖，對帳用 CAS")) {
                    java.util.Map<String, Integer> outcome = new java.util.TreeMap<>();
                    for (int round = 0; round < ROUNDS; round++) {
                        int d = run(v.substring(0, 2), scenario.startsWith("B"));
                        outcome.merge(d < 0 ? "少賣（" + d + "）" : d > 0 ? "多算（+" + d + "）" : "一致", 1, Integer::sum);
                    }
                    System.out.printf("  %-12s %-20s %s%n", scenario, v, outcome);
                }
            }
        } finally {
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", P);
            redis.delete(HotStock.key(P));
            app.close();
        }
    }

    int run(String v, boolean releases) throws Exception {
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", P);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 50000)", P);
        redis.opsForValue().set(HotStock.key(P), "50000");
        AtomicBoolean done = new AtomicBoolean();
        ExecutorService pool = Executors.newFixedThreadPool(3);
        Future<?> restocks = pool.submit(() -> {
            for (int i = 0; i < OPS; i++) { if (i == OPS * 2 / 3) done.set(true); restock(v); }
            return null;
        });
        Future<?> cancels = pool.submit(() -> { if (releases) for (int i = 0; i < OPS; i++) release(); return null; });
        Future<?> reconciler = pool.submit(() -> { while (!done.get()) reconcile(v); return null; });
        reconciler.get();
        restocks.get();
        cancels.get();
        pool.shutdown();
        int r = Integer.parseInt(redis.opsForValue().get(HotStock.key(P)));
        int d = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, P);
        return r - d;
    }

    void incr() { redis.execute(HotStock.RETURN, List.of(HotStock.key(P)), "1"); }

    void afterCommit(Runnable r) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { r.run(); }
        });
    }

    DistributedLock.Handle lock() {
        while (true) {
            var h = locks.tryLock("lock:" + HotStock.key(P), Duration.ofSeconds(5));
            if (h.isPresent()) return h.get();
            Thread.onSpinWait();
        }
    }

    void restock(String v) {
        switch (v) {
            case "V1" -> tx.executeWithoutResult(s -> {                       // 「照直覺寫」：@Transactional 方法裡 lock / finally unlock
                var h = lock();
                try {
                    jdbc.update("UPDATE inventory SET on_hand = on_hand + 1 WHERE product_id = ?", P);
                    incr();
                } finally {
                    locks.unlock(h);
                }
            });
            case "V2" -> tx.executeWithoutResult(s -> {
                var h = lock();
                jdbc.update("UPDATE inventory SET on_hand = on_hand + 1 WHERE product_id = ?", P);
                afterCommit(this::incr);
                locks.unlockAfterTransaction(h);                              // afterCompletion：在 afterCommit 的 incr 之後
            });
            default -> tx.executeWithoutResult(s -> {
                jdbc.update("UPDATE inventory SET on_hand = on_hand + 1 WHERE product_id = ?", P);
                afterCommit(this::incr);                                      // 正式的 HotStock.giveBackAfterCommit
            });
        }
    }

    /** 取消：reserved − 1，commit 之後加回 Redis。不拿鎖（正式的 JdbcInventoryService.release 也不拿） */
    void release() {
        tx.executeWithoutResult(s -> {
            jdbc.update("UPDATE inventory SET reserved = reserved - 1 WHERE product_id = ?", P);
            afterCommit(this::incr);
        });
    }

    void reconcile(String v) {
        if (v.equals("V3")) {
            String before = redis.opsForValue().get(HotStock.key(P));
            Integer d = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, P);
            redis.execute(HotStock.CAS, List.of(HotStock.key(P)), before, String.valueOf(d));
            return;
        }
        var h = lock();
        try {
            Integer d = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, P);
            redis.opsForValue().set(HotStock.key(P), String.valueOf(d));
        } finally {
            locks.unlock(h);
        }
    }
}
```

**`src/test/java/com/example/shop/ch06/G6HotFlashSaleTest.java`**（新增；6.5.4）

```java
package com.example.shop.ch06;

import com.example.shop.ch04.E7FlashSaleLoadTest;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * 6.5.4 第 04 章 4.8 的搶購壓測（E7）原封不動，只改一件事：商品是不是熱點（hot）。
 *   hot = false：第 04 章的路徑（MySQL 條件式 UPDATE）
 *   hot = true ：這一章的路徑（Redis 閘門 → MySQL 落帳）
 * 兩種交錯跑（避免「後跑的比較快」），平台執行緒（0.9.2 的預設，4.8.3）。
 */
@Tag("experiment")
class G6HotFlashSaleTest {

    @Test
    void sameLoadHotVersusNot() throws Exception {
        E7FlashSaleLoadTest.flashSale(false, 0, true);                        // 暖機
        System.out.println("═══ 6.5.4 2,000 個買家搶 500 件；0.6.2 的負載：每秒 200 個請求、10 秒（開放式）═══");
        for (boolean hot : new boolean[]{false, true, false, true, false, true}) print(hot, E7FlashSaleLoadTest.flashSale(false, 200, hot));
        System.out.println("═══ 6.5.4 同樣 2,000 個買家；200 個並行的客戶端（封閉式）═══");
        for (boolean hot : new boolean[]{false, true, false, true}) print(hot, E7FlashSaleLoadTest.flashSale(false, 0, hot));
    }

    static void print(boolean hot, Object run) throws Exception {
        var r = (java.lang.reflect.RecordComponent[]) run.getClass().getRecordComponents();
        java.util.Map<String, Object> v = new java.util.LinkedHashMap<>();
        for (var c : r) v.put(c.getName(), c.getAccessor().invoke(run));
        System.out.printf("  %-8s HTTP %s │ %5.2f 秒 │ p50 %5.0f  p95 %5.0f  p99 %5.0f  最慢 %5.0f ms │ reserved=%s 明細=%s RESERVE 帳=%s │ 連線池：同時使用最多 %s、等待最多 %s%n",
                hot ? "熱點" : "一般", v.get("statuses"), v.get("seconds"), v.get("p50"), v.get("p95"), v.get("p99"), v.get("max"),
                v.get("reserved"), v.get("orders"), v.get("ledger"), v.get("maxActive"), v.get("maxPending"));
        if (!((java.util.Map<?, ?>) v.get("retried")).isEmpty()) System.out.printf("           └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP %s%n", v.get("retried"));
    }
}
```

**`src/test/java/com/example/shop/ch06/G6bDiagnoseTest.java`**（新增；6.5.4 的「一般路徑有沒有變慢」）

```java
package com.example.shop.ch06;

import com.example.shop.ch04.E7FlashSaleLoadTest;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/** 6.5.4 追查：「一般」路徑在這一章變慢，是不是因為 Redis 逾時讓 RedisGuard 跳開？跑兩輪，保留 WARN 日誌 */
@Tag("experiment")
class G6bDiagnoseTest {
    @Test
    void normalPathWithLogs() throws Exception {
        E7FlashSaleLoadTest.flashSale(false, 200, false);
        for (int i = 0; i < 2; i++) {
            var r = E7FlashSaleLoadTest.flashSale(false, 200, false);
            System.out.printf("  一般 HTTP %s │ p50 %.0f p99 %.0f ms │ 等待最多 %d%n", r.statuses(), r.p50(), r.p99(), r.maxPending());
        }
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/G7BulkheadTest.java`**（新增；6.9.1）

```java
package com.example.shop.ordering.internal;

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
 * 6.9.1 0.6.3「下單（熱點商品）× Redis 掛了 = 503」的理由：艙壁（bulkhead）。
 * 熱點商品每秒 200 個下單（10 秒），同時一般商品每秒 20 個下單（50 個不同的商品）。量「一般商品」的延遲：
 *   ① Redis 正常：熱點走閘門（6.5）
 *   ② Redis 停掉，熱點「退回 MySQL」：跳過閘門，直接走下單交易（第 04 章的路徑）
 *   ③ Redis 停掉，熱點回 503（本專題）
 * 在 Service 層呼叫：200 條共用的執行緒（= Tomcat 的 maxThreads）、同一個連線池 20 條。開放式負載：延遲從「預定送出的時間」算起（4.8.1），包含排隊。
 */
@Tag("experiment")
class G7BulkheadTest {

    static final long HOT = 9_900_701, FIRST_NORMAL = 9_900_710, HOT_BUYER = 3_200_000, NORMAL_BUYER = 3_300_000;
    static final int NORMALS = 50;

    @Test
    void hotFallbackDragsEveryoneDown() throws Exception {
        var app = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=ERROR", "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false");
        JdbcTemplate jdbc = app.getBean(JdbcTemplate.class);
        StringRedisTemplate redis = app.getBean(StringRedisTemplate.class);
        PlaceOrderService orders = app.getBean(PlaceOrderService.class);
        var placeGated = PlaceOrderService.class.getDeclaredMethod("placeGated", long.class, String.class, List.class, List.class);
        placeGated.setAccessible(true);
        try {
            reset(jdbc, redis);
            load(orders, placeGated, false);                                   // 暖機（JIT、連線池），不計
            System.out.println("═══ 6.9.1 熱點每秒 200 個下單 + 一般商品每秒 20 個下單，各 10 秒 ═══");
            if (!Boolean.getBoolean("only600"))
                run(jdbc, redis, orders, placeGated, List.of("① Redis 正常", "② Redis 停掉，熱點退回 MySQL", "③ Redis 停掉，熱點回 503",
                        "① Redis 正常", "② Redis 停掉，熱點退回 MySQL", "③ Redis 停掉，熱點回 503"));
            hotRps = 600;
            System.out.println("═══ 6.9.1 熱點每秒 600 個下單（0.6.1：200 個 × 失敗後平均再按 2 次）+ 一般商品每秒 20 個下單，各 10 秒 ═══");
            run(jdbc, redis, orders, placeGated, List.of("② Redis 停掉，熱點退回 MySQL", "③ Redis 停掉，熱點回 503",
                    "② Redis 停掉，熱點退回 MySQL", "③ Redis 停掉，熱點回 503"));
        } finally {
            reset(jdbc, redis);
            for (long id = HOT; id < FIRST_NORMAL + NORMALS; id++) {
                jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", id);
                jdbc.update("DELETE FROM inventory WHERE product_id = ?", id);
                jdbc.update("DELETE FROM products WHERE id = ?", id);
                TestRedis.forgetProducts(redis, id);
            }
            app.close();
        }
    }

    static void run(JdbcTemplate jdbc, StringRedisTemplate redis, PlaceOrderService orders, java.lang.reflect.Method placeGated, List<String> ways) throws Exception {
        for (String way : ways) {
            reset(jdbc, redis);
            boolean down = !way.startsWith("①");
            if (down) docker("stop", "shop-redis-1");
            try {
                var r = load(orders, placeGated, way.startsWith("②"));
                System.out.printf("  %-24s 熱點 %-34s │ 一般 %-14s p50 %5.0f  p95 %5.0f  p99 %5.0f ms%n", way, r.hot, r.normal, r.p50, r.p95, r.p99);
            } finally {
                if (down) { docker("start", "shop-redis-1"); waitForRedis(redis); }
            }
        }
    }

    record Result(Map<String, Integer> hot, Map<String, Integer> normal, double p50, double p95, double p99) {}

    static int hotRps = 200;

    /**
     * 200 條共用的「伺服器執行緒」（= Tomcat 預設的 maxThreads），熱點與一般的請求都在這裡排隊。
     * 一個 dispatcher 照時間表把請求放進佇列（開放式）；延遲從預定時間算起，包含排隊的時間。
     */
    static Result load(PlaceOrderService orders, java.lang.reflect.Method placeGated, boolean fallback) throws Exception {
        ExecutorService server = Executors.newFixedThreadPool(200);
        ConcurrentHashMap<String, Integer> hot = new ConcurrentHashMap<>(), normal = new ConcurrentHashMap<>();
        ConcurrentLinkedQueue<Long> lat = new ConcurrentLinkedQueue<>();
        record Job(long due, Callable<Void> task) {}
        List<Job> jobs = new ArrayList<>();
        long start = System.nanoTime() + 100_000_000L;
        for (int i = 0; i < hotRps * 10; i++) {
            long due = start + i * (1_000_000_000L / hotRps), buyer = HOT_BUYER + i;
            List<OrderingApi.OrderLine> lines = List.of(new OrderingApi.OrderLine(HOT, 1, new BigDecimal("1990")));
            jobs.add(new Job(due, () -> {
                hot.merge(outcome(() -> {
                    if (fallback) placeGated.invoke(orders, buyer, "g7-" + buyer, lines, List.of());
                    else orders.placeOrder(buyer, "g7-" + buyer, lines);
                }), 1, Integer::sum);
                return null;
            }));
        }
        for (int i = 0; i < 200; i++) {
            long due = start + i * 50_000_000L, buyer = NORMAL_BUYER + i, product = FIRST_NORMAL + i % NORMALS;   // 每 50 ms 一個 = 每秒 20 個
            jobs.add(new Job(due, () -> {
                String o = outcome(() -> orders.placeOrder(buyer, "g7n-" + buyer, List.of(new OrderingApi.OrderLine(product, 1, new BigDecimal("100")))));
                lat.add(System.nanoTime() - due);
                normal.merge(o, 1, Integer::sum);
                return null;
            }));
        }
        jobs.sort(Comparator.comparingLong(Job::due));
        List<Future<Void>> fs = new ArrayList<>();
        for (Job j : jobs) { sleepUntil(j.due()); fs.add(server.submit(j.task())); }
        for (var f : fs) f.get();
        server.shutdown();
        long[] l = lat.stream().mapToLong(Long::longValue).sorted().toArray();
        return new Result(new TreeMap<>(hot), new TreeMap<>(normal), l[l.length / 2] / 1e6, l[(int) (l.length * 0.95)] / 1e6, l[(int) (l.length * 0.99)] / 1e6);
    }

    interface Call { void run() throws Exception; }

    static String outcome(Call c) {
        try {
            c.run();
            return "201";
        } catch (Exception e) {
            Throwable t = e instanceof java.lang.reflect.InvocationTargetException ite ? ite.getCause() : e;
            if (t instanceof ShopException se) return String.valueOf(se.type().status().value());
            if (t instanceof org.springframework.transaction.CannotCreateTransactionException
                    || t instanceof org.springframework.dao.DataAccessResourceFailureException) return "503（連線池）";
            return "500 " + t.getClass().getSimpleName();
        }
    }

    static void sleepUntil(long due) throws InterruptedException {
        long wait = due - System.nanoTime();
        if (wait > 0) TimeUnit.NANOSECONDS.sleep(wait);
    }

    static void reset(JdbcTemplate jdbc, StringRedisTemplate redis) {
        long lo = HOT_BUYER, hi = NORMAL_BUYER + 1000;                     // HOT_BUYER + 6,000 < NORMAL_BUYER
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        for (long id = HOT; id < FIRST_NORMAL + NORMALS; id++) {
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", id);
            jdbc.update("DELETE FROM products WHERE id = ?", id);
        }
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '限量商品', 1990.00, 'ON_SALE', TRUE)", HOT);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 500, 0)", HOT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 500, 0, 'INITIAL', 'g7')", HOT);
        for (long id = FIRST_NORMAL; id < FIRST_NORMAL + NORMALS; id++) {
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '一般商品', 100.00, 'ON_SALE')", id);
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 1000, 0)", id);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 1000, 0, 'INITIAL', 'g7')", id);
        }
        try { for (long id = HOT; id < FIRST_NORMAL + NORMALS; id++) TestRedis.forgetProducts(redis, id); } catch (Exception ignored) { }
    }

    static void docker(String... args) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("docker"));
        cmd.addAll(List.of(args));
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        p.getInputStream().readAllBytes();
        p.waitFor();
    }

    static void waitForRedis(StringRedisTemplate redis) throws InterruptedException {
        for (int i = 0; i < 60; i++) {
            try { redis.opsForValue().get("ping"); Thread.sleep(6000); return; } catch (Exception e) { Thread.sleep(500); }
        }
    }
}
```

**`src/test/java/com/example/shop/ch06/G8RedisOutageDrillTest.java`**（新增；6.9.2）

```java
package com.example.shop.ch06;

import com.example.shop.ShopApplication;
import com.example.shop.support.TestRedis;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;
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
 * 6.9.2 降級演練（驗收 Q8 的完整版）：固定的混合流量跑 100 秒，第 20 秒把 Redis 停掉（stop 或 pause），第 80 秒恢復。
 * 流量（開放式）：商品詳情每秒 300 次（100 個商品）、熱門排行每秒 20 次、熱點商品下單每秒 20 次、一般商品下單每秒 5 次。
 * 每 5 秒一列：MySQL 每秒收到的指令數（Questions）、各 API 的狀態碼與 p99。
 */
@Tag("experiment")
class G8RedisOutageDrillTest {

    static final long HOT = 9_900_771, NORMAL = 9_900_772, BUYER = 3_400_000;

    @Test
    void sixtySecondsWithoutRedis() throws Exception {
        for (String mode : System.getProperty("g8.modes", "stop,pause").split(",")) drill(mode);   // 只跑一種：-Dg8.modes=pause
    }

    record Sample(String api, int status, long nanos) {}

    void drill(String mode) throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--shop.order.jobs-enabled=false",
                "--shop.inventory.jobs-enabled=false", "--spring.main.banner-mode=off", "--logging.level.root=" + System.getProperty("g8.log", "ERROR"))) {
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            StringRedisTemplate redis = ctx.getBean(StringRedisTemplate.class);
            JdbcTemplate root = new JdbcTemplate(new DriverManagerDataSource("jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true", "root", "root"));
            cleanup(jdbc, redis);
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '演練熱點', 100.00, 'ON_SALE', TRUE)", HOT);
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '演練一般', 100.00, 'ON_SALE')", NORMAL);
            for (long id : new long[]{HOT, NORMAL}) jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", id);
            List<Long> products = jdbc.queryForList("SELECT id FROM products WHERE status = 'ON_SALE' AND NOT hot ORDER BY id LIMIT 100", Long.class);
            HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(64)).build();
            String base = "http://localhost:" + port;
            for (long id : products) http.send(HttpRequest.newBuilder(URI.create(base + "/api/products/" + id)).build(), HttpResponse.BodyHandlers.discarding());   // 暖快取

            ConcurrentLinkedQueue<Sample>[] buckets = new ConcurrentLinkedQueue[20];
            for (int i = 0; i < 20; i++) buckets[i] = new ConcurrentLinkedQueue<>();
            long[] questions = new long[21];
            ScheduledExecutorService clock = Executors.newScheduledThreadPool(2);
            ExecutorService senders = Executors.newCachedThreadPool();
            long t0 = System.nanoTime();
            AtomicLong buyerSeq = new AtomicLong(BUYER);
            Random rnd = new Random(8);
            // 每 5 ms 一個 tick：決定這一個 tick 要送什麼（300 + 20 + 20 + 5 每秒）
            ScheduledFuture<?> ticker = clock.scheduleAtFixedRate(() -> {
                long now = System.nanoTime();
                int bucket = (int) ((now - t0) / 5_000_000_000L);
                if (bucket >= 20) return;
                long tick = (now - t0) / 5_000_000L;
                List<String[]> reqs = new ArrayList<>();
                reqs.add(new String[]{"詳情", "GET", "/api/products/" + products.get(rnd.nextInt(products.size()))});
                if (tick % 2 == 0) reqs.add(new String[]{"詳情", "GET", "/api/products/" + products.get(rnd.nextInt(products.size()))});
                if (tick % 3 == 0) reqs.add(new String[]{"詳情", "GET", "/api/products/" + products.get(rnd.nextInt(products.size()))});
                if (tick % 10 == 0) reqs.add(new String[]{"排行", "GET", "/api/products/trending"});
                if (tick % 10 == 5) reqs.add(new String[]{"熱點下單", "POST", "" + HOT});
                if (tick % 40 == 0) reqs.add(new String[]{"一般下單", "POST", "" + NORMAL});
                for (String[] r : reqs) senders.submit(() -> {
                    long s = System.nanoTime();
                    HttpRequest.Builder b;
                    if (r[1].equals("GET")) b = HttpRequest.newBuilder(URI.create(base + r[2])).timeout(java.time.Duration.ofSeconds(10));
                    else {
                        long buyer = buyerSeq.getAndIncrement();
                        b = HttpRequest.newBuilder(URI.create(base + "/api/orders")).timeout(java.time.Duration.ofSeconds(10))
                                .header("Authorization", TestTokens.bearer(ctx, buyer)).header("Idempotency-Key", "g8-" + buyer).header("Content-Type", "application/json")
                                .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + r[2] + ",\"quantity\":1,\"unitPrice\":100}]}"));
                    }
                    int status;
                    try { status = http.send(b.build(), HttpResponse.BodyHandlers.discarding()).statusCode(); } catch (Exception e) { status = 0; }
                    buckets[bucket].add(new Sample(r[0], status, System.nanoTime() - s));
                });
            }, 0, 5, TimeUnit.MILLISECONDS);
            for (int i = 0; i <= 20; i++) {
                long due = t0 + i * 5_000_000_000L;
                while (System.nanoTime() < due) Thread.sleep(20);
                questions[i] = questions(root);
                if (i == 4) docker(mode, "shop-redis-1");
                if (i == 16) docker(mode.equals("stop") ? "start" : "unpause", "shop-redis-1");
            }
            ticker.cancel(false);
            senders.shutdown();
            senders.awaitTermination(30, TimeUnit.SECONDS);
            clock.shutdown();

            System.out.printf("═══ 6.9.2 降級演練：docker %s shop-redis-1（第 20～80 秒）═══%n", mode);
            System.out.println("  秒      Redis │ MySQL 指令/秒 │ 詳情 p99（ms） 狀態                │ 排行 狀態        │ 熱點下單 狀態            │ 一般下單 狀態");
            for (int i = 0; i < 20; i++) {
                Map<String, List<Sample>> by = new TreeMap<>();
                for (Sample s : buckets[i]) by.computeIfAbsent(s.api(), k -> new ArrayList<>()).add(s);
                System.out.printf("  %3d-%-3d %-5s │ %8.0f      │ %8.1f   %-22s │ %-16s │ %-24s │ %s%n", i * 5, i * 5 + 5, i >= 4 && i < 16 ? "掛了" : "正常",
                        (questions[i + 1] - questions[i]) / 5.0, p99(by.get("詳情")), statuses(by.get("詳情")), statuses(by.get("排行")),
                        statuses(by.get("熱點下單")), statuses(by.get("一般下單")));
            }
        } finally {
            docker("unpause", "shop-redis-1");
            docker("start", "shop-redis-1");
            Thread.sleep(8000);
        }
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).web(org.springframework.boot.WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=ERROR", "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false")) {
            cleanup(ctx.getBean(JdbcTemplate.class), ctx.getBean(StringRedisTemplate.class));
        }
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

    static long questions(JdbcTemplate root) {
        return Long.parseLong(root.queryForMap("SHOW GLOBAL STATUS LIKE 'Questions'").get("Value").toString());
    }

    static void cleanup(JdbcTemplate jdbc, StringRedisTemplate redis) {
        long lo = BUYER, hi = BUYER + 100_000;
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        jdbc.update("DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        for (long id : new long[]{HOT, NORMAL}) {
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", id);
            jdbc.update("DELETE FROM products WHERE id = ?", id);
            TestRedis.forgetProducts(redis, id);
        }
    }

    static void docker(String... args) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("docker"));
        cmd.addAll(List.of(args));
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        p.getInputStream().readAllBytes();
        p.waitFor();
    }
}
```

**`src/test/java/com/example/shop/ch06/G9RateLimitTest.java`**（新增；6.7.1、6.7.3）

```java
package com.example.shop.ch06;

import com.example.shop.ShopApplication;
import com.example.shop.shared.ratelimit.RateLimiter;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

/**
 * 6.7 US-ORD-1 AC-8（每位買家每分鐘 10 張）的兩個問題：
 *   A. 什麼算「一次」？買家連點送出鈕 10 次（同一個 Idempotency-Key），接著再下 5 張不同的訂單
 *      per-request：每一個請求都算    distinct：只數不同的 Idempotency-Key（本專題）
 *   B. Redis 掛了：兩台機器各自用自己的記憶體計數（0.6.3「限流改用單機記憶體」）。一位買家輪流打兩台，送 30 張不同的訂單
 */
@Tag("experiment")
class G9RateLimitTest {

    @Test
    void whatCountsAndWhereItIsCounted() throws Exception {
        var a = start();
        var b = start();
        try {
            RateLimiter la = a.getBean(RateLimiter.class), lb = b.getBean(RateLimiter.class);
            StringRedisTemplate redis = a.getBean(StringRedisTemplate.class);
            redis.delete(List.of("rl:g9-per-request:1", "rl:g9-distinct:1", "rl:g9-two:1", "rl:g9-two:2"));
            System.out.println("═══ 6.7.1 連點 10 次（同一個鍵），接著再下 5 張不同的訂單 ═══");
            for (String way : List.of("per-request", "distinct")) {
                ExecutorService pool = Executors.newFixedThreadPool(10);
                CountDownLatch go = new CountDownLatch(1);
                List<Future<Boolean>> clicks = new ArrayList<>();
                for (int i = 0; i < 10; i++) clicks.add(pool.submit(() -> { go.await(); return acquire(la, way, "same-key"); }));
                go.countDown();
                int clickAllowed = 0;
                for (var f : clicks) if (f.get()) clickAllowed++;
                pool.shutdown();
                List<String> next = new ArrayList<>();
                for (int i = 1; i <= 5; i++) next.add(acquire(la, way, "order-" + i) ? "放行" : "429");
                System.out.printf("  %-12s 連點 10 次：放行 %2d │ 接下來 5 張新訂單：%s%n", way, clickAllowed, next);
            }

            System.out.println("═══ 6.7.3 一位買家輪流打兩台機器，送 30 張不同的訂單（上限 10）═══");
            for (String state : List.of("Redis 正常", "Redis 停掉")) {
                if (state.endsWith("停掉")) docker("stop", "shop-redis-1");
                try {
                    long buyer = state.endsWith("正常") ? 1 : 2;
                    int allowedA = 0, allowedB = 0;
                    for (int i = 0; i < 30; i++) {
                        RateLimiter l = i % 2 == 0 ? la : lb;
                        if (l.distinct("g9-two:" + buyer, "k-" + i, 10, Duration.ofMinutes(1)).allowed()) { if (i % 2 == 0) allowedA++; else allowedB++; }
                    }
                    System.out.printf("  %-10s 放行 %2d 張（A 台 %d、B 台 %d）%n", state, allowedA + allowedB, allowedA, allowedB);
                } finally {
                    if (state.endsWith("停掉")) docker("start", "shop-redis-1");
                }
            }
        } finally {
            Thread.sleep(8000);
            a.close();
            b.close();
        }
    }

    static boolean acquire(RateLimiter l, String way, String key) {
        return way.equals("distinct") ? l.distinct("g9-distinct:1", key, 10, Duration.ofMinutes(1)).allowed()
                : l.perRequest("g9-per-request:1", 10, Duration.ofMinutes(1)).allowed();
    }

    static org.springframework.context.ConfigurableApplicationContext start() {
        return new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=ERROR", "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false");
    }

    static void docker(String... args) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("docker"));
        cmd.addAll(List.of(args));
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        p.getInputStream().readAllBytes();
        p.waitFor();
    }
}
```

**`src/test/java/com/example/shop/ch06/G10DetailSloTest.java`**（新增；6.4.5）

```java
package com.example.shop.ch06;

import com.example.shop.ShopApplication;
import io.micrometer.core.instrument.MeterRegistry;
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

/**
 * 6.4.5 0.6.2 的第一列 SLO：GET /api/products/{id}（快取命中），同一個商品每秒 1,000 次 → p95 20 ms、p99 50 ms。
 * 開放式負載 10 秒（延遲從預定送出的時間算起，4.8.1）。每種 3 輪：一般商品（3）、熱點商品（1，可售量讀 Redis 的副本）。
 * 另外記：這段期間 MySQL 每秒收到幾句、Redis 失敗幾次、RedisGuard 跳開了幾次。
 */
@Tag("experiment")
class G10DetailSloTest {

    @Test
    void thousandRequestsPerSecondOnOneProduct() throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--shop.order.jobs-enabled=false",
                "--shop.inventory.jobs-enabled=false", "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            JdbcTemplate root = new JdbcTemplate(new DriverManagerDataSource("jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true", "root", "root"));
            MeterRegistry meters = ctx.getBean(MeterRegistry.class);
            HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(200)).build();
            System.out.println("═══ 6.4.5 同一個商品，每秒 1,000 次 GET /api/products/{id}，10 秒（開放式）═══");
            for (long id : new long[]{3, 1, 3, 1, 3, 1}) {
                URI uri = URI.create("http://localhost:" + port + "/api/products/" + id);
                for (int i = 0; i < 500; i++) http.send(HttpRequest.newBuilder(uri).build(), HttpResponse.BodyHandlers.discarding());   // 暖機、填快取
                double failures0 = meters.get("shop.redis.failures").counter().count(), trips0 = meters.get("shop.redis.trips").counter().count();
                long q0 = questions(root);
                ConcurrentLinkedQueue<Long> lat = new ConcurrentLinkedQueue<>();
                ConcurrentHashMap<Integer, Integer> statuses = new ConcurrentHashMap<>();
                long start = System.nanoTime() + 100_000_000L;
                List<CompletableFuture<?>> fs = new ArrayList<>();
                for (int i = 0; i < 10_000; i++) {                               // dispatcher：照時間表送出，不等回應（sendAsync）
                    long due = start + i * 1_000_000L;
                    long w = due - System.nanoTime();
                    if (w > 0) TimeUnit.NANOSECONDS.sleep(w);
                    fs.add(http.sendAsync(HttpRequest.newBuilder(uri).build(), HttpResponse.BodyHandlers.discarding()).whenComplete((r, e) -> {
                        lat.add(System.nanoTime() - due);
                        statuses.merge(e == null ? r.statusCode() : 0, 1, Integer::sum);
                    }));
                }
                CompletableFuture.allOf(fs.toArray(CompletableFuture[]::new)).exceptionally(e -> null).join();
                double secs = (System.nanoTime() - start) / 1e9;
                long[] l = lat.stream().mapToLong(Long::longValue).sorted().toArray();
                System.out.printf("  商品 %d（%s）HTTP %s │ p50 %5.1f  p95 %5.1f  p99 %6.1f  最慢 %6.1f ms │ MySQL %4.0f 句/秒 │ Redis 失敗 %.0f 次、跳開 %.0f 次%n",
                        id, id == 1 ? "熱點" : "一般", new TreeMap<>(statuses), l[l.length / 2] / 1e6, l[(int) (l.length * 0.95)] / 1e6, l[(int) (l.length * 0.99)] / 1e6,
                        l[l.length - 1] / 1e6, (questions(root) - q0) / secs, meters.get("shop.redis.failures").counter().count() - failures0,
                        meters.get("shop.redis.trips").counter().count() - trips0);
            }
        }
    }

    static long questions(JdbcTemplate root) {
        return Long.parseLong(root.queryForMap("SHOW GLOBAL STATUS LIKE 'Questions'").get("Value").toString());
    }
}
```

---

## 6.12 常見誤區

**① 「改了資料，就在同一個方法裡把快取刪掉」**

6.2.1 ①：`@Transactional` 方法裡的 `cache.evict()` 在 commit **之前**執行，讀的人在那個空窗把舊值填回去 —— 200 次有 199 次，舊價格留 10 分鐘。**快取的動作要在 commit 之後。**

**② 「commit 之後刪快取就對了」**

6.2.1 ②：在「快取剛好過期」的那一刻改價，100 次有 2 次留下舊價格 —— 讀的人在 commit 前讀到舊值，在刪除之後才寫回。**寫入新值、帶版本號**：舊的版本蓋不掉新的（6.4.1）。

**③ 「有版本號，快取就一定是新的」**

6.4.2：版本號只保證「舊的蓋不掉新的」，不保證「新的寫得進去」。commit 之後那一次寫入碰上 Redis 逾時，舊值就留到 TTL。**寫入失敗要記下來、重試**；行程死掉的那一種，只能靠 TTL 或第 07 章。

**④ 「快取命中了，就不會碰資料庫」**

6.2.3：方法上的 `@Transactional(readOnly = true)` 讓每一次快取命中都送 5 句交易控制的指令、拿一條連線。**交易的範圍跟著「真的會碰資料庫的那一段」走。**

**⑤ 「熱點商品要用分散式鎖防擊穿」**

6.2.2：本機的 single-flight 把 200 次讀取變成每台 1 次。3 台 3 次，MySQL 感覺不到。分散式的版本多一次往返、多一種失敗模式，換來的是把 3 變成 1。

**⑥ 「Redis 減了庫存，失敗的時候記得加回去就好」**

6.2.4：「記得」是不夠的 —— 漏了價格不符那一條路，100 件商品一件都賣不出去。**在閘門的下一行就開始 `try`**，所有失敗都經過同一個 `catch`。

**⑦ 「Redis 跟 MySQL 的庫存要保持一致」**

不可能（沒有分散式交易）。能決定的只有「不一致時往哪邊偏」：**偏高（多放一些請求進 MySQL）可以，偏低（少賣）不行**，MySQL 的條件式 UPDATE 永遠是最後一道防線（6.5.3）。

**⑧ 「用分散式鎖讓 Redis 跟 MySQL 同步」**

6.2.5 V1：鎖在 `@Transactional` 方法的 `finally` 裡放掉，比 commit 早，20 輪裡 2～3 輪少賣。就算鎖包住了交易，也要「每一個寫入者都拿鎖」才有用 —— 包括在訂單交易裡的取消。**對帳用 CAS**：寫入者都不拿鎖（6.6）。

**⑨ 「限流就是數請求」**

6.7.1：連點 10 次（同一個冪等鍵）就用光一分鐘的額度，4.8.2 叫客戶端重試的 503 也被算進去。**下單的「一次」是一個冪等鍵**。

**⑩ 「斷路器跳開之後，改讀資料庫就好」**

6.4.5、6.9.2：跳開之後每秒 1,000 個請求全部改讀 MySQL，MySQL 每秒 1,272 句、整站一起慢。**跳開之後也要 single-flight、也要一個短的本機副本**（價格 1 秒、庫存 5 秒，剛好是需求允許的延遲）。

**⑪ 「Redis 逾時設 500 ms 很保守了」**

6.4.5：500 ms 是商品頁 SLO 的 10 倍。Redis 一卡，延遲就由逾時決定。**「可以失敗」的讀取，逾時要比 SLO 短。**

**⑫ 「Redis 掛了，熱點商品也退回 MySQL，總比 503 好」**

6.9.1：每秒 600 次的熱點流量退回 MySQL，一般商品的下單 p50 變成 2.3～6.9 秒，有一次還出現了一般商品的 503。**一個功能 503，好過整站變慢**（0.6.3 的艙壁）。但在每秒 200 次時兩者分不出差別 —— 艙壁防的是 0.6.1 算出來的那個尖峰，不是平常的流量。

**⑬ 「改一下 migration 的註解沒關係」**

6.8.1：checksum 變了，每一個應用程式都起不來。**已套用的 migration 一個字都不能改**；還沒發布的，在本機撤掉重做。

**⑭ 「測試用 SQL 建資料比較快」**

6.4.1：繞過 `ProductService` 的寫入，快取不會知道 —— 同一個 id 重建的商品 `version` 又是 0，舊的快取一直留著。**有快取之後，「誰可以寫這張表」多了一個問題：寫完之後，快取怎麼辦。**

**⑮ 「降級路徑有單元測試，所以沒問題」**

6.9.2：`RedisGuard.tripped()` 只在 Redis 失敗時執行，而且要「幾十個執行緒同時失敗」才會撞上那個 NPE —— 單元測試、整合測試、一次一個請求的 Q8 全部是綠的。它在 `docker pause` + 真實流量的演練裡，7 次出現了 5 個 500。**降級路徑是最少被執行、最晚被發現的程式碼**；要用「同時失敗」去測它（`RedisGuardTest` 的 `CyclicBarrier`），也要真的演練。

**⑯ 「`ConcurrentXxx` 的集合是執行緒安全的，所以我的程式碼也是」**

每一個方法各自安全，**「`isEmpty()` 然後 `peekFirst()`」這個組合不是**（6.9.2）。跟 4.2.1 ①「讀了再寫」是同一個錯：判斷與動作之間，別人可以插進來。

---

## 6.13 本章小結

**這一章建立了六件事**：

1. **一個不會說謊的商品快取**（6.4）：commit 之後寫入新值、版本號擋住舊值、寫入失敗會重試；single-flight 防擊穿；方法上沒有交易。
2. **一個熱點商品的閘門**（6.5）：搶不到的人不碰 MySQL；閘門之後的每一條失敗路徑都加回去；Redis 只能偏高。
3. **一個用 CAS 的對帳**（6.6）：寫入者不拿鎖，對帳自己確認沒有人動過；連續兩輪才修正。
4. **一個知道「什麼算一次」的限流**（6.7）：只數不同的冪等鍵；Redis 掛了退回單機。
5. **一個斷路器，以及跳開之後的行為**（6.4.5、6.9.2）：1 秒內 3 次才跳開；跳開之後本機 1 秒 / 5 秒的副本，MySQL 從 5.4～5.5 倍降到 1.0～1.2 倍；同時失敗的競態修掉了（`RedisGuardTest`）。
6. **一次真的降級演練**（6.9）：Redis 掛 60 秒，0.6.3 那一欄的每一格都照設計運作。**驗收 Q8 變綠。**

**以及一個沒有達成的目標**：熱點搶購的 p99 < 500 ms（6.5.4）。閘門讓搶不到的人快了兩個數量級，但搶到的那 500 人仍然排在同一列 MySQL 後面。

**如果這一章只能記一句話**：

> **快取與 Redis 永遠會跟資料庫不一致。** 設計的工作不是讓它們一致，而是決定：不一致的時候往哪邊偏、偏多久、誰會發現。

### 6.13.1 驗收清單

做得到才往下走：

- [ ] 跑完 G1，說出 ① 為什麼 200 次有 199 次錯，以及 ② 要在什麼條件下才會錯。
- [ ] 說出 `SET_IF_NEWER` 擋住了哪一種競態、擋不住哪一種（6.4.2）。
- [ ] 用 MySQL 的 general log 看一次 6.2.3 那 5 句，再把 `detail()` 上的 `@Transactional` 加回去，跑 G3 看數字。
- [ ] 跑完 G4，說出 naive 版本的 100 件商品為什麼一件都賣不出去，以及 INV-1～INV-4 為什麼一條都沒有被違反。
- [ ] 跑完 G5，說出 V1 的鎖在哪一行被放掉、那時候交易 commit 了沒有。
- [ ] 說出 6.5.3 那張表的每一列，Redis 在出錯時會偏高還是偏低。
- [ ] 說出熱點搶購的 p99 為什麼還是沒有達成，以及第 07 章要改的是哪一段。
- [ ] 跑完 G9，說出「連點 10 次」在兩種計數下各發生什麼事。
- [ ] 跑一次 G8，自己算出 Redis 掛掉時 MySQL 的 QPS 是平常的幾倍；把 `ProductCache` 的降級副本拿掉再跑一次。
- [ ] `docker stop shop-redis-1`，用 `curl` 打一次商品詳情、熱點下單、一般下單、熱門排行、readiness，對照 0.6.3 的那一欄。
- [ ] 把 `RedisGuard.tripped()` 的 `synchronized` 拿掉，跑 `RedisGuardTest`，說出那個 NPE 是哪兩個執行緒、在哪兩行之間交錯出來的。
- [ ] `mvn clean verify` 顯示 `Tests run: 160, Failures: 0, Errors: 0, Skipped: 4`。

### 6.13.2 本章練習

**練習一（20 分鐘）：分桶的 ZSET 排行**

照 6.8.2 的第 2 點做一個「每小時一個桶」的 ZSET 排行：下單 commit 之後 `ZINCRBY trending:{yyyyMMddHH}`，查詢時 `ZUNIONSTORE` 最近 24 個桶。用 G8 的流量量它的 Redis 指令數，跟 6.8.1 的「每分鐘一句 SQL」比較。**行程在 commit 之後、`ZINCRBY` 之前死掉，排行會少算嗎？**

**練習二（20 分鐘）：Redis 的資料丟了**

在搶購進行中執行 `redis-cli FLUSHALL`（模擬 Redis 重啟、沒有持久化）。`stock:{id}` 會被誰、在什麼時候重建？重建時讀到的 MySQL 可售量，跟「Redis 已減、MySQL 還沒 commit」的那幾張訂單有什麼關係？Redis 的數字會偏高還是偏低？用對帳的 `HOT_STOCK_DRIFT` 日誌驗證你的推論。

**練習三（30 分鐘）：V2 的那個窗口**

6.2.5 推論 V2（鎖包住交易）在「取消不拿鎖」時會出錯，但 20 輪沒有量到。設計一個實驗把那個窗口放大（例如讓對帳在「讀 MySQL」與「`SET` Redis」之間多做一點事），量出它出錯的機率。**它跟 V1 的錯，是同一種錯嗎？**

**練習四（30 分鐘）：Lua 腳本與 Redis Cluster**

把 `HotStock.GATE` 改成在 Redis Cluster 上也能執行：key 加上 hash tag（`stock:{product}:123`），或者一次只閘一個品項、失敗時把前面的加回去。兩種做法各有什麼代價？

**練習五（40 分鐘）：兩種逾時**

照 6.4.5 的結論，讓「讀快取」與「閘門、寫入」用不同的 Redis 逾時：兩個 `LettuceConnectionFactory`（50 ms 與 500 ms）、兩個 `StringRedisTemplate`。重跑 G10，Redis 卡住時 p99 變成多少？`RedisGuard` 要不要也分成兩個？

**練習六（20 分鐘）：修資料的 SOP**

寫一支 `POST /api/admin/products/{id}/cache/evict`（管理員用 SQL 修完資料之後呼叫），刪掉 6.4.1 那三個 key，並寫 `audit_logs`。它要放進 `IdorMatrixTest` 的 `MATRIX` 還是 `EXEMPT`？

**練習七（進階，60 分鐘）：降級時的熱點**

0.6.3 說熱點商品在 Redis 掛了的時候 503。設計一個折衷：Redis 掛了的時候，熱點商品退回 MySQL，但**同一個商品同時最多 5 個請求**進下單交易（一個 per-product 的 `Semaphore`），其他的 503。用 G7 的每秒 600 次量一般商品的延遲，跟 6.9.1 的兩種做法比較。

**練習八（20 分鐘）：登入的 IP 限流**

第 05 章的 `IpLoginLimiter`（每 IP 每分鐘 20 次）還是單機的：N 台機器，實際上限是 N 倍（6.7.3）。把它改成用 `RateLimiter.perRequest`，並決定 Redis 掛了的時候它要怎麼辦 —— 跟 0.6.3「登入 × Redis = 暫停鎖定」的 fail-open 是同一個取捨嗎？`AuthApiTest.perIpLimit` 要不要改？

**練習九（30 分鐘）：MySQL 說沒貨時，要不要加回去**

6.5.3 的 ⚠️：`PlaceOrderService` 接到 `InsufficientStockException` 時不把那個品項加回 Redis，在數量 > 1 時會讓 Redis 偏低。先寫一個測試把它重現出來（`stock:{id}` 設成 3、MySQL 可售 2、一張買 3 件的熱點訂單；結束時斷言 Redis ≥ MySQL 的可售量），再修它：一律加回去（偏高，交給 MySQL 的條件式 UPDATE 與對帳），還是只加回「多減的那一部分」？後者需要知道什麼數字、要不要多讀一次 MySQL？修完之後，6.5.3 那張表的第二列要怎麼寫？（做完再對照 6.5.3 的追記：專題寫完之後的修法 —— 那時候它已經搬到第 07 章的落帳裡了。）

---

## 6.14 下一章預告

這一章留下了一個沒有達成的目標，和兩個「第 07 章」：

- **熱點搶購的 p99**（6.5.4）：閘門讓搶不到的 1,500 人在幾十毫秒內知道結果（p50 15～29 ms），但搶到的 500 人仍然一張一張排在同一列 MySQL 後面 —— 下單交易要寫那一列的 `reserved`、八張表、二十幾句 SQL。
- **commit 之後、Redis 之前行程死掉**（6.4.2、6.5.3）：快取的新值、閘門的加回，都只在記憶體裡記著「要做」。
- **「排行 +1」與「訂單成立」是兩個寫入**（6.8.2）。

三件事是同一個問題：**「MySQL 的交易 commit 了」與「之後要做的事」之間，沒有可靠的連結。**

下一章（07）是這個專題的**第二個重頭戲**：事件驅動的訂單流。

- **Outbox**：在下單的同一個交易裡寫一筆「訂單已成立」，由另一個程式在 commit 之後可靠地送出 —— 行程被 `kill -9` 也不會遺失（驗收 **Q9**）。
- **熱點商品的 MySQL 落帳移出下單交易**：下單只寫訂單，庫存的預留由消費者在幾秒內完成 —— 0.6.4 那一列「庫存帳落帳 | 最終一致 | 60 秒」。這是熱點 p99 的第二次嘗試。
- **冪等消費**：同一則訊息投遞 10 次，庫存只扣 1 次（驗收 **Q10**）。
- **通知與退款**：0.5.4 右欄的「提交後」，一格一格落實；退款的金流呼叫失敗要重試、要進死信。
- **broker 只出現在 `shared.messaging`**（驗收 **Q11**）。

門鎖裝好了，房子也撐得住人潮了。下一章讓「做完一件事之後」的那些事，一件都不會掉。
