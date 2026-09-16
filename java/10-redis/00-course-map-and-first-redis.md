# 第 00 章：課程地圖與第一台 Redis

> 這一站從零開始。**你不需要用過 Redis，也不需要知道 `SETNX` 是什麼。**
> 這一章結束時，你的機器上會有一台跑著的 Redis、一個連得上它的 Spring Boot 專案，
> 以及一個把 Redis 內部狀態印出來的工具——接下來十四章的每一個數字，都從那個工具來。
>
> 但在敲第一個命令之前，這一章要先做兩件事：
>
> **一、把「為什麼需要它」講清楚。**
> 大部分人對 Redis 的第一印象是「它很快」。
> 這一章 0.2.3 會實測給你看：**在同一台機器上，Redis 比你的行程內快取慢 5000 倍，比同一個行程裡的資料庫慢 29 倍。**
> 它從來不是因為快才被選上的。搞錯這件事，後面所有的取捨都會歪。
>
> **二、先看見痛。**
> 這一章有**四個實測事故**——
> 一行看起來人畜無害的 `keys()` 把 API 從 0.17 毫秒變成 **0.58 秒**、
> 一個「刻意不設過期時間」的購物車自己消失而且沒有任何錯誤、
> `redis-cli` 裡看到一串 `\xac\xed\x00\x05` 而改個套件名之後整個快取讀不回來、
> 100 件庫存在 200 個人同時搶的時候賣出了 **200 件**——
> **四個事故的程式碼全部「看起來是對的」，四個都不會讓任何一個測試變紅。**
>
> 📌 這四個事故分別是 01、04、06、09 章要解決的東西。
> 先看到它們壞掉的樣子，後面學那些設定的時候才知道自己在防什麼。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 用一句話說出 Redis 是什麼（0.2.1），並說明它跟「在 JVM 裡開一個 `ConcurrentHashMap`」的真正差別在哪裡——
  **不是速度**（0.2.3 的實測：HashMap 24 ns、Redis 134,861 ns）。
- 列出「一份狀態」可以放的四個地方，以及每一個地方各自會怎麼死（0.2.2）。
- 判斷一份資料該不該放 Redis，並說出三個「放進去就會後悔」的東西（0.2.5）。
- 重現四個事故，並說出每一個的根因與它被解決的章節（0.3）。
- 用 `docker run` 起一台 Redis，說明指令裡每一個參數的意思，
  並指出**哪一個參數只能出現在實驗機上**（0.4.1、0.4.5）。
- 在 `redis-cli` 裡下 `SET` / `GET` / `DEL` / `EXISTS` / `TYPE`，並讀懂回傳的 `nil`、`OK`、`(integer) 1`（0.4.2）。
- 讀懂 `INFO` 的五個區段，並說出 `used_memory` 與 `used_memory_rss` 為什麼不一樣（0.4.4）。
- 說出這台機器上 Redis 的實測吞吐（0.5.1：單命令 27 萬 rps、p50 0.095 ms），
  並解釋為什麼 pipeline 可以把它推到 **330 萬 rps**（0.5.2）——以及這個數字證明了瓶頸在哪裡。
- 建好本站的基準專案，並讓 `RedisProbe` 印出第一份快照（0.7）。

---

## 0.2 Redis 是什麼、為什麼是它

### 0.2.1 一句話

> **Redis 是一個把資料結構放在行程外面、用網路存取的伺服器。**

這句話有三個重點，每一個都會影響你後面的設計：

| 關鍵字 | 意思 | 後果 |
|---|---|---|
| **資料結構** | 它存的不是「字串」而已，是 list、hash、set、sorted set——而且提供的是**操作這些結構的命令**（`LPUSH`、`ZADD`、`HINCRBY`），不是「讀出來、改、寫回去」 | 很多事情可以**一條命令做完**，這件事在併發下是決定性的（0.3.4） |
| **行程外面** | 它跟你的 Java 程式是兩個行程，通常還是兩台機器 | 你的十台機器**看到同一份資料**——這是 Redis 真正的價值（0.2.4） |
| **用網路存取** | 每一次讀寫都是一次 TCP 往返 | 它比行程內的任何東西都慢，而且**它會塞住你的執行緒**（0.3.1） |

### 0.2.2 沒有 Redis 的時候，那份狀態放在哪裡

假設你要做一件很小的事：**「同一個 IP 一分鐘內最多打 100 次 API」**。

這需要一份狀態：「這個 IP 這一分鐘已經打了幾次」。它可以放四個地方：

**放法一：JVM 裡的 `ConcurrentHashMap`**

```java
private final Map<String, AtomicInteger> counter = new ConcurrentHashMap<>();
```

- 快到不像話（0.2.3 實測 24 奈秒）。
- **死法**：你有三台機器。攻擊者打三台，每台各算自己的 100 次，實際放行 300 次。
  再加上：重新部署，計數全部歸零；沒人幫你清理過期的 key，`Map` 一路長到 OOM。

**放法二：資料庫的一張表**

```sql
UPDATE rate_limit SET count = count + 1 WHERE ip = ? AND minute = ?
```

- 三台機器看到同一份資料了，重啟也不會掉。
- **死法**：你替**每一個請求**加了一次寫入資料庫。原本 QPS 3000 的服務，現在資料庫要扛 3000 TPS 的寫入，
  而且這張表每分鐘長幾十萬列，還要另外寫程式去刪。**為了保護服務而加的東西，變成服務最先倒的地方。**

**放法三：Redis**

```
INCR rate:1.2.3.4:202609161430
EXPIRE rate:1.2.3.4:202609161430 60
```

- 三台機器看到同一份資料、一條命令就是原子的、**過期不用你管**。
- **死法**：也有，而且這一站剩下的十四章就在講它們。

**放法四：不做這個功能**

- 認真的：這是一個合法選項。0.2.5 會給一個判斷準則。

> 📌 **看清楚「放法三」贏在哪裡**：
> 它贏在**共享**（三台機器同一份）、**原子**（`INCR` 不會算錯）、**自動過期**（不用寫清理程式）。
> **它沒有贏在速度**——下一節會用實測證明這件事。

### 0.2.3 實測：同一筆查詢，三個地方

同一個「用 id 查商品名稱」，分別問三個地方：JVM 裡的 `HashMap`、同一個行程裡的 H2 記憶體資料庫、
本機 Docker 裡的 Redis。

```java
package com.example.lab10.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.HashMap;
import java.util.Map;

@SpringBootTest
class A0WhyRedisTest {

    @Autowired StringRedisTemplate redis;
    @Autowired JdbcTemplate jdbc;

    private long bench(String name, int times, Runnable op) {
        for (int i = 0; i < times / 10; i++) op.run();      // 熱身
        long s = System.nanoTime();
        for (int i = 0; i < times; i++) op.run();
        long ns = (System.nanoTime() - s) / times;
        System.out.printf("  %-28s %,9d ns/次   （每秒約 %,d 次）%n", name, ns, 1_000_000_000L / Math.max(1, ns));
        return ns;
    }

    @Test
    void howFastIsItReally() {
        System.out.println("═══ 0.2.3 同一筆查詢，三個地方 ═══");
        jdbc.execute("CREATE TABLE IF NOT EXISTS product(id BIGINT PRIMARY KEY, name VARCHAR(50))");
        jdbc.update("MERGE INTO product KEY(id) VALUES (1001, '無線耳機')");
        redis.opsForValue().set("product:1001:name", "無線耳機");
        Map<Long, String> local = new HashMap<>();
        local.put(1001L, "無線耳機");

        long a = bench("JVM 裡的 HashMap", 200_000, () -> local.get(1001L));
        long b = bench("H2（同一個行程裡的記憶體資料庫）", 20_000,
                () -> jdbc.queryForObject("SELECT name FROM product WHERE id = 1001", String.class));
        long c = bench("Redis（本機 Docker，走 TCP）", 20_000,
                () -> redis.opsForValue().get("product:1001:name"));

        System.out.printf("%n  Redis 比行程內的 HashMap 慢 %,d 倍%n", c / Math.max(1, a));
        System.out.printf("  Redis 比同行程的 H2 %s%n",
                c > b ? "慢 " + String.format("%.1f", (double) c / b) + " 倍"
                      : "快 " + String.format("%.1f", (double) b / c) + " 倍");
    }
}
```

**輸出**：

```
═══ 0.2.3 同一筆查詢，三個地方 ═══
  JVM 裡的 HashMap                      24 ns/次   （每秒約 41,666,666 次）
  H2（同一個行程裡的記憶體資料庫）                4,588 ns/次   （每秒約 217,959 次）
  Redis（本機 Docker，走 TCP）         134,861 ns/次   （每秒約 7,415 次）

  Redis 比行程內的 HashMap 慢 5,619 倍
  Redis 比同行程的 H2 慢 29.4 倍
```

⚠️ **這是在同一台筆電上、Redis 跑在本機 Docker、完全沒有網路延遲的情況下量的。**
真實環境裡 Redis 在另一台機器上，再加 0.2～1 毫秒。

### 0.2.4 所以 Redis 快在哪裡？

**它不快。它「共享」。**

前一節那個 134,861 奈秒（0.13 毫秒）裡，**絕大部分不是 Redis 在計算，是網路往返**。
0.5 節會證明這件事：同樣一台 Redis，用 pipeline 一次送 16 條命令，吞吐從 27 萬 rps 跳到 **330 萬 rps**——
Redis 自己根本沒變快，只是省掉了 15 次往返。

那為什麼還要用它？把它跟「行程內快取」放在一起比：

| | 行程內 `HashMap` | Redis |
|---|---|---|
| 單次讀取 | **24 ns** | 134,861 ns（慢 5619 倍） |
| 十台機器看到的是不是同一份 | ❌ 十份，各自為政 | ✅ 一份 |
| 重新部署之後 | ❌ 全部歸零 | ✅ 還在 |
| 過期清理 | ❌ 自己寫 | ✅ 內建 |
| 「庫存剩幾件」這種需要正確的數字 | ❌ 十台各扣各的 | ✅ 一條 `DECR` 搞定 |
| 佔用的是誰的記憶體 | 你的 JVM heap（會影響 GC） | Redis 的（跟你的 heap 無關） |

> 📌 **判斷準則**：
> **如果一份狀態「每台機器各算各的也沒關係」，那它不該進 Redis**——放行程內，快 5000 倍。
> **如果它「十台機器必須看到同一個答案」，那它才需要 Redis**，而你要為此付出 0.13 毫秒與一整套故障處理。
>
> 這一站後面所有的主題——分散式鎖、限流、Session、庫存——
> **全部都是「十台機器必須看到同一個答案」的變形。**

### 0.2.5 什麼該放、什麼不該放

| 適合 | 為什麼 | 本站哪一章 |
|---|---|---|
| 快取（查詢結果、商品資料） | 讀多寫少、掉了可以重算 | 07、08 |
| Session、登入狀態 | 多台機器要共享、天生有過期時間 | 11 |
| 限流計數 | 需要原子遞增、需要自動過期 | 10 |
| 分散式鎖 | 需要「只有一個人拿得到」 | 09 |
| 排行榜、熱門商品 | ZSet 天生就是幹這個的 | 12 |
| 搶購的庫存預扣 | 需要單點的原子扣減 | 12 |

| **不適合** | 為什麼 | 該放哪 |
|---|---|---|
| 唯一的一份訂單資料 | Redis 的持久化**會掉資料**（04 章會量給你看掉多少），而且沒有交易回滾、沒有外鍵、沒有 join | 資料庫 |
| 需要複雜查詢的資料（「找出上個月消費超過 5000 的客戶」） | 沒有 SQL。你只能一個一個 key 撈出來自己算 | 資料庫 |
| 很大的東西（整份 PDF、影片） | 它是單執行緒的，搬一個 10MB 的值會卡住所有人（03 章） | 物件儲存 |
| 冷資料（三年前的日誌） | 記憶體比磁碟貴一到兩個數量級 | 資料庫 / 檔案 |

⚠️ **最常見的誤用是第一個**：把 Redis 當資料庫用。
「反正它有 AOF 持久化」——04 章會實測：**預設設定下，主機斷電最多掉 1 秒的寫入**。
一秒鐘的訂單，你賠得起嗎？

---

## 0.3 先看見痛：四個事故

### 0.3.0 四個事故共用的場景

一個賣耳機的線上商店，三台機器跑同一份 Spring Boot 程式，前面有負載平衡，
後面是一台 MySQL，中間新加了一台 Redis 做快取與 Session。

四個事故都發生在這個很普通的架構上。**四段程式碼都通過了 code review。**

> 📌 **這四個事故現在就可以重現**，但要先有 0.4 的 Redis 與 0.7 的專案。
> 建議的讀法：**先往下讀到 0.7 把環境建好，再回來這一節把四個事故跑一次。**
> 每個事故的完整程式碼都在下面，複製貼上就能跑。

四個事故要用到的測試資料，用 `redis-cli --pipe` 灌（這是灌大量測試資料最快的方式，
它把命令批次送進去，不是一條一條等回應）：

```bash
# 300 萬個 session key —— 模擬一個跑了幾個月的正式環境
docker exec redis-lab bash -c \
  'for i in $(seq 1 3000000); do echo "SET session:$i x"; done | redis-cli --pipe'
```

```
All data transferred. Waiting for the last reply...
Last reply received from server.
errors: 0, replies: 3000000
```

### 0.3.1 事故一：一行 `keys()`，把 API 從 0.17 毫秒變成 0.58 秒 ★★

**事情的經過**：營運要一份「目前線上人數」的報表。工程師寫了一行：

```java
Set<String> keys = redis.keys("session:*");
int online = keys.size();
```

**這一行在測試環境跑得好好的**（測試環境有 200 個 session）。
上線之後，整個網站每隔幾秒鐘卡一下，而且**卡住的不是報表，是所有其他 API**。

**重現**：

```java
package com.example.lab10.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;

@SpringBootTest
class A1KeysTest {

    @Autowired StringRedisTemplate redis;

    record Result(long qps, long p50, long p99, long max) {
        public String toString() {
            return String.format("%,7d 次/秒   p50=%3d µs   p99=%,6d µs   最慢=%,7d µs", qps, p50, p99, max);
        }
    }

    /** 20 個執行緒不停地 GET，回報這段期間的吞吐與延遲分佈 */
    private Result measure(int seconds) throws Exception {
        int threads = 20;
        ConcurrentLinkedQueue<Long> all = new ConcurrentLinkedQueue<>();
        long deadline = System.nanoTime() + seconds * 1_000_000_000L;
        CountDownLatch done = new CountDownLatch(threads);
        for (int t = 0; t < threads; t++) {
            new Thread(() -> {
                while (System.nanoTime() < deadline) {
                    long s = System.nanoTime();
                    redis.opsForValue().get("key:100");
                    all.add((System.nanoTime() - s) / 1000);
                }
                done.countDown();
            }).start();
        }
        done.await();
        long[] us = all.stream().mapToLong(Long::longValue).sorted().toArray();
        return new Result(us.length / seconds, us[us.length / 2], us[(int) (us.length * 0.99)], us[us.length - 1]);
    }

    @Test
    void oneInnocentLine() throws Exception {
        System.out.println("═══ 0.3.1 事故一：一行 keys() ═══");
        measure(2); // 熱身：讓連線池與 JIT 就位，這一輪不計
        System.out.println("平常時候   : " + measure(5));

        Thread culprit = new Thread(() -> {
            for (int i = 0; i < 5; i++) {
                long s = System.currentTimeMillis();
                Set<String> keys = redis.keys("session:*");
                System.out.printf("  [那支報表] keys(\"session:*\") 撈回 %,d 個 key，花了 %,d ms%n",
                        keys == null ? 0 : keys.size(), System.currentTimeMillis() - s);
            }
        });
        culprit.start();
        Result during = measure(5);
        culprit.join();
        System.out.println("報表在跑時 : " + during);
    }
}
```

**輸出**：

```
═══ 0.3.1 事故一：一行 keys() ═══
平常時候   :  108,457 次/秒   p50=172 µs   p99=   353 µs   最慢= 28,504 µs
  [那支報表] keys("session:*") 撈回 3,000,000 個 key，花了 1,849 ms
  [那支報表] keys("session:*") 撈回 3,000,000 個 key，花了 2,052 ms
  [那支報表] keys("session:*") 撈回 3,000,000 個 key，花了 1,755 ms
  [那支報表] keys("session:*") 撈回 3,000,000 個 key，花了 1,448 ms
  [那支報表] keys("session:*") 撈回 3,000,000 個 key，花了 1,280 ms
報表在跑時 :   44,046 次/秒   p50=230 µs   p99=   678 µs   最慢=584,661 µs
```

**看三個數字**：

| | 平常 | 報表在跑時 | |
|---|---|---|---|
| 吞吐 | 108,457 次/秒 | 44,046 次/秒 | **掉了 59%** |
| p99 延遲 | 353 µs | 678 µs | 慢一倍 |
| **最慢的那一次** | 28.5 ms | **584.7 ms** | **有使用者等了 0.58 秒** |

⚠️ **注意 p50 只從 172 µs 變成 230 µs。**
如果你的監控只看平均值或中位數，**這個事故在監控上幾乎看不見**——
但每隔一兩秒，就有一批請求被卡住超過半秒。

**根因**：`keys()` 送出去的是 `KEYS` 命令，而 Redis 是**單執行緒**處理命令的。
`KEYS *` 要走過整個 keyspace（300 萬個 key）才能回答，
**這段時間 Redis 不處理任何其他人的任何一條命令**——它們全部在 socket 裡排隊。

Redis 自己記得這件事。`SLOWLOG` 是它的黑盒子：

```bash
docker exec redis-lab redis-cli SLOWLOG GET 3
```

```
1) 1) (integer) 9
   2) (integer) 1789540745
   3) (integer) 97836          ← 這條命令佔用主執行緒 97,836 微秒
   4) 1) "KEYS"
      2) "*"
   5) "127.0.0.1:44584"
```

📌 **附帶一提，那個 `keys()` 還做了第二件壞事**：它把 300 萬個字串一次搬進 JVM 的 heap。
光是 `Set<String>` 的容器加上 300 萬個 `String`，就是幾百 MB——**一行程式碼同時打了 Redis 跟你自己的 GC。**

**解決在哪**：01 章 1.5（`SCAN` 怎麼用、它保證什麼不保證什麼）、03 章（還有哪些命令有一樣的問題）。

### 0.3.2 事故二：購物車自己不見了，而且沒有任何錯誤 ★★

**事情的經過**：購物車放在 Redis。工程師想得很清楚：
**「購物車不應該自己消失，所以不設過期時間。」**

上線三週後，客服開始收到投訴：**東西加到購物車，過一陣子回來就沒了。**
查日誌——沒有任何錯誤。查程式——邏輯完全正確。

**重現**：

```java
package com.example.lab10.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.util.Properties;

@SpringBootTest
class A2EvictionTest {

    @Autowired StringRedisTemplate redis;

    private String info(String section, String field) {
        Properties p = redis.getConnectionFactory().getConnection().serverCommands().info(section);
        return p == null ? "?" : p.getProperty(field);
    }

    @Test
    void theCartThatVanished() {
        System.out.println("═══ 0.3.2 事故二：購物車自己不見了 ═══");
        redis.getConnectionFactory().getConnection().serverCommands().flushAll();
        // 這台 Redis 分到 32MB，滿了就用 LRU 淘汰 —— 一個非常常見的正式環境設定
        redis.getConnectionFactory().getConnection().serverCommands()
                .setConfig("maxmemory", "32mb");
        redis.getConnectionFactory().getConnection().serverCommands()
                .setConfig("maxmemory-policy", "allkeys-lru");

        // 購物車：刻意不設 TTL，因為「購物車不應該自己過期」
        redis.opsForValue().set("cart:alice", "無線耳機 x1, 保護殼 x2");
        System.out.println("alice 的購物車     : " + redis.opsForValue().get("cart:alice"));
        System.out.println("它的 TTL           : " + redis.getExpire("cart:alice") + "（-1 = 永不過期）");
        System.out.println("現在用掉的記憶體   : " + info("memory", "used_memory_human"));

        // 接著是平常的流量：商品快取一直寫進來
        String payload = "x".repeat(1024);
        for (int i = 0; i < 60_000; i++) {
            redis.opsForValue().set("cache:product:" + i, payload);
        }

        System.out.println("---- 60,000 筆商品快取寫進來之後 ----");
        System.out.println("用掉的記憶體       : " + info("memory", "used_memory_human")
                + " / 上限 " + info("memory", "maxmemory_human"));
        System.out.println("被淘汰掉的 key 數  : " + info("stats", "evicted_keys"));
        System.out.println("alice 的購物車     : " + redis.opsForValue().get("cart:alice"));
        System.out.println("它有回報任何錯誤嗎 : 沒有。get() 回傳 null，就這樣。");

        redis.getConnectionFactory().getConnection().serverCommands().setConfig("maxmemory", "0");
    }
}
```

**輸出**：

```
═══ 0.3.2 事故二：購物車自己不見了 ═══
alice 的購物車     : 無線耳機 x1, 保護殼 x2
它的 TTL           : -1（-1 = 永不過期）
現在用掉的記憶體   : 1.72M
---- 60,000 筆商品快取寫進來之後 ----
用掉的記憶體       : 32.00M / 上限 32.00M
被淘汰掉的 key 數  : 36564
alice 的購物車     : null
它有回報任何錯誤嗎 : 沒有。get() 回傳 null，就這樣。
```

**根因有三層，每一層都很反直覺**：

1. **`TTL = -1` 不代表「這個 key 會永遠在」**，它只代表「這個 key 不會因為**時間**而消失」。
   它還是會因為**記憶體不夠**而消失。
2. `maxmemory-policy` 設成 `allkeys-lru` 時，**Redis 從「所有 key」裡挑最久沒被用到的踢掉**——
   它不知道哪個 key 是可以重算的快取、哪個是使用者辛苦加的購物車。
   購物車剛好就是「加完之後好幾小時沒人碰」的那種資料，**LRU 專挑這種**。
3. **淘汰不會回報錯誤**。你的程式碼拿到的就是一個 `null`，跟「這個人本來就沒有購物車」長得一模一樣。

> ⚠️ **這裡有一個更深的陷阱**：
> 這台 Redis 同時放了「掉了可以重算的快取」跟「掉了就是資料遺失的購物車」。
> **一旦混在同一個實例、同一個淘汰策略下，Redis 沒有任何辦法分辨它們。**
> 04 章會講八種淘汰策略與它們的分界，11 章會講 Session 這類資料到底該怎麼放。

**解決在哪**：01 章（TTL 的真正語意）、04 章（`maxmemory` 與八種淘汰策略）、11 章（Session 與購物車的正確放法）。

### 0.3.3 事故三：`redis-cli` 裡看到一串 `\xac\xed`，改個套件名全部讀不回來 ★★

**事情的經過**：工程師照著網路上的範例設定了 `RedisTemplate`：

```java
@Bean
public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory) {
    RedisTemplate<String, Object> template = new RedisTemplate<>();
    template.setConnectionFactory(factory);
    return template;     // 什麼序列化器都沒設 —— 這就是問題
}
```

一切正常。三個月後為了整理程式碼，把 `com.example.shop.v1` 這個套件改名成 `com.example.shop.catalog`。
**部署上去之後，所有快取讀取全部拋例外。**

**重現**（完整可跑）：

```java
package com.example.lab10.ch00;

import com.example.lab10.ch00.v1.Product;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.serializer.RedisSerializer;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;

@SpringBootTest
class A3SerializationTest {

    @Autowired RedisConnectionFactory factory;

    /** 教科書上最常見的那一段 RedisTemplate 設定：什麼序列化器都沒指定 */
    private RedisTemplate<String, Object> defaultTemplate() {
        RedisTemplate<String, Object> t = new RedisTemplate<>();
        t.setConnectionFactory(factory);
        t.afterPropertiesSet();
        return t;
    }

    @Test
    void whatIsActuallyStored() {
        System.out.println("═══ 0.3.3 事故三：redis-cli 裡看到的那串東西 ═══");
        RedisTemplate<String, Object> redis = defaultTemplate();
        redis.opsForValue().set("product:1001", new Product(1001L, "無線耳機", new BigDecimal("2490")));

        System.out.println("Java 這一側讀回來  : " + redis.opsForValue().get("product:1001"));

        // 用「原始位元組」的方式看同一筆資料
        byte[] rawKey = ser(redis.getKeySerializer(), "product:1001");
        System.out.println("實際存進去的 key   : " + escape(rawKey));
        byte[] rawValue = redis.execute((RedisCallback<byte[]>) c -> c.stringCommands().get(rawKey));
        System.out.println("value 長度         : " + rawValue.length + " bytes（JSON 版只要 46 bytes）");
        System.out.println("位元組裡夾帶的類名 : " + classNameInside(rawValue));
    }

    @Test
    void renameThePackage() {
        System.out.println("═══ 0.3.3 事故三（下半）：改個套件名 ═══");
        RedisTemplate<String, Object> redis = defaultTemplate();
        byte[] rawKey = ser(redis.getKeySerializer(), "product:1002");
        redis.opsForValue().set("product:1002", new Product(1002L, "無線耳機", new BigDecimal("2490")));
        byte[] raw = redis.execute((RedisCallback<byte[]>) c -> c.stringCommands().get(rawKey));

        // 模擬「上線後把 v1 套件改名成 catalog」：JDK 序列化把類名寫死在位元組裡，
        // 這裡直接把那段字串換掉（長度一樣），效果等同重新命名套件後重新部署。
        String before = new String(raw, StandardCharsets.ISO_8859_1);
        byte[] patched = before.replace("ch00.v1.Product", "catalog.Product")
                               .getBytes(StandardCharsets.ISO_8859_1);
        redis.execute((RedisCallback<Boolean>) c -> c.stringCommands().set(rawKey, patched));
        System.out.println("快取裡現在寫的類名 : " + classNameInside(patched));

        try {
            Object v = redis.opsForValue().get("product:1002");
            System.out.println("讀回來             : " + v);
        } catch (Exception e) {
            Throwable root = e;
            while (root.getCause() != null) root = root.getCause();
            System.out.println("讀回來             : 炸了");
            System.out.println("  " + e.getClass().getName());
            System.out.println("  → " + root.getClass().getName() + ": " + root.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    private static byte[] ser(RedisSerializer<?> s, Object v) {
        return ((RedisSerializer<Object>) s).serialize(v);
    }

    private static String escape(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) {
            if (x >= 0x20 && x < 0x7f) sb.append((char) x);
            else sb.append(String.format("\\x%02x", x));
        }
        return sb.toString();
    }

    /** JDK 序列化格式：TC_OBJECT(0x73) TC_CLASSDESC(0x72) 之後是 2 bytes 長度 + 類名 */
    private static String classNameInside(byte[] b) {
        for (int i = 0; i < b.length - 4; i++) {
            if (b[i] == 0x73 && b[i + 1] == 0x72) {
                int len = ((b[i + 2] & 0xff) << 8) | (b[i + 3] & 0xff);
                return new String(b, i + 4, len, StandardCharsets.UTF_8);
            }
        }
        return "(找不到)";
    }
}
```

需要的 `Product`（注意：它必須 `implements Serializable`，否則第一步就爆）：

```java
package com.example.lab10.ch00.v1;

import java.io.Serializable;
import java.math.BigDecimal;

public class Product implements Serializable {
    private Long id;
    private String name;
    private BigDecimal price;

    public Product() {}
    public Product(Long id, String name, BigDecimal price) {
        this.id = id; this.name = name; this.price = price;
    }
    public Long getId() { return id; }
    public String getName() { return name; }
    public BigDecimal getPrice() { return price; }
    public String toString() { return "Product[" + id + ", " + name + ", " + price + "]"; }
}
```

**輸出**：

```
═══ 0.3.3 事故三：redis-cli 裡看到的那串東西 ═══
Java 這一側讀回來  : Product[1001, 無線耳機, 2490]
實際存進去的 key   : \xac\xed\x00\x05t\x00\x0cproduct:1001
value 長度         : 493 bytes（JSON 版只要 46 bytes）
位元組裡夾帶的類名 : com.example.lab10.ch00.v1.Product
```

那 46 bytes 是這一包（同一個物件用 Jackson 序列化）：

```
{"id":1001,"name":"無線耳機","price":2490}

═══ 0.3.3 事故三（下半）：改個套件名 ═══
快取裡現在寫的類名 : com.example.lab10.catalog.Product
讀回來             : 炸了
  org.springframework.data.redis.serializer.SerializationException
  → java.lang.ClassNotFoundException: com.example.lab10.catalog.Product
```

**Java 這一側完全看不出問題**——`Product[1001, 無線耳機, 2490]` 存進去、讀出來，一模一樣。
問題要換到 `redis-cli` 那一側才看得見：

```bash
docker exec redis-lab redis-cli --no-raw KEYS '*'
```

```
1) "\xac\xed\x00\x05t\x00\x0cproduct:1001"
```

**連 key 都是二進位的。** 這代表：

- 你**沒有辦法**在 `redis-cli` 上打出這個 key 去查它（裡面有 `\x00`，shell 傳不過去）。
- 所有以 key 前綴為前提的維運操作（`SCAN cart:*`、按前綴統計、按前綴清理）**全部失效**。
- 任何非 Java 的程式（Python 的維運腳本、Go 寫的另一個服務）**讀不懂這份資料**。

值的部分（用 Lua 繞過 shell 的限制才看得到）：

```bash
docker exec redis-lab redis-cli --no-raw EVAL "local k = redis.call('KEYS','*')[1]; return redis.call('GET', k)" 0
```

```
"\xac\xed\x00\x05sr\x00!com.example.lab10.ch00.v1.ProductS\x85b\x8d\x15\x13N\x80\x02\x00\x03L
\x00\x02idt\x00\x10Ljava/lang/Long;L\x00\x04namet\x00\x12Ljava/lang/String;L\x00\x05pricet
\x00\x16Ljava/math/BigDecimal;xpsr\x00\x0ejava.lang.Long;\x8b\xe4\x90\xcc\x8f#\xdf ...
```

看清楚裡面有什麼：**`com.example.lab10.ch00.v1.Product`**、**`Ljava/lang/Long;`**、**`java.math.BigDecimal`**。

> 📌 **JDK 序列化把「你的類別長什麼樣子」整包寫進了快取。**
> 493 bytes 裡面，真正的資料（1001、無線耳機、2490）不到 20 bytes，其他全是型別描述。
>
> 所以「改個套件名」不是一個重構動作，**它是一次資料格式變更**——
> 而那份舊格式的資料，正躺在一台你不會去改的 Redis 裡。

**根因**：`new RedisTemplate<>()` 沒指定序列化器時，key 與 value 都用 `JdkSerializationRedisSerializer`。

**解決在哪**：06 章 6.3～6.5（四個序列化器分別在哪裡、該怎麼選）、07 章 7.6（快取資料跨版本的相容性）。

### 0.3.4 事故四：100 件庫存，賣出 200 件 ★★

**事情的經過**：限量 100 件的耳機開賣。程式碼是這樣寫的——**先查庫存，有貨才賣**：

```java
String s = redis.opsForValue().get("stock:1001");
int stock = Integer.parseInt(s);
if (stock > 0) {                                   // 有貨才賣
    redis.opsForValue().set("stock:1001", String.valueOf(stock - 1));
    出貨();
}
```

**這段邏輯沒有任何問題**——除了它在 200 個人同時按下去的時候會賣掉 200 件。

**重現**：

```java
package com.example.lab10.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

@SpringBootTest
class A4OversellTest {

    @Autowired StringRedisTemplate redis;

    /** 讓 buyers 個執行緒在同一瞬間一起動 */
    private void rush(Runnable buyer, int buyers) throws Exception {
        CountDownLatch start = new CountDownLatch(1), done = new CountDownLatch(buyers);
        for (int i = 0; i < buyers; i++) {
            new Thread(() -> {
                try { start.await(); buyer.run(); } catch (InterruptedException ignored) {}
                finally { done.countDown(); }
            }).start();
        }
        start.countDown();
        done.await();
    }

    @Test
    void oversell() throws Exception {
        System.out.println("═══ 0.3.4 事故四：賣掉 100 件，出貨單上有 ? 張 ═══");

        // ---- 寫法 A：先查再扣（看起來完全正確）----
        redis.opsForValue().set("stock:1001", "100");
        AtomicInteger soldA = new AtomicInteger();
        rush(() -> {
            String s = redis.opsForValue().get("stock:1001");
            int stock = Integer.parseInt(s);
            if (stock > 0) {                                   // 有貨才賣
                redis.opsForValue().set("stock:1001", String.valueOf(stock - 1));
                soldA.incrementAndGet();                       // 出貨
            }
        }, 200);
        System.out.println("寫法 A：先查再扣");
        System.out.println("  庫存剩下   : " + redis.opsForValue().get("stock:1001"));
        System.out.println("  實際賣出   : " + soldA.get() + " 件   ← 只有 100 件可以賣");
        System.out.println("  超賣       : " + (soldA.get() - 100) + " 件");

        // ---- 寫法 B：交給 Redis 自己扣 ----
        redis.opsForValue().set("stock:1002", "100");
        AtomicInteger soldB = new AtomicInteger();
        rush(() -> {
            Long left = redis.opsForValue().decrement("stock:1002");
            if (left != null && left >= 0) soldB.incrementAndGet();
            else redis.opsForValue().increment("stock:1002");   // 扣過頭，補回去
        }, 200);
        System.out.println("寫法 B：DECR");
        System.out.println("  庫存剩下   : " + redis.opsForValue().get("stock:1002"));
        System.out.println("  實際賣出   : " + soldB.get() + " 件");
    }
}
```

**輸出**：

```
═══ 0.3.4 事故四：賣掉 100 件，出貨單上有 ? 張 ═══
寫法 A：先查再扣
  庫存剩下   : 98
  實際賣出   : 200 件   ← 只有 100 件可以賣
  超賣       : 100 件
寫法 B：DECR
  庫存剩下   : 0
  實際賣出   : 100 件
```

⚠️ **看「寫法 A」那兩個數字放在一起有多荒謬**：
**賣出 200 件，而庫存顯示還剩 98 件。**
不是「剩下 -100」——是 98。因為每個人都讀到 100、每個人都寫回 99 或 98。
**這個系統連自己少了多少貨都不知道。**

**根因**：這三行不是一個動作，是三個動作：

```
    執行緒 A                          執行緒 B
    GET stock:1001  → 100
                                      GET stock:1001  → 100     ← 它也讀到 100
    if (100 > 0) ✓
                                      if (100 > 0) ✓
    SET stock:1001 99
                                      SET stock:1001 99          ← 兩個人都賣了，庫存只掉 1
```

**「讀」跟「寫」之間有一道縫。** 兩百個人擠進這道縫，就超賣兩百件。

寫法 B 為什麼對？因為 `DECR` 是**一條命令**。
Redis 是單執行緒的，**一條命令執行到底、中間沒有人插得進來**——這是 Redis 最重要的一個性質，
也是這一站後面所有「原子操作」的基礎（05 章會把它講透）。

📌 **但寫法 B 也不是最終答案**。它有兩個問題：
扣完之後要在資料庫建訂單，那一段**不在** `DECR` 的保護範圍裡（12 章）；
而且如果要「同一個人只能買一件」「扣庫存的同時寫一筆流水」，一條 `DECR` 就不夠了——
那時候你需要的是 Lua（05 章）或分散式鎖（09 章）。

**解決在哪**：05 章（原子性：`MULTI`、Lua）、09 章（分散式鎖）、12 章（預扣庫存 + 資料庫落帳的完整流程）。

### 0.3.5 四個事故的共同形狀

把四個並排：

| 事故 | 程式碼看起來 | 實際發生的事 | 根因是 Redis 的哪個性質 | 章 |
|---|---|---|---|---|
| 一行 `keys()` | 一個查詢 | 整台 Redis 停擺 1.8 秒 | **單執行緒**：一條命令跑完才輪到下一條 | 01、03 |
| 購物車不見 | 不設 TTL = 不會消失 | LRU 把它踢了，且不回報 | **記憶體是有上限的**，淘汰不挑資料的重要性 | 04、11 |
| `\xac\xed` | 存物件、讀物件 | 資料格式綁死在 Java 類名上 | **Redis 只認位元組**，它不知道你存的是什麼 | 06、07 |
| 超賣 100 件 | 先查再扣 | 讀與寫之間有縫 | **每一條命令是原子的，但兩條就不是** | 05、09、12 |

四個事故有一個共同形狀：

> **每一個都是「Java 這一側看起來完全正常」，而問題在 Redis 那一側。**
>
> 你在 IDE 裡看到的是 `redis.opsForValue().get(...)`——一個方法呼叫。
> Redis 那一側看到的是一條命令、一次記憶體配置、一個佔用主執行緒的動作。
> **這兩個視角之間的落差，就是這一站要補的東西。**

📌 **這也是為什麼這一站的前六章要待在 `redis-cli` 裡。**
你必須先能看到 Redis 那一側發生了什麼，
才有辦法在 Java 這一側判斷「我這行程式碼會變成什麼」。

---

## 0.4 起一台 Redis

### 0.4.1 `docker run`：一行，但每個參數都有理由

```bash
docker run -d --name redis-lab -p 16379:6379 redis:7.2 \
  redis-server --enable-debug-command yes --save "" --appendonly no
```

| 參數 | 意思 | 為什麼這樣設 |
|---|---|---|
| `-d` | 背景跑 | —— |
| `--name redis-lab` | 容器取名 | 後面所有命令都用 `docker exec redis-lab ...`，不用記容器 id |
| `-p 16379:6379` | 把容器的 6379 對到本機的 **16379** | **刻意不用 6379**：你機器上可能已經有別的 Redis，撞埠會拿到錯誤的資料而且很難發現 |
| `redis:7.2` | 映像版本 | **釘住版本**。Redis 7 跟 6 在過期、`SCAN`、`OBJECT ENCODING` 上都有差異，課文的輸出對不上會讓你懷疑人生 |
| `redis-server ...` | 蓋掉映像預設的啟動命令 | 後面三個參數才是重點 |
| `--enable-debug-command yes` | 打開 `DEBUG` 命令 | ⚠️ **只有實驗機可以這樣。** 01、03、04 章需要 `DEBUG POPULATE`（灌假資料）、`DEBUG SET-ACTIVE-EXPIRE`（關掉主動過期）、`DEBUG SLEEP`（讓 Redis 假裝卡住）。詳見 0.4.5 |
| `--save ""` | 關掉 RDB 快照 | 實驗機不需要持久化；而且 04 章要**手動**開它、看它的成本，預設開著會干擾其他章的量測 |
| `--appendonly no` | 關掉 AOF | 同上 |

確認它活著：

```bash
docker exec redis-lab redis-cli PING
```

```
PONG
```

📌 **後面每一章都假設這台叫 `redis-lab`、開在 16379。** 如果你改了名字或埠，
記得同步改 `application.yml`（0.7.2）。

### 0.4.2 第一個 `SET` 與 `GET`

進到互動式的 `redis-cli`：

```bash
docker exec -it redis-lab redis-cli
```

```
127.0.0.1:6379> SET product:1001:name "無線耳機"
OK
127.0.0.1:6379> GET product:1001:name
"\xe7\x84\xa1\xe7\xb7\x9a\xe8\x80\xb3\xe6\xa9\x9f"
```

⚠️ **第一個坑就在這裡。** 你存的是「無線耳機」，讀回來卻是一串 `\xe7\x84\xa1...`。

**資料沒有壞。** Redis 存的是位元組，它不知道那是 UTF-8 中文；
`redis-cli` 預設把非 ASCII 的位元組跳脫出來顯示。加 `--raw` 就正常了：

```bash
docker exec -it redis-lab redis-cli --raw
```

```
127.0.0.1:6379> GET product:1001:name
無線耳機
```

> 📌 **兩個模式各有用處，不要只用一個**：
> `--raw` 給人看（中文、正常字串）；
> **預設（`--no-raw`）給你除錯用**——0.3.3 那個 `\xac\xed\x00\x05` 就是靠它才看得見。
> 本課的輸出如果出現 `(integer)`、`(nil)` 這種標記，就是 `--no-raw` 模式。

**今天就該會的九條命令**：

```
127.0.0.1:6379> SET product:1001:name "無線耳機"
OK                                      ← 成功。SET 永遠成功（除非你加了 NX/XX）

127.0.0.1:6379> EXISTS product:1001:name
(integer) 1                             ← 1 = 有，0 = 沒有

127.0.0.1:6379> TYPE product:1001:name
string                                  ← 每個 key 有型別，型別決定它能用哪些命令

127.0.0.1:6379> GET nosuchkey
(nil)                                   ← 不存在。注意：不是錯誤，是 nil

127.0.0.1:6379> DEL product:1001:name
(integer) 1                             ← 刪掉了 1 個

127.0.0.1:6379> DEL product:1001:name
(integer) 0                             ← 已經沒有了。刪不存在的 key 不是錯誤

127.0.0.1:6379> INCR pv
(integer) 1                             ← key 不存在時當成 0，加 1 之後回傳新值
127.0.0.1:6379> INCR pv
(integer) 2

127.0.0.1:6379> SET counter abc
OK
127.0.0.1:6379> INCR counter
(error) ERR value is not an integer or out of range      ← 這個才是錯誤

127.0.0.1:6379> LPUSH mylist a
(integer) 1
127.0.0.1:6379> GET mylist
(error) WRONGTYPE Operation against a key holding the wrong kind of value
```

**最後兩個錯誤值得停一下**：

- `INCR` 對一個存著 `"abc"` 的 key 會失敗——**Redis 的 String 沒有型別，是命令有型別**。
  同一個 key，`SET` 存進去的是位元組，`INCR` 會試著把它讀成整數。
- `GET` 對一個 list 會回 `WRONGTYPE`——**key 的型別是固定的**，
  一個 key 是 list 就不能用 string 的命令去碰它。
  這個錯誤在 Java 這一側會變成 `RedisSystemException`，而且**通常是在正式環境才第一次出現**
  （因為測試環境的那個 key 剛好是對的型別）。

📌 **`nil` 跟 `error` 是兩件事**，在 Java 這一側也是：
前者是 `null`，後者是例外。02 章開始每一種資料結構都會踩到這個分界。

### 0.4.3 五個你今天就該裝進腦袋的觀測命令

| 命令 | 回答什麼問題 | 代價 |
|---|---|---|
| `INFO [section]` | 這台 Redis 現在整體狀況如何 | 很便宜，可以常呼叫 |
| `DBSIZE` | 現在有幾個 key | O(1)，很便宜 |
| `MEMORY USAGE <key>` | 這**一個** key 佔多少記憶體 | 對大 key 會抽樣，不完全精確 |
| `SLOWLOG GET [n]` | 最近哪些命令跑很久 | 便宜。**出事的時候第一個看這裡** |
| `MONITOR` | 現在每一條進來的命令是什麼 | ⚠️ **很貴**，見下方警告 |

**`MONITOR` 印出每一條命令**——除錯時非常好用：

```bash
docker exec redis-lab redis-cli MONITOR
```

```
OK
1789541554.988416 [0 127.0.0.1:55410] "SET" "cart:alice" "\xe8\x80\xb3\xe6\xa9\x9fx1" "EX" "1800"
1789541555.047276 [0 127.0.0.1:55418] "INCR" "counter:pv"
1789541555.110073 [0 127.0.0.1:55420] "HSET" "user:7" "name" "bob"
```

每一行是：`時間戳 [db編號 來源IP:port] "命令" "參數"...`

> ⚠️ **`MONITOR` 不要開在正式環境，而且開了要記得關。**
> 它讓 Redis 把**每一條**命令都複製一份送給你。
> 一台 QPS 十萬的 Redis，`MONITOR` 一開就是每秒十萬行——
> 輸出緩衝區塞爆、CPU 被吃掉，**你為了查問題而開的工具，變成新的問題。**
> 需要在正式環境看流量，用 `SLOWLOG`（只記慢的）或 `redis-cli --stat`（只看統計）。

`redis-cli --stat` 是一個很好的日常監看工具，一秒一行：

```bash
docker exec redis-lab redis-cli --stat
```

```
------- data ------ --------------------- load -------------------- - child -
keys       mem      clients blocked requests            connections
4          1.34M    1       0       56 (+0)             22
4          1.33M    1       0       57 (+1)             22
4          1.33M    1       0       58 (+1)             22
```

`requests` 那一欄的 `(+1)` 是「這一秒新增了幾條命令」——**它是最快能看出「Redis 還活著嗎、忙不忙」的地方**。

### 0.4.4 `INFO` 怎麼讀

`INFO` 一次吐幾百行，分成十幾個區段。**第一次先認這五個**：

```bash
docker exec redis-lab redis-cli INFO server | grep -E "redis_version|redis_mode|uptime_in_seconds"
```

```
redis_version:7.2.16
redis_mode:standalone          ← standalone / sentinel / cluster（13 章）
uptime_in_seconds:897
```

```bash
docker exec redis-lab redis-cli INFO memory
```

```
used_memory:1043712
used_memory_human:1019.25K     ← Redis 自己認為用掉的記憶體
used_memory_rss_human:38.27M   ← 作業系統看到這個行程佔的實體記憶體
used_memory_peak_human:524.19M ← 史上最高點（很重要，見下方）
maxmemory:0                    ← 0 = 沒有上限
maxmemory_human:0B
maxmemory_policy:noeviction    ← 預設策略：滿了就拒絕寫入（04 章）
mem_fragmentation_ratio:39.92
```

⚠️ **`used_memory` 與 `used_memory_rss` 為什麼差這麼多？**

- `used_memory` 是 Redis 統計自己配置出去的位元組。
- `used_memory_rss` 是作業系統看到的。**它包含了「Redis 曾經用過、還給配置器、但配置器還沒還給作業系統」的部分。**
- 上面這台剛跑完一個 500MB 的實驗又刪光，所以 `peak` 是 524MB、`rss` 還留著 38MB，
  比率變成 39.92——**這不是記憶體洩漏，是碎片**（04 章 4.4）。

> 📌 **看記憶體要看三個數字，不是一個**：
> `used_memory`（現在用多少）、`used_memory_peak`（曾經用到多少）、`used_memory_rss`（作業系統實際給了多少）。
> **容量規劃要看 peak，不是 current**——你的機器必須裝得下尖峰，而不是平均。

```bash
docker exec redis-lab redis-cli INFO stats
```

```
total_connections_received:7
total_commands_processed:7
instantaneous_ops_per_sec:2
keyspace_hits:1                ← 讀取時 key 存在的次數
keyspace_misses:1              ← 讀取時 key 不存在的次數
expired_keys:0                 ← 因為過期被刪掉的 key 數（01 章）
evicted_keys:0                 ← 因為記憶體不夠被踢掉的 key 數（04 章）
rejected_connections:0         ← 因為連線數滿而被拒絕的連線
```

⚠️ **這些是「從啟動到現在」的累計值，不是當下的值。**
你要的通常是「最近一分鐘增加了多少」——監控系統會幫你算差值，
手動看的時候記得 `CONFIG RESETSTAT` 歸零再觀察。

**`expired_keys` 跟 `evicted_keys` 一定要分清楚**：

| | 意思 | 正常嗎 |
|---|---|---|
| `expired_keys` | key 到了它自己設定的過期時間 | ✅ 正常，你要的 |
| `evicted_keys` | **記憶體滿了**，Redis 挑 key 出來踢掉 | ⚠️ **不正常**。0.3.2 那個購物車就死在這裡 |

> 📌 **`evicted_keys` 是這一站最該接上告警的一個指標。**
> 它從 0 變成非 0 的那一刻，代表「有資料在你不知道的情況下被刪掉了」。

```bash
docker exec redis-lab redis-cli INFO keyspace
```

```
# Keyspace
db0:keys=1,expires=0,avg_ttl=0
```

`keys` 是 key 總數，**`expires` 是其中「有設過期時間」的數量**。
這兩個數字的差距是一個很有用的健康指標：
**`keys` 遠大於 `expires`，代表這台 Redis 上有一大堆永遠不會走的 key**——
它們只會愈長愈多，直到 0.3.2 的事故發生。

### 0.4.5 ⚠️ 這台是實驗機

0.4.1 的啟動命令裡有 `--enable-debug-command yes`。**正式環境絕對不要開。**

不開的話，`DEBUG` 系列命令會直接被擋掉：

```bash
docker exec redis-nodebug redis-cli DEBUG POPULATE 100
```

```
ERR DEBUG command not allowed. If the enable-debug-command option is set to "local",
you can run it from a local connection, otherwise you need to set this option in the
configuration file, and then restart the server.
```

**為什麼 Redis 7 預設把它擋掉**：`DEBUG` 底下有一堆可以直接弄死這台 Redis 的子命令——
`DEBUG SLEEP 100`（讓它整整卡 100 秒）、`DEBUG SEGFAULT`（讓它當場崩潰）、
`DEBUG QUICKLIST-PACKED-THRESHOLD`（改內部結構門檻）。

本站會用到三個，全部只在實驗機上：

| 命令 | 做什麼 | 哪一章用 |
|---|---|---|
| `DEBUG POPULATE 1000000` | 瞬間灌 100 萬個 `key:N` 進去 | 01、03 |
| `DEBUG SET-ACTIVE-EXPIRE 0` | 關掉主動過期——**這是看懂惰性刪除的唯一方法** | 01 |
| `DEBUG SLEEP 5` | 讓 Redis 主執行緒睡 5 秒，模擬「它卡住了」 | 03、08 |

📌 **正式環境要擋掉的不只 `DEBUG`。** `FLUSHALL`、`KEYS`、`CONFIG` 都可以用
`rename-command` 改名或停用——13 章與 14 章會給一份完整的正式環境設定。

---

## 0.5 Redis 有多快，以及瓶頸在哪

### 0.5.1 實測：單命令的吞吐

Redis 自己附了壓測工具 `redis-benchmark`。**在容器內跑**（先排除網路變因）：

```bash
docker exec redis-lab redis-benchmark -q -n 100000 -c 50 -t set,get,incr,lpush,sadd,zadd
```

| 參數 | 意思 |
|---|---|
| `-q` | 安靜模式，只印結果 |
| `-n 100000` | 每種命令跑 10 萬次 |
| `-c 50` | 50 個併發連線 |
| `-t set,get,...` | 只測這幾種命令 |

```
SET:   272479.56 requests per second, p50=0.095 msec
GET:   279329.59 requests per second, p50=0.095 msec
INCR:  274725.28 requests per second, p50=0.095 msec
LPUSH: 271739.12 requests per second, p50=0.095 msec
SADD:  274725.28 requests per second, p50=0.095 msec
ZADD:  270270.28 requests per second, p50=0.095 msec
```

**注意六種命令的數字幾乎一模一樣**（27 萬 rps 上下、p50 都是 0.095 毫秒）。
`SET` 是寫字串、`ZADD` 是寫排序集合，計算量差很多，**但吞吐一樣**。

> 📌 **這件事本身就是答案**：
> **在這個規模下，時間根本不是花在 Redis 的計算上，是花在「收一個請求、回一個回應」上。**

### 0.5.2 實測：pipeline 一次送 16 條

同一台 Redis，只多一個參數 `-P 16`（一次打包 16 條命令再送出去）：

```bash
docker exec redis-lab redis-benchmark -q -n 100000 -c 50 -t set,get -P 16
```

```
SET: 2702702.75 requests per second, p50=0.239 msec
GET: 3333333.50 requests per second, p50=0.191 msec
```

| | 一條一條送 | pipeline 16 條 | 倍數 |
|---|---|---|---|
| SET | 272,479 rps | **2,702,702 rps** | **9.9 倍** |
| GET | 279,329 rps | **3,333,333 rps** | **11.9 倍** |

**Redis 一行程式碼都沒改，吞吐變成 10 倍。**

它證明的事情是：

> **原本的 27 萬 rps 裡，大約九成的時間花在網路往返上，不是花在 Redis 執行命令上。**
> Redis 執行一條 `GET` 需要的時間是**奈秒等級**；
> 把請求送過去、把回應送回來需要的時間是**百微秒等級**。差了三個數量級。

📌 **這個結論會在整站不斷回來**：

- 03 章：什麼時候該用 pipeline，以及它跟「交易」的差別（它們常被搞混）。
- 06 章：為什麼 Lettuce 的連線池設定沒有你想的那麼重要（因為它是多工的）。
- 12 章：為什麼「一個請求打 20 次 Redis」比「一個請求打 1 次 MySQL」還慢。

### 0.5.3 從 Java 這一側看到的數字

回到 0.2.3 的實測：Java 打本機 Docker 的 Redis，單執行緒循序呼叫 `GET`，
量到 **134,861 ns = 0.135 毫秒**。而 `redis-benchmark` 在容器內量到的 p50 是 **0.095 毫秒**。

差的那 0.04 毫秒是：Docker 的埠轉發 + Lettuce 的編解碼 + JVM 這一側的開銷。

| 量法 | p50 | 誰在裡面 |
|---|---|---|
| `redis-benchmark`（容器內） | 0.095 ms | Redis 本身 + 容器內 loopback |
| Java（本機 Docker、20 執行緒） | 0.172 ms | ＋ Docker 埠轉發、Lettuce、JVM |
| 真實環境（Redis 在另一台機器） | 0.3～1 ms | ＋ 實體網路 |

> ⚠️ **拿這一節的數字去做容量規劃之前，先在你自己的環境上重跑一次。**
> 雲端的 Redis 託管服務（ElastiCache、Memorystore）加上跨可用區的網路，
> **單次往返 1～2 毫秒是常態**——那代表「一個請求打 20 次 Redis」就是 40 毫秒，全部花在等待上。

---

## 0.6 這一站的地圖

### 0.6.1 十五章，分兩半

```
第一部分：Redis 本體（在 redis-cli 裡把它弄懂）
  00  課程地圖與第一台 Redis                      ← 你在這裡
  01  key、TTL 與過期機制
  02  五大結構與它們的場景                        ★核心
  03  單執行緒與慢命令                            ★核心
  04  記憶體、淘汰與持久化
  05  原子性：交易、Lua 與 pipeline                ★核心
        ↓
第二部分：接進 Spring 專案
  06  連線與序列化（RedisTemplate / Lettuce）      ★核心
  07  快取抽象接上 Redis（@Cacheable）
  08  故障與降級
  09  分散式鎖                                    ★核心
  10  限流與冪等
  11  Session 與 token 撤銷
  12  熱點、計數與預扣庫存                         ★核心
  13  高可用在 Java 這一側（主從 / Sentinel / Cluster）
  14  測試與維運
```

**為什麼前六章要待在命令列裡？**

因為 `redis.opsForValue().get("k")` 這行 Java 程式碼，**把真正發生的事情蓋住了**。
它看起來像一個方法呼叫，實際上是：一次網路往返、一條佔用 Redis 主執行緒的命令、
一次記憶體查找、一次可能觸發的惰性刪除。

**0.3 的四個事故，全部都是「Java 那一側看不出來」的事故。**
所以這一站的教法是：先在命令列裡把 Redis 那一側看清楚，再回到 Java。

### 0.6.2 四個事故分別在哪裡被解決

| 事故 | 你現在只知道「它會壞」 | 你之後會知道 | 章 |
|---|---|---|---|
| 一行 `keys()` | KEYS 很慢 | `SCAN` 的游標語意、它保證與不保證什麼、COUNT 怎麼設、還有哪 12 個命令有同樣的問題 | 01.5、03 |
| 購物車不見 | 記憶體會滿 | 八種淘汰策略的差別、`volatile-*` 與 `allkeys-*` 的分界、什麼資料不能跟快取放同一台 | 04、11 |
| `\xac\xed` | 預設序列化器很爛 | 四個序列化器分別在哪裡、Jackson 要不要帶型別資訊、快取資料怎麼跨版本 | 06、07 |
| 超賣 100 件 | 要用 `DECR` | 為什麼 `MULTI` 不能解決它、Lua 可以、分散式鎖什麼時候才真的需要、鎖與交易的先後順序 | 05、09、12 |

### 0.6.3 這一站**不**處理的四件事

| 不處理 | 為什麼 | 在哪裡 |
|---|---|---|
| Redis 原始碼與 C 實作細節 | 本站教「怎麼用對」，不教「它怎麼寫的」。但**每一個行為都會實測給你看**，不會只叫你背結論 | —— |
| Redis Stack 的擴充模組（RedisJSON、RediSearch、向量搜尋） | 那是另一套產品線，且多數團隊的正式環境是純 Redis | —— |
| Redis 7.4+ / Valkey 的新功能（hash 欄位級 TTL 等） | 本站釘在 7.2。那些功能很好，但你的正式環境多半還沒有 | 14 章會提一句升級路徑 |
| 完整的維運（備份、擴容、遷移） | 那是 SRE 的工作。本站只教「Java 這一側該知道的部分」 | 13、14 |

---

## 0.7 本站的基準專案

整站只有一個 Maven 專案，每一章往上加東西。現在先把它建起來。

### 0.7.1 `pom.xml`

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
  <artifactId>lab10</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <properties><java.version>21</java.version></properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-redis</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
    <dependency>
      <groupId>com.h2database</groupId>
      <artifactId>h2</artifactId>
      <scope>runtime</scope>
    </dependency>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-pool2</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
```

四個相依各自的角色：

| 相依 | 角色 | 注意 |
|---|---|---|
| `spring-boot-starter-data-redis` | `RedisTemplate`、`StringRedisTemplate`，以及底層的 **Lettuce** 客戶端 | Boot 3.2.5 帶的是 Lettuce 6.3.x。**Jedis 不是預設**（06 章會比較兩者） |
| `spring-boot-starter-web` | 後面幾章需要真的用 HTTP 打進來（限流、Session） | —— |
| `spring-boot-starter-data-jpa` + `h2` | 12 章的「Redis 預扣 + 資料庫落帳」需要一個會做交易的地方 | 用 H2 是刻意的：**這一站要看的是 Redis**，不想讓你先裝一台資料庫 |
| `commons-pool2` | **Lettuce 的連線池需要它，而它不是自動帶進來的** | 沒有它，`spring.data.redis.lettuce.pool.*` 的設定會**安靜地不生效**（06 章 6.7） |

### 0.7.2 `application.yml`

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 16379          # 0.4.1 刻意避開 6379
  datasource:
    url: jdbc:h2:mem:lab10;DB_CLOSE_DELAY=-1
  jpa:
    hibernate.ddl-auto: update
logging:
  level:
    root: WARN
    com.example.lab10: INFO
```

⚠️ **這裡故意「沒有」設逾時與連線池。**
這是 Spring Boot 的預設狀態，也是絕大多數專案上線時的狀態——
**06 章 6.8 會實測這個預設有多危險**（Redis 卡住時，你的執行緒會等多久），
然後才加上正確的設定。現在先保持原樣，這樣你才看得到差別。

### 0.7.3 `RedisProbe`：整站共用的觀測工具

這是本站最該先裝好的東西。它把 0.4.3、0.4.4 那些命令包成 Java 可以呼叫的形式，
**後面每一章的每一個數字都從它來**。

```java
package com.example.lab10;

import io.lettuce.core.api.async.RedisAsyncCommands;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Properties;
import java.util.function.Function;

/**
 * 整站共用的觀測工具：把 Redis 自己記錄的狀態印出來。
 * 課文裡的每一個數字，不是這支工具印的，就是 redis-cli 上同名命令印的。
 */
@Component
public class RedisProbe {

    private final StringRedisTemplate redis;

    public RedisProbe(StringRedisTemplate redis) {
        this.redis = redis;
    }

    private <T> T withConnection(Function<RedisConnection, T> fn) {
        try (RedisConnection conn = redis.getRequiredConnectionFactory().getConnection()) {
            return fn.apply(conn);
        }
    }

    /** INFO 裡的某一個欄位，例如 info("memory", "used_memory_human") */
    public String info(String section, String field) {
        Properties p = withConnection(c -> c.serverCommands().info(section));
        return p == null ? "?" : p.getProperty(field, "?");
    }

    public long infoLong(String section, String field) {
        String v = info(section, field);
        return "?".equals(v) ? -1 : Long.parseLong(v);
    }

    public long dbSize() {
        return withConnection(c -> c.serverCommands().dbSize());
    }

    /** 一行摘要：key 數 / 記憶體 / 命中率 / 淘汰 / 過期 / 連線 */
    public void snapshot(String title) {
        long hits = infoLong("stats", "keyspace_hits");
        long misses = infoLong("stats", "keyspace_misses");
        double hitRate = (hits + misses) == 0 ? 0 : 100.0 * hits / (hits + misses);
        System.out.printf("[%-12s] keys=%,-9d 記憶體=%-8s 上限=%-8s 命中率=%5.1f%%  淘汰=%-7s 過期=%-9s 連線=%s%n",
                title, dbSize(),
                info("memory", "used_memory_human"), info("memory", "maxmemory_human"),
                hitRate,
                info("stats", "evicted_keys"), info("stats", "expired_keys"),
                info("clients", "connected_clients"));
    }

    /**
     * 慢命令：Redis 自己量的「這條命令佔用主執行緒多久」（微秒）。
     * 注意這裡走的是 Lettuce 原生 API —— Spring Data Redis 的 execute() 只認位元組回應，
     * 而 SLOWLOG 回的是巢狀陣列（見下方說明）。
     */
    public void slowlog(int count) {
        List<Object> entries = redis.execute((RedisCallback<List<Object>>) c -> {
            @SuppressWarnings("unchecked")
            RedisAsyncCommands<byte[], byte[]> cmd = (RedisAsyncCommands<byte[], byte[]>) c.getNativeConnection();
            try {
                return cmd.slowlogGet(count).get();
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        if (entries == null || entries.isEmpty()) {
            System.out.println("SLOWLOG 是空的（沒有命令超過門檻）");
            return;
        }
        System.out.println("SLOWLOG（最近 " + entries.size() + " 筆）");
        for (Object e : entries) {
            List<?> row = (List<?>) e;
            long micros = (Long) row.get(2);
            StringBuilder cmd = new StringBuilder();
            for (Object a : (List<?>) row.get(3)) cmd.append(new String((byte[]) a, StandardCharsets.UTF_8)).append(' ');
            System.out.printf("  %,10d µs  %s%n", micros, cmd.toString().trim());
        }
    }

    /** 直接下一條原始命令，回傳字串——在 redis-cli 做的事，Java 這邊也能重現 */
    public String raw(String command, String... args) {
        byte[][] bytes = new byte[args.length][];
        for (int i = 0; i < args.length; i++) bytes[i] = args[i].getBytes(StandardCharsets.UTF_8);
        Object r = redis.execute((RedisCallback<Object>) c -> c.execute(command, bytes));
        if (r instanceof byte[] b) return new String(b, StandardCharsets.UTF_8);
        return String.valueOf(r);
    }

    /** 改設定，例如 config("maxmemory", "32mb") */
    public void config(String key, String value) {
        withConnection(c -> { c.serverCommands().setConfig(key, value); return null; });
    }

    public void flushAll() {
        withConnection(c -> { c.serverCommands().flushAll(); return null; });
    }
}
```

**`slowlog()` 那段為什麼要繞到 Lettuce 原生 API？**

因為 Spring Data Redis **沒有**包裝 `SLOWLOG`。直覺的寫法是用通用的 `execute`：

```java
redis.execute((RedisCallback<Object>) c -> c.execute("SLOWLOG", "GET".getBytes(), "2".getBytes()));
```

它會炸：

```
java.lang.UnsupportedOperationException: io.lettuce.core.output.ByteArrayOutput does not support set(long)
```

**原因很值得記住**：`RedisConnection.execute()` 假設回應是「一坨位元組」，
而 `SLOWLOG GET` 回的是**巢狀陣列**（陣列裡有整數、有字串、有子陣列）。
解碼器對不上，就是這個例外。

> 📌 **這是第一次遇到、但不會是最後一次的模式**：
> **Spring Data Redis 是一層抽象，它蓋不住所有的 Redis 命令。**
> 遇到抽象沒包到的命令時，你有三條路：
> ① `execute(...)` 下原始命令（只適用於回應是簡單型別的）、
> ② 拿 `getNativeConnection()` 直接用 Lettuce 的 API（像這裡）、
> ③ 寫 Lua 腳本（05 章）。
> 這三條路後面都會用到。

### 0.7.4 跑起來確認

```java
package com.example.lab10.ch00;

import com.example.lab10.RedisProbe;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;

@SpringBootTest
class ProbeSmokeTest {

    @Autowired RedisProbe probe;
    @Autowired StringRedisTemplate redis;

    @Test
    void itWorks() {
        System.out.println("═══ 0.7.4 RedisProbe 試跑 ═══");
        System.out.println("Redis 版本 : " + probe.info("server", "redis_version"));
        probe.snapshot("一開始");
        for (int i = 0; i < 1000; i++) redis.opsForValue().set("probe:" + i, "v");
        redis.opsForValue().get("probe:1");
        redis.opsForValue().get("probe:沒有這個");
        probe.snapshot("寫了 1000 筆");
        System.out.println("PING = " + probe.raw("PING"));
        probe.slowlog(2);
    }
}
```

先把 Redis 的統計歸零，再跑：

```bash
docker exec redis-lab redis-cli FLUSHALL
docker exec redis-lab redis-cli CONFIG RESETSTAT
mvn -Dtest=ProbeSmokeTest test
```

```
═══ 0.7.4 RedisProbe 試跑 ═══
Redis 版本 : 7.2.16
[一開始         ] keys=0         記憶體=1.04M    上限=0B       命中率=  0.0%  淘汰=0       過期=0         連線=2
[寫了 1000 筆   ] keys=1,000     記憶體=1.14M    上限=0B       命中率= 50.0%  淘汰=0       過期=0         連線=2
PING = PONG
SLOWLOG 是空的（沒有命令超過門檻）
```

**看到這個輸出，環境就對了。** 順便驗證三件事：

- **命中率 50%**：一次 `get("probe:1")` 命中、一次 `get("probe:沒有這個")` 沒命中。命中率是**讀取**的統計，1000 次寫入不算在裡面。
- **1000 個 key 只多用了 0.1 MB**：平均一個 key（含 key 名、值、內部結構）約 100 bytes。01 章 1.3 會拆解這 100 bytes 是誰在用。
- **上限 0B**：`maxmemory` 沒設，也就是**沒有上限**——0.3.2 的事故正是在有上限時發生的，04 章會談該怎麼設。

### 0.7.5 命名慣例

| 套件 | 放什麼 | 說明 |
|---|---|---|
| `com.example.lab10.chNN` | **刻意寫壞的實驗變體** | 例如本章的 `ch00.A1KeysTest`。這些程式碼是拿來看它壞掉的，不要照抄 |
| `com.example.lab10.shop` | **本站建議的樣子** | 每一章最後的「落地到 shop-service」會往這裡加東西 |
| `com.example.lab10.RedisProbe` | 共用工具 | 整站共用 |

- **實測輸出的標頭就是節號**：每段輸出都印 `═══ 節號 標題 ═══`，可以直接對回課文。
- **本站所有引用都是站內引用**，寫成「01 章 1.5.3」。這一站不依賴任何其他課程。

---

## 0.8 常見誤區

**① 「Redis 很快，所以能用它的地方都用它」**

0.2.3 實測：它比行程內的 `HashMap` 慢 **5,619 倍**。
一個請求打 20 次 Redis，就是 20 次網路往返。
**先問「這份狀態需要跨機器共享嗎」，不要先問「這樣會不會比較快」。**

**② 「Redis 是記憶體資料庫，所以可以拿來當資料庫」**

它沒有交易回滾、沒有外鍵、沒有 join、查詢能力極弱，
而且**預設設定下主機斷電會掉資料**（04 章會量給你看）。
它是「可以撐一下的共享狀態」，不是「你的資料在哪裡」。

**③ 「設了 TTL 的資料才會消失」**

0.3.2 實測：沒設 TTL 的購物車照樣被 LRU 踢掉，而且**不回報任何錯誤**。
**在 Redis 裡，任何一個 key 都可能在任何時候不見。**
你的程式碼必須能處理「它不在」——這是整站的第一原則。

**④ 「快取掉了頂多重算一次，沒什麼大不了」**

那要看掉的是什麼、以及同時掉多少。
八千個請求同時發現快取沒了、同時去打資料庫，那叫雪崩（07 章）。

**⑤ 「單執行緒 = 慢」**

0.5.1 實測：單執行緒的 Redis 在這台筆電上跑到 **27 萬 rps**。
單執行緒帶來的不是慢，是**「一條命令執行到底不會被打斷」**——
這個性質是 `DECR`、`SETNX`、Lua 能解決併發問題的根本原因（05 章）。
它真正的代價是 0.3.1 那種：**一條慢命令會卡住所有人**。

**⑥ 「先在測試環境驗過就沒問題」**

0.3.1 的 `keys()` 在 200 個 key 的測試環境是 0.2 毫秒，在 300 萬個 key 的正式環境是 1.8 秒。
**這一站有一整類問題是「只在資料量大的時候才出現」的**，
所以本站的每一個實驗都會告訴你「資料量是多少」——請照著灌，不要用 10 筆資料驗證結論。

**⑦ 「用 `MONITOR` 看一下線上流量」**

見 0.4.3 的警告。**這是新手最容易在正式環境闖的禍之一。**

---

## 0.9 本章小結

**這一章建立了三件事**：

1. **一個判斷準則**（0.2.4）：這份狀態需不需要跨機器共享？
   不需要 → 放行程內，快 5000 倍。需要 → 才付 Redis 的代價。
2. **四個事故**（0.3）：每一個都是「Java 這一側看起來正常，問題在 Redis 那一側」。
3. **一套環境與工具**（0.4、0.7）：一台釘在 7.2 的 Redis、一個 Spring Boot 專案、
   一個 `RedisProbe`——接下來十四章都在這上面跑。

### 0.9.1 驗收清單

做得到才往下走：

- [ ] `docker exec redis-lab redis-cli PING` 回 `PONG`。
- [ ] 說得出 `docker run` 那行裡 `--enable-debug-command yes` 為什麼**只能**出現在實驗機。
- [ ] 在 `redis-cli` 裡分辨 `(nil)` 與 `(error)`，並說出它們在 Java 這一側分別是什麼。
- [ ] 說出 `INFO` 裡 `expired_keys` 與 `evicted_keys` 的差別，以及哪一個該接告警。
- [ ] 說出 `used_memory` 與 `used_memory_rss` 為什麼會差幾十倍。
- [ ] 跑完 0.3 的四個事故，並說出每一個的根因。
- [ ] `ProbeSmokeTest` 印出和 0.7.4 一樣格式的輸出。

### 0.9.2 本章練習

**練習一（10 分鐘）**：把 0.3.4 的「寫法 A」改成用 200 個執行緒跑 10 次，
記錄每次超賣幾件。**超賣的數量穩定嗎？** 想一想為什麼不穩定——
這件事會直接影響你之後怎麼寫併發測試（14 章）。

**練習二（15 分鐘）**：0.3.1 的事故用了 300 萬個 key。
把資料量改成 1 萬、10 萬、100 萬、300 萬各跑一次，記錄 `keys()` 的耗時與 p99 延遲。
**畫成一張表。** 你要親眼看到「它跟資料量成正比」這件事——
這是 `KEYS` 與 `SCAN` 的核心差別，01 章會用到這張表。

**練習三（10 分鐘）**：在你自己的機器上重跑 0.2.3 與 0.5.1。
**你的數字跟課文差多少？** 如果差超過 3 倍，看一下是不是 Docker 分到的 CPU 太少
（`docker stats` 可以看）。後面所有的逾時設定都應該基於**你自己的**數字。

**練習四（進階，20 分鐘）**：用 `redis-cli --raw` 進互動模式，
只用 `SET` / `GET` / `INCR` / `EXPIRE` / `TTL` 五條命令，
實作一個「同一個 IP 一分鐘最多 5 次」的限流器——**用手打，不要寫程式**。
打到第 6 次時你應該看到計數超過 5。
記下你的作法，10 章會拿它跟正確作法對照（你現在這個版本有兩個 bug）。

---

## 0.10 下一章預告

下一章（01）從最基本的東西開始：**key**。

聽起來沒什麼好講的，但這一章會回答四個問題，而且四個都反直覺：

- 為什麼 `SET cart:alice "..."` 這一行，會讓你精心設定的 30 分鐘過期**變成永不過期**？
  （這是 0.3.2 事故的另一半）
- 一個 key 過期之後，它**還在記憶體裡嗎**？
  實測：關掉主動過期後，過期 900 毫秒的 key **還在 `DBSIZE` 裡面**，直到有人去讀它。
- 100 萬個 key 同時到期，Redis 要花多久清掉？
  實測：**3 秒**，而且期間其他人的延遲從 0.15 ms 跳到 26 ms。
- `SCAN` 到底保證什麼？
  實測：**它會吐出重複的 key**——在一次掃描中間有人刪掉大量資料時，1 萬個 key 裡出現了重複。

這四件事全部都會在 `redis-cli` 裡看到，然後回到 Java 這一側看它們長什麼樣子。
