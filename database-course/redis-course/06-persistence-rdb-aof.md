# 第 06 章：持久化 — RDB、AOF 與恢復演練

> 「Redis 有持久化，所以資料不會丟」——這句話對了一半，而錯的那一半會讓你在某次意外重啟後才發現。
> Redis 持久化的設計目標是**快速恢復**，不是**絕不遺失**。預設設定下，一次斷電最多可能丟掉一秒的寫入；如果只開 RDB，可能丟掉幾分鐘。這不是 bug，是刻意的取捨——因為「絕不遺失」的代價是把 Redis 的寫入效能拉低一個數量級。
> 這章要讓你能明確回答一個問題：**「如果現在機器斷電，我會丟掉哪些資料？」** 答不出來，就代表你的持久化設定其實是碰運氣。

---

## 6.1 學習目標

完成本章後，你應該可以：

- 說明 RDB 與 AOF 的機制差異，以及各自的優缺點。
- 說明 `BGSAVE` 的 fork + copy-on-write 原理，以及它的記憶體與延遲風險。
- 說出 `appendfsync` 三個選項各自的資料遺失窗口與效能代價。
- 解釋 AOF 為什麼需要重寫，以及 7.0 的多部分 AOF 改善了什麼。
- 說明混合持久化（RDB preamble）如何兼顧啟動速度與資料安全。
- 判斷一個持久化設定下，斷電會丟掉多少資料。
- 完成一次完整的恢復演練，包含檔案損壞的修復。
- 說明持久化和主從複製解決的是不同的問題，不能互相取代。

---

## 6.2 先想清楚：你到底需要多強的保證

在選設定之前，先確認你的 Redis 屬於哪一類：

| 定位 | 資料遺失的後果 | 該選的方向 |
|------|--------------|-----------|
| 純快取（資料庫是事實來源） | 快取重建，短暫的資料庫負載上升 | 持久化主要是為了「重啟後不用冷啟動」，RDB 就夠 |
| Session / 購物車 | 使用者要重新登入 / 購物車清空，體驗差但不致命 | AOF `everysec` |
| 分散式鎖 / 限流計數 | 鎖失效可能造成重複處理 | 業務必須冪等，持久化幫不了你 |
| 排行榜 / 統計 | 可從資料庫重算 | RDB 足夠 |
| 事實來源（不建議，但有人這樣用） | 真實的資料損失 | AOF `always` + 主從 + 定期備份，或改用 MemoryDB 這類方案 |

**一個重要的認知：持久化不能取代「有一個真正的資料庫」。** 如果你的資料絕對不能丟，答案不是「把 AOF 調成 `always`」，而是「這份資料應該存在關聯式資料庫裡」。

---

## 6.3 RDB：時間點快照

RDB（Redis Database）是把整個記憶體的資料，在某個時間點壓縮成一個二進位檔案。

### 觸發方式

**方式 1：自動觸發（`save` 設定）**

```bash
CONFIG GET save
# 1) "save"
# 2) "3600 1 300 100 60 10000"
```

這是三條規則，任一滿足就觸發 `BGSAVE`：

```text
3600 1       -> 3600 秒內至少有 1 次寫入
300 100      -> 300 秒內至少有 100 次寫入
60 10000     -> 60 秒內至少有 10000 次寫入
```

設計邏輯是「寫入越頻繁，快照越勤」。要完全關閉 RDB：

```bash
CONFIG SET save ""
```

**方式 2：手動觸發**

```bash
BGSAVE      # fork 子行程做，主執行緒只阻塞在 fork 那一下
SAVE        # 主執行緒直接做，全程阻塞。生產環境絕對不要用
```

**`SAVE` 在生產環境是禁令。** 一個 10GB 的實例執行 `SAVE` 會阻塞數十秒，等同於服務中斷。建議用 ACL 或 `rename-command` 封鎖它（第 13 章）。

**方式 3：隱式觸發**

以下情況也會產生 RDB：

- 主從全量同步時，主節點要產生 RDB 傳給從節點。
- 執行 `SHUTDOWN`（如果設定了 `save` 規則）。
- 執行 `DEBUG RELOAD`。
- `FLUSHALL` 之後（會產生一個空的 RDB）。

### 相關設定

```bash
CONFIG GET dbfilename           # "dump.rdb"
CONFIG GET dir                  # 檔案存放目錄
CONFIG GET rdbcompression       # "yes"，用 LZF 壓縮字串，省磁碟但耗一點 CPU
CONFIG GET rdbchecksum          # "yes"，檔案尾端加 CRC64 校驗
CONFIG GET stop-writes-on-bgsave-error   # "yes"  <- 這個很重要
```

### `stop-writes-on-bgsave-error`：一個會讓你莫名其妙掛掉的設定

預設值是 `yes`，意思是：**如果上一次 `BGSAVE` 失敗，Redis 會拒絕所有寫入命令。**

```bash
SET foo bar
# (error) MISCONF Redis is configured to save RDB snapshots, but it's currently
# not able to persist on disk. Commands that may modify the data set are disabled...
```

這個設計的本意是保護你：既然無法持久化，就不要繼續累積可能遺失的資料。但實務上它經常造成困惑——最常見的原因是**磁碟滿了**，然後整個服務的寫入全部失敗，而錯誤訊息看起來和磁碟毫無關聯。

排查：

```bash
INFO persistence | grep -E "rdb_last_bgsave_status|rdb_bgsave_in_progress"
# rdb_last_bgsave_status:err        <- 上次失敗了
```

處理：

```bash
df -h                              # 先確認磁碟空間
CONFIG SET stop-writes-on-bgsave-error no    # 緊急止血（但要知道你放棄了什麼）
```

**如果 Redis 是純快取**，把這個設為 `no` 是合理的——快取遺失不是大問題，但寫入全掛是大問題。**如果 Redis 存重要資料**，保持 `yes` 並確保有磁碟空間告警。

### 觀察 RDB 狀態

```bash
INFO persistence
# rdb_changes_since_last_save:1523      <- 上次快照後有多少次變更（= 潛在遺失量）
# rdb_bgsave_in_progress:0
# rdb_last_save_time:1786000000
# rdb_last_bgsave_status:ok
# rdb_last_bgsave_time_sec:3
# rdb_current_bgsave_time_sec:-1
# rdb_last_cow_size:8388608             <- 上次 fork 的 copy-on-write 用了多少額外記憶體

LASTSAVE
# (integer) 1786000000                  <- 上次成功保存的時間戳
```

**`rdb_changes_since_last_save` 就是你的「潛在遺失量」。** 這個數字如果經常是幾十萬，說明你的快照間隔對寫入量來說太長了。

### fork 與 copy-on-write

`BGSAVE` 的核心機制：

```text
1. 主行程呼叫 fork()，產生子行程
   -> 子行程「看到」和父行程完全一樣的記憶體內容
   -> 但作業系統沒有真的複製資料，只是複製了頁表，並把頁面標記為唯讀共享

2. 子行程開始把記憶體內容寫成 RDB 檔（慢，但不影響主行程）

3. 主行程繼續處理請求
   -> 當它要修改某個記憶體頁面時，作業系統攔截（因為頁面是唯讀的）
   -> 複製一份該頁面給主行程去改（這就是 copy-on-write）
   -> 子行程仍然看到舊的那份，所以 RDB 是一個「一致的時間點快照」
```

這個機制帶來三個實務後果：

**後果 1：fork 本身是阻塞的。** 第 04 章講過，每 GB 大約 10-20 毫秒。

**後果 2：記憶體可能翻倍。** 如果在 `BGSAVE` 期間，主行程把所有頁面都改過一遍，那麼所有頁面都會被複製——記憶體用量變成兩倍。

```text
最壞情況：10GB 的實例做 BGSAVE，期間高頻寫入
=> 可能需要接近 20GB 記憶體
=> 如果機器只有 16GB，觸發 swap 或 OOM
```

實務上不會真的翻倍（通常只有一小部分頁面被修改），但**這是 `maxmemory` 要留 30-40% 餘裕的核心原因**。

觀察實際的 COW 用量：

```bash
INFO persistence | grep cow
# rdb_last_cow_size:134217728      <- 上次 BGSAVE 期間 COW 用了 128MB
# aof_last_cow_size:0
```

**後果 3：需要正確設定 `vm.overcommit_memory`。**

Linux 預設（`vm.overcommit_memory = 0`）會用啟發式判斷來決定是否允許記憶體配置。fork 時，即使實際上只需要少量額外記憶體，核心可能認為「這個行程要求的記憶體量超過可用量」而拒絕 fork：

```text
Redis 日誌會出現：
Can't save in background: fork: Cannot allocate memory
```

解法：

```bash
# 檢查
cat /proc/sys/vm/overcommit_memory

# 設為 1（允許超額配置，讓 fork 成功）
sysctl vm.overcommit_memory=1

# 永久設定
echo "vm.overcommit_memory = 1" >> /etc/sysctl.conf
```

**Redis 啟動時如果偵測到這個值不是 1，會在日誌裡警告。** 這和第 04 章的 THP 一樣，屬於部署 Redis 的標準檢查項。

### RDB 的優缺點

**優點：**

- **檔案緊湊，恢復極快。** RDB 是二進位格式的資料快照，載入時直接重建資料結構。比 AOF 快一個數量級。
- **適合備份與災難恢復。** 一個檔案就是一個完整的時間點，複製到別的地方就是備份。
- **對效能影響集中。** 只在 fork 那一下阻塞，其餘時間由子行程負責。

**缺點：**

- **會遺失資料。** 兩次快照之間的寫入全部遺失。用預設的 `save 300 100`，最壞情況丟 5 分鐘。
- **大實例的 fork 成本高。** 記憶體越大，fork 越慢，COW 風險越高。
- **不能做到「秒級」的持久化。** 快照太頻繁，fork 的開銷會壓垮效能。

---

## 6.4 AOF：追加寫入日誌

AOF（Append Only File）記錄的是**每一個修改資料的命令**，本質上是重做日誌（redo log）。

### 開啟與基本設定

```bash
CONFIG SET appendonly yes        # 動態開啟（會立刻觸發一次重寫產生初始檔案）

# 或在 redis.conf
appendonly yes
appendfsync everysec
```

7.0 之後的檔案結構有變化：

```bash
CONFIG GET appenddirname         # "appendonlydir"（7.0+）
CONFIG GET appendfilename        # "appendonly.aof"
```

目錄裡會看到：

```text
appendonlydir/
├── appendonly.aof.manifest      <- 清單檔，記錄有哪些檔案
├── appendonly.aof.1.base.rdb    <- 基準檔（混合持久化時是 RDB 格式）
└── appendonly.aof.1.incr.aof    <- 增量檔（重寫後的新命令）
```

（7.0 之前是單一個 `appendonly.aof` 檔案。這個改動是為了讓重寫更安全，見第 6.4 節末。）

### 寫入流程與 `appendfsync`

理解 AOF 的關鍵是知道「寫入」其實有兩個階段：

```text
命令執行完
  -> 寫入 AOF 緩衝區（記憶體）        <- 這一步永遠都做，很快
  -> 呼叫 write() 寫入作業系統的頁快取  <- 每個事件循環結束時做
  -> 呼叫 fsync() 真正刷到磁碟         <- 由 appendfsync 決定何時做
```

**資料只有在 `fsync()` 完成後才真正安全。** 停在頁快取的資料，斷電就沒了。

三個選項：

| `appendfsync` | fsync 時機 | 最壞遺失 | 效能影響 |
|--------------|-----------|---------|---------|
| `always` | 每個寫命令都 fsync | 幾乎不遺失（最多一個命令） | **顯著**，吞吐可能掉到 1/10 |
| `everysec` | 每秒一次，由背景執行緒做 | **最多 1 秒** | 小 |
| `no` | 交給作業系統決定 | 幾十秒（Linux 預設 30 秒） | 最小 |

**預設是 `everysec`，也是絕大多數場景的正確選擇。**

關於 `always` 的實際代價，值得說清楚：一次 fsync 在 SSD 上大約幾百微秒，在有電池保護的 RAID 卡上可能更快，在普通雲端磁碟上可能 1-2 毫秒。因為它在寫入路徑上同步發生，**寫入 QPS 的上限直接被 fsync 速度決定**。原本 10 萬 QPS 的寫入能力可能降到幾千。

**一個常被誤解的點：即使用 `everysec`，也不保證「一定只丟 1 秒」。** 如果背景執行緒的上一次 fsync 還沒完成（磁碟慢、或 AOF 重寫正在搶 I/O），主執行緒在下一次要 `write()` 時可能會被迫等待。這時 `LATENCY LATEST` 會出現 `aof-write` 或 `aof-fsync-always` 事件。

### AOF 為什麼需要重寫

AOF 記錄的是命令，所以會有大量冗餘：

```text
INCR counter        -> counter = 1
INCR counter        -> counter = 2
INCR counter        -> counter = 3
...重複一百萬次
=> AOF 裡有一百萬行，但實際只需要記錄 SET counter 1000000
```

更明顯的例子：

```text
LPUSH list a
LPUSH list b
DEL list
LPUSH list c
=> 前三行完全是浪費，只需要 RPUSH list c
```

不重寫的話，AOF 會無限膨脹，而且恢復時要重放所有命令，啟動會非常慢。

**重寫的做法是：讀取當前記憶體狀態，產生一份「能重建這個狀態的最小命令集」。**

### 重寫的觸發

```bash
BGREWRITEAOF        # 手動觸發

CONFIG GET auto-aof-rewrite-percentage    # 100
CONFIG GET auto-aof-rewrite-min-size      # 64mb
```

自動觸發條件是**兩個都滿足**：

```text
AOF 檔案大小 >= auto-aof-rewrite-min-size（64MB）
且
當前大小相對上次重寫後的大小成長了 auto-aof-rewrite-percentage（100% = 翻倍）
```

`min-size` 的存在是為了避免小檔案頻繁重寫。實務上如果你的 AOF 成長很快，可以把 `percentage` 調高（例如 200）減少重寫頻率——因為**重寫本身要 fork**，成本不低。

觀察狀態：

```bash
INFO persistence | grep aof
# aof_enabled:1
# aof_rewrite_in_progress:0
# aof_last_bgrewrite_status:ok
# aof_last_write_status:ok
# aof_rewrite_scheduled:0
# aof_base_size:52428800
# aof_current_size:104857600        <- 已經翻倍，即將觸發重寫
# aof_pending_rewrite:0
```

### 7.0 的多部分 AOF 解決了什麼

7.0 之前的重寫流程有個尷尬的地方：

```text
舊做法：
  1. fork 子行程，把記憶體狀態寫成新的 AOF 檔
  2. 期間主行程繼續處理的新命令，要寫進一個「重寫緩衝區」
  3. 子行程完成後，主行程把重寫緩衝區的內容追加到新檔尾端
  4. 用新檔替換舊檔

問題：
  第 2、3 步需要額外記憶體存重寫緩衝區（高寫入時可能很大）
  第 3 步是主行程在做，資料量大時會阻塞
```

7.0 的做法：

```text
新做法：
  1. 建立一個新的 base 檔（子行程寫），同時建立一個新的 incr 檔
  2. 主行程的新命令直接寫進新的 incr 檔        <- 不需要重寫緩衝區
  3. 子行程完成後，更新 manifest 檔指向新的 base + incr
  4. 刪除舊檔
```

**收益：不再需要重寫緩衝區（省記憶體）、不再有第 3 步的追加阻塞（省延遲）。** 這是升級到 7.x 的一個實際好處。

### 混合持久化：`aof-use-rdb-preamble`

```bash
CONFIG GET aof-use-rdb-preamble
# "yes"      <- 4.0 之後的預設值
```

開啟時，AOF 重寫產生的 base 檔**是 RDB 格式**，而不是一堆 Redis 命令。

```text
AOF 檔案的實際結構：
  [base：RDB 格式的快照]  +  [incr：重寫之後的命令，AOF 格式]
```

好處是**兩邊的優點都拿到了**：

```text
啟動速度：base 部分用 RDB 的方式快速載入（快）
資料安全：incr 部分保留了最近的每個命令（不丟）
```

代價是 base 部分不再是人類可讀的文字。7.0 的多部分 AOF 讓這件事更清楚——base 檔的擴展名直接就是 `.rdb`。

**這個設定應該保持 `yes`。** 沒有理由關掉它。

### AOF 的優缺點

**優點：**

- **資料遺失窗口小。** `everysec` 最多丟 1 秒，`always` 幾乎不丟。
- **檔案是命令記錄，可讀可分析**（incr 部分）。極端情況下可以手動編輯修復。
- **重寫是安全的**（7.0 之後尤其）。

**缺點：**

- **檔案比 RDB 大**（即使有重寫）。
- **恢復比 RDB 慢**（要重放 incr 部分的命令）。混合持久化緩解了這點。
- **重寫要 fork**，同樣有 fork 的成本。
- **`always` 模式對效能影響大。**

---

## 6.5 資料遺失窗口分析

這是本章最實用的一節。**給定一個設定，斷電會丟多少資料？**

### 情境 1：只開 RDB，預設 `save`

```text
save 3600 1 / 300 100 / 60 10000
```

最壞情況：上次快照後只有 99 次寫入，且不到 3600 秒。那麼這 99 次寫入全部遺失，且**時間跨度可能接近一小時**。

```bash
INFO persistence | grep rdb_changes_since_last_save
# rdb_changes_since_last_save:8523     <- 這 8523 次寫入現在斷電就沒了
```

**適合：純快取。不適合任何你會在意的資料。**

### 情境 2：只開 AOF，`everysec`

最壞情況：**1 秒的寫入。**

但要注意兩個「比 1 秒更糟」的例外：

- 如果磁碟卡住，fsync 延遲，實際窗口可能更長。
- 如果是**行程崩潰**（不是機器斷電），已經 `write()` 到頁快取的資料其實還在（作業系統會負責寫下去）。所以行程崩潰的遺失量遠小於斷電。

```text
Redis 行程被 kill      -> 頁快取的資料仍會被作業系統寫入磁碟，幾乎不丟
機器斷電 / 硬體故障     -> 頁快取遺失，丟最多 1 秒
```

**這個區別很重要**：多數「重啟 Redis」的情況（部署、OOM kill、手動重啟）屬於前者，實際遺失比理論值小得多。

### 情境 3：只開 AOF，`always`

最壞情況：**一個命令**（正在寫入但還沒 fsync 完成的那個）。

代價是寫入吞吐大幅下降。

### 情境 4：RDB + AOF 都開（推薦）

恢復時**以 AOF 為準**（見下節），所以遺失窗口由 AOF 決定：`everysec` 下是 1 秒。

RDB 在這裡的角色是**備份與快速災難恢復**：AOF 檔損壞時你還有 RDB 可以退回，而且 RDB 檔小、方便傳到異地。

### 情境 5：都不開

重啟即全部遺失。

**這在某些場景是合理的**：純快取、且你確定能承受冷啟動（快取全空時大量請求打到資料庫）。要用這個設定，必須先確認資料庫扛得住冷啟動的流量，並且有預熱機制。

### 總表

| 設定 | 斷電遺失 | 恢復速度 | 寫入效能影響 | 適合 |
|------|---------|---------|------------|------|
| 都不開 | 全部 | 最快（無資料） | 無 | 純快取，可承受冷啟動 |
| 只 RDB | 幾分鐘到一小時 | 快 | 小（僅 fork） | 快取、可重算的統計 |
| 只 AOF `everysec` | 1 秒 | 中（混合持久化下較快） | 小 | 多數業務場景 |
| 只 AOF `always` | 幾乎 0 | 中 | **大** | 有強持久化需求，且能接受效能代價 |
| RDB + AOF `everysec` | 1 秒 | 中 | 小 | **生產環境推薦** |

---

## 6.6 恢復流程與載入優先級

### 啟動時載入哪個檔案

```text
if (appendonly == yes)
    載入 AOF（appendonlydir/）
    如果 AOF 目錄不存在或為空 -> 空資料庫啟動（不會去讀 RDB！）
else
    載入 RDB（dump.rdb）
```

**這是一個非常重要的陷阱：開啟 AOF 時，Redis 完全不會去看 RDB 檔案。**

實務事故場景：

```text
1. 一個實例原本只用 RDB，有 10GB 資料在 dump.rdb
2. 有人想加強持久化，在設定檔加上 appendonly yes 然後重啟
3. Redis 啟動 -> 發現沒有 AOF 目錄 -> 以空資料庫啟動
4. 10GB 資料看起來全部消失（其實 dump.rdb 還在，但 Redis 不讀它）
```

**正確的開啟 AOF 方式是用動態設定，而不是改設定檔重啟：**

```bash
# 在運行中的實例執行
CONFIG SET appendonly yes
# Redis 會立刻用當前記憶體的資料做一次 AOF 重寫，產生完整的 AOF 檔

# 確認完成
INFO persistence | grep aof_rewrite_in_progress    # 等它變成 0
INFO persistence | grep aof_last_bgrewrite_status  # 應該是 ok

# 確認之後，才把 appendonly yes 寫進設定檔（讓下次重啟也生效）
CONFIG REWRITE      # 或手動編輯 redis.conf
```

`CONFIG REWRITE` 會把當前的運行時設定寫回設定檔，很方便但要注意它會重新格式化整個檔案（註解可能遺失）。

### 從備份恢復的步驟

```bash
# 1. 停止 Redis（優雅關閉，會做最後一次持久化）
redis-cli -a pass SHUTDOWN
# 如果不想做最後一次保存（例如資料已經有問題）：
# redis-cli -a pass SHUTDOWN NOSAVE

# 2. 確認要恢復的檔案，放到 dir 指定的目錄
cp /backup/dump-20260813.rdb /var/lib/redis/dump.rdb
chown redis:redis /var/lib/redis/dump.rdb

# 3. 如果 appendonly 是 yes，必須先關掉，否則 RDB 不會被載入
#    在設定檔改 appendonly no

# 4. 啟動
systemctl start redis

# 5. 驗證
redis-cli -a pass DBSIZE
redis-cli -a pass INFO keyspace

# 6. 資料確認無誤後，再動態開啟 AOF
redis-cli -a pass CONFIG SET appendonly yes
redis-cli -a pass CONFIG REWRITE
```

第 3 步和第 6 步的順序是關鍵。很多人卡在「明明把 RDB 放回去了，資料卻是空的」，原因就是 `appendonly yes` 還開著。

### 檔案損壞的修復

```bash
# 檢查 RDB
redis-check-rdb /var/lib/redis/dump.rdb
# [offset 0] Checking RDB file dump.rdb
# ...
# \o/ RDB looks OK! \o/

# 檢查並修復 AOF（7.0+ 要指定 manifest）
redis-check-aof /var/lib/redis/appendonlydir/appendonly.aof.manifest
redis-check-aof --fix /var/lib/redis/appendonlydir/appendonly.aof.manifest
```

**`--fix` 的做法是「截斷到最後一個完整的命令」**，也就是丟棄尾端不完整的部分。它會問你確認，因為這是有損操作。

**修復前一定要先備份原始檔案。** `--fix` 是不可逆的。

```bash
cp -r /var/lib/redis/appendonlydir /var/lib/redis/appendonlydir.bak
redis-check-aof --fix /var/lib/redis/appendonlydir/appendonly.aof.manifest
```

相關設定：

```bash
CONFIG GET aof-load-truncated
# "yes"      <- 預設
```

`yes` 表示啟動時遇到「尾端被截斷的 AOF」會容忍它（載入到最後一個完整命令並記錄警告），而不是拒絕啟動。**這通常是你想要的**——尾端截斷正是斷電最常見的結果。設為 `no` 會讓 Redis 拒絕啟動並要求你手動處理。

### RDB 版本相容性

RDB 檔案有版本號。**新版 Redis 能讀舊版 RDB，但舊版 Redis 不能讀新版 RDB。**

```text
Redis 7.2 可以載入 Redis 6.0 產生的 RDB      -> 可以
Redis 6.0 載入 Redis 7.2 產生的 RDB          -> 失敗
```

所以升級是單向的。**降級（rollback）時不能直接用新版產生的 RDB**——這是升級計畫必須考慮的事：升級前先留一份舊版格式的備份。

---

## 6.7 生產環境設定建議

### 推薦配置

```bash
# ---- RDB：作為備份與災難恢復手段 ----
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb
dir /var/lib/redis
rdbcompression yes
rdbchecksum yes
# 純快取設 no（避免磁碟問題導致寫入全掛）；重要資料設 yes
stop-writes-on-bgsave-error no

# ---- AOF：作為主要的持久化手段 ----
appendonly yes
appendfsync everysec
aof-use-rdb-preamble yes
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
aof-load-truncated yes
# 重寫期間不做 fsync：延遲更平穩，但重寫期間的遺失窗口變大
no-appendfsync-on-rewrite no

# ---- 系統層面（在宿主機設定） ----
# vm.overcommit_memory = 1
# transparent_hugepage = never
```

關於 `no-appendfsync-on-rewrite`：設為 `yes` 可以避免「AOF 重寫的磁碟 I/O」和「fsync」互相搶資源造成的延遲尖峰，代價是重寫期間（可能幾十秒）的資料遺失窗口變大。**磁碟較慢的環境可以考慮設 `yes`，SSD 環境保持 `no`。**

### 在從節點做持久化

第 04 章提過的技巧，這裡展開：

```text
主節點：關閉 RDB 與 AOF（save "" 、appendonly no）
        -> 完全沒有 fork，延遲最平穩
從節點：開啟 AOF + RDB
        -> 承擔所有持久化的 fork 成本
```

**收益很明顯**：主節點的 P99 延遲不再有持久化造成的尖峰。

**但風險也要說清楚：**

```text
風險 1：如果主節點重啟，它會以空資料庫啟動
        -> 然後從節點跟它同步 -> 從節點的資料也被清空
        -> 兩邊都空了

這是真實發生過的事故。
```

所以採用這個方案必須配套：

- **主節點必須設定 `appendonly no` 且不能自動重啟。** 主節點掛掉時，正確流程是「把從節點提升為主」，不是「重啟原主節點」。
- **用 Sentinel 或 Cluster 管理故障轉移**，不要靠手動或 systemd 的自動重啟。
- **明確的維運文件**，因為這個坑不直觀，值班的人不一定知道。

如果你的團隊沒有成熟的故障轉移機制，**建議主節點也開 AOF**，用效能換安全。

### 備份策略

持久化檔案在本機，**本機磁碟損壞就一起沒了**。所以還需要備份：

```bash
#!/bin/bash
# 每日備份腳本
set -e

BACKUP_DIR=/backup/redis
DATE=$(date +%Y%m%d-%H%M)
REDIS_DIR=/var/lib/redis

# 觸發一次快照並等它完成
BEFORE=$(redis-cli -a "$PASS" --no-auth-warning LASTSAVE)
redis-cli -a "$PASS" --no-auth-warning BGSAVE

while [ "$(redis-cli -a "$PASS" --no-auth-warning LASTSAVE)" = "$BEFORE" ]; do
  sleep 1
done

# 確認這次保存成功
STATUS=$(redis-cli -a "$PASS" --no-auth-warning INFO persistence \
  | grep rdb_last_bgsave_status | cut -d: -f2 | tr -d '\r')
if [ "$STATUS" != "ok" ]; then
  echo "BGSAVE 失敗，中止備份" >&2
  exit 1
fi

# 複製並壓縮
cp "$REDIS_DIR/dump.rdb" "$BACKUP_DIR/dump-$DATE.rdb"
gzip "$BACKUP_DIR/dump-$DATE.rdb"

# 上傳到異地（S3 / OSS / 其他）
aws s3 cp "$BACKUP_DIR/dump-$DATE.rdb.gz" "s3://my-backup/redis/"

# 清理 7 天前的本機備份
find "$BACKUP_DIR" -name "dump-*.rdb.gz" -mtime +7 -delete
```

三個關鍵設計：

**用 `LASTSAVE` 判斷 `BGSAVE` 是否完成。** `BGSAVE` 是異步的，立刻複製檔案可能拿到寫入中的不完整檔案。比較 `LASTSAVE` 的時間戳變化才能確認完成。

**檢查 `rdb_last_bgsave_status`。** `BGSAVE` 可能失敗（磁碟滿、fork 失敗），要確認成功才備份。

**必須上傳異地。** 備份和資料在同一顆磁碟上，等於沒有備份。

### 最重要的一件事：定期做恢復演練

**沒有演練過的備份，等於沒有備份。** 常見的失敗：

- 備份檔案其實是壞的，但沒人發現（因為從沒試過恢復）。
- 備份腳本半年前就靜默失敗了（因為沒有監控）。
- 恢復流程沒人會，事故當下現學（第 6.6 節的 `appendonly` 陷阱就會卡住你）。

建議每季度做一次：**在測試環境用最新的生產備份完整恢復一次，記錄耗時，驗證資料完整性。**

---

## 6.8 持久化 ≠ 高可用

這是概念上必須分清楚的一件事：

| | 持久化 | 主從複製 |
|---|--------|---------|
| 解決什麼 | 行程或機器重啟後，資料還在 | 一個節點掛掉，另一個節點能接手 |
| 恢復時間 | 分鐘級（要載入檔案） | 秒級（故障轉移） |
| 防護對象 | 行程崩潰、機器重啟 | 節點永久故障、機器損壞 |
| 資料遺失 | 由 fsync 策略決定 | 由複製延遲決定（異步複製會丟） |

**兩者不能互相取代：**

```text
只有持久化，沒有複製：
  機器硬碟壞了 -> 檔案沒了 -> 資料全丟
  機器重啟要幾分鐘 -> 這段時間服務不可用

只有複製，沒有持久化：
  整個機房斷電，所有節點一起重啟 -> 全部空資料庫
  誤操作（FLUSHALL）會立刻複製到從節點 -> 兩邊都沒了
```

**所以生產環境需要三層防護：**

```text
第 1 層：主從複製 + 自動故障轉移   -> 應對單節點故障（秒級恢復）
第 2 層：持久化                    -> 應對行程 / 機器重啟（分鐘級恢復）
第 3 層：異地備份                  -> 應對機房災難、誤操作（小時級恢復）
```

第 11 章會處理第 1 層。這裡要記住的是：**不要以為「我開了 AOF 就安全了」。**

---

## 6.9 常見錯誤

### 錯誤 1：以為開了持久化資料就不會丟

`everysec` 仍有 1 秒窗口，RDB 有幾分鐘窗口。核心資料要有真正的資料庫。

### 錯誤 2：改設定檔加上 `appendonly yes` 然後重啟

Redis 會以空資料庫啟動（因為沒有 AOF 檔，且不會退回讀 RDB）。要用 `CONFIG SET appendonly yes` 動態開啟。

### 錯誤 3：恢復 RDB 時忘記關掉 `appendonly`

RDB 不會被載入，資料看起來是空的。

### 錯誤 4：`BGSAVE` 之後立刻複製 RDB 檔

`BGSAVE` 是異步的，可能拿到不完整的檔案。用 `LASTSAVE` 確認完成。

### 錯誤 5：主節點關掉持久化，但沒有配套的故障轉移機制

主節點一重啟就是空資料庫，然後從節點跟著被清空。

### 錯誤 6：忽略 `stop-writes-on-bgsave-error` 造成的寫入全掛

磁碟滿了會導致所有寫入報 `MISCONF` 錯誤。要有磁碟空間告警。

### 錯誤 7：沒設 `vm.overcommit_memory = 1`

fork 可能失敗，導致無法持久化，然後觸發錯誤 6。

### 錯誤 8：`maxmemory` 設太滿，`BGSAVE` 期間 OOM

COW 需要額外記憶體。`maxmemory` 不要超過實體記憶體的 60-70%。

### 錯誤 9：備份和資料放在同一顆磁碟

必須異地。

### 錯誤 10：從來沒做過恢復演練

事故當下才發現備份是壞的，或沒人會恢復。

### 錯誤 11：以為主從複製取代了持久化

一起斷電就一起空。誤操作也會立刻同步。

---

## 6.10 本章練習

### 練習 1：計算資料遺失量

以下四個設定，各自在「機器突然斷電」時最多會丟多少資料？在「Redis 行程被 `kill -9`」時呢？

1. `save 900 1`，`appendonly no`
2. `save ""`，`appendonly yes`，`appendfsync everysec`
3. `save ""`，`appendonly yes`，`appendfsync always`
4. `save ""`，`appendonly no`

<details>
<summary>參考解答</summary>

| 設定 | 機器斷電 | `kill -9` 行程 |
|------|---------|---------------|
| 1. 只 RDB | 最多 **900 秒**的寫入 | 同樣最多 900 秒 |
| 2. AOF everysec | 最多 **1 秒** | **幾乎不丟** |
| 3. AOF always | 最多 **1 個命令** | 幾乎不丟 |
| 4. 都不開 | **全部** | **全部** |

**關鍵區別在第 2 行：為什麼 `kill -9` 的遺失量比斷電小？**

因為 AOF 的寫入分兩步：

```text
write() -> 資料進入作業系統的頁快取（此時 Redis 行程已經「交出去」了）
fsync() -> 資料真正落到磁碟
```

- **`kill -9` 殺掉的是 Redis 行程，但作業系統還活著。** 頁快取裡的資料會由作業系統繼續寫入磁碟。所以已經 `write()` 的資料不會丟——而 Redis 在每個事件循環結束時都會 `write()`，所以遺失量極小。
- **機器斷電時頁快取也消失了。** 只有 `fsync()` 完成的資料才安全，所以窗口是 fsync 的間隔（1 秒）。

**設定 1 為什麼兩種情況一樣？** 因為 RDB 不是持續寫入的，它是「到了觸發條件才做一次完整快照」。行程被殺掉時，記憶體裡的資料直接消失，沒有任何機制能救回來。

**這個區別的實務意義：**

```text
最常見的「Redis 重啟」原因：
  部署新版本、手動重啟、OOM killer、容器被重新調度
  -> 這些都是「行程層級」的事件，AOF everysec 幾乎不丟資料

真正的斷電 / 硬體故障相對罕見
  -> 這才是 everysec 那 1 秒窗口生效的場合
```

所以 `everysec` 在實務上的表現比理論值好很多，這也是它成為預設值的原因。

**追問：設定 3 的效能代價值得嗎？**

從 `everysec` 換到 `always`，換來的是「把斷電時的 1 秒窗口縮小到幾乎 0」，付出的是**寫入吞吐可能降到 1/10**。

判斷方式：如果這 1 秒的資料遺失會造成無法接受的後果（例如金流），那答案不是用 `always`，而是**這份資料不該只存在 Redis**。用 `always` 是在試圖把 Redis 變成關聯式資料庫，而它並不擅長這件事。

</details>

### 練習 2：實際驗證資料遺失

設計實驗，實測「RDB only」和「AOF everysec」在容器被強制刪除時的資料遺失量。

<details>
<summary>參考解答</summary>

**準備兩個獨立的容器分別測試。**

**實驗 A：只開 RDB**

```bash
docker run --name redis-rdb -d -p 6390:6379 redis:7.2 \
  redis-server --save "3600 1" --appendonly no
```

`save 3600 1` 意味著「一小時內有 1 次寫入就快照」——所以在實驗的短時間內不會自動觸發。

```bash
# 先寫入一批資料並手動觸發快照
redis-cli -p 6390 EVAL "
for i=1,1000 do redis.call('SET', 'before:'..i, i) end
return redis.call('DBSIZE')" 0
# (integer) 1000

redis-cli -p 6390 BGSAVE
sleep 2
redis-cli -p 6390 LASTSAVE

# 快照之後再寫入一批（這批只在記憶體裡）
redis-cli -p 6390 EVAL "
for i=1,500 do redis.call('SET', 'after:'..i, i) end
return redis.call('DBSIZE')" 0
# (integer) 1500

redis-cli -p 6390 INFO persistence | grep rdb_changes_since_last_save
# rdb_changes_since_last_save:500     <- 這 500 次寫入處於風險中

# 模擬斷電：直接 kill 容器（不給它優雅關閉的機會）
docker kill redis-rdb
docker start redis-rdb
sleep 3

redis-cli -p 6390 DBSIZE
# (integer) 1000        <- 只剩快照時的資料

redis-cli -p 6390 EXISTS after:1
# (integer) 0           <- 快照後的 500 筆全部遺失
```

**注意 `docker kill` 和 `docker stop` 的差別：** `docker stop` 會先發 `SIGTERM`，Redis 收到後會做一次持久化再退出（優雅關閉），資料不會丟。`docker kill` 發 `SIGKILL`，等同 `kill -9`，沒有機會保存。**要驗證資料遺失必須用 `docker kill`。**

**實驗 B：AOF everysec**

```bash
docker run --name redis-aof -d -p 6391:6379 redis:7.2 \
  redis-server --save "" --appendonly yes --appendfsync everysec
```

```bash
redis-cli -p 6391 EVAL "
for i=1,1000 do redis.call('SET', 'before:'..i, i) end
return redis.call('DBSIZE')" 0

# 不做任何手動保存，直接寫入更多資料然後立刻 kill
redis-cli -p 6391 EVAL "
for i=1,500 do redis.call('SET', 'after:'..i, i) end
return redis.call('DBSIZE')" 0
# (integer) 1500

docker kill redis-aof
docker start redis-aof
sleep 3

redis-cli -p 6391 DBSIZE
# (integer) 1500        <- 全部保住了
```

**為什麼 AOF 一筆都沒丟？** 這正是練習 1 的結論：`docker kill` 殺的是行程，`write()` 到頁快取的資料仍會被作業系統（在這裡是容器的宿主機核心）寫入磁碟。

**要真正驗證那 1 秒的窗口，需要模擬「連作業系統一起消失」**，例如強制關閉整台虛擬機。在 Docker 環境裡很難精確模擬，但可以用另一個角度觀察窗口的存在：

```bash
# 觀察 AOF 檔案大小和實際寫入的關係
docker exec redis-aof sh -c "ls -la /data/appendonlydir/"

# 高速寫入的同時觀察檔案大小的變化滯後
docker exec redis-aof sh -c "
redis-cli EVAL \"for i=1,100000 do redis.call('SET','k'..i,i) end return 1\" 0 &
for i in 1 2 3 4 5; do
  ls -la /data/appendonlydir/*.incr.aof | awk '{print \$5}'
  sleep 1
done
"
```

你會看到檔案大小是**階梯式**增長的，而不是連續的——那些「還沒反映在檔案大小上」的寫入，就是處於風險窗口中的資料。

**實驗 C：驗證 `SHUTDOWN` 是安全的**

```bash
redis-cli -p 6390 EVAL "
for i=1,300 do redis.call('SET', 'shutdown_test:'..i, i) end
return 1" 0

redis-cli -p 6390 SHUTDOWN NOSAVE 2>/dev/null   # 明確不保存
docker start redis-rdb
sleep 3
redis-cli -p 6390 EXISTS shutdown_test:1
# (integer) 0        <- NOSAVE 所以丟了

# 對比：預設的 SHUTDOWN 會保存
redis-cli -p 6390 EVAL "
for i=1,300 do redis.call('SET', 'shutdown_test2:'..i, i) end
return 1" 0
redis-cli -p 6390 SHUTDOWN 2>/dev/null
docker start redis-rdb
sleep 3
redis-cli -p 6390 EXISTS shutdown_test2:1
# (integer) 1        <- 保住了
```

**這說明「正常重啟」和「異常崩潰」的差別很大。** 部署流程一定要用優雅關閉（`SHUTDOWN` 或 `SIGTERM`），不要用 `kill -9`。

**清理**

```bash
docker rm -f redis-rdb redis-aof
```

</details>

### 練習 3：完整的恢復演練

模擬一次真實的災難恢復：從備份的 RDB 檔案恢復一個實例，並在恢復後正確開啟 AOF。過程中要處理「檔案損壞」的情況。

<details>
<summary>參考解答</summary>

**第 1 步：建立一個有資料的實例並產生備份**

```bash
docker run --name redis-src -d -p 6392:6379 -v redis-src-data:/data redis:7.2 \
  redis-server --save "3600 1" --appendonly no

redis-cli -p 6392 EVAL "
for i=1,5000 do
  redis.call('HSET', 'user:'..i, 'name', 'user_'..i, 'level', i % 10)
end
for i=1,1000 do
  redis.call('ZADD', 'rank:global', i * 10, 'user:'..i)
end
return redis.call('DBSIZE')" 0
# (integer) 5001

# 產生快照並確認完成
BEFORE=$(redis-cli -p 6392 LASTSAVE)
redis-cli -p 6392 BGSAVE
while [ "$(redis-cli -p 6392 LASTSAVE)" = "$BEFORE" ]; do sleep 1; done
redis-cli -p 6392 INFO persistence | grep rdb_last_bgsave_status
# rdb_last_bgsave_status:ok

# 取出備份
docker cp redis-src:/data/dump.rdb ./backup-dump.rdb
ls -la backup-dump.rdb
```

**第 2 步：驗證備份檔案的完整性**

```bash
# 用容器裡的工具檢查（本機可能沒裝）
docker cp ./backup-dump.rdb redis-src:/tmp/check.rdb
docker exec redis-src redis-check-rdb /tmp/check.rdb
# [offset 0] Checking RDB file /tmp/check.rdb
# [offset 26] AUX FIELD redis-ver = '7.2.x'
# ...
# [info] 5001 keys read
# \o/ RDB looks OK! \o/
```

**每次備份後都該跑這個檢查。** 一個壞掉的備份比沒有備份更危險，因為它給你虛假的安全感。

**第 3 步：模擬災難並恢復到新實例**

```bash
# 「原實例毀了」
docker rm -f redis-src

# 建立新實例，先不要啟動 Redis
docker volume create redis-restore-data
docker run --rm -v redis-restore-data:/data -v "$PWD":/backup alpine \
  cp /backup/backup-dump.rdb /data/dump.rdb

# 啟動，注意 appendonly 必須是 no，否則不會讀 RDB
docker run --name redis-restore -d -p 6393:6379 -v redis-restore-data:/data redis:7.2 \
  redis-server --save "3600 1" --appendonly no

sleep 3
redis-cli -p 6393 DBSIZE
# (integer) 5001       <- 恢復成功

# 驗證資料內容，不要只看數量
redis-cli -p 6393 HGETALL user:100
redis-cli -p 6393 ZREVRANGE rank:global 0 4 WITHSCORES
redis-cli -p 6393 ZCARD rank:global
# (integer) 1000
```

**驗證要看內容，不能只看 `DBSIZE`。** key 數量對但資料結構錯誤（例如編碼問題導致某些型別載入異常）的情況雖然罕見，但值得檢查幾個代表性的 key。

**第 4 步：故意犯錯，體驗 `appendonly` 陷阱**

```bash
docker rm -f redis-restore

# 這次「不小心」在啟動時就開了 appendonly
docker volume create redis-wrong-data
docker run --rm -v redis-wrong-data:/data -v "$PWD":/backup alpine \
  cp /backup/backup-dump.rdb /data/dump.rdb

docker run --name redis-wrong -d -p 6394:6379 -v redis-wrong-data:/data redis:7.2 \
  redis-server --appendonly yes

sleep 3
redis-cli -p 6394 DBSIZE
# (integer) 0          <- 資料「不見了」！

# 但檔案其實還在
docker exec redis-wrong ls -la /data/
# dump.rdb 還在那裡，只是 Redis 開了 AOF 所以完全沒去讀它
```

**這就是第 6.6 節的陷阱。** 修正方式：

```bash
docker rm -f redis-wrong

docker run --name redis-fixed -d -p 6394:6379 -v redis-wrong-data:/data redis:7.2 \
  redis-server --appendonly no     # 先用 no 啟動

sleep 3
redis-cli -p 6394 DBSIZE
# (integer) 5001       <- 資料回來了

# 確認資料正確後，才動態開啟 AOF
redis-cli -p 6394 CONFIG SET appendonly yes

# 等重寫完成
while [ "$(redis-cli -p 6394 INFO persistence | grep aof_rewrite_in_progress | cut -d: -f2 | tr -d '\r')" != "0" ]; do
  sleep 1
done
redis-cli -p 6394 INFO persistence | grep aof_last_bgrewrite_status
# aof_last_bgrewrite_status:ok

# 確認 AOF 檔案真的產生了
docker exec redis-fixed ls -la /data/appendonlydir/
# appendonly.aof.manifest
# appendonly.aof.1.base.rdb
# appendonly.aof.1.incr.aof

# 把設定持久化到設定檔（這樣下次重啟也會開 AOF，且此時已有 AOF 檔可讀）
redis-cli -p 6394 CONFIG REWRITE
```

**第 5 步：驗證現在重啟是安全的**

```bash
redis-cli -p 6394 SET verify:after-aof "ok"
docker restart redis-fixed
sleep 3
redis-cli -p 6394 DBSIZE
# (integer) 5002
redis-cli -p 6394 GET verify:after-aof
# "ok"
```

**第 6 步：處理損壞的 AOF**

```bash
# 故意截斷 AOF 的增量檔（模擬斷電造成的尾端不完整）
docker exec redis-fixed sh -c '
  f=/data/appendonlydir/appendonly.aof.1.incr.aof
  size=$(stat -c %s "$f")
  echo "原始大小：$size"
  # 砍掉最後 20 bytes
  truncate -s $((size - 20)) "$f"
  echo "截斷後：$(stat -c %s "$f")"
'

docker restart redis-fixed
sleep 3
docker logs --tail 30 redis-fixed
```

因為 `aof-load-truncated` 預設是 `yes`，Redis 會在日誌裡警告但仍然啟動：

```text
# !!! Warning: short read while loading the AOF file ...
# AOF loaded anyway because aof-load-truncated is enabled
```

```bash
redis-cli -p 6394 DBSIZE      # 應該能正常回應
```

**如果損壞不在尾端（例如中間的位元組被改壞了），Redis 會拒絕啟動。** 這時要用 `redis-check-aof --fix`：

```bash
# 先備份，--fix 是不可逆的
docker exec redis-fixed cp -r /data/appendonlydir /data/appendonlydir.bak

docker exec redis-fixed redis-check-aof /data/appendonlydir/appendonly.aof.manifest
docker exec -it redis-fixed redis-check-aof --fix /data/appendonlydir/appendonly.aof.manifest
# 會問 "Continue? [y/N]"，確認後它會截斷到最後一個完整命令
```

**第 7 步：把演練寫成文件**

這是演練最重要的產出。文件應該包含：

```text
1. 備份存放位置與命名規則
2. 恢復步驟（含 appendonly 必須先設 no 這個關鍵點）
3. 驗證清單（DBSIZE + 抽樣檢查各型別的 key）
4. 恢復耗時的實測值（用來估算 RTO）
5. 常見錯誤與對應處理
6. 誰有權限執行、需要誰批准
```

**實測恢復耗時尤其重要**，因為它就是你的 RTO（恢復時間目標）。5000 個 key 的恢復是秒級，但 10GB 的實例可能要幾分鐘——這個數字必須事先知道，而不是在事故當下才發現「原來要 20 分鐘」。

**清理**

```bash
docker rm -f redis-fixed
docker volume rm redis-restore-data redis-wrong-data redis-src-data 2>/dev/null
rm -f backup-dump.rdb
```

</details>

---

## 6.11 驗收清單

進入下一章前，確認你可以：

- [ ] 說明 RDB 與 AOF 的機制差異，以及各自的優缺點。
- [ ] 說明 `BGSAVE` 的 fork + COW 原理，以及記憶體可能翻倍的風險。
- [ ] 說出 `vm.overcommit_memory` 為什麼要設 1。
- [ ] 說出 `appendfsync` 三個選項的資料遺失窗口與效能代價。
- [ ] 解釋為什麼「行程被 kill」的遺失量比「機器斷電」小。
- [ ] 說明 AOF 為什麼需要重寫，以及 7.0 的多部分 AOF 改善了什麼。
- [ ] 說明混合持久化（`aof-use-rdb-preamble`）的好處。
- [ ] 給定一組設定，算出斷電最多會丟多少資料。
- [ ] 說出「開著 `appendonly yes` 時 RDB 不會被載入」這個陷阱，以及正確的開啟方式。
- [ ] 完成一次從 RDB 備份恢復的完整流程，包含驗證。
- [ ] 說明 `stop-writes-on-bgsave-error` 可能造成的寫入全掛，以及排查方向。
- [ ] 說明持久化和主從複製解決的是不同問題，以及生產環境需要的三層防護。

---

下一章回到程式設計層面：[07-pipeline-transaction-lua.md](./07-pipeline-transaction-lua.md)，我們會處理「怎麼把多個命令變成一次往返」以及「怎麼讓多個命令變成一個原子操作」——這是兩件不同的事，很多人搞混了。
