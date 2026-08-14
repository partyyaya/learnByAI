# 第 11 章：主從複製、Sentinel 與 Cluster

> 單機 Redis 有兩個天花板：**它會掛**，而且**它的記憶體有上限**。這章的三種架構分別在解這兩個問題——主從複製提供資料副本，Sentinel 提供自動故障轉移，Cluster 提供水平分片。
> 但每一種都要付代價，而且代價常常被低估。最典型的是：很多團隊上了主從 + Sentinel，以為「資料安全了」，直到某次故障轉移之後發現少了幾百筆寫入——因為 **Redis 的複製是非同步的，故障轉移必然會丟資料**。這不是設定錯誤，是設計取捨。
> 這章要把三種架構實際搭起來、把故障轉移真的觸發一次，並誠實回答上一章留下的問題：切換的那一刻，到底會丟多少。

---

## 11.1 學習目標

完成本章後，你應該可以：

- 說明主從複製的完整流程，區分全量同步與部分同步的觸發條件。
- 說明 `repl-backlog` 的作用，以及它設太小會造成什麼。
- 用 Docker Compose 搭起一主二從，並觀察複製狀態與延遲。
- 說出讀寫分離的三個陷阱，並判斷哪些讀不能走從節點。
- 部署 Sentinel，實際觸發一次故障轉移，並解讀整個過程的日誌。
- 說明 Sentinel 的 quorum、`down-after-milliseconds`、`failover-timeout` 各自的意義。
- 說明腦裂如何發生，以及 `min-replicas-to-write` 能與不能防住什麼。
- 用 RPO / RTO 的語言量化「故障轉移會丟多少資料、要多久」。
- 說明 Cluster 的 16384 slot、CRC16 分配、`MOVED` 與 `ASK` 的差別。
- 用 hash tag 讓多個 key 落在同一 slot，並說出它的副作用。
- 建立一個三主三從的 Cluster，並完成一次擴容 reshard。
- 說出 Cluster 對多 key 命令、Lua、交易、Pub/Sub 的限制。
- 在主從、Sentinel、Cluster 之間做出有理由的選擇。

---

## 11.2 三種架構在解什麼問題

```text
單機 Redis
   │
   ├─ 問題 1：機器掛掉，資料和服務都沒了
   │     └─> 主從複製：多一份資料副本（但故障時要手動切換）
   │           └─> + Sentinel：自動偵測故障並切換
   │
   └─ 問題 2：資料量或寫入量超過單機負荷
         └─> Cluster：把資料切成 16384 個 slot 分散到多個節點
```

| | 主從複製 | 主從 + Sentinel | Cluster |
|---|---------|----------------|---------|
| 解決 | 資料備援、讀擴展 | + 自動故障轉移 | + 水平擴展寫入與容量 |
| 寫入擴展 | 否（單一主節點） | 否 | **是** |
| 容量擴展 | 否 | 否 | **是** |
| 自動故障轉移 | 否（要人工） | **是** | **是**（內建） |
| 客戶端複雜度 | 低 | 中（要支援 Sentinel） | 高（要支援重導向） |
| 命令限制 | 無 | 無 | **有**（多 key 跨 slot） |
| 最少節點數 | 2 | 2 Redis + 3 Sentinel | 6（3 主 3 從） |
| 維運複雜度 | 低 | 中 | **高** |

**選擇的第一個原則：不要過早上 Cluster。** 單機 Redis 用 64GB 記憶體、跑到 10 萬 QPS 是很常見的，多數業務一輩子都到不了那個規模。Cluster 帶來的命令限制（11.12 節）會實際影響你的程式碼寫法，這個代價要在真的需要時才付。

---

## 11.3 主從複製的原理

### 基本設定

從節點只需要一行設定就能開始複製：

```bash
# 設定檔
replicaof 172.20.0.10 6379
masterauth coursepass          # 如果主節點有密碼

# 或執行時動態設定
REPLICAOF 172.20.0.10 6379

# 取消複製，變回獨立主節點
REPLICAOF NO ONE
```

（`SLAVEOF` 是舊名稱，5.0 起改為 `REPLICAOF`，兩者都還能用。）

### 完整同步流程

```text
從節點                                      主節點
  │                                           │
  │──── 1. PSYNC <replid> <offset> ─────────>│
  │                                           │
  │<─── 2a. +FULLRESYNC <replid> <offset> ───│  （需要全量同步）
  │                                           │
  │                                    3. BGSAVE 產生 RDB
  │                                       同時把期間的新寫入
  │                                       存進 replication buffer
  │                                           │
  │<─── 4. 傳送 RDB 檔案 ────────────────────│
  │                                           │
  │    5. 清空自己的資料，載入 RDB              │
  │                                           │
  │<─── 6. 傳送 buffer 裡累積的命令 ──────────│
  │                                           │
  │<═══ 7. 之後持續傳送每一個寫命令 ══════════│  （命令傳播）
```

### 全量同步 vs 部分同步

**部分同步（Partial Resynchronization）** 是 2.8 引入的最佳化。從節點斷線重連時，如果主節點還保留著斷線期間的命令，就只補送缺的那一段，不用重傳整份資料。

它依賴三個東西：

| 概念 | 作用 |
|------|------|
| **replication ID** | 標識一份資料集的「歷史」。主節點重啟或故障轉移後會產生新的 replid |
| **offset** | 複製流的位元組偏移量，主從各自維護，用來判斷從節點落後多少 |
| **repl-backlog** | 主節點上的環狀緩衝區，保存最近的複製流 |

判斷邏輯：

```text
從節點重連，送上 PSYNC <自己記得的 replid> <自己的 offset>

主節點檢查：
  replid 對得上嗎？
    不對 -> 全量同步（資料集歷史不同，例如故障轉移換過主）
  對的話，offset 還在 backlog 範圍內嗎？
    在   -> 部分同步，只補送 offset 之後的命令 ✅
    不在 -> 全量同步（斷線太久，缺的部分已經被覆蓋掉了）
```

### `repl-backlog-size`：一個常被設太小的參數

```bash
# 預設只有 1MB
repl-backlog-size 1mb

# 保留時間：即使沒有從節點連著也保留多久（預設 1 小時）
repl-backlog-ttl 3600
```

**1MB 在寫入量大的實例上撐不了幾秒。** 一次網路抖動導致從節點斷線 10 秒，如果這 10 秒的寫入量超過 1MB，重連時就會觸發**全量同步**——主節點要 fork 出 RDB、傳輸整份資料，這對主節點是明顯的負擔（第 06 章的 fork 阻塞問題）。

更糟的是它可能形成惡性循環：全量同步造成主節點負載升高 → 網路更擁塞 → 從節點又斷線 → 又一次全量同步。

怎麼設：

```text
repl-backlog-size ≥ 每秒寫入流量 × 可容忍的斷線時間

例：每秒寫入 5MB，希望能容忍 60 秒斷線
    -> 5MB × 60 = 300MB
```

用 `INFO stats` 的 `sync_full` 觀察是否設得太小：

```bash
redis-cli -a coursepass INFO stats | grep sync
# sync_full:2                 <- 全量同步次數，應該極少
# sync_partial_ok:15          <- 部分同步成功次數
# sync_partial_err:0          <- 部分同步失敗（退化成全量），這個持續增加就是 backlog 太小
```

### 無磁碟複製

預設的全量同步要先把 RDB 寫到磁碟再傳。磁碟慢的話這是瓶頸：

```bash
repl-diskless-sync yes            # 直接透過 socket 傳，不落地
repl-diskless-sync-delay 5        # 等 5 秒，讓多個從節點可以共用同一次傳輸
```

從節點側也可以不落地直接載入：

```bash
repl-diskless-load on-empty-db    # 資料庫為空時直接從 socket 載入
```

`swapdb` 選項更激進（先載到記憶體再切換），但會需要雙倍記憶體，一般不建議。

---

## 11.4 實作：搭一主二從

建立 `docker-compose-replication.yml`：

```yaml
services:
  redis-master:
    image: redis:7.2
    container_name: redis-master
    ports:
      - "6379:6379"
    command: >
      redis-server
      --requirepass coursepass
      --masterauth coursepass
      --appendonly yes
      --repl-backlog-size 64mb
    networks:
      redis-net:
        ipv4_address: 172.30.0.10

  redis-replica-1:
    image: redis:7.2
    container_name: redis-replica-1
    ports:
      - "6380:6379"
    command: >
      redis-server
      --requirepass coursepass
      --masterauth coursepass
      --replicaof 172.30.0.10 6379
      --appendonly yes
    depends_on:
      - redis-master
    networks:
      redis-net:
        ipv4_address: 172.30.0.11

  redis-replica-2:
    image: redis:7.2
    container_name: redis-replica-2
    ports:
      - "6381:6379"
    command: >
      redis-server
      --requirepass coursepass
      --masterauth coursepass
      --replicaof 172.30.0.10 6379
      --appendonly yes
    depends_on:
      - redis-master
    networks:
      redis-net:
        ipv4_address: 172.30.0.12

networks:
  redis-net:
    driver: bridge
    ipam:
      config:
        - subnet: 172.30.0.0/16
```

固定 IP 是必要的——Sentinel 和 Cluster 都會記錄節點位址，用 Docker 的動態 IP 在容器重啟後會對不上。

啟動與驗證：

```bash
docker compose -f docker-compose-replication.yml up -d
```

```bash
# 主節點狀態
docker exec redis-master redis-cli -a coursepass INFO replication
```

```text
# Replication
role:master
connected_slaves:2
slave0:ip=172.30.0.11,port=6379,state=online,offset=1234,lag=0
slave1:ip=172.30.0.12,port=6379,state=online,offset=1234,lag=0
master_replid:8f3c2a1b...
master_repl_offset:1234
```

```bash
# 從節點狀態
docker exec redis-replica-1 redis-cli -a coursepass INFO replication
```

```text
role:slave
master_host:172.30.0.10
master_link_status:up          <- 關鍵：連線正常
master_last_io_seconds_ago:1
slave_read_only:1
slave_repl_offset:1234
```

驗證資料同步：

```bash
docker exec redis-master redis-cli -a coursepass SET hello world
docker exec redis-replica-1 redis-cli -a coursepass GET hello
# "world"
```

驗證從節點唯讀：

```bash
docker exec redis-replica-1 redis-cli -a coursepass SET foo bar
# (error) READONLY You can't write against a read only replica.
```

`replica-read-only yes` 是預設值，**不要關掉它**。從節點的寫入不會同步回主節點，而且下次全量同步時會被清空——這種資料會安靜地消失，是很難查的問題。

### 觀察複製延遲

```bash
# 主節點的 offset
docker exec redis-master redis-cli -a coursepass INFO replication | grep master_repl_offset

# 從節點的 offset
docker exec redis-replica-1 redis-cli -a coursepass INFO replication | grep slave_repl_offset
```

兩者的差就是**還沒同步的位元組數**。`INFO replication` 在主節點上顯示的 `lag` 欄位是「秒」，精度較粗；用 offset 差值更準。

實測一下寫入壓力下的延遲：

```bash
# 持續寫入
docker exec redis-master redis-benchmark -a coursepass -t set -n 100000 -q &

# 另一個終端持續觀察 offset 差距
docker exec redis-master sh -c '
while true; do
  M=$(redis-cli -a coursepass --no-auth-warning INFO replication | grep master_repl_offset | cut -d: -f2 | tr -d "\r")
  S=$(redis-cli -a coursepass --no-auth-warning INFO replication | grep "slave0" | grep -o "offset=[0-9]*" | cut -d= -f2)
  echo "master=$M replica=$S diff=$((M-S))"
  sleep 1
done'
```

---

## 11.5 讀寫分離的三個陷阱

把讀流量分到從節點是主從架構最直接的好處，但有三個陷阱。

### 陷阱 1：複製延遲造成「寫了讀不到」

```text
使用者改了暱稱 -> 寫入主節點 -> 前端立刻重新載入 -> 讀從節點（還沒同步）
                                                        ▲
                                            使用者看到的還是舊暱稱
```

這是讀寫分離最常見的客訴來源。三種處理方式：

```javascript
// 方式 1：關鍵讀走主節點（最簡單也最常用）
async function getUserProfile(userId, { fresh = false } = {}) {
  const client = fresh ? masterClient : replicaClient;
  return await client.get(`user:${userId}`);
}

// 寫入後的第一次讀，強制走主
await updateProfile(userId, data);
const profile = await getUserProfile(userId, { fresh: true });
```

```javascript
// 方式 2：寫入後在 session 裡標記一段時間，這段期間都走主節點
async function afterWrite(userId) {
  recentWrites.set(userId, Date.now() + 3000);   // 3 秒內都走主
}

function pickClient(userId) {
  const until = recentWrites.get(userId);
  return (until && Date.now() < until) ? masterClient : replicaClient;
}
```

```javascript
// 方式 3：用 WAIT 等待複製確認（會犧牲延遲）
await master.set(`user:${userId}`, value);
const acked = await master.wait(1, 100);   // 等至少 1 個 replica 確認，最多等 100ms
if (acked < 1) {
  logger.warn('replication not acked, subsequent reads may be stale');
}
```

`WAIT numreplicas timeout` 會阻塞直到指定數量的從節點確認收到，或超時。**注意它保證的是「收到」不是「持久化」**，而且會顯著增加寫入延遲，只用在真正需要的地方。

### 陷阱 2：從節點的過期 key 行為

這是一個很少人知道、但會造成實際 bug 的細節：

**從節點不會自己刪除過期的 key。** 它等主節點發來 `DEL` 命令才刪。原因是必須維持主從資料一致——如果從節點自己刪，兩邊的資料集就會分歧。

那麼「主節點還沒發現這個 key 過期」的期間，從節點上讀這個 key 會怎樣？

```text
Redis 3.2 之前：可能讀到已過期的資料 ❌
Redis 3.2 之後：從節點會在讀取時檢查邏輯過期時間，回傳 nil ✅
```

所以現代版本讀取是安全的，**但 `DBSIZE`、`KEYS`、`SCAN` 在從節點上仍可能算進已過期的 key**：

```bash
# 從節點上的 key 數量可能大於主節點
docker exec redis-replica-1 redis-cli -a coursepass DBSIZE
```

用從節點的 `DBSIZE` 做監控或容量判斷時要知道這件事。

### 陷阱 3：從節點的故障不會自動處理

從節點掛掉時，如果你的客戶端沒有健康檢查，讀請求會直接失敗。這需要：

- 客戶端支援從節點列表與自動剔除，或
- 前面放一層代理（HAProxy、Envoy、Twemproxy），或
- 用 Sentinel 並讓客戶端透過 Sentinel 取得可用的從節點列表

### 哪些讀不能走從節點

```text
不能走從節點：
  寫入後立刻要讀（read-your-writes）
  金額、庫存、餘額等「讀了要拿來做決策」的資料
  分散式鎖的檢查（第 10 章：從節點上的鎖狀態可能是舊的）
  需要精確 DBSIZE / key 數量的監控

可以走從節點：
  商品詳情、文章內容等變動不頻繁的資料
  排行榜、統計數字（本來就允許延遲）
  報表、資料匯出（大量讀取，正好不該打主節點）
```

---

## 11.6 Sentinel：自動故障轉移

主從複製解決了「有副本」，但主節點掛掉時仍然要人工介入：找出最新的從節點、`REPLICAOF NO ONE` 提升它、改其他從節點的複製目標、改應用的連線設定。這個過程通常要十幾分鐘，而且半夜執行很容易出錯。

Sentinel 把這件事自動化。

### 架構

```text
        ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
        │ Sentinel 1  │  │ Sentinel 2  │  │ Sentinel 3  │
        └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
               └────────────────┼────────────────┘
                    互相通訊，共同決策
                                │ 監控
               ┌────────────────┼────────────────┐
               ▼                ▼                ▼
        ┌───────────┐    ┌───────────┐    ┌───────────┐
        │  Master   │───>│ Replica 1 │    │ Replica 2 │
        └───────────┘    └───────────┘    └───────────┘
```

**Sentinel 至少要 3 個，且要是奇數。** 原因是故障判定需要多數決——2 個 Sentinel 的話，其中一個掛掉，剩下的無法形成多數，故障轉移就做不了。

### 故障判定的兩個階段

```text
1. 主觀下線（SDOWN, Subjectively Down）
   單一 Sentinel 在 down-after-milliseconds 內收不到 PING 回應
   -> 它「個人認為」主節點掛了

2. 客觀下線（ODOWN, Objectively Down）
   達到 quorum 個 Sentinel 都認為主節點主觀下線
   -> 「大家一致認為」主節點掛了，可以開始故障轉移
```

這個兩階段設計是為了避免**單一 Sentinel 的網路問題造成誤判**。如果只有 Sentinel 2 連不上主節點，那多半是 Sentinel 2 自己的網路問題，不該觸發轉移。

### 故障轉移流程

```text
1. 達成 ODOWN
2. Sentinel 之間選出一個 leader（用 Raft 的變體）
   —— 需要超過半數 Sentinel 同意，這裡的門檻是「多數」，不是 quorum
3. Leader 從從節點中挑選新主，優先序：
     a. 排除已下線、斷線太久的
     b. replica-priority 較小的優先（設為 0 表示永不提升）
     c. 複製 offset 較大的優先（資料最新）
     d. runid 字典序較小的（純粹為了決定性）
4. 對選中的從節點執行 REPLICAOF NO ONE，提升為主
5. 讓其他從節點 REPLICAOF 新主
6. 把舊主標記為從節點（它恢復後會自動去複製新主）
7. 透過 Pub/Sub 通知客戶端（+switch-master 事件）
```

**注意第 2 步和 ODOWN 的門檻不同**：ODOWN 用 `quorum` 參數，但真正執行故障轉移的 leader 選舉需要**超過半數的 Sentinel** 同意。所以 5 個 Sentinel、quorum 設 2 的話，2 個就能判定 ODOWN，但仍需要 3 個才能真的執行轉移。這個區別常被誤解。

### 設定

`sentinel.conf`：

```bash
port 26379

# 監控名為 mymaster 的主節點，quorum = 2
sentinel monitor mymaster 172.30.0.10 6379 2

# 主節點的密碼
sentinel auth-pass mymaster coursepass

# 多久沒回應就判定主觀下線（毫秒）
sentinel down-after-milliseconds mymaster 5000

# 故障轉移的超時
sentinel failover-timeout mymaster 60000

# 轉移後同時有幾個從節點去同步新主
# 設 1 表示一個一個來，避免同時全量同步壓垮新主
sentinel parallel-syncs mymaster 1
```

三個參數的取捨：

| 參數 | 設太小 | 設太大 |
|------|-------|--------|
| `down-after-milliseconds` | 網路抖動就誤觸發轉移 | 真的掛了要等很久才切（RTO 變長） |
| `failover-timeout` | 轉移還沒完成就被判定失敗 | 卡住時要等很久才重試 |
| `parallel-syncs` | 轉移後從節點恢復慢 | 多個從節點同時全量同步，壓垮新主 |

實務常見值：`down-after` 5～30 秒（要大於你的網路抖動時間），`parallel-syncs` 設 1。

---

## 11.7 實作：部署 Sentinel 並觸發故障轉移

在 11.4 的基礎上加入三個 Sentinel。建立 `sentinel.conf`：

```bash
mkdir -p sentinel
cat > sentinel/sentinel.conf <<'EOF'
port 26379
sentinel monitor mymaster 172.30.0.10 6379 2
sentinel auth-pass mymaster coursepass
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 60000
sentinel parallel-syncs mymaster 1
EOF
```

**Sentinel 會改寫自己的設定檔**（記錄目前的主節點、其他 Sentinel 的位址），所以每個 Sentinel 需要自己的一份副本，不能共用同一個檔案：

```bash
for i in 1 2 3; do
  mkdir -p sentinel/s$i
  cp sentinel/sentinel.conf sentinel/s$i/sentinel.conf
done
```

加進 compose：

```yaml
  sentinel-1:
    image: redis:7.2
    container_name: sentinel-1
    ports:
      - "26379:26379"
    command: redis-sentinel /etc/redis/sentinel.conf
    volumes:
      - ./sentinel/s1/sentinel.conf:/etc/redis/sentinel.conf
    depends_on:
      - redis-master
    networks:
      redis-net:
        ipv4_address: 172.30.0.21

  sentinel-2:
    image: redis:7.2
    container_name: sentinel-2
    ports:
      - "26380:26379"
    command: redis-sentinel /etc/redis/sentinel.conf
    volumes:
      - ./sentinel/s2/sentinel.conf:/etc/redis/sentinel.conf
    depends_on:
      - redis-master
    networks:
      redis-net:
        ipv4_address: 172.30.0.22

  sentinel-3:
    image: redis:7.2
    container_name: sentinel-3
    ports:
      - "26381:26379"
    command: redis-sentinel /etc/redis/sentinel.conf
    volumes:
      - ./sentinel/s3/sentinel.conf:/etc/redis/sentinel.conf
    depends_on:
      - redis-master
    networks:
      redis-net:
        ipv4_address: 172.30.0.23
```

啟動並確認：

```bash
docker compose -f docker-compose-replication.yml up -d

# 查詢 Sentinel 看到的主節點
docker exec sentinel-1 redis-cli -p 26379 SENTINEL master mymaster
```

重點欄位：

```text
name                        mymaster
ip                          172.30.0.10
port                        6379
flags                       master
num-slaves                  2
num-other-sentinels         2        <- 有看到另外兩個 Sentinel
quorum                      2
```

`num-other-sentinels` 是 2 才代表三個 Sentinel 互相發現了。如果是 0，通常是網路設定問題。

其他實用查詢：

```bash
# 目前的主節點位址（客戶端就是問這個）
docker exec sentinel-1 redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster
# 1) "172.30.0.10"
# 2) "6379"

# 從節點列表
docker exec sentinel-1 redis-cli -p 26379 SENTINEL replicas mymaster
```

### 觸發故障轉移

**方式 1：手動觸發（測試用，不會真的殺掉主節點）**

```bash
docker exec sentinel-1 redis-cli -p 26379 SENTINEL failover mymaster
```

**方式 2：模擬主節點故障（真實演練）**

先開一個終端持續觀察 Sentinel 的事件：

```bash
docker exec sentinel-1 redis-cli -p 26379 PSUBSCRIBE '*'
```

另一個終端殺掉主節點：

```bash
docker stop redis-master
```

觀察事件序列（約 5～10 秒內）：

```text
+sdown master mymaster 172.30.0.10 6379          <- 主觀下線
+odown master mymaster 172.30.0.10 6379 #quorum 2/2  <- 客觀下線
+try-failover master mymaster ...
+vote-for-leader <runid> <epoch>                 <- Sentinel 選 leader
+elected-leader master mymaster ...
+failover-state-select-slave master mymaster ...
+selected-slave slave 172.30.0.11:6379 ...       <- 選中 replica-1
+failover-state-send-slaveof-noone ...
+promoted-slave slave 172.30.0.11:6379 ...       <- 提升為主
+failover-state-reconf-slaves ...
+slave-reconf-sent slave 172.30.0.12:6379 ...    <- 讓 replica-2 改跟新主
+switch-master mymaster 172.30.0.10 6379 172.30.0.11 6379   <- 完成！
```

**`+switch-master` 是客戶端要訂閱的事件**，格式是「主節點名稱 舊IP 舊PORT 新IP 新PORT」。

驗證：

```bash
docker exec redis-replica-1 redis-cli -a coursepass INFO replication | head -3
# role:master              <- replica-1 已經是主節點了
# connected_slaves:1
```

把舊主啟回來：

```bash
docker start redis-master
sleep 5
docker exec redis-master redis-cli -a coursepass INFO replication | head -3
# role:slave               <- 自動變成從節點，去複製新主
# master_host:172.30.0.11
```

Sentinel 會自動把恢復的舊主降級為從節點——**這一步很重要，它避免了兩個主節點同時存在**。

### 客戶端怎麼感知切換

客戶端不能寫死主節點 IP，要透過 Sentinel 取得：

```javascript
const Redis = require('ioredis');

const redis = new Redis({
  sentinels: [
    { host: '127.0.0.1', port: 26379 },
    { host: '127.0.0.1', port: 26380 },
    { host: '127.0.0.1', port: 26381 },
  ],
  name: 'mymaster',              // 對應 sentinel monitor 的名稱
  password: 'coursepass',
  sentinelPassword: undefined,   // Sentinel 本身若有密碼要設

  // 故障轉移期間的重試策略
  retryStrategy: (times) => Math.min(times * 200, 3000),
});

// 讀請求走從節點
const redisReader = new Redis({
  sentinels: [ /* 同上 */ ],
  name: 'mymaster',
  role: 'slave',                 // 從 Sentinel 取得從節點列表
  password: 'coursepass',
});
```

客戶端函式庫會自己訂閱 `+switch-master` 並重新連線。**你的程式碼要能容忍故障轉移期間的短暫錯誤**（通常 5～30 秒），所以重試機制不能省。

---

## 11.8 腦裂與資料遺失：故障轉移的 RPO

### 非同步複製必然會丟資料

回到本章開頭那個問題。Redis 的複製流程是：

```text
客戶端 -> 主節點寫入成功 -> 立刻回 OK 給客戶端
                              │
                              └─> （之後才）傳送給從節點
```

**主節點回 OK 的那一刻，資料還沒到從節點。** 所以：

```text
主節點在「已回 OK，但還沒複製」的瞬間掛掉
  -> 那些寫入永遠遺失
  -> 客戶端卻收到過成功的回應
```

用 `database-course` 第 09 章的語言說：**Redis 主從架構的 RPO 不是 0，它等於「複製延遲」的大小。** 正常情況下是幾毫秒的量，但在寫入高峰或網路擁塞時可能是幾百毫秒甚至幾秒的資料。

這也正是第 10 章講的「主從切換會丟鎖」的根本原因——鎖的寫入還沒複製過去，新主上就沒有那把鎖。

### 腦裂（Split-Brain）

更嚴重的情況是網路分區：

```text
                 ╳ 網路分區 ╳
     ┌───────────────┐   │   ┌──────────────────────┐
     │  舊 Master    │   │   │  Sentinel × 3        │
     │  + 部分客戶端  │   │   │  Replica 1, 2        │
     └───────────────┘   │   └──────────────────────┘
                         │
     舊主還在接受寫入 ────┘── Sentinel 判定它掛了，提升 Replica 1 為新主

     現在有兩個主節點，各自接受寫入！
```

分區恢復後，舊主被降級為從節點，它會**清空自己的資料並全量同步新主**——分區期間寫進舊主的所有資料**全部消失**。

而那些客戶端當時收到的都是成功回應。

### `min-replicas-to-write`：降低損失

```bash
# 主節點要求：至少有 N 個從節點的複製延遲小於 M 秒，才接受寫入
min-replicas-to-write 1
min-replicas-max-lag 10
```

設定後，如果主節點發現健康的從節點少於 1 個，它會**拒絕所有寫入**：

```text
(error) NOREPLICAS Not enough good replicas to write.
```

這樣在腦裂時，被隔離的舊主會因為連不上從節點而停止接受寫入，把損失限制在 `min-replicas-max-lag` 這段時間內。

**但這是用可用性換一致性**：從節點全掛時，主節點也不能寫了。要不要開、參數怎麼設，取決於你的業務更怕丟資料還是更怕不可用。

| 設定 | 效果 | 適合 |
|------|------|------|
| 不設（預設） | 可用性優先，腦裂時損失不受限 | 純快取 |
| `min-replicas-to-write 1` | 至少一個從節點健康才寫 | 半持久化的狀態資料 |
| `min-replicas-to-write 2` | 更嚴格，但更容易變不可寫 | 很少用（Redis 不是為此設計的） |

**根本結論：Redis 不適合當需要零資料遺失的事實來源。** 這是第 00 章就講過的定位問題，架構層面繞不過去。真的需要強保證，用 AWS MemoryDB（它有多可用區的交易日誌）或換一個為此設計的系統。

### 量化你的 RPO / RTO

演練故障轉移時，順便把這兩個數字量出來：

```bash
# 一邊持續寫入帶序號的資料
docker exec redis-master sh -c '
i=0
while true; do
  redis-cli -a coursepass --no-auth-warning SET seq:latest $i > /dev/null 2>&1 || break
  i=$((i+1))
done' &

# 記錄殺掉主節點的時間
date +%s%3N && docker stop redis-master

# 持續嘗試寫入新主，記錄第一次成功的時間（= RTO）
while ! docker exec redis-replica-1 redis-cli -a coursepass --no-auth-warning SET probe 1 2>/dev/null | grep -q OK; do
  sleep 0.2
done
date +%s%3N

# 比對新主上的 seq:latest 和你最後寫入的序號（差值 = RPO 的實測值）
docker exec redis-replica-1 redis-cli -a coursepass GET seq:latest
```

典型結果：RTO 約 `down-after-milliseconds` + 幾秒（5～15 秒），RPO 是幾十到幾百筆寫入。**把這兩個數字寫進你的維運文件**，並在每次調整參數後重測。

---

## 11.9 Cluster：水平分片

當單機記憶體或寫入量不夠時，才需要 Cluster。

### 16384 個 slot

Cluster 不是用一致性雜湊，而是用**固定的 16384 個 slot**：

```text
slot = CRC16(key) mod 16384

三個主節點的典型分配：
  節點 A：slot 0     ~ 5460
  節點 B：slot 5461  ~ 10922
  節點 C：slot 10923 ~ 16383
```

用固定 slot 數的好處是：**slot 的所有權可以被明確地轉移**。擴容時就是把某些 slot 從舊節點搬到新節點，不需要重算整個雜湊環。

為什麼是 16384（2^14）而不是更多？節點之間要互相交換 slot 分配資訊，用 bitmap 表示的話 16384 bit = 2KB，這個大小在心跳封包裡是可接受的。而 65536 就會變成 8KB，對高頻的節點間通訊來說太大。

查詢某個 key 屬於哪個 slot：

```bash
redis-cli -c -p 7001 CLUSTER KEYSLOT user:1001
# (integer) 8093
```

### `MOVED` 與 `ASK`

客戶端可能連到不負責該 slot 的節點，這時節點會回一個重導向錯誤：

```bash
# 連到節點 A，但這個 key 屬於節點 B
127.0.0.1:7001> GET user:1001
(error) MOVED 8093 172.30.1.12:6379
```

**`MOVED` 表示「這個 slot 永久屬於那個節點」**，客戶端應該更新自己的 slot 路由表，之後直接連對的節點。

```bash
# 遷移進行中
(error) ASK 8093 172.30.1.13:6379
```

**`ASK` 表示「這個 slot 正在遷移，這一次請求去問那個節點」**，客戶端**不應該**更新路由表——因為遷移還沒完成，其他 key 可能還在原節點。客戶端要先送 `ASKING` 命令再送實際命令。

兩者的差別是 Cluster 面試的高頻題：

| | `MOVED` | `ASK` |
|---|--------|-------|
| 含義 | slot 已經歸屬新節點 | slot 遷移中，這個 key 已經搬過去了 |
| 客戶端行為 | **更新**本地路由表 | **不更新**，只這次重導向 |
| 前置命令 | 無 | 要先送 `ASKING` |

用 `redis-cli -c` 會自動處理重導向（`-c` 就是 cluster 模式）：

```bash
redis-cli -c -p 7001 GET user:1001
# -> Redirected to slot [8093] located at 172.30.1.12:6379
# "value"
```

生產環境的客戶端函式庫（ioredis、Lettuce、redis-py-cluster）都會在啟動時抓取 slot 分配表並自動維護。

### hash tag：讓多個 key 落在同一 slot

Cluster 下，多 key 命令要求所有 key 在同一個 slot：

```bash
127.0.0.1:7001> MGET user:1001 user:1002
(error) CROSSSLOT Keys in request don't hash to the same slot
```

用 `{}` 指定參與雜湊計算的部分：

```bash
# 只用 {user:1001} 內的內容算 slot，所以這三個 key 一定同 slot
CLUSTER KEYSLOT "{user:1001}:profile"
CLUSTER KEYSLOT "{user:1001}:settings"
CLUSTER KEYSLOT "{user:1001}:cart"
# 三個都回傳同一個數字
```

```javascript
// 應用：同一使用者的所有資料放同一 slot，就能用 MGET / 交易 / Lua
const key = (userId, suffix) => `{user:${userId}}:${suffix}`;

await redis.mget(key(1001, 'profile'), key(1001, 'cart'));   // OK
```

**hash tag 的副作用要注意**：如果你用 `{tenant:123}` 當 tag，那個租戶的所有資料都會擠在同一個節點上。大租戶會造成明顯的資料傾斜——**這正是分片鍵選擇的老問題**（`database-course` 第 08 章討論過同樣的取捨）。

hash tag 只該用在「確實需要一起操作」的 key 上，不要濫用。

---

## 11.10 實作：建立三主三從的 Cluster

`docker-compose-cluster.yml`：

```yaml
services:
  redis-1:
    image: redis:7.2
    container_name: redis-cluster-1
    command: >
      redis-server
      --port 6379
      --cluster-enabled yes
      --cluster-config-file nodes.conf
      --cluster-node-timeout 5000
      --appendonly yes
      --requirepass coursepass
      --masterauth coursepass
    ports: ["7001:6379"]
    networks:
      cluster-net:
        ipv4_address: 172.31.0.11

  redis-2:
    image: redis:7.2
    container_name: redis-cluster-2
    command: >
      redis-server --port 6379 --cluster-enabled yes
      --cluster-config-file nodes.conf --cluster-node-timeout 5000
      --appendonly yes --requirepass coursepass --masterauth coursepass
    ports: ["7002:6379"]
    networks:
      cluster-net:
        ipv4_address: 172.31.0.12

  redis-3:
    image: redis:7.2
    container_name: redis-cluster-3
    command: >
      redis-server --port 6379 --cluster-enabled yes
      --cluster-config-file nodes.conf --cluster-node-timeout 5000
      --appendonly yes --requirepass coursepass --masterauth coursepass
    ports: ["7003:6379"]
    networks:
      cluster-net:
        ipv4_address: 172.31.0.13

  redis-4:
    image: redis:7.2
    container_name: redis-cluster-4
    command: >
      redis-server --port 6379 --cluster-enabled yes
      --cluster-config-file nodes.conf --cluster-node-timeout 5000
      --appendonly yes --requirepass coursepass --masterauth coursepass
    ports: ["7004:6379"]
    networks:
      cluster-net:
        ipv4_address: 172.31.0.14

  redis-5:
    image: redis:7.2
    container_name: redis-cluster-5
    command: >
      redis-server --port 6379 --cluster-enabled yes
      --cluster-config-file nodes.conf --cluster-node-timeout 5000
      --appendonly yes --requirepass coursepass --masterauth coursepass
    ports: ["7005:6379"]
    networks:
      cluster-net:
        ipv4_address: 172.31.0.15

  redis-6:
    image: redis:7.2
    container_name: redis-cluster-6
    command: >
      redis-server --port 6379 --cluster-enabled yes
      --cluster-config-file nodes.conf --cluster-node-timeout 5000
      --appendonly yes --requirepass coursepass --masterauth coursepass
    ports: ["7006:6379"]
    networks:
      cluster-net:
        ipv4_address: 172.31.0.16

networks:
  cluster-net:
    driver: bridge
    ipam:
      config:
        - subnet: 172.31.0.0/16
```

啟動並組成叢集：

```bash
docker compose -f docker-compose-cluster.yml up -d
sleep 5

docker exec redis-cluster-1 redis-cli -a coursepass --cluster create \
  172.31.0.11:6379 172.31.0.12:6379 172.31.0.13:6379 \
  172.31.0.14:6379 172.31.0.15:6379 172.31.0.16:6379 \
  --cluster-replicas 1 --cluster-yes
```

`--cluster-replicas 1` 表示每個主節點配一個從節點，所以 6 個節點會變成 3 主 3 從。工具會自動盡量把主從放在不同的「機器」上（用 IP 判斷）。

輸出會顯示 slot 分配：

```text
M: xxx 172.31.0.11:6379
   slots:[0-5460] (5461 slots) master
M: yyy 172.31.0.12:6379
   slots:[5461-10922] (5462 slots) master
M: zzz 172.31.0.13:6379
   slots:[10923-16383] (5461 slots) master
S: aaa 172.31.0.14:6379
   replicates xxx
...
```

驗證：

```bash
# 叢集狀態
docker exec redis-cluster-1 redis-cli -a coursepass CLUSTER INFO
# cluster_state:ok
# cluster_slots_assigned:16384
# cluster_known_nodes:6
# cluster_size:3

# 節點列表
docker exec redis-cluster-1 redis-cli -a coursepass CLUSTER NODES

# 寫入測試（-c 啟用重導向）
docker exec redis-cluster-1 redis-cli -a coursepass -c SET user:1001 "Alice"
docker exec redis-cluster-1 redis-cli -a coursepass -c GET user:1001

# 看資料分布
for i in 1 2 3; do
  echo -n "node-$i: "
  docker exec redis-cluster-$i redis-cli -a coursepass DBSIZE
done
```

灌一些資料觀察分布：

```bash
docker exec redis-cluster-1 sh -c '
for i in $(seq 1 1000); do
  redis-cli -a coursepass --no-auth-warning -c SET key:$i value:$i > /dev/null
done'

# 檢查分布是否均勻
docker exec redis-cluster-1 redis-cli -a coursepass --cluster info 172.31.0.11:6379
```

### 故障轉移

Cluster 內建故障轉移，不需要 Sentinel：

```bash
# 殺掉一個主節點
docker stop redis-cluster-1

# 等待 cluster-node-timeout（5 秒）後觀察
sleep 10
docker exec redis-cluster-2 redis-cli -a coursepass CLUSTER NODES | grep master
```

從節點會被提升為主。判定機制和 Sentinel 類似——**多數主節點**認為某節點失聯，才會觸發轉移（所以主節點數量也建議是奇數，且至少 3 個）。

```bash
# 恢復
docker start redis-cluster-1
sleep 5
docker exec redis-cluster-1 redis-cli -a coursepass INFO replication | head -2
# role:slave        <- 變成新主的從節點
```

---

## 11.11 擴容：重新分片

加入第四個主節點並搬移 slot 過去。

```bash
# 1. 啟動新節點（假設是 172.31.0.17）
# 2. 加入叢集
docker exec redis-cluster-1 redis-cli -a coursepass --cluster add-node \
  172.31.0.17:6379 172.31.0.11:6379

# 新節點目前沒有任何 slot
docker exec redis-cluster-1 redis-cli -a coursepass CLUSTER NODES | grep 172.31.0.17
```

搬移 slot：

```bash
# 互動式
docker exec -it redis-cluster-1 redis-cli -a coursepass --cluster reshard 172.31.0.11:6379

# 會問你：
#   How many slots do you want to move? -> 4096   （16384 / 4）
#   What is the receiving node ID? -> <新節點的 ID>
#   Source node #1: -> all           （從所有節點平均取）
```

非互動式（適合寫進腳本）：

```bash
docker exec redis-cluster-1 redis-cli -a coursepass --cluster reshard 172.31.0.11:6379 \
  --cluster-from all \
  --cluster-to <新節點ID> \
  --cluster-slots 4096 \
  --cluster-yes
```

自動平衡（7.0 後更方便）：

```bash
docker exec redis-cluster-1 redis-cli -a coursepass --cluster rebalance 172.31.0.11:6379 \
  --cluster-use-empty-masters
```

### 遷移期間發生什麼

這是 `ASK` 重導向存在的原因：

```text
slot 8000 正在從節點 A 遷移到節點 B

客戶端請求 slot 8000 裡的某個 key：
  key 還在 A     -> A 正常回應
  key 已搬到 B   -> A 回 ASK 172.31.0.17:6379
                    客戶端送 ASKING + 命令 給 B

遷移完成後，A 會回 MOVED，客戶端才更新路由表
```

**遷移是線上進行的，不需要停機**，但會有額外的網路與 CPU 負載。大規模 reshard 建議在低峰期做，並用 `--cluster-timeout` 控制節奏。

### 縮容

反過來：先把 slot 搬走，再移除節點。

```bash
# 1. 把該節點的 slot 全部搬給別人
docker exec redis-cluster-1 redis-cli -a coursepass --cluster reshard 172.31.0.11:6379 \
  --cluster-from <要移除的節點ID> \
  --cluster-to <目標節點ID> \
  --cluster-slots 4096 --cluster-yes

# 2. 確認它已經沒有 slot 了，再移除
docker exec redis-cluster-1 redis-cli -a coursepass --cluster del-node \
  172.31.0.11:6379 <要移除的節點ID>
```

**順序不能反。** 直接 `del-node` 一個還持有 slot 的節點，那些 slot 會變成無人負責，叢集狀態變成 `fail`。

---

## 11.12 Cluster 的限制

這些限制會實際影響你的程式碼，上 Cluster 前必須知道。

### 限制 1：多 key 命令要求同 slot

```bash
MGET user:1 user:2               # CROSSSLOT 錯誤
MSET a 1 b 2                     # CROSSSLOT 錯誤
SINTER set:a set:b               # CROSSSLOT 錯誤
ZUNIONSTORE dst 2 src1 src2      # CROSSSLOT 錯誤
```

解法：用 hash tag，或改成多次單 key 操作（用 pipeline 減少往返）。

```javascript
// 不能用 MGET，改成 pipeline
const pipe = redis.pipeline();
for (const id of ids) pipe.get(`user:${id}`);
const results = await pipe.exec();
```

多數 Cluster 客戶端函式庫會自動把 `mget` 拆成按節點分組的多個請求，但要確認你用的函式庫有這個功能。

### 限制 2：Lua 腳本的所有 key 要在同一 slot

```bash
EVAL "return redis.call('GET', KEYS[1]) .. redis.call('GET', KEYS[2])" 2 a b
# (error) CROSSSLOT
```

而且腳本裡**不能存取沒有宣告在 `KEYS` 裡的 key**（Cluster 模式會檢查）。這是第 07 章強調「一定要用 KEYS 而不是在腳本裡寫死 key 名稱」的實際原因。

第 10 章的滑動窗口計數限流器就會踩到這個，解法是 hash tag：

```javascript
`rate:{${key}}:${bucket - 1}`
`rate:{${key}}:${bucket}`
```

### 限制 3：`MULTI`/`EXEC` 只能在同一 slot

跨 slot 的交易不支援。這也是 hash tag 的常見用途。

### 限制 4：只有 database 0

```bash
SELECT 1
# (error) ERR SELECT is not allowed in cluster mode
```

Cluster 不支援多 database。原本用 `SELECT` 做環境隔離的做法要改成 key 前綴。

### 限制 5：Pub/Sub 是全叢集廣播

第 08 章提過：`PUBLISH` 會被廣播到叢集裡的**每一個節點**，不管有沒有訂閱者。節點越多，這個開銷越大。

Redis 7.0 引入 sharded Pub/Sub 解決這個問題：

```bash
SPUBLISH channel message    # 只在該 channel 所屬 slot 的節點上傳播
SSUBSCRIBE channel
```

### 限制 6：`KEYS`、`SCAN`、`DBSIZE` 是單節點的

這些命令只回傳你連到的那個節點的資料。要掃全叢集必須遍歷所有主節點：

```bash
# 對每個主節點分別執行
redis-cli -a coursepass --cluster call 172.31.0.11:6379 DBSIZE
```

### 限制 7：`FLUSHALL`、`randomkey` 等的語意變化

大部分管理命令都變成「只作用於當前節點」。寫維運腳本時要特別注意。

---

## 11.13 怎麼選

```text
資料量與 QPS 在單機能力內（多數情況）
  ├─ 能接受幾分鐘的人工恢復    -> 單機 + 完整備份（第 06 章）
  ├─ 需要自動故障轉移          -> 主從 + Sentinel  ✅ 最常見的生產架構
  └─ 讀取壓力大                -> 主從 + Sentinel + 讀寫分離

單機扛不住了
  ├─ 只是讀不夠                -> 加從節點，不要上 Cluster
  ├─ 記憶體不夠                -> 先做記憶體優化（第 05 章），真的不夠再 Cluster
  └─ 寫入不夠 / 資料量太大     -> Cluster

用雲端託管
  -> 直接用廠商的高可用方案，把這章當成「理解它在做什麼」
```

**兩個實務建議：**

**先垂直擴展。** 把記憶體從 16GB 加到 64GB，比上 Cluster 簡單一百倍。Redis 單實例跑到 100GB+ 是可行的（要注意 fork 時間，見第 06 章）。

**在一台機器上跑多個實例。** 這是「想用滿多核心但不想上 Cluster」的標準做法，也是官方建議。每個實例獨立、互不影響慢命令，應用層自己分片即可。

---

## 11.14 常見錯誤

### 錯誤 1：`repl-backlog-size` 用預設的 1MB

寫入量稍大時，短暫斷線就會觸發全量同步，主節點被反覆 fork 拖垮。依「每秒寫入量 × 可容忍斷線秒數」設定。

### 錯誤 2：以為主從複製是備份

複製是即時同步，誤刪會立刻傳到所有從節點。備份要用 RDB/AOF 並存到別的地方（第 06 章）。

### 錯誤 3：關掉 `replica-read-only` 並往從節點寫入

那些寫入不會同步回主節點，且下次全量同步時會被清空。資料會安靜消失。

### 錯誤 4：只部署 2 個 Sentinel

無法形成多數決，其中一個掛掉就無法執行故障轉移。至少 3 個，且為奇數。

### 錯誤 5：三個 Sentinel 共用同一個設定檔

Sentinel 會改寫自己的設定檔記錄狀態。共用會互相覆蓋，導致行為異常。

### 錯誤 6：把 Sentinel 和 Redis 部署在同一台機器

那台機器掛掉會同時失去一個 Redis 節點和一個 Sentinel。Sentinel 應該獨立部署，或至少分散在不同故障域。

### 錯誤 7：客戶端寫死主節點 IP

故障轉移後客戶端連的還是舊主（已降級為從節點），所有寫入都會失敗。必須透過 Sentinel 取得位址。

### 錯誤 8：以為 Sentinel 保證不丟資料

非同步複製決定了故障轉移必然有 RPO。要量化它，不要假設它是 0。

### 錯誤 9：`down-after-milliseconds` 設太短

網路抖動就誤觸發故障轉移，造成沒必要的服務中斷與資料遺失。要大於你的網路抖動時間。

### 錯誤 10：故障轉移後沒有處理舊主的資料

舊主恢復後會清空並全量同步新主。如果它在分區期間收過寫入，那些資料就沒了——**要在轉移前確認業務層有補償機制**。

### 錯誤 11：過早上 Cluster

為了「以後好擴展」在流量還很小時就上 Cluster，付出所有命令限制的代價卻沒有得到好處。單機能扛就單機。

### 錯誤 12：hash tag 用得太粗

用 `{tenant}` 之類的粗粒度 tag，會讓大租戶的資料全擠在一個節點上，造成嚴重傾斜。tag 要盡量細。

### 錯誤 13：Cluster 下用 Lua 但沒把 key 宣告在 `KEYS`

Cluster 會檢查腳本存取的 key 是否屬於當前節點，寫死的 key 名稱會直接報錯。

### 錯誤 14：縮容時先 `del-node` 再搬 slot

那些 slot 會變成無人負責，叢集進入 fail 狀態。必須先 reshard 再移除。

### 錯誤 15：Cluster 只用 2 個主節點

主節點的故障判定需要多數決，2 個主節點掛掉一個就無法形成多數，故障轉移做不了。至少 3 個主節點。

---

## 11.15 本章練習

### 練習 1：實測故障轉移的 RPO 與 RTO

用 11.7 節的環境，量出你這套設定下的實際數字。

<details>
<summary>參考解答</summary>

**第 1 步：確認環境正常**

```bash
docker compose -f docker-compose-replication.yml up -d
sleep 10
docker exec sentinel-1 redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster
```

**第 2 步：啟動一個帶序號的持續寫入**

用一個腳本持續寫入遞增序號，並把「客戶端認為成功寫入的最後一個序號」記到本地檔案：

```bash
cat > /tmp/writer.sh <<'EOF'
#!/bin/sh
i=0
while true; do
  RESULT=$(redis-cli -h 172.30.0.10 -p 6379 -a coursepass --no-auth-warning SET seq $i 2>/dev/null)
  if [ "$RESULT" = "OK" ]; then
    echo $i > /tmp/last_acked.txt      # 客戶端收到成功回應的最後一筆
  fi
  i=$((i+1))
done
EOF
chmod +x /tmp/writer.sh

docker cp /tmp/writer.sh redis-master:/tmp/writer.sh 2>/dev/null || true
# 在一個能連到叢集網路的容器裡跑
docker exec -d redis-replica-2 sh -c 'chmod +x /tmp/writer.sh 2>/dev/null; sh /tmp/writer.sh'
```

（實務上更方便的做法是用 `redis-benchmark` 或一支簡單的程式；這裡用 shell 是為了不依賴額外工具。）

**第 3 步：記錄時間並殺掉主節點**

```bash
echo "T0 (kill master): $(date +%s%3N)"
docker stop redis-master
```

**第 4 步：偵測新主可寫的時間（RTO）**

```bash
while true; do
  ADDR=$(docker exec sentinel-1 redis-cli -p 26379 \
    SENTINEL get-master-addr-by-name mymaster 2>/dev/null | head -1)
  if [ "$ADDR" != "172.30.0.10" ] && [ -n "$ADDR" ]; then
    echo "T1 (new master ready): $(date +%s%3N), addr=$ADDR"
    break
  fi
  sleep 0.2
done
```

`T1 - T0` 就是 **RTO**。用 `down-after-milliseconds 5000` 的話，典型值是 6～12 秒。

**第 5 步：比對序號（RPO）**

```bash
# 客戶端認為成功寫入的最後一筆
docker exec redis-replica-2 cat /tmp/last_acked.txt

# 新主上實際有的最後一筆
docker exec redis-replica-1 redis-cli -a coursepass GET seq
```

兩者的差就是**遺失的寫入筆數**，這是 RPO 的直接量測。

典型結果：在本機 Docker 環境、低寫入量下，差距可能只有 0～3 筆；但如果你先用 `redis-benchmark` 把寫入量拉高再殺，差距會明顯放大。

**第 6 步：加壓再測一次**

```bash
docker compose -f docker-compose-replication.yml restart
sleep 10

# 高速寫入
docker exec -d redis-master redis-benchmark -a coursepass -t set -n 10000000 -P 50

sleep 5
docker stop redis-master
# 重複第 4、5 步
```

你會看到**寫入量越大，RPO 越差**。這直接證明了 11.8 節的結論：RPO 等於複製延遲，而複製延遲隨寫入量增加。

**第 7 步：開啟 `min-replicas-to-write` 再測**

```bash
docker compose -f docker-compose-replication.yml up -d
sleep 10
docker exec redis-master redis-cli -a coursepass CONFIG SET min-replicas-to-write 1
docker exec redis-master redis-cli -a coursepass CONFIG SET min-replicas-max-lag 10

# 把兩個從節點都停掉，觀察主節點的行為
docker stop redis-replica-1 redis-replica-2
sleep 12
docker exec redis-master redis-cli -a coursepass SET test 1
# (error) NOREPLICAS Not enough good replicas to write.
```

**這就是用可用性換一致性的具體樣子**：從節點都不健康時，主節點寧可拒絕寫入，也不接受「一旦掛掉就會遺失」的資料。

**該記錄下來的數字**

```text
RTO（實測）：______ 秒
RPO（低負載）：______ 筆
RPO（高負載）：______ 筆
down-after-milliseconds：5000
min-replicas-to-write：未開啟 / 開啟
```

把這張表放進維運文件，每次改參數後重測。

**清理**

```bash
docker compose -f docker-compose-replication.yml down -v
```

</details>

### 練習 2：在 Cluster 上修好一段會壞掉的程式碼

以下程式碼在單機 Redis 上運作正常，搬到 Cluster 後全部壞掉。請找出每一個問題並修正。

```javascript
// 1. 批次取得使用者資料
async function getUsers(ids) {
  const keys = ids.map(id => `user:${id}`);
  return await redis.mget(...keys);
}

// 2. 把使用者加入某個群組，並更新計數
async function joinGroup(userId, groupId) {
  const multi = redis.multi();
  multi.sadd(`group:${groupId}:members`, userId);
  multi.sadd(`user:${userId}:groups`, groupId);
  multi.incr(`group:${groupId}:count`);
  return await multi.exec();
}

// 3. 限流（第 10 章的滑動窗口計數）
async function checkRate(userId) {
  const bucket = Math.floor(Date.now() / 1000 / 60);
  return await redis.eval(SLIDING_COUNTER, 2,
    `rate:${userId}:${bucket - 1}`,
    `rate:${userId}:${bucket}`,
    '100', '0.5', '60');
}

// 4. 清理某個租戶的所有快取
async function clearTenantCache(tenantId) {
  const keys = await redis.keys(`cache:${tenantId}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

// 5. 用 database 1 存測試資料
async function setupTestData() {
  await redis.select(1);
  await redis.flushdb();
}
```

<details>
<summary>參考解答</summary>

**問題 1：`MGET` 跨 slot**

不同 userId 的 key 會落在不同 slot，直接 `MGET` 會收到 `CROSSSLOT`。

```javascript
// 修正：用 pipeline，讓客戶端自動按節點分組
async function getUsers(ids) {
  const pipe = redis.pipeline();
  for (const id of ids) {
    pipe.get(`user:${id}`);
  }
  const results = await pipe.exec();
  return results.map(([err, value]) => {
    if (err) throw err;
    return value;
  });
}
```

多數 Cluster 客戶端（ioredis 的 `Cluster` 模式）會自動把 pipeline 裡的命令按目標節點分組，並行送出。效能和 `MGET` 差距不大。

**問題 2：交易跨 slot**

三個 key（`group:X:members`、`user:Y:groups`、`group:X:count`）分屬不同 slot，`MULTI` 無法執行。

這題比較麻煩，因為**它本質上就是一個跨實體的操作**——群組和使用者是兩個不同的維度，不可能同時和對方在同一 slot。

```javascript
// 修正：拆成兩部分，把「同一群組的資料」綁在同一 slot
async function joinGroup(userId, groupId) {
  // 群組維度的資料用 hash tag 綁在一起，可以用交易保證一致
  const multi = redis.multi();
  multi.sadd(`{group:${groupId}}:members`, userId);
  multi.incr(`{group:${groupId}}:count`);
  await multi.exec();

  // 使用者維度的資料是另一個 slot，單獨執行
  await redis.sadd(`{user:${userId}}:groups`, groupId);
}
```

**但這樣就失去了三者的原子性**——第一個交易成功、第二個操作失敗時，資料會不一致。三種處理方式：

```javascript
// 方式 A：讓它最終一致，用補償任務修正（推薦）
async function joinGroup(userId, groupId) {
  const multi = redis.multi();
  multi.sadd(`{group:${groupId}}:members`, userId);
  multi.incr(`{group:${groupId}}:count`);
  await multi.exec();

  try {
    await redis.sadd(`{user:${userId}}:groups`, groupId);
  } catch (err) {
    // 記錄下來由補償任務重試
    await mq.send('group-join-repair', { userId, groupId });
    throw err;
  }
}

// 方式 B：去掉冗餘資料。user:X:groups 其實可以從 group:*:members 反查，
//         但那需要掃全部群組 —— 只有群組數量很少時可行。

// 方式 C：計數不要單獨存，改用 SCARD 即時算
//         這樣就只剩兩個 key，且 members 和 count 天然一致
async function joinGroup(userId, groupId) {
  await redis.sadd(`{group:${groupId}}:members`, userId);
  await redis.sadd(`{user:${userId}}:groups`, groupId);
}
async function getGroupCount(groupId) {
  return await redis.scard(`{group:${groupId}}:members`);
}
```

**方式 C 最乾淨**——它消除了「計數」這個冗餘資料，也就消除了不一致的可能。`SCARD` 是 O(1)，沒有效能問題。這題最重要的體會是：**Cluster 的限制常常會逼你看見設計上本來就存在的冗餘。**

**問題 3：Lua 的兩個 key 跨 slot**

```javascript
// 修正：用 hash tag 綁定
async function checkRate(userId) {
  const bucket = Math.floor(Date.now() / 1000 / 60);
  return await redis.eval(SLIDING_COUNTER, 2,
    `rate:{${userId}}:${bucket - 1}`,
    `rate:{${userId}}:${bucket}`,
    '100', '0.5', '60');
}
```

這裡用 `{userId}` 當 tag 是安全的——限流本來就是按使用者分開的，不會造成傾斜。

**問題 4：`KEYS` 只掃單一節點**

在 Cluster 上，`redis.keys()` 只回傳你連到的那個節點的 key，其他節點的 key 完全掃不到。而且 `KEYS` 本身就是危險命令（第 01、04 章）。

```javascript
// 修正：用 Set 主動維護索引，不要靠掃描
async function cacheWithIndex(tenantId, key, value, ttl) {
  await redis.set(`cache:{${tenantId}}:${key}`, value, 'EX', ttl);
  await redis.sadd(`cache:{${tenantId}}:index`, key);
}

async function clearTenantCache(tenantId) {
  const indexKey = `cache:{${tenantId}}:index`;
  const keys = await redis.smembers(indexKey);

  if (keys.length > 0) {
    // 因為用了 hash tag，這些 key 都在同一 slot，可以一次刪
    const pipe = redis.pipeline();
    for (const k of keys) {
      pipe.unlink(`cache:{${tenantId}}:${k}`);
    }
    pipe.del(indexKey);
    await pipe.exec();
  }
}
```

注意這裡用 hash tag 有代價（單一租戶的快取全在一個節點）。如果租戶很大，另一個做法是不用 tag，改成遍歷所有主節點做 `SCAN`：

```javascript
async function clearTenantCacheByScanning(tenantId) {
  const nodes = redis.nodes('master');   // ioredis Cluster 的 API
  await Promise.all(nodes.map(async (node) => {
    let cursor = '0';
    do {
      const [next, keys] = await node.scan(
        cursor, 'MATCH', `cache:${tenantId}:*`, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await node.unlink(...keys);
    } while (cursor !== '0');
  }));
}
```

**問題 5：Cluster 不支援 `SELECT`**

```javascript
// 修正：用 key 前綴取代 database 隔離
const PREFIX = process.env.NODE_ENV === 'test' ? 'test:' : '';

function k(key) {
  return PREFIX + key;
}

async function setupTestData() {
  // 也不能用 FLUSHDB（只清當前節點），要按前綴清
  const nodes = redis.nodes('master');
  await Promise.all(nodes.map(async (node) => {
    let cursor = '0';
    do {
      const [next, keys] = await node.scan(cursor, 'MATCH', 'test:*', 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await node.unlink(...keys);
    } while (cursor !== '0');
  }));
}
```

**總結：Cluster 遷移的檢查清單**

```text
[ ] 所有多 key 命令（MGET/MSET/SINTER/ZUNIONSTORE...）
[ ] 所有 MULTI/EXEC
[ ] 所有 Lua 腳本的 KEYS 是否同 slot
[ ] 所有 KEYS / SCAN / DBSIZE / FLUSHDB
[ ] 所有 SELECT
[ ] 所有 Pub/Sub（考慮改用 SPUBLISH）
[ ] hash tag 的粒度是否會造成傾斜
```

</details>

### 練習 3：為一個社群平台選架構

某社群平台目前用單機 Redis（32GB，實際用了 24GB），存放：

- 使用者 Session（約 200 萬個，佔 6GB，TTL 30 分鐘）
- 動態時間軸快取（約 500 萬個 List，佔 12GB）
- 熱門話題排行榜（幾十個 ZSET，佔 200MB）
- 限流計數器（佔 500MB）
- 分散式鎖（少量）

現況與需求：

- 尖峰 QPS 8 萬（讀 7 萬 / 寫 1 萬）。
- 目前單機 CPU 尖峰 70%，記憶體用量每月成長 8%。
- 業務要求：Session 遺失會導致大量使用者被登出，希望盡量避免。
- 團隊只有 2 個後端工程師，沒有專職 SRE。

請提出架構方案並說明理由。

<details>
<summary>參考解答</summary>

**先做判斷，不要急著上 Cluster**

現況分析：

```text
記憶體：24GB / 32GB = 75%，每月成長 8%
        -> 約 3～4 個月後會撐不住（24 × 1.08^4 ≈ 32.6GB）

CPU：   尖峰 70%，單執行緒
        -> 還有餘裕，但不多

QPS：   8 萬，其中讀 7 萬
        -> 單機 Redis 的能力大約在 10 萬 QPS（視命令而定），已經接近上限
```

**兩個瓶頸都是真的，但它們需要不同的解法。**

**方案：分階段，不要一次到位**

**階段 1（立刻做）：主從 + Sentinel + 讀寫分離**

這是投報率最高的一步，解決三件事：

- **高可用**：Session 遺失問題的直接解法。目前單機掛掉，200 萬使用者全部被登出。
- **讀擴展**：7 萬讀 QPS 分到 2 個從節點，主節點壓力立刻降到 1/3 左右。
- **維運簡單**：2 人團隊能負擔，客戶端改動小。

```text
Master（32GB）
  ├─ Replica 1（32GB）  <- 讀
  └─ Replica 2（32GB）  <- 讀
Sentinel × 3（小機器即可）
```

讀寫分離的分配（呼應 11.5 節）：

```text
可以走從節點：
  動態時間軸快取（本來就允許延遲）
  熱門話題排行榜（允許延遲）

必須走主節點：
  Session 讀取（登入後立刻要讀到，不能有複製延遲）
  限流計數器（讀了要做決策）
  分散式鎖（第 10 章：從節點的鎖狀態可能是舊的）
```

Session 走主節點會讓主節點仍有相當的讀流量，但比全部走主好得多。

**階段 2（1 個月內）：記憶體優化，把 Cluster 往後推**

先確認 12GB 的時間軸快取真的需要那麼大。可查的方向（第 05 章）：

```bash
# 看內部編碼是否退化成非壓縮結構
redis-cli -a coursepass OBJECT ENCODING timeline:12345
# 如果 List 元素太多變成 quicklist 而非 listpack，考慮縮短每條時間軸的長度

redis-cli -a coursepass CONFIG GET list-max-listpack-size
```

具體措施：

```text
1. 時間軸只保留最近 N 條（LTRIM），舊的回源資料庫
   —— 使用者滑到很下面的機率極低，這通常能省掉一半以上
2. Session 只存必要欄位，把大 payload 移出去
3. 檢查是否有沒設 TTL 的殘留 key（第 01 章）
4. 確認 maxmemory-policy 設對（Session 有 TTL，用 volatile-lru；
   但混用了無 TTL 的資料時要小心，見第 05 章）
```

**這一步常常能買回半年到一年的時間**，而它的成本遠低於上 Cluster。

**階段 3（記憶體優化後仍不夠時）：按業務拆成多個實例**

在上 Cluster 之前，還有一個更適合小團隊的選項——**垂直拆分**：

```text
實例 A（Session）：           主從 + Sentinel，8GB
實例 B（時間軸快取）：         主從 + Sentinel，24GB
實例 C（排行榜 + 限流 + 鎖）： 主從 + Sentinel，4GB
```

好處非常明顯：

- **故障隔離**：時間軸快取的 big key 拖慢實例 B，不會影響 Session 登入。
- **獨立調參**：Session 用 `volatile-lru`，時間軸可以用 `allkeys-lru`，排行榜用 `noeviction`（不能被驅逐）。
- **獨立擴展**：哪個先撐不住就先擴哪個。
- **沒有任何命令限制**：不需要改程式碼，不用擔心 hash tag 和跨 slot。
- **用滿多核心**：三個實例可以跑在同一台機器的不同核心上（第 04 章）。

**對 2 人團隊來說，這比 Cluster 好太多。** 代價只是多幾組連線設定。

**階段 4（真的需要時）：只把最大的那塊上 Cluster**

如果時間軸快取單獨就超過單機能力（例如成長到 60GB+），才把**它一個**上 Cluster：

```text
Session：      主從 + Sentinel（不動）
排行榜/限流：   主從 + Sentinel（不動）
時間軸快取：    Cluster 3 主 3 從
```

時間軸快取是最適合 Cluster 的部分，因為它的存取模式最單純：

- key 是 `timeline:{userId}`，天然按使用者分散，不會傾斜。
- 幾乎都是單 key 操作（`LRANGE`、`LPUSH`、`LTRIM`），沒有跨 slot 問題。
- 是純快取，Cluster 故障轉移丟資料可以接受。

反過來，**排行榜最不適合上 Cluster**——它會用到 `ZUNIONSTORE` 之類的多 key 命令，而且只有幾十個 key，分片沒有意義。

**最終建議**

```text
現在做：      主從 + Sentinel + 讀寫分離（1～2 天）
1 個月內：    記憶體優化（LTRIM + 清理無 TTL 的 key）
3 個月內：    按業務垂直拆成三個實例
1 年後再看：  只有時間軸快取需要時才上 Cluster
```

**這個順序的核心理由：團隊只有 2 個人。** 架構選擇不只看技術指標，也要看誰來維運。Cluster 出問題時的排查難度（slot 分布、重導向、跨節點的一致性）遠高於主從架構，一個沒有專職 SRE 的團隊在半夜遇到 Cluster 故障，處理時間會很長。

**另外要立刻補上的**（和架構選擇同樣重要）：

```text
[ ] 備份：主從不是備份，要有 RDB 定期備份到異地（第 06 章）
[ ] 監控：記憶體使用率、複製延遲、evicted_keys、命中率（第 12 章）
[ ] 告警：記憶體 > 80%、複製中斷、故障轉移事件
[ ] 演練：至少做一次故障轉移演練，量出 RPO/RTO（練習 1）
[ ] Session 的降級方案：Redis 全掛時能不能讓使用者用 JWT 暫時撐著？
```

最後一項值得特別想——**如果 Session 遺失的後果真的很嚴重，那架構上不該讓它只存在 Redis 裡。** 改用「JWT 帶簽章 + Redis 只存黑名單」的設計，Redis 掛掉時使用者不會被登出，只是撤銷功能暫時失效。這是比任何高可用架構都更根本的解法。

</details>

---

## 11.16 驗收清單

進入下一章前，確認你可以：

- [ ] 說明主從複製、Sentinel、Cluster 各自解決什麼問題。
- [ ] 描述 `PSYNC` 的完整流程，並說出全量與部分同步的觸發條件。
- [ ] 說明 replication ID、offset、repl-backlog 三者的作用。
- [ ] 依寫入量計算 `repl-backlog-size`，並用 `sync_full` 驗證是否設得夠。
- [ ] 搭起一主二從，並用 offset 差值觀察複製延遲。
- [ ] 說出讀寫分離的三個陷阱，並列出哪些讀不能走從節點。
- [ ] 說明從節點為什麼不自己刪過期 key，以及這對 `DBSIZE` 的影響。
- [ ] 說明 SDOWN 與 ODOWN 的差別，以及為什麼要兩階段。
- [ ] 說明 quorum 和「leader 選舉需要多數」的區別。
- [ ] 部署 Sentinel 並實際觸發一次故障轉移，看懂 `+switch-master` 事件。
- [ ] 說明為什麼 Sentinel 要 3 個以上且為奇數、為什麼不能共用設定檔。
- [ ] 說明非同步複製為什麼必然造成資料遺失，並用 RPO 表達。
- [ ] 說明腦裂如何發生，以及 `min-replicas-to-write` 能限制什麼。
- [ ] 實測並記錄你這套設定的 RPO 與 RTO。
- [ ] 說明 16384 slot 的分配方式，以及為什麼是這個數字。
- [ ] 區分 `MOVED` 和 `ASK`，並說出客戶端該有的不同行為。
- [ ] 用 hash tag 綁定 key，並說出粒度太粗的後果。
- [ ] 建立三主三從的 Cluster，完成一次擴容 reshard。
- [ ] 列出 Cluster 的七項限制，並知道每一項的替代寫法。
- [ ] 說明為什麼縮容要先 reshard 再 `del-node`。
- [ ] 在單機、主從、垂直拆分、Cluster 之間做出有理由的選擇。

---

下一章處理「線上出事時你怎麼查」：[12-monitoring-and-troubleshooting.md](./12-monitoring-and-troubleshooting.md)，我們會把 `INFO` 的關鍵指標逐項解讀，並建立四個實戰排錯劇本。
