# 第 04 章：記憶體、淘汰與持久化

> 03 章講的是「主執行緒被佔用」。這一章講**另外兩件會讓你的資料消失的事**：
> **記憶體滿了**，以及**Redis 重啟了**。
>
> 00 章 0.3.2 那個「自己不見的購物車」——工程師刻意不設 TTL，它還是消失了——
> 要到這一章才能真正解釋並修好。
>
> 這一章有四組實測：
>
> - **八種淘汰策略誰保住了熱門資料**：熱門的 1000 個 key，
>   `allkeys-lru` 存活 **99%**、`allkeys-lfu` 存活 **100%**、`allkeys-random` 存活 **55%**。
>   而 `volatile-lru` 在「沒有 key 設 TTL」時，**三萬筆寫入有兩萬三千筆直接失敗**。
> - **LRU 是近似的**：它不找「最久沒用的那一個」，而是隨機抽 5 個挑最舊的。
>   抽 3 個時準確度掉到 87%，抽 5 個是 99%，抽 10 個是 100%——**這解釋了預設值為什麼是 5**。
> - **`fork` 會讓主執行緒停住**，而且跟資料量成正比：
>   19 MB → **280 µs**，184 MB → **1,267 µs**，974 MB → **6,884 µs**。
> - **真的把容器 `docker kill` 掉，各種設定掉多少資料**：
>   不持久化掉 100%、RDB 掉「最後一次快照之後的全部」、AOF 掉 0 筆。
>
> ⚠️ 但最後那組實測有一個陷阱，4.7 會拆給你看：
> **`docker kill` 模擬的是「行程崩潰」，不是「拔電源」。** 兩者掉的資料不一樣。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 說出 `maxmemory` 不設會怎樣、設了搭配 `noeviction` 會怎樣，
  以及**記憶體滿的時候哪些命令還能用**（4.2）。
- 說出八種淘汰策略的兩個維度，並指出 `volatile-*` 最危險的失效情境（4.3.1、4.3.2）。
- 用實測數字說明 LRU、LFU、random 保住熱門資料的能力差多少（4.3.3）。
- 解釋 Redis 的 LRU 為什麼是「近似的」，以及 `maxmemory-samples` 該設多少（4.3.4）。
- 讀懂 `OBJECT FREQ` 與 `OBJECT IDLETIME`，並說出 LFU 計數器的上限（4.3.5）。
- 說明 `mem_fragmentation_ratio` 什麼時候有意義、什麼時候是雜訊（4.4）。
- 說出 RDB 與 AOF 各自的形狀、成本與**掉多少資料**（4.5、4.6）。
- 解釋 `fork` 為什麼會讓主執行緒停住，並估算你自己的 Redis 會停多久（4.5.3）。
- 說出 `appendfsync` 三個值的差別，以及**「行程崩潰」與「主機斷電」為什麼掉的資料不一樣**（4.6.2、4.7）。
- 回答「我的 Redis 只是快取，需要持久化嗎」——**而且知道這個問題有兩個答案**（4.8.2）。

---

## 4.2 `maxmemory`：不設會怎樣，設了會怎樣

### 4.2.1 不設 = 沒有上限

00 章 0.7.4 的第一份快照就看到了：

```
[一開始] keys=0  記憶體=1.04M  上限=0B  ...
```

**`maxmemory_human: 0B` 的意思不是「上限 0」，是「沒有上限」。**

沒有上限的 Redis 會一路長到作業系統受不了，然後：

| 環境 | 結局 |
|---|---|
| Linux 實體機／VM | **OOM killer 把 redis-server 殺掉**（`docker logs` 裡什麼都沒有，行程就不見了） |
| 容器有 memory limit | 容器被 kill，重啟後資料看持久化設定 |
| 機器有 swap | **更糟**：Redis 開始用 swap，每個操作變成磁碟 I/O，延遲從微秒變成毫秒，但沒死——服務「還活著但完全不能用」 |

> 📌 **所以第一條規則是：正式環境一定要設 `maxmemory`。**
> 設多少？**機器實體記憶體的 60～70%**——
> 剩下的要留給 4.5.3 的 `fork`（最壞情況下記憶體會短暫翻倍）、
> 以及 4.4 的碎片。

### 4.2.2 實測：設了上限，但用 `noeviction`

```bash
docker exec redis-lab redis-cli CONFIG SET maxmemory 16mb
docker exec redis-lab redis-cli CONFIG SET maxmemory-policy noeviction
# 寫入 3 萬筆 1KB 的資料
```

```
OOM command not allowed when used memory > 'maxmemory'.
  寫入 3 萬筆 1KB 之後：
used_memory_human:16.02M
maxmemory_human:16.00M
  DBSIZE = 7006                     ← 3 萬筆只寫進去 7006 筆
  再寫一筆會怎樣： OOM command not allowed when used memory > 'maxmemory'.
  讀取還可以嗎：   xxxxxxxxxxxxxxxxxxxx...      ← 可以
  刪除呢：         1                             ← 可以
```

**`noeviction` 的意思是「寧可拒絕寫入，也不刪任何東西」。**

### 4.2.3 ⚠️ 記憶體滿的時候，哪些命令還能用

這個分界很重要，因為它決定了你的服務會變成什麼樣子：

| 命令類型 | 記憶體滿時 | 例子 |
|---|---|---|
| **會增加記憶體的** | ❌ **拒絕**，回 `OOM command not allowed` | `SET`、`LPUSH`、`HSET`、`ZADD`、`INCR`（是的，連 `INCR` 都會被擋） |
| **不增加記憶體的** | ✅ 可以 | `GET`、`HGET`、`EXISTS`、`TTL` |
| **會減少記憶體的** | ✅ 可以 | `DEL`、`UNLINK`、`EXPIRE`、`FLUSHALL` |

> ⚠️ **注意 `INCR` 也會被擋。**
> 你的限流器（10 章）用 `INCR` 計數——**Redis 記憶體滿的那一刻，限流器開始拋例外**。
> 如果你的程式碼寫的是「限流檢查失敗就放行」，那**記憶體滿的同時，限流也失效了**。
>
> 這一類「A 壞掉導致 B 也壞掉」的連鎖，是 08 章降級設計要處理的主題。

📌 **在 Java 這一側，`OOM command not allowed` 是一個 `RedisSystemException`。**
它跟連線失敗、逾時是**不同的例外**，但很多人的 `catch (Exception e)` 把它們全部當成同一件事。

---

## 4.3 八種淘汰策略

### 4.3.1 兩個維度

八種策略其實是 **2 × 4 的組合**（再加一個 `noeviction`）：

| | **從「所有 key」挑** | **只從「有設 TTL 的 key」挑** |
|---|---|---|
| **最久沒用的**（LRU） | `allkeys-lru` | `volatile-lru` |
| **最少用的**（LFU） | `allkeys-lfu` | `volatile-lfu` |
| **隨機** | `allkeys-random` | `volatile-random` |
| **最快過期的** | —— | `volatile-ttl` |
| **不淘汰** | `noeviction`（預設） | |

```bash
docker exec redis-lab redis-cli CONFIG GET maxmemory-policy
```

```
maxmemory-policy: noeviction          ← Redis 的預設值
```

### 4.3.2 ⚠️ `volatile-*` 最危險的失效情境

`volatile-lru` 聽起來很安全：「只淘汰那些本來就會過期的 key，使用者資料不會被動到。」

**但如果沒有任何 key 設了 TTL 呢？**

```bash
docker exec redis-lab redis-cli CONFIG SET maxmemory 16mb
docker exec redis-lab redis-cli CONFIG SET maxmemory-policy volatile-lru
# 寫入 3 萬筆（全部沒有 TTL）
```

```
errors: 23000, replies: 30000          ← 三萬筆有兩萬三千筆失敗
  DBSIZE = 7000
  再寫一筆： OOM command not allowed when used memory > 'maxmemory'.
```

> ⚠️ **`volatile-*` 在「找不到可以淘汰的 key」時，行為完全等同 `noeviction`。**
>
> 這件事的危險在於它的**發生時機**：
> 你設了 `volatile-lru`，上線初期所有快取都有 TTL，一切正常。
> 三個月後有人加了一個「不該過期」的功能（購物車、Session、某張設定表）……
> **然後某一天記憶體滿了，而那些有 TTL 的 key 剛好都還沒滿足淘汰條件**——
> **整台 Redis 的寫入全部開始失敗。**

### 4.3.3 實測：誰保住了熱門資料

實驗設計：

1. 放 5,000 個 key（各 1 KB）。
2. **等 3 秒**（讓 LRU 時鐘前進——見 4.3.4）。
3. 把**前 1,000 個**讀 20 遍，讓它們成為「熱門資料」。
4. 把 `maxmemory` 設成當下用量，再寫 3,000 個新 key 逼它淘汰。
5. 數熱門的 1,000 個活下來幾個。

```
  allkeys-lru      samples=5   熱門 1000 個存活  994 ( 99%)   冷門 4000 個存活  985 ( 25%)
  allkeys-lfu      samples=5   熱門 1000 個存活  998 (100%)   冷門 4000 個存活 1961 ( 49%)
  allkeys-random   samples=5   熱門 1000 個存活  553 ( 55%)   冷門 4000 個存活 2211 ( 55%)
```

**三個結論**：

| 策略 | 熱門存活 | 解讀 |
|---|---|---|
| `allkeys-lru` | **99%** | 幾乎完美地保住了熱門資料 |
| `allkeys-lfu` | **100%** | 更好——因為它看的是「用了幾次」，不是「多久沒用」 |
| `allkeys-random` | **55%** | **跟冷門資料的 55% 一模一樣**——它根本不分辨 |

> 📌 **`allkeys-random` 的 55% 就是「完全隨機」的數學期望值。**
> 它唯一的優點是快（不用取樣、不用比較）。
> **只有在「所有 key 一樣重要」時才用它**——而那種情況比你想的少。

### 4.3.4 LRU 是**近似的**

上面的實驗有一個刻意的步驟：**第 2 步要等 3 秒**。

我第一次跑這個實驗時沒有等，結果是：

```
  allkeys-lru      熱門 1000 個活了 560 個 (56%)     ← 跟 random 一樣
  allkeys-random   熱門 1000 個活了 549 個 (55%)
```

**因為 5,000 個 key 是在同一秒內建立的、也在同一秒內被讀取——
它們的 LRU 時間戳全部一樣，LRU 無從分辨。**

Redis 的 LRU 有兩個「近似」：

| 近似 | 說明 |
|---|---|
| **時間戳的解析度很粗** | 每個 key 只存一個 24 位元的時鐘值，**解析度是秒**。同一秒內的操作分不出先後 |
| **它不掃全部，只抽樣** | 淘汰時隨機抽 `maxmemory-samples` 個 key，**從這幾個裡面挑最舊的** |

第二點可以直接量：

```
  allkeys-lru      samples=3    熱門 1000 個存活  869 ( 87%)
  allkeys-lru      samples=5    熱門 1000 個存活  986 ( 99%)      ← 預設值
  allkeys-lru      samples=10   熱門 1000 個存活 1000 (100%)
  allkeys-lru      samples=50   熱門 1000 個存活 1000 (100%)
```

> 📌 **這張表解釋了 `maxmemory-samples` 的預設值為什麼是 5**：
> **抽 5 個就有 99% 的準確度，抽 10 個是 100%，再往上沒有收益。**
> 而每多抽一個，每次淘汰就多一次隨機取樣的成本——**而淘汰是在主執行緒上做的**（03 章）。
>
> **要調的話調到 10，不要再高。** 官方文件的說法也是這樣。

📌 **`OBJECT IDLETIME` 讓你看到 LRU 眼中的世界**（只在 LRU 策略下可用）：

```
  剛建立      OBJECT IDLETIME = 0 秒
  3 秒後      OBJECT IDLETIME = 3 秒
  讀一次之後  OBJECT IDLETIME = 0 秒
```

### 4.3.5 LFU：一個會衰減的對數計數器

LFU 看的是「**被用了幾次**」，而不是「多久沒用」。它的計數器很有意思：

```bash
docker exec redis-lab redis-cli CONFIG SET maxmemory-policy allkeys-lfu
docker exec redis-lab redis-cli SET k v
docker exec redis-lab redis-cli OBJECT FREQ k
```

```
  剛建立            OBJECT FREQ = 5       ← 起始值不是 0
  再讀 10      次   OBJECT FREQ = 6
  再讀 100     次   OBJECT FREQ = 8
  再讀 1000    次   OBJECT FREQ = 20
  再讀 10000   次   OBJECT FREQ = 51
  再讀 100000  次   OBJECT FREQ = 150
```

**讀了 11 萬次，計數器只到 150。** 因為：

| 特性 | 說明 |
|---|---|
| **它是對數的** | 計數器只有 8 位元（最大 255）。存取次數愈多，加 1 的機率愈低——`lfu-log-factor`（預設 10）控制這條曲線 |
| **起始值是 5** | 新 key 不會因為「剛建立所以次數少」就馬上被淘汰 |
| **它會衰減** | `lfu-decay-time`（預設 1 分鐘）——每過一分鐘沒被存取，計數器減 1。**否則一個三年前很紅的 key 會永遠留著** |

> 📌 **LFU 比 LRU 好在哪**：
> 「有一支批次程式把整個資料庫掃過一遍」——
> LRU 眼中，那些被掃過的冷資料全都是「剛剛用過」，於是把真正的熱門資料擠掉了。
> **LFU 不會，因為那些冷資料只被用了一次。**
>
> **這個情境叫「快取污染」，而它在每天跑報表的系統上是常態。**

### 4.3.6 怎麼選

```
你的 Redis 上有「掉了就是資料遺失」的東西嗎？
├─ 有（Session、購物車、預扣的庫存…）
│   └─ ⚠️ 先問：它們為什麼跟快取放在同一台？
│       ├─ 可以分開 → 分成兩台，快取那台用 allkeys-lru / allkeys-lfu，
│       │              資料那台用 noeviction + 監控 + 告警
│       └─ 不能分開 → volatile-lru，
│                      並且 ⚠️ 確保「快取類」的 key 一定都有 TTL（4.3.2 的陷阱）
└─ 沒有，全部都是可以重算的快取
    └─ 有沒有「週期性的全表掃描」（報表、批次）？
        ├─ 有 → allkeys-lfu（抗快取污染）
        └─ 沒有 → allkeys-lru（最通用）
```

| 策略 | 什麼時候用 |
|---|---|
| `noeviction` | **放的是不能掉的資料**。搭配容量監控與告警——記憶體滿了要人來處理，不是讓 Redis 自己刪 |
| `allkeys-lru` | **純快取的預設選擇** |
| `allkeys-lfu` | 純快取，而且有批次掃描造成的快取污染 |
| `volatile-lru` / `volatile-lfu` | 快取與資料混在同一台（**不建議，但現實常常如此**），且**所有快取都有 TTL** |
| `volatile-ttl` | 優先淘汰「快要過期的」——語意最直覺，但它不管熱度 |
| `*-random` | 幾乎不用。除非你確定所有 key 一樣重要且要極致省 CPU |

### 4.3.7 回到 00 章 0.3.2 那個購物車

現在可以完整解釋它了：

```
那台 Redis:  maxmemory 32mb, maxmemory-policy allkeys-lru
購物車:      cart:alice，刻意不設 TTL
之後:        60,000 筆商品快取寫進來
結果:        evicted_keys = 36564，cart:alice 變成 null，而且沒有任何錯誤
```

| 錯在哪 | 該怎麼做 |
|---|---|
| **把「可重算的快取」跟「使用者資料」放在同一台** | 分開。這是根本解 |
| 用了 `allkeys-lru`——它會從**所有** key 裡挑 | 不能分開時改 `volatile-lru`，並確保快取都有 TTL |
| 購物車不設 TTL，以為這樣就不會消失 | **TTL = -1 只保證「不會因為時間消失」，不保證「不會因為記憶體消失」**（01 章 1.4.2） |
| 購物車「很久沒被碰」正是 LRU 最愛挑的 | LFU 也救不了——它同樣是低頻的 |
| **沒有監控 `evicted_keys`** | **這是最該補的一條**（00 章 0.4.4） |

> 📌 **一句話**：
> **`evicted_keys` 從 0 變成非 0 的那一刻，代表「有資料在你不知道的情況下被刪掉了」。**
> 它應該是這一站最先接上告警的指標。

---

## 4.4 記憶體碎片

### 4.4.1 三個數字，不是一個

00 章 0.4.4 看過這一組，當時說「之後再解釋」：

```
used_memory_human:1019.25K       ← Redis 認為自己配置出去的
used_memory_rss_human:38.27M     ← 作業系統看到這個行程佔的實體記憶體
mem_fragmentation_ratio:39.92    ← rss / used
```

**這三個數字之間隔著一層：記憶體配置器（jemalloc）。**

```
   你的資料  ←→  Redis（used_memory）  ←→  jemalloc  ←→  作業系統（rss）
                                            ↑
                                    它跟作業系統要的是「大塊」，
                                    切給 Redis 的是「小塊」，
                                    Redis 還回來的小塊它不一定還給作業系統
```

Redis 7 把這一層拆得更細：

| 欄位 | 意思 |
|---|---|
| `used_memory` | Redis 要求配置的總量 |
| `allocator_allocated` | jemalloc 實際配置出去的 |
| `allocator_active` | jemalloc 佔著的「活躍頁」 |
| `allocator_resident` | jemalloc 向作業系統要到的 |
| `used_memory_rss` | 作業系統看到的（含 Redis 程式碼本身、堆疊等） |
| **`allocator_frag_ratio`** | `active / allocated`——**真正的「配置器碎片」** |
| `mem_fragmentation_ratio` | `rss / used`——**包含了一堆跟碎片無關的東西** |

### 4.4.2 實測：刪掉一半資料之後

```
① 空的：           used=1.22M    rss=68.85M    frag_ratio=58.43   alloc_frag=7.32
② 放 50 萬筆：      used=153.93M  rss=215.98M   frag_ratio=1.41    alloc_frag=1.04
③ 隔一個刪一個：    used=79.61M   rss=216.85M   frag_ratio=2.73    alloc_frag=2.03
   （DBSIZE 從 500,000 變成 250,000）
⑤ FLUSHALL 之後：   used=1.26M    rss=90.31M    frag_ratio=72.57   alloc_frag=23.80
```

**三件事要一起看**：

| 觀察 | 意義 |
|---|---|
| **① 跟 ⑤ 的 `frag_ratio` 是 58 和 72** | ⚠️ **記憶體很小的時候，這個比值是雜訊**。分母只有 1 MB，而 Redis 程式碼本身就佔了幾十 MB |
| **③ 的 `rss` 完全沒降**（215.98M → 216.85M） | **刪掉 25 萬個 key，作業系統看到的記憶體一點都沒少**。那些空間留在 jemalloc 手上 |
| ③ 的 `alloc_frag` 從 1.04 升到 2.03 | **這才是真正的碎片訊號**：配置器佔著兩倍於實際需要的空間 |

> 📌 **所以看碎片要看 `allocator_frag_ratio`，不要看 `mem_fragmentation_ratio`。**
> 而且**只在 `used_memory` 夠大（至少幾百 MB）時才有意義**。
>
> **什麼時候該擔心**：`allocator_frag_ratio > 1.5` 而且 `used_memory` 是 GB 等級。
> 典型的成因就是 ③ 這種「大量寫入後又大量刪除」的模式。

### 4.4.3 `activedefrag`：以及它為什麼「沒生效」

Redis 可以在執行期間自己整理碎片：

```bash
docker exec redis-lab redis-cli CONFIG SET activedefrag yes
```

**我第一次打開它，等了 40 秒，什麼都沒發生**：

```
  打開前           used=79.63M  rss=216.56M  alloc_frag=2.03
  activedefrag 開了 40 秒  used=79.61M  rss=216.68M  alloc_frag=2.03   active_defrag_hits=0
```

`active_defrag_hits` 一直是 0。查下去才發現原因：

```
  allocator_frag_bytes      = 85,683,952    （82 MB 的碎片）
  active-defrag-ignore-bytes = 104,857,600   （門檻是 100 MB）
```

**碎片量還沒到門檻，所以 `activedefrag` 什麼都不做。** 把門檻降到 10 MB 再試：

```
  開啟前   used=79.62M  rss=216.68M  alloc_frag=2.02  frag_bytes=85,683,952
  10 秒後  used=79.62M  rss=216.81M  alloc_frag=1.20  frag_bytes=16,899,576  hits=648,943
  20 秒後  used=79.62M  rss=208.42M  alloc_frag=1.20
  40 秒後  used=79.62M  rss=151.47M  alloc_frag=1.20
```

**碎片比從 2.02 降到 1.20，rss 從 216 MB 降到 151 MB。**

| 設定 | 預設 | 意思 |
|---|---|---|
| `activedefrag` | `no` | 總開關 |
| `active-defrag-ignore-bytes` | **100 MB** | **碎片沒超過這個量就不做**（就是上面那個「沒生效」的原因） |
| `active-defrag-threshold-lower` | 10（%） | 碎片比例低於這個就不做 |
| `active-defrag-threshold-upper` | 100（%） | 超過這個就全力做 |
| `active-defrag-cycle-min` / `-max` | 1 / 25（%） | **它能吃掉多少 CPU**——上限 25%，跟 01 章主動過期的煞車是同一個設計 |

> ⚠️ **兩個前提**：
> ① **只有用 jemalloc 編譯的 Redis 支援**（`INFO memory` 的 `mem_allocator` 要是 `jemalloc-*`）。
> 官方 Docker 映像是 jemalloc，但某些 Linux 發行版的套件是 libc——**那個版本打開了也沒用**。
> ② **它要花 CPU，而那是主執行緒的 CPU**（03 章）。碎片沒有真的造成問題就不要開。

📌 **另一個「解決」碎片的辦法是重啟**（RDB / AOF 載入會把記憶體重新緊密排好）。
聽起來粗暴，但在有主從架構時（13 章）這是標準操作：先切換、再重啟舊的那台。

---

## 4.5 持久化（一）：RDB 快照

### 4.5.1 它是什麼

**RDB = 把當下整個資料集寫成一個二進位檔案。** 像拍一張照片。

| | |
|---|---|
| 檔案 | `dump.rdb`（單一檔案） |
| 觸發 | `SAVE`（⚠️ 同步，會卡住整台）、`BGSAVE`（背景）、`save` 設定自動觸發、正常關機時 |
| 優點 | **檔案小、載入快**、適合備份與傳輸 |
| 缺點 | **兩次快照之間的資料會掉** |

### 4.5.2 `save` 設定

```
save 900 1        ← 900 秒內至少 1 個 key 變更，就存一次
save 300 10       ← 300 秒內至少 10 個變更
save 60 10000     ← 60 秒內至少 10000 個變更
```

這三行是 Redis 的預設值（**多個條件是「或」的關係，滿足任一個就存**）。
本課的實驗容器用 `--save ""` 把它關掉了（00 章 0.4.1）。

⚠️ **看懂這組預設值代表什麼**：
一台每分鐘只有幾百次寫入的 Redis，**最久可能 15 分鐘才存一次**——
也就是**最多掉 15 分鐘的資料**。

### 4.5.3 實測：`fork` 讓主執行緒停多久

`BGSAVE` 的「BG」是靠 `fork` 一個子行程做到的。子行程在背景慢慢寫檔案，主執行緒繼續服務。

**但 `fork` 這個動作本身會讓主執行緒停住**——它要複製行程的頁表。

```bash
docker exec redis-persist redis-cli BGSAVE
docker exec redis-persist redis-cli INFO stats | grep latest_fork_usec
```

| 資料量 | 記憶體 | **`fork` 耗時** | 整個 `BGSAVE` |
|---|---|---|---|
| 100,000 個 key | 19.44 MB | **280 µs** | < 1 秒 |
| 1,000,000 個 key | 184.41 MB | **1,267 µs** | < 1 秒 |
| 5,000,000 個 key | 974.32 MB | **6,884 µs** | 2 秒 |

**大約每 GB 記憶體，`fork` 要 7 毫秒。**

> 📌 **拿這個數字去估你自己的 Redis**：
> - 8 GB 的 Redis → `fork` 大約停 **56 毫秒**。
> - 32 GB 的 Redis → 大約停 **220 毫秒**。
>
> 而且這個停頓 **`SLOWLOG` 看不到**（03 章 3.4.4 ③）——要用 `LATENCY LATEST` 的 `fork` 事件看。

⚠️ **`fork` 還有第二個成本：記憶體。**
`fork` 用的是「寫入時複製」（copy-on-write）——子行程一開始跟父行程共用同一份記憶體頁，
**但父行程每改一個頁，那個頁就要複製一份**。

**所以在 `BGSAVE` 期間，如果寫入量很大，記憶體可能接近翻倍。**
這就是 4.2.1 說「`maxmemory` 設成實體記憶體的 60～70%」的原因。

📌 **雲端環境要特別注意**：很多虛擬化環境的 `fork` 比實體機慢很多
（因為頁表複製在虛擬化層有額外成本）。**`latest_fork_usec` 要在你自己的環境量。**

### 4.5.4 實測：拔掉電源，RDB 掉多少

用 `docker kill`（SIGKILL）模擬「Redis 突然死掉」：

```bash
docker run -d --name redis-persist redis:7.2 redis-server --save "5 100" --appendonly no
# 寫入 10 萬筆，等 8 秒讓 save 5 100 觸發
# 快照之後再寫 5000 筆
docker kill redis-persist && docker start redis-persist
```

```
  寫了 10 萬筆，等 8 秒讓 save 5 100 觸發...
  rdb_changes_since_last_save:0          ← 快照做完了
  快照後再寫 5000 筆（這些還沒進快照）
  拔電源前共 105000 筆（其中 5000 筆是快照之後寫的）
  重啟後 100,000 筆 → 遺失 5,000 筆（正好是最後一次快照之後寫入的那些）
```

**掉的正好是「最後一次快照之後的全部」。** 這就是 RDB 的語意。

```
  ① 完全不持久化                   拔電源前 101,000 筆 → 重啟後       0 筆   遺失 100.0%
  ② RDB save 3600 1               拔電源前 101,000 筆 → 重啟後       0 筆   遺失 100.0%
```

⚠️ **② 為什麼也是 100%**：`save 3600 1` 代表「一小時才存一次」，
而實驗只跑了幾秒——**快照一次都還沒發生**。
**「我有開 RDB」不等於「我有資料」，要看 `save` 設定與最後一次快照的時間。**

📌 **對照組：正常關機**

```
  docker stop（SIGTERM）    關機前 100,000 筆 → 重啟後 100,000 筆   遺失 0 筆
```

**Redis 收到 `SIGTERM` 會先存一次再退出。**
所以「重新部署」「滾動更新」這種**計畫內**的重啟不會掉資料——
掉資料的是**計畫外**的那種。

---

## 4.6 持久化（二）：AOF

### 4.6.1 它是什麼

**AOF = 把每一條「改變資料的命令」追加寫進一個檔案。** 像記帳本。
重啟時把整本帳重放一次，就回到當時的狀態。

**Redis 7 的 AOF 不是一個檔案，是一個目錄**：

```bash
docker exec redis-persist ls -la /data/appendonlydir/
```

```
-rw------- 1 redis redis      89 appendonly.aof.1.base.rdb    ← 基準（RDB 格式！）
-rw------- 1 redis redis 3777813 appendonly.aof.1.incr.aof    ← 增量（命令）
-rw------- 1 redis redis      88 appendonly.aof.manifest      ← 清單
```

| 檔案 | 內容 |
|---|---|
| `*.base.rdb` | **基準快照**，用 RDB 格式存（因為 `aof-use-rdb-preamble: yes`） |
| `*.incr.aof` | 基準之後的每一條寫入命令 |
| `*.manifest` | 目前有哪些檔案、順序是什麼 |

📌 **這個設計把 RDB 與 AOF 的優點合在一起**：
載入時先讀一個緊湊的 RDB 基準（快），再重放少量增量命令（新）。

### 4.6.2 `appendfsync`：三個值，三種取捨

**這裡有一個關鍵的分界，先講清楚**：

```
   Redis  --write()-->  作業系統的 page cache  --fsync()-->  磁碟
            ↑                                      ↑
      每次事件迴圈都做                    appendfsync 控制的是這一步
```

| `appendfsync` | `fsync` 的頻率 | 主機斷電最多掉 | 效能 |
|---|---|---|---|
| `always` | **每一條寫入命令** | **一條命令** | 最慢（每次寫入都要等磁碟） |
| **`everysec`** | **每秒一次** | **1 秒** | **預設，也是幾乎所有人該用的** |
| `no` | **交給作業系統決定**（通常 30 秒） | 可能 30 秒以上 | 最快 |

### 4.6.3 實測：AOF 會長多大、`BGREWRITEAOF` 做什麼

```
  寫 10 萬筆之後：
    appendonly.aof.1.incr.aof = 3,777,813 bytes（3.78 MB）
    資料本身佔記憶體 = 8.72 MB

  對同一個 key 寫 10 萬次（DBSIZE 只多 1）：
    整個 appendonlydir = 7.2 MB           ← ⚠️ 資料沒變多，帳本變兩倍
```

**AOF 記的是「發生過什麼」，不是「現在是什麼」。**
同一個 key 被改 10 萬次，AOF 就有 10 萬筆記錄。

`BGREWRITEAOF` 解決這件事——**它產生一份「等價但最短」的新帳本**：

```bash
docker exec redis-persist redis-cli BGREWRITEAOF
```

```
  重寫後：整個 appendonlydir = 1.6 MB     ← 從 7.2 MB 降下來
    appendonly.aof.2.base.rdb = 1,577,902
    appendonly.aof.2.incr.aof = 0
```

**自動重寫的設定**：

```
auto-aof-rewrite-percentage  100        ← AOF 比上次重寫後大了一倍，就重寫
auto-aof-rewrite-min-size    64mb       ← 但至少要 64 MB 才考慮
```

⚠️ **`BGREWRITEAOF` 也要 `fork`**（4.5.3），所以它也有那個停頓與記憶體翻倍的風險。

### 4.6.4 實測：拔掉電源，AOF 掉多少

```
  ④ AOF appendfsync everysec   拔電源前 101,000 筆 → 重啟後 101,000 筆   遺失 0 筆
  ⑤ AOF appendfsync always     拔電源前 101,000 筆 → 重啟後 101,000 筆   遺失 0 筆
  ⑥ AOF appendfsync no         拔電源前 101,000 筆 → 重啟後 101,000 筆   遺失 0 筆
```

**三個都是零遺失。連 `appendfsync no` 都是。**

**這個結果是對的，但它不是你以為的意思。** 下一節解釋。

---

## 4.7 ⚠️ `docker kill` 不等於拔電源

上一節的實驗用 `docker kill` 送 `SIGKILL`——**它殺掉的是 Redis 這個行程**。

但 4.6.2 那張圖裡，資料有兩段路：

```
   Redis  --write()-->  作業系統的 page cache  --fsync()-->  磁碟
          ↑ 每次事件迴圈都做                    ↑ appendfsync 控制
          └── 行程死掉會失去的是「還沒 write() 的」
                                                └── 斷電會失去的是「還沒 fsync() 的」
```

| 故障類型 | 失去什麼 | `appendfsync` 有差嗎 |
|---|---|---|
| **行程崩潰**（`docker kill`、OOM killer、segfault） | 只失去「Redis 還沒 `write()` 出去的」——**幾乎是零**，因為每次事件迴圈都會 write | ❌ **沒差**，所以三個值都是零遺失 |
| **主機斷電 / 核心 panic** | 失去「還在 page cache、沒 `fsync()` 到磁碟的」 | ✅ **差很多**：`always` 掉一條、`everysec` 掉 1 秒、`no` 可能掉 30 秒 |

> 📌 **所以 4.6.4 的實驗證明的是**：
> **「Redis 行程掛掉」這種故障，開了 AOF 就幾乎不會掉資料，連 `appendfsync no` 都一樣。**
>
> **它沒有證明的是**：`appendfsync no` 在斷電時也安全。**那要拔真的電源才測得出來。**

⚠️ **這一節本身是一個方法論的教訓**：
**做可靠性實驗時，要先確認「你模擬的故障」跟「你擔心的故障」是同一種。**
`docker kill`、`docker stop`、`kill -9`、拔網路線、拔電源——**這四件事會掉的資料完全不同**。

📌 **實務上怎麼判斷你該擔心哪一種**：

| 環境 | 最常見的故障 | 建議 |
|---|---|---|
| 雲端託管（ElastiCache 等） | 節點替換、故障轉移 | 這是雲端供應商的事，你選的是「有沒有多可用區」 |
| 自建 VM | VM 重開、行程被 OOM killer 殺 | **行程崩潰居多** → `everysec` 綽綽有餘 |
| 實體機 | 電源、硬體故障 | `everysec` 掉 1 秒；不能接受就 `always`（但吞吐會掉很多） |

---

## 4.8 所以，你的 Redis 需要哪一種

### 4.8.1 四種組合

| 組合 | 掉多少（行程崩潰） | 掉多少（斷電） | 重啟載入速度 | 適合 |
|---|---|---|---|---|
| **都不開** | **全部** | **全部** | 最快（沒東西要載） | 純快取，且重啟後的冷啟動可接受（見 4.8.2） |
| **只有 RDB** | 最後一次快照之後的全部 | 同左 | 快 | 可容忍掉幾分鐘的資料；主要當備份用 |
| **只有 AOF（everysec）** | 幾乎 0 | **1 秒** | 較慢（要重放） | **大多數需要持久化的場景** |
| **RDB + AOF** | 幾乎 0 | 1 秒 | 較慢 | 要 AOF 的安全 ＋ RDB 的備份與傳輸便利 |

📌 **Redis 7 的 AOF 已經內含 RDB 基準檔**（4.6.1），
所以「只開 AOF」其實已經有一份 RDB 格式的快照了。
**額外開 RDB 的理由主要是「定期產生一個可以搬走的備份檔」。**

### 4.8.2 「快取不需要持久化」什麼時候是錯的

這句話有兩個答案，取決於你問的是**資料**還是**流量**。

**從資料看：對的。** 快取掉了可以重算，這就是快取的定義。

**從流量看：可能是災難。**

```
    Redis 重啟（不持久化）
        ↓
    快取全空
        ↓
    所有請求都變成「快取沒命中」
        ↓
    全部打到資料庫
        ↓
    資料庫 QPS 從 200 變成 8000
        ↓
    資料庫倒了 → 整站 503
```

**這叫「快取雪崩」的一種——冷啟動雪崩。** 07 章會完整處理它，
但選擇持久化設定的時候就要先想到：

| 問題 | 如果答案是「不行」 |
|---|---|
| 快取全空時，你的資料庫扛得住嗎？ | → **需要持久化**（讓重啟後快取還在） |
| 你能接受重啟後幾分鐘的高延遲嗎？ | → 需要持久化，或需要「預熱」機制 |
| 你的快取是不是「算一次很貴」的東西？ | → 需要持久化 |

> 📌 **一個實用的折衷**：
> **只開 RDB、`save` 設得寬鬆一點**（例如 `save 300 10000`）。
> 你不在乎掉幾分鐘的快取內容（反正是快取），
> **但你在乎「重啟後有 95% 的快取還在」**——這樣資料庫就不會被打爆。
>
> **這是「為了流量而持久化」，不是「為了資料而持久化」。** 兩者的設定取捨不同。

---

## 4.9 落地：shop-service 的記憶體與持久化

### 4.9.1 兩台 Redis，不是一台

4.3.6 的決策樹指向一個結論：**把快取跟資料分開**。

| | **快取那台** | **狀態那台** |
|---|---|---|
| 放什麼 | 商品快取、查詢結果 | Session、購物車、限流計數、分散式鎖 |
| `maxmemory` | 實體記憶體的 60% | 實體記憶體的 60% |
| `maxmemory-policy` | **`allkeys-lru`** | **`noeviction`** |
| 持久化 | **RDB（`save 300 10000`）** —— 為了重啟後不打爆資料庫（4.8.2） | **AOF `everysec`** |
| 掉資料的後果 | 資料庫壓力上升 | **使用者的東西不見了** |
| 告警 | `evicted_keys` 的成長速度 | **`evicted_keys` > 0（應該永遠是 0）**、`used_memory / maxmemory` > 80% |

> 📌 **如果只能有一台**（很多團隊的現實）：
> `volatile-lru` ＋ **所有快取類 key 一律設 TTL**（01 章 1.7.4 的規約第 2 條），
> 並且**把 4.3.2 的陷阱寫進 code review 清單**。

### 4.9.2 實測：Java 這一側看到的兩種結局

```java
@Test
void whatOomLooksLikeInJava() {
    System.out.println("═══ 4.9.2 記憶體滿了，Java 這一側看到什麼 ═══");
    probe.flushAll();
    probe.config("maxmemory", "8mb");
    probe.config("maxmemory-policy", "noeviction");

    String payload = "x".repeat(1024);
    int written = 0;
    try {
        for (int i = 0; i < 100_000; i++) { redis.opsForValue().set("k:" + i, payload); written++; }
    } catch (Exception e) {
        Throwable root = e; while (root.getCause() != null) root = root.getCause();
        System.out.println("寫了 " + written + " 筆之後炸了：");
        System.out.println("  " + e.getClass().getName());
        System.out.println("  → " + root.getClass().getSimpleName() + ": " + root.getMessage());
    }
    System.out.println("這時候還能做什麼：");
    System.out.println("  GET     : " + (redis.opsForValue().get("k:1") != null ? "可以" : "失敗"));
    try { redis.opsForValue().increment("counter"); System.out.println("  INCR    : 可以"); }
    catch (Exception e) { System.out.println("  INCR    : ❌ 被擋了（限流器就是死在這裡）"); }
    System.out.println("  DEL     : " + (redis.delete("k:1") ? "可以" : "失敗"));
    System.out.println("  EXPIRE  : " + redis.expire("k:2", Duration.ofSeconds(60)));

    System.out.println("── 換成 allkeys-lru ──");
    probe.config("maxmemory-policy", "allkeys-lru");
    probe.flushAll();
    long evictedBefore = probe.infoLong("stats", "evicted_keys");
    for (int i = 0; i < 20_000; i++) redis.opsForValue().set("k:" + i, payload);
    System.out.println("  同樣寫 2 萬筆：一個例外都沒有");
    System.out.println("  DBSIZE       = " + probe.dbSize() + "（寫了 20,000 筆）");
    System.out.println("  evicted_keys = " + (probe.infoLong("stats", "evicted_keys") - evictedBefore) + " 個 key 被默默刪掉");
}
```

```
═══ 4.9.2 記憶體滿了，Java 這一側看到什麼 ═══
寫了 5017 筆之後炸了：
  org.springframework.data.redis.RedisSystemException
  → RedisCommandExecutionException: OOM command not allowed when used memory > 'maxmemory'.
這時候還能做什麼：
  GET     : 可以
  INCR    : ❌ 被擋了（限流器就是死在這裡）
  DEL     : 可以
  EXPIRE  : true

── 換成 allkeys-lru ──
  同樣寫 2 萬筆：一個例外都沒有
  DBSIZE       = 4968（寫了 20,000 筆）
  evicted_keys = 15032 個 key 被默默刪掉
```

> ⭐ **這兩段輸出並排起來，就是這一章的全部。**
>
> | | `noeviction` | `allkeys-lru` |
> |---|---|---|
> | 寫入 | **失敗，拋例外** | **全部「成功」** |
> | 你知道出事了嗎 | **知道**（日誌、告警、監控都看得到） | **不知道** |
> | 資料 | 舊的都還在 | **15,032 筆不見了，而且不知道是哪些** |
>
> **這跟 03 章 3.7.3 的逾時是同一個取捨**：
> **你要一個會抱怨的系統，還是一個會默默吞掉問題的系統？**

### 4.9.3 五個該接告警的指標

| 指標 | 從哪來 | 門檻 | 為什麼 |
|---|---|---|---|
| **`evicted_keys`** | `INFO stats` | **狀態那台：> 0 就告警**；快取那台：成長速度異常 | 有資料在你不知道時被刪掉（00 章 0.3.2） |
| `used_memory / maxmemory` | `INFO memory` | > 80% | 還有時間處理 |
| `allocator_frag_ratio` | `INFO memory` | > 1.5 且 `used_memory` 是 GB 等級 | 碎片（4.4.2） |
| `rdb_last_bgsave_status` / `aof_last_bgrewrite_status` | `INFO persistence` | 不是 `ok` 就告警 | **持久化失敗時 Redis 不會停下來，它繼續服務**——你以為有備份其實沒有 |
| `latest_fork_usec` | `INFO stats` | 超過 100 ms | fork 停頓（4.5.3） |

⚠️ **第四條特別容易被忽略。** 磁碟滿了、權限錯了、目錄不存在——
`BGSAVE` 失敗之後 Redis 只在日誌裡寫一行，**服務照跑**。
（更糟的是：`stop-writes-on-bgsave-error` 預設是 `yes`，
代表 **RDB 存檔失敗時 Redis 會拒絕所有寫入**——服務直接掛，但原因藏在一行日誌裡。）

---

## 4.10 常見誤區

**① 「`maxmemory` 沒設就是不限制，很好啊」**

不限制的結果是被 OOM killer 殺掉，或開始用 swap（更糟，4.2.1）。

**② 「設了 `volatile-lru` 比較安全，只會刪快取」**

沒有 key 有 TTL 時它等同 `noeviction`——**3 萬筆寫入有 2.3 萬筆失敗**（4.3.2）。

**③ 「LRU 會找出最久沒用的那個 key」**

它從隨機抽的 5 個裡面挑（4.3.4）。抽 3 個時準確度只有 87%。

**④ 「`mem_fragmentation_ratio` 是 39，碎片好嚴重」**

`used_memory` 只有 1 MB 的時候這個數字沒有意義（4.4.2）。
看 `allocator_frag_ratio`，而且要在記憶體夠大時才看。

**⑤ 「打開 `activedefrag` 就會整理碎片」**

還有一個 `active-defrag-ignore-bytes`（預設 100 MB）的門檻。
我第一次打開時 `active_defrag_hits` 一直是 0（4.4.3）。

**⑥ 「我有開 RDB，資料不會掉」**

要看 `save` 設定。`save 3600 1` 代表**最多掉一小時**（4.5.4 的實驗②掉了 100%）。

**⑦ 「`docker kill` 測過了，`appendfsync no` 也不掉資料」**

`docker kill` 是行程崩潰，不是斷電（4.7）。**你測的不是你擔心的那件事。**

**⑧ 「`BGSAVE` 是背景做的，不影響服務」**

`fork` 本身會停住主執行緒，974 MB 停了 **6,884 µs**（4.5.3），
而且寫入量大時記憶體可能翻倍。

**⑨ 「快取不需要持久化」**

從資料看對，**從流量看可能是災難**（4.8.2 的冷啟動雪崩）。

**⑩ 「持久化失敗了 Redis 會告訴我」**

它只寫一行日誌。而且 `stop-writes-on-bgsave-error: yes` 會讓它**拒絕所有寫入**（4.9.3）。

---

## 4.11 本章小結

**這一章講了兩種「資料會不見」的方式，而它們的共同點是：Redis 不會叫你。**

| 消失方式 | 觸發條件 | 你怎麼知道 |
|---|---|---|
| **被淘汰** | 記憶體滿 + `allkeys-*` 策略 | **只有 `evicted_keys` 這個指標** |
| **重啟後沒回來** | 持久化設定不足 + 非計畫性重啟 | 重啟後自己發現 |

**三個要記住的數字**：

| | |
|---|---|
| **`maxmemory` 設實體記憶體的 60～70%** | 留給 `fork`（可能翻倍）與碎片 |
| **`maxmemory-samples` 用 5 或 10** | 5 已經 99% 準確，10 是 100%，再高沒收益 |
| **`fork` 每 GB 約 7 ms** | 8 GB 的 Redis，每次 `BGSAVE` 停約 56 ms |

### 4.11.1 驗收清單

- [ ] 說出 `maxmemory` 不設的三種死法。
- [ ] 說出記憶體滿時哪些命令還能用、哪些不行，並指出 `INCR` 屬於哪一類。
- [ ] 畫出八種淘汰策略的 2×4 表格，並說出 `volatile-*` 的失效情境。
- [ ] 說明 Redis 的 LRU 為什麼是近似的（兩個原因）。
- [ ] 說出 `OBJECT FREQ` 的起始值、上限，以及它為什麼會衰減。
- [ ] 說出該看 `allocator_frag_ratio` 還是 `mem_fragmentation_ratio`，以及什麼時候兩者都不該看。
- [ ] 說出 RDB 與 AOF 各自掉多少資料，以及 `appendfsync` 三個值的差別。
- [ ] 解釋為什麼 `docker kill` 測不出 `appendfsync` 的差別。
- [ ] 回答「快取要不要持久化」——並說出兩個不同的判斷角度。

### 4.11.2 本章練習

**練習一（20 分鐘）**：重跑 4.3.3 的實驗，但把「熱門資料」的定義改成
「**最近 1 分鐘內被讀過的 500 個 key**」，並在中間插入一次「把全部 5000 個 key 掃一遍」
（模擬報表程式）。**比較 `allkeys-lru` 與 `allkeys-lfu` 的存活率**——
這就是 4.3.5 說的「快取污染」，你應該會看到 LFU 明顯勝出。

**練習二（15 分鐘）**：在你自己的機器上量 `latest_fork_usec`：
灌入 1 GB、2 GB、4 GB 的資料，各跑一次 `BGSAVE`。**畫出「記憶體 vs fork 耗時」的線**。
用這條線估算：你的正式環境 Redis 每次持久化會停多久？可以接受嗎？

**練習三（20 分鐘）**：4.7 說 `docker kill` 測不出斷電。
**想一個能在你的環境裡真的測出 `appendfsync` 差別的方法**
（提示：需要讓「page cache 裡的資料」消失——虛擬機的強制斷電、或 `echo 3 > /proc/sys/vm/drop_caches` 之外的手段）。
**如果想不出來，那就是一個重要的結論：你的環境測不出來，所以你只能相信文件。**

**練習四（進階，30 分鐘）**：寫一個 `MemoryGuard`：
每 10 秒採集一次 `used_memory` / `maxmemory` / `evicted_keys` / `allocator_frag_ratio`，
在以下情況印出警告：
① 記憶體使用率超過 80%；② `evicted_keys` 在這 10 秒內成長；
③ 碎片比 > 1.5 且 `used_memory` > 1 GB。
接著**加一個功能**：在 `evicted_keys` 成長時，用 `SCAN` 取樣 1000 個 key，
統計「哪個前綴的 key 最多」——**這樣告警發出來的時候，你就知道是誰在吃記憶體。**

---

## 4.12 下一章預告

第一部分剩最後一章（05），而它是整站的樞紐。

00 章 0.3.4 的超賣、02 章 2.4.4 掉的 198 次更新——**兩個事故是同一個形狀**：
**「讀出來、改、寫回去」中間有一道縫。**

下一章把 Redis 能封住這道縫的**三個工具**攤開比較：

- **pipeline**（03 章已經講過）：只是打包，**完全不保證原子**。
- **`MULTI` / `EXEC`**：中間別人插不進來——**但它失敗時不回滾**。
  實測：交易裡第二條命令錯了，第一條和第三條照樣生效，`INCR` 執行了兩次。
- **`WATCH`**：樂觀鎖。實測 200 個人搶 100 件，結果正確，**但總共重試了 5,440 次**。
- **Lua**：唯一真正的原子。同樣 200 個人搶 100 件，**賣出正好 100 件，0 次重試**，
  而且它能做到 `DECR` 做不到的事——「**要買 3 件，庫存不足就整筆不賣**」。

以及 Lua 的三個坑：
**一段跑 7 秒的腳本會讓其他人收到 `BUSY` 錯誤**、
**`SCRIPT KILL` 殺不掉「已經寫過資料」的腳本**（只能重啟整台），
以及**腳本中途出錯時，前面已經改掉的東西一樣不會回滾**。

**後面九章的分散式鎖、限流、預扣庫存，全部建立在那一章上。**
