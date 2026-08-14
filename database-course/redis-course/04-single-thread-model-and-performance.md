# 第 04 章：單執行緒模型、big key 與 hot key

> 前三章在教「用什麼」，這章開始教「為什麼會慢」。
> Redis 的效能問題有個很不直觀的特性：**它平時的 P99 延遲可能是 0.3 毫秒，但某一秒突然變成 5 秒。** 不是慢慢變差，是斷崖式的。原因幾乎總是同一個——單執行緒被某件事卡住了。
> 這章要建立的能力是：拿到一個「Redis 好像變慢了」的告警，你知道要看哪些指標、按什麼順序排查、以及找到 big key 或 hot key 之後該怎麼拆。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 精確說明「Redis 是單執行緒」到底指什麼，以及哪些部分其實是多執行緒。
- 解釋事件循環與 I/O 多工如何讓單執行緒支撐上萬連線。
- 說明 Redis 6.0 的 `io-threads` 做了什麼、沒做什麼。
- 列出 Redis 延遲的八個來源，並對每個給出排查方法。
- 定義 big key，用工具找出它，並說出三種拆解策略。
- 定義 hot key，用工具找出它，並說出四種解法。
- 說明 fork、AOF fsync、THP、swap 為什麼會造成毫秒到秒級的抖動。
- 用 `SLOWLOG`、`LATENCY`、`INFO commandstats` 完成一次完整的效能診斷。

---

## 4.2 「單執行緒」到底指什麼

這句話被講得太簡略，導致很多誤解。精確的說法是：

**Redis 用單一執行緒處理所有客戶端命令。但 Redis 這個行程有多個執行緒。**

Redis 從 4.0 開始就有背景執行緒（bio threads），負責這些工作：

| 背景工作 | 為什麼要放背景 |
|---------|--------------|
| 關閉檔案描述符（`bio_close_file`） | 關閉大檔案可能觸發磁碟 I/O，會阻塞 |
| AOF 的 fsync（`bio_aof_fsync`） | 刷盤是慢操作，不能讓主執行緒等 |
| 大物件的記憶體釋放（`bio_lazy_free`） | 釋放百萬元素的集合要花時間，這是 `UNLINK` 的實作基礎 |

6.0 之後又加了 I/O threads（第 4.4 節）。

所以完整的圖像是：

```text
Redis 行程
├── 主執行緒：事件循環 + 執行所有命令      <- 這裡是單執行緒
├── bio 執行緒 × 3：檔案關閉、AOF fsync、lazy free
└── io 執行緒 × N（6.0+，預設關閉）：網路讀寫的 socket I/O
```

**關鍵推論：因為命令執行是單執行緒，所以：**

1. **命令天然原子。** 這是 `INCR`、`HINCRBY`、`SETBIT` 能保證正確的根本原因，也是 Lua 腳本能提供原子性的基礎（第 07 章）。
2. **一個慢命令會卡住所有人。** 沒有並行執行，只有排隊。
3. **不需要鎖。** 省下大量開銷，也不會死鎖。
4. **無法用單一實例吃滿多核心。** 要用滿 CPU，標準做法是一台機器跑多個實例。

第 3 點和第 2 點是同一件事的兩面：**Redis 用「放棄併發執行」換來了「沒有鎖開銷 + 原子語意」。** 這個交易在「每個命令都極快」的前提下非常划算，一旦你破壞了這個前提（丟一個 O(N) 大命令進去），代價就會立刻顯現。

---

## 4.3 事件循環與 I/O 多工

「單執行緒怎麼同時服務一萬個連線？」答案是 I/O 多工（I/O multiplexing）。

### 沒有 I/O 多工會怎樣

最原始的伺服器寫法是「一個連線一個執行緒」：

```text
連線 1 -> 執行緒 1（大部分時間在等這個客戶端發資料）
連線 2 -> 執行緒 2（也在等）
...
連線 10000 -> 執行緒 10000
```

問題是：這一萬個執行緒絕大多數時間都在**等待**（客戶端還沒發下一個命令），但每個執行緒都要佔記憶體（預設 stack 通常是 MB 級），而且執行緒切換本身有開銷。一萬個執行緒，光切換就能吃掉大量 CPU。

### I/O 多工的做法

作業系統提供一個機制：**「我把這一萬個 socket 交給你，有任何一個可讀或可寫時通知我。」**

Linux 上這個機制是 `epoll`，macOS/BSD 是 `kqueue`，Solaris 是 `evport`，都不支援時退回 `select`。Redis 在 `ae.c` 裡把這些封裝成統一的事件抽象層，所以同一份程式碼能跑在各種平台上。

事件循環的邏輯大致是：

```text
while (伺服器還在跑) {
    // 一次系統呼叫，問作業系統「哪些 socket 有事了」
    events = epoll_wait(所有 socket, timeout)

    for (每個有事的 socket) {
        讀取命令
        執行命令              <- 全部在同一個執行緒依序執行
        把回應寫入輸出緩衝區
    }

    執行到期的時間事件（serverCron：過期清理、統計、RDB 檢查等）
}
```

一萬個連線裡，某個瞬間可能只有 50 個真的有命令進來。事件循環只處理這 50 個，剩下的 9950 個完全不佔用 CPU。

**這就是「單執行緒 + I/O 多工」能撐高併發的原因：瓶頸不在連線數，而在「每秒要執行多少命令」和「每個命令要花多久」。**

心智模型：

```text
多執行緒模型：一萬個服務員，各自守著一張桌子，大部分在發呆
Redis 模型：  一個超快的服務員 + 一個「哪桌舉手了」的通知系統
              舉手的桌子依序服務，沒舉手的完全不佔用他的時間

前提：每桌的需求都能在幾微秒內處理完
一旦有桌客人點了要煮十分鐘的菜（O(N) 命令），後面所有人都得等
```

### `--intrinsic-latency`：認識你的硬體底線

在排查延遲前，先知道你的機器本身能做到多好：

```bash
redis-cli --intrinsic-latency 60
# Max latency so far: 1 microseconds.
# ...
# Max latency so far: 87 microseconds.
```

這個測試**不連 Redis**，它只是在本機跑一個緊密迴圈量測作業系統的排程抖動。它告訴你「這台機器的延遲下限」。如果這個數字本身就有幾毫秒（常見於超賣的虛擬機或有吵鬧鄰居的雲主機），那 Redis 再怎麼優化也不可能更好——問題在基礎設施。

---

## 4.4 Redis 6.0 的 `io-threads`：它做了什麼

先說結論：**`io-threads` 只把「網路資料的讀寫與協定解析」多執行緒化，命令執行仍然是單執行緒。**

一個命令的完整處理流程可以拆成三段：

```text
1. 從 socket 讀取資料 + 解析 RESP 協定      <- 6.0 可以多執行緒
2. 執行命令（操作資料結構）                  <- 永遠單執行緒
3. 把回應序列化並寫入 socket                 <- 6.0 可以多執行緒
```

在高吞吐場景下，第 1 和第 3 步其實佔了相當比例的 CPU 時間（特別是 value 較大、或用 `MGET` 一次回傳大量資料時）。把它們分給多個執行緒，能提升整體吞吐。

### 怎麼開

```bash
# redis.conf
io-threads 4
io-threads-do-reads yes    # 預設只多執行緒化「寫」，這個開關讓「讀」也多執行緒化
```

或動態設定（部分版本需要重啟）：

```bash
CONFIG SET io-threads 4
```

### 該不該開

官方建議與實務經驗：

- **`io-threads 1` 是預設值，代表關閉。** 多數場景不需要開。
- **建議值不要超過 CPU 核心數，通常 4 個以內就夠。** 開太多反而因為同步開銷變慢。
- **只有在「網路 I/O 成為瓶頸」時才有幫助。** 判斷方式：`INFO cpu` 顯示 CPU 使用率接近單核心上限（100%），但 `SLOWLOG` 沒有慢命令——這代表時間花在協定處理而非命令執行。
- **如果你的瓶頸是慢命令或 big key，開 `io-threads` 完全沒用。** 因為那是第 2 步的問題。

**一個常見的誤解是「開了 io-threads，Redis 就變多執行緒了，慢命令不會阻塞了」——完全不是。** 慢命令照樣卡住所有人。

實務優先順序：

```text
1. 先修慢命令與 big key（效果最大）
2. 再考慮多實例分片（真正用滿多核心）
3. 最後才是 io-threads（邊際優化）
```

---

## 4.5 延遲的八個來源

拿到「Redis 變慢」的告警時，按這個清單排查：

| # | 來源 | 典型症狀 | 排查工具 |
|---|------|---------|---------|
| 1 | 慢命令 | 特定時刻延遲飆高，且有規律 | `SLOWLOG GET` |
| 2 | big key | 操作某些 key 特別慢 | `--bigkeys`、`--memkeys` |
| 3 | hot key | 某個節點 QPS 遠高於其他節點 | `--hotkeys`、`MONITOR` 抽樣 |
| 4 | fork（RDB / AOF 重寫 / 全量同步） | 每隔固定時間出現尖峰 | `INFO stats` 的 `latest_fork_usec` |
| 5 | AOF fsync | 持續性的寫入延遲偏高 | `INFO persistence`、`LATENCY LATEST` |
| 6 | 記憶體交換（swap） | 延遲從微秒級變成毫秒級，且無明顯慢命令 | `/proc/<pid>/smaps`、系統 `vmstat` |
| 7 | 透明大頁（THP） | fork 之後的一段時間延遲偏高 | 檢查 `/sys/kernel/mm/transparent_hugepage/enabled` |
| 8 | 網路 / 客戶端 | Redis 端指標正常，但客戶端測到高延遲 | `--latency` vs 應用端埋點對比 |

### 先建立監控基礎設施

排查之前，這幾個設定要先開：

```bash
# 慢查詢：超過 10 毫秒就記錄（預設是 10000 微秒 = 10ms）
CONFIG SET slowlog-log-slower-than 10000
CONFIG SET slowlog-max-len 256

# 延遲監控：超過 100 毫秒的事件記錄下來
CONFIG SET latency-monitor-threshold 100
```

`latency-monitor-threshold` 預設是 0（關閉），**強烈建議在生產環境開啟**，開銷極小但排查時價值巨大。它會記錄各類「延遲事件」的發生時間與峰值：

```bash
LATENCY LATEST
# 1) 1) "command"          <- 事件類型
#    2) (integer) 1786000123   <- 最後一次發生的時間戳
#    3) (integer) 152           <- 最後一次的延遲（毫秒）
#    4) (integer) 890           <- 歷史最大延遲（毫秒）
# 2) 1) "fork"
#    2) (integer) 1786000050
#    3) (integer) 320
#    4) (integer) 320

LATENCY HISTORY command      # 某類事件的歷史
LATENCY RESET                # 清空
LATENCY DOCTOR               # 自動分析並給建議（很值得一試）
```

`LATENCY DOCTOR` 會用人話告訴你它的判斷，例如「你的 fork 時間過長，可能是實例太大或啟用了 THP」。第 12 章會深入這些工具。

---

## 4.6 慢命令：完整的危險清單

### 第一類：O(N) 的「取全部」命令

| 命令 | 危險程度 | 安全替代 |
|------|---------|---------|
| `KEYS pattern` | 極高 | `SCAN` |
| `HGETALL` / `HKEYS` / `HVALS` | 高 | `HSCAN` / `HMGET` |
| `SMEMBERS` | 高 | `SSCAN` / `SISMEMBER` |
| `LRANGE key 0 -1` | 高 | `LRANGE key 0 99` |
| `ZRANGE key 0 -1` | 高 | `ZRANGE key 0 99` / `ZSCAN` |
| `FLUSHALL` / `FLUSHDB` | 極高 | 加 `ASYNC` |
| `DEBUG SLEEP` | 極高 | 只該在測試環境用 |

### 第二類：集合運算

| 命令 | 複雜度 | 注意 |
|------|--------|------|
| `SUNIONSTORE` / `SINTERSTORE` / `SDIFFSTORE` | O(N) ~ O(N*M) | 大集合運算要離線做 |
| `ZUNIONSTORE` / `ZINTERSTORE` | O(N)+O(M log M) | 同上 |
| `BITOP` | O(N) bytes | 第 03 章提過，放定時任務 |
| `PFMERGE` | O(N) | 合併大量 HLL 時注意 |
| `SORT` | O(N+M log M) | 相當昂貴，考慮改用 Sorted Set |

### 第三類：容易被忽略的

**`DEL` 一個大集合。** 這是很多人沒想到的：刪除也是 O(N)，因為要逐個釋放元素的記憶體。用 `UNLINK`。

**`EXPIRE` 造成的大量同時過期。** 如果一萬個 key 在同一秒過期，週期刪除任務會忙起來，可能造成延遲尖峰。解法是 TTL 加隨機抖動（第 09 章）。

**`SETRANGE` / `APPEND` 造成的記憶體重新配置。** 對一個大 String 反覆 `APPEND`，可能觸發多次記憶體搬移。

**大 value 的 `GET`。** 即使 `GET` 是 O(1)，取一個 10MB 的 value 也要花時間序列化並傳輸。

### 用 `INFO commandstats` 找出真正的成本大戶

`SLOWLOG` 只記錄超過閾值的命令，但有種情況它抓不到：**單次不慢，但呼叫量極大的命令。**

```bash
INFO commandstats
# cmdstat_get:calls=8123456,usec=4061728,usec_per_call=0.50,rejected_calls=0,failed_calls=0
# cmdstat_hgetall:calls=12000,usec=36000000,usec_per_call=3000.00,...
```

解讀方式：

- `usec_per_call` 高的 -> 單次慢，`SLOWLOG` 應該也抓到了。
- `calls × usec_per_call` 總量高的 -> **真正吃掉 CPU 時間的元凶**，即使單次不慢。

上面的例子：`GET` 單次只 0.5 微秒，但呼叫 812 萬次，總計 4 秒；`HGETALL` 單次 3 毫秒（不到 10ms 閾值，`SLOWLOG` 抓不到），但 1.2 萬次總計 36 秒。**`HGETALL` 吃掉的時間是 `GET` 的九倍**，但它不在慢查詢日誌裡。

```bash
CONFIG RESETSTAT      # 清空統計，重新開始觀察一段時間
```

7.0 之後還有 `INFO latencystats`，直接給你每個命令的延遲百分位分布：

```bash
INFO latencystats
# latency_percentiles_usec_get:p50=0.50,p99=1.00,p99.9=3.00
```

---

## 4.7 big key：定義、危害、排查、拆解

### 什麼是 big key

沒有絕對標準，業界常用的判斷線是：

| 型別 | big key 的警戒線 |
|------|----------------|
| String | value 超過 10KB |
| Hash / Set / List / ZSet | 元素數超過 5000 個，或總大小超過 1MB |
| 任何型別 | `MEMORY USAGE` 超過 1MB |

比絕對數字更重要的判斷是：**這個 key 會不會無限成長？**

```text
一個 Hash 存 100 個固定欄位     -> 永遠不會是 big key
一個 List 每次操作就 LPUSH 一筆  -> 遲早變成 big key（除非有 LTRIM）
```

**設計時就要問「這個集合的上限在哪」**，這比事後排查有效得多。

### big key 的五種危害

**危害 1：操作它的命令變成慢命令。** `HGETALL`、`SMEMBERS`、`DEL` 都會卡住整個實例。

**危害 2：網路頻寬被吃掉。** 一個 10MB 的 value，QPS 100 就是 1GB/s 的出口流量——很可能先打爆網卡。

**危害 3：刪除與過期造成阻塞。** `DEL` 一個百萬元素的 Hash 可能阻塞數百毫秒。過期時也是同樣的釋放成本（除非開了 `lazyfree-lazy-expire`）。

**危害 4：主從同步壓力。** 大 key 的變更會產生大量複製流量，可能撐爆複製緩衝區導致全量重新同步——而全量同步又會觸發 fork，形成連鎖反應。

**危害 5：在 Cluster 模式下造成資料傾斜。** 一個 key 只能屬於一個 slot，也就只能在一個節點上。有 big key 的節點記憶體會遠高於其他節點，而且**無法透過擴容解決**——你不能把一個 key 拆到兩個節點。

### 排查工具

**工具 1：`--bigkeys`**

```bash
redis-cli -a pass --bigkeys
# [00.00%] Biggest string found so far '"config:global"' with 3021 bytes
# [12.34%] Biggest hash   found so far '"user:cart:1001"' with 45 fields
# ...
# -------- summary -------
# Biggest   string found '"page:cache:home"' has 5242880 bytes
# Biggest     hash found '"session:index"' has 480123 fields
```

它底層用 `SCAN` 分批掃，所以**不會阻塞**，可以在生產環境跑（但仍會產生持續負載，建議低峰期）。

**重要限制：它按「元素數量」判斷，不是按記憶體。** 一個有 10 個欄位但每個欄位存 1MB 的 Hash，`--bigkeys` 不會認為它大。

**工具 2：`--memkeys`（6.0+）**

```bash
redis-cli -a pass --memkeys
```

這個用 `MEMORY USAGE` 判斷，看的是真實記憶體佔用，更準確。但它比 `--bigkeys` 慢（`MEMORY USAGE` 本身有成本）。

**工具 3：`MEMORY USAGE` 精確測量單個 key**

```bash
MEMORY USAGE session:index
# (integer) 52428800      <- 50MB

MEMORY USAGE session:index SAMPLES 0    # SAMPLES 0 = 精確計算所有元素（慢，但準）
```

預設會抽樣估算（`SAMPLES 5`），對大集合來說估算可能有偏差。`SAMPLES 0` 是精確值，但對超大 key 會是慢命令，謹慎使用。

**工具 4：離線分析 RDB 檔（最安全）**

如果你連 `--bigkeys` 的負載都不想承擔，可以把 RDB 檔複製出來離線分析：

```bash
# 用 rdb_bigkeys、redis-rdb-tools 等社群工具
rdb --command memory dump.rdb --bytes 10240 > memory-report.csv
```

完全零線上影響，適合定期的健康檢查。

**工具 5：RedisInsight 的記憶體分析**

圖形化呈現各前綴的記憶體佔比，適合快速找出「哪個業務吃掉最多記憶體」。這也是第 01 章強調 key 命名規範的價值所在——命名混亂的話這個分析毫無意義。

### 三種拆解策略

**策略 1：按 field 分片（適合 Hash / Set）**

```text
原本：user:index（一個 Hash，500 萬個 field）

拆成：user:index:0 ~ user:index:99（100 個 Hash，各 5 萬個 field）
      分片規則：hash(field) % 100
```

```javascript
function shardKey(base, field, shards = 100) {
  return `${base}:${crc32(field) % shards}`;
}

// 寫入
await redis.hset(shardKey('user:index', userId), userId, data);
// 讀取
await redis.hget(shardKey('user:index', userId), userId);
```

單點讀寫完全不受影響（還是一次命令），但「取全部」變成要遍歷 100 個 key——這其實是好事，因為你可以用 pipeline 分批取，每批都是小命令。

**策略 2：按時間或業務維度拆（適合 List / ZSet）**

```text
原本：order:timeline（一個 ZSet，所有歷史訂單）

拆成：order:timeline:202608、order:timeline:202607、...（按月）
```

這個拆法的額外好處是**過期變簡單**：舊月份的 key 直接設 TTL 或刪除，不需要 `ZREMRANGEBYSCORE` 這種 O(N) 操作。

**策略 3：拆成獨立 key（適合大 String）**

```text
原本：page:cache:home（一個 5MB 的 JSON，整頁的資料）

拆成：page:cache:home:banner
      page:cache:home:hotproducts
      page:cache:home:categories
```

好處是：更新某一區塊不必重寫整份、可以按區塊設不同 TTL、讀取時用 `MGET` 一次取需要的部分。

**策略 4：加上裁切策略（預防勝於治療）**

```bash
LPUSH user:timeline:1001 "post:9999"
LTRIM user:timeline:1001 0 199              # List

ZADD rank:xxx 100 "member"
ZREMRANGEBYRANK rank:xxx 0 -10001           # ZSet 只留前 10000

ZREMRANGEBYSCORE log:xxx "-inf" <一天前的時間戳>   # 按時間清理
```

**每個會成長的集合，都該在寫入路徑上配一個裁切動作。** 這是最省事的做法，因為它讓 big key 根本不會出現。

### 拆解時的遷移注意事項

線上拆一個 big key 不能「停機改結構」，標準做法是雙寫加灰度：

```text
階段 1：新舊都寫，只讀舊的
階段 2：把歷史資料遷移到新結構（分批、節流）
階段 3：讀新的，舊的保留一段時間當退路
階段 4：確認穩定後，UNLINK 舊 key
```

第 4 階段記得用 `UNLINK` 不是 `DEL`——你正要刪掉的就是一個 big key。

---

## 4.8 hot key：定義、排查、解法

### 什麼是 hot key

**某個 key 的存取量遠高於其他 key，導致它成為瓶頸。**

典型例子：

- 秒殺商品的庫存 key，活動開始瞬間每秒幾十萬次存取。
- 首頁的推薦位快取。
- 明星發文後的貼文詳情。
- 全站公告、全局設定。

### hot key 的危害

**危害 1：單實例的 CPU 或網路被打滿。** 即使每個命令都是 O(1)，數量夠大就會撐滿單核心。

**危害 2：在 Cluster 模式下無法用擴容解決。** 這是最麻煩的一點：

```text
一個 key -> 一個 slot -> 一個節點

所以無論你的 Cluster 有 3 個還是 30 個節點
這個 hot key 的所有流量都會集中打在同一個節點上
擴容完全沒有幫助
```

**危害 3：這個節點掛掉會造成局部雪崩。** 熱點資料不可用，大量請求瞬間轉向資料庫。

### 排查工具

**工具 1：`--hotkeys`**

```bash
# 前提：maxmemory-policy 必須設成 LFU 模式
CONFIG SET maxmemory-policy allkeys-lfu

redis-cli -a pass --hotkeys
```

它的原理是用 `OBJECT FREQ` 讀取 LFU 的存取頻率計數器。**限制是必須用 LFU 策略**，如果你的驅逐策略是 LRU 就不能用（第 05 章會講兩者差異）。

**工具 2：`MONITOR` 抽樣**

```bash
# 只抓 10 秒，統計出現最多的 key
timeout 10 redis-cli -a pass MONITOR | awk '{print $4}' | sort | uniq -c | sort -rn | head -20
```

**警告：`MONITOR` 在高流量下會明顯影響效能**（它要把每個命令都推送給你）。只在能承擔的情況下短時間使用，或在從節點上跑。

**工具 3：客戶端埋點（生產環境最推薦）**

在應用層的 Redis 客戶端包一層統計，記錄每個 key 前綴的呼叫次數，定期上報監控系統。

```javascript
async function get(key) {
  metrics.increment('redis.get', { prefix: keyPrefix(key) });
  return await redis.get(key);
}
```

好處是零 Redis 負載、可以長期觀察、能和業務指標關聯。**這是唯一適合常態開啟的方案。**

**工具 4：代理層統計。** 如果你用 Twemproxy、Codis 或雲廠商的代理，通常內建熱點統計功能。

### 四種解法

**解法 1：本地快取（最有效）**

在應用行程內用 Caffeine、`lru-cache` 這類本地快取擋住熱點：

```javascript
const local = new LRUCache({ max: 1000, ttl: 3000 });   // 只快取 3 秒

async function getHotConfig(key) {
  const cached = local.get(key);
  if (cached !== undefined) return cached;

  const value = await redis.get(key);
  local.set(key, value);
  return value;
}
```

效果非常好：假設有 100 台應用伺服器，本地快取 TTL 3 秒，那麼對 Redis 的 QPS 上限就是 `100 / 3 ≈ 33`，不管前端流量多大。

**代價是資料延遲。** 資料更新後，各台機器最多要 3 秒才會看到新值。所以 TTL 要根據業務容忍度設定：

```text
全站設定、推薦位 -> 可以容忍幾秒，適合本地快取
庫存數量        -> 不能容忍，不適合（會超賣）
```

**解法 2：key 打散成多個副本**

把一個 hot key 複製成 N 份，讀取時隨機選一個。這樣流量會分散到不同的 slot / 節點：

```javascript
const COPIES = 10;

async function writeHot(key, value) {
  const pipeline = redis.pipeline();
  for (let i = 0; i < COPIES; i++) {
    pipeline.set(`${key}:copy:${i}`, value, 'EX', 300);
  }
  await pipeline.exec();
}

async function readHot(key) {
  const i = Math.floor(Math.random() * COPIES);
  return await redis.get(`${key}:copy:${i}`);
}
```

適合**讀多寫極少**的資料。代價是寫入成本變 N 倍，而且更新時可能出現「不同副本短暫不一致」。

**解法 3：讀寫分離，讀走從節點**

加從節點分擔讀流量。這對純讀的熱點有效，但要注意：

- 主從有複製延遲，可能讀到舊資料。
- 寫入仍然集中在主節點，寫熱點無法解決。

**解法 4：客戶端快取（Client-side caching，6.0+）**

Redis 6 引入了伺服器輔助的客戶端快取：客戶端在本地快取資料，Redis 追蹤誰快取了什麼，資料變更時**主動發送失效通知**。

```bash
CLIENT TRACKING ON
```

這解決了解法 1 的核心痛點——不需要靠短 TTL 猜測，而是資料真的變了才失效。缺點是需要客戶端庫支援（且通常需要 RESP3 協定），並非所有語言的客戶端都成熟。

### 解法選擇

```text
讀多寫少、能容忍幾秒延遲     -> 本地快取（最簡單有效）
讀多寫少、不能容忍延遲       -> 客戶端快取（需客戶端支援）
讀量極大、資料靜態           -> key 打散 + 本地快取
寫熱點（如庫存扣減）         -> 這是另一個問題，見第 10、14 章
                              （分段庫存、請求合併、佇列削峰）
```

**特別注意：寫熱點不能用上面的方法解決。** 「一萬人同時扣同一個商品的庫存」是本質上的序列化需求，解法是把庫存拆成多段（例如 100 件拆成 10 段各 10 件，隨機選一段扣），或者用佇列把請求排隊處理。第 14 章會完整設計。

---

## 4.9 其他阻塞源：fork、fsync、THP、swap

這四個是「你的命令都很快，但延遲還是有尖峰」時的元凶。

### fork：持久化的隱藏成本

Redis 在這些時候會 fork 出子行程：

- `BGSAVE`（RDB 快照，包含自動觸發的）
- `BGREWRITEAOF`（AOF 重寫）
- 主從全量同步（主節點要產生 RDB）

**fork 本身是阻塞的。** 雖然 Linux 用 copy-on-write 避免了複製整份記憶體，但它仍需要複製**頁表**——而頁表大小與記憶體用量成正比。

```text
經驗值：每 GB 記憶體大約需要 10-20 毫秒的 fork 時間
       10GB 的實例，fork 可能阻塞 100-200 毫秒
```

查看實際數字：

```bash
INFO stats | grep fork
# latest_fork_usec:187000        <- 上次 fork 花了 187 毫秒
# total_forks:42
```

**這 187 毫秒是完全阻塞的**——期間所有請求都在排隊。如果你的 SLA 是 P99 < 10ms，一次 fork 就會製造一批超時。

緩解方式：

- **控制單實例大小。** 建議不超過 10GB，理想是 4-8GB。要更大就分片成多個實例。
- **在從節點做持久化。** 主節點關掉 RDB/AOF，讓從節點承擔 fork 成本。
- **錯開時間。** 多個實例的持久化時間不要撞在一起。
- **關閉 THP**（下面說）。

### AOF fsync：寫入延遲的來源

`appendfsync always` 意味著**每個寫命令都要等磁碟確認**。即使是 SSD，一次 fsync 也要幾百微秒到幾毫秒。

```bash
CONFIG GET appendfsync
# "everysec"     <- 預設，每秒刷一次，由背景執行緒做
```

三個選項的取捨在第 06 章會詳談。這裡只需要知道：

```text
always   -> 最安全，但寫入延遲顯著上升，吞吐可能掉一個數量級
everysec -> 預設，最多丟 1 秒資料，延遲影響小（背景執行緒處理）
no       -> 交給作業系統，最快但可能丟幾十秒資料
```

即使是 `everysec`，如果磁碟很慢（或 AOF 重寫正在進行造成 I/O 競爭），主執行緒仍可能因為「上一次的 fsync 還沒完成」而被迫等待。`LATENCY LATEST` 會出現 `aof-fsync-always` 或 `aof-write` 事件。

### 透明大頁（THP）：一定要關

Linux 的 THP 功能會用 2MB 的大頁取代 4KB 的標準頁，本意是減少 TLB 未命中。但它和 Redis 的 copy-on-write 嚴重衝突：

```text
沒有 THP：fork 後子行程寫入時，複製 4KB
有 THP：  fork 後子行程寫入時，複製 2MB     <- 放大 512 倍
```

結果是持久化期間的寫入延遲大幅上升，而且記憶體用量可能暴增。

**Redis 啟動時如果偵測到 THP 開啟，會在日誌裡明確警告。** 關閉方式：

```bash
# 檢查
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never      <- always 就是開著，要關

# 臨時關閉
echo never > /sys/kernel/mm/transparent_hugepage/enabled

# 永久關閉（加進 /etc/rc.local 或 systemd unit，各發行版做法略有不同）
```

這是**部署 Redis 的標準檢查項**，成本為零、效果明確。用容器跑 Redis 時要注意：THP 是宿主機層級的設定，在容器裡改不了，得在宿主機處理。

### swap：最可怕的一種慢

Redis 的資料在記憶體裡。如果作業系統把部分記憶體換到磁碟（swap），那些資料的存取就從奈秒級變成毫秒級——**慢一萬倍**，而且 Redis 完全不知道發生了什麼。

檢查方式：

```bash
# 找出 Redis 的 pid
redis-cli INFO server | grep process_id

# 看它有多少記憶體被 swap 出去
grep -A 1 VmSwap /proc/<pid>/status
# 或更詳細
cat /proc/<pid>/smaps | grep -i swap | awk '{sum+=$2} END {print sum " kB"}'
```

只要這個數字不是 0，就要處理。預防措施：

- **確保 `maxmemory` 加上其他行程的用量，明顯小於實體記憶體。** 一般建議 Redis 的 `maxmemory` 不超過實體記憶體的 60-70%（要留給 fork 時的 COW 和各種緩衝區）。
- **調低 `vm.swappiness`**（例如 1，不建議設 0，那可能觸發 OOM killer）。
- **監控告警。** swap 使用量應該是一個獨立的告警項。

---

## 4.10 lazyfree：把釋放工作交給背景

第 01 章提過這四個設定，這裡說明為什麼它們重要：

```bash
CONFIG SET lazyfree-lazy-eviction yes      # 驅逐 key 時
CONFIG SET lazyfree-lazy-expire yes        # 過期刪除時
CONFIG SET lazyfree-lazy-server-del yes    # 內部隱式刪除時（如 RENAME 覆蓋目標）
CONFIG SET lazyfree-lazy-user-del yes      # 使用者執行 DEL 時（等於自動變 UNLINK）
CONFIG SET lazyfree-lazy-user-flush yes    # FLUSHALL / FLUSHDB 時
```

每一個都對應一個「Redis 可能在你沒察覺的情況下釋放大量記憶體」的場景：

| 設定 | 沒開會怎樣 |
|------|-----------|
| `lazy-eviction` | 記憶體滿時驅逐一個 big key，會在請求路徑上阻塞 |
| `lazy-expire` | 一個 big key 過期，週期清理任務會阻塞 |
| `lazy-server-del` | `RENAME a b` 時 b 原本是 big key，會阻塞 |
| `lazy-user-del` | 有人手動 `DEL` big key，會阻塞 |

**這五個在生產環境建議全開。** 風險極低（唯一的代價是記憶體釋放稍有延遲，且背景執行緒會用一點 CPU），收益是消除一整類延遲尖峰。

要注意這是**設定檔層級的最佳實踐**，很多人只知道用 `UNLINK` 取代 `DEL`，卻忘了驅逐和過期這兩條路徑同樣會刪除 big key，而那兩條路徑你在程式裡管不到。

---

## 4.11 一次完整的診斷流程

把前面的工具串成可執行的排查順序。假設你收到「Redis P99 延遲從 1ms 漲到 200ms」的告警：

**第 1 步：確認是 Redis 的問題，還是網路 / 客戶端的問題**

```bash
redis-cli -a pass --latency-history -i 5
# min: 0, max: 1, avg: 0.23 (100 samples) -- 5.00 seconds range
```

如果這裡的數字正常（微秒到 1ms 級），但應用端測到 200ms，問題在網路、客戶端連線池、或應用本身。

```bash
redis-cli -a pass --intrinsic-latency 30   # 確認機器本身的抖動水準
```

**第 2 步：看有沒有慢命令**

```bash
SLOWLOG GET 20
# 1) 1) (integer) 14              <- 序號
#    2) (integer) 1786000123      <- 發生時間
#    3) (integer) 231456          <- 耗時（微秒）= 231ms
#    4) 1) "HGETALL"              <- 命令與參數
#       2) "session:index"
#    5) "10.0.1.55:41232"         <- 來源客戶端
#    6) ""
```

第 5 個欄位（來源 IP）很有價值——它直接告訴你是哪台機器發出的，可以回頭找對應的程式碼。

**第 3 步：看延遲事件的分類**

```bash
LATENCY LATEST
LATENCY DOCTOR
```

如果出現 `fork` 事件，去看第 4 步；出現 `command` 事件，回到第 2 步；出現 `aof-fsync-always`，檢查磁碟與持久化設定。

**第 4 步：檢查持久化相關**

```bash
INFO stats | grep fork          # latest_fork_usec
INFO persistence               # rdb_bgsave_in_progress、aof_rewrite_in_progress
```

如果延遲尖峰的時間點和 `rdb_last_save_time` 或 AOF 重寫吻合，元凶就是 fork。

**第 5 步：找 big key**

```bash
redis-cli -a pass --bigkeys
redis-cli -a pass --memkeys
```

**第 6 步：找總成本大戶**

```bash
CONFIG RESETSTAT
# 等 5-10 分鐘
INFO commandstats
INFO latencystats
```

**第 7 步：檢查系統層面**

```bash
INFO memory | grep -E "used_memory_human|maxmemory_human|mem_fragmentation_ratio"
cat /sys/kernel/mm/transparent_hugepage/enabled     # THP
grep VmSwap /proc/<pid>/status                       # swap
INFO clients                                         # 連線數、blocked_clients
INFO cpu                                             # CPU 使用率
```

**第 8 步：檢查客戶端與連線**

```bash
INFO clients
# connected_clients:842
# client_recent_max_input_buffer:20480
# client_recent_max_output_buffer:0
# blocked_clients:3

CLIENT LIST                    # 看有沒有異常的長連線或大緩衝區
```

連線數暴增本身就會造成延遲（每個連線都有記憶體開銷，而且事件循環要處理更多 socket）。常見原因是應用端的連線池設定錯誤或連線洩漏。

---

## 4.12 常見錯誤

### 錯誤 1：以為開了 `io-threads` 慢命令就不會阻塞

命令執行永遠是單執行緒。`io-threads` 只優化網路 I/O。

### 錯誤 2：以為 `--bigkeys` 找出的就是最佔記憶體的 key

它按元素數量判斷。要看記憶體用 `--memkeys` 或 `MEMORY USAGE`。

### 錯誤 3：在生產環境長時間開 `MONITOR`

會顯著影響效能。短時間抽樣，或改用客戶端埋點。

### 錯誤 4：只看 `SLOWLOG` 就下結論

單次不慢但呼叫量巨大的命令不會出現在 `SLOWLOG`。要配合 `INFO commandstats`。

### 錯誤 5：忘記關 THP

持久化期間的延遲會顯著惡化。這是零成本的檢查項。

### 錯誤 6：`maxmemory` 設得和實體記憶體一樣大

fork 時的 COW、複製緩衝區、客戶端緩衝區都需要額外記憶體。設太滿會導致 swap 或被 OOM killer 殺掉。建議不超過實體記憶體的 60-70%。

### 錯誤 7：把 hot key 問題交給 Cluster 擴容解決

一個 key 只在一個節點上，擴容無效。要用本地快取或 key 打散。

### 錯誤 8：讓集合無限成長

沒有裁切策略的集合遲早變成 big key。這是設計問題，不是維運問題。

### 錯誤 9：沒開 lazyfree 設定

驅逐和過期路徑上的 big key 釋放會造成你查不出原因的延遲尖峰。

---

## 4.13 本章練習

### 練習 1：判斷延遲的來源

以下四個症狀，各自最可能是什麼原因？該用什麼指令確認？

1. 每天凌晨 3 點準時出現 300ms 的延遲尖峰，持續約 2 秒。
2. `SLOWLOG` 是空的，`--latency` 顯示正常，但應用端監控顯示 P99 是 150ms。
3. 延遲從平時的 0.3ms 變成穩定的 8ms，沒有尖峰，就是整體變慢。
4. Cluster 有 6 個節點，其中 1 個節點的 CPU 是 95%，其他 5 個都在 20% 以下。

<details>
<summary>參考解答</summary>

**1. 凌晨 3 點準時的尖峰 → fork（RDB 快照或 AOF 重寫）**

「準時」是最強的線索——業務流量不會這麼規律，只有排程任務才會。

```bash
INFO stats | grep latest_fork_usec       # 看 fork 耗時
INFO persistence | grep -E "rdb_last_save_time|aof_rewrite"
CONFIG GET save                           # 看 RDB 觸發規則
LATENCY HISTORY fork                      # 確認 fork 事件的歷史
```

確認方向：`latest_fork_usec` 如果是 300000（300ms）左右，就吻合了。

處理：改在從節點做持久化、縮小實例、確認 THP 已關閉、或把時間錯開到更低峰。

**2. Redis 端正常但應用端慢 → 網路、連線池或客戶端問題**

Redis 自己測到的延遲正常，說明命令執行沒問題，時間花在 Redis 之外。

```bash
# 先確認 Redis 端真的沒問題
redis-cli --latency-history -i 5
redis-cli --intrinsic-latency 30

# 再看連線相關
INFO clients                # connected_clients、blocked_clients
CLIENT LIST | wc -l
```

常見原因，按發生機率排序：

- **連線池太小**。應用端的請求在等連線，這段等待時間算在應用的延遲裡，但 Redis 完全不知道。這是最常見的原因。
- **應用端在迴圈裡發命令**（第 02 章的 N 次往返問題），總延遲是 N × RTT。改用 `MGET` 或 pipeline。
- **跨可用區或跨機房**，網路 RTT 本身就高。
- **應用端 GC 停頓**，特別是 JVM 應用。
- **DNS 解析每次都重做**。

排查方法：在應用端埋點，分別記錄「等連線的時間」和「命令執行的時間」。這兩個數字一分開，答案通常就明顯了。

**3. 整體穩定變慢（0.3ms → 8ms）→ 最可能是 swap，其次是 CPU 飽和或網路劣化**

「穩定變慢」和「尖峰」是不同的模式。尖峰指向某個週期性事件，穩定變慢指向持續性的資源問題。

```bash
# 首先確認 swap
redis-cli INFO server | grep process_id
grep VmSwap /proc/<pid>/status
cat /proc/<pid>/smaps | grep -i swap | awk '{sum+=$2} END {print sum" kB"}'

# 其次確認記憶體壓力
INFO memory | grep -E "used_memory_human|maxmemory_human|mem_fragmentation_ratio"

# 再確認 CPU
INFO cpu
INFO commandstats     # 是不是 QPS 大幅上升了

# 最後確認硬體本身
redis-cli --intrinsic-latency 30
```

如果 `VmSwap` 不是 0，答案就是 swap，處理方式是降低 `maxmemory` 或加機器記憶體。

如果 swap 是 0，看 `--intrinsic-latency`——如果它本身就有幾毫秒，問題在宿主機（可能是雲主機的鄰居在吵，或被限流）。

**4. Cluster 單節點 CPU 95% → hot key 或資料傾斜**

```bash
# 直連那個節點排查
redis-cli -h <該節點> -a pass INFO commandstats     # 哪個命令量最大
redis-cli -h <該節點> -a pass --bigkeys
redis-cli -h <該節點> -a pass DBSIZE                 # key 數量是否明顯多於其他節點

# 找 hot key（需要 LFU 策略）
redis-cli -h <該節點> -a pass CONFIG SET maxmemory-policy allkeys-lfu
redis-cli -h <該節點> -a pass --hotkeys

# 或短時間抽樣
timeout 10 redis-cli -h <該節點> -a pass MONITOR \
  | awk '{print $4}' | sort | uniq -c | sort -rn | head -20
```

兩種可能要分清楚：

- **hot key**：key 數量正常，但某個 key 的存取量極高。解法是本地快取、key 打散、或讀走從節點。
- **資料傾斜**：這個節點的 key 數量或記憶體明顯多於其他節點。原因通常是 hash tag 用錯了（例如所有 key 都寫成 `{user}:1001`、`{user}:1002`，導致全部落在同一個 slot），或有 big key。

`DBSIZE` 的對比可以快速區分這兩者。第 11 章會詳談 hash tag 與 slot 分布。

</details>

### 練習 2：找出並拆解一個 big key

線上有一個 key `article:comments:8888`（熱門文章的評論 List），已經累積 80 萬條評論，導致「查看評論」的 API 經常超時。設計完整的解決方案，包含線上遷移步驟。

<details>
<summary>參考解答</summary>

**第一步：確認現狀**

```bash
LLEN article:comments:8888
# (integer) 812345

MEMORY USAGE article:comments:8888
# (integer) 487000000        <- 約 487MB，這是個非常嚴重的 big key

OBJECT ENCODING article:comments:8888
# "quicklist"
```

487MB 的 List 意味著：`LRANGE` 取大範圍會卡住整個實例、這個 key 過期或被刪除會阻塞數百毫秒、主從同步時它是個大負擔。

**第二步：分析真正的存取模式**

拆解之前必須先問清楚業務怎麼用它，這決定了拆法。假設查出來的答案是：

- 99% 的請求是「取最新 20 條」（第一頁）。
- 少數請求會翻到第 2-5 頁。
- 幾乎沒有人翻到第 100 頁以後。
- 偶爾需要「取某條評論的詳情」。
- 需要顯示「總評論數」。

**這個分析是整個方案的關鍵。** 如果沒有問清楚就直接拆，很可能拆出一個不符合存取模式的結構。

**第三步：設計新結構**

```text
article:comments:8888:hot      List，只保留最新 500 條（LTRIM 維護）
                                -> 服務 99% 的請求，永遠不會變大

article:comments:8888:count    String，總評論數（INCR 維護）
                                -> O(1) 取得總數，不必 LLEN

comment:detail:{commentId}     Hash 或 String，單條評論的內容
                                -> 支援「取某條詳情」

冷資料                          留在資料庫，深分頁走資料庫查詢
                                -> 反正很少人翻到那麼後面
```

這個設計的核心判斷是：**不要試圖讓 Redis 承擔全部 80 萬條評論。** Redis 負責熱資料（最新 500 條）和計數，冷資料回歸資料庫。這比「把 80 萬條拆成 800 個 key」簡單得多，也更符合 Redis 作為加速層的定位。

**第四步：寫入路徑改造**

```javascript
const HOT_SIZE = 500;

async function addComment(articleId, comment) {
  // 1. 資料庫是事實來源，先寫它
  const saved = await db.insertComment(articleId, comment);

  // 2. 更新 Redis 的熱資料與計數
  const hotKey = `article:comments:${articleId}:hot`;
  const countKey = `article:comments:${articleId}:count`;

  const pipeline = redis.pipeline();
  pipeline.lpush(hotKey, JSON.stringify(saved));
  pipeline.ltrim(hotKey, 0, HOT_SIZE - 1);        // 關鍵：每次寫入都裁切
  pipeline.incr(countKey);
  pipeline.expire(hotKey, 86400 * 7, 'GT');
  await pipeline.exec();

  return saved;
}
```

`LTRIM` 是這個方案的核心——**它保證這個 key 永遠不會超過 500 條，big key 從此不可能再出現。**

**第五步：讀取路徑改造**

```javascript
async function getComments(articleId, page = 1, size = 20) {
  const start = (page - 1) * size;
  const end = start + size - 1;

  // 熱資料範圍內走 Redis
  if (end < HOT_SIZE) {
    const hotKey = `article:comments:${articleId}:hot`;
    const items = await redis.lrange(hotKey, start, end);

    if (items.length > 0) {
      return items.map(JSON.parse);
    }
    // 快取未命中（例如剛過期），回填
    return await rebuildHot(articleId, start, end);
  }

  // 超出熱資料範圍，走資料庫
  return await db.getComments(articleId, start, size);
}

async function rebuildHot(articleId, start, end) {
  const items = await db.getComments(articleId, 0, HOT_SIZE);
  if (items.length === 0) return [];

  const hotKey = `article:comments:${articleId}:hot`;
  const pipeline = redis.pipeline();
  pipeline.del(hotKey);
  pipeline.rpush(hotKey, ...items.map(i => JSON.stringify(i)));
  pipeline.expire(hotKey, 86400 * 7);
  await pipeline.exec();

  return items.slice(start, end + 1);
}
```

注意 `rebuildHot` 有併發重建的問題（多個請求同時發現快取沒了，同時去查資料庫）——這是快取擊穿，第 09 章會用互斥鎖解決。

**第六步：線上遷移步驟**

不能停機，所以要分階段：

```text
階段 1（雙寫）：
  部署新版寫入邏輯，同時寫舊 key 和新結構
  讀取仍走舊 key
  觀察：新舊資料是否一致、新增的 key 是否符合預期

階段 2（初始化熱資料）：
  對現有文章批次執行 rebuildHot（分批、節流）
  同時初始化 count（用資料庫的 COUNT 灌入）

階段 3（切讀）：
  灰度把讀取切到新結構，先 1% 再逐步放大
  對比新舊路徑的回傳結果，確認一致
  監控資料庫的深分頁查詢量是否在預期內

階段 4（清理，這步最需要小心）：
  停止寫入舊 key
  觀察一週，確認沒有遺漏的讀取路徑
  最後刪除舊 key
```

**第七步：刪除舊 key 的正確方式**

這是整個遷移中最危險的一步——你要刪的是一個 487MB 的 big key。

```bash
# 絕對不要這樣做，會阻塞數百毫秒甚至更久
DEL article:comments:8888

# 做法一：UNLINK，記憶體回收交給背景執行緒
UNLINK article:comments:8888
```

更保守的做法是**先分批縮小，再刪除**：

```javascript
// 每次砍掉 1 萬條，中間留空隙，把單次阻塞控制在毫秒級
const key = 'article:comments:8888';
while (await redis.llen(key) > 10000) {
  await redis.ltrim(key, 0, -10001);    // 從尾部砍掉 1 萬條
  await sleep(100);
}
await redis.unlink(key);
```

雖然 `UNLINK` 已經把記憶體釋放交給背景執行緒了，但對於接近 500MB 的 key，「先縮小再刪」能讓整個過程對線上的影響更平滑，也更容易在出問題時中止。

**第八步：建立預防機制**

修完這一個 key 不代表問題解決，因為**製造它的程式碼還在**。要加上：

```javascript
// 監控告警：定期檢查是否有集合超過閾值
async function checkBigKeys() {
  // 對已知的高風險 key 模式做抽樣檢查
  const keys = await scanKeys('article:comments:*:hot');
  for (const key of keys) {
    const len = await redis.llen(key);
    if (len > HOT_SIZE * 1.5) {
      alert(`big key 風險：${key} 長度 ${len}，LTRIM 可能失效`);
    }
  }
}
```

以及在 code review 的檢查清單裡加一條：**任何 `LPUSH` / `SADD` / `ZADD` 的程式碼，都必須說明對應的裁切策略在哪裡。**

</details>

### 練習 3：實際觸發並觀測阻塞

在你的練習環境裡，設計一個實驗：一邊持續量測延遲，一邊觸發慢命令，記錄延遲的變化，並在 `SLOWLOG` 和 `LATENCY` 裡找到證據。

<details>
<summary>參考解答</summary>

**準備：開啟監控設定並灌入測試資料**

```bash
docker compose exec redis sh
```

```sh
# 把閾值調低一點，方便觀察
redis-cli -a mysecret CONFIG SET slowlog-log-slower-than 5000    # 5ms
redis-cli -a mysecret CONFIG SET latency-monitor-threshold 10    # 10ms
redis-cli -a mysecret SLOWLOG RESET
redis-cli -a mysecret LATENCY RESET

# 灌一個 100 萬元素的 Set
redis-cli -a mysecret EVAL "
for i=1,1000000 do
  redis.call('SADD', KEYS[1], 'member:'..i)
end
return redis.call('SCARD', KEYS[1])" 1 big:set

redis-cli -a mysecret MEMORY USAGE big:set
```

**實驗 1：觀測慢命令造成的阻塞**

開兩個終端。

終端 A（持續量測）：

```sh
redis-cli -a mysecret --latency-history -i 2
# min: 0, max: 1, avg: 0.21 (18 samples) -- 2.00 seconds range
# min: 0, max: 1, avg: 0.19 (19 samples) -- 2.00 seconds range
```

終端 B（觸發慢命令）：

```sh
redis-cli -a mysecret SMEMBERS big:set > /dev/null
```

回到終端 A，你會看到某一行的 `max` 突然變成幾百甚至上千：

```text
min: 0, max: 847, avg: 42.31 (5 samples) -- 2.00 seconds range
```

注意 `samples` 數量也變少了——因為量測本身也被卡住，這 2 秒內只跑得了 5 次。**這就是「一個慢命令卡住所有人」的直接證據。**

**找證據：**

```sh
redis-cli -a mysecret SLOWLOG GET 5
# 1) 1) (integer) 0
#    2) (integer) 1786000123
#    3) (integer) 843215          <- 843 毫秒
#    4) 1) "SMEMBERS"
#       2) "big:set"
#    5) "127.0.0.1:52418"
#    6) ""

redis-cli -a mysecret LATENCY LATEST
# 1) 1) "command"
#    2) (integer) 1786000123
#    3) (integer) 843
#    4) (integer) 843
```

兩邊都記錄到了，而且數字吻合。

**實驗 2：對比 `DEL` 和 `UNLINK`**

```sh
redis-cli -a mysecret LATENCY RESET

# 先確認 lazyfree 是關的，才能看到差異
redis-cli -a mysecret CONFIG SET lazyfree-lazy-user-del no

# 終端 A 繼續跑 --latency-history
# 終端 B：
time redis-cli -a mysecret DEL big:set
```

觀察終端 A 的尖峰。然後重新灌資料，改用 `UNLINK`：

```sh
redis-cli -a mysecret EVAL "
for i=1,1000000 do redis.call('SADD', KEYS[1], 'member:'..i) end
return 1" 1 big:set

# 終端 B：
time redis-cli -a mysecret UNLINK big:set
```

`UNLINK` 的回應時間應該明顯更短，終端 A 的延遲尖峰也小得多——因為記憶體釋放被丟給了背景執行緒。

**實驗 3：觀測 fork 的成本**

```sh
# 灌大量資料，讓實例變大
redis-cli -a mysecret EVAL "
for i=1,2000000 do
  redis.call('SET', 'k:'..i, string.rep('x', 100))
end
return redis.call('DBSIZE')" 0

redis-cli -a mysecret INFO memory | grep used_memory_human

# 終端 A 跑 --latency-history
# 終端 B 觸發 BGSAVE
redis-cli -a mysecret BGSAVE
```

然後看 fork 耗時：

```sh
redis-cli -a mysecret INFO stats | grep fork
# latest_fork_usec:45231       <- 45 毫秒
# total_forks:1

redis-cli -a mysecret LATENCY LATEST
# 應該會出現 "fork" 事件
```

在容器裡跑的數字可能和實體機差異較大，但趨勢很明確：**實例越大，fork 越慢。** 可以多灌一倍資料再測一次，觀察 `latest_fork_usec` 是否接近翻倍——這能直接驗證「fork 時間與記憶體用量成正比」這個結論。

**實驗 4：用 `commandstats` 找出總成本大戶**

```sh
redis-cli -a mysecret CONFIG RESETSTAT

# 模擬：大量的快 GET + 少量的慢 HGETALL
redis-cli -a mysecret EVAL "
for i=1,100 do redis.call('HSET', 'h:big', 'f'..i, string.rep('x', 100)) end
for i=1,50000 do redis.call('GET', 'k:1') end
for i=1,500 do redis.call('HGETALL', 'h:big') end
return 1" 0

redis-cli -a mysecret INFO commandstats | grep -E "cmdstat_(get|hgetall)"
```

自己算一下 `calls × usec_per_call`，比較兩者的總耗時。你會發現即使 `HGETALL` 的呼叫次數少 100 倍，它的總成本可能仍然更高——而且它單次可能不到 5ms 的閾值，`SLOWLOG` 完全抓不到。

**這個實驗的結論：`SLOWLOG` 和 `commandstats` 要一起看，前者抓「單次很慢」，後者抓「總量很貴」。**

**清理**

```sh
redis-cli -a mysecret FLUSHDB ASYNC
redis-cli -a mysecret CONFIG SET lazyfree-lazy-user-del yes
redis-cli -a mysecret SLOWLOG RESET
redis-cli -a mysecret LATENCY RESET
```

</details>

---

## 4.14 驗收清單

進入下一章前，確認你可以：

- [ ] 精確說明「Redis 單執行緒」指的是命令執行，並說出三個背景執行緒的工作。
- [ ] 解釋 I/O 多工如何讓單執行緒支撐上萬連線。
- [ ] 說明 `io-threads` 優化的是哪一段，以及它為什麼對慢命令沒幫助。
- [ ] 列出延遲的八個來源，並對每個說出一個排查指令。
- [ ] 說明 `SLOWLOG` 抓不到什麼問題，以及為什麼要看 `INFO commandstats`。
- [ ] 定義 big key，說出五種危害與三種拆解策略。
- [ ] 說明 `--bigkeys` 和 `--memkeys` 的差別。
- [ ] 定義 hot key，說明為什麼 Cluster 擴容不能解決它。
- [ ] 說出 hot key 的四種解法，以及各自的代價。
- [ ] 解釋 fork 為什麼阻塞，以及「每 GB 約 10-20ms」的經驗值。
- [ ] 說明 THP 為什麼要關、swap 為什麼可怕。
- [ ] 說出五個 lazyfree 設定的作用，以及為什麼光用 `UNLINK` 不夠。

---

下一章深入記憶體：[05-memory-management-and-eviction.md](./05-memory-management-and-eviction.md)，我們會看 Redis 的內部編碼如何省記憶體，以及記憶體滿了之後八種驅逐策略該怎麼選。
