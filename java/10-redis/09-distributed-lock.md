# 第 09 章：分散式鎖

> 08 章最後那張降級決策表（8.8）留下三行寫著 **「❌ 直接失敗」**，
> 而它們有同一個共同點：**它們都是用 Redis 來保證「同一時間只有一個人能做某件事」。**
>
> 這一章從最基本的那個開始。
>
> 先看結論。同一段業務（**200 個人搶 100 件商品**），六種寫法，每一種都在你自己的機器上跑得出來：
>
> | 寫法 | 節 | 訂單筆數 | 庫存剩 | **超賣** | 耗時 |
> |---|---|---|---|---|---|
> | 完全沒有鎖 | 9.2.2 | 200 | 99 | **100 件** | 37 ms |
> | `if (get() == null) set(...)` | 9.3.1 | 200 | 99 | **100 件** | 45 ms |
> | `SET NX PX` ＋ `DEL` 釋放 | 9.4.2 | — | — | （**28/30 次刪到別人的鎖**） | — |
> | `SET NX PX` ＋ Lua 釋放，TTL 200ms | 9.5.2 | — | — | （**互斥失效 29 次**） | 6,388 ms |
> | ⚠️ **鎖包在交易裡面** | 9.8.2 | 200 | 45 | **145 件** | 1,909 ms |
> | ✅ **鎖包住交易** | 9.8.3 | 100 | 0 | **0 件** | 1,240 ms |
>
> 📌 **請先看最後兩列。** 它們是**同一段業務、同一把鎖、同一個 Redis**，
> 差別只有 `@Transactional` 標在哪一層——一個超賣 145 件，一個一件都沒有，
> **而且對的那個還比較快。**
>
> 而第四列是這一章最需要小心的那一種：
> **它有鎖、有 Lua、有 token 比對，看起來每一條規則都遵守了，而且它跑得比正確的版本快 33%。**
> 「比較快」正是它壞掉的證據（9.5.3）。
>
> ⚠️ **這一章的每個實驗都是併發壓測，請一個一個跑**（`mvn -Dtest=類別#方法 test`）。
> 9.11 會 `docker pause` 你的 `redis-lab` 容器。

---

## 9.1 學習目標

完成本章後，你應該可以：

- 說出「兩行之間的那道縫」為什麼在單機 `synchronized` 下不存在、在多實例下一定存在（9.2）。
- 指出 `if (get() == null) set(...)`、`SETNX` + `EXPIRE`、`SET NX PX` 三種取鎖寫法分別漏了什麼（9.3）。
- 說明釋放鎖為什麼**不能**用 `DEL`，並寫出 05 章那段 `release-lock.lua` 的完整理由（9.4）。
- 估出一個合理的鎖過期時間，並說出**設太短**與**設太長**分別付出什麼代價（9.5）。
- 實作 watchdog 續期，並說出它解決了哪一半、**沒有**解決哪一半（9.6）。
- 用 Redisson 的 `RLock`，看懂它在 Redis 裡留下的那個 Hash，並說出可重入、公平鎖、watchdog 各自的成本（9.7）。
- ⚠️ 判斷一段程式的**鎖與交易順序**是對是錯，並寫出一個在執行期就會擋下來的自檢（9.8）。
- 設計鎖的粒度與 key，並說出「一把全域鎖」在實測中慢了幾倍（9.9）。
- 說明 RedLock 的爭議、fencing token 解決什麼，以及 **Redis 的鎖在什麼前提下才算安全**（9.10）。
- 說出為什麼分散式鎖**不能降級**，以及 Redis 不回話時你的 API 該回什麼（9.11）。

---

## 9.2 先看那道縫

### 9.2.1 為什麼「兩行之間」是一道縫

05 章 5.2 已經說過一次，這裡把它放回業務裡。一個「買一件」長這樣：

```java
public boolean buy(Long productId, String userId) {
    int stock = readStock(productId);      // ① 讀
    if (stock <= 0) return false;          // ② 判斷
    doSomething();                          // ③ 業務（算優惠、查風控……）
    writeStock(productId, stock - 1);      // ④ 寫
    createOrder(productId, userId);         // ⑤ 下單
}
```

只要 ① 和 ④ 不是同一個瞬間，中間就有一道縫：

```
執行緒 A：  讀到 1 ────────────── 寫 0，下單
執行緒 B：        讀到 1 ────────────── 寫 0，下單
                  ↑
              這裡 A 還沒寫回去，所以 B 讀到的還是 1
              兩個人都覺得「還有貨」，兩張訂單，一件商品
```

**單機的 `synchronized` 可以封住它**——但只封住**這一台**。
你有兩台機器，`synchronized` 就只保證「每台機器裡同時只有一個人」，兩台加起來還是兩個。
**分散式鎖要做的，就是把這個「只有一個人」的範圍，從一個 JVM 擴大到整個叢集。**

### 9.2.2 實測：200 個人搶 100 件

專案裡的 `StockService` 刻意把三段動作拆成三個獨立交易，好讓縫看得見：

```java
@Service
public class StockService {

    private final StockDao dao;      // ⚠️ 必須是另一個 bean：同一個 bean 內部呼叫不會經過 proxy

    /** 沒有鎖的「買一件」：讀 →（業務處理 gapMillis）→ 寫。 */
    public boolean buyNoLock(Long id, String userId, long gapMillis) {
        int stock = dao.readStock(id);          // ① 讀（獨立交易）
        if (stock <= 0) return false;           // ②
        sleep(gapMillis);                        // ③ 業務
        dao.writeStock(id, stock - 1);          // ④ 寫（獨立交易）
        dao.createOrder(id, userId);            // ⑤ 下單（獨立交易）
        return true;
    }
}
```

> ⚠️ **`StockDao` 是獨立的 bean，不是 `StockService` 的一個 private 方法。**
> 寫這個實驗的時候第一版就踩到了：三段動作寫在同一個 class 裡互相呼叫，
> `@Transactional` **完全沒有生效**（自呼叫不經過 proxy，07 章 7.2.3 的老朋友），
> 結果是實體處於 detached 狀態、`setStock()` 什麼也沒做，
> **庫存永遠停在 100，實驗「看起來很成功」。**
> 你在跑這一章的實驗時，**每一次都要順便看庫存有沒有真的變**。

200 個執行緒同時進來：

```java
Drill.run(200, n -> stock.buyNoLock(1L, "u" + n, 20));
```

```
═══ 9.2.2 沒有任何鎖：200 個人搶 100 件 ═══
  無鎖      下單成功 200，庫存剩   99，訂單 200，超賣 100 件，耗時 37 ms
```

### 9.2.3 三個數字，三件事

**① 訂單 200 筆**

100 件商品，賣出 200 張訂單。**100 個人會收到「已出貨」，然後收到「抱歉沒貨了」。**

**② 庫存剩 99，不是 0，也不是 -100**

這一格最值得看。200 個人各自讀到 100、各自寫回 99——

```
A 讀 100 ─┐
B 讀 100 ─┼─▶ 全部寫 99
C 讀 100 ─┘
                └── 200 次扣減，只有 1 次「生效」
```

**199 次扣減整個消失了。** 這是資料庫課本上的 **lost update**，
而它在這裡的意思是：**你的庫存數字跟事實完全脫節，而且沒有任何錯誤被記錄下來。**

> 📌 **對帳的時候你會看到**：庫存表說「賣掉 1 件」，訂單表說「賣掉 200 件」。
> 兩張表都沒有壞掉的資料，**每一筆單獨看都是對的**。

**③ 37 毫秒**

比後面任何一個正確版本都快幾十倍。**錯誤的版本總是比較快**——
這句話會在 9.5.3 再出現一次，而那一次會更難發現。

### 9.2.4 這不是「Redis 的問題」，也不是「資料庫的問題」

在往下走之前先把選項擺開。這道縫有三種封法：

| 方案 | 怎麼做 | 章 |
|---|---|---|
| 資料庫悲觀鎖 | `SELECT ... FOR UPDATE` | 12 章 |
| 資料庫樂觀鎖 | `UPDATE ... WHERE version = ?`，失敗就重試 | 12 章 |
| **分散式鎖** | **在 Redis 上搶一個 key，搶到的人才能做事** | **本章** |

⚠️ **分散式鎖不是「比較好的那個」，它是「範圍比較大的那個」。**
資料庫的鎖只能鎖住資料庫裡的東西；
當你要保護的是「同一時間只能有一個人**送出這封信 / 跑這個排程 / 呼叫這個外部 API**」時，
資料庫鎖沒有東西可以鎖——**這才是分散式鎖真正不可取代的場景。**

三種方案的完整對照（含實測）在 12 章。這一章只問一件事：**分散式鎖要怎麼寫才是對的。**

---

## 9.3 四種「看起來像鎖」的寫法

### 9.3.1 ⚠️ `if (get() == null) set(...)`

最直覺的寫法：

```java
// ⚠️ 這不是鎖
while (true) {
    if (redis.opsForValue().get(key) == null) {          // ← 第一行
        redis.opsForValue().set(key, token, 10, SECONDS); // ← 第二行
        break;
    }
    Thread.sleep(2);
}
```

**它自己就有一道縫**，而且就是 9.2.1 那道縫的複製品：

```
A：GET → null ──────────── SET
B：      GET → null ──────────── SET
                ↑
        A 還沒 SET，所以 B 也讀到 null
```

實測（200 個執行緒，每個拿到「鎖」之後就進臨界區，計算同時有幾個人在裡面）：

```
═══ 9.3.1 `if (get() == null) set(...)`：看起來像鎖 ═══
  get-then-set   下單成功 200，庫存剩 99，訂單 200，超賣 100 件，耗時 45 ms
  ⚠️ 同時握著「鎖」的最高人數 = 200（正確的鎖應該永遠是 1）
```

跑八次，「同時持鎖最高人數」分別是 **200、165、160、133、124、120、118、116**，
而「超賣 100 件」**八次全部一樣**。

> ⚠️ **最少的那一次也有 116 個執行緒同時「持有」同一把鎖。**
> 不是 2，不是 5——因為它們是同時進來的，同時 `GET` 到 `null`，同時 `SET`。
>
> 📌 **這個寫法完全等於沒有鎖**（比較 9.2.2 那一列：超賣數字一模一樣）。
> 它唯一的效果是**讓你以為自己加了鎖**，外加多花一趟 Redis 往返。

### 9.3.2 `SETNX` + `EXPIRE`：兩個命令的那一瞬間

知道要用 `SETNX`（`SET if Not eXists`）之後，很多人寫成兩行：

```java
if (Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(key, token))) {   // SETNX
    redis.expire(key, 10, SECONDS);                                        // EXPIRE
    // ... 業務
}
```

**取鎖本身是對的**——`SETNX` 是單一命令，Redis 單執行緒（03 章 3.2），不可能兩個人同時成功。

問題在第二行。**這兩行之間如果程式掛了**：

```
SETNX 成功  ──▶  [ 行程被 kill / OOM / 機器斷電 ]  ──▶  EXPIRE 沒跑到
                                                          │
                                        鎖永遠留在 Redis 上，沒有 TTL
                                                          ▼
                              ⚠️ 這個商品從此再也沒有人賣得掉，直到有人手動 DEL
```

你可以自己造一次：

```bash
docker exec redis-lab redis-cli SETNX lock:product:1 dead-process
docker exec redis-lab redis-cli TTL lock:product:1
```

```
(integer) 1
(integer) -1        ← 01 章 1.4：-1 代表「永不過期」
```

> 📌 **這種故障的形狀很特別**：不是報錯，是**安靜地停止服務**。
> 監控上看不到錯誤率上升（請求正常回「系統忙碌中，請稍後再試」），
> 只有訂單數字慢慢歸零。**通常是營運先發現的。**

### 9.3.3 順帶一提：把過期時間寫在 value 裡的那個老寫法

Redis 2.6.12 以前沒有 `SET key value NX PX`，所以流傳過這種寫法：

```java
long expireAt = System.currentTimeMillis() + 10_000;
if (setIfAbsent(key, String.valueOf(expireAt))) return true;      // 拿到了
String old = get(key);
if (old != null && Long.parseLong(old) < System.currentTimeMillis()) {
    String prev = getAndSet(key, String.valueOf(expireAt));        // ⚠️ 搶過期的鎖
    if (old.equals(prev)) return true;
}
```

⚠️ **這段程式現在不要寫**。它有三個問題：

1. **它依賴每台機器的時鐘一致**——差幾百毫秒就會有兩個人同時認為鎖過期了。
2. `GETSET` 那一段在高競爭下會**把別人剛拿到的鎖的過期時間覆寫掉**。
3. 它解決的是一個 2012 年就不存在的問題。

你在網路上還是會搜到它（很多中文文章至今照抄）。**看到 `getAndSet` 出現在鎖的程式碼裡，就是這一段。**

### 9.3.4 `SET NX PX`：一個命令，兩件事

正確的取鎖只有一行：

```
SET lock:product:1 <token> NX PX 10000
    └───key────┘  └token┘ │   └─ 10000 毫秒後自動消失
                           └──── 只有 key 不存在時才成功
```

Java：

```java
Boolean got = redis.opsForValue()
        .setIfAbsent(key, token, 10_000, TimeUnit.MILLISECONDS);
```

> 📌 `setIfAbsent(key, value, timeout, unit)` 送出去的就是 `SET ... NX PX ...`，**一個命令**。
> 別用 `setIfAbsent(key, value)` 再補一行 `expire()`——那就是 9.3.2。
>
> ⚠️ 也**不要**用 `SET ... NX EX`（秒）當作「反正差不多」。
> 鎖的過期時間幾乎都落在 1 秒以下的量級（9.5.5），**`EX` 的最小單位就已經太粗了。**

實測：

```
═══ 9.3.4 `SET NX PX`：一個命令拿到鎖 ═══
  SET NX PX     下單成功 100，庫存剩 0，訂單 100，超賣 0 件，耗時 2,839 ms
  同時握著鎖的最高人數 = 1
```

**訂單 100 筆、庫存 0、超賣 0。** 而且「同時持鎖最高人數 = 1」——這是我們要的。

代價是 2,839 毫秒：200 個請求完全序列化了。**這是分散式鎖的本質成本**，9.9 會談怎麼把它降下來。

### 9.3.5 但取鎖只是一半

到這裡，很多人就上線了。

`SET NX PX` 確實把「同時兩個人拿到鎖」這件事解決了。
但一把鎖有**兩個**動作，而**釋放**那一半還沒開始討論——
下一節會看到，在同樣的 200 個執行緒下，**30 次釋放裡有 28 次刪掉的是別人的鎖。**

---

## 9.4 釋放：那把鎖不一定還是你的

### 9.4.1 怎麼會刪到別人的

釋放鎖最直覺的寫法是 `DEL`：

```java
try {
    // ... 業務
} finally {
    redis.delete(key);      // ⚠️
}
```

只要業務跑得比 TTL 久，這行就會刪掉別人的鎖：

```
時間軸 ──────────────────────────────────────────────────────────▶

A：  拿鎖(TTL 200ms) ═══════ 業務跑 300ms ═══════ DEL
                          ↑                      ↑
                     200ms 鎖自己過期了      ⚠️ A 刪掉的是 B 的鎖

B：                        拿鎖 ════ 業務 ════
                                ↑
                          B 以為自己獨佔，其實 A 還在裡面
                          而且 B 的鎖等一下會被 A 刪掉
                                          ↓
C：                                    拿鎖 ════   ← 連鎖反應
```

⚠️ 注意這是**連鎖**的：A 刪掉 B 的鎖，C 就進來了；C 又會刪掉 D 的……
**一次過期，之後就再也沒有互斥了。**

### 9.4.2 實測：30 次釋放，28 次刪到別人的

刻意把 TTL 設成 200 毫秒、業務設成 300 毫秒（⚠️ 這個比例在正式環境會自然發生——
一次 GC、一次資料庫慢查詢、一次 04 章的 `fork` 尖峰就夠了）：

```java
String token = lock.tryLock(KEY, Duration.ofMillis(200), Duration.ofSeconds(30));
try {
    Thread.sleep(300);                       // 業務：比 TTL 久
} finally {
    String ownerNow = lock.owner(KEY);       // 釋放前先看一眼鎖在誰手上
    if (ownerNow != null && !ownerNow.equals(token)) stolen.incrementAndGet();
    redis.delete(KEY);                        // ⚠️ 直接 DEL
}
```

```
═══ 9.4.2 釋放時直接 `DEL`：30 執行緒、鎖 TTL 200ms、業務 300ms ═══
  DEL   同時持鎖最多 3 人｜鎖在我手上時就過期了 2 次｜過期後被別人拿走 28 次｜⚠️ 這 28 次會刪掉別人的鎖
```

**30 次釋放裡有 28 次，刪掉的是別人的鎖。**

> 📌 **這個實驗最重要的一件事是「它需要兩個條件同時成立」**：
> 業務比 TTL 久（很常見），**而且**有人在等鎖（也很常見）。
> 在低流量的測試環境裡，第二個條件不成立，所以**這個 bug 在測試環境永遠不會出現。**

### 9.4.3 token 要長什麼樣子

要判斷「這把鎖是不是我的」，value 就不能是固定值。三個層級：

| token | 能分辨 | ⚠️ |
|---|---|---|
| `"1"`、`"locked"` | **什麼都分不出來** | 等於沒有 token |
| `機器名 + 執行緒 ID` | 分得出不同執行緒 | ⚠️ **同一個執行緒的前後兩次會撞**——正是 9.4.1 那個場景 |
| **`UUID.randomUUID()`** | 每一次取鎖都不同 | ✅ |

```java
String token = UUID.randomUUID().toString();
```

> 📌 Redisson 用的是 `<客戶端 UUID>:<執行緒 ID>`（9.7.2 會親眼看到），
> 那是為了支援**可重入**——同一個執行緒要能認出「這把鎖是我自己拿的」。
> 自己寫的話，**如果不需要可重入就用 UUID**，簡單而且不會撞。

### 9.4.4 Lua：05 章那段 `release-lock.lua` 的完整理由

要做的事情是「**如果鎖是我的，就刪掉**」，而這句話裡有一個 `if`——
05 章 5.4.4 已經證明 `MULTI` 做不到「讀了再決定」，所以只能是 Lua：

```lua
-- src/main/resources/scripts/release-lock.lua
-- KEYS[1] = 鎖的 key，ARGV[1] = 我當初寫進去的 token
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return 0
end
```

⚠️ **不要寫成兩行 Java**：

```java
// ⚠️ 錯的：GET 跟 DEL 之間，鎖可能剛好過期並被別人拿走
if (token.equals(redis.opsForValue().get(key))) {
    redis.delete(key);
}
```

**這道縫比 9.4.1 那道窄很多（大概幾百微秒），但它是同一道縫。**
窄的縫不會讓 bug 消失，只會讓它**變成一年出現兩次、而且永遠重現不了**的那種。

Java 這一側（05 章 5.7.4 的 `DefaultRedisScript`）：

```java
@Component
public class SimpleRedisLock {

    private final StringRedisTemplate redis;
    private final RedisScript<Long> unlockScript;   // ← 載入 release-lock.lua

    /** 回 true 代表「鎖確實是我的、而且被我刪掉了」。 */
    public boolean unlock(String key, String token) {
        Long deleted = redis.execute(unlockScript, List.of(key), token);
        return Long.valueOf(1L).equals(deleted);
    }
}
```

> 📌 **回傳值一定要用**。`unlock()` 回 `false` 的意思是
> **「我以為我持有鎖，但其實沒有」**——那是一個必須記 WARN 的事件（9.12.5）。
> 大部分實作把它寫成 `void`，等於把一個很重要的訊號丟掉了。

### 9.4.5 ⚠️ Lua 修好了誤刪，但**沒有**修好互斥

同樣的實驗，只把釋放換成 Lua：

```
═══ 9.4.5 釋放時用 Lua 比對 token：同樣的條件 ═══
  Lua compare   同時持鎖最多 2 人｜鎖在我手上時就過期了 1 次｜過期後被別人拿走 29 次｜✅ Lua 比對後沒有動別人的鎖
```

| | DEL | Lua |
|---|---|---|
| 刪掉別人的鎖 | **28 次** | **0 次** ✅ |
| 同時持鎖最多幾人 | 3 | **2** ⚠️ |
| 「鎖在我手上時就過期了」 | 2 次 | 1 次 |
| 「過期後被別人拿走」 | 28 次 | **29 次** ⚠️ |

> ⚠️ **請看最後兩列。**
> Lua 讓你不再破壞別人的鎖，但**「兩個人同時在臨界區裡」這件事完全沒有改善**——
> 29 次「我的鎖在業務跑到一半時就被別人拿走了」。
>
> 📌 **這是兩個不同的問題**：
>
> | 問題 | 症狀 | 解法 |
> |---|---|---|
> | 釋放時刪錯人 | 破壞**別人的**互斥 | **Lua 比對 token**（9.4.4） |
> | 鎖比業務先過期 | 破壞**自己的**互斥 | **過期時間（9.5）＋ watchdog（9.6）** |
>
> 很多文章寫到「用 Lua 釋放」就結束了。
> **那只做完一半**，而且做完的是比較簡單的那一半。

---

## 9.5 過期時間：兩個方向都會出事

### 9.5.1 為什麼一定要有過期時間

**因為持鎖的那台機器可能永遠不會回來。** 沒有 TTL 的鎖，在行程被 `kill -9`、
容器被驅逐、機器斷電的那一刻，就變成一個**永久的路障**（9.3.2 已經看過）。

所以 TTL 是必須的。而一旦有了 TTL，你就得回答一個很難的問題：**設多久？**

```
設太短 ──▶ 業務還沒做完，鎖就沒了 ──▶ 互斥失效（兩個人同時在裡面）
設太長 ──▶ 持鎖的機器掛了        ──▶ 其他人要等滿整個 TTL 才能繼續
```

⚠️ **這兩個方向的代價完全不對稱**：
設太短是**資料錯誤**（超賣、重複扣款），設太長是**可用性下降**（一段時間卡住）。
**猶豫的時候往長的設。**

### 9.5.2 實測：TTL 200 / 400 / 5000 毫秒

30 個執行緒，業務固定 300 毫秒。
「互斥失效」的定義：任何一個瞬間臨界區裡超過一個人。

```
═══ 9.5.2 過期時間怎麼估：30 個執行緒、業務固定 300ms ═══
  TTL  200ms (plain)   互斥失效 29 次｜同時最多 2 人｜業務跑到一半鎖沒了 30 次｜總耗時 6,388 ms
  TTL  400ms (plain)   互斥失效  0 次｜同時最多 1 人｜業務跑到一半鎖沒了  0 次｜總耗時 9,444 ms
  TTL 5000ms (plain)   互斥失效  0 次｜同時最多 1 人｜業務跑到一半鎖沒了  0 次｜總耗時 9,562 ms
```

**TTL 200ms 那一列：30 次取鎖，30 次都在業務跑到一半時鎖就沒了。**
不是偶爾，是**每一次**——因為 200 < 300，這是必然的。

**TTL 400ms 就完全正確了**，而 5000ms 沒有變得「更正確」。

### 9.5.3 ⚠️ 最危險的訊號：錯的版本比較快

回頭看耗時那一欄：

| TTL | 互斥失效 | 總耗時 |
|---|---|---|
| **200 ms** | **29 次** | **6,388 ms** ← 最快 |
| 400 ms | 0 次 | 9,444 ms |
| 5000 ms | 0 次 | 9,562 ms |

> ⚠️ **壞掉的那個版本快了 33%。**
>
> 理由很簡單：鎖提早消失，等鎖的人提早進場，**併發度變高了**。
> 30 個人 × 300 毫秒 = 9 秒，這是**正確**的序列化時間；6.4 秒代表**有人是並行跑的**。
>
> 📌 **請把這件事記在身上**：
> **當你「調整了一個參數，然後 TPS 上升了」，第一個要懷疑的是互斥有沒有被破壞。**
> 這一章的每一個錯誤版本都比正確版本快——
> 9.2.2 的無鎖快了 250 倍，9.8.2 的順序寫反快了 35%。
>
> **鎖的正確性，在壓測圖表上長得跟效能退化一模一樣。**

### 9.5.4 實測：長 TTL 的代價

持鎖的行程掛掉（拿了鎖之後永遠不 `unlock`），下一個人要等多久：

```java
simple.tryLock(key, Duration.ofSeconds(ttl), ...);   // 拿了就「掛掉」
long t0 = System.currentTimeMillis();
String token = simple.tryLock(key, Duration.ofSeconds(ttl), Duration.ofSeconds(60));
System.out.printf("TTL = %d 秒 → 下一個人等了 %,d ms%n", ttl, System.currentTimeMillis() - t0);
```

```
═══ 9.5.4 持鎖的行程掛掉：別人要等多久 ═══
  TTL =  3 秒 → 下一個人等了 3,087 ms 才拿到鎖
  TTL = 10 秒 → 下一個人等了 10,019 ms 才拿到鎖
```

**一分不差。** TTL 就是你的「故障恢復時間」下限。

> 📌 把它放進 08 章的語言：**TTL 是這個功能的 MTTR。**
> 如果這把鎖保護的是「使用者下單」，TTL 30 秒的意思是
> **「一台機器掛掉，這個商品有 30 秒賣不出去」**。
>
> ⚠️ 如果鎖的粒度是全域的（9.9.2），那就是**整個服務停 30 秒**。

### 9.5.5 那到底該設多少

從這個式子開始：

```
TTL  >  業務最壞情況耗時（p99.9）＋ 一次 full GC ＋ 一次網路抖動
```

實務上：

| 你知道的 | 建議 |
|---|---|
| 業務 p99 = 50ms，p99.9 = 200ms | TTL **3～5 秒**（留 15～25 倍餘裕） |
| 業務裡有呼叫外部 API | ⚠️ **不要估**，用 watchdog（9.6） |
| 業務裡有資料庫交易 | TTL **≥ 資料庫的 `lock_timeout`**，否則會出現「鎖沒了但交易還在跑」 |
| 完全估不出來 | **用 Redisson 的預設（30 秒 + watchdog）** |

⚠️ **最不該做的事是「量一次平均值然後乘以 2」。**
平均 20 毫秒的業務，p99.9 可能是 2 秒（一次 GC 就到了），**而你只需要一次就會超賣。**

> 📌 **但這一整節其實在繞遠路。** 只要你問「TTL 該設多久」，就代表你在猜。
> 下一節把這個問題整個拿掉。

---

## 9.6 watchdog：不要猜，續期

### 9.6.1 它解決的是哪一半

```
                   我還活著嗎？
                   ├─ 是 ──▶ 續期，鎖繼續留著        ← watchdog 做這件事
                   └─ 否 ──▶ 沒人續期，TTL 到就自己消失  ← TTL 原本的用途
```

**watchdog 讓你可以把 TTL 設得很短（幾秒），同時又不怕業務跑很久。**

- TTL 短 → 機器掛掉時，**別人幾秒鐘後就能繼續**（9.5.4 的代價被壓到最低）。
- 有續期 → 業務跑 10 分鐘也不會被中斷。

### 9.6.2 自己寫一個

```java
@Component
public class RenewingRedisLock {

    private final SimpleRedisLock delegate;
    private final ScheduledExecutorService watchdog =
            Executors.newScheduledThreadPool(2, r -> {
                Thread t = new Thread(r, "lock-watchdog");
                t.setDaemon(true);       // ⚠️ 一定要 daemon，否則 JVM 關不掉
                return t;
            });
    private final Map<String, ScheduledFuture<?>> tasks = new ConcurrentHashMap<>();
    private final Map<String, Boolean> lost = new ConcurrentHashMap<>();

    public String tryLock(String key, Duration ttl, Duration waitMax) throws InterruptedException {
        String token = delegate.tryLock(key, ttl, waitMax);
        if (token == null) return null;

        long period = Math.max(10, ttl.toMillis() / 3);      // 經典設定：每 1/3 TTL 續一次
        ScheduledFuture<?> f = watchdog.scheduleAtFixedRate(() -> {
            if (!delegate.renew(key, token, ttl)) {            // 續不到 → 鎖已經不是我的了
                lost.put(token, Boolean.TRUE);                 // ⚠️ 記一筆：業務正跑在一把不存在的鎖裡
                cancel(token);
            }
        }, period, period, TimeUnit.MILLISECONDS);
        tasks.put(token, f);
        return token;
    }

    public boolean unlock(String key, String token) {
        cancel(token);                                         // ⚠️ 先停 watchdog 再刪鎖
        return delegate.unlock(key, token);
    }

    public boolean lostLock(String token) { return lost.containsKey(token); }
}
```

續期本身也是一段 Lua——理由跟 9.4.4 一模一樣（**只能續我自己的鎖**）：

```lua
-- src/main/resources/scripts/renew-lock.lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
    return 0
end
```

**為什麼是 `ttl / 3`：**

```
TTL = 300ms，每 100ms 續一次

  0ms    100ms   200ms   300ms
  ├───────┼───────┼───────┤
  拿鎖    續①     續②     續③
          └─ 如果續①失敗（網路抖一下），還有續②、續③兩次機會
```

⚠️ **不要設成 `ttl / 2`**：只剩一次補救機會。
⚠️ 也不要設成 `ttl / 10`：Redis 白白多收 10 倍的 `PEXPIRE`。

### 9.6.3 實測

同樣 30 個執行緒、業務 300 毫秒，**TTL 故意設成會出事的 200 毫秒**：

```
═══ 9.6.3 watchdog 續期：TTL 故意設成 200ms（＜ 業務 300ms） ═══
  TTL 200ms (renew)   互斥失效 0 次｜同時最多 1 人｜業務跑到一半鎖沒了 0 次｜總耗時 9,430 ms
```

| TTL 200ms | 互斥失效 | 總耗時 |
|---|---|---|
| 沒續期 | **29 次** | 6,388 ms |
| **有續期** | **0 次** | 9,430 ms ←（＝ TTL 400ms 那一列的 9,444 ms） |

**同一個 TTL，加上 watchdog 就完全正確了**，而且耗時跟「正確地猜對 TTL」一模一樣。

再加碼一次：業務突然變成 **1.5 秒**（TTL 還是 200 毫秒，也就是業務比 TTL 久 7.5 倍）：

```
═══ 9.6.3b 業務突然變慢（1.5 秒），TTL 還是 200ms ═══
  watchdog + 業務 1500ms：互斥失效 0 次｜鎖掉過 0 次
```

> 📌 **這就是 watchdog 的價值**：
> **你不再需要知道業務會跑多久。**

### 9.6.4 ⚠️ watchdog 的三個限制

**① 它救不了「行程還活著，但業務已經卡死」**

watchdog 跑在另一條執行緒上。業務執行緒卡在一個沒有逾時的 HTTP 呼叫上時，
**watchdog 會很盡責地一直續期，鎖就永遠不會釋放。**

```java
// ⚠️ 一定要有上限
private static final Duration MAX_HOLD = Duration.ofMinutes(5);
// watchdog 續到 MAX_HOLD 就停手，讓鎖自然過期
```

Redisson 也一樣——它的 watchdog **沒有**上限，這是它被抱怨最多的一點。

**② 續期失敗之後，業務已經在裸奔**

`lostLock(token)` 回 `true` 的時候，業務**已經跑了一段時間沒有鎖**。
你不能「補一把鎖回來」，只能：

```java
if (renewing.lostLock(token)) {
    log.error("持鎖期間鎖遺失，key={}，這一次的結果不可信", key);
    throw new LockLostException(key);      // 讓交易回滾，而不是假裝沒事
}
```

> ⚠️ **這一段大部分實作都沒寫**（包括很多線上教學的版本）。
> 沒寫的話，「鎖掉了」這件事**不會留下任何痕跡**。

**③ watchdog 執行緒本身是共用資源**

`Executors.newScheduledThreadPool(2)` ——兩條執行緒要服務所有的鎖。
持鎖 500 把、TTL 3 秒的話，每秒要送 500 次 `PEXPIRE`。
⚠️ 續期任務本身如果被 Redis 慢命令（03 章）卡住，**所有的鎖會一起掉**。

---

## 9.7 Redisson：不要自己寫

前面六節寫出來的東西，Redisson 都有，而且處理了更多邊界情況。
**正式環境請用 Redisson**。前面六節的價值是：出事的時候你看得懂它在做什麼。

### 9.7.1 ⚠️ 先講一個坑：starter 會換掉你的 Lettuce

大部分文章叫你加這個：

```xml
<!-- ⚠️ 先別急著用這個 -->
<dependency>
  <groupId>org.redisson</groupId>
  <artifactId>redisson-spring-boot-starter</artifactId>
  <version>3.27.2</version>
</dependency>
```

加下去之後跑一次這個測試：

```java
@Autowired RedisConnectionFactory factory;

@Test void who() {
    System.out.println("RedisConnectionFactory = " + factory.getClass().getName());
}
```

```
RedisConnectionFactory = org.redisson.spring.data.connection.RedissonConnectionFactory
bean: redissonConnectionFactory → RedissonConnectionFactory
```

> ⚠️ **你的 Lettuce 不見了。**
>
> `redisson-spring-boot-starter` 會註冊一個 `RedissonConnectionFactory`，
> 而 Spring Boot 的 `LettuceConnectionFactory` 是 `@ConditionalOnMissingBean` 的——
> **它讓位了。**
>
> 也就是說 06 章花一整章調的東西，**全部安靜地失效**：
>
> | 06 章設定的 | 加了 starter 之後 |
> |---|---|
> | `spring.data.redis.lettuce.pool.*` | ❌ 沒人讀 |
> | `timeout: 500ms`（command 逾時） | ❌ 換成 Redisson 的 `timeout`（預設 3000ms） |
> | `REJECT_COMMANDS`（6.9、8.4.7） | ❌ 不存在這個概念 |
> | `ClientOptions` / `SocketOptions` | ❌ 全部無效 |
>
> 而 08 章的熔斷、逾時、降級演練**全部要重做**，因為底層換人了。

**這一章的做法**：只拿 Redisson 的鎖，連線層維持 Lettuce。

```java
@Configuration
public class RedissonConfig {

    /**
     * ⚠️ 刻意不用 redisson-spring-boot-starter（9.7.1）。
     * 只要一個 RedissonClient，Spring Data Redis 那一側維持 Lettuce。
     */
    @Bean(destroyMethod = "shutdown")
    public RedissonClient redissonClient(
            @Value("${spring.data.redis.host}") String host,
            @Value("${spring.data.redis.port}") int port) {
        Config config = new Config();
        config.useSingleServer()
              .setAddress("redis://" + host + ":" + port)
              .setClientName("shop-service-redisson")   // ⚠️ 取跟 Lettuce 不同的名字，CLIENT LIST 才分得出來
              .setConnectionPoolSize(64)
              .setConnectionMinimumIdleSize(8)
              .setTimeout(3000)
              .setRetryAttempts(3);                      // ⚠️ 9.11.4 會看到這一行的副作用
        config.setLockWatchdogTimeout(30_000);           // 預設就是 30 秒
        return Redisson.create(config);
    }
}
```

對應的 Maven 座標是 `org.redisson:redisson`（**沒有** `-spring-boot-starter`）：

```xml
<dependency>
  <groupId>org.redisson</groupId>
  <artifactId>redisson</artifactId>
  <version>3.27.2</version>
</dependency>
```

驗證一下：

```
RedisConnectionFactory = org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
bean: redisConnectionFactory → LettuceConnectionFactory
redisson bean: redissonClient
```

✅ **兩個都在，各做各的事。**

> 📌 **代價**：你的應用會開兩組連線到 Redis（Lettuce 一組、Redisson 一組）。
> 在 `CLIENT LIST` 裡用 `client-name` 就分得出來——這也是為什麼上面要取不同的名字。

### 9.7.2 Redisson 的鎖在 Redis 裡長什麼樣子

```java
RLock lock = redisson.getLock("lock:product:1");
lock.lock();
```

```
TYPE        → hash
HGETALL     → 80f502f3-46c1-409f-b115-b9411518fd42:1 / 1
PTTL        → 29804 ms
holdCount   → 1
```

**它不是 String，是 Hash：**

```
key    lock:product:1
        └─ field  <客戶端 UUID>:<執行緒 ID>      ← 誰拿的
           value  1                             ← 重入次數
```

同一個執行緒再 `lock()` 一次：

```
--- 同一個執行緒再 lock() 一次 ---
HGETALL     → 80f502f3-46c1-409f-b115-b9411518fd42:1 / 2      ← 變成 2
holdCount   → 2
unlock 一次後 holdCount = 1，key 還在嗎 → 1                     ← 還在
全部 unlock 後 key 還在嗎 → 0
```

> 📌 **這就是可重入的全部機密**：把「鎖的持有者」跟「持有幾次」分開存。
> `HINCRBY` 一次加一、`unlock` 一次減一，**減到 0 才真的 `DEL`**。
>
> 用 String 存不下這兩件事——這就是 Redisson 選 Hash 的理由。

### 9.7.3 可重入：自己寫的版本會被自己鎖死

```java
RLock r = redisson.getLock(key);
r.lock();
boolean second = r.tryLock(1, TimeUnit.SECONDS);      // 同一個執行緒

String t1 = simple.tryLock(key, ttl, Duration.ofSeconds(1));
String t2 = simple.tryLock(key, ttl, Duration.ofSeconds(1));   // 同一個執行緒
```

```
═══ 9.7.3 可重入：同一個執行緒的第二次 lock() ═══
  Redisson  第二次 tryLock(1s) → true（可重入）
  自己寫的  第二次 tryLock(1s) → false（⚠️ 同一個執行緒也被自己擋住）
```

這件事在真實程式裡比想像中容易撞到：

```java
@DistributedLock(key = "'product:' + #id")
public void createOrder(Long id) {
    ...
    inventoryService.deduct(id);        // ← 這個方法上面也有 @DistributedLock(key = "'product:' + #id")
}
```

⚠️ 自己寫的版本在這裡會**卡到 `waitMax` 逾時，然後失敗**，
而且失敗訊息會是「取鎖逾時」——**你會去查是誰持有這把鎖，答案是你自己。**

### 9.7.4 watchdog：`lock()` 不帶 `leaseTime` 的時候

```java
lock.lock();        // 沒給 leaseTime
```

每 10 秒看一次 `PTTL`：

```
═══ 9.7.4 Redisson 的 watchdog：lock() 不帶 leaseTime ═══
   第  0 秒：PTTL = 29927 ms
   第 10 秒：PTTL = 29855 ms
   第 20 秒：PTTL = 29844 ms
   第 30 秒：PTTL = 29838 ms
   第 40 秒：PTTL = 29812 ms
```

**跑了 40 秒，PTTL 一直停在 29.8 秒左右。**
Redisson 的 watchdog 每 `lockWatchdogTimeout / 3`（預設 10 秒）把 TTL 重設回 30 秒——
跟 9.6.2 自己寫的那個一模一樣的策略。

```java
config.setLockWatchdogTimeout(30_000);   // 預設 30 秒；續期週期 = 它的 1/3
```

### 9.7.5 ⚠️ 給了 `leaseTime` 就**沒有** watchdog

```java
lock.lock(5, TimeUnit.SECONDS);      // 明確給 5 秒
```

```
═══ 9.7.5 給了 leaseTime 就沒有 watchdog ═══
   第 0 秒：PTTL = 4942 ms，EXISTS = 1
   第 2 秒：PTTL = 2798 ms，EXISTS = 1
   第 4 秒：PTTL = 649 ms，EXISTS = 1
   第 6 秒：PTTL = -2 ms，EXISTS = 0
   ⚠️ 業務還沒做完，鎖已經自己不見了
```

> ⚠️ **這是 Redisson 最容易誤用的一個 API。**
>
> | 寫法 | watchdog | 鎖什麼時候消失 |
> |---|---|---|
> | `lock()` | ✅ 有 | `unlock()`，或行程死後 30 秒 |
> | `tryLock(waitTime, unit)` | ✅ 有 | 同上 |
> | `lock(leaseTime, unit)` | ❌ **沒有** | **leaseTime 到，不管業務做完沒** |
> | `tryLock(waitTime, leaseTime, unit)` | ❌ **沒有** | 同上 |
>
> 📌 **一句話**：**只要你傳了 `leaseTime`，你就回到了 9.5——自己猜。**
>
> 很多人寫 `tryLock(3, 10, SECONDS)` 是想表達「等 3 秒、最多鎖 10 秒」，
> 但真正的效果是**「10 秒後鎖一定消失，就算業務還在跑」**。
> **想要保護就用 `tryLock(waitTime, unit)`，想要上限就自己在業務裡加逾時。**

### 9.7.6 自旋 vs pub/sub：等鎖的成本

自己寫的版本是**自旋**：拿不到就 sleep 一下再試。
Redisson 是**訂閱**：拿不到就 `SUBSCRIBE` 一個頻道，前一個人 `unlock` 時 `PUBLISH` 通知。

200 個執行緒搶同一把鎖，臨界區時間從 5 毫秒拉到 50 毫秒：

```
═══ 9.7.6 自旋 vs pub/sub：200 個執行緒搶同一把鎖 ═══
  臨界區時間 | 實作          |     耗時 | Redis 命令數 | 每次取鎖敲幾個命令
  -----------+---------------+----------+--------------+-----------------
       5 ms  | 自己寫的（自旋）  |  1,805 ms |    3,728 次 |   18.6 個
       5 ms  | Redisson       |  1,590 ms |    4,163 次 |   20.8 個
      20 ms  | 自己寫的（自旋）  |  5,292 ms |    8,134 次 |   40.7 個
      20 ms  | Redisson       |  5,080 ms |    3,995 次 |   20.0 個
      50 ms  | 自己寫的（自旋）  | 11,352 ms |   15,752 次 |   78.8 個
      50 ms  | Redisson       | 11,217 ms |    4,059 次 |   20.3 個
```

> 📌 **看最後一欄的兩條曲線：**
>
> ```
>  每次取鎖的 Redis 命令數
>   80 ┤                              ● 自旋（78.8）
>   60 ┤
>   40 ┤              ● 自旋（40.7）
>   20 ┤  ●●          ○ Redisson（20.0）  ○ Redisson（20.3）
>      └──┬───────────┬──────────────────┬──────
>        5ms         20ms               50ms      臨界區時間
> ```
>
> **自旋是線性的，pub/sub 是常數的。**
> 臨界區越久、等的人越多，自旋就越浪費——
> 而 03 章已經證明過，**Redis 是單執行緒的，你浪費的是所有人的 Redis。**

⚠️ 注意**耗時幾乎一樣**（11,352 vs 11,217）。
**自旋的代價不會出現在你的 API 延遲上，只會出現在 Redis 的 QPS 上。**
這正是它容易被忽略的原因：你的服務看起來沒問題，Redis 的 CPU 圖表卻莫名其妙地高。

### 9.7.7 公平鎖：先到先得，但要付錢

20 個執行緒連續搶同一把鎖 5 秒，數每個人搶到幾次：

```
═══ 9.7.7 公平鎖 vs 非公平鎖：20 個執行緒連搶 5 秒，誰搶到幾次 ═══
  非公平鎖  5 秒內總共取鎖 664 次｜最少的人 15 次、最多的人 53 次（差 3.5 倍）｜Redis 命令 11,879 次（每次取鎖 17.9 個）
           每個執行緒：[26, 37, 28, 36, 42, 37, 29, 36, 37, 30, 31, 27, 35, 53, 28, 15, 48, 25, 32, 32]

  公平鎖    5 秒內總共取鎖 682 次｜最少的人 34 次、最多的人 35 次（差 1.0 倍）｜Redis 命令 41,100 次（每次取鎖 60.3 個）
           每個執行緒：[34, 35, 34, 34, 34, 34, 34, 34, 34, 34, 34, 34, 34, 34, 34, 34, 34, 34, 34, 35]
```

| | 非公平鎖 | 公平鎖 |
|---|---|---|
| 5 秒總取鎖次數 | 664 | 682 |
| 最少 / 最多 | **15 / 53（3.5 倍）** | **34 / 35（1.0 倍）** |
| 每次取鎖的 Redis 命令 | **17.9 個** | **60.3 個（3.4 倍）** |

**公平鎖真的公平**（34、34、34……整齊到有點不真實），**吞吐量也沒有變差**。
代價全部落在 Redis 上：**每次取鎖多敲 3.4 倍的命令。**

它多出來的東西看得到：

```
公平鎖持有中，Redis 裡有這些 key：
  myfair                          TYPE=hash  db139c6a-...:1 / 1
  redisson_lock_queue:{myfair}    TYPE=list  db139c6a-...:71          ← 排隊的人（FIFO）
  redisson_lock_timeout:{myfair}  TYPE=zset  db139c6a-...:71 / 1789702165289  ← 每個人的排隊逾時
```

> 📌 `{myfair}` 那個大括號是 **hash tag**（13 章）——
> 它保證這三個 key 在 Cluster 上一定落在同一個 slot，Lua 才跑得動。
> **Redisson 的每一個 key 都這樣寫，你自己寫鎖的時候也要。**

**什麼時候需要公平鎖：**

| 場景 | 建議 |
|---|---|
| 搶購、秒殺 | ❌ **不要**——本來就不需要公平，而且多 3.4 倍成本 |
| 背景任務排隊（每個任務都必須跑到） | ✅ 需要 |
| 使用者會重試的操作 | ❌ 不需要——重試本身就是一種公平 |
| ⚠️ **等鎖的人很多，而且等不到會逾時失敗** | ✅ 需要，否則 3.5 倍的差距會變成「某些使用者永遠失敗」 |

### 9.7.8 `lock()` / `tryLock()` 五種多載，選哪一個

```java
lock.lock();                                  // ⚠️ 永遠等下去
lock.lock(10, SECONDS);                       // ⚠️ 永遠等；拿到後 10 秒強制過期（沒有 watchdog）
lock.tryLock();                               // 拿不到立刻回 false
lock.tryLock(3, SECONDS);                     // ✅ 等 3 秒；有 watchdog
lock.tryLock(3, 10, SECONDS);                 // ⚠️ 等 3 秒；10 秒強制過期（沒有 watchdog）
```

> 📌 **預設就用 `tryLock(waitTime, unit)`**。
>
> ⚠️ **不要用 `lock()`**：它會永遠等下去。
> 在一個 Tomcat 執行緒上「永遠等下去」的意思是
> **那條執行緒永遠回不去執行緒池**——08 章 8.2.4 已經演過這件事的結局
> （50 條執行緒全滿，連不相關的 API 一起 503）。
>
> `waitTime` 要怎麼設？**比你的 HTTP 逾時短一點。**
> 前端等 3 秒就放棄的話，`waitTime` 設 10 秒毫無意義——
> **你只是在為一個已經沒人在等的請求佔著執行緒。**

⚠️ **釋放一定要檢查持有者：**

```java
} finally {
    if (lock.isHeldByCurrentThread()) lock.unlock();   // ✅
}
```

直接 `lock.unlock()` 的話，如果鎖已經因為某種原因不在你手上，會丟 `IllegalMonitorStateException`，
**而它會蓋掉業務原本要丟的那個例外**——你會看到一個跟事故完全無關的錯誤訊息。

### 9.7.9 自己寫 vs Redisson

| | 自己寫（9.3～9.6） | Redisson |
|---|---|---|
| 取鎖 | `SET NX PX` | Lua（`HEXISTS` + `HINCRBY` + `PEXPIRE`） |
| 釋放 | Lua 比對 token | Lua 減重入次數，歸零才 `DEL` |
| 等鎖 | 自旋，成本隨臨界區線性成長 | pub/sub，常數成本 |
| 可重入 | ❌ 會鎖死自己 | ✅ |
| 續期 | 自己接 watchdog | ✅ 內建（但 ⚠️ 沒有上限） |
| 公平鎖 | ❌ | ✅（3.4 倍成本） |
| 讀寫鎖、Semaphore、CountDownLatch | ❌ | ✅ |
| Sentinel / Cluster | 要自己處理（13 章） | ✅ |
| **出事的時候你看得懂嗎** | ✅ **這是自己寫的唯一價值** | 要讀它的 Lua |

> 📌 **建議**：**用 Redisson，但把 9.3～9.6 自己寫過一遍。**
> 不然 `RLock` 對你來說只是一個 `lock()` / `unlock()`，
> 而 9.7.5 那種「我明明設了 `leaseTime` 為什麼鎖不見了」的問題你會查很久。

---

## 9.8 ⚠️ 鎖與交易的順序：只有一種是對的

這一節是整章最重要的一節。**前面七節做對了，這一節做錯，全部歸零。**

### 9.8.1 兩種寫法，差別只有一個 `@Transactional` 標在哪

```java
/** ⚠️ 錯的順序：交易在外，鎖在裡。 */
@Transactional
public boolean buyLockInsideTx(Long id, String user) {
    String token = lock.tryLock(key(id), TTL, WAIT);
    try {
        Product p = products.findById(id).orElseThrow();
        if (p.getStock() <= 0) return false;
        p.setStock(p.getStock() - 1);
        orders.save(new OrderRow(id, user));
    } finally {
        lock.unlock(key(id), token);     // ← 鎖在這裡就放掉了
    }
    return true;                          // ← 交易到這裡才提交
}

/** ✅ 對的順序：鎖在外，交易在裡。 */
public boolean buyLockOutsideTx(Long id, String user) {
    String token = lock.tryLock(key(id), TTL, WAIT);
    try {
        return dao.buyInOneTransaction(id, user);   // 交易在這裡開始與結束
    } finally {
        lock.unlock(key(id), token);                 // ← 提交之後才放鎖
    }
}
```

**看起來只是縮排不同。** 實測差 145 件。

### 9.8.2 實測：鎖包在交易裡面

200 個執行緒、100 件庫存。兩個變體：解鎖之後交易裡**還有沒有別的事要做**。

```
═══ 9.8.2 鎖包在交易裡面（交易在外、鎖在內） ═══
  ① 解鎖後交易裡沒別的事        訂單 103 筆，庫存剩 0，超賣   3 件，耗時 1,071 ms
  ② 解鎖後交易裡還有 20ms 的事   訂單 200 筆，庫存剩 45，超賣 145 件，耗時 1,909 ms
```

（跑八次：**① 是 1、2、2、3、3、4、4、6 件**，② 是 142、144、145、145 件。
⚠️ ② 很穩定，**① 不穩定——而不穩定的那個才是危險的**，下一段就說為什麼。）

> ⚠️ **請先看 ①：只超賣 1 ～ 6 件。**
>
> 3 件在 200 次請求裡是 1.5%。你的單元測試會過，你的 QA 會過，
> **你的壓測跑 1000 次也只會多出十幾筆訂單，而沒有人會去數。**
>
> 而且它**每次的數字都不一樣**（1 ～ 6）——
> 所以就算有人真的去數了，也會覺得那是壓測工具的誤差。
>
> 📌 **這才是這個 bug 真正的形狀**：
> 它不是「一定壞」，是**「偶爾壞，而且壞得剛好在雜訊裡」**。
>
> ② 只是把交易在解鎖後多做 20 毫秒的事——
> **在真實的服務裡，這 20 毫秒是你寫記錄檔、發領域事件、更新統計欄位的時間。**
> 超賣立刻從 3 件變成 145 件。

### 9.8.3 實測：交易包在鎖裡面

```
═══ 9.8.3 交易包在鎖裡面（鎖在外、交易在內） ═══
  ③ 鎖在外、交易在內            訂單 100 筆，庫存剩 0，超賣 0 件，耗時 1,240 ms
```

**訂單剛好 100 筆，庫存剛好 0，超賣 0 件。** 耗時 1,240 ms vs ① 的 1,071 ms——**慢 16%。**

| | 訂單 | 超賣 | 耗時 |
|---|---|---|---|
| ① 鎖在交易裡（無尾巴） | 103 | 3 | 1,071 ms |
| ② 鎖在交易裡（尾巴 20ms） | 200 | **145** | 1,909 ms |
| ✅ ③ 交易在鎖裡 | **100** | **0** | 1,240 ms |

### 9.8.4 為什麼順序反了就錯

```
時間軸 ──────────────────────────────────────────────────────────────▶

A：  開交易 ─ 拿鎖 ─ 讀庫存=1 ─ 寫庫存=0 ─ 放鎖 ─ ... ─ COMMIT
                                            ↑            ↑
                                      鎖已經放掉了     資料才真的變成 0
                                            │
                                      ┌─────┴──────┐
                                      │ 這段時間裡  │  ⚠️ 資料庫裡庫存還是 1
                                      │ 沒有鎖，   │     （A 的修改還沒提交，
                                      │ 資料也還沒 │       別人看不到 —— READ COMMITTED）
                                      │ 更新      │
                                      └─────┬──────┘
B：                                       拿鎖 ─ 讀庫存=1 ─ 寫庫存=0 ─ 放鎖 ─ COMMIT
                                                     ↑
                                              B 讀到的是舊值
```

> 📌 **一句話**：
> **鎖保護的是「臨界區」，而交易沒提交前，臨界區還沒結束。**
>
> 換個說法：**鎖的生命週期必須完全覆蓋交易的生命週期。**
> 鎖先放掉，等於在交易的最後一段裸奔。
>
> ⚠️ 這跟 07 章 7.7 的 `@CacheEvict` 是**同一個**問題的兩個面貌：
> 07 章是「清了快取、交易還沒提交、別人把舊值寫回快取」，
> 這裡是「放了鎖、交易還沒提交、別人讀到舊值」。
> **兩次都是因為有人以為 `finally` 跑完就結束了。**

### 9.8.5 ⚠️ 用註解做鎖時，`@Order` 決定順序

實務上大家會把鎖包成註解：

```java
@DistributedLock(key = "'product:' + #id")
@Transactional
public boolean buy(Long id, String user) { ... }
```

**這兩個註解的相對順序不是由你寫的順序決定的，是由切面的 `@Order` 決定的。**

```
數字小 ──▶ 外層
數字大 ──▶ 內層

Spring 的交易切面預設 order = Ordered.LOWEST_PRECEDENCE（Integer.MAX_VALUE）
                                                            ↑
                                  所以任何「有設 @Order」的切面都會跑在它外面
```

```java
@Aspect
@Component
@Order(0)                   // ⚠️ 這一行是整個切面最重要的一行
public class DistributedLockAspect { ... }
```

⚠️ **沒寫 `@Order` 的話會怎樣？** 沒寫 `@Order` 的切面，order 也是 `LOWEST_PRECEDENCE`——
**跟交易切面一樣**，於是順序由 bean 的宣告順序決定，**而那是不保證的**。

實測（同一段業務，一個 `@Order(0)`，一個 `@Order(LOWEST_PRECEDENCE)`）：

```
═══ 9.8.5 用註解做鎖：@Order(0) 的切面（鎖在交易外） ═══
  @DistributedLock    訂單 100 筆，庫存剩 0，超賣 0 件，例外 0 次，耗時 1,121 ms

═══ 9.8.5 同一段程式，切面 @Order 設成 LOWEST_PRECEDENCE（鎖掉進交易裡） ═══
  @LockInsideTx       訂單 102 筆，庫存剩 0，超賣 2 件，例外 0 次，耗時 903 ms
  切面執行時交易已經開了嗎 → true（order 相同 → 順序由宣告順序決定，⚠️ 不保證）
```

**「切面執行時交易已經開了嗎 → true」** ——這就是證據：
鎖的切面跑起來的時候，交易**已經開了**，所以鎖在交易裡面。超賣 2 件（跑三次都是 2 件）。

> 📌 **在我這台機器上是 `true`。在你那台可能是 `false`。**
> **這正是問題所在**——它不是一個「錯的設定」，是一個**沒有定義行為的設定**。
> 換一個 Spring 版本、加一個 `@Component`，結果就可能翻過來。

### 9.8.6 一條可以寫進 code review 的規則，加一個執行期自檢

**規則**：

> 🔒 **加鎖一定在開交易之前，解鎖一定在提交之後。**
> 也就是：`@Transactional` **永遠**在 `@DistributedLock` 的內層。

**但規則會被違反，所以再加一個在執行期就會擋下來的自檢**：

```java
@Around("@annotation(ann)")
public Object around(ProceedingJoinPoint pjp, DistributedLock ann) throws Throwable {
    // 🔒 執行期自檢：如果進到這裡的時候交易已經開了，代表 @Order 設錯了
    if (TransactionSynchronizationManager.isActualTransactionActive()) {
        throw new IllegalStateException(
                "分散式鎖被包在交易裡面了（9.8）：鎖釋放時交易還沒提交。"
              + " 請確認 DistributedLockAspect 的 @Order 小於交易切面的 order。");
    }
    ...
}
```

> 📌 **這六行程式的價值**：
> 它把一個「壓測 200 次才多出 3 筆訂單」的問題，
> 變成一個**在第一次呼叫就會炸開、而且訊息直接告訴你怎麼修**的問題。
>
> ⚠️ **別忘了對應的測試**：
>
> ```java
> @Test void 鎖一定要在交易外面() {
>     assertThatThrownBy(() -> service.buyWrongOrder(1L, "u", 0))
>             .isInstanceOf(IllegalStateException.class)
>             .hasMessageContaining("分散式鎖被包在交易裡面");
> }
> ```

**手寫版本的等價規則**（沒有用註解的話）：

```java
// ✅ 鎖在外，@Transactional 的方法在另一個 bean 上
public boolean buy(Long id, String user) {
    String token = lock.tryLock(key(id), TTL, WAIT);
    if (token == null) throw new LockBusyException(key(id));
    try {
        return dao.buyInOneTransaction(id, user);   // ⚠️ 必須是另一個 bean（自呼叫不生效）
    } finally {
        lock.unlock(key(id), token);
    }
}
```

⚠️ **注意 `dao` 是另一個 bean。** 如果 `buyInOneTransaction` 寫在同一個類別裡，
`@Transactional` 根本不會生效（9.2.2 的那個坑），
**結果是「沒有交易」——那反而看起來是對的，直到你在裡面寫第二張表。**

---

## 9.9 鎖的粒度與 key 設計

### 9.9.1 鎖的三個屬性

```
鎖住什麼   ──▶ key 的設計（9.9.3）
鎖多久     ──▶ TTL + watchdog（9.5、9.6）
鎖多大範圍 ──▶ 粒度（9.9.2）  ← 這一個決定你的吞吐量
```

### 9.9.2 實測：一把全域鎖慢了 21 倍

200 個請求打在 **20 個不同的商品**上，臨界區 20 毫秒：

```
═══ 9.9.2 鎖的粒度：200 個請求打在 20 個商品上 ═══
  一把全域鎖        耗時 5,274 ms（理論下限：4000 ms）
  每個商品一把鎖     耗時   252 ms（理論下限：200 ms）
```

**21 倍。**

```
一把全域鎖：   200 個請求 × 20ms 全部排隊  = 4,000 ms（下限）
每商品一把鎖：  20 條隊伍各排 10 個 × 20ms = 200 ms（下限）
```

> 📌 **兩者的「正確性」完全一樣**——都沒有超賣。
> 差別純粹是**你把多少不相干的請求放進同一條隊伍**。
>
> ⚠️ 而且全域鎖還有一個實測看不到的代價：
> **9.5.4 說 TTL 就是 MTTR。全域鎖 + TTL 30 秒 = 一台機器掛掉，整個服務停 30 秒。**

### 9.9.3 key 怎麼命名

接續 01 章 1.2 的命名規約：

```
lock:<資源類型>:<資源 ID>[:<動作>]

lock:product:1234                商品 1234 的庫存
lock:order:create:user:5678      使用者 5678 的「建立訂單」
lock:job:daily-settlement        每日結算排程（全域，只有一個）
lock:account:transfer:{9001}     ⚠️ Cluster 上要用 hash tag（13 章）
```

| ⚠️ 不要這樣 | 理由 |
|---|---|
| `lock` | 全域鎖，9.9.2 那 21 倍 |
| `product_lock_1234` | 前綴不統一，`SCAN lock:*` 找不到它 |
| `lock:` + `list.toString()` | 順序不同就是不同的鎖——**兩個人鎖同一組資源卻互不排斥** |
| `lock:` + 使用者輸入 | ⚠️ 有人可以送一個超長字串把你的記憶體吃掉（02 章） |

### 9.9.4 ⚠️ 鎖的範圍要跟「資料的範圍」一樣大

最容易出事的不是粒度太粗，而是**粒度跟資料對不上**：

```java
// ⚠️ 鎖的是商品，改的是訂單
@DistributedLock(key = "'product:' + #productId")
public void refund(Long productId, Long orderId) {
    ...
    orderRepository.updateStatus(orderId, REFUNDED);   // ← 這裡沒有被保護
}
```

同一張訂單可能有兩個不同商品的退款請求同時進來——
**鎖的 key 不同，兩個人同時進到臨界區，而他們改的是同一列。**

> 📌 **檢查方法**：把方法裡**所有被寫入的資料**列出來，
> 問一句「有沒有哪一筆，可能被一個拿著**不同 key**的請求同時改？」
> 有的話，**鎖的粒度就錯了**（要嘛換 key，要嘛多鎖一把，要嘛把它拆成兩個方法）。

⚠️ **鎖兩把的時候，一定要固定順序**：

```java
// ⚠️ A 鎖 1 再鎖 2，B 鎖 2 再鎖 1 → 死鎖（而且會等滿 waitTime 才失敗）
List<Long> ids = new ArrayList<>(List.of(fromId, toId));
Collections.sort(ids);                                    // ✅ 固定順序
RLock multi = redisson.getMultiLock(
        redisson.getLock("lock:account:" + ids.get(0)),
        redisson.getLock("lock:account:" + ids.get(1)));
multi.tryLock(3, TimeUnit.SECONDS);
```

Redisson 的 `getMultiLock()` 幫你把「全部拿到才算成功、失敗時全部放掉」做好了，
**但它不會幫你排序**——那是你的責任。

---

## 9.10 RedLock，以及 Redis 的鎖到底安不安全

### 9.10.1 單點的問題

前面九節都假設一台 Redis。那台 Redis 掛了呢？

```
主從架構：

  Client ── SET NX PX ──▶ [ 主 ] ─ 非同步複製 ─▶ [ 從 ]
                            │                      ↑
                          回 OK                 還沒收到
                            │
                          主掛了 ──▶ 從升主 ──▶ ⚠️ 鎖不見了
                                                   │
                        另一個 Client 來 SET NX PX ─┘ ──▶ 成功
                                                   
                        ⚠️ 兩個人同時持有同一把鎖
```

**Redis 的複製是非同步的**（13 章會完整拆解）。
只要「主回 OK」跟「從收到」之間有落差，切換就會丟鎖。**這不是 bug，是設計。**

### 9.10.2 RedLock 與那場爭論

Redis 作者 antirez 為此提出 **RedLock**：

```
準備 5 台「互相獨立」的 Redis（不是主從，是 5 台各自獨立的）

  ① 記下現在時間 T1
  ② 依序向 5 台送 SET NX PX（每一台都給很短的逾時）
  ③ 成功的台數 ≥ 3（多數）  而且  現在時間 - T1 < TTL
         → 拿到鎖，實際有效時間 = TTL - (現在 - T1) - 時鐘誤差
  ④ 否則 → 向全部 5 台送釋放
```

2016 年，Martin Kleppmann（《Designing Data-Intensive Applications》作者）寫了一篇
**《How to do distributed locking》** 反對它，antirez 隔天回了一篇。這是分散式系統領域最有名的爭論之一。

**爭論的核心不是「RedLock 有沒有 bug」，而是「鎖到底能保證什麼」**：

| | Kleppmann | antirez |
|---|---|---|
| RedLock 依賴時鐘 | ⚠️ 時鐘會跳（NTP 校正、VM 暫停、閏秒） | 只要不跳超過誤差就好 |
| GC 停頓 | ⚠️ **任何鎖都擋不住**，需要 fencing token | 大部分場景不需要 |
| 結論 | **要正確性就用 ZooKeeper / etcd + fencing** | Redis 夠用，而且快很多 |

> 📌 **兩個人其實都對，因為他們在講不同的場景。** 分界線是這一句：
>
> **「拿到鎖」跟「在被保護的資源上真的還持有鎖」是兩件事。**

### 9.10.3 實測：鎖過期 ＋ STW，鎖救不了你

這是 Kleppmann 那篇文章裡的圖，跑成程式：

```
A：拿鎖(TTL 200ms) ─┬─ [ GC 停頓 400ms，程式自己完全不知道 ] ─┬─ 寫入
                    │                                        │
                 200ms 鎖過期                                 ⚠️ A 以為自己還持有鎖
                    │
B：              拿鎖 ──── 寫入 ────
```

```java
// A：拿鎖 → 被 GC 停住 400ms（鎖 TTL 只有 200ms）
String ta = simple.tryLock(key, Duration.ofMillis(200), ...);
Long fa = useFencing ? redis.opsForValue().increment("fence:counter") : null;
new Thread(() -> {
    sleepQuiet(400);                  // ← STW
    store.write("v", myValue, fa);    // 它以為自己還持有鎖
}).start();

// B：A 的鎖過期後拿到鎖，正常寫入
sleepQuiet(250);
String tb = simple.tryLock(key, Duration.ofMillis(3000), ...);
Long fb = useFencing ? redis.opsForValue().increment("fence:counter") : null;
store.write("v", newValue, fb);
```

`FencedStore` 只接受「token 比上一次大」的寫入——
真實世界裡這個檢查在資料庫（`UPDATE ... WHERE fence_token < ?`）：

```java
synchronized void write(String k, int v, Long token) {
    if (token != null) {
        Long last = fence.get(k);
        if (last != null && token <= last) { rejected.incrementAndGet(); return; }  // ⛔ 舊的持鎖者
        fence.put(k, token);
    }
    value.put(k, v);
}
```

```
═══ 9.10.3 鎖過期 + STW：Redis 的鎖救不了你，fencing token 可以 ═══
  沒有 fencing   10 回合裡，舊的持鎖者蓋掉新資料 10 次｜被 fencing 擋下  0 次
  有 fencing    10 回合裡，舊的持鎖者蓋掉新資料  0 次｜被 fencing 擋下 10 次
```

**10 回合，10 次資料被舊的持鎖者蓋掉。** 而這裡的鎖是完全正確的：
`SET NX PX`、Lua 釋放、token 比對，**每一條規則都遵守了。**

> 📌 **fencing token 的關鍵是「檢查發生在被保護的資源上」，不是在鎖上。**
>
> ```
>       ┌─ Redis：發 token（單調遞增，INCR 就夠了）
>  鎖 ──┤
>       └─ 資料庫：UPDATE ... WHERE fence_token < :myToken   ← 真正的防線在這裡
> ```
>
> ⚠️ **這代表被保護的資源必須「看得懂 token」。**
> 如果你保護的是一個外部 API、一封 email、一台印表機——**它們不會檢查 token，
> 那你就沒有 fencing，只能接受「極小機率會做兩次」。**

### 9.10.4 一句話：什麼時候可以用 Redis 的鎖

| 你的需求 | 用什麼 |
|---|---|
| **效率**：避免重複做（重複寄信、重複算報表、重複拉資料） | ✅ **Redis 鎖夠用**。偶爾做兩次的代價是「多寄一封信」 |
| **正確性**：絕對不能做兩次（扣款、發貨、開獎） | ⚠️ **Redis 鎖不夠**。要加 fencing token，或把最終檢查放在資料庫（12 章） |
| 正確性 + 資源不支援 fencing（外部 API） | ⚠️ ZooKeeper / etcd（它們也擋不住 GC，但 session 機制讓窗口小很多），**並且做冪等**（10 章） |

> 📌 **這一站的立場**：
> **用 Redis 鎖來「減少衝突」，用資料庫來「保證正確」。**
>
> 也就是說 9.8.3 那個正確版本的完整形狀是：
>
> ```java
> lock.tryLock(...)                                   // ① Redis：把 99.99% 的衝突擋在外面
> try {
>     dao.deductIfEnough(productId);                  // ② 資料庫：UPDATE ... WHERE stock > 0
>     //                                                  ↑ 最後一道防線，它才是真正保證不超賣的那個
> } finally { lock.unlock(...); }
> ```
>
> ⚠️ **如果你的程式拿掉 Redis 鎖之後就會出錯，那它本來就是錯的。**
> 12 章會把 ② 這一行完整展開。

---

## 9.11 ⚠️ 鎖不能降級

### 9.11.1 08 章決策表上的那一行

```
| **分散式鎖** | **09** | **❌ 直接失敗** | 「拿不到鎖就當作拿到了」＝ 超賣 |
```

08 章花了一整章教你「Redis 掛了不要讓服務跟著掛」。**這一章要收回其中一部分。**

```java
// ⚠️ 絕對不要寫這個
try {
    token = lock.tryLock(key, TTL, WAIT);
} catch (Exception e) {
    log.warn("Redis 掛了，跳過鎖", e);
    token = "degraded";        // ⚠️⚠️⚠️
}
```

**這行程式碼在 Redis 正常時什麼都不做，在 Redis 故障的那 60 秒把你的庫存清空。**
而且它不會出現在錯誤率圖表上——**它會出現在對帳單上**（08 章 8.8 的那句話）。

### 9.11.2 實測：持鎖中途 Redis 不回話

```java
String token = simple.tryLock(key, Duration.ofSeconds(30), ...);   // 拿到鎖
docker("pause", "redis-lab");                                      // ← Redis 凍住
boolean released = simple.unlock(key, token);                      // 業務做完要放鎖
```

```
═══ 9.11.2 持鎖中途 Redis 不回話（docker pause 3 秒） ═══
  取鎖成功，開始做業務……
  業務做完了要放鎖 → 等了 535 ms，結果：QueryTimeoutException → Command timed out after 500 millisecond(s)，釋放成功（程式以為的）= false
  ⚠️ unpause 一秒後回頭看：EXISTS lock:failure-demo = 0  ← 0 代表那個「逾時」的 unlock 其實還是跑了，只是晚了
```

> ⚠️ **最後一行是這一節最重要的發現：逾時不等於沒執行。**
>
> Lettuce 在 500 毫秒（06 章 6.9.1 設的）之後放棄等待、丟出 `QueryTimeoutException`，
> **但那個 `EVALSHA` 已經送到 Redis 了**，Redis 恢復之後照樣執行。
>
> 📌 這對「釋放鎖」來說是好消息（鎖最後還是放掉了），
> 但對**任何有副作用的命令**來說是壞消息：
> 05 章 5.11 的第 ③ 條（「拋了例外表示沒生效」是錯的）在這裡拿到了實證。
>
> ⚠️ **所以：逾時之後不要「重試一次扣款」。** 先查狀態，或者做冪等（10 章）。

### 9.11.3 實測：取鎖時 Redis 不回話

```
═══ 9.11.3 取鎖時 Redis 不回話：20 個請求各自看到什麼 ═══
  20 個請求：成功取鎖 0，例外 20，耗時 511 ms
      20 次  QueryTimeoutException: Command timed out after 500 millisecond(s)
  📌 ⚠️ 這裡沒有「降級」這個選項：拿不到鎖就不能做事（8.8 的決策表）。
```

**20/20 全部失敗，511 毫秒。** 而這正是**應該**發生的事：

```
Redis 不能用  ──▶  拿不到鎖  ──▶  不能保證互斥  ──▶  ❌ 拒絕這個請求（503）
                                                     └── 不是 500，是 503：
                                                         告訴客戶端「等一下再試」
```

⚠️ 注意 08 章 8.3 的 `CacheErrorHandler` **管不到這裡**——那是 Spring Cache 的擴充點，
而鎖走的是 `RedisTemplate`（8.3.5 已經說過）。**鎖的失敗處理必須自己寫。**

### 9.11.4 ⚠️ Redisson 的 `tryLock(3, SECONDS)` 等了 17 秒

同樣的情況，換成 Redisson：

```java
boolean got = redisson.getLock(key).tryLock(3, TimeUnit.SECONDS);
```

```
═══ 9.11.4 同樣的情況，Redisson 看到什麼 ═══
  tryLock(3s) 等了 17,218 ms → RedisException(Unexpected exception while processing command)
                                → NullPointerException(Cannot invoke "java.lang.Throwable.getMessage()" ...)
```

> ⚠️ **17 秒。你要求的是 3 秒。**
>
> 原因在 9.7.1 那段設定裡：
>
> ```java
> .setTimeout(3000)        // 一個命令等 3 秒
> .setRetryAttempts(3)     // 失敗重試 3 次
> ```
>
> `waitTime` 約束的是「**等鎖**」的時間，不是「**等 Redis**」的時間。
> Redis 不回話時，每一次嘗試都要先耗掉 `timeout × (retryAttempts + 1)`。
>
> 📌 **這在 08 章的語言裡是災難**：一個「應該 3 秒內失敗」的請求佔住執行緒 17 秒。
> 50 條 Tomcat 執行緒 ÷ 17 秒 = **每秒只能處理 3 個請求**（8.4.1 的 Little's Law）。
>
> **要壓下來就調 Redisson 自己的參數：**
>
> ```java
> config.useSingleServer()
>       .setTimeout(500)          // ← 對齊 06 章的 500ms
>       .setRetryAttempts(1)      // ← 鎖不需要重試那麼多次
>       .setRetryInterval(200);
> ```
>
> ⚠️ 順便注意那個例外訊息：`NullPointerException(Cannot invoke ...getMessage())`。
> **Redisson 在這條路徑上自己爆了 NPE。**
> 你在正式環境看到的錯誤訊息會是這個，而它跟「Redis 不回話」四個字毫無關係——
> **記得把 `RedisException` 整條 cause chain 都印出來。**

### 9.11.5 那該怎麼辦

```java
public Order createOrder(Long productId, String userId) {
    RLock lock = redisson.getLock("lock:product:" + productId);
    boolean got;
    try {
        got = lock.tryLock(2, TimeUnit.SECONDS);
    } catch (RedisException | InterruptedException e) {
        // ⚠️ 不降級。Redis 不能用 → 這個功能就不能用
        log.error("取鎖失敗（Redis 異常），productId={}", productId, e);
        throw new ServiceUnavailableException("系統繁忙，請稍後再試");   // → 503 + Retry-After
    }
    if (!got) {
        // 鎖被別人拿著（Redis 是好的）→ 這是正常的競爭
        throw new TooManyRequestsException("這個商品正在被搶購，請稍後再試");  // → 429
    }
    try {
        return dao.createOrderInTransaction(productId, userId);
    } finally {
        if (lock.isHeldByCurrentThread()) lock.unlock();
    }
}
```

> 📌 **兩種失敗要分開回**：
>
> | 情況 | HTTP | 語意 | 客戶端該做什麼 |
> |---|---|---|---|
> | Redis 異常 | **503** + `Retry-After` | 我的系統壞了 | 退避後重試 |
> | 拿不到鎖（有人在搶） | **429** | 你來得太擠了 | 立刻重試一次也可以 |
> | 業務失敗（沒庫存） | **409** | 事實如此 | 不要重試 |
>
> ⚠️ 全部回 500 的話，客戶端的重試策略只能瞎猜——
> 而**瞎猜的結果通常是「全部重試」**，於是 Redis 恢復的那一秒，
> 所有人同時打進來（08 章 8.7 的第二波）。
>
> 10 章會把這三個狀態碼與 `Retry-After` 標頭一起做完。

---

## 9.12 落地：shop-service 的鎖

### 9.12.1 一個入口，`LockTemplate`

前面十一節的每一條結論，收斂成一個類別。**專案裡不應該有第二個地方直接呼叫 `redisson.getLock()`。**

```java
@Component
public class LockTemplate {

    private final RedissonClient redisson;

    // 9.12.5：這四個計數器要接出去
    public final LongAdder acquired = new LongAdder();
    public final LongAdder busy     = new LongAdder();
    public final LongAdder failed   = new LongAdder();
    public final LongAdder heldOver1s = new LongAdder();

    public <T> T execute(String key, Duration waitTime, Supplier<T> body) {
        // 🔒 9.8.6：鎖必須在交易外面
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("分散式鎖被包在交易裡面了（9.8）：key=" + key);
        }

        RLock lock = redisson.getLock(key);
        boolean got;
        try {
            got = lock.tryLock(waitTime.toMillis(), TimeUnit.MILLISECONDS);   // 9.7.8：有 watchdog
        } catch (RedisException e) {                    // 9.11：Redis 壞了 → 503，不降級
            failed.increment();
            log.error("取鎖失敗（Redis 異常）key={}", key, e);
            throw new LockUnavailableException(key, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            failed.increment();
            throw new LockUnavailableException(key, e);
        }
        if (!got) {                                      // 9.11.5：有人在搶 → 429
            busy.increment();
            throw new LockBusyException(key);
        }

        acquired.increment();
        long t0 = System.nanoTime();
        try {
            return body.get();                           // ← 呼叫端在這裡放「一個有 @Transactional 的方法」
        } finally {
            long heldMs = (System.nanoTime() - t0) / 1_000_000;
            if (heldMs > 1000) { heldOver1s.increment(); log.warn("持鎖過久 key={} heldMs={}", key, heldMs); }

            if (lock.isHeldByCurrentThread()) {          // 9.7.8
                lock.unlock();
            } else {
                // 9.4.4：unlock 的回傳值一定要用。走到這裡代表持鎖期間鎖掉了
                log.error("解鎖時發現鎖已經不是我的了 key={} heldMs={}", key, heldMs);
            }
        }
    }
}
```

呼叫端：

```java
public Order createOrder(Long productId, String userId) {
    return locks.execute("lock:product:" + productId, Duration.ofSeconds(2),
            () -> dao.createOrderInTransaction(productId, userId));   // ⚠️ 另一個 bean，@Transactional 在它身上
}
```

### 9.12.2 設定

```yaml
lab10:
  lock:
    wait: 2s               # 9.7.8：比 HTTP 逾時短
    watchdog: 30s          # 9.7.4：Redisson 預設
    max-hold: 5m           # 9.6.4 ①：業務卡死時的上限
  redisson:
    timeout: 500ms         # ⚠️ 9.11.4：預設 3s 會讓 tryLock(2s) 等 17 秒
    retry-attempts: 1
    retry-interval: 200ms
```

```java
config.useSingleServer()
      .setAddress("redis://" + host + ":" + port)
      .setClientName("shop-service-redisson")   // 9.7.1：跟 Lettuce 分開
      .setTimeout(500)                           // 9.11.4
      .setRetryAttempts(1)
      .setRetryInterval(200)
      .setConnectionPoolSize(64)
      .setConnectionMinimumIdleSize(8);
config.setLockWatchdogTimeout(30_000);           // 9.7.4
```

### 9.12.3 驗收

```
═══ 9.12.3 驗收：LockTemplate + 交易在鎖裡，200 執行緒搶 100 件 ═══
  訂單 100 筆，庫存剩 0，超賣 0 件，429 0 次，耗時 1,298 ms
  指標：acquired=200 busy=0 failed=0 heldOver1s=0

═══ 9.12.3 驗收：鎖被包在交易裡面時，第一次呼叫就炸 ═══
  ✅ 被擋下來了：InvalidDataAccessApiUsageException
     訊息：分散式鎖被包在交易裡面了（9.8）：key=lock:product:1
```

> 📌 **注意第二個的例外型別是 `InvalidDataAccessApiUsageException`，不是 `IllegalStateException`。**
> `@Repository` 上的例外轉譯（`PersistenceExceptionTranslationPostProcessor`）把它換掉了。
> **所以測試要斷言訊息，不要斷言型別：**
>
> ```java
> assertThatThrownBy(...).hasMessageContaining("分散式鎖被包在交易裡面");
> ```

### 9.12.4 五條規約（接續 08 章 8.9.4 的第 20 條）

21. **釋放鎖一律用 Lua 比對 token**（自己寫）或 `isHeldByCurrentThread()`（Redisson）。
    ⚠️ 專案裡**不可以出現** `redis.delete(lockKey)`（9.4）。
22. **`@Transactional` 永遠在加鎖的內層。** 用註解的話，鎖的切面必須有一個明確的、
    小於交易切面的 `@Order`，而且要有執行期自檢（9.8.6）。
23. **不要傳 `leaseTime`。** 用 `tryLock(waitTime, unit)` 讓 watchdog 接手；
    需要上限就在業務裡加逾時（9.7.5、9.6.4）。
24. **`waitTime` 必須短於 HTTP 逾時**，而且 **Redisson 的 `timeout` × `(retryAttempts + 1)`
    也必須短於它**（9.11.4）。
25. ⚠️ **鎖沒有降級路徑。** 取鎖失敗一律往上丟；
    `catch` 區塊裡**不可以出現「當作拿到了」的分支**（9.11）。

### 9.12.5 五個該接告警的指標（接續 08 章 8.9.5）

| 指標 | 怎麼來 | 告警條件 | 代表什麼 |
|---|---|---|---|
| `lock.acquired` | `LockTemplate.acquired` | —— | 基準線 |
| **`lock.busy`**（429） | `LockTemplate.busy` | 佔比 > 5% | 粒度太粗（9.9.2），或臨界區太久 |
| **`lock.failed`**（503） | `LockTemplate.failed` | **> 0 就告警** | **Redis 有問題**，而且這些請求直接失敗了 |
| **`lock.held.over1s`** | `heldOver1s` | **> 0 就看一眼** | 臨界區裡有慢查詢／外部呼叫（9.6.4 ①） |
| **`lock.lost`** | 「解鎖時發現鎖已經不是我的了」的 ERROR 次數 | **> 0 是事故** | **互斥已經失效過**——去對帳 |

> ⚠️ **最後一個是這一章唯一一個「出現就代表資料可能已經錯了」的指標。**
> 08 章的那五個指標都是「服務品質」，這一個是**「正確性」**。
> **它跟錯誤率沒有關係，所以不會有人主動去看——請把它設成告警。**

---

## 9.13 常見誤區

**① 「`if (get() == null) set(...)` 就是鎖」**

9.3.1 實測：**200 個執行緒同時持有它**。跟完全沒有鎖的數字一模一樣。

**② 「`SETNX` 之後再 `EXPIRE` 也一樣」**

兩個命令中間掛掉 → 鎖永遠留著（9.3.2）。而且這種故障**不會報錯**，只會安靜地停止服務。

**③ 「釋放鎖就是 `DEL`」**

9.4.2 實測：**30 次釋放裡 28 次刪到別人的鎖**。而且是連鎖的——一次過期之後就再也沒有互斥。

**④ 「用 Lua 釋放就完整了」**

9.4.5：Lua 修好「誤刪別人」，**完全沒有修好「我的鎖提早消失」**（29 次）。這是兩個問題。

**⑤ 「TTL 設長一點比較保險」**

9.5.4：**TTL 就是你的 MTTR**。10 秒的 TTL ＝ 持鎖的機器掛掉時，別人等 10 秒。
全域鎖的話就是整個服務停 10 秒。

**⑥ 「調了參數之後 TPS 上升，所以改對了」**

⚠️ 9.5.3：這一章**每一個錯誤版本都比正確版本快**。
無鎖快 250 倍、TTL 太短快 33%、順序寫反快 16%。
**併發程式裡「變快了」是要先去驗證正確性的訊號。**

**⑦ 「Redisson 的 `tryLock(3, 10, SECONDS)` 是『等 3 秒、最多鎖 10 秒』」**

9.7.5：傳了 `leaseTime` 就**沒有 watchdog**，10 秒到鎖一定消失，不管業務做完沒。

**⑧ 「加 `redisson-spring-boot-starter` 就好」**

9.7.1：它會把 `RedisConnectionFactory` 換成 Redisson 的，
**06 章調的 Lettuce 逾時、連線池、`REJECT_COMMANDS` 全部安靜失效。**

**⑨ 「鎖跟交易的順序差不多啦」**

9.8.2：超賣 **145 件** vs **0 件**。而且錯的那個在低負載下只超賣 3 件——**測試會過**。

**⑩ 「用註解就不會寫錯順序」**

9.8.5：**`@Order` 才是決定順序的東西**。沒寫 `@Order` 的切面跟交易切面同級，順序不保證。

**⑪ 「自旋跟 pub/sub 效能差不多」**

9.7.6：API 延遲確實差不多，但臨界區 50 毫秒時，
**自旋每次取鎖敲 78.8 個 Redis 命令，Redisson 是 20.3 個**——而 Redis 是單執行緒的（03 章）。

**⑫ 「拿到 Redis 的鎖就等於安全」**

9.10.3：鎖過期 + 一次 GC 停頓 → **10 回合 10 次舊資料蓋掉新資料**。
需要 fencing token，或把最終檢查放在資料庫。

**⑬ 「Redis 掛了就先跳過鎖，不要影響下單」**

9.11 + 08 章 8.8：**這行程式在 Redis 故障的那 60 秒把庫存清空**，
而且不會出現在錯誤率圖表上。

**⑭ 「逾時了就代表沒執行，可以重試」**

9.11.2 實測：Lettuce 逾時丟例外，**但那個命令後來還是跑了**。
05 章 5.11 ③ 的實證。重試前先查狀態，或做冪等（10 章）。

**⑮ 「`waitTime` 設 2 秒，最多就卡 2 秒」**

9.11.4：Redis 不回話時實際等了 **17 秒**——`timeout × (retryAttempts + 1)` 沒人約束。

---

## 9.14 本章小結

**一把正確的分散式鎖，有六個部件，少一個就有一種壞法：**

| 部件 | 少了它會怎樣 | 節 |
|---|---|---|
| ① `SET NX PX`（單一命令） | 兩個人同時拿到鎖 | 9.3 |
| ② 唯一 token | 分不出鎖是誰的 | 9.4.3 |
| ③ Lua 比對釋放 | 刪掉別人的鎖（28/30 次） | 9.4.4 |
| ④ 續期（watchdog） | 業務跑一半鎖就沒了（29 次互斥失效） | 9.6 |
| ⑤ **鎖在交易外面** | **超賣 145 件** | **9.8** |
| ⑥ 失敗就失敗，不降級 | Redis 故障 60 秒 ＝ 庫存清空 | 9.11 |

**而即使六個都做對了，還有一句話**：

> 📌 **Redis 的鎖負責「減少衝突」，資料庫負責「保證正確」。**
> 9.10.3 證明了任何有 TTL 的鎖都擋不住 GC 停頓；
> 真正不能出錯的地方，最後一道防線必須是
> `UPDATE ... WHERE stock > 0` 或 fencing token（12 章）。

### 9.14.1 驗收清單

- [ ] 說得出「兩行之間的縫」在單機 `synchronized` 下為什麼不存在。
- [ ] 說得出 9.2.2 為什麼**庫存剩 99 而不是 -100**。
- [ ] 手寫出 `release-lock.lua`，並解釋為什麼它不能寫成兩行 Java。
- [ ] 說得出 Lua 釋放**沒有**解決的那個問題是什麼。
- [ ] 替一段業務估出 TTL，並說出估太短、估太長各付出什麼代價。
- [ ] 說得出 watchdog 為什麼是 `ttl / 3` 而不是 `ttl / 2`。
- [ ] 說得出 Redisson 的鎖為什麼用 Hash 存。
- [ ] 說得出 `lock.lock(10, SECONDS)` 跟 `lock.tryLock(10, SECONDS)` 差在哪。
- [ ] ⚠️ **看到一段程式，能立刻判斷鎖在交易裡面還是外面。**
- [ ] 說得出為什麼一把全域鎖慢 21 倍，以及它跟 MTTR 的關係。
- [ ] 說得出 fencing token 檢查發生在哪裡（提示：不在鎖上）。
- [ ] 說得出 Redis 掛掉時取鎖失敗，你的 API 該回 503 還是 429。

### 9.14.2 本章練習

**練習一（15 分鐘）**：把 9.2.2 的實驗跑起來，**把 `gapMillis` 從 20 改成 0**。
超賣還在嗎？變多還是變少？**說明為什麼「業務變快」沒有讓 bug 消失。**

**練習二（20 分鐘）**：實作 9.4.4 的 Lua 釋放，然後故意把它改回兩行 Java
（`if (token.equals(get(key))) delete(key)`）。
⚠️ **把 TTL 調到 50 毫秒、執行緒調到 200**，看看要跑幾次才會抓到一次誤刪。
**記錄下「要跑幾次才重現一次」這個數字**——它就是這個 bug 在正式環境的形狀。

**練習三（25 分鐘）**：實作 9.6.2 的 watchdog，然後：
① 把續期週期從 `ttl/3` 改成 `ttl/1.2`；
② 在續期的 Lua 前面加一行 `Thread.sleep(150)` 模擬網路抖動；
量一次互斥失效幾次。**解釋 `ttl/3` 那個「3」在對抗什麼。**

**練習四（30 分鐘，核心）**：把 9.8 的三個變體都跑一次，然後：
① 把 ① 的 `afterUnlock` 從 0 一路調到 50 毫秒，每 10 毫秒量一次超賣數；
② 畫出那條曲線；
③ ⚠️ **回答一個問題：在你的服務裡，「解鎖之後交易還要做多久」你知道嗎？**

**練習五（30 分鐘）**：實作 9.12.1 的 `LockTemplate`，加上執行期自檢，
然後寫一個**會失敗的**測試：把 `@Transactional` 標在呼叫 `locks.execute()` 的那個方法上。
確認它在第一次呼叫就炸，而且訊息看得懂。

**練習六（進階，40 分鐘）**：實作 9.10.3 的 fencing token：
① 在 `product` 表加一個 `fence_token BIGINT` 欄位；
② 取鎖時 `INCR lock:fence:product:<id>` 拿一個 token；
③ 扣庫存改成 `UPDATE product SET stock = stock - 1, fence_token = :t WHERE id = :id AND fence_token < :t`；
④ 用 9.10.3 的方式製造一次「鎖過期 + STW」，確認舊的持鎖者被擋下來。

**練習七（進階，40 分鐘）**：量一次**你自己服務**的鎖等待時間分布。
在 `LockTemplate` 裡記錄 `tryLock` 花了多久，輸出 p50 / p95 / p99。
⚠️ **如果 p99 接近你設的 `waitTime`，代表有一批使用者正在被 429**——
去看 9.9.2，你的粒度可能錯了。

---

## 9.15 下一章預告

這一章解決的是「**同一時間只有一個人能做某件事**」。
10 章要問的是它的兩個近親：

**「同一段時間裡，一個人最多能做幾次？」** ——**限流**。

- 固定窗為什麼在窗口交界那一秒可以放進**兩倍**流量（會實測給你看）。
- 滑動窗（ZSet 版）與令牌桶的 Lua 實作，以及它們的**記憶體成本差幾倍**。
- 多維度限流：IP、使用者、API key 同時生效時，key 該怎麼設計。
- ⚠️ 限流器放在 `Filter` 還是 `Interceptor`：**位置決定了它擋不擋得住你想擋的東西。**
- `429` 要回哪些標頭，才能讓客戶端**有辦法退讓**而不是立刻重打。

**「同一個請求送了兩次，會不會做兩次？」** ——**冪等**。

- ⚠️ 9.11.2 已經證明**「逾時了不代表沒執行」**——
  而客戶端的重試就建立在那個錯誤的假設上。10 章要把這個洞補起來。
- 冪等鍵的三個狀態（處理中／成功／失敗），以及**第二個請求到達時該等還是該回**。
- 為什麼「先查有沒有做過，再做」**又是 9.2.1 那道縫**。

> 📌 **這兩件事跟分散式鎖是同一個家族**：
> 它們都在 08 章 8.8 的決策表上被標成「❌ 不可以降級」，
> 而且它們的正確實作**全部建立在 05 章的 Lua 上**。
