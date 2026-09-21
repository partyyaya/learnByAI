# 第 03 章：單執行緒與慢命令

> 前三章反覆出現同一句話：「**這條命令佔用主執行緒 N 毫秒**」。
> 這一章把那句話的來源講完，然後回答一個你遲早要面對的問題：
> **Redis 卡住的時候，你的 Java 應用會發生什麼事？**
>
> 答案比想像中糟：**什麼事都不會發生。**
>
> 實測：讓 Redis 卡住 5 秒，20 個執行緒**全部**卡在 `redis.opsForValue().get()` 這一行，
> 最慢的一次等了 **5,008 毫秒**，**沒有任何一個呼叫拋出例外**——
> 因為 Lettuce 的預設命令逾時是 **60 秒**。
>
> 更糟的是你看不到它：
>
> - 那 20 次各等 5 秒的 `GET`，**`SLOWLOG` 裡一筆都沒有**。
>   （`SLOWLOG` 只記「執行」花多久，不記「排隊」等多久。）
> - 整段期間的 **p50 與 p99 延遲都是 0 毫秒**——監控圖表上完全正常。
> - 你想進去看一眼發生什麼事？**`PING`、`INFO`、`SLOWLOG`、`CLIENT LIST` 四個命令同時等了 2,700 毫秒**。
>   **Redis 卡住的時候，你的監控也一起瞎了。**
>
> 📌 這一章是 06 章（三層逾時）與 08 章（降級）的起點。
> 在學會怎麼設定之前，要先親眼看到「不設定」長什麼樣子。

---

## 3.1 學習目標

完成本章後，你應該可以：

- 說出 Redis 行程裡實際有幾個執行緒、各自在做什麼，
  以及「單執行緒」這個說法**精確**指的是哪一件事（3.2.1）。
- 解釋為什麼單執行緒還能跑到 27 萬 rps，以及它換來的**兩個好處**（3.2.4）。
- 說明 `io-threads` 是什麼、預設為什麼是關的、什麼時候才該開（3.2.3）。
- 說出「排隊」如何把一條慢命令變成所有人的延遲，並實測重現（3.3.1）。
- 指出 `SLOWLOG` 的**三個盲點**，特別是「它不記排隊時間」這一個（3.3.2、3.5.3）。
- 列出六類危險命令，並對每一條說出「這裡的 N 是誰」（3.4）。
- 用 `SLOWLOG`、`INFO commandstats`、`INFO latencystats`、`LATENCY` 四個工具**分工**排查延遲（3.5、3.6）。
- 說出 Lettuce 的預設命令逾時是多久，以及它造成的後果（3.7.2）。
- 用實測數字說明 pipeline 為什麼能把吞吐拉高 25～126 倍，並選出合理的批次大小（3.8）。
- 說出 **pipeline 與交易的三個差別**，並解釋為什麼「pipeline 拋了例外」不代表「沒有寫進去」（3.8.4）。

---

## 3.2 「單執行緒」到底單在哪裡

### 3.2.1 實測：Redis 行程裡有 5 個執行緒

「Redis 是單執行緒的」這句話，字面上是錯的。看容器裡的行程：

```bash
docker exec redis-lab sh -c 'for t in /proc/1/task/*; do echo "$(basename $t): $(cat $t/comm)"; done'
```

```
1:  redis-server
11: bio_close_file
12: bio_aof
13: bio_lazy_free
14: jemalloc_bg_thd
```

**五個執行緒**。各自在做什麼：

| 執行緒 | 工作 | 本課哪裡遇過 |
|---|---|---|
| **`redis-server`（主執行緒）** | **接受連線、讀命令、執行命令、寫回應** | **全部** |
| `bio_close_file` | 背景關閉檔案（例如 RDB 寫完之後） | 04 章 |
| `bio_aof` | 背景做 AOF 的 `fsync` | 04 章 |
| **`bio_lazy_free`** | **背景釋放大物件的記憶體** | **01 章 1.3.2 的 `UNLINK`** |
| `jemalloc_bg_thd` | 記憶體配置器自己的背景整理 | 04 章的碎片 |

> 📌 **所以精確的說法是**：
> **Redis 用一個執行緒執行所有命令。**
> 其他四個都是「善後」的執行緒——它們不碰你的資料結構，只做釋放記憶體、寫檔案這類工作。
>
> **這正是 `UNLINK` 比 `DEL` 快 160 倍的原因**（01 章 1.3.2）：
> `DEL` 在主執行緒上釋放 363 MB，`UNLINK` 把這件事交給 `bio_lazy_free`，主執行緒立刻回去服務別人。

### 3.2.2 那一個執行緒在做什麼：事件迴圈

主執行緒跑的是一個很簡單的迴圈：

```
     ┌──────────────────────────────────────────────┐
     │  1. 問作業系統：哪些連線有資料進來了？（epoll） │
     │  2. 把那些連線的位元組讀進來、解析成命令        │
     │  3. 【一條一條】執行命令                       │
     │  4. 把回應寫回去                               │
     │  5. 順便做一點背景工作（過期抽樣、漸進式 rehash）│
     └──────────────────────┬───────────────────────┘
                            └──→ 回到 1
```

第 5 步就是 01 章 1.6.1 的主動過期——**它跟你的命令搶的是同一個執行緒**，
所以那裡才有「25% CPU 時間預算」的煞車。

**第 3 步是這一章的全部重點**：

> **「一條一條」意味著：一條命令執行完，下一條才開始。**
> 沒有搶佔、沒有時間片、沒有優先權。
> **你排在一條 0.8 秒的 `DEL` 後面，你就等 0.8 秒。**

### 3.2.3 `io-threads`：Redis 6 加的那一半

```bash
docker exec redis-lab redis-cli CONFIG GET io-threads
docker exec redis-lab redis-cli CONFIG GET io-threads-do-reads
docker exec redis-lab redis-cli INFO server | grep io_threads_active
```

```
io-threads: 1
io-threads-do-reads: no
io_threads_active: 0
```

Redis 6 引進了 I/O 執行緒，但**它們只負責「把位元組讀進來、把位元組寫回去」——
第 3 步（執行命令）永遠只有主執行緒做。**

| | 誰做 |
|---|---|
| 從 socket 讀位元組、解析協定 | 主執行緒（開了 `io-threads-do-reads` 才分出去） |
| **執行命令** | **主執行緒，永遠** |
| 把回應序列化、寫回 socket | 主執行緒（`io-threads > 1` 時分出去） |

**預設是關的（`io-threads: 1`），而且多數情況不該開**：

- 00 章 0.5.1 量過，一台 Redis 在這台機器上跑到 27 萬 rps 時，
  瓶頸是**網路往返次數**，不是 socket 讀寫的 CPU。
- 開了之後主執行緒要多做一次執行緒間的同步，**低流量時反而變慢**。
- 官方建議：**只有在確認「單核心已經跑滿，而且是花在 I/O 上」時才開**，
  而且要搭配 `CONFIG GET io-threads` 的核心數上限。

📌 **判斷方法**：`INFO commandstats`（3.6.1）如果顯示每條命令的 `usec_per_call` 都很小，
但 CPU 卻滿了——那才是 I/O 成本。否則你該處理的是慢命令，不是 I/O 執行緒。

### 3.2.4 為什麼單執行緒還這麼快

00 章 0.5.1 的實測：六種不同的命令（`SET`、`GET`、`INCR`、`LPUSH`、`SADD`、`ZADD`）
吞吐幾乎一模一樣，都是 27 萬 rps、p50 都是 0.095 毫秒。

**因為時間根本不花在「執行命令」上**：

| 一條 `GET` 的時間花在哪 | 量級 |
|---|---|
| Redis 在雜湊表裡找到那個 key | **奈秒** |
| 網路往返 + 系統呼叫 + 協定解析 | **百微秒** |

**差三個數量級。** 所以 Redis 用幾個執行緒去執行命令，對吞吐幾乎沒有影響——
**它本來就不是卡在那裡。**

單執行緒換來的**兩個好處**才是重點：

| 好處 | 具體是什麼 |
|---|---|
| **每一條命令都是原子的** | 00 章 0.3.4 的 `DECR`、01 章的 `SET NX`、02 章的 `HINCRBY` / `ZADD GT`——**它們能解決併發問題，全部建立在這件事上** |
| **沒有鎖，就沒有鎖的成本與 bug** | 不需要為每個資料結構加鎖、不會死結、沒有 race condition 要 debug |

> 📌 **這是一個很清楚的取捨**：
> **Redis 用「一次只做一件事」換到了「每件事都不會被打斷」。**
> 而代價就是這一章剩下的部分——**一件慢事，會讓所有事都慢。**

---

## 3.3 排隊：所有問題的根源

### 3.3.1 實測：`DEBUG SLEEP 2`，別人等 1.8 秒

`DEBUG SLEEP` 讓主執行緒單純地睡著（不做任何事），是模擬「Redis 卡住」最乾淨的方式。

```bash
docker exec redis-lab bash -c '
  redis-cli SET k v
  (redis-cli DEBUG SLEEP 2 &)
  sleep 0.2
  for i in 1 2 3; do
    s=$(date +%s%3N); v=$(redis-cli GET k); e=$(date +%s%3N)
    echo "  GET k 回傳 \"$v\"，等了 $((e-s)) ms"
  done'
```

```
  GET k 回傳 "v"，等了 1799 ms
  GET k 回傳 "v"，等了 6 ms
  GET k 回傳 "v"，等了 5 ms
```

**第一個 `GET` 等了 1,799 毫秒**（睡了 2 秒，它在 0.2 秒時送出，所以等了剩下的 1.8 秒）。
第二、三個在睡醒之後送出，各 5～6 毫秒。

**這個 `GET` 本身是 O(1) 的，它一點都不慢。它只是排在一條慢命令後面。**

### 3.3.2 ⚠️ 那 1.8 秒，`SLOWLOG` 裡一筆都沒有

同一個實驗，看 Redis 自己記了什麼：

```bash
docker exec redis-lab redis-cli SLOWLOG GET 5
```

```
1) 1) (integer) 7111173
   2) (integer) 1789546512
   3) (integer) 2001677          ← DEBUG SLEEP 執行了 2,001,677 µs
   4) 1) "DEBUG"
      2) "SLEEP"
      3) "2"
   5) "127.0.0.1:43512"
```

**只有一筆。** 那個等了 1.8 秒的 `GET`——**不在裡面**。

> ⚠️ **因為 `SLOWLOG` 記的是「這條命令執行了多久」，不是「這個客戶端等了多久」。**
>
> 那個 `GET` 的**執行**時間是 5 微秒，遠低於 10 毫秒的門檻，所以不會被記錄。
> 它的 **1,799 毫秒全部花在排隊**，而排隊時間 Redis 不記。

這件事的實務後果非常大：

```
    客戶端看到的  ：這次 GET 花了 1.8 秒
    SLOWLOG 說的  ：沒有任何慢命令
    監控圖表說的  ：Redis 平均延遲 0.1 毫秒，一切正常
```

**三邊都沒說謊，但只有客戶端說的是使用者的體驗。**

📌 **所以排查 Redis 延遲的正確順序是**：

1. **先從客戶端量**（`redis-cli --latency`、或你的應用埋點）——**這才是真相**。
2. 客戶端看到尖峰，才去 `SLOWLOG` 找**是誰造成的**。
3. `SLOWLOG` 是空的但客戶端仍然慢 → 往下查 3.4.4 的「三種你不覺得它慢的慢」。

### 3.3.3 實測：Redis 卡住的時候，監控命令也卡住

既然一切都在同一條執行緒上排隊，**那「進去看一眼」這個動作本身也要排隊**。

讓 Redis 睡 3 秒，同時送出四個監控命令：

```bash
docker exec redis-lab bash -c '
  (redis-cli DEBUG SLEEP 3 &)
  sleep 0.3
  for cmd in PING INFO SLOWLOG CLIENT; do
    ( s=$(date +%s%3N)
      case $cmd in
        PING)    redis-cli PING > /dev/null ;;
        INFO)    redis-cli INFO clients > /dev/null ;;
        SLOWLOG) redis-cli SLOWLOG GET 1 > /dev/null ;;
        CLIENT)  redis-cli CLIENT LIST > /dev/null ;;
      esac
      e=$(date +%s%3N); printf "  %-9s 等了 %s ms\n" "$cmd" "$((e-s))" ) &
  done; wait'
```

```
  INFO      等了 2700 ms
  PING      等了 2700 ms
  SLOWLOG   等了 2700 ms
  CLIENT    等了 2700 ms
```

> ⚠️ **四個都等了 2.7 秒。**
>
> 這代表：**當 Redis 真的出問題時，你的監控系統拿到的不是「Redis 很慢」的資料，
> 而是「監控採集超時」——或者更糟，什麼資料都沒有，圖表上是一段空白。**
>
> **看到監控圖表有一段斷線，不要假設是監控壞了。** 那很可能正是 Redis 卡死的那一段。

📌 **唯一不會被卡住的觀察點是「Redis 之外」**：
客戶端這一側的延遲埋點、作業系統層級的 CPU / 記憶體、
以及 06 章會講的「連線池裡有幾個執行緒在等」。
**14 章的監控清單會把這件事寫成一條規則：不要只監控 Redis 自己回報的指標。**

---

## 3.4 慢命令清單

### 3.4.1 先問一個問題：這裡的 N 是誰

02 章 2.2.2 提過，每條命令的複雜度都寫在文件上。但複雜度本身不是答案：

```
HGETALL cart:8842        O(N)，N = 購物車裡的商品數 = 5      →  5 µs
HGETALL bighash          O(N)，N = 100 萬                    →  199,542 µs
```

**同一條命令、同一份程式碼，差 4 萬倍。**

> 📌 **所以看到 `O(N)` 時要問的不是「它是不是慢命令」，而是：**
> **「這個 N 在正式環境、一年後，會長到多大？」**
>
> 答得出來（「購物車最多 50 件商品，我們有上限檢查」）→ 安全。
> **答不出來 → 它遲早是一次事故。**（這就是 02 章 2.12 第六條規約的由來。）

### 3.4.2 六類危險命令

| 類別 | 命令 | N 是誰 | 安全的替代 |
|---|---|---|---|
| **① 掃描整個 keyspace** | `KEYS`、`RANDOMKEY`（部分情況）、`DBSIZE`（O(1)，安全） | 整台 Redis 的 key 數 | **`SCAN`**（01 章 1.5） |
| **② 讀整個集合** | `HGETALL`、`HKEYS`、`HVALS`、`SMEMBERS`、`LRANGE k 0 -1`、`ZRANGE k 0 -1` | 那個 key 的元素數 | `HMGET` / `HSCAN` / `SSCAN` / `ZSCAN` / 分頁 `LRANGE k 0 99` |
| **③ 集合運算** | `SINTER`、`SUNION`、`SDIFF`、`ZUNIONSTORE`、`ZINTERSTORE` | 參與運算的集合大小總和 | `SINTERCARD`（只要數量）、離線預先算好 |
| **④ 刪除與清空** | `DEL` 一個大 key、`FLUSHALL`、`FLUSHDB` | 被釋放的元素數 | **`UNLINK`**（01 章 1.3.2）、`FLUSHALL ASYNC`、或打開 `lazyfree-*`（見下方） |
| **⑤ 排序與計算** | `SORT`、`LPOS`（大 list）、`LREM`、`SETRANGE` 造成的大量複製 | 元素數 | 在應用層排序、或用 ZSet |
| **⑥ 一次操作很多 key** | `MGET`／`MSET` 傳幾千個 key、`DEL k1 k2 ... k5000` | 你傳了幾個 key | 分批，每批 100～1000（3.8.4） |

**④ 有一組設定可以把「釋放記憶體」全部交給背景執行緒**，而它們預設全是關的：

```bash
docker exec redis-lab redis-cli CONFIG GET 'lazyfree-*'
```

```
lazyfree-lazy-user-del      no     ← DEL 要不要自動當成 UNLINK
lazyfree-lazy-user-flush    no     ← FLUSHALL / FLUSHDB 要不要非同步
lazyfree-lazy-server-del    no     ← 內部隱含的刪除（例如 RENAME 蓋掉目標）
lazyfree-lazy-expire        no     ← 過期刪除要不要交給背景（01 章 1.6）
lazyfree-lazy-eviction      no     ← 淘汰刪除要不要交給背景（04 章）
```

> 📌 **`lazyfree-lazy-user-del yes` 等於「所有 `DEL` 自動變成 `UNLINK`」**——
> 這是一個成本極低、收益很大的設定，尤其是當你**改不動應用程式碼**的時候
> （01 章 1.3.2 說過 `redisTemplate.delete()` 送的是 `DEL`）。
> 14 章的上線設定清單會把這五個一起打開。

⚠️ **還有一條不在清單裡但最危險的：`MONITOR`**（00 章 0.4.3）。
它不是 O(N)，它是「**把每一條命令都複製一份給你**」——
在一台 QPS 十萬的 Redis 上開它，等於替 Redis 加了十萬 QPS 的輸出工作。

### 3.4.3 本課測過的數字，放在一起

前三章散落的實測，集中成一張表（都是這台筆電、Redis 7.2、`SLOWLOG` 記錄的伺服器端耗時）：

| 命令 | 資料規模 | **佔用主執行緒** | 出處 |
|---|---|---|---|
| `DEL` 一個 hash | 500 萬欄位（363 MB） | **810,351 µs（0.81 秒）** | 01 章 1.3.2 |
| `KEYS *` | 500 萬個 key | **727,335 µs（0.73 秒）** | 01 章 1.5.1 |
| `FLUSHALL` | 500 萬個 key | 374,476 µs | 02 章 |
| `HGETALL` | 100 萬欄位 | **199,542 µs（0.20 秒）** | 02 章 2.10.1 |
| `SUNION` | 兩個各 50 萬成員 | 143,000 µs | 02 章 2.6.2 |
| `SDIFF` | 兩個各 50 萬成員 | 71,300 µs | 02 章 2.6.2 |
| `SMEMBERS` | 100 萬成員 | 50,978 µs | 02 章 2.10.1 |
| `SINTER` | 兩個各 50 萬成員 | 44,500 µs | 02 章 2.6.2 |
| `LRANGE k 0 -1` | 100 萬元素 | 25,415 µs | 02 章 2.10.1 |
| `ZRANGE k 0 -1` | 100 萬成員 | 21,830 µs | 02 章 2.10.1 |
| **對照：`GET`** | —— | **約 5 µs** | 3.3.1 |
| **對照：`ZSCORE`** | 500 萬成員的 ZSet | **1.58 µs** | 02 章 2.7.3 |

> 📌 **看最後兩行**：`O(log N)` 的 `ZSCORE` 在 500 萬成員上是 **1.58 微秒**，
> 而 `O(N)` 的 `ZRANGE 0 -1` 在同一個 key 上是 **21,830 微秒**。
> **差 13,816 倍，而它們操作的是同一個 key。**
>
> **危險的從來不是「這個 key 很大」，是「你對這個大 key 做了什麼」。**

### 3.4.4 三種「你不覺得它慢」的慢

`SLOWLOG` 空空如也、命令看起來都很正常，但客戶端就是偶爾卡一下。往這三個方向找：

**① 一大批 key 同時過期**

01 章 1.6.3 實測：100 萬個 key 同時到期，Redis 花了 **3 秒**才清完，
期間其他人的最大延遲從 7 毫秒跳到 **26 毫秒**。
**這不會進 `SLOWLOG`**——它不是命令，是背景工作。

**② 一個很大的 value 被讀出來**

`GET` 是 `O(1)`，但「把 50 MB 複製到輸出緩衝區」不是：

```
  GET 一個  1 MB 的 value   SLOWLOG 沒記（10 ms 門檻以下）
  GET 一個 10 MB 的 value   SLOWLOG = 1,731 µs
  GET 一個 50 MB 的 value   SLOWLOG = 9,940 µs
```

連續 20 次 `GET` 那個 50 MB 的 value 時，其他客戶端的最大延遲是 **9 毫秒**。

⚠️ **這一條會讓你看 `SLOWLOG` 看得很困惑**：
**上面寫著 `GET` 很慢，而 `GET` 明明是 O(1)。**
看到這種紀錄，去查那個 key 的 `STRLEN` / `MEMORY USAGE`——問題在 value 的大小，不在命令。

**③ `fork`：持久化的瞬間**

RDB 快照與 AOF 重寫都要 `fork` 一個子行程，**而 `fork` 本身會讓主執行緒停住**
（時間跟記憶體用量成正比）。這是 04 章的主題，先記住一件事：
**`SLOWLOG` 是空的、命令都很快、但每隔幾分鐘卡一下——先去看 `INFO persistence` 的 `rdb_last_bgsave_time_sec`。**

---

## 3.5 `SLOWLOG`：Redis 的黑盒子

前三章用了十幾次，現在正式教。

### 3.5.1 兩個設定

```bash
docker exec redis-lab redis-cli CONFIG GET slowlog-log-slower-than
docker exec redis-lab redis-cli CONFIG GET slowlog-max-len
```

| 設定 | 預設 | 意思 |
|---|---|---|
| `slowlog-log-slower-than` | **10000**（微秒 = 10 毫秒） | 超過這個時間的命令會被記錄。**設 0 = 記錄每一條**，設負數 = 關閉 |
| `slowlog-max-len` | **128** | 最多保留幾筆（環狀緩衝，滿了擠掉最舊的） |

**這兩個預設值都該改**：

```bash
# 10 毫秒對 Redis 來說太寬鬆了 —— 一條 GET 只要 5 微秒
docker exec redis-lab redis-cli CONFIG SET slowlog-log-slower-than 5000    # 5 毫秒
docker exec redis-lab redis-cli CONFIG SET slowlog-max-len 512
```

> 📌 **門檻設多少**：
> 從 **5,000～10,000 微秒**開始（5～10 毫秒），
> 觀察一陣子之後往下調到「每天大約記到十幾筆」的水準。
>
> ⚠️ **不要設 0**。除了效能開銷之外，還有一個實際的坑：
> **`SLOWLOG RESET` 自己也會被記進去**，於是 `SLOWLOG GET 1` 回給你的是 `SLOWLOG RESET` 那一筆，
> 不是你要量的那條命令。（本課量 `SINTER` 時就踩過：量到 48 µs，實際是 44,500 µs。）

### 3.5.2 怎麼讀

```bash
docker exec redis-lab redis-cli SLOWLOG GET 2
```

```
1) 1) (integer) 23                    ← ① 流水號（每筆遞增，可用來判斷有沒有漏看）
   2) (integer) 1789543814            ← ② Unix 時間戳
   3) (integer) 199542                ← ③ 執行耗時（微秒）★ 最重要
   4) 1) "HGETALL"                    ← ④ 命令與參數
      2) "bighash"
   5) "127.0.0.1:54862"               ← ⑤ 客戶端位址
   6) ""                              ← ⑥ 客戶端名稱（CLIENT SETNAME 設的）
```

| 其他子命令 | 用途 |
|---|---|
| `SLOWLOG LEN` | 目前記了幾筆 |
| `SLOWLOG RESET` | 清空 |
| `SLOWLOG GET`（不帶數字） | 預設回 10 筆；`SLOWLOG GET -1` 回全部 |

📌 **第 ⑥ 欄是被低估的一欄。** 如果你的每個服務在連線後都下一次
`CLIENT SETNAME order-service`，那 `SLOWLOG` 就會直接告訴你**是哪個服務**打的這條慢命令。
**在一台被五個服務共用的 Redis 上，這一行省下的是半小時的追查。**

### 3.5.3 ⚠️ `SLOWLOG` 的三個盲點

| 盲點 | 說明 | 怎麼補 |
|---|---|---|
| **① 不記排隊時間** | 3.3.2 實測：等了 1,799 毫秒的 `GET` 完全沒被記錄 | **從客戶端量延遲**（3.6.4、06 章） |
| **② 不記網路時間** | 命令從客戶端到 Redis、回應傳回去的時間都不算 | 同上 |
| **③ 只有 128 筆，而且會被擠掉** | 一次雪崩產生幾千條慢命令，你只看得到最後 128 條 | 調大 `slowlog-max-len`，**並且定期採集到外部**（14 章） |

> 📌 **`SLOWLOG` 回答的是「誰造成了延遲」，不是「有沒有延遲」。**
> 這兩個問題要用不同的工具（3.6.4 有分工表）。

---

## 3.6 另外三個觀測工具

### 3.6.1 `INFO commandstats`：找出誰最貴

```bash
docker exec redis-lab redis-cli CONFIG RESETSTAT
# ...讓系統跑一陣子...
docker exec redis-lab redis-cli INFO commandstats
```

```
cmdstat_hset:calls=200000,usec=59096,usec_per_call=0.30,rejected_calls=0,failed_calls=0
cmdstat_get:calls=1000,usec=49,usec_per_call=0.05,rejected_calls=0,failed_calls=0
cmdstat_hgetall:calls=3,usec=53504,usec_per_call=17834.67,rejected_calls=0,failed_calls=0
```

**三條命令，`usec_per_call` 差了 35 萬倍**：

| 命令 | 呼叫次數 | 每次平均 | 總共吃掉 |
|---|---|---|---|
| `hset` | 200,000 | 0.30 µs | 59,096 µs |
| `get` | 1,000 | 0.05 µs | 49 µs |
| **`hgetall`** | **3** | **17,834.67 µs** | **53,504 µs** |

> ⭐ **這是本節最該學會的一張表。**
> `hgetall` 只被呼叫了 **3 次**，卻吃掉了跟 20 萬次 `hset` **差不多的主執行緒時間**。
>
> **`SLOWLOG` 告訴你「有一條命令很慢」，`commandstats` 告訴你「哪一種命令吃掉了你的 Redis」。**
> 排查時應該先看 `commandstats` 的 `usec` 欄（總時間），
> **排在最前面的那一條，就是你該優化的那一條**——不管它被呼叫幾次。

另外兩欄也很有用：

| 欄位 | 意思 |
|---|---|
| `rejected_calls` | 命令**沒有執行**就被拒絕（參數錯誤、權限不足、記憶體滿了） |
| `failed_calls` | 命令執行了但回傳錯誤（例如 `WRONGTYPE`） |

**`failed_calls` 持續增加 = 你的程式碼在做某件一直失敗的事**，而且可能沒有人在看那個例外。

### 3.6.2 `INFO latencystats`：每條命令的 p50 / p99（Redis 7+）

```bash
docker exec redis-lab redis-cli INFO latencystats
```

```
latency_percentiles_usec_hset:p50=0.001,p99=1.003,p99.9=10.047
latency_percentiles_usec_get:p50=0.001,p99=1.003,p99.9=1.003
latency_percentiles_usec_hgetall:p50=15597.567,p99=22806.527,p99.9=22806.527
```

`commandstats` 只有平均值，**平均值會被少數幾次極端值拉歪、也會把極端值藏起來**。
`latencystats` 給的是分佈——**這是 Redis 7 加的，如果你的版本有，就用它。**

### 3.6.3 `LATENCY`：Redis 自己的延遲事件記錄

跟 `SLOWLOG` 不同，`LATENCY` 記錄的是**各種事件**造成的延遲尖峰（包含 fork、過期、AOF 寫入）。
預設是關的：

```bash
docker exec redis-lab redis-cli CONFIG SET latency-monitor-threshold 100   # 100 毫秒
docker exec redis-lab redis-cli LATENCY RESET
docker exec redis-lab redis-cli DEBUG SLEEP 0.3
docker exec redis-lab redis-cli LATENCY LATEST
```

```
1) 1) "command"          ← 事件類型
   2) (integer) 1789546572   ← 最後一次發生的時間
   3) (integer) 301          ← 最後一次的延遲（毫秒）
   4) (integer) 301          ← 這個事件歷史上的最大值
```

| 命令 | 用途 |
|---|---|
| `LATENCY LATEST` | 每種事件的最近一次與歷史最大值 |
| `LATENCY HISTORY <event>` | 某個事件的歷史記錄（最多 160 筆） |
| `LATENCY RESET` | 清空 |
| `LATENCY DOCTOR` | **Redis 自己給的診斷建議**（見下方） |

**常見的事件類型**：`command`（命令執行）、`fork`（持久化）、`expire-cycle`（過期）、
`eviction-del` / `eviction-cycle`（淘汰）、`aof-fsync-always`。

**`LATENCY DOCTOR` 會直接給你一段人話的診斷**（在本章跑完那些 `DEBUG SLEEP` 之後）：

```
Dave, I have observed latency spikes in this Redis instance. You don't mind talking about it, do you Dave?

1. command: 7 latency spikes (average 2105ms, mean deviation 1340ms, period 62.43 sec).
   Worst all time event 5003ms.

I have a few advices for you:

- Check your Slow Log to understand what are the commands you are running which are too slow
  to execute. ...
- Deleting, expiring or evicting (because of maxmemory policy) large objects is a blocking
  operation. If you have very large objects that are often deleted, expired, or evicted,
  try to fragment those objects into multiple smaller objects.
```

（那個 `Dave` 是作者留的彩蛋，出自《2001 太空漫遊》。它建議的兩件事，正好就是 3.4.2 的 ② 與 ④。）

> 📌 **`LATENCY` 的價值在於它涵蓋了 3.4.4 那三種「不是命令」的慢**。
> `SLOWLOG` 看不到過期與 fork，`LATENCY` 看得到。

### 3.6.4 四個工具的分工

| 問題 | 用哪個 |
|---|---|
| **現在有沒有延遲？** | `redis-cli --latency`（客戶端量）★ **從這裡開始** |
| 是哪一條命令造成的？ | `SLOWLOG GET` |
| 哪一種命令吃掉最多主執行緒時間？ | **`INFO commandstats` 的 `usec` 欄** |
| 那種命令的延遲分佈長什麼樣？ | `INFO latencystats`（Redis 7+） |
| 慢的不是命令，是別的東西？ | `LATENCY LATEST` / `LATENCY DOCTOR` |
| **Redis 說它很健康，但使用者說很慢？** | **你的應用端埋點**（3.3.2、3.7） |

⚠️ **最後一列是這一章的重點。** 前五個工具全都在 Redis 裡面，
而 3.3.3 已經證明：**Redis 卡住的時候，這五個工具全部也卡住。**

---

## 3.7 Redis 卡住的時候，你的 Spring 應用怎麼樣

### 3.7.1 先講結論

**它會安靜地等，等到 Redis 好為止。**

大部分人對「Redis 只是快取」這句話的理解是：**它掛了，頂多快取沒命中、變慢一點。**
這個理解在預設設定下是**錯的**，而且錯得很徹底。下面是實測。

### 3.7.2 實測：20 個執行緒一起卡 5 秒

```java
package com.example.lab10.ch03;

import com.example.lab10.RedisProbe;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

@SpringBootTest
class BlockedRedisTest {

    @Autowired StringRedisTemplate redis;
    @Autowired RedisProbe probe;
    @Autowired LettuceConnectionFactory factory;

    @Test
    void whatHappensToYourApp() throws Exception {
        System.out.println("═══ 3.7.2 Redis 卡住 5 秒，你的應用怎麼樣 ═══");
        probe.flushAll();
        redis.opsForValue().set("k", "v");
        System.out.println("Lettuce 的預設命令逾時 : " + factory.getClientConfiguration().getCommandTimeout());

        int threads = 20;
        ConcurrentLinkedQueue<Long> latencies = new ConcurrentLinkedQueue<>();
        AtomicInteger ok = new AtomicInteger(), failed = new AtomicInteger();
        AtomicInteger inFlight = new AtomicInteger(), maxInFlight = new AtomicInteger();
        CountDownLatch done = new CountDownLatch(threads);
        long deadline = System.nanoTime() + 8_000_000_000L;

        for (int t = 0; t < threads; t++) {
            new Thread(() -> {
                while (System.nanoTime() < deadline) {
                    long s = System.nanoTime();
                    int n = inFlight.incrementAndGet();
                    maxInFlight.accumulateAndGet(n, Math::max);
                    try {
                        redis.opsForValue().get("k");
                        ok.incrementAndGet();
                    } catch (Exception e) {
                        failed.incrementAndGet();
                    } finally {
                        inFlight.decrementAndGet();
                    }
                    latencies.add((System.nanoTime() - s) / 1_000_000);
                }
                done.countDown();
            }).start();
        }

        Thread.sleep(2000);
        System.out.println("--- 現在讓 Redis 睡 5 秒 ---");
        long s = System.currentTimeMillis();
        new Thread(() -> probe.raw("DEBUG", "SLEEP", "5")).start();
        Thread.sleep(5500);
        System.out.println("--- Redis 醒了（" + (System.currentTimeMillis() - s) + " ms）---");
        done.await();

        long[] ms = latencies.stream().mapToLong(Long::longValue).sorted().toArray();
        System.out.printf("總共送出 %,d 次 GET：成功 %,d，失敗 %,d%n", ms.length, ok.get(), failed.get());
        System.out.printf("延遲 p50=%d ms  p99=%,d ms  最慢=%,d ms%n",
                ms[ms.length / 2], ms[(int) (ms.length * 0.99)], ms[ms.length - 1]);
        System.out.println("同時卡在 Redis 呼叫裡的執行緒數（最高）: " + maxInFlight.get() + " / " + threads);
        System.out.println("有沒有任何一個呼叫拋出例外？ " + (failed.get() > 0 ? "有" : "沒有 —— 它們全部安靜地等完了"));
        probe.slowlog(3);
    }
}
```

**輸出**：

```
═══ 3.7.2 Redis 卡住 5 秒，你的應用怎麼樣 ═══
Lettuce 的預設命令逾時 : PT1M
--- 現在讓 Redis 睡 5 秒 ---
--- Redis 醒了（5505 ms）---
總共送出 223,944 次 GET：成功 223,944，失敗 0
延遲 p50=0 ms  p99=0 ms  最慢=5,008 ms
同時卡在 Redis 呼叫裡的執行緒數（最高）: 20 / 20
有沒有任何一個呼叫拋出例外？ 沒有 —— 它們全部安靜地等完了
SLOWLOG（最近 2 筆）
   5,005,883 µs  DEBUG SLEEP 5
```

**四個數字要一起看**：

| 觀察 | 數字 | 意義 |
|---|---|---|
| **Lettuce 預設命令逾時** | **PT1M = 60 秒** | **這是預設值。Spring Boot 沒有替你設得更短** |
| 同時卡住的執行緒 | **20 / 20** | **全部**。不是「一部分請求變慢」，是「這台機器上所有碰到 Redis 的執行緒」 |
| 最慢的一次 | **5,008 ms** | 等到 Redis 醒為止 |
| 拋出的例外 | **0 個** | **沒有任何錯誤訊息、沒有任何日誌、沒有任何告警** |

> ⚠️ **把這件事放進一個真實的 Spring MVC 應用裡**：
> Tomcat 預設 200 個工作執行緒。每個請求都會讀一次快取。
> **Redis 卡住 5 秒 → 200 個執行緒全部卡在那一行 → 執行緒池耗盡 → 新請求連排隊都排不進來。**
>
> **這時候掛掉的不是快取，是整個服務。**
> 而且因為 Redis 60 秒後才逾時，**這 5 秒裡你的健康檢查也可能一起失敗，
> 於是負載平衡把這台機器踢掉，流量全部壓到其他同樣在卡的機器上。**
>
> **「Redis 只是快取，掛了不影響主流程」——這句話在預設設定下是錯的。**

📌 **而 `p50=0 ms、p99=0 ms`。** 22 萬次請求裡只有 20 次被卡住，
統計上完全被稀釋掉了。**你的監控圖表在事故當下看起來是一條平線。**

### 3.7.3 實測：同一個實驗，逾時設成 500 毫秒

只加一行設定：

```yaml
spring:
  data:
    redis:
      timeout: 500ms        # ← 就這一行
```

```
═══ 3.7.3 同一個實驗，但逾時設成 500 毫秒 ═══
命令逾時 : PT0.5S
--- 讓 Redis 睡 5 秒 ---
總共送出 219,102 次 GET：成功 218,922，失敗 180
最慢的一次 = 510 ms
第一個錯誤 : QueryTimeoutException: Redis command timed out
```

**同一個 5 秒的阻塞，兩種結局**：

| | 預設（60 秒） | `timeout: 500ms` |
|---|---|---|
| 最慢的一次 | **5,008 ms** | **510 ms** |
| 失敗的請求 | 0 | **180** |
| 你知道出事了嗎 | **不知道** | **知道**（`QueryTimeoutException`，會進日誌、會觸發告警） |
| 執行緒被佔用多久 | 5 秒 | 0.5 秒 |

> 📌 **這不是「哪個比較好」的問題，是「你想在哪裡承擔這個失敗」的問題。**
>
> 預設設定把失敗**藏起來**：沒有例外、沒有日誌，但你的執行緒池在無聲地耗盡。
> 短逾時把失敗**攤開來**：180 個請求明確失敗了，而你的應用可以決定怎麼辦——
> 去資料庫拿、回一個預設值、還是回 503。
>
> **後者是 08 章「降級」的前提：你必須先知道它失敗了，才能降級。**

### 3.7.4 這一節還沒完

上面只解決了一半。**`timeout: 500ms` 只管「命令送出去之後等多久」**，
還有另外兩層逾時（建立連線、socket 層）沒設，
而且「失敗了要怎麼辦」也還沒回答。

| 問題 | 哪一章 |
|---|---|
| 三層逾時分別是什麼、各該設多少 | **06 章 6.8** |
| 連線池滿了怎麼辦 | **06 章 6.7** |
| 逾時之後要降級成什麼 | **08 章** |
| 「快取故障」不能變成「資料庫雪崩」 | **08 章** |

**現在只要記住一件事**：
**Spring Boot 的預設設定，會讓 Redis 的停頓變成你的服務的停頓，而且不留痕跡。**

---

## 3.8 Pipeline：把往返次數打下來

### 3.8.1 為什麼有效

00 章 0.5.2 已經證明過：同一台 Redis，`redis-benchmark -P 16` 讓吞吐從 27 萬 rps 跳到 330 萬 rps。
**Redis 一行程式碼都沒改。**

原因在 3.2.4：**時間不花在執行命令上，花在往返上。**

```
   一條一條送：  [送] → [等] → [回]   [送] → [等] → [回]   [送] → [等] → [回]
                  ↑ 每一輪都要付一次網路往返（本機 Docker 約 130 µs）

   pipeline  ：  [送 送 送 送 ... 送] → [等] → [回 回 回 回 ... 回]
                  ↑ 一次往返，Redis 連續執行，回應一起傳回來
```

### 3.8.2 實測：一萬次操作，四種送法

```java
private static final int N = 10_000;

// ① 一條一條
for (int i = 0; i < N; i++) redis.opsForValue().set("p:" + i, "v" + i);

// ② executePipelined
redis.executePipelined((RedisCallback<Object>) c -> {
    for (int i = 0; i < N; i++)
        c.stringCommands().set(("p:" + i).getBytes(UTF_8), ("v" + i).getBytes(UTF_8));
    return null;
});

// ③ multiGet（讀取時才有這個選項）
redis.opsForValue().multiGet(keys);
```

**寫入一萬筆**：

| 做法 | 耗時 | 每筆 | 吞吐 | |
|---|---|---|---|---|
| ① 一條一條 `set()` | **1,518 ms** | 151.8 µs | 6,587 次/秒 | |
| ② `executePipelined` | **59 ms** | 5.9 µs | 169,491 次/秒 | **快 25.7 倍** |

**讀取一萬筆**：

| 做法 | 耗時 | 每筆 | 吞吐 | |
|---|---|---|---|---|
| ① 一條一條 `get()` | **1,391 ms** | 139.1 µs | 7,189 次/秒 | |
| ② `executePipelined` | **37 ms** | 3.7 µs | 270,270 次/秒 | **快 37.6 倍** |
| ③ **`multiGet`（一條 `MGET`）** | **11 ms** | 1.1 µs | 909,090 次/秒 | **快 126.5 倍** |

> 📌 **`MGET` 比 pipeline 又快了 3.4 倍**，因為它連「一萬條命令的協定文字」都省了——
> 一條 `MGET` 帶一萬個 key，Redis 只解析一條命令。
>
> **所以優先順序是：① 有原生的批次命令（`MGET`/`MSET`/`HMGET`/`SADD 多個成員`）就用它，
> ② 沒有的話用 pipeline，③ 都不行才一條一條送。**

⚠️ **`MGET` 的限制**（02 章 2.3.2 提過）：Cluster 模式下跨 slot 的 `MGET` 會失敗。
pipeline 沒有這個問題（Lettuce 會自動把命令分派到對的節點）——**這是 13 章的內容。**

### 3.8.3 ⚠️ pipeline 不是交易

這是最常見的誤解，而且誤解的代價很大。

**證據一：兩個 pipeline 會交錯**

```java
// 執行緒 A：pipeline 裡 APPEND 三次 "A"
// 執行緒 B：pipeline 裡 APPEND 三次 "B"
```

```
兩個 pipeline（各 3 條 APPEND）交錯的結果: ABBBAA
（如果 pipeline 是原子的，只會看到 AAABBB 或 BBBAAA）
```

**證據二：裡面有一條失敗，其他條照樣生效**

```java
try {
    redis.executePipelined((RedisCallback<Object>) c -> {
        c.stringCommands().set("ok1".getBytes(), "1".getBytes());
        c.listCommands().lPush("str".getBytes(), "x".getBytes());   // ❌ WRONGTYPE
        c.stringCommands().set("ok2".getBytes(), "2".getBytes());
        return null;
    });
} catch (Exception e) {
    System.out.println("  " + e.getClass().getSimpleName() + ": " + e.getMessage());
    Throwable root = e; while (root.getCause() != null) root = root.getCause();
    System.out.println("  root cause: " + root.getMessage());
}
System.out.println("  ok1 = " + redis.opsForValue().get("ok1"));
System.out.println("  ok2 = " + redis.opsForValue().get("ok2"));
```

```
pipeline 裡第 2 條是錯的，Spring 拋了：
  RedisPipelineException: Pipeline contained one or more invalid commands
  root cause: WRONGTYPE Operation against a key holding the wrong kind of value
但伺服器那一側：
  ok1 = 1   （第 1 條生效了）
  ok2 = 2   （第 3 條也生效了）
  → 拋了例外，但沒有回滾任何東西
```

> ⚠️ **這一段是這一節最重要的地方。**
>
> Spring 拋出 `RedisPipelineException`，**讓它看起來像是一個交易失敗了**。
> 你的 `catch` 區塊很可能寫著「這批沒寫成功，等一下重試」——
> **但其實三條裡有兩條已經寫進去了。重試一次就變成寫兩次。**
>
> **拋例外 ≠ 沒生效。** 在 Redis 上，這兩件事完全無關。

**pipeline 到底保證什麼**：

| | pipeline |
|---|---|
| 這批命令會依序送到、依序執行 | ✅ |
| 這批命令中間不會插進別人的命令 | ❌ **會**（證據一） |
| 其中一條失敗，其他條會回滾 | ❌ **不會**（證據二） |
| 少幾次網路往返 | ✅ **這是它唯一的目的** |

> 📌 **pipeline 是一個「網路優化」，不是「一致性工具」。**
> 需要原子性請往 05 章：`MULTI/EXEC`（但它也不回滾）與 **Lua**（才是真的原子）。

### 3.8.4 一批打包幾條

pipeline 不是愈大愈好。寫 10 萬筆，用不同的批次大小：

| 一批幾條 | 幾批 | 耗時 | 吞吐 |
|---|---|---|---|
| 1 | 100,000 | **14,235 ms** | 7,024 次/秒 |
| 10 | 10,000 | 1,616 ms | 61,881 次/秒 |
| **100** | 1,000 | **541 ms** | 184,842 次/秒 |
| **1,000** | 100 | **399 ms** | 250,626 次/秒 |
| 10,000 | 10 | 378 ms | 264,550 次/秒 |
| 100,000 | 1 | 377 ms | 265,251 次/秒 |

**從 1 到 100，快了 26 倍。從 1,000 到 100,000，只快了 6%。**

> 📌 **建議：一批 100～1,000 條。**
>
> 再往上不但沒有收益，還要付兩個代價：
> - **Redis 那一側**：一個 pipeline 裡的命令是**連續執行完才回應的**——
>   一批十萬條就是一段長長的「別人插不進來」的時間（回到 3.3 的排隊問題）。
> - **你這一側**：所有回應要一起收下來放進記憶體（02 章 2.10.2 的 269 MB 是同一個問題）。

⚠️ **`executePipelined` 會把「每一條命令的回應」收集成一個 `List` 回傳給你。**
如果你不需要那些回應（例如純粹批次寫入），它仍然會建那個 List——
十萬條就是十萬個物件。**這是分批的另一個理由。**

---

## 3.9 落地：shop-service 的慢命令防線

這一章不加新的資料結構，加的是**三道防線**。

**第一道：Redis 端的設定**

```bash
# 慢命令記錄：門檻從 10 毫秒收到 5 毫秒，保留量從 128 加到 512
CONFIG SET slowlog-log-slower-than 5000
CONFIG SET slowlog-max-len 512

# 延遲事件監控：打開（預設是關的）
CONFIG SET latency-monitor-threshold 100

# 把「釋放記憶體」全部交給背景執行緒（3.4.2 ④）
CONFIG SET lazyfree-lazy-user-del yes
CONFIG SET lazyfree-lazy-expire yes
CONFIG SET lazyfree-lazy-eviction yes
CONFIG SET lazyfree-lazy-server-del yes
CONFIG SET lazyfree-lazy-user-flush yes
```

⚠️ **`CONFIG SET` 只改到記憶體裡，重啟就沒了。** 正式環境要寫進設定檔
（或 `CONFIG REWRITE`）——14 章 14.9.9 會給完整的 `redis.conf`。

**第二道：應用端的設定**

```yaml
spring:
  data:
    redis:
      timeout: 500ms          # 3.7.3 —— 先加這一行，06 章會補完另外兩層
```

```java
package com.example.lab10.ch03;

import org.springframework.boot.autoconfigure.data.redis.LettuceClientConfigurationBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 連線時報上名號，讓 SLOWLOG 的第 ⑥ 欄有內容（3.5.2） */
@Configuration
public class ClientNameConfig {
    @Bean
    LettuceClientConfigurationBuilderCustomizer clientName() {
        return builder -> builder.clientName("shop-service");
    }
}
```

**加上去之後，`CLIENT LIST` 與 `SLOWLOG` 都會認得你**：

```
id=865 addr=192.168.65.1:42362 ... name=shop-service age=0 idle=0 flags=N db=0 ...
```

```
1) 1) (integer) 7111356
   2) (integer) 1789547385
   3) (integer) 3
   4) 1) "GET"
      2) "k"
   5) "192.168.65.1:57199"
   6) "shop-service"          ← 這一欄現在有值了
```

**第三道：Code review 的檢查項**

| 看到這個 | 要問 |
|---|---|
| `redisTemplate.keys(...)` | **直接退回**（01 章 1.5.6） |
| `opsForHash().entries(...)` / `opsForSet().members(...)` | 「這個 key 最大會有幾個元素？」 |
| `opsForList().range(k, 0, -1)` | 同上 |
| `opsForZSet().range(k, 0, -1)` | 同上 |
| `sInter` / `sUnion` / `sDiff` | 「兩個集合各多大？能不能用 `SINTERCARD`？」 |
| 迴圈裡呼叫 Redis | 「能不能改成 `MGET` 或 pipeline？」（3.8.2 差 126 倍） |
| `delete(...)` 一個集合類的 key | 「改成 `unlink(...)`」（或打開 `lazyfree-lazy-user-del`） |

**第四道（給維運的）：三個該接告警的指標**

| 指標 | 從哪來 | 門檻 |
|---|---|---|
| **客戶端量到的 p99 延遲** | 應用埋點 ★ **最重要** | 超過平常的 10 倍 |
| `SLOWLOG LEN` 的成長速度 | `SLOWLOG LEN` 定期採集 | 一小時新增超過 N 筆 |
| `INFO commandstats` 裡 `usec` 最高的命令 | 定期採集，看排名有沒有變 | 排名第一的命令換人了 |

---

## 3.10 常見誤區

**① 「Redis 是單執行緒，所以它慢」**

單執行緒的 Redis 在這台筆電上跑到 **27 萬 rps**（00 章 0.5.1）。
它不慢，而且單執行緒換來了**每條命令都是原子的**——這是後面所有併發解法的基礎。

**② 「Redis 是單執行緒，所以它只有一個執行緒」**

實測有 **5 個**（3.2.1）。只是**執行命令**的只有一個。
`UNLINK` 快 160 倍，正是因為它把工作交給了 `bio_lazy_free`。

**③ 「`SLOWLOG` 是空的，代表 Redis 沒問題」**

3.3.2 實測：等了 1,799 毫秒的 `GET`，`SLOWLOG` 一筆都沒有。
**它不記排隊時間、不記網路時間、只留 128 筆。**

**④ 「監控圖表很平，代表沒事」**

3.7.2 實測：22 萬次請求裡有 20 次卡了 5 秒，**p50 與 p99 都是 0 毫秒**。
**平均值會把事故稀釋掉。要看的是最大值與逾時數。**

**⑤ 「Redis 出問題時，先進去 `redis-cli` 看一下」**

3.3.3 實測：Redis 卡住時 `PING`、`INFO`、`SLOWLOG`、`CLIENT LIST` **一起等了 2.7 秒**。
**你的監控會在最需要資料的那一刻斷線。**

**⑥ 「Redis 只是快取，掛了不影響主流程」**

3.7.2 實測：預設逾時 **60 秒**，20 個執行緒全部卡住，**零例外**。
在真實的 Tomcat 上，這叫執行緒池耗盡。

**⑦ 「pipeline 就是交易」**

3.8.3 實測：兩個 pipeline 交錯成 `ABBBAA`；裡面一條失敗、其他條照樣生效。
**而且 Spring 會拋 `RedisPipelineException`，讓你以為它回滾了。**

**⑧ 「pipeline 愈大愈好」**

3.8.4 實測：從 1,000 加到 100,000，只快 6%，
代價是「別人插不進來」的時間變長、以及你這一側的記憶體。**100～1,000 就夠了。**

**⑨ 「這條命令是 O(1)，所以很快」**

`GET` 一個 50 MB 的 value 是 **9,940 µs**（3.4.4 ②）。
**複雜度算的是「找」，不是「搬」。**

**⑩ 「`HGETALL` 只被呼叫幾次，不用管它」**

3.6.1 實測：**3 次** `HGETALL` 吃掉的主執行緒時間，跟 **20 萬次** `HSET` 一樣多。
**看 `commandstats` 的 `usec` 總和，不要看呼叫次數。**

---

## 3.11 本章小結

**一句話**：

> **Redis 用一個執行緒執行所有命令。所以「慢」在 Redis 上不是一個命令的問題，是所有人的問題。**

**四個推論**，每一個都有實測：

| 推論 | 實測 |
|---|---|
| 一條慢命令會變成所有人的延遲 | `DEBUG SLEEP 2` → 別人的 `GET` 等了 1,799 ms（3.3.1） |
| 這個延遲**不會**出現在 Redis 自己的記錄裡 | 那個 `GET` 不在 `SLOWLOG` 裡（3.3.2） |
| Redis 卡住時，你**看不到**它卡住 | 四個監控命令一起等 2,700 ms（3.3.3） |
| 你的應用會**安靜地**陪它一起卡 | 20/20 執行緒卡 5 秒，0 個例外（3.7.2） |

**兩個可以現在就做的事**：

1. **`spring.data.redis.timeout: 500ms`** —— 把「無聲的等待」變成「明確的失敗」（3.7.3）。
2. **`CONFIG SET lazyfree-lazy-user-del yes`** —— 所有 `DEL` 自動變 `UNLINK`（3.4.2 ④）。

### 3.11.1 驗收清單

- [ ] 說出 Redis 行程裡的 5 個執行緒，以及哪一個執行命令。
- [ ] 說出 `UNLINK` 為什麼比 `DEL` 快，並把它對到某一個執行緒的名字。
- [ ] 解釋 `io-threads` 分擔的是什麼、不分擔的是什麼。
- [ ] 說出 `SLOWLOG` 的三個盲點。
- [ ] 說出 `SLOWLOG`、`commandstats`、`latencystats`、`LATENCY`、客戶端埋點各自回答哪個問題。
- [ ] 說出 Lettuce 的預設命令逾時，以及它在 Tomcat 上的後果。
- [ ] 說出 pipeline 保證什麼、不保證什麼（四條）。
- [ ] 解釋為什麼「`executePipelined` 拋了例外」不代表「這批命令沒生效」。
- [ ] 在你自己的系統上跑一次 `INFO commandstats`，找出 `usec` 最高的那條命令。

### 3.11.2 本章練習

**練習一（15 分鐘）**：在你的專案裡找出所有「在迴圈裡呼叫 Redis」的地方。
挑一個改成 pipeline 或 `MGET`，**量改造前後的耗時**。
如果沒有這種地方，就自己寫一個 1,000 次 `get()` 的迴圈，量它、改它、再量一次。

**練習二（20 分鐘）**：重跑 3.7.2 的實驗，但把 `threads` 改成 200（模擬 Tomcat 的預設執行緒數），
並在 `DEBUG SLEEP` 期間用另一個執行緒**每 100 毫秒印一次「現在有幾個執行緒卡在 Redis 呼叫裡」**。
**你會看到一條從 0 衝到 200 的曲線。** 那就是執行緒池耗盡的形狀。

**練習三（15 分鐘）**：設 `slowlog-log-slower-than 0`（記錄每一條命令），
跑一次你的應用的正常流量，然後 `SLOWLOG GET -1` 匯出來，
**按命令分組統計總耗時**。跟 `INFO commandstats` 的結果對照——
兩者應該吻合。⚠️ 做完記得改回來（3.5.1 的警告）。

**練習四（進階，30 分鐘）**：寫一個 `SlowCommandReporter`：
定期（每分鐘）採集 `SLOWLOG GET -1` 與 `INFO commandstats`，
算出「這一分鐘內，每種命令的呼叫數、總耗時、最慢一次」，
並在「某種命令的總耗時佔比超過 50%」時印出警告。
⚠️ 記得處理 `SLOWLOG` 的環狀緩衝——**用第 ① 欄的流水號判斷有沒有漏看**（3.5.2）。

---

## 3.12 下一章預告

這一章一直在講「主執行緒被佔用」。下一章（04）講**另一種會讓 Redis 停住的東西：記憶體**。

- `maxmemory` 沒設會怎樣？**設了之後，八種淘汰策略到底差在哪？**
  00 章 0.3.2 那個被 LRU 吃掉的購物車，要在這一章才真正能解釋與修好。
- Redis 的 LRU **是近似的**——它不會真的找出「最久沒用的那一個」，
  而是隨機抽幾個挑最舊的。抽幾個？這個數字怎麼影響準確度？
- 記憶體碎片：00 章 0.4.4 看到的 `mem_fragmentation_ratio: 39.92` 是什麼意思，
  什麼時候該擔心、什麼時候不用。
- **持久化**：RDB 與 AOF 各會掉多少資料？我們會**真的拔掉電源**（`docker kill`）來量。
- 以及這一章留的伏筆：**`fork` 為什麼會讓主執行緒停住**，停多久跟什麼有關。
