# 第 12 章：監控與線上排錯

> 前面十一章講的都是「怎麼做對」。這章講的是「做錯之後，你怎麼在半夜兩點的三十分鐘內找到原因」。
> Redis 出事時的症狀高度重複：延遲突然飆高、記憶體莫名暴漲、連線數打滿、資料無故消失。而這四種症狀背後的原因加起來不超過十五種——**只要你知道該按什麼順序查什麼指標，多數問題可以在十分鐘內定位。**
> 沒有這套順序的話，你會做的是：重啟看看、加機器看看、把 TTL 調短看看。這些動作偶爾會讓症狀消失，但你永遠不知道為什麼，於是它下個月會再來一次。
> 這章要建立的是：關鍵指標的判讀能力，以及四個可以直接照著跑的排錯劇本。

---

## 12.1 學習目標

完成本章後，你應該可以：

- 說明監控的三個層次，以及各自該看哪些指標。
- 逐項解讀 `INFO` 各區塊的關鍵欄位，知道每個數字異常時代表什麼。
- 列出必須設告警的指標與合理閾值，並說明閾值怎麼推。
- 用 `SLOWLOG` 找出慢命令，並知道它的兩個盲點。
- 用 `LATENCY MONITOR`、`LATENCY DOCTOR`、`--intrinsic-latency` 定位延遲來源。
- 用 `MEMORY DOCTOR`、`MEMORY STATS`、`--bigkeys` 診斷記憶體問題。
- 用 `CLIENT LIST` 找出異常連線與緩衝區問題。
- 正確使用 `redis-benchmark`，避免測出沒有意義的數字。
- 照著四個劇本排查：延遲飆高、記憶體暴漲、連線打滿、資料消失。
- 建立一套最小可用的監控體系。

---

## 12.2 監控的三個層次

多數團隊的 Redis 監控只有一張「記憶體使用率」的圖，出事時完全不夠用。完整的監控要涵蓋三層：

```text
第 1 層：可用性 —— 它還活著嗎？
  PING 是否有回應、主從連線狀態、故障轉移事件
  → 這層出問題 = 服務中斷，必須立刻告警（P0）

第 2 層：資源 —— 它撐得住嗎？
  記憶體、CPU、連線數、網路流量、驅逐與過期速率
  → 這層惡化 = 未來會出事，要在惡化到臨界前告警（P1）

第 3 層：業務 —— 它做對了嗎？
  命中率、慢命令、延遲分布、各命令的呼叫量
  → 這層異常 = 效能或正確性問題，用於分析與調校（P2）
```

**第 3 層最常被忽略，但它是排錯時最有用的。** 記憶體 90% 只告訴你「快滿了」，命令分布卻能告訴你「因為某個服務昨天開始每秒呼叫 5 萬次 `HGETALL`」。

---

## 12.3 `INFO`：逐區塊解讀

`INFO` 是 Redis 監控的核心，它有十幾個區塊。可以只取需要的：

```bash
redis-cli -a coursepass INFO memory
redis-cli -a coursepass INFO stats
redis-cli -a coursepass INFO all       # 包含 commandstats、latencystats
```

以下按實務重要性排序。

### `# Memory`

```text
used_memory:1073741824               Redis 分配器分配的記憶體（邏輯用量）
used_memory_human:1.00G
used_memory_rss:1288490188           作業系統看到的實體記憶體（含碎片）
used_memory_peak:2147483648          歷史峰值 —— 重要！
used_memory_lua:36864                Lua 引擎佔用
used_memory_scripts:512
maxmemory:2147483648                 上限
maxmemory_policy:allkeys-lru         驅逐策略
mem_fragmentation_ratio:1.20         rss / used_memory
mem_allocator:jemalloc-5.3.0
```

**`used_memory_peak` 是最容易被忽略的欄位。** 它告訴你「這個實例歷史上曾經用到多少」。如果目前是 1GB 但峰值是 8GB，代表某個時間點發生過異常（大量寫入、big key、客戶端緩衝區暴漲），值得追查。

**`mem_fragmentation_ratio` 的判讀**（第 05 章詳談）：

| 數值 | 含義 | 處理 |
|------|------|------|
| ~1.0 ～ 1.5 | 正常 | 不用管 |
| > 1.5 | 碎片偏高 | 考慮開啟 `activedefrag`，或重啟 |
| **< 1.0** | **記憶體被 swap 到磁碟！** | **立刻處理**，Redis 效能會崩潰 |

小於 1 特別危險——它代表作業系統把 Redis 的記憶體換出到磁碟了，延遲會從微秒級變成毫秒甚至更差。

```bash
# 確認是否真的在 swap
cat /proc/$(pgrep redis-server | head -1)/smaps | grep -i swap | awk '{s+=$2} END {print s" kB"}'
```

### `# Stats`

```text
total_connections_received:1250000   累計連線數
total_commands_processed:98765432    累計命令數
instantaneous_ops_per_sec:12500      即時 QPS ★
total_net_input_bytes:...
total_net_output_bytes:...
rejected_connections:0               因為超過 maxclients 被拒絕的連線 ★
sync_full:2                          全量同步次數 ★（第 11 章）
sync_partial_ok:15
sync_partial_err:0                   部分同步失敗 ★
expired_keys:1234567                 被過期刪除的 key ★
evicted_keys:0                       被驅逐的 key ★★
keyspace_hits:9500000                命中次數 ★
keyspace_misses:500000               未命中次數 ★
pubsub_channels:5
latest_fork_usec:35000               最近一次 fork 耗時（微秒）★★
total_forks:120
```

**`evicted_keys` 是最重要的告警指標之一。** 它不為零就代表記憶體不夠、key 正在被踢掉。第 09 章提過，這會直接反映成命中率下降。

**`latest_fork_usec` 決定了你的持久化會不會造成卡頓**（第 06 章）。它和資料量成正比，超過 100 毫秒（100000 微秒）就要注意，超過 1 秒就是明顯的問題。

**`rejected_connections` 不為零代表連線數打滿了**，見劇本 3。

**`expired_keys` 的尖峰**通常對應 TTL 集中（第 09 章的雪崩前兆）。

### `# Clients`

```text
connected_clients:850                目前連線數 ★
cluster_connections:0
maxclients:10000                     上限
client_recent_max_input_buffer:20480
client_recent_max_output_buffer:0    ★（第 05 章的緩衝區問題）
blocked_clients:12                   阻塞在 BLPOP/BRPOP/XREAD BLOCK 的客戶端
tracking_clients:0
```

`blocked_clients` 不是問題——它就是 `BRPOP` 之類的阻塞命令在等待。但如果這個數字持續等於 `connected_clients`，代表你的消費者全部卡住了。

### `# Persistence`

```text
loading:0                            是否正在載入 RDB/AOF（啟動中）
rdb_changes_since_last_save:15234    上次快照後的變更數 ★（潛在遺失量，第 06 章）
rdb_bgsave_in_progress:0
rdb_last_save_time:1755100000
rdb_last_bgsave_status:ok            ★ 失敗的話寫入可能被拒絕
rdb_last_bgsave_time_sec:3
aof_enabled:1
aof_rewrite_in_progress:0
aof_last_bgrewrite_status:ok         ★
aof_last_write_status:ok             ★★ 失敗代表磁碟寫不進去
```

**`rdb_last_bgsave_status` 或 `aof_last_write_status` 是 `err` 時，Redis 預設會拒絕所有寫入**（`stop-writes-on-bgsave-error yes`）。第 06 章講過，這個錯誤訊息看起來和磁碟毫無關聯，是很常見的困惑來源：

```text
(error) MISCONF Redis is configured to save RDB snapshots, but it's currently
not able to persist on disk.
```

看到 `MISCONF` 第一件事就是查磁碟空間。

### `# Replication`

```text
role:master
connected_slaves:2
slave0:ip=...,port=6379,state=online,offset=123456789,lag=0  ★
master_repl_offset:123456789
master_link_status:up                （從節點視角）★★
master_last_io_seconds_ago:0         ★
master_sync_in_progress:0
```

從節點上的 `master_link_status:down` 是 P0 級告警——複製斷了，這個從節點的資料正在變舊。

複製延遲用 offset 差計算（第 11 章）：

```bash
redis-cli -a coursepass INFO replication | \
  awk -F'[:=,]' '/master_repl_offset/{m=$2} /slave[0-9]/{for(i=1;i<=NF;i++) if($i=="offset") print "lag_bytes="m-$(i+1)}'
```

### `# CPU`

```text
used_cpu_sys:1234.56
used_cpu_user:5678.90
used_cpu_sys_children:12.34          fork 出來的子行程（BGSAVE/AOF 重寫）
used_cpu_user_children:56.78
```

主要用來判斷「CPU 高是主執行緒還是子行程造成的」。子行程的 CPU 高通常是持久化，主執行緒的 CPU 高才是命令處理的問題。

### `# Commandstats`（要 `INFO all` 或 `INFO commandstats`）

**這是排錯時最有價值的區塊，但預設不會出現在 `INFO` 裡。**

```bash
redis-cli -a coursepass INFO commandstats
```

```text
cmdstat_get:calls=5000000,usec=7500000,usec_per_call=1.50,rejected_calls=0,failed_calls=0
cmdstat_hgetall:calls=12000,usec=48000000,usec_per_call=4000.00,rejected_calls=0,failed_calls=0
cmdstat_keys:calls=3,usec=9000000,usec_per_call=3000000.00,...
```

三個欄位的用法：

- **`usec_per_call`**：平均耗時。上面的 `hgetall` 平均 4 毫秒，是 `get` 的 2600 倍——這就是嫌疑犯。
- **`calls`**：呼叫量。找出「量大 × 單次慢」的組合。
- **`calls × usec_per_call`**：這個命令總共佔了多少 CPU 時間。上例中 `hgetall` 只被呼叫 12000 次，卻吃掉 48 秒的 CPU，比 500 萬次 `get` 的 7.5 秒多得多。

```bash
# 找出總耗時最高的命令
redis-cli -a coursepass INFO commandstats | \
  sed 's/cmdstat_//' | \
  awk -F'[:,=]' '{printf "%-20s calls=%-10s total_ms=%.0f\n", $1, $3, $5/1000}' | \
  sort -k3 -t= -rn | head -10
```

重設統計（做壓測或觀察某段時間時很有用）：

```bash
redis-cli -a coursepass CONFIG RESETSTAT
```

### `# Latencystats`（7.0+）

```bash
redis-cli -a coursepass INFO latencystats
```

```text
latency_percentiles_usec_get:p50=1.003,p99=3.007,p99.9=15.039
latency_percentiles_usec_hgetall:p50=800.1,p99=12000.5,p99.9=45000.2
```

**這比 `usec_per_call` 的平均值有用得多。** 平均 1.5 毫秒可能是「99% 在 0.1 毫秒、1% 在 150 毫秒」，而 p99 會直接告訴你這件事。

### `# Keyspace`

```text
db0:keys=1500000,expires=1200000,avg_ttl=1800000
```

`keys` 和 `expires` 的差就是**沒有 TTL 的 key 數量**。上例是 30 萬個永久 key——如果你以為所有東西都有 TTL，這個數字會讓你發現問題（第 01、05 章）。

---

## 12.4 必須告警的指標

把上面的欄位收斂成一張可以直接抄的告警表：

| 等級 | 指標 | 條件 | 代表什麼 |
|------|------|------|---------|
| **P0** | `PING` 無回應 | 連續 3 次失敗 | 服務中斷 |
| **P0** | `master_link_status` | `down` 持續 > 30s | 複製斷開，從節點資料變舊 |
| **P0** | `aof_last_write_status` | `err` | 磁碟寫入失敗，寫入即將被拒絕 |
| **P0** | `rdb_last_bgsave_status` | `err` | 同上 |
| **P0** | Sentinel `+switch-master` | 任何事件 | 發生了故障轉移，要人工確認 |
| **P1** | `used_memory / maxmemory` | > 80% | 快滿了，即將開始驅逐 |
| **P1** | `evicted_keys` 增量 | > 0 持續 5 分鐘 | 記憶體不足，key 正被踢掉 |
| **P1** | `rejected_connections` 增量 | > 0 | 連線數打滿 |
| **P1** | `mem_fragmentation_ratio` | < 1.0 | **記憶體被 swap** |
| **P1** | 複製 offset 差 | > 50MB 或 > 10 秒 | 複製延遲過大，RPO 惡化 |
| **P1** | `connected_clients` | > `maxclients` × 0.8 | 連線數接近上限 |
| **P2** | `latest_fork_usec` | > 500000（0.5s） | fork 阻塞明顯 |
| **P2** | `instantaneous_ops_per_sec` | 突增/突降 50% | 流量異常 |
| **P2** | 命中率（區間） | < 平常值 - 10% | 快取效率下降 |
| **P2** | `sync_full` 增量 | > 0 | backlog 太小或網路不穩 |
| **P2** | `slowlog` 新增條目 | > 10/分鐘 | 有慢命令 |

**閾值怎麼推**：不要直接抄。正確做法是先觀察一到兩週的正常波動，取「正常峰值 + 合理餘裕」。例如你的 `connected_clients` 平常尖峰是 800，那 1500 是合理的告警線，而不是照抄 `maxclients × 0.8`。

---

## 12.5 `SLOWLOG`：找出慢命令

```bash
# 超過多少微秒算慢（預設 10000 = 10 毫秒）
CONFIG SET slowlog-log-slower-than 10000

# 最多保留幾筆（預設 128）
CONFIG SET slowlog-max-len 256

# 查看最近 10 筆
SLOWLOG GET 10

# 目前有幾筆
SLOWLOG LEN

# 清空
SLOWLOG RESET
```

輸出格式：

```text
1) 1) (integer) 42                        # 序號
   2) (integer) 1755100000                # 時間戳
   3) (integer) 125000                    # 耗時（微秒）= 125 毫秒
   4) 1) "HGETALL"                        # 命令與參數
      2) "user:big:hash"
   5) "172.30.0.5:52134"                  # 客戶端位址
   6) "worker-3"                          # 客戶端名稱（CLIENT SETNAME）
```

**第 6 個欄位是被嚴重低估的功能。** 如果每個服務啟動時都設定客戶端名稱：

```javascript
await redis.client('SETNAME', `order-service-${process.env.POD_NAME}`);
```

那麼慢查詢日誌會直接告訴你**是哪個服務、哪個 pod** 發出的慢命令。沒有這個資訊時，你只能從 IP 反查，在 K8s 環境下這非常痛苦。

### `SLOWLOG` 的兩個盲點

**盲點 1：它只記錄「命令執行時間」，不含網路傳輸與排隊時間。**

```text
客戶端感受到的延遲 = 網路往返 + 排隊等待 + 命令執行 + 回傳資料
                                              ↑
                                    SLOWLOG 只記這一段
```

所以會出現「客戶端說很慢，但 SLOWLOG 是空的」——這時問題在排隊（前面有個慢命令堵住）或網路。要用 `LATENCY` 工具（下一節）。

**盲點 2：它是環狀緩衝區，只保留最近 N 筆。**

尖峰時可能一分鐘就被沖掉。要保留歷史必須定期採集：

```bash
# 每分鐘採集一次並輸出成 log
* * * * * redis-cli -a coursepass SLOWLOG GET 128 >> /var/log/redis-slowlog.log && redis-cli -a coursepass SLOWLOG RESET
```

---

## 12.6 延遲診斷

當「客戶端說慢，但 SLOWLOG 沒東西」時，用這一組工具。

### `--latency`：量測端到端延遲

```bash
# 持續量測（發 PING 並記錄往返時間）
redis-cli -a coursepass --latency
# min: 0, max: 3, avg: 0.18 (1385 samples)

# 每秒輸出一行，適合長時間觀察
redis-cli -a coursepass --latency-history -i 1

# 顯示延遲分布的直方圖（最有用）
redis-cli -a coursepass --latency-dist
```

**注意這量的是「包含網路的端到端延遲」**，所以要在**應用伺服器上**跑才有意義。在 Redis 本機跑只能排除網路因素。

### `--intrinsic-latency`：量測系統本身的延遲下限

```bash
# 在 Redis 所在的機器上執行，測 100 秒
redis-cli --intrinsic-latency 100
# Max latency so far: 1 microseconds.
# ...
# Max latency so far: 245 microseconds.
```

這個命令**不連 Redis**，它只是在本機跑一個緊密迴圈量測作業系統的排程抖動。

它回答的問題是：**「這台機器本身能提供多低的延遲？」** 如果 intrinsic latency 就有 5 毫秒，那你不可能期待 Redis 的延遲低於 5 毫秒——問題在機器（虛擬化、CPU 超賣、其他行程干擾），不在 Redis。

這是排除「到底是 Redis 慢還是機器慢」的關鍵工具。

### `LATENCY MONITOR`：找出延遲尖峰的來源

```bash
# 啟用：記錄超過 100 毫秒的事件
CONFIG SET latency-monitor-threshold 100

# 查看有哪些事件超標
LATENCY LATEST
```

```text
1) 1) "command"              # 事件類型
   2) (integer) 1755100000   # 最近一次發生時間
   3) (integer) 850          # 最近一次的延遲（毫秒）
   4) (integer) 1200         # 歷史最大值
2) 1) "fork"
   2) (integer) 1755099000
   3) (integer) 320
   4) (integer) 450
```

事件類型直接告訴你原因：

| 事件 | 含義 | 對策 |
|------|------|------|
| `command` | 某個命令執行太久 | 查 SLOWLOG，找 O(N) 命令與 big key |
| `fork` | fork 子行程耗時 | 第 06 章：減少資料量、關閉 THP、換機型 |
| `rdb-unlink-temp-file` | 刪除臨時 RDB 檔案 | 磁碟慢 |
| `aof-write` / `aof-fsync-always` | AOF 寫入阻塞 | 磁碟慢或 `appendfsync always` |
| `expire-cycle` | 過期 key 清理週期 | 大量 key 同時過期（第 01 章） |
| `eviction-cycle` / `eviction-del` | 驅逐 | 記憶體不足 |

```bash
# 查看某個事件的完整歷史
LATENCY HISTORY command

# 文字版診斷建議（真的很有用）
LATENCY DOCTOR
```

`LATENCY DOCTOR` 會輸出一段人類可讀的分析：

```text
Dave, I have observed latency spikes in this Redis instance. You don't mind talking
about it, do you Dave?

1. command: 12 latency spikes (average 320ms, mean deviation 45ms, period 15.30 sec).
   Worst all time event 1200ms.

I have a few advices for you:
- Check your Slow Log to understand what are the commands you are running which are too slow...
```

（那個 Dave 的梗來自《2001太空漫遊》，這是 antirez 的幽默。）

### 延遲診斷的順序

```text
1. 客戶端量到的延遲高嗎？（在應用伺服器跑 redis-cli --latency）
     否 -> 問題在應用端（連線池、序列化、GC），不在 Redis

2. 在 Redis 機器上跑 --intrinsic-latency
     高（> 1ms）-> 機器問題：虛擬化、CPU 超賣、鄰居干擾、THP
     低          -> 繼續

3. LATENCY LATEST 有哪些事件？
     fork/aof   -> 持久化問題（第 06 章）
     expire     -> TTL 集中
     eviction   -> 記憶體不足
     command    -> 繼續第 4 步

4. SLOWLOG GET 找出慢命令
     -> 通常是 O(N) 命令 + big key（第 04 章）

5. 都沒有？看 INFO clients 的 blocked_clients 和網路頻寬
     -> 可能是輸出頻寬打滿，或大量 big key 的傳輸時間
```

---

## 12.7 記憶體診斷

### `MEMORY DOCTOR`

```bash
redis-cli -a coursepass MEMORY DOCTOR
```

```text
Sam, I detected a few issues in this Redis instance memory implants:

 * High allocator fragmentation: This instance has an allocator external
   fragmentation greater than 1.1. This problem is usually due to a large peak
   memory...

I'm here just for mental support, so please seek professional help.
```

它會檢查碎片率、峰值比例、客戶端緩衝區等常見問題。

### `MEMORY STATS`：記憶體到底花在哪

```bash
redis-cli -a coursepass MEMORY STATS
```

關鍵欄位：

```text
peak.allocated            歷史峰值
total.allocated           目前總量
startup.allocated         啟動時的基礎佔用
replication.backlog       複製 backlog 佔用
clients.slaves            從節點連線的緩衝區 ★
clients.normal            一般客戶端的緩衝區 ★
aof.buffer                AOF 緩衝區
overhead.total            所有非資料的開銷
dataset.bytes             實際資料佔用
dataset.percentage        資料佔總量的比例
keys.count                key 數量
keys.bytes-per-key        平均每個 key 佔多少
```

**`clients.normal` 異常大是很常見的問題。** 它代表某些客戶端的輸出緩衝區堆積了大量待傳送的資料——通常是有人在跑 `MONITOR`、訂閱了高頻 Pub/Sub、或執行了回傳大量資料的命令（第 05 章）。

### `--bigkeys` 與 `--memkeys`

```bash
# 找出每種型別中最大的 key（用 SCAN，安全）
redis-cli -a coursepass --bigkeys
```

```text
[00.00%] Biggest string found so far '"session:abc"' with 1024 bytes
[35.20%] Biggest hash   found so far '"user:profile:1001"' with 500000 fields
...
-------- summary -------
Sampled 1500000 keys in the keyspace!
Total key length in bytes is 45000000 (avg len 30.00)

Biggest   hash found '"user:profile:1001"' has 500000 fields
Biggest string found '"cache:report:2026"' has 5242880 bytes
```

**`--bigkeys` 找的是「元素最多」的 key，不是「佔記憶體最多」的 key。** 一個有 100 萬個 1 byte 元素的 Set，和一個有 10 個 1MB 元素的 List，前者會被報出來，但後者才是記憶體大戶。

要按實際記憶體排序用 `--memkeys`（6.0+）：

```bash
redis-cli -a coursepass --memkeys
```

它對每個 key 呼叫 `MEMORY USAGE`，比 `--bigkeys` 準確但更慢。

單獨查一個 key：

```bash
redis-cli -a coursepass MEMORY USAGE user:profile:1001
# (integer) 45678901

# SAMPLES 0 表示精確計算（大 key 會慢）
redis-cli -a coursepass MEMORY USAGE user:profile:1001 SAMPLES 0
```

**兩個工具都會產生持續負載**，在超大實例上跑要注意。理想做法是在**從節點**上跑，完全不影響主節點。

---

## 12.8 連線與客戶端

### `CLIENT LIST`

```bash
redis-cli -a coursepass CLIENT LIST
```

```text
id=1234 addr=172.30.0.5:52134 laddr=... fd=8 name=order-service-pod-3
age=3600 idle=0 flags=N db=0 sub=0 psub=0 multi=-1
qbuf=26 qbuf-free=32742 argv-mem=10
obl=0 oll=0 omem=0 tot-mem=61466
events=r cmd=get user=default redir=-1 resp=2
```

排錯時最有用的欄位：

| 欄位 | 含義 | 異常時代表 |
|------|------|-----------|
| `name` | 客戶端名稱 | 空的話你會很痛苦，一定要設 |
| `age` | 連線存活秒數 | 全部都很小 = 連線在頻繁重建（沒用連線池） |
| `idle` | 閒置秒數 | 很大 = 殭屍連線，佔用配額 |
| `omem` | 輸出緩衝區佔用 | **大 = 這個客戶端讀不夠快，或在跑 MONITOR** |
| `oll` | 輸出列表長度 | 同上 |
| `cmd` | 最後執行的命令 | 找出誰在跑 `KEYS`、`MONITOR` |
| `sub`/`psub` | 訂閱數 | 判斷是不是 Pub/Sub 連線 |
| `multi` | 交易中的命令數 | -1 = 沒在交易中 |

實用的排查命令：

```bash
# 找出佔用輸出緩衝區最多的客戶端
redis-cli -a coursepass CLIENT LIST | \
  awk '{for(i=1;i<=NF;i++) if($i ~ /^omem=/) {split($i,a,"="); if(a[2]>0) print $0}}'

# 統計各服務的連線數
redis-cli -a coursepass CLIENT LIST | \
  grep -o 'name=[^ ]*' | sort | uniq -c | sort -rn

# 找出閒置超過一小時的連線
redis-cli -a coursepass CLIENT LIST | \
  awk '{for(i=1;i<=NF;i++) if($i ~ /^idle=/) {split($i,a,"="); if(a[2]>3600) print $0}}'

# 找出正在跑危險命令的客戶端
redis-cli -a coursepass CLIENT LIST | grep -E 'cmd=(keys|monitor|flushall|flushdb)'
```

### 踢掉有問題的客戶端

```bash
# 依 ID 踢
CLIENT KILL ID 1234

# 依位址踢
CLIENT KILL ADDR 172.30.0.5:52134

# 踢掉所有跑 MONITOR 的（救急很有用）
CLIENT KILL TYPE pubsub
CLIENT NO-EVICT on          # 7.0+：保護客戶端不因記憶體壓力被踢
```

### 輸出緩衝區限制

```bash
CONFIG GET client-output-buffer-limit
```

```text
1) "client-output-buffer-limit"
2) "normal 0 0 0 slave 268435456 67108864 60 pubsub 33554432 8388608 60"
```

格式是 `<類別> <硬限制> <軟限制> <軟限制持續秒數>`：

- `normal 0 0 0`：一般客戶端**沒有限制**（預設）。這代表一個讀取很慢的客戶端可以無限堆積輸出緩衝區，直到吃光記憶體。
- `slave 256mb 64mb 60`：從節點超過 256MB 直接斷開，或超過 64MB 持續 60 秒斷開。
- `pubsub 32mb 8mb 60`：訂閱者的限制。

**`normal` 設 0 是為了不影響正常業務（例如一次 `LRANGE` 取回很大的結果），但它也是記憶體暴漲的一個常見原因。** 有需要時可以設一個保護值：

```bash
CONFIG SET client-output-buffer-limit "normal 256mb 128mb 60 slave 512mb 128mb 60 pubsub 32mb 8mb 60"
```

---

## 12.9 `redis-benchmark`：怎麼測才有意義

```bash
# 最基本
redis-benchmark -a coursepass -q

# 指定測試的命令、請求數、併發數、value 大小
redis-benchmark -a coursepass -t set,get -n 100000 -c 50 -d 100 -q

# 加上 pipeline（第 07 章）
redis-benchmark -a coursepass -t set -n 1000000 -P 16 -q

# 測自訂命令
redis-benchmark -a coursepass -n 10000 ZADD myzset __rand_int__ ele:__rand_int__

# 用隨機 key（避免所有請求打同一個 key，那不真實）
redis-benchmark -a coursepass -t set -n 100000 -r 100000 -q
```

常用參數：

| 參數 | 意義 | 建議 |
|------|------|------|
| `-n` | 總請求數 | 至少 10 萬，否則統計不穩 |
| `-c` | 併發連線數 | 對應你的實際連線池大小 |
| `-d` | value 大小（bytes） | 用你的真實平均值，預設 3 bytes 沒有意義 |
| `-P` | pipeline 深度 | 只在你的應用真的用 pipeline 時加 |
| `-r` | key 空間大小 | **一定要設**，否則所有請求打同一個 key |
| `-t` | 測哪些命令 | 只測你真正在用的 |
| `--threads` | 客戶端執行緒數 | 高 QPS 測試時，避免客戶端成為瓶頸 |

**三個常見的錯誤用法：**

**錯誤 1：不加 `-r`。** 預設所有 `SET` 都寫同一個 key，這會有極高的 CPU cache 命中率，測出來的數字遠高於真實情況。

**錯誤 2：用預設的 `-d 3`。** 3 bytes 的 value 完全不反映真實的網路與序列化成本。用你的實際平均 value 大小。

**錯誤 3：在 Redis 本機跑。** 這樣測不到網路延遲，而網路往往是真實環境的主要成本。應該在應用伺服器上跑。

**還有一個更根本的提醒：`redis-benchmark` 測的是「Redis 能跑多快」，不是「你的應用能跑多快」。** 真實瓶頸常常在客戶端的連線池、序列化、或應用邏輯。壓測前先確認你要回答的是哪個問題。

---

## 12.10 劇本 1：延遲突然飆高

**症狀**：應用的 P99 延遲從 5 毫秒跳到 500 毫秒，錯誤率上升。

```bash
#!/bin/sh
# 延遲排查腳本（在 Redis 機器上跑）
R="redis-cli -a coursepass --no-auth-warning"

echo "=== 1. 目前的即時狀態 ==="
$R INFO stats | grep -E 'instantaneous_ops_per_sec|rejected_connections'
$R INFO clients | grep -E 'connected_clients|blocked_clients'

echo "=== 2. 延遲事件 ==="
$R CONFIG SET latency-monitor-threshold 100
$R LATENCY LATEST
$R LATENCY DOCTOR

echo "=== 3. 慢命令 ==="
$R SLOWLOG GET 10

echo "=== 4. 最耗 CPU 的命令 ==="
$R INFO commandstats | sed 's/cmdstat_//' | \
  awk -F'[:,=]' '{printf "%s %s %.0f\n", $1, $3, $5/1000}' | \
  sort -k3 -rn | head -5

echo "=== 5. 記憶體與 swap ==="
$R INFO memory | grep -E 'used_memory_human|maxmemory_human|mem_fragmentation_ratio'

echo "=== 6. 持久化 ==="
$R INFO persistence | grep -E 'rdb_bgsave_in_progress|aof_rewrite_in_progress|latest_fork'
$R INFO stats | grep latest_fork_usec

echo "=== 7. 大 key（在從節點上跑更好）==="
$R --bigkeys 2>/dev/null | tail -20
```

**判讀順序與對應處理：**

```text
LATENCY LATEST 顯示 fork？
  -> 正在做 BGSAVE 或 AOF 重寫（第 06 章）
  -> 短期：錯開時間、關掉不必要的 RDB save 規則
  -> 長期：降低資料量、確認關閉 THP、換 fork 快的機型

LATENCY LATEST 顯示 expire-cycle？
  -> 大量 key 同時過期（第 01 章）
  -> TTL 加抖動（第 09 章）

LATENCY LATEST 顯示 eviction？
  -> 記憶體不足，正在大量驅逐
  -> 跳到劇本 2

SLOWLOG 有 O(N) 命令（KEYS/HGETALL/SMEMBERS/LRANGE 0 -1）？
  -> 找到兇手了。用 SLOWLOG 的 client name 定位是哪個服務
  -> 改用 SCAN / HSCAN / 分批取

commandstats 顯示某命令 calls 突增？
  -> 有服務改版或出現迴圈呼叫，去查那個服務

mem_fragmentation_ratio < 1？
  -> 記憶體被 swap，這是最嚴重的情況
  -> 立刻降低記憶體用量或加機器；長期要設 vm.swappiness=0

以上都正常，但 --intrinsic-latency 很高？
  -> 機器問題（CPU 超賣、鄰居吵鬧、虛擬化）
  -> 換機器或申請專屬資源

以上全部正常？
  -> 檢查網路頻寬（大 value × 高 QPS 可能打滿網卡）
  -> 檢查應用端的連線池是否耗盡
```

---

## 12.11 劇本 2：記憶體暴漲

**症狀**：記憶體用量從 8GB 漲到 15GB，接近 `maxmemory`，開始出現驅逐。

```bash
#!/bin/sh
R="redis-cli -a coursepass --no-auth-warning"

echo "=== 1. 記憶體組成 ==="
$R MEMORY STATS | paste - - | grep -E 'dataset.bytes|overhead.total|clients.normal|clients.slaves|replication.backlog|aof.buffer|peak.allocated'

echo "=== 2. key 數量與 TTL 覆蓋率 ==="
$R INFO keyspace

echo "=== 3. 驅逐與過期 ==="
$R INFO stats | grep -E 'evicted_keys|expired_keys'

echo "=== 4. 大 key ==="
$R --bigkeys | tail -20
$R --memkeys 2>/dev/null | tail -20

echo "=== 5. 客戶端緩衝區 ==="
$R CLIENT LIST | awk '{for(i=1;i<=NF;i++) if($i ~ /^omem=/) {split($i,a,"="); if(a[2]>1048576) print}}'

echo "=== 6. 診斷建議 ==="
$R MEMORY DOCTOR
```

**判讀順序：**

```text
1. dataset.bytes 佔比高（> 80%）？
   -> 是真的資料變多。問：
      keys 數量變多？   -> 誰在寫？TTL 設了嗎？（INFO keyspace 的 expires）
      keys 沒變多？     -> 有 big key 在長大，用 --memkeys 找出來

2. clients.normal 很大？
   -> 有客戶端讀不夠快，輸出緩衝區堆積
   -> CLIENT LIST 找 omem 大的，看它的 cmd 是什麼
   -> 常見兇手：MONITOR 忘了關、高頻 Pub/Sub 訂閱者、一次 LRANGE 取太多

3. replication.backlog 很大？
   -> repl-backlog-size 設太大（第 11 章），這是設定問題不是異常

4. overhead.total 佔比高（資料少但總量大）？
   -> key 太多太小，每個 key 有固定開銷（約 50～100 bytes）
   -> 考慮把多個小 key 合併成 Hash（第 05 章）

5. expires 遠小於 keys？
   -> 大量 key 沒有 TTL，會永久累積
   -> 這是最常見的記憶體暴漲原因

6. mem_fragmentation_ratio > 1.5？
   -> 碎片問題，不是真的資料多
   -> CONFIG SET activedefrag yes（第 05 章）
```

**緊急處理（記憶體即將滿）：**

```bash
# 1. 確認驅逐策略正確（noeviction 會讓寫入直接報錯）
redis-cli -a coursepass CONFIG GET maxmemory-policy

# 2. 找出並刪除最大的幾個 key（用 UNLINK，非阻塞）
redis-cli -a coursepass UNLINK huge:key:name

# 3. 對沒有 TTL 的 key 批次補上 TTL（用 SCAN，不要用 KEYS）
redis-cli -a coursepass --scan --pattern 'temp:*' | \
  while read k; do
    redis-cli -a coursepass --no-auth-warning TTL "$k" | grep -q '^-1$' && \
      redis-cli -a coursepass --no-auth-warning EXPIRE "$k" 3600
  done

# 4. 臨時調高 maxmemory 爭取時間（如果機器還有記憶體）
redis-cli -a coursepass CONFIG SET maxmemory 20gb
```

---

## 12.12 劇本 3：連線數打滿

**症狀**：應用出現 `ERR max number of clients reached` 或連線逾時。

```bash
R="redis-cli -a coursepass --no-auth-warning"

echo "=== 1. 目前連線數 vs 上限 ==="
$R INFO clients | grep connected_clients
$R CONFIG GET maxclients
$R INFO stats | grep rejected_connections

echo "=== 2. 連線來自哪裡 ==="
$R CLIENT LIST | grep -o 'addr=[0-9.]*' | cut -d= -f2 | \
  sort | uniq -c | sort -rn | head -10

echo "=== 3. 各服務的連線數（需要有設 CLIENT SETNAME）==="
$R CLIENT LIST | grep -o 'name=[^ ]*' | sort | uniq -c | sort -rn

echo "=== 4. 連線年齡分布（判斷是否在頻繁重建）==="
$R CLIENT LIST | grep -o 'age=[0-9]*' | cut -d= -f2 | \
  awk '{if($1<10) a++; else if($1<300) b++; else c++} END {print "  <10s: "a"\n  <5m: "b"\n  >5m: "c}'

echo "=== 5. 閒置連線 ==="
$R CLIENT LIST | grep -o 'idle=[0-9]*' | cut -d= -f2 | \
  awk '{if($1>3600) n++} END {print "  idle>1h: "n+0}'
```

**判讀：**

```text
大量連線的 age 都很小（< 10 秒）？
  -> 應用沒有用連線池，或連線池設定錯誤（每次請求建新連線）
  -> 這是最常見的原因。檢查應用的 Redis 客戶端設定

大量連線的 idle 很大（> 1 小時）？
  -> 殭屍連線。可能是應用崩潰後 TCP 連線沒被清掉
  -> 短期：CLIENT KILL；長期：設定 timeout

某個 IP 佔了絕大多數連線？
  -> 那台機器的應用有問題，或它的實例數/連線池設太大

連線數合理但仍打滿？
  -> maxclients 設太小。注意它受作業系統的 fd 上限限制：
     Redis 會自動把 maxclients 調降到 (ulimit -n) - 32
```

**處理：**

```bash
# 設定閒置逾時（0 = 不逾時，預設值）
redis-cli -a coursepass CONFIG SET timeout 300

# 提高上限（要先確認系統 fd 夠）
ulimit -n                                  # 查看目前的 fd 上限
redis-cli -a coursepass CONFIG SET maxclients 20000

# 緊急：踢掉閒置連線
redis-cli -a coursepass CLIENT LIST | \
  awk '{for(i=1;i<=NF;i++){if($i ~ /^id=/) split($i,id,"="); if($i ~ /^idle=/) split($i,idle,"=")}} idle[2]>3600 {print id[2]}' | \
  while read cid; do redis-cli -a coursepass --no-auth-warning CLIENT KILL ID $cid; done
```

**根本解法是應用側的連線池設定**：

```javascript
// ioredis 的連線池設定（每個 Redis 實例一個連線，複用）
const redis = new Redis({
  host, port, password,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: true,
  connectTimeout: 5000,
  // ioredis 預設就是單連線複用，不需要連線池
  // 但要確保你不是每次請求都 new Redis()
});

// 常見錯誤：在請求處理函式裡建立連線
app.get('/api/x', async (req, res) => {
  const redis = new Redis(config);   // ❌ 每個請求一個連線
  // ...
});
```

---

## 12.13 劇本 4：資料莫名消失

**症狀**：某些 key 突然不見了，或命中率大幅下降。

```bash
R="redis-cli -a coursepass --no-auth-warning"

echo "=== 1. 是不是被驅逐了 ==="
$R INFO stats | grep evicted_keys
$R INFO memory | grep -E 'used_memory_human|maxmemory_human'
$R CONFIG GET maxmemory-policy

echo "=== 2. 是不是過期了 ==="
$R INFO stats | grep expired_keys
$R TTL 那個消失的key      # -2 = 不存在，-1 = 沒有 TTL

echo "=== 3. 是不是被人清掉了 ==="
$R INFO commandstats | grep -E 'flushall|flushdb|del|unlink'

echo "=== 4. 是不是發生過故障轉移 ==="
$R INFO replication | head -3
$R INFO server | grep uptime_in_seconds     # 剛重啟？

echo "=== 5. 資料量變化 ==="
$R INFO keyspace
```

**五種可能的原因與判別方式：**

| 原因 | 判別 | 處理 |
|------|------|------|
| **被驅逐** | `evicted_keys` > 0 | 擴容、縮短 TTL、換驅逐策略 |
| **正常過期** | `expired_keys` 有對應增量，`TTL` 回傳 -2 | 檢查 TTL 設定是否過短 |
| **被人清空** | `cmdstat_flushall/flushdb` 的 calls > 0 | 查是誰（用 `CLIENT LIST` 抓不到歷史，要靠 ACL 日誌或應用日誌）|
| **實例重啟** | `uptime_in_seconds` 很小 | 查是否有持久化，沒有的話重啟即全失 |
| **故障轉移** | `INFO replication` 的 role 或 master 變了 | 第 11 章：切換會丟未複製的資料 |

**驅逐是最常見也最隱蔽的原因。** 特別注意驅逐策略的陷阱（第 05 章）：

```bash
# volatile-lru 只驅逐「有 TTL」的 key
# 如果你的資料大多沒有 TTL，記憶體滿時會無 key 可驅逐，行為等同 noeviction
redis-cli -a coursepass CONFIG GET maxmemory-policy
redis-cli -a coursepass INFO keyspace
# db0:keys=1000000,expires=50000    <- 只有 5% 有 TTL，volatile-lru 幾乎無效
```

**預防 `FLUSHALL` 事故**（第 13 章會完整處理）：

```bash
# 用 ACL 禁止危險命令
ACL SETUSER app_user on >password ~* +@all -@dangerous -flushall -flushdb -keys

# 或重新命名（舊做法，但仍有效）
rename-command FLUSHALL ""
rename-command FLUSHDB ""
rename-command KEYS ""
```

---

## 12.14 建立監控體系

### 最小可用配置

```yaml
# docker-compose 加入 exporter
  redis-exporter:
    image: oliver006/redis_exporter:latest
    container_name: redis-exporter
    environment:
      REDIS_ADDR: "redis://redis-master:6379"
      REDIS_PASSWORD: "coursepass"
      # 針對特定 key 做監控（非常有用）
      REDIS_EXPORTER_CHECK_KEYS: "queue:orders,cache:hot:*"
    ports:
      - "9121:9121"
```

```bash
curl -s localhost:9121/metrics | grep -E 'redis_memory_used_bytes|redis_evicted_keys'
```

### 必備的告警規則（Prometheus 格式）

```yaml
groups:
- name: redis
  rules:
  - alert: RedisDown
    expr: redis_up == 0
    for: 1m
    labels: { severity: critical }

  - alert: RedisMemoryHigh
    expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.8
    for: 5m
    labels: { severity: warning }

  - alert: RedisEvictingKeys
    expr: rate(redis_evicted_keys_total[5m]) > 0
    for: 5m
    labels: { severity: warning }
    annotations:
      summary: "記憶體不足，key 正在被驅逐"

  - alert: RedisReplicationBroken
    expr: redis_connected_slaves < 1
    for: 1m
    labels: { severity: critical }

  - alert: RedisReplicationLagHigh
    expr: redis_master_repl_offset - on(instance) redis_slave_repl_offset > 50000000
    for: 2m
    labels: { severity: warning }

  - alert: RedisRejectedConnections
    expr: rate(redis_rejected_connections_total[5m]) > 0
    for: 1m
    labels: { severity: warning }

  - alert: RedisSlowFork
    expr: redis_latest_fork_usec > 500000
    for: 1m
    labels: { severity: warning }

  - alert: RedisMemorySwapping
    expr: redis_memory_used_rss_bytes / redis_memory_used_bytes < 1
    for: 5m
    labels: { severity: critical }
    annotations:
      summary: "記憶體可能被 swap 到磁碟，延遲會嚴重惡化"
```

### 儀表板該放什麼

```text
第一排（可用性，一眼看完）
  ├─ 上線狀態 / uptime
  ├─ 主從角色與連線狀態
  └─ QPS

第二排（資源）
  ├─ 記憶體用量 vs maxmemory（含 peak 線）
  ├─ 連線數 vs maxclients
  ├─ 網路進出流量
  └─ CPU（分主執行緒與子行程）

第三排（效能與正確性）
  ├─ 命中率（區間值，不是累計）
  ├─ 各命令的 p99 延遲（來自 latencystats）
  ├─ evicted_keys / expired_keys 速率
  └─ 慢命令數量

第四排（持久化與複製）
  ├─ latest_fork_usec
  ├─ rdb_changes_since_last_save
  └─ 複製 offset 差
```

### 應用層要埋的指標

Redis 自身的指標看不到「你的業務怎麼用它」。至少要埋這三個（第 09 章提過）：

```javascript
// 1. 分業務的命中率
metrics.increment('cache.hit', { biz: 'product' });
metrics.increment('cache.miss', { biz: 'product' });

// 2. 客戶端量到的延遲（含網路，這才是使用者感受到的）
const start = process.hrtime.bigint();
await redis.get(key);
metrics.histogram('redis.latency_us',
  Number(process.hrtime.bigint() - start) / 1000, { cmd: 'get' });

// 3. Redis 錯誤與降級次數
metrics.increment('redis.error', { type: err.name });
metrics.increment('redis.degraded');
```

第 3 個特別重要——如果你有做第 09 章的降級（Redis 出錯就當未命中），那**Redis 故障時應用不會報錯，你的告警也不會響**。只有這個計數器會告訴你「快取已經失效了兩小時，全部流量都在打資料庫」。

---

## 12.15 常見錯誤

### 錯誤 1：只監控記憶體

記憶體正常但延遲飆高、連線打滿、複製斷開的情況都存在。三個層次都要有。

### 錯誤 2：用累計值做告警

`keyspace_hits`、`evicted_keys` 都是啟動至今的累計值。要用區間增量（`rate()`），否則永遠看不出「昨天開始惡化」。

### 錯誤 3：不設 `CLIENT SETNAME`

慢查詢日誌和 `CLIENT LIST` 裡只有 IP，在容器環境下幾乎無法定位是哪個服務。設一行的成本，換排錯時省下的半小時。

### 錯誤 4：在生產環境長時間開 `MONITOR`

它會把每個命令都推給你的連線，高流量下有明顯效能影響，還會撐大輸出緩衝區。用 `SLOWLOG` 和 `commandstats` 代替。

### 錯誤 5：在主節點跑 `--bigkeys` / `--memkeys`

雖然底層是 `SCAN`（安全），但在大實例上會產生持續負載。在從節點跑。

### 錯誤 6：`redis-benchmark` 不加 `-r`

所有請求打同一個 key，測出來的數字虛高，做容量規劃時會嚴重高估。

### 錯誤 7：在 Redis 本機量延遲然後說「Redis 很快」

使用者感受到的是含網路的端到端延遲。要在應用伺服器上量。

### 錯誤 8：看到延遲高就重啟

重啟會清空所有診斷資訊（`commandstats`、`slowlog`、`latency`），讓你永遠查不出原因；如果沒有持久化，還會丟掉全部資料。**先採集，再處理。**

### 錯誤 9：忽略 `mem_fragmentation_ratio < 1`

這代表記憶體被 swap，是最嚴重的效能問題之一，但因為「碎片率低」聽起來像好事而常被忽略。

### 錯誤 10：告警閾值直接抄網路上的值

正確做法是先觀察一到兩週的正常波動再定。抄來的閾值不是一直誤報，就是永遠不報。

### 錯誤 11：沒有監控「應用層的降級次數」

有降級機制卻沒有監控它，等於 Redis 掛掉時完全無感——直到資料庫也被打垮。

### 錯誤 12：把 `--bigkeys` 的結果當成記憶體排行

它找的是「元素最多」，不是「佔記憶體最多」。要用 `--memkeys` 或 `MEMORY USAGE`。

---

## 12.16 本章練習

### 練習 1：製造問題並用工具找出來

自己製造四種故障，然後只用監控工具（不看自己寫了什麼）把原因找出來。

<details>
<summary>參考解答</summary>

**準備環境**

```bash
docker run --name redis-debug -p 6399:6379 -d redis:7.2 \
  redis-server --requirepass coursepass --maxmemory 100mb \
  --maxmemory-policy allkeys-lru --appendonly no

alias R='docker exec redis-debug redis-cli -a coursepass --no-auth-warning'
```

**故障 1：big key 造成延遲**

製造：

```bash
R EVAL "for i=1,300000 do redis.call('HSET', KEYS[1], 'f'..i, string.rep('x', 100)) end return 1" 1 big:hash
```

診斷：

```bash
# 開啟延遲監控與慢查詢
R CONFIG SET latency-monitor-threshold 50
R CONFIG SET slowlog-log-slower-than 5000

# 觸發問題
R HGETALL big:hash > /dev/null

# 診斷
R SLOWLOG GET 3
R LATENCY LATEST
R --bigkeys | tail -10
R MEMORY USAGE big:hash
```

你會看到：

```text
SLOWLOG: HGETALL big:hash 耗時數十萬微秒
LATENCY LATEST: 1) "command" ... 
--bigkeys: Biggest hash found 'big:hash' has 300000 fields
```

**三個工具指向同一個結論。** 這是正常的——它們從不同角度看同一件事，互相印證才敢下結論。

**故障 2：記憶體滿了觸發驅逐**

```bash
R CONFIG RESETSTAT
R EVAL "for i=1,200000 do redis.call('SET', 'pad:'..i, string.rep('y', 500)) end return redis.call('DBSIZE')" 0
```

診斷：

```bash
R INFO stats | grep evicted_keys
# evicted_keys:xxxxx      <- 不為零，有 key 被踢掉

R INFO memory | grep -E 'used_memory_human|maxmemory_human'
R INFO keyspace
# db0:keys=xxxxx          <- 遠小於你寫入的 200000

R MEMORY DOCTOR
```

**關鍵觀察：你寫進去 20 萬個 key，但 `DBSIZE` 遠小於 20 萬。** 在真實環境裡，這正是「明明寫進去了，讀的時候卻沒有」這類詭異 bug 的來源。

順便驗證第 05 章的陷阱：

```bash
# 換成 volatile-lru（只驅逐有 TTL 的 key）
R CONFIG SET maxmemory-policy volatile-lru
R SET nottl:1 "value"
# 繼續寫入直到滿
R EVAL "for i=1,50000 do redis.call('SET', 'pad2:'..i, string.rep('z', 500)) end return 1" 0
# (error) OOM command not allowed when used memory > 'maxmemory'.
```

**因為沒有 key 有 TTL，volatile-lru 無 key 可驅逐，行為等同 noeviction，寫入直接報錯。**

**故障 3：輸出緩衝區暴漲**

```bash
R CONFIG SET maxmemory 500mb
R CONFIG SET maxmemory-policy noeviction

# 開一個 MONITOR 但不讀取（模擬慢客戶端）
docker exec -d redis-debug sh -c 'redis-cli -a coursepass --no-auth-warning MONITOR > /dev/null'

# 製造大量命令
docker exec -d redis-debug redis-benchmark -a coursepass -t set -n 500000 -q
sleep 5
```

診斷：

```bash
R MEMORY STATS | paste - - | grep clients
R CLIENT LIST | grep -E 'cmd=monitor|omem=[1-9]'
```

你會看到某個客戶端的 `omem` 明顯偏大，且 `cmd=monitor`。

處理：

```bash
R CLIENT LIST | grep 'cmd=monitor' | grep -o 'id=[0-9]*' | cut -d= -f2 | \
  while read id; do R CLIENT KILL ID $id; done
```

**故障 4：連線洩漏**

```bash
# 模擬沒有用連線池：不斷建立新連線且不關閉
docker exec -d redis-debug sh -c '
for i in $(seq 1 200); do
  (redis-cli -a coursepass --no-auth-warning BLPOP nonexist 0 &) 
done'
sleep 3
```

診斷：

```bash
R INFO clients | grep -E 'connected_clients|blocked_clients'
R CLIENT LIST | grep -o 'age=[0-9]*' | cut -d= -f2 | \
  awk '{if($1<30) n++} END {print "新連線（<30秒）: "n+0}'
R CLIENT LIST | grep -c 'cmd=blpop'
```

`blocked_clients` 幾乎等於 `connected_clients`，且全部卡在 `BLPOP`——這是消費者全部阻塞、或連線洩漏的典型特徵。

**清理**

```bash
docker rm -f redis-debug
```

**這個練習的重點**：每種故障都有**多個工具能看到**，而它們的組合才能確定原因。單看一個指標常常會誤判——例如「記憶體高」可能是資料多、可能是碎片、可能是客戶端緩衝區，三者的處理方式完全不同。

</details>

### 練習 2：判讀一組真實的線上指標

某天收到告警，你採集到以下資訊。請判斷發生了什麼、下一步該查什麼、以及該怎麼處理。

```text
# INFO memory
used_memory_human:14.85G
used_memory_rss_human:15.20G
used_memory_peak_human:14.90G
maxmemory_human:16.00G
maxmemory_policy:volatile-lru
mem_fragmentation_ratio:1.02

# INFO stats
instantaneous_ops_per_sec:45000
evicted_keys:0
expired_keys:8234567
keyspace_hits:445123098
keyspace_misses:198456712
rejected_connections:0
latest_fork_usec:1250000

# INFO keyspace
db0:keys=28500000,expires=1200000,avg_ttl=0

# INFO clients
connected_clients:1250
blocked_clients:0

# SLOWLOG GET 5 —— 空的

# LATENCY LATEST
1) 1) "fork"
   2) (integer) 1755100000
   3) (integer) 1250
   4) (integer) 1380
```

<details>
<summary>參考解答</summary>

**先讀出四個異常訊號：**

**訊號 1：命中率只有 69%**

```text
445123098 / (445123098 + 198456712) = 69.2%
```

對一個快取實例來說偏低。但要注意這是**累計值**，需要取區間差值確認是「一直都低」還是「最近變低」。

**訊號 2：只有 4.2% 的 key 有 TTL**

```text
expires 1200000 / keys 28500000 = 4.2%
```

**這是最嚴重的問題**，而且它和訊號 3 直接相關。

**訊號 3：`maxmemory-policy` 是 `volatile-lru`，但 `evicted_keys` 是 0**

這個組合非常危險。`volatile-lru` **只驅逐有 TTL 的 key**，而 96% 的 key 沒有 TTL。

目前記憶體 14.85G / 16G = 92.8%，還沒滿。但一旦滿了：

```text
可驅逐的候選 key 只有那 120 萬個（4.2%）
驅逐完之後 -> 無 key 可驅逐 -> 行為等同 noeviction
-> 所有寫入開始回 OOM 錯誤
```

**這個實例正走向一次全面的寫入失敗，而目前所有指標看起來都「還好」。**

`evicted_keys:0` 在這裡不是好消息，它只代表「還沒滿」。

**訊號 4：`latest_fork_usec` 是 1.25 秒**

`LATENCY LATEST` 也確認了 fork 事件（1250 毫秒）。這代表**每次 BGSAVE 或 AOF 重寫時，Redis 會卡住 1.25 秒**。以 45000 QPS 計算，那一瞬間有超過 5 萬個請求在排隊。

fork 耗時和資料量成正比，14.85G 的實例出現 1.25 秒是合理的——但「合理」不代表可以接受。

**其他指標是正常的**：碎片率 1.02 很健康、沒有 swap、連線數正常、沒有慢命令、沒有拒絕連線。

**下一步要查什麼**

```bash
# 1. 那 2700 萬個沒有 TTL 的 key 是什麼？（用 SCAN，不要用 KEYS）
redis-cli --scan --pattern '*' --count 1000 | head -1000 | \
  while read k; do
    ttl=$(redis-cli TTL "$k")
    [ "$ttl" = "-1" ] && echo "$k"
  done | awk -F: '{print $1}' | sort | uniq -c | sort -rn
# -> 找出是哪個前綴（哪個業務）沒設 TTL

# 2. 命中率是一直低還是最近變低？
#    取兩次採樣算區間值
redis-cli INFO stats | grep keyspace
sleep 60
redis-cli INFO stats | grep keyspace

# 3. 記憶體成長速度（決定還剩多少時間）
#    從監控系統看過去 7 天的 used_memory 曲線

# 4. 哪些命令的量最大
redis-cli INFO commandstats | sed 's/cmdstat_//' | \
  awk -F'[:,=]' '{printf "%s %s\n", $1, $3}' | sort -k2 -rn | head -10

# 5. 有沒有 big key
redis-cli --memkeys        # 在從節點上跑

# 6. 目前的持久化設定（fork 從哪來）
redis-cli CONFIG GET save
redis-cli CONFIG GET appendonly
redis-cli CONFIG GET auto-aof-rewrite-percentage
```

**處理建議，按優先順序**

**優先級 1（立刻，避免寫入失敗）：改驅逐策略**

```bash
redis-cli CONFIG SET maxmemory-policy allkeys-lru
```

`allkeys-lru` 會驅逐任何 key，不限於有 TTL 的。這讓實例在記憶體滿時能繼續運作，而不是開始拒絕寫入。

**但這個改動有前提**：必須確認**沒有任何不能被驅逐的資料**在這個實例裡。如果裡面混著分散式鎖、限流計數器、或某些「消失就會出錯」的狀態，`allkeys-lru` 會把它們也踢掉。

所以真正的第一步是**先查清楚那 2700 萬個 key 是什麼**（上面的第 1 項），確認全部都是可重建的快取，再改策略。

如果裡面確實混了不能驅逐的資料——**那才是根本問題**，應該把它們拆到獨立的實例（第 11 章的垂直拆分）。

**優先級 2（本週）：補上 TTL**

```bash
# 找出沒有 TTL 的 key 並補上（分批，避免一次操作太多）
redis-cli --scan --pattern 'cache:*' --count 500 | \
  while read k; do
    [ "$(redis-cli TTL "$k")" = "-1" ] && redis-cli EXPIRE "$k" $((3600 + RANDOM % 600))
  done
```

注意 `$((3600 + RANDOM % 600))` 的抖動——一次補上 2700 萬個相同的 TTL，一小時後會是一場完美的雪崩（第 09 章）。

同時要**修好寫入端的程式碼**，否則補完又會長回來。

**優先級 3（本週）：降低 fork 耗時**

```bash
# 1. 確認關閉透明大頁（THP）—— 這是 fork 慢最常見的原因
cat /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/enabled

# 2. 檢查 RDB 的 save 規則是否太頻繁
redis-cli CONFIG GET save

# 3. 如果有從節點，把持久化交給從節點做，主節點關閉 RDB
#    （要謹慎：主節點重啟就沒有本機的資料檔了）
```

根本解法是**減少資料量**——這和優先級 2 是同一件事。14.85G 裡如果有一半是該過期而沒過期的資料，清掉之後 fork 時間會直接減半。

**優先級 4（本月）：提升命中率**

69% 的命中率意味著三成的請求打到後端。要查的是（第 09 章）：

```text
是不是快取了低頻資料？   -> 只快取熱資料
是不是有穿透？           -> 看後端的查詢是不是大量「查無資料」
是不是 TTL 太短？         -> 但這裡的問題正好相反（沒有 TTL）
```

**這題的核心結論**

四個訊號裡，**最危險的那個（`volatile-lru` + 96% 無 TTL）在儀表板上完全看不出來**——記憶體 92% 會告警，但告警內容只會說「記憶體偏高」，不會說「而且你的驅逐策略即將失效」。

`evicted_keys:0` 這種「看起來是好消息」的指標，在錯誤的策略設定下是最危險的訊號。

</details>

### 練習 3：為一個 Redis 實例設計完整的監控與應變方案

某電商的 Redis（單機 32GB，主從 + Sentinel）承載 Session、商品快取與限流。請設計：

1. 監控指標與告警規則（含閾值理由）。
2. 每個告警對應的處理手冊（runbook）。
3. 一份可以交給值班同事的排錯速查表。

<details>
<summary>參考解答</summary>

**1. 監控指標與告警**

分三層，每層的告警動作不同。

**P0（立刻叫人起床）**

| 告警 | 條件 | 閾值理由 |
|------|------|---------|
| Redis 無回應 | `redis_up == 0` 持續 1 分鐘 | 1 分鐘避開網路抖動誤報；再久使用者已經有感 |
| 主從複製中斷 | `master_link_status != up` 持續 30 秒 | 從節點資料開始變舊，RPO 惡化中 |
| 磁碟寫入失敗 | `rdb_last_bgsave_status == err` | 寫入即將被全面拒絕，只有幾分鐘反應時間 |
| 發生故障轉移 | Sentinel `+switch-master` | 必然伴隨資料遺失，要人工確認影響範圍 |
| 記憶體被 swap | `rss / used_memory < 1` 持續 5 分鐘 | 延遲會惡化 10～100 倍，等同服務不可用 |

**P1（上班時間處理，非上班時間發通知不叫人）**

| 告警 | 條件 | 閾值理由 |
|------|------|---------|
| 記憶體 > 80% | 持續 10 分鐘 | 32GB 的 80% 是 25.6GB，以每月 8% 成長算還有約 2 個月，足夠從容處理 |
| 開始驅逐 | `rate(evicted_keys[5m]) > 0` 持續 5 分鐘 | 不為零就是記憶體不足；但要 5 分鐘避免瞬時尖峰誤報 |
| 複製延遲 > 50MB | 持續 2 分鐘 | 對應「故障轉移會丟 50MB 資料」，這是業務可接受上限（要跟業務確認） |
| 連線數 > 2000 | 持續 5 分鐘 | 平常尖峰是 1200，2000 給了 60% 餘裕；`maxclients` 是 10000 |
| fork > 500ms | 任一次 | 45000 QPS 下這會造成 2 萬個請求排隊 |
| 命中率下降 10% | 區間值 vs 前一天同時段 | 用同時段比對，避開日夜流量差異 |

**P2（進儀表板，不告警）**

慢命令數量、各命令 p99 延遲、`expired_keys` 速率、`sync_full` 次數、各服務的連線數。

**2. Runbook（每個告警怎麼處理）**

```markdown
## [P0] Redis 無回應

1. 確認是不是網路問題：從另一台機器 `redis-cli -h <ip> PING`
2. 確認行程還在：`ps aux | grep redis-server`
   - 不在 -> 查 dmesg 看是否 OOM kill：`dmesg -T | grep -i "killed process"`
   - 在但無回應 -> 可能被慢命令卡住，見下
3. 確認 Sentinel 是否已經自動切換：
   `redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster`
   - 已切換 -> 確認應用是否已連上新主（看應用日誌）
   - 未切換 -> 檢查 Sentinel 是否也掛了
4. 若行程存活但卡住，先採集再處理：
   `redis-cli --latency`、`redis-cli SLOWLOG GET 20`（可能連不上，盡力而為）
5. 最後手段才重啟。重啟前確認持久化檔案存在：`ls -la /data/`

## [P0] 記憶體被 swap（rss < used_memory）

1. 確認：`cat /proc/$(pgrep redis-server)/smaps | grep -i swap | awk '{s+=$2} END {print s}'`
2. 立刻降低記憶體壓力：
   - 找出並刪除最大的幾個 key：`redis-cli --memkeys`（在從節點跑）
   - 用 UNLINK 刪除（非阻塞）
3. 檢查機器是否有其他行程在吃記憶體：`top -o %MEM`
4. 長期：設定 `vm.swappiness=0`，並確保 maxmemory < 實體記憶體 × 0.7

## [P1] 開始驅逐（evicted_keys > 0）

1. 確認驅逐策略是否正確：`redis-cli CONFIG GET maxmemory-policy`
   - volatile-* + 大量無 TTL 的 key -> 這是設定錯誤，見練習 2
2. 確認 TTL 覆蓋率：`redis-cli INFO keyspace`
   - expires / keys < 50% -> 有大量永久 key，先查是哪個業務
3. 找出大 key：`redis-cli --memkeys`（從節點）
4. 短期處理：清理明確可刪的資料、臨時調高 maxmemory（若機器有餘裕）
5. 長期：擴容或垂直拆分（第 11 章）

## [P1] 複製延遲過大

1. 確認是網路還是負載：
   `redis-cli INFO stats | grep sync_` -> sync_full 增加代表 backlog 太小
2. 檢查從節點是否在做 BGSAVE（會拖慢複製）
3. 檢查主節點寫入量是否突增：`instantaneous_ops_per_sec`
4. 調大 repl-backlog-size（見第 11 章的計算方式）

## [P0] 發生故障轉移

1. 確認新主是誰：`redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster`
2. 確認應用已連上新主：看應用的錯誤率是否恢復
3. **評估資料遺失範圍**：
   - 查故障前後的業務日誌，找出「應用認為寫成功但 Redis 上沒有」的資料
   - Session：使用者可能被登出，通知客服
   - 限流計數器：可以接受重置
   - 分散式鎖：檢查是否有重複執行的任務（第 10 章）
4. 確認舊主恢復後已降級為從節點：`redis-cli -h <舊主> INFO replication | head -2`
5. 事後：把這次的 RPO/RTO 記錄下來
```

**3. 值班速查表（貼在牆上的那種）**

```text
┌───────────────────────────────────────────────────────────────┐
│ Redis 排錯 60 秒速查                                            │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│ 症狀：延遲高                                                    │
│   1. LATENCY LATEST     -> fork? expire? eviction? command?    │
│   2. SLOWLOG GET 10     -> 有 O(N) 命令嗎                       │
│   3. INFO memory        -> frag_ratio < 1 就是 swap（最嚴重）    │
│   4. --intrinsic-latency-> 高的話是機器問題，不是 Redis          │
│                                                               │
│ 症狀：記憶體高                                                  │
│   1. INFO keyspace      -> expires/keys 太低就是沒設 TTL         │
│   2. MEMORY STATS       -> clients.normal 大 = 緩衝區問題        │
│   3. --memkeys（從節點） -> 找 big key                           │
│   4. CONFIG GET maxmemory-policy -> volatile-* 是不是失效了      │
│                                                               │
│ 症狀：連線滿                                                    │
│   1. CLIENT LIST | grep age= -> 都很小 = 沒用連線池              │
│   2. CLIENT LIST | grep name= -> 哪個服務佔最多                  │
│   3. INFO stats | grep rejected -> 確認真的打滿了                │
│                                                               │
│ 症狀：資料不見                                                  │
│   1. INFO stats | grep evicted -> 被驅逐？                      │
│   2. TTL <key>          -> -2 是不存在，-1 是沒 TTL              │
│   3. INFO server | grep uptime -> 剛重啟？                      │
│   4. INFO replication   -> 剛故障轉移？                         │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│ ⚠ 絕對不要做的事                                                │
│   ✗ 先重啟（會清掉所有診斷資訊）                                 │
│   ✗ 跑 KEYS *                                                  │
│   ✗ 開 MONITOR 忘了關                                           │
│   ✗ 在主節點跑 --bigkeys / --memkeys                            │
│   ✗ DEL 一個大 key（用 UNLINK）                                 │
├───────────────────────────────────────────────────────────────┤
│ 出事時第一件事：採集，不是處理                                    │
│   redis-cli INFO all > /tmp/info-$(date +%s).txt               │
│   redis-cli SLOWLOG GET 128 > /tmp/slowlog-$(date +%s).txt     │
│   redis-cli CLIENT LIST > /tmp/clients-$(date +%s).txt         │
│   redis-cli LATENCY LATEST > /tmp/latency-$(date +%s).txt      │
└───────────────────────────────────────────────────────────────┘
```

**最後一段值得單獨強調：出事時第一件事是採集。**

重啟能讓症狀消失，但也會清空 `commandstats`、`slowlog`、`latency` 的所有歷史。採集只要 10 秒，卻決定了你事後能不能找出根因——否則同樣的事故下個月會再來一次，而你還是不知道為什麼。

</details>

---

## 12.17 驗收清單

進入下一章前，確認你可以：

- [ ] 說出監控的三個層次，以及各自該看什麼指標。
- [ ] 解讀 `INFO memory` 的關鍵欄位，說明 `mem_fragmentation_ratio < 1` 為什麼最嚴重。
- [ ] 解讀 `INFO stats`，說出 `evicted_keys`、`latest_fork_usec`、`rejected_connections` 各代表什麼。
- [ ] 用 `INFO commandstats` 找出「總耗時最高」的命令，而不只是「單次最慢」。
- [ ] 說明 `latencystats` 的 p99 為什麼比 `usec_per_call` 的平均值有用。
- [ ] 從 `INFO keyspace` 算出沒有 TTL 的 key 數量。
- [ ] 列出至少 10 個必須告警的指標，並說明閾值該怎麼推。
- [ ] 用 `SLOWLOG` 找慢命令，並說出它的兩個盲點。
- [ ] 說明為什麼要設 `CLIENT SETNAME`。
- [ ] 用 `LATENCY LATEST` 的事件類型判斷延遲來源。
- [ ] 說明 `--intrinsic-latency` 回答的是什麼問題。
- [ ] 說出 `--bigkeys` 和 `--memkeys` 的差別。
- [ ] 用 `CLIENT LIST` 的 `age`、`idle`、`omem` 診斷連線問題。
- [ ] 說明 `client-output-buffer-limit` 的三個類別與 `normal 0 0 0` 的風險。
- [ ] 正確使用 `redis-benchmark`，說出不加 `-r` 會有什麼問題。
- [ ] 照劇本排查延遲飆高、記憶體暴漲、連線打滿、資料消失。
- [ ] 說明 `volatile-*` 策略在大量無 TTL 的 key 下會失效。
- [ ] 說明為什麼「出事時第一件事是採集而不是重啟」。
- [ ] 建立一套含 exporter、告警規則、儀表板與應用層埋點的監控體系。
- [ ] 說明為什麼有降級機制時，特別需要監控「降級次數」。

---

下一章是上線前的最後一關：[13-security-and-production-best-practices.md](./13-security-and-production-best-practices.md)，我們會處理 ACL、TLS、危險命令、連線池設定、容量規劃與一份完整的上線檢查表。
