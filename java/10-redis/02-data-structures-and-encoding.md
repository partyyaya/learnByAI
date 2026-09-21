# 第 02 章：五大結構與它們的場景

> 01 章把 key 當成標籤在看。這一章看 key 指向的**值**。
>
> Redis 常被說成「一個 key-value 儲存」。**這個描述會讓你用錯它。**
> 真正的描述是 00 章那句話：**它是一個資料結構伺服器**——
> 它不是「存字串的地方」，是「一組放在行程外面、可以用命令操作的資料結構」。
>
> 這個差別具體有多大？這一章會量給你看：
>
> - 同一份 10 欄位的使用者資料，10 萬筆。用 10 個 String 存要 **79.4 MB**，
>   用一包 JSON 存要 **30.7 MB**，用 Hash 存只要 **24.7 MB**。
> - 更重要的是**改一個欄位**：200 個人同時幫同一個使用者加 1 點，
>   JSON 版**掉了 198 次更新**（12500 只變成 12502），Hash 版一次都沒掉。
> - Sorted Set 從 1000 個成員長到 **500 萬**個成員（5000 倍），
>   單次查詢從 0.98 µs 變成 1.58 µs——**只慢了 1.6 倍**。這就是 `O(log N)`。
> - 「今天誰簽到了」——30 萬人，用 Set 存要 **15.2 MB**，用 Bitmap 存要 **0.06 MB**（**242 倍**）。
> - 而 Hash 從 512 個欄位變成 513 個欄位的那一刻，
>   **記憶體從 6,192 bytes 跳到 28,816 bytes——多了一個欄位，多了 4.6 倍。**
>
> 📌 這一章的主線是一個問題：**同一個需求，用哪個結構？**
> 最後 2.11 有一張決策表，但先把五個結構各自的脾氣看過一遍。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 說出五大結構各自的**命令前綴、典型場景、以及它們的複雜度**，
  並指出每個結構有哪一條「不能在正式環境用」的命令（2.3～2.7）。
- 在「10 個 String / 一包 JSON / 一個 Hash」之間做出有數字支持的選擇（2.4.2）。
- 說明為什麼「讀出來、改、寫回去」在併發下一定會掉更新，
  以及 Hash 的 `HINCRBY` 為什麼不會（2.4.4）。
- 說出 `O(log N)` 在實務上的意義：**資料多 5000 倍，查詢只慢 1.6 倍**（2.7.3）。
- 說明 ZSet 的分數是 `double`，並指出**哪一種時間戳可以當分數、哪一種不行**（2.7.2）。
- 用 `OBJECT ENCODING` 說出一個 key 現在用哪種內部表示，
  並說出四個結構各自的轉換門檻（2.8.3）。
- 解釋**編碼轉換是單向的**，以及這件事在什麼情況下會讓你白白多用 19 倍的記憶體（2.8.2）。
- 在 Set、Bitmap、HyperLogLog 之間做選擇，並說出各自**能回答**與**不能回答**的問題（2.9）。
- 指出一個 big key 的三種代價：Redis 主執行緒、網路、以及 **JVM 的 heap**（2.10）。

---

## 2.2 先講一件事：命令是綁在型別上的

### 2.2.1 一個 key 一個型別

00 章 0.4.2 看過這個錯誤，現在正式說明它：

```
127.0.0.1:6379> LPUSH mylist a
(integer) 1
127.0.0.1:6379> GET mylist
(error) WRONGTYPE Operation against a key holding the wrong kind of value
```

**每個 key 有且只有一個型別**，`TYPE` 告訴你它是什麼：

| `TYPE` 回傳 | 結構 | 命令前綴 |
|---|---|---|
| `string` | String | `SET` / `GET` / `INCR` / `APPEND` / `SETBIT` / `PFADD` |
| `hash` | Hash | `H`（`HSET`、`HGET`、`HINCRBY`…） |
| `list` | List | `L` / `R`（`LPUSH`、`RPOP`、`LRANGE`…） |
| `set` | Set | `S`（`SADD`、`SISMEMBER`、`SINTER`…） |
| `zset` | Sorted Set | `Z`（`ZADD`、`ZSCORE`、`ZRANGE`…） |

📌 **注意最後一列**：Bitmap 與 HyperLogLog **不是獨立的型別**，
它們都是 String——只是用不同的命令去解讀同一串位元組（2.9 會展開）。

⚠️ **`WRONGTYPE` 在 Java 這一側是 `RedisSystemException`，而且通常是上線之後才第一次出現**——
因為測試環境的那個 key 剛好是被正確的程式碼建立的。
**這是 key 命名慣例（01 章 1.2.3）真正的價值**：
`cart:8842` 如果約定好是 hash，就不會有另一支程式用 `SET` 去寫它。

### 2.2.2 複雜度就寫在命令上

Redis 的每一條命令，文件上都標了時間複雜度。**這件事比在其他資料庫裡重要得多**，
因為 00 章 0.3.1 已經證明過：**Redis 是單執行緒的，一條 `O(N)` 的命令會讓所有人一起等。**

先把這一章會出現的複雜度分成三類：

| 類別 | 例子 | 能不能隨便用 |
|---|---|---|
| **`O(1)`** | `GET`、`SET`、`HGET`、`HSET`、`SADD`、`SISMEMBER`、`LPUSH`、`RPOP`、`ZSCORE`（實際是 O(1)～O(log N)） | ✅ 隨便用 |
| **`O(log N)`** | `ZADD`、`ZRANK`、`ZRANGEBYSCORE` 的定位部分 | ✅ 幾乎等於免費（2.7.3 有實測） |
| **`O(N)`** | `HGETALL`、`SMEMBERS`、`LRANGE 0 -1`、`SINTER`、`KEYS`、`DEL` 一個大 key | ⚠️ **N 是誰？** N 小就沒事，N 大就是事故 |

> 📌 **整章請帶著這個問題讀每一條 `O(N)` 命令：「這裡的 N 會長到多大？」**
> `HGETALL` 對一個 10 欄位的購物車是 `O(10)`，對一個 100 萬欄位的 hash 是 0.19 秒的全服務暫停（2.10.1）。
> **同一條命令，同一份程式碼，差別只在資料長大了。**

---

## 2.3 String：它不只是字串

### 2.3.1 它其實是「一段位元組」

Redis 的 String 可以放任何位元組，最大 512 MB。
但真正該記住的是：**有一整組命令把這段位元組當成「數字」或「位元陣列」在用。**

### 2.3.2 命令巡禮

```
127.0.0.1:6379> SET pv 0
OK
127.0.0.1:6379> INCR pv
(integer) 1
127.0.0.1:6379> INCRBY pv 10
(integer) 11
127.0.0.1:6379> INCRBYFLOAT price 19.99
"19.99"

127.0.0.1:6379> APPEND log "line1;"
(integer) 6
127.0.0.1:6379> APPEND log "line2;"
(integer) 12
127.0.0.1:6379> GET log
"line1;line2;"
127.0.0.1:6379> STRLEN log
(integer) 12
127.0.0.1:6379> GETRANGE log 0 4
"line1"
127.0.0.1:6379> SETRANGE log 0 "LINE1"
(integer) 12
127.0.0.1:6379> GET log
"LINE1;line2;"

127.0.0.1:6379> MSET a 1 b 2 c 3
OK
127.0.0.1:6379> MGET a b c nope
1) "1"
2) "2"
3) "3"
4) (nil)
```

| 命令 | 複雜度 | 用途 |
|---|---|---|
| `SET` / `GET` | O(1) | —— |
| `MSET` / `MGET` | O(N)，N = key 個數 | **一次往返讀寫多個 key**——比迴圈快一個數量級（00 章 0.5.2） |
| `INCR` / `INCRBY` / `DECR` | O(1) | **原子計數**：00 章 0.3.4 的庫存、10 章的限流 |
| `INCRBYFLOAT` | O(1) | 金額累加。⚠️ 浮點數，不要拿來記帳 |
| `APPEND` | O(1) 攤提 | 累加日誌。⚠️ 沒有上限，會長成 big key |
| `STRLEN` / `GETRANGE` / `SETRANGE` | O(1) / O(N) | 把 String 當位元組陣列用 |
| `SETNX`（= `SET k v NX`） | O(1) | 09 章分散式鎖的根基 |

⚠️ **`MGET` 有一個常被忽略的限制**：在 Cluster 模式下，
**多個 key 如果不在同一個 slot，`MGET` 會直接失敗**（13 章 `CROSSSLOT`）。
單機寫得很順的 `MGET`，上 Cluster 那天全部要改。

### 2.3.3 三種編碼

01 章 1.2.2 看過一半，這裡補完：

```
值 '12345'              ENCODING=int      MEMORY USAGE=48
值 'xxxx...'（10 bytes） ENCODING=embstr   MEMORY USAGE=64
值 'xxxx...'（44 bytes） ENCODING=embstr   MEMORY USAGE=96
值 'xxxx...'（45 bytes） ENCODING=raw      MEMORY USAGE=104
```

| 編碼 | 條件 | 做法 |
|---|---|---|
| `int` | 值是 64 位元以內的整數 | **直接存在指標欄位裡**，連字串都不配置 |
| `embstr` | 字串 ≤ 44 bytes | 物件標頭與字串內容配置在**同一塊**記憶體 |
| `raw` | 字串 > 44 bytes | 標頭與內容分成兩塊 |

**`int` 那條的邊界很嚴格**，實測：

```
  '12345'              ENCODING=int      MEMORY USAGE=48
  '12345 '（多一個空白） ENCODING=embstr   MEMORY USAGE=64
  '012345'（前導 0）    ENCODING=embstr   MEMORY USAGE=64
  9223372036854775807  ENCODING=int      MEMORY USAGE=48     ← 2^63-1，還是 int
  9223372036854775808  ENCODING=embstr   MEMORY USAGE=72     ← 超過 int64 就不是了
  SET 12345 之後 APPEND 'x'  ENCODING=raw  MEMORY USAGE=64   ← 一旦離開就回不去
```

📌 **這件事在什麼時候有感覺**：
存一千萬個計數器，值都是乾淨的整數 → `int`，一個 48 bytes。
值多一個空白或前導 0 → `embstr`，一個 64 bytes。
**一千萬個 key 差 152 MB，只因為多了一個字元。**

⚠️ **`APPEND` 或 `SETRANGE` 會把 `int` / `embstr` 變成 `raw`**，而且不會變回去（2.8.2 的通則）。

### 2.3.4 String 該用在哪

| 適合 | 例子 |
|---|---|
| 單一值的快取 | `shop:cache:product:1001` 存整包 JSON |
| 計數器 | `shop:pv:20260916`、限流計數 |
| 分散式鎖 | `SET lock:xxx token NX PX 30000` |
| 位元運算（Bitmap） | 簽到、活躍用戶（2.9） |

| **不適合** | 為什麼 | 該用 |
|---|---|---|
| 多欄位的物件 | 改一個欄位要整包讀寫，而且併發下會掉更新（2.4.4） | Hash |
| 一直 `APPEND` 的日誌 | 沒有上限、沒有裁切，一定長成 big key | List + `LTRIM` |

---

## 2.4 Hash：這一章最該學會的結構

### 2.4.1 命令巡禮

```
127.0.0.1:6379> HSET cart:8842 p1001 2 p2002 1
(integer) 2
127.0.0.1:6379> HGET cart:8842 p1001
"2"
127.0.0.1:6379> HINCRBY cart:8842 p1001 3
(integer) 5
127.0.0.1:6379> HGETALL cart:8842
1) "p1001"
2) "5"
3) "p2002"
4) "1"
127.0.0.1:6379> HMGET cart:8842 p1001 p9999
1) "5"
2) (nil)
127.0.0.1:6379> HEXISTS cart:8842 p1001
(integer) 1
127.0.0.1:6379> HDEL cart:8842 p2002
(integer) 1
127.0.0.1:6379> HLEN cart:8842
(integer) 1
127.0.0.1:6379> HKEYS cart:8842
1) "p1001"
127.0.0.1:6379> HVALS cart:8842
1) "5"
```

| 命令 | 複雜度 | 備註 |
|---|---|---|
| `HSET` / `HGET` / `HDEL` / `HEXISTS` | O(1) | 一次一個欄位 |
| `HMGET` | O(N)，N = 你要的欄位數 | **一次往返拿多個欄位** |
| `HINCRBY` / `HINCRBYFLOAT` | O(1) | **原子**，2.4.4 的主角 |
| `HLEN` | O(1) | 欄位數 |
| **`HGETALL` / `HKEYS` / `HVALS`** | **O(N)，N = 整個 hash 的欄位數** | ⚠️ **N 會長大的話就是事故**（2.10） |
| `HSCAN` | 一批 O(1) | `HGETALL` 的安全版（跟 01 章的 `SCAN` 同一套語意） |
| `HRANDFIELD` | O(N) | 隨機取欄位（Redis 6.2+） |

### 2.4.2 實測：同一份資料，三種存法

一份 10 個欄位的使用者資料，10 萬筆。三種存法：

```bash
# ① 10 個獨立的 String key
SET user:1:name alice1
SET user:1:email alice1@example.com
... （每個使用者 10 條）

# ② 一包 JSON 存在一個 String
SET user:1 '{"name":"alice1","email":"alice1@example.com",...,"news":1}'

# ③ 一個 Hash
HSET user:1 name alice1 email alice1@example.com ... news 1
```

**結果**：

| 存法 | key 數 | 總記憶體 | 每個使用者 | 相對 Hash |
|---|---|---|---|---|
| ① 10 個 String | 1,000,000 | **79.39 MB** | 832 bytes | **3.2 倍** |
| ② 一包 JSON | 100,000 | **30.74 MB** | 322 bytes | 1.25 倍 |
| ③ 一個 Hash | 100,000 | **24.67 MB** | 258 bytes | 1 |

```
user:1 的細節
  ② JSON : STRLEN=173  MEMORY USAGE=304  ENCODING=raw
  ③ Hash : HLEN=10     MEMORY USAGE=208  ENCODING=listpack
```

**為什麼 ① 那麼貴**：01 章 1.2.2 算過，**一個 key 的固定成本就是 56 bytes**。
10 個欄位拆成 10 個 key，就是付 10 份 key 的管理成本，
再加上 `user:1:email` 這種長 key 名要重複存 10 次。

**為什麼 ③ 比 ② 省**：Hash 在欄位少的時候用 `listpack` 編碼——
**一塊連續的記憶體，欄位與值一個接一個排好，沒有指標、沒有雜湊表**（2.8 會展開）。
JSON 則要付出 `{`、`"`、`:`、`,` 這些語法字元的空間。

### 2.4.3 但記憶體不是重點

上面那張表的差距是 3.2 倍，聽起來不算驚人。
**真正的差距在「改一個欄位」跟「讀一個欄位」**：

| 操作 | ① 10 個 String | ② JSON | ③ Hash |
|---|---|---|---|
| 讀整個使用者 | `MGET` 10 個 key（1 次往返） | `GET`（1 次往返） | `HGETALL`（1 次往返） |
| **讀一個欄位** | `GET user:1:level`（4 bytes） | **`GET` 整包 173 bytes，Java 這側解析** | `HGET`（4 bytes） |
| **改一個欄位** | `SET user:1:points 12600` | **`GET` + 解析 + 改 + `SET`（2 次往返）** | `HSET`（1 次往返） |
| **點數 +1** | `INCR user:1:points`（原子） | **讀改寫（不是原子）** | `HINCRBY`（原子） |
| 刪掉整個使用者 | **`DEL` 10 個 key** | `DEL` 1 個 | `DEL` 1 個 |
| 設定過期時間 | **要設 10 次** | 1 次 | 1 次 |

**注意 ② 那一欄的兩個粗體：它們是同一個問題的兩面**——
**JSON 沒有「欄位」的概念，Redis 只看到一串位元組。**
任何針對單一欄位的操作，都得把整包搬到 Java 這一側處理。

### 2.4.4 實測：JSON 的讀改寫掉了 198 次更新

「讀改寫不是原子的」聽起來很抽象。**讓 200 個人同時幫同一個使用者加 1 點**：

```java
package com.example.lab10.ch02;

import com.example.lab10.RedisProbe;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;

@SpringBootTest
class JsonVsHashTest {

    @Autowired StringRedisTemplate redis;
    @Autowired RedisProbe probe;
    private final ObjectMapper mapper = new ObjectMapper();

    /** ⚠️ 全部是 String：StringRedisTemplate 的 hash 值只能是 String（2.4.6） */
    private Map<String, String> user() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("name", "alice");       m.put("email", "alice@example.com");
        m.put("phone", "0912345678"); m.put("city", "Taipei");
        m.put("level", "gold");       m.put("points", "12500");
        m.put("since", "2023-04-01"); m.put("lang", "zh-TW");
        m.put("theme", "dark");       m.put("news", "1");
        return m;
    }

    /** 200 個執行緒各幫同一個使用者加 1 點 */
    private void concurrentAddPoints(Runnable addOnePoint) throws Exception {
        CountDownLatch start = new CountDownLatch(1), done = new CountDownLatch(200);
        for (int i = 0; i < 200; i++) {
            new Thread(() -> {
                try { start.await(); addOnePoint.run(); } catch (InterruptedException ignored) {}
                finally { done.countDown(); }
            }).start();
        }
        start.countDown();
        done.await();
    }

    @Test
    void updateOneField() throws Exception {
        System.out.println("═══ 2.4.4 改一個欄位：JSON vs Hash ═══");
        probe.flushAll();

        // ---- JSON：讀出來、改、寫回去 ----
        redis.opsForValue().set("user:json", mapper.writeValueAsString(user()));
        concurrentAddPoints(() -> {
            try {
                String raw = redis.opsForValue().get("user:json");          // ① GET
                Map<String, Object> m = mapper.readValue(raw, Map.class);   // ② 反序列化
                m.put("points", String.valueOf(Integer.parseInt((String) m.get("points")) + 1)); // ③ 改
                redis.opsForValue().set("user:json", mapper.writeValueAsString(m)); // ④ SET
            } catch (Exception e) { throw new RuntimeException(e); }
        });
        Map<?, ?> after = mapper.readValue(redis.opsForValue().get("user:json"), Map.class);
        int got = Integer.parseInt(String.valueOf(after.get("points")));
        System.out.println("JSON  : 200 個人各加 1 點，12500 應該變成 12700");
        System.out.println("        實際 points = " + got + "   ← 少了 " + (12700 - got) + " 點");

        // ---- Hash：交給 Redis 加 ----
        redis.opsForHash().putAll("user:hash", user());
        concurrentAddPoints(() -> redis.opsForHash().increment("user:hash", "points", 1));
        System.out.println("Hash  : 同樣 200 個人各加 1 點");
        System.out.println("        實際 points = " + redis.opsForHash().get("user:hash", "points"));

        System.out.println();
        System.out.println("往返次數（改一個欄位）：JSON = 2 次（GET + SET），Hash = 1 次（HINCRBY）");
        System.out.println("傳輸位元組：JSON = " + (redis.opsForValue().get("user:json").length() * 2)
                + " bytes 來回，Hash = 約 20 bytes");
    }
}
```

**輸出**：

```
═══ 2.4.4 改一個欄位：JSON vs Hash ═══
JSON  : 200 個人各加 1 點，12500 應該變成 12700
        實際 points = 12502   ← 少了 198 點
Hash  : 同樣 200 個人各加 1 點
        實際 points = 12700

往返次數（改一個欄位）：JSON = 2 次（GET + SET），Hash = 1 次（HINCRBY）
傳輸位元組：JSON = 350 bytes 來回，Hash = 約 20 bytes
```

**200 次加點，只有 2 次留下來。**

這跟 00 章 0.3.4 的超賣是**同一個 bug**，只是換了個樣子：

```
    執行緒 A                              執行緒 B
    GET user:json  → points=12500
                                          GET user:json  → points=12500
    改成 12501
                                          改成 12501
    SET user:json（12501）
                                          SET user:json（12501）   ← A 的更新被蓋掉了
```

> 📌 **這個模式叫「lost update」，它會在任何「讀出來、改、寫回去」的地方出現。**
> 而 JSON 存法**強迫**你每次都讀改寫——**它把一個原本可以是原子的操作，變成必然不是原子的。**
>
> **Hash 的 `HINCRBY` 為什麼對**：它是**一條命令**，Redis 單執行緒執行到底（00 章 0.3.4）。
> 這是 Redis 資料結構真正的價值——**不是「省空間」，是「把操作做成原子的」。**

⚠️ **如果你非用 JSON 不可**（例如欄位結構很動態），那你需要的是 05 章的 Lua 或 09 章的鎖。
**但先問一次：真的不能用 Hash 嗎？**

### 2.4.5 只想讀一個欄位

```
═══ 2.4.5 只想讀一個欄位 ═══
JSON  : GET 整包 175 bytes，在 Java 這一側解析後取出 level
Hash  : HGET 只傳回 "gold"（4 bytes）
Hash  : HMGET 一次取三個 -> [alice, gold, 12500]
```

**175 bytes vs 4 bytes。** 一個欄位差 44 倍，在 QPS 一萬的服務上就是頻寬與 CPU 的實際成本。

📌 **`HMGET` 是很多人不知道但該用的命令**：
需要三個欄位時，**不要 `HGETALL` 再自己挑**，也不要呼叫三次 `HGET`——
`HMGET` 是一次往返、只傳你要的。

### 2.4.6 ⚠️ `StringRedisTemplate` 的 hash 值只能是 String

上面的 `user()` 方法刻意回傳 `Map<String, String>`。如果照直覺寫成 `Map<String, Object>`
並放進一個 `Integer`：

```java
m.put("points", 12500);          // ← Integer
redis.opsForHash().putAll("user:hash", m);
```

```
java.lang.ClassCastException: class java.lang.Integer cannot be cast to class java.lang.String
    at org.springframework.data.redis.core.AbstractOperations.rawHashValue(AbstractOperations.java:186)
    at org.springframework.data.redis.core.DefaultHashOperations.putAll(DefaultHashOperations.java:161)
```

**原因**：`StringRedisTemplate` 的四個序列化器全是 `StringRedisSerializer`，
但 `opsForHash()` 的泛型是 `HashOperations<String, Object, Object>`——
**型別在編譯期過得去，在執行期才炸。**

> 📌 **這個錯誤要記住的是它的形狀，不是它本身**：
> **Spring Data Redis 的泛型與實際的序列化器是兩件事**，編譯器幫不了你。
> 06 章會把四個序列化器的位置講清楚，那一章之後你就知道為什麼是 `rawHashValue` 這一行爆掉。

### 2.4.7 Hash 該用在哪

| 適合 | 例子 |
|---|---|
| 多欄位的物件 | 使用者資料、商品資料、購物車（商品 id → 數量） |
| 需要對單一欄位做原子加減 | 庫存明細、計數的集合 |
| 一組相關的計數器 | `stats:20260916` 的 pv / uv / order 三個欄位 |
| 想省 key 數量 | 一千萬個小物件，用 Hash 比拆成 key 省很多（2.4.2） |

| **不適合** | 為什麼 |
|---|---|
| 欄位數會無限成長 | `HGETALL` 變成 0.19 秒的全服務暫停（2.10.1）；而且**整個 hash 只能有一個 TTL** |
| 需要按值排序或範圍查詢 | Hash 沒有順序。要排序用 ZSet |
| 每個欄位需要不同的過期時間 | Redis 7.2 做不到（7.4 才有欄位級 TTL）。用獨立的 key |

---

## 2.5 List：一條可以從兩頭進出的佇列

### 2.5.1 命令巡禮

```
127.0.0.1:6379> RPUSH feed a b c
(integer) 3
127.0.0.1:6379> LPUSH feed z
(integer) 4
127.0.0.1:6379> LRANGE feed 0 -1
1) "z"
2) "a"
3) "b"
4) "c"
127.0.0.1:6379> LLEN feed
(integer) 4
127.0.0.1:6379> LPOP feed
"z"
127.0.0.1:6379> RPOP feed
"c"
127.0.0.1:6379> LINDEX feed 0
"a"
127.0.0.1:6379> LTRIM feed 0 0
OK
127.0.0.1:6379> LRANGE feed 0 -1
1) "a"
```

| 命令 | 複雜度 | 備註 |
|---|---|---|
| `LPUSH` / `RPUSH` / `LPOP` / `RPOP` | **O(1)** | 兩頭進出都很快 |
| `LLEN` | O(1) | —— |
| `LRANGE key start stop` | O(S+N)，S = 起點偏移、N = 取幾個 | ⚠️ **`LRANGE key 0 -1` 就是 O(整條)** |
| `LINDEX` | O(N) | 但常數極小，見 2.5.3 |
| `LTRIM` | O(N)，N = 被移除的數量 | **唯一能讓 List 不無限成長的東西**（2.5.4） |
| `LREM` | O(N) | 按值刪除 |
| `BLPOP` / `BRPOP` | O(1) + 阻塞 | 沒東西時**掛在那裡等**，不用輪詢 |
| `LMOVE` / `BLMOVE` | O(1) | 從一條 list 原子地搬到另一條（取代舊的 `RPOPLPUSH`） |

⚠️ **`RPOPLPUSH` 在 Redis 6.2 之後被標為 deprecated**，改用 `LMOVE source dest LEFT RIGHT`
（`LMOVE` 可以指定兩端，`RPOPLPUSH` 只能右進左出）。

### 2.5.2 四種用法

同一個結構，看你從哪一頭進出：

| 用法 | 寫 | 讀 | 例子 |
|---|---|---|---|
| **佇列**（FIFO） | `LPUSH` | `RPOP` / `BRPOP` | 待處理的任務 |
| **堆疊**（LIFO） | `LPUSH` | `LPOP` | 「上一步」的復原紀錄 |
| **最近 N 筆** | `LPUSH` + **`LTRIM key 0 N-1`** | `LRANGE key 0 N-1` | 最近瀏覽、最新留言 |
| **阻塞佇列** | `LPUSH` | `BRPOP key 30` | 簡易的工作佇列（但先讀 2.5.5） |

「最近 10 筆瀏覽紀錄」是 List 最漂亮的用法，**兩條命令就做完**：

```
LPUSH  history:8842 product:1001
LTRIM  history:8842 0 9
```

第二條命令保證這條 list **永遠不會超過 10 筆**——
這是 List 跟 String 的 `APPEND` 最大的差別（2.3.4 提過 `APPEND` 沒有上限）。

### 2.5.3 實測：`LINDEX` 是 O(N)，但它比你想的快

100 萬個元素的 list，取三個位置：

```
LINDEX big 0       ->  4 µs
LINDEX big 500000  ->  6 µs        ← 正中間
LINDEX big 999999  ->  4 µs
```

**中間那個只慢了 2 微秒。** 為什麼 O(N) 的命令這麼快？

因為 quicklist 編碼**不是一個一個元素串起來的鏈結串列**，
而是「**一串節點，每個節點裡塞一個 8 KB 的 listpack**」。
走到第 50 萬個元素，只要跳過約 700 個節點，不是 50 萬次指標跳躍。

> 📌 **這是「看複雜度也要看常數」的好例子。**
> 但不要把結論反過來記成「List 的 O(N) 都沒關係」——
> **危險的是 `LRANGE key 0 -1`**：它要把 100 萬個元素**全部序列化送回客戶端**，
> 實測佔用主執行緒 **25,415 µs（25 毫秒）**（2.10.1）。
>
> **`LINDEX` 慢在「找」，`LRANGE 0 -1` 慢在「搬」。搬才是真正的成本。**

📌 **List 是五個結構裡最省記憶體的**：100 萬個元素只要 **11.4 MB**
（同樣 100 萬個成員，Set 要 46.1 MB、Hash 要 61.4 MB、ZSet 要 87.3 MB）。
因為 quicklist 把元素緊密地打包在 8 KB 的區塊裡，**沒有雜湊表、沒有每元素的指標**。

### 2.5.4 `LTRIM`：唯一能防止它長到爆的東西

**List 沒有容量上限。** 一個只 `LPUSH` 不 `LTRIM` 的 list，會一路長到把記憶體吃光。

```java
// ❌ 上線三個月後這條 list 有 400 萬筆
redis.opsForList().leftPush("history:" + userId, productId);

// ✅ 每次寫入後裁切
redis.opsForList().leftPush("history:" + userId, productId);
redis.opsForList().trim("history:" + userId, 0, 49);   // 只留最近 50 筆
```

⚠️ **這兩條命令中間有縫**（01 章 1.4.1 同一個教訓）。
併發寫入時 list 可能短暫超過 50 筆——這通常無所謂。
**真的需要原子的話，是 05 章的 Lua。**

### 2.5.5 ⚠️ 用 List 當訊息佇列的四個問題

`BRPOP` 看起來就是一個現成的工作佇列，**很多團隊真的這樣用**。先知道你放棄了什麼：

| 問題 | 說明 |
|---|---|
| **訊息一旦 pop 出來就不見了** | 消費者處理到一半掛掉，那則訊息**永遠消失**。（緩解：用 `LMOVE` 搬到「處理中」的 list，處理完再刪——但你得自己寫超時回收） |
| **沒有消費者群組** | 十台機器一起 `BRPOP`，每則訊息只有一台拿到（這通常是你要的），但**無法做「每台都收到一份」** |
| **沒有重試、沒有死信** | 全部要自己實作 |
| **沒有訊息保留** | 處理完就沒了，不能重讀、不能追溯 |

📌 **Redis 5.0 之後有 Stream 型別**（`XADD` / `XREADGROUP`），它補上了消費者群組、
訊息保留、ACK 機制。**但它不在這一站的範圍**——
如果你需要的是「可靠的訊息佇列」，那是一個獨立的主題，Redis 不是唯一選項也不是最好的選項。

**這一站對 List 的定位很明確**：
**它是「最近 N 筆」與「簡單任務緩衝」的結構，不是你的訊息中介軟體。**

---

## 2.6 Set：去重與集合運算

### 2.6.1 命令巡禮

```
127.0.0.1:6379> SADD tag:sale p1 p2 p3
(integer) 3
127.0.0.1:6379> SADD tag:sale p1
(integer) 0                          ← 已經有了，回 0（不是錯誤）
127.0.0.1:6379> SMEMBERS tag:sale
1) "p1"
2) "p2"
3) "p3"
127.0.0.1:6379> SISMEMBER tag:sale p2
(integer) 1
127.0.0.1:6379> SMISMEMBER tag:sale p2 p9
1) (integer) 1
2) (integer) 0
127.0.0.1:6379> SCARD tag:sale
(integer) 3
127.0.0.1:6379> SRANDMEMBER tag:sale 2
1) "p1"
2) "p2"
127.0.0.1:6379> SPOP tag:new
"p4"
127.0.0.1:6379> SREM tag:sale p1
(integer) 1
```

| 命令 | 複雜度 | 備註 |
|---|---|---|
| `SADD` / `SREM` / `SISMEMBER` | **O(1)** | **去重是免費的** |
| `SMISMEMBER` | O(N)，N = 你問的個數 | 一次問多個（Redis 6.2+），比迴圈 `SISMEMBER` 好 |
| `SCARD` | O(1) | 成員數 |
| **`SMEMBERS`** | **O(N)，N = 整個集合** | ⚠️ 等同 `SCAN` 的 `KEYS`——見 2.10 |
| `SSCAN` | 一批 O(1) | `SMEMBERS` 的安全版 |
| `SRANDMEMBER` / `SPOP` | O(N) | 隨機抽（抽獎、隨機推薦）。`SPOP` 會移除，`SRANDMEMBER` 不會 |
| `SINTER` / `SUNION` / `SDIFF` | O(N×M) / O(N) / O(N) | **集合運算，見 2.6.2** |
| `SINTERCARD` | O(N×M) | 只要交集的**數量**，不搬結果（Redis 7.0+） |

### 2.6.2 集合運算：Redis 幫你算，但要付錢

```
127.0.0.1:6379> SINTER tag:sale tag:new       ← 交集：兩邊都有
1) "p3"
127.0.0.1:6379> SUNION tag:sale tag:new       ← 聯集
1) "p1"
2) "p2"
3) "p3"
4) "p4"
127.0.0.1:6379> SDIFF tag:sale tag:new        ← 差集：在左邊、不在右邊
1) "p1"
2) "p2"
```

這三條命令能直接回答「**同時在特價又是新品的商品**」「**追蹤 A 但沒追蹤 B 的人**」——
在資料庫裡這是 JOIN，在 Redis 裡是一條命令。

**但它是在 Redis 的主執行緒上算的。** 兩個各 50 萬成員的集合（交集 25 萬）：

| 命令 | 第 1 次 | 第 2 次 |
|---|---|---|
| `SINTER` | **44.5 ms** | 45.8 ms |
| `SUNION` | **143.0 ms** | 125.3 ms |
| `SDIFF` | **71.3 ms** | 72.2 ms |
| `SINTERCARD`（只要數量） | **35.9 ms** | 38.6 ms |

> ⚠️ **一條 `SUNION` = 全服務暫停 0.13 秒。**
> 這跟 00 章 0.3.1 的 `KEYS` 是同一類事故，只是它長得比較像「正常的業務查詢」。

**三個實務建議**：

| | |
|---|---|
| 只需要數量時用 `SINTERCARD` | 省掉「把 25 萬個成員序列化送回來」的成本 |
| 需要把結果存起來時用 `SINTERSTORE` / `SUNIONSTORE` | 結果留在 Redis，不經過網路。但**計算成本一樣付** |
| 集合很大時**不要即時算** | 改成離線算好、存成一個新的 key |

### 2.6.3 三種編碼

Set 是唯一有**三種**編碼的結構：

```
  100 個純數字成員   ENCODING=intset     MEMORY USAGE=272
  600 個純數字成員   ENCODING=hashtable  MEMORY USAGE=27496
  100 個字串成員     ENCODING=listpack   MEMORY USAGE=944
  200 個字串成員     ENCODING=hashtable  MEMORY USAGE=8872
```

| 編碼 | 條件 | 特性 |
|---|---|---|
| `intset` | **全部是整數** 且數量 ≤ `set-max-intset-entries`（512） | 一個**排序過的整數陣列**，極省空間（100 個成員只要 272 bytes） |
| `listpack` | 有非整數成員，且數量 ≤ 128 且每個 ≤ 64 bytes | 連續記憶體 |
| `hashtable` | 超過上面任一條件 | 真正的雜湊表 |

**看那個 272 對 27496**：100 個整數成員 2.7 bytes/個，600 個整數成員 45.8 bytes/個——
**跨過 512 的門檻，每個成員貴了 17 倍。**

📌 **所以「成員用整數 id 還是字串 id」不只是風格問題**：
`SADD followers:8842 12345` 可以走 `intset`，
`SADD followers:8842 user:12345` 只能走 `listpack` 或 `hashtable`。
**小集合大量存在的時候（例如每個使用者一個），這個差距是實打實的記憶體。**

### 2.6.4 Set 該用在哪

| 適合 | 例子 |
|---|---|
| 去重 | 今天有哪些使用者登入過 |
| 「有沒有在裡面」 | 黑名單、白名單、已讀標記 |
| 標籤與集合運算 | 商品標籤、共同好友 |
| 隨機抽取 | 抽獎（`SPOP` 直接移除中獎者） |

| **不適合** | 為什麼 | 該用 |
|---|---|---|
| 需要排序或排名 | Set 無序 | ZSet |
| 成員數量很大又只需要「有幾個」 | 46.1 MB vs 14.1 KB | HyperLogLog（2.9.3） |
| 成員是連續的整數 id 而且只需要「有沒有」 | 15.2 MB vs 0.06 MB | Bitmap（2.9.1） |

---

## 2.7 Sorted Set：多一個分數，多一個世界

### 2.7.1 命令巡禮

ZSet = Set + 每個成員帶一個**分數**（score），而且**永遠按分數排好**。

```
127.0.0.1:6379> ZADD rank 100 alice 250 bob 175 carol
(integer) 3
127.0.0.1:6379> ZSCORE rank bob
"250"
127.0.0.1:6379> ZINCRBY rank 50 alice
"150"
127.0.0.1:6379> ZRANGE rank 0 -1
1) "alice"                        ← 150
2) "carol"                        ← 175
3) "bob"                          ← 250
127.0.0.1:6379> ZRANGE rank 0 -1 WITHSCORES
1) "alice"
2) "150"
3) "carol"
4) "175"
5) "bob"
6) "250"
127.0.0.1:6379> ZREVRANGE rank 0 2 WITHSCORES      ← 由高到低（排行榜）
1) "bob"
2) "250"
3) "carol"
4) "175"
5) "alice"
6) "150"
127.0.0.1:6379> ZRANK rank alice                   ← 名次（從 0 開始，由低到高）
(integer) 0
127.0.0.1:6379> ZREVRANK rank bob                  ← 由高到低的名次
(integer) 0
127.0.0.1:6379> ZCOUNT rank 150 300                ← 分數在區間內的數量
(integer) 3
127.0.0.1:6379> ZRANGEBYSCORE rank 150 300
1) "alice"
2) "carol"
3) "bob"
127.0.0.1:6379> ZRANGEBYSCORE rank (150 +inf       ← ( = 不含；+inf / -inf 可用
1) "carol"
2) "bob"
127.0.0.1:6379> ZREMRANGEBYRANK rank 0 0           ← 砍掉名次最低的
(integer) 1
```

| 命令 | 複雜度 | 備註 |
|---|---|---|
| `ZADD` / `ZINCRBY` | **O(log N)** | 插入／改分數並維持排序 |
| `ZSCORE` / `ZCARD` | O(1) | —— |
| `ZRANK` / `ZREVRANK` | **O(log N)** | **這是 ZSet 獨有的**：直接問名次 |
| `ZRANGE` / `ZREVRANGE` | O(log N + M)，M = 取幾個 | **取前 10 名很便宜**，取全部很貴 |
| `ZRANGEBYSCORE` / `ZCOUNT` | O(log N + M) | 範圍查詢 |
| `ZREM` / `ZREMRANGEBYRANK` / `ZREMRANGEBYSCORE` | O(log N + M) | **`ZREMRANGEBYRANK` 是排行榜的 `LTRIM`** |
| `ZPOPMIN` / `ZPOPMAX` / `BZPOPMIN` | O(log N) | 取出並移除最小／最大（延遲佇列用得到） |

### 2.7.2 ⚠️ 分數是 `double`，超過 2^53 就失真

這是 ZSet 最容易踩、而且**踩了不會報錯**的一個坑：

```
127.0.0.1:6379> ZADD z 9007199254740992 a        ← 2^53
127.0.0.1:6379> ZSCORE z a
"9007199254740992"                                ← 正確

127.0.0.1:6379> ZADD z 9007199254740993 b        ← 2^53 + 1
127.0.0.1:6379> ZSCORE z b
"9007199254740992"                                ← ⚠️ 存進去的跟拿出來的不一樣

127.0.0.1:6379> ZADD z 1789543000123456789 c     ← 奈秒時間戳
127.0.0.1:6379> ZSCORE z c
"1789543000123456768"                             ← ⚠️ 尾巴 21 被改掉了
```

**分數的型別是 IEEE 754 雙精度浮點數**，它能精確表示的整數上限是 **2^53 = 9,007,199,254,740,992**。
超過之後，相鄰的整數會被映射到同一個浮點值。

**這在實務上的形狀**：

| 當分數用 | 位數 | 安全嗎 |
|---|---|---|
| 秒級時間戳（`1789543000`） | 10 位 | ✅ |
| **毫秒時間戳**（`1789543000123`） | 13 位 | ✅ **最常用，安全** |
| 微秒時間戳（`1789543000123456`） | 16 位 | ✅ 還在 2^53 內（約 9×10^15），但已經接近 |
| **奈秒時間戳**（`1789543000123456789`） | 19 位 | ❌ **會失真** |
| 雪花演算法產生的 id（Snowflake，64 bit） | 19 位 | ❌ **會失真** |

> ⚠️ **「用 id 當分數」是一個常見的錯誤設計。**
> Snowflake id 是 64 位元整數，放進 ZSet 的分數會被截斷——
> **兩個不同的 id 會變成同一個分數，排序結果錯亂，而且沒有任何錯誤訊息。**
>
> **規則：分數只放「可以是小數的量」（金額、權重、毫秒時間戳），不要放識別碼。**

### 2.7.3 實測：`O(log N)` 到底在什麼規模才有感覺

「O(log N) 很快」是口號。**量給你看。**

方法：用一段 Lua 腳本在 Redis 內部跑 10 萬次 `ZSCORE`，
再從 `SLOWLOG` 讀這條 `EVAL` 佔用主執行緒的總時間——**這樣量到的是純伺服器成本，完全排除網路往返**。

```bash
docker exec redis-lab redis-cli CONFIG SET slowlog-log-slower-than 50000
docker exec redis-lab redis-cli SLOWLOG RESET
docker exec redis-lab redis-cli EVAL \
  "for i=1,100000 do redis.call('ZSCORE', KEYS[1], 'm'..((i % tonumber(ARGV[1])) + 1)) end return 1" \
  1 z 1000000
docker exec redis-lab redis-cli SLOWLOG GET 1
```

| ZSet 的成員數 | 10 萬次 `ZSCORE` | 換算單次 | 10 萬次 `ZRANK` |
|---|---|---|---|
| 1,000 | 97.7 ms | **0.98 µs** | 95.4 ms |
| 10,000 | 113.0 ms | 1.13 µs | 113.7 ms |
| 100,000 | 116.5 ms | 1.17 µs | 120.4 ms |
| 1,000,000 | 135.5 ms | 1.35 µs | 137.7 ms |
| **5,000,000** | **158.4 ms** | **1.58 µs** | 163.2 ms |

📌 **對照組**：同樣的 Lua 迴圈跑 10 萬次 `GET`（一個不存在的 key，O(1)）要 **51.0 ms**——
**那 51 ms 是 Lua 迴圈自己的成本**，不是 Redis 查詢的成本。
扣掉之後：1000 個成員時每次約 0.47 µs，500 萬個成員時每次約 1.07 µs。

> **資料量變成 5000 倍，單次查詢慢了 1.6 倍。**
>
> 這就是 `O(log N)`：log₂(1000) ≈ 10，log₂(5000000) ≈ 22，**只差兩倍多**。
>
> 📌 **結論是：不要為了「怕 ZSet 太大而變慢」去拆分排行榜。**
> ZSet 真正會讓你出事的不是 `ZSCORE` / `ZRANK` / `ZADD`，
> 而是 **`ZRANGE key 0 -1`**（把整份搬回來，2.10.1 實測 21,830 µs）
> 與**記憶體**（100 萬成員要 87.3 MB，是五個結構裡最貴的）。

### 2.7.4 `ZADD` 的修飾詞

跟 01 章 1.4.6 的 `EXPIRE` 一樣，`ZADD` 也有條件參數：

```
127.0.0.1:6379> ZADD rank GT CH 100 bob       ← bob 目前 250
(integer) 0                                     ← 100 < 250，GT 不讓它降下來
127.0.0.1:6379> ZSCORE rank bob
"250"
127.0.0.1:6379> ZADD rank GT CH 999 bob
(integer) 1                                     ← 999 > 250，更新
127.0.0.1:6379> ZSCORE rank bob
"999"
```

| 參數 | 意思 | 用途 |
|---|---|---|
| `NX` | 只在成員不存在時加 | 「第一次進榜的分數」 |
| `XX` | 只在成員已存在時更新 | 不要憑空建立成員 |
| **`GT` / `LT`** | 只在新分數**大於／小於**現有分數時更新 | **「歷史最高分」「最早的時間戳」——不用讀回來比較** |
| `CH` | 讓回傳值變成「**改變了幾個**」而不是「新增了幾個」 | 想知道到底有沒有生效時必加 |
| `INCR` | 把分數當成增量（等同 `ZINCRBY`） | —— |

> 📌 **`GT` 消滅了一整類的讀改寫**：
> 「只有比目前紀錄高才更新最高分」——沒有 `GT` 的話是 `ZSCORE` → 比較 → `ZADD`（三步，會掉更新）。
> 有了 `GT` 就是一條原子命令。**這是 2.4.4 那個教訓的另一個實例。**

### 2.7.5 三種典型用法

**① 排行榜**

```
ZINCRBY  rank:20260916 1 product:1001        # 賣出一件
ZREVRANGE rank:20260916 0 9 WITHSCORES       # 前 10 名
ZREVRANK  rank:20260916 product:1001         # 這個商品第幾名
ZREMRANGEBYRANK rank:20260916 0 -1001        # 只留前 1000 名（排行榜的 LTRIM）
```

**② 範圍查詢（分數 = 時間）**

```
ZADD  orders:pending 1789543000123 order:A   # 分數是毫秒時間戳
ZRANGEBYSCORE orders:pending -inf 1789543060000   # 撈出「這個時間點之前」的
```

**③ 延遲佇列**

```
ZADD  delay:queue <執行時間的毫秒時間戳> <任務id>
# 消費者每秒撈一次「已經到時間的」
ZRANGEBYSCORE delay:queue -inf <現在> LIMIT 0 10
```

⚠️ **③ 的「撈出來然後刪掉」中間有縫**——兩台消費者會拿到同一個任務。
正解是 05 章的 Lua（一條腳本裡撈 + 刪）或 `ZPOPMIN`。
**而且 01 章 1.6.4 已經說過：不要用過期事件做這件事。**

---

## 2.8 編碼：Redis 對「小東西」的一整套省法

前面每個結構都提到 `listpack`、`intset`、`skiplist`。現在把它講完。

### 2.8.1 同一個結構，兩套完全不同的實作

Redis 對每個結構都準備了**兩套（Set 是三套）實作**：

| 結構 | 小的時候 | 大的時候 |
|---|---|---|
| Hash | `listpack` | `hashtable` |
| List | `listpack` | `quicklist` |
| Set | `intset` / `listpack` | `hashtable` |
| ZSet | `listpack` | `skiplist` |

**`listpack` 是什麼**：一塊**連續的記憶體**，元素一個接一個排好。
沒有指標、沒有雜湊桶、沒有每元素的物件標頭。
查一個元素要**從頭走過去**（O(N)），但 N 很小的時候這比雜湊快，而且省非常多空間。

**跨過門檻就換成真正的資料結構**：雜湊表 O(1)、跳表 O(log N)，
但每個元素都要付指標與標頭的成本。

### 2.8.2 實測：門檻兩側

**Hash（門檻：512 個欄位）**：

```
     1 個欄位  ENCODING=listpack   MEMORY USAGE=64       每欄位 64.0 bytes
    64 個欄位  ENCODING=listpack   MEMORY USAGE=688      每欄位 10.8 bytes
   128 個欄位  ENCODING=listpack   MEMORY USAGE=1,584    每欄位 12.4 bytes
   256 個欄位  ENCODING=listpack   MEMORY USAGE=3,120    每欄位 12.2 bytes
   511 個欄位  ENCODING=listpack   MEMORY USAGE=6,192    每欄位 12.1 bytes
   512 個欄位  ENCODING=listpack   MEMORY USAGE=6,192    每欄位 12.1 bytes
   513 個欄位  ENCODING=hashtable  MEMORY USAGE=28,816   每欄位 56.2 bytes
  1000 個欄位  ENCODING=hashtable  MEMORY USAGE=48,296   每欄位 48.3 bytes
```

> **從 512 個欄位變成 513 個欄位——多一個欄位，記憶體從 6,192 變成 28,816 bytes（4.65 倍）。**

**ZSet（門檻：128 個成員）差距更誇張**：

```
  127 個成員  ENCODING=listpack   MEMORY USAGE=1,072    每成員 8.4 bytes
  128 個成員  ENCODING=listpack   MEMORY USAGE=1,072    每成員 8.4 bytes
  129 個成員  ENCODING=skiplist   MEMORY USAGE=12,540   每成員 97.2 bytes
```

> **多一個成員，每成員的成本從 8.4 bytes 變成 97.2 bytes——11.6 倍。**

**單一「值」太長也會跨過去**（不只看數量）：

```
  hash 裡一個 64 bytes 的值   ENCODING=listpack   MEMORY USAGE=128
  hash 裡一個 65 bytes 的值   ENCODING=hashtable  MEMORY USAGE=248
```

**List 的門檻是「大小」不是「個數」**（`list-max-listpack-size` 預設 `-2` = 每節點 8 KB）：

```
  500 個元素（每個 11 bytes）ENCODING=listpack   MEMORY USAGE=7,216
  560 個元素                 ENCODING=listpack   MEMORY USAGE=8,240
  600 個元素                 ENCODING=listpack   MEMORY USAGE=8,240
  640 個元素                 ENCODING=quicklist  MEMORY USAGE=8,520
  1 個 9,000 bytes 的元素     ENCODING=quicklist  ← 單一元素就超過 8 KB
```

### 2.8.3 ⚠️ 編碼轉換是**單向的**

這是本節最重要、也最反直覺的一點：

```
  600 個欄位          ENCODING=hashtable  MEMORY USAGE=32,296
  （刪到只剩 1 個欄位）
  刪到只剩 1 個欄位   ENCODING=hashtable  MEMORY USAGE=1,200   HLEN=1
```

**一個只有 1 個欄位的 hash，佔了 1,200 bytes。**
同樣 1 個欄位、從來沒超過門檻的 hash 只要 **64 bytes**（2.8.2 表格的第一行）。

**19 倍的浪費，而且永遠不會自己好。**

> 📌 **為什麼 Redis 不轉回去**：因為「剛好在門檻附近震盪」的 key 會不停地來回轉換，
> 每次轉換都是一次完整的重建。**Redis 選擇了「絕不回頭」這個簡單而可預測的策略。**
>
> **實務後果**：一個曾經很大、後來被清空的集合，**它的記憶體成本停留在「曾經很大」那個等級**。
> 要拿回來只有一個辦法：**把 key 刪掉重建。**

⚠️ **這件事跟 01 章 1.6 的過期合在一起會很有趣**：
一個 hash 裡的欄位被一個一個 `HDEL` 掉，直到剩下幾個——
**`MEMORY USAGE` 不會回到小 hash 的水準，而 `DBSIZE` 也還算它一個 key。**
14 章的維運檢查會教你怎麼找出這種 key。

### 2.8.4 四個門檻設定

```bash
docker exec redis-lab redis-cli CONFIG GET 'hash-max-listpack-*'
docker exec redis-lab redis-cli CONFIG GET 'list-max-listpack-size'
docker exec redis-lab redis-cli CONFIG GET 'set-max-intset-entries'
docker exec redis-lab redis-cli CONFIG GET 'set-max-listpack-*'
docker exec redis-lab redis-cli CONFIG GET 'zset-max-listpack-*'
```

| 設定 | 預設值（Redis 7.2） | 意思 |
|---|---|---|
| `hash-max-listpack-entries` | **512** | hash 超過幾個欄位就轉 `hashtable` |
| `hash-max-listpack-value` | **64** | hash 裡任一個值超過幾 bytes 就轉 |
| `list-max-listpack-size` | **-2** | 負數 = 按大小：`-2` 表示每個節點 8 KB |
| `set-max-intset-entries` | **512** | 純整數 set 超過幾個就離開 `intset` |
| `set-max-listpack-entries` | **128** | 非整數 set 超過幾個就轉 `hashtable` |
| `set-max-listpack-value` | **64** | set 裡任一個成員超過幾 bytes 就轉 |
| `zset-max-listpack-entries` | **128** | zset 超過幾個成員就轉 `skiplist` |
| `zset-max-listpack-value` | **64** | zset 裡任一個成員超過幾 bytes 就轉 |

⚠️ **注意 `hash-max-listpack-entries` 是 512，而 `zset` / `set` 是 128。**
很多網路文章寫「都是 128」——**那是舊版本（ziplist 時代）的值。以你自己機器上 `CONFIG GET` 的結果為準。**

### 2.8.5 該不該把門檻調高

「既然 listpack 這麼省，把 `zset-max-listpack-entries` 調成 5000 不就好了？」

**不要，除非你量過。** 因為 listpack 的查詢是 **O(N) 的線性掃描**：

| | 128 個成員 | 5000 個成員 |
|---|---|---|
| listpack 的查詢成本 | 掃 128 個，很快 | **掃 5000 個，每一次查詢** |
| listpack 的插入成本 | 可能要 memmove 整塊 | **memmove 一塊更大的記憶體** |

**Redis 挑這些預設值是有理由的**：它們大約落在「線性掃描還比雜湊快」的臨界點。

📌 **什麼時候值得調**：
你有**幾百萬個小 hash**（例如每個使用者一個），每個剛好 600 個欄位——
那把 `hash-max-listpack-entries` 調到 1024 可以省下大量記憶體，**而且每次只掃 600 個仍然很快**。
**調之前先用 `MEMORY USAGE` 量、調之後用 `SLOWLOG` 驗。**

---

## 2.9 Bitmap 與 HyperLogLog：兩個不是型別的型別

2.2.1 提過：Bitmap 與 HyperLogLog **都是 String**，
只是用不同的命令去解讀同一串位元組。它們解決的是同一類問題的兩端。

### 2.9.1 Bitmap：242 倍

需求：「**今天有哪些使用者簽到了**」。使用者 id 是 1～300000 的連續整數，全部簽到。

⚠️ **「id 連續」是這個實驗的前提，不是細節。** 下一節（2.9.2）會說明 id 一旦不連續，
Bitmap 會從「最省的」變成「最貴的」。

```bash
# ① Set：把簽到的 id 全部存起來
SADD signin:set:20260916 1
SADD signin:set:20260916 2
...

# ② Bitmap：第 N 個位元代表第 N 個使用者
SETBIT signin:bit:20260916 1 1
SETBIT signin:bit:20260916 2 1
...
```

| 存法 | 記憶體 | 能回答「總共幾人」 | 能回答「12345 有沒有簽到」 |
|---|---|---|---|
| ① Set（30 萬個整數 id） | **15.2 MB** | `SCARD` ✅ | `SISMEMBER` ✅ |
| ② **Bitmap** | **0.06 MB**（65,584 bytes） | `BITCOUNT` ✅ | `GETBIT` ✅ |
| ③ HyperLogLog | **0.014 MB**（14,384 bytes） | `PFCOUNT`（近似）✅ | ❌ **做不到** |

**Set 對 Bitmap 是 242 倍。**

> 📌 **這三個數字是 `MEMORY USAGE` 量的**（跟 2.10.1 同一把尺）。
> ⚠️ **換一把尺會得到不一樣的數字**：`MEMORY USAGE` 是按內部結構推算的，
> 對大型 `hashtable`（那個 Set）**會高估**——
> 同一份資料用「寫入前後 `INFO memory` 的 `used_memory` 差值」量，只有 **9.7 MB**。
> Bitmap 與 HLL 兩種量法幾乎一樣（都是一整塊連續的位元組）。
> **比較記憶體時，兩種量法不要混著用。**

```
127.0.0.1:6379> BITCOUNT signin:bit:20260916
(integer) 300000
127.0.0.1:6379> GETBIT signin:bit:20260916 12345
(integer) 1
127.0.0.1:6379> STRLEN signin:bit:20260916
(integer) 37501                              ← 30 萬個 bit ≈ 37 KB
```

**`BITOP` 讓「連續簽到」這種需求變成一條命令**：

```
127.0.0.1:6379> BITOP AND both day1 day2      ← 兩天都簽到的
(integer) 2
127.0.0.1:6379> BITCOUNT both
(integer) 1
127.0.0.1:6379> BITOP OR either day1 day2     ← 任一天簽到的
(integer) 2
127.0.0.1:6379> BITCOUNT either
(integer) 3
```

「連續簽到 7 天送優惠券」= `BITOP AND` 七個 key，再 `BITCOUNT`。
**七天的資料各佔 37 KB，運算在 Redis 裡一次做完。**

### 2.9.2 ⚠️ Bitmap 的稀疏陷阱

Bitmap 省空間的前提是「**位元的位置是密集的小整數**」。如果不是：

```
127.0.0.1:6379> DEL sparse
127.0.0.1:6379> SETBIT sparse 100000000 1     ← 只設「第 1 億個位元」這一個
(integer) 0
127.0.0.1:6379> STRLEN sparse
(integer) 12500001                             ← 12.5 MB
127.0.0.1:6379> MEMORY USAGE sparse
(integer) 12582960
```

**設一個 bit，配置了 12.5 MB。** 因為 String 是連續的位元組，
要有第 1 億個位元，前面 9999 萬 9999 個位元也得存在。

> ⚠️ **所以「用使用者 id 當 bit 位置」只有在 id 是連續小整數時才成立。**
> 如果你的 id 是 Snowflake（19 位）、UUID、或 `user_20260916_xxx` 這種字串——**Bitmap 完全不能用。**
>
> **判斷準則**：`最大 id / 8` bytes 就是這個 Bitmap 的大小，跟你實際設了幾個 bit 無關。

### 2.9.3 HyperLogLog：1104 倍，代價是它只會數數

```
127.0.0.1:6379> PFADD signin:hll:20260916 u1 u2 u3 ...
127.0.0.1:6379> PFCOUNT signin:hll:20260916
(integer) 297723                               ← 真實是 300000，誤差 0.76%
```

| | Set | HyperLogLog |
|---|---|---|
| 30 萬個成員的記憶體 | 15.2 MB | **0.014 MB（14,384 bytes）** |
| 100 萬個成員的記憶體 | 46.1 MB | **14,392 bytes（14.1 KB）** |
| 誤差 | 精確 | **標準誤差 0.81%** |
| 「有幾個不重複的」 | ✅ | ✅（近似） |
| 「X 在不在裡面」 | ✅ | ❌ |
| 「列出所有成員」 | ✅ | ❌ |
| 合併多天的資料 | `SUNION`（貴） | **`PFMERGE`（固定 12 KB 的成本）** |

**HyperLogLog 的大小是固定的**——不管你放 100 個還是 1 億個成員，它永遠是約 12 KB。
它用的是機率演算法：**它根本不記得成員是誰，只記得「雜湊值的分佈長什麼樣」。**

> 📌 **`PFMERGE` 是 HLL 真正的殺手鐧**：
> 「這個月的不重複訪客」= `PFMERGE` 30 個每日 HLL。
> 用 Set 做同一件事是 `SUNION` 30 個大集合（2.6.2 實測：兩個 50 萬的集合就要 143 ms）。

### 2.9.4 三者怎麼選

```
需要知道「X 在不在裡面」嗎？
├─ 是 → id 是連續的小整數嗎？
│       ├─ 是 → Bitmap（省 242 倍）
│       └─ 否 → Set
└─ 否，只需要「有幾個不重複的」
        → 可以接受 0.81% 誤差嗎？
          ├─ 可以 → HyperLogLog（省 1000 倍以上）
          └─ 不行 → Set
```

⚠️ **「可以接受 0.81% 誤差嗎」要問對人。**
「今天有 297,723 個不重複訪客」給營運看沒問題；
**「這個月有 297,723 個人達成滿額，每人送 100 元」——那 2,277 個人的差額要有人負責。**

---

## 2.10 一個 key 塞太多東西：big key

### 2.10.1 實測：100 萬個元素的「整包讀取」

四個結構各塞 100 萬個元素，然後各下一條「把整包拿回來」的命令：

| key | 記憶體 | 整包讀取的命令 | **佔用主執行緒** |
|---|---|---|---|
| hash（100 萬欄位） | 61.4 MB | `HGETALL` | **199,542 µs（0.20 秒）** |
| set（100 萬成員） | 46.1 MB | `SMEMBERS` | 50,978 µs（51 ms） |
| list（100 萬元素） | **11.4 MB** | `LRANGE 0 -1` | 25,415 µs（25 ms） |
| zset（100 萬成員） | **87.3 MB** | `ZRANGE 0 -1` | 21,830 µs（22 ms） |

**同一段時間其他客戶端的最大延遲：191 ms。**

兩個觀察：

- **記憶體最省的是 List（11.4 MB），最貴的是 ZSet（87.3 MB）**——差 7.6 倍。
  ZSet 貴在它要同時維護跳表與雜湊表兩份索引。
- **`HGETALL` 特別慢**，因為它要傳回 100 萬個欄位**加** 100 萬個值，是其他命令的兩倍資料量。

### 2.10.2 Java 這一側：`entries()` 把 269 MB 搬進 heap

Redis 那一側的 0.2 秒只是故事的一半。**另一半在你的 JVM 裡**：

```java
@Test
void entriesPullsEverything() {
    System.out.println("═══ 2.10.2 entries() 把整包搬進 JVM ═══");
    // ... bighash 有 1,000,000 個欄位

    Runtime rt = Runtime.getRuntime();
    System.gc();
    long heapBefore = rt.totalMemory() - rt.freeMemory();
    long t = System.currentTimeMillis();
    Map<Object, Object> all = redis.opsForHash().entries("bighash");   // ❌
    long ms = System.currentTimeMillis() - t;
    long heapAfter = rt.totalMemory() - rt.freeMemory();
    System.out.printf("entries()     : 拿回 %,d 筆，花了 %,d ms，JVM heap 多了 %,d MB%n",
            all.size(), ms, (heapAfter - heapBefore) / 1048576);
    all = null;

    t = System.currentTimeMillis();
    int counted = 0;
    try (Cursor<Map.Entry<Object, Object>> c =
                 redis.opsForHash().scan("bighash", ScanOptions.scanOptions().count(1000).build())) {
        while (c.hasNext()) { c.next(); counted++; }          // ✅ 一批一批來
    }
    System.out.printf("hscan(1000)   : 走過 %,d 筆，花了 %,d ms，JVM 這一側一次只留一批%n",
            counted, System.currentTimeMillis() - t);

    System.out.printf("只要一個欄位  : hget = %s%n", redis.opsForHash().get("bighash", "f500000"));
    probe.slowlog(3);
}
```

```
═══ 2.10.2 entries() 把整包搬進 JVM ═══
bighash 有 1,000,000 個欄位
entries()     : 拿回 1,000,000 筆，花了 681 ms，JVM heap 多了 269 MB
hscan(1000)   : 走過 1,000,000 筆，花了 1,205 ms，JVM 這一側一次只留一批
只要一個欄位  : hget = value500000
SLOWLOG（最近 3 筆）
     190,782 µs  HGETALL bighash
```

**一行 `entries()` 做了三件壞事**：

| | 代價 |
|---|---|
| Redis 主執行緒 | **190,782 µs**——這 0.19 秒整台 Redis 不服務任何人 |
| 網路 | 把 100 萬組 key-value 全部傳過來 |
| **你的 JVM** | **heap 多了 269 MB**。幾個併發請求同時這樣做就是 OOM |

> 📌 **這跟 01 章 1.5.6 的 `keys()` vs `scan()` 是同一個形狀**：
> `hscan` 總共花了 1,205 ms，**比 `entries()` 的 681 ms 慢了快一倍**——
> 但它從來不佔用主執行緒超過幾十微秒，JVM 這一側也只留一批。
>
> **在 Redis 上，「我多快做完」不是重點，「我佔用主執行緒多久」才是。**

### 2.10.3 怎麼拆 big key

| 情況 | 做法 |
|---|---|
| 一個 hash 存所有使用者 | 拆成 `user:{id}` 一人一個 hash |
| 一個 set 存所有商品 id | 按類別／日期分片：`products:cat:3`、`products:20260916` |
| 一個排行榜有幾百萬人 | **不用拆**（2.7.3 證明 `O(log N)` 撐得住），但**永遠不要 `ZRANGE 0 -1`**，只取前 N 名 |
| 一條 list 一直長 | `LTRIM`（2.5.4） |
| 就是需要整包讀 | 用 `HSCAN` / `SSCAN` / `ZSCAN` 分批，或改用 `LRANGE key 0 999` 這種分頁 |

**判斷 big key 的粗略準則**（14 章會給完整的檢查腳本）：

- 單個 key 超過 **10 KB**（String）或 **5,000 個元素**（集合類）→ 留意。
- 單個 key 超過 **1 MB** 或 **100,000 個元素** → **必須處理**。

---

## 2.11 選型決策表

**從需求出發**（這張表是本章的索引）：

| 需求 | 結構 | 關鍵命令 | 為什麼不是別的 |
|---|---|---|---|
| 快取一個查詢結果 | **String** | `SET k v EX` | 不需要單欄位操作 |
| 計數（PV、限流） | **String** | `INCR` | 原子且 `int` 編碼最省 |
| 分散式鎖 | **String** | `SET NX PX` | 09 章 |
| 多欄位物件（使用者、購物車） | **Hash** | `HSET` / `HMGET` / `HINCRBY` | JSON 會掉更新（2.4.4） |
| 一組相關計數器 | **Hash** | `HINCRBY` | 共用一個 key、一個 TTL |
| 最近 N 筆 | **List** | `LPUSH` + `LTRIM` | 有裁切，不會無限長 |
| 簡單任務緩衝 | **List** | `LPUSH` / `BRPOP` | 但先讀 2.5.5 的四個限制 |
| 去重、標籤、黑名單 | **Set** | `SADD` / `SISMEMBER` | 去重是 O(1) |
| 共同好友、標籤交集 | **Set** | `SINTER` / `SINTERCARD` | 但 2.6.2 的成本要算 |
| 排行榜、名次 | **ZSet** | `ZINCRBY` / `ZREVRANGE` / `ZREVRANK` | **只有 ZSet 能問「第幾名」** |
| 按時間範圍撈 | **ZSet** | `ZRANGEBYSCORE` | 分數用**毫秒**時間戳（2.7.2） |
| 延遲佇列 | **ZSet** | `ZADD` / `ZPOPMIN` | 撈+刪要原子（05 章） |
| 簽到、活躍標記（連續 id） | **Bitmap** | `SETBIT` / `BITCOUNT` / `BITOP` | 省 242 倍，但注意稀疏陷阱 |
| 不重複計數（可容忍誤差） | **HyperLogLog** | `PFADD` / `PFCOUNT` / `PFMERGE` | 省 1000 倍以上，代價 0.81% |

**從「會不會出事」出發**——每個結構的那一條危險命令：

| 結構 | ⚠️ 不要在正式環境對大 key 用 | 改用 |
|---|---|---|
| String | `APPEND` 到無限長 | List + `LTRIM` |
| Hash | **`HGETALL` / `HKEYS` / `HVALS`** | `HMGET`（要特定欄位）／ `HSCAN`（要全部） |
| List | **`LRANGE key 0 -1`** | `LRANGE key 0 99` 分頁 |
| Set | **`SMEMBERS`**、`SUNION` | `SSCAN` / `SISMEMBER` / `SINTERCARD` |
| ZSet | **`ZRANGE key 0 -1`** | `ZRANGE key 0 9`（只取前 N） |
| 全部 | `KEYS`（01 章）、`DEL` 大 key（01 章 1.3.2） | `SCAN`、`UNLINK` |

---

## 2.12 落地：shop-service 的結構選擇

把 01 章 1.7.4 那張規約表補上「用哪個結構」：

| 資料 | 結構 | key | TTL | 為什麼是這個結構 |
|---|---|---|---|---|
| 商品快取 | String（JSON） | `shop:cache:product:{id}` | 10 分 + 抖動 | 整包讀寫、不需要改單一欄位 |
| 購物車 | **Hash** | `shop:cart:{userId}` | 30 天 | 商品 id → 數量，`HINCRBY` 加減數量；改欄位不動 TTL（01 章 1.7.3） |
| 使用者側寫 | **Hash** | `shop:user:{userId}` | 1 天 | 多欄位、要單欄位讀寫 |
| 最近瀏覽 | **List** | `shop:history:{userId}` | 30 天 | `LPUSH` + `LTRIM 0 49` |
| 商品標籤 | **Set** | `shop:tag:{tagId}` | 無 | 要做交集 |
| 熱銷排行 | **ZSet** | `shop:rank:{yyyyMMdd}` | 7 天 | `ZINCRBY` + `ZREVRANGE`，要名次 |
| 每日簽到 | **Bitmap** | `shop:signin:{yyyyMMdd}` | 90 天 | 使用者 id 是連續自增整數 |
| 每日 UV | **HyperLogLog** | `shop:uv:{yyyyMMdd}` | 90 天 | 只要數量，可容忍誤差 |
| 限流計數 | String | `shop:rate:{dim}:{窗口}` | 窗口 + 10 秒 | 10 章 |
| 分散式鎖 | String | `shop:lock:{resource}` | 依業務 | 09 章 |

**三條補充規約**（接續 01 章 1.7.4 的三條）：

4. **禁止對可能長大的 key 使用 `HGETALL` / `SMEMBERS` / `LRANGE 0 -1` / `ZRANGE 0 -1`。**
   Code review 看到這四個命令就要問「這個 key 最大會多大」。
5. **ZSet 的分數只放毫秒時間戳或可量化的數值，絕不放識別碼**（2.7.2）。
6. **每一個集合類的 key 都要有一個「它最大會多大」的答案**，寫在註解裡。
   答不出來的，就是未來的 big key。

---

## 2.13 常見誤區

**① 「把物件序列化成 JSON 存 String，簡單又通用」**

它讓每一次單欄位更新都變成讀改寫——**2.4.4 實測掉了 198/200 次更新**。
而且讀一個欄位要傳 175 bytes（Hash 只要 4 bytes）。

**② 「一個 key 一個欄位，最清楚」**

10 個欄位拆成 10 個 key，記憶體是 Hash 的 **3.2 倍**（2.4.2），
還要設 10 次 TTL、刪 10 次（而且刪一半失敗你就有半個使用者）。

**③ 「ZSet 太大會變慢，要拆」**

500 萬個成員的 `ZSCORE` 是 **1.58 µs**（2.7.3）。
**該怕的不是大，是 `ZRANGE 0 -1` 跟 87.3 MB 的記憶體。**

**④ 「用 id 當 ZSet 的分數，剛好可以排序」**

分數是 `double`，超過 2^53 就失真（2.7.2）。Snowflake id 直接爆炸，**而且不報錯**。

**⑤ 「listpack 比較省，把門檻調高一點」**

listpack 的查詢是線性掃描（2.8.5）。調之前先量，調之後看 `SLOWLOG`。

**⑥ 「這個 hash 之前很大，我已經把欄位刪掉了，記憶體會還回來」**

不會。**編碼轉換是單向的**——1 個欄位的 hash 佔了 1,200 bytes（2.8.3）。要刪掉重建。

**⑦ 「Bitmap 省空間，什麼都用它」**

設一個「第 1 億個位元」就配置 12.5 MB（2.9.2）。**id 不連續的話它是最貴的選擇。**

**⑧ 「HyperLogLog 有誤差，但差不多啦」**

0.81% 的標準誤差在 30 萬人上是 ±2,400 人。**用來發獎品會出事**（2.9.4）。

**⑨ 「`SMEMBERS` 只是把集合讀出來」**

100 萬成員 = 51 ms 的全服務暫停 + 把整包搬進 JVM（2.10）。

**⑩ 「`entries()` 比 `hscan` 快，所以用 `entries()`」**

它確實快一倍（681 ms vs 1,205 ms），**代價是 0.19 秒的全服務暫停與 269 MB 的 heap**（2.10.2）。

---

## 2.14 本章小結

這一章只有一個主張：

> **選對結構，很多問題根本不會發生。**

四個具體的形式：

| 選錯的代價 | 選對之後 |
|---|---|
| JSON 存物件 → 讀改寫掉更新（198/200） | Hash + `HINCRBY` → 一條原子命令 |
| 拆成 10 個 key → 3.2 倍記憶體、10 次 TTL | 一個 Hash → 一個 key、一個 TTL |
| Set 存簽到 → 15.2 MB | Bitmap → 0.06 MB |
| 自己算「最高分」→ 讀改寫 | `ZADD GT` → 一條原子命令 |

**以及一個要長期記住的機制**：`OBJECT ENCODING`。
它會告訴你這個 key 現在用哪種內部表示，而**跨過門檻的那一刻，每元素的成本會跳 4～12 倍，而且回不去。**

### 2.14.1 驗收清單

- [ ] 說出五大結構各自的**一條危險命令**，以及它的替代方案（2.11 第二張表）。
- [ ] 說明為什麼 JSON 存法在併發下一定會掉更新，而 `HINCRBY` 不會。
- [ ] 說出 `HGETALL` 與 `HMGET` 的差別，並說明什麼時候必須用 `HSCAN`。
- [ ] 說出 ZSet 分數的精度上限，以及哪一種時間戳可以當分數。
- [ ] 用 `OBJECT ENCODING` 找出你系統裡一個「已經轉成 hashtable / skiplist」的 key。
- [ ] 說明「編碼轉換是單向的」造成的浪費，以及唯一的修法。
- [ ] 在 Set / Bitmap / HyperLogLog 之間做一次選擇，並說出你放棄了什麼能力。
- [ ] 說出一行 `entries()` 的三個代價（Redis 主執行緒、網路、JVM heap）。

### 2.14.2 本章練習

**練習一（15 分鐘）**：把你專案裡一個「存 JSON 的快取」改成 Hash。
測量三件事：記憶體、讀一個欄位的傳輸量、改一個欄位的往返次數。
**如果改完發現沒有變好，說出為什麼**——有些資料本來就該整包存。

**練習二（20 分鐘）**：實作「最近瀏覽的 20 件商品，不重複」。
⚠️ **List 做不到「不重複」，Set 做不到「最近」。** 想出兩種做法：
① List + `LREM`，② ZSet（分數 = 時間戳）+ `ZREMRANGEBYRANK`。
各寫一次，並比較：命令數、原子性、記憶體。

**練習三（15 分鐘）**：造一個 600 個欄位的 hash，記下 `MEMORY USAGE`。
把 `hash-max-listpack-entries` 調到 1024，**重建**同一個 hash，再記一次。
兩個數字差多少？接著用 05 章的方式（或 Lua 迴圈）各查 10 萬次，用 `SLOWLOG` 比較查詢成本。
**你現在有一份「調這個參數值不值得」的自製數據。**

**練習四（進階，30 分鐘）**：寫一個 `BigKeyScanner`：
用 `SCAN` 走過 keyspace，對每個 key 取 `TYPE` 與元素數量
（`STRLEN` / `HLEN` / `LLEN` / `SCARD` / `ZCARD`）與 `OBJECT ENCODING`，
輸出「前 20 大的 key」報表，並對「元素數 > 5000」或「已轉成 hashtable/skiplist 但元素數 < 100」的 key 發警告
（後者就是 2.8.3 那種浪費）。
⚠️ 每個 key 都要多次往返——**用 pipeline**（03 章會教，先自己試）。

---

## 2.15 下一章預告

這一章反覆出現同一句話：「**這條命令佔用主執行緒 N 毫秒**」。

下一章（03）把這句話的根源講完：**單執行緒**。

- 「單執行緒」到底單在哪裡？Redis 7.2 其實有**好幾個執行緒**，
  只是**執行命令的只有一個**——搞清楚這個分界，才知道哪些操作會互相卡、哪些不會。
- 一張**完整的 O(N) 命令清單**：這一章零散提到的 `HGETALL`、`SMEMBERS`、`SINTER`、`KEYS`，
  加上你還沒注意到的那些。
- `SLOWLOG` 要怎麼設、怎麼讀、怎麼接告警——**這一章用了十幾次的工具，下一章才正式教。**
- 為什麼「把命令包成 pipeline」可以讓吞吐變 10 倍（00 章 0.5.2 量過），
  以及 **pipeline 跟交易的差別**（它們常被搞混，而且搞混會出事）。
- 一個實驗：用 `DEBUG SLEEP 5` 讓 Redis 卡住 5 秒，**看你的 Spring 應用會發生什麼事**——
  這是 06 章「三層逾時」與 08 章「降級」的起點。
