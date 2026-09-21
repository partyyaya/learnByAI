# 第 13 章：高可用在 Java 這一側

> 前面十三章，每一章都建立在同一個假設上：**只有一台 Redis。**
>
> 這一章把那個假設拿掉，然後你會發現前面每一章都有一個東西壞掉。
>
> 先看兩個實測。第一個：**一台 master、兩台 replica、三台 Sentinel**，
> 客戶端用 `SET` 寫入，**每一筆都等 master 回 OK 才算數**。寫到一半 `kill -9` master：
>
> | | 筆數 |
> |---|---|
> | 客戶端收到 `OK` 的筆數 | **15,583** |
> | Sentinel 切換完成後，新 master 上的筆數 | **9,602** |
> | **消失** | ⚠️ **5,981 筆（38.4%）** |
>
> **沒有任何一個錯誤。** 那 5,981 筆的客戶端全都收到了 `OK`。
>
> 第二個：同一次演練，量「客戶端多久才恢復」：
>
> | | 時間 |
> |---|---|
> | Sentinel 完成切換 | 6,463 ms |
> | **Java 客戶端第一次成功** | ⚠️ **9,289 ms** |
> | 落差 | **2,826 ms —— 這一段是 Lettuce 自己的** |
> | 同樣的故障，**沒走 Sentinel（直連 master）** | ❌ **43 秒後仍未恢復** |
>
> 📌 **這一章的主題是這兩個數字之間的東西：**
> **「Redis 做到了什麼」與「你的 Java 程式看到什麼」不是同一件事。**
>
> 然後是 Cluster：**你前面寫的每一段多 key 的 Lua，在 Cluster 上都會直接失敗。**

---

## 13.1 學習目標

完成本章後，你應該可以：

- 說明 Redis 的複製為什麼是**非同步**的，並實測出一次切換會丟掉多少「已經回 OK」的寫入（13.2.3）。
- 說出 `WAIT` 能保證什麼、不能保證什麼，以及它的代價（實測 **380 倍**，13.2.5）。
- 用 `min-replicas-to-write` 把「丟資料」換成「拒絕寫入」，並判斷你的業務要哪一個（13.2.6）。
- ⚠️ 說出讀寫分離會讓你讀到多舊的資料（實測 **100% 陳舊率**），以及哪些資料絕對不能讀 replica（13.3）。
- 畫出 Sentinel 的完整切換時間軸，並指出**那 5 秒是設定出來的，不是選舉花的**（13.4.2、13.4.3）。
- ⚠️ 說出舊 master 重新上線的那幾秒鐘為什麼是個事故（實測 **100 筆寫入靜靜消失**，13.4.5）。
- 設定 Lettuce 的 Sentinel 連線，並把切換後的恢復時間從 **9.3 秒縮到 6.7 秒**（13.5.3、13.5.4）。
- ⚠️ 重現 09 章預告過的那件事：**主從切換時，同一把鎖被兩個人同時持有**（13.5.6）。
- 解釋 Cluster 的 16384 個槽、`MOVED` / `ASK`，以及 Lettuce 是怎麼知道要去哪一台的（13.6）。
- ⚠️ 指出你前面每一章寫的哪些程式在 Cluster 上會直接失敗，並用 hash tag 修好它們（13.7）。
- 設定 Lettuce 的 topology refresh，並說出 ⚠️ **預設值為什麼是個地雷**（13.8）。

---

## 13.2 主從複製：先看它掉了什麼

### 13.2.1 三行指令，一組主從

這一章需要一個多節點環境。**為了讓 macOS / Windows 上的 Docker 也能用**，
我們把所有節點跑在**同一個容器裡**（容器內的 `127.0.0.1` 剛好對應到你主機的 `127.0.0.1`，
省掉一大堆 `announce-ip` 的麻煩）：

```bash
docker run -d --name redis-ha \
  -p 6380:6380 -p 6381:6381 -p 6382:6382 \
  -p 26379:26379 -p 26380:26380 -p 26381:26381 \
  redis:7.2 tail -f /dev/null
```

> 📌 **這裡刻意不用 `docker-compose` 開六個容器。**
> 六個容器的話，容器內的 IP（`172.x.x.x`）跟你主機看到的位址不一樣，
> **Sentinel 會把容器內的位址回給你的 Java 程式，而你的 Java 程式連不到它。**
> 這個坑在 13.5.5 會再談一次——**它是真實環境裡最常見的 Sentinel 設定錯誤。**

然後在容器裡起三台 Redis（一主二從）：

```bash
docker exec redis-ha sh -c '
  redis-server --port 6380 --daemonize yes --dir /lab --logfile /lab/m.log
  redis-server --port 6381 --daemonize yes --dir /lab --logfile /lab/r1.log --replicaof 127.0.0.1 6380
  redis-server --port 6382 --daemonize yes --dir /lab --logfile /lab/r2.log --replicaof 127.0.0.1 6380
'
```

`--replicaof 127.0.0.1 6380` 這一個參數就是全部了。確認一下：

```bash
$ docker exec redis-ha redis-cli -p 6380 info replication
role:master
connected_slaves:2
slave0:ip=127.0.0.1,port=6381,state=online,offset=9947,lag=1
slave1:ip=127.0.0.1,port=6382,state=online,offset=10005,lag=1
master_repl_offset:10040
```

三個欄位值得先記住：

| 欄位 | 意思 | 什麼時候會救你 |
|---|---|---|
| `state=online` | 這台 replica 正在**即時**接收複製流 | 不是 `online` 就代表它在做全量同步，或斷線了 |
| `offset` | 這台 replica **確認收到**到哪個位置 | ⚠️ 跟 `master_repl_offset` 的差，就是「還沒複製過去的量」 |
| `lag` | master 幾秒前收到這台 replica 的 ACK | `lag` 變大 = 這台 replica 有問題 |

⚠️ **`master_repl_offset` 減掉 `slaveN.offset`，就是這一刻主掛掉會丟掉的資料量。**
上面那組是 `10040 - 9947 = 93` bytes。這個數字在正式環境會大得多，
而且**它跟你的告警系統之間，預設沒有任何連線**（13.10 會補上）。

### 13.2.2 replica 是唯讀的

```bash
$ redis-cli -p 6381 set foo bar
(error) READONLY You can't write against a read only replica.

$ redis-cli -p 6381 get foo
"hello"
```

這是 `replica-read-only yes`（預設值）。**永遠不要把它改成 `no`**：
replica 上寫進去的資料**不會**複製回 master，也**不會**複製給其他 replica，
而且下次全量同步時會被整個清掉——你會得到一份只有這台機器看得到、
而且隨時會消失的資料。13.4.5 的實測就是這個東西的完整版本。

### 13.2.3 ⚠️ 實測：15,583 筆 `OK`，切換後只剩 9,602 筆

這是本章最重要的一個實驗。程式很簡單——**一筆一筆同步寫，每筆都等 master 回 OK**：

```java
public class AsyncLoss {
    public static void run(String[] args) throws Exception {
        boolean useWait = args.length > 1 && args[1].equals("wait");
        int vsize = args.length > 2 ? Integer.parseInt(args[2]) : 8;
        String payload = "x".repeat(vsize);

        RedisClient client = RedisClient.create(RedisURI.builder()
                .withHost("127.0.0.1").withPort(6380)
                .withTimeout(Duration.ofMillis(500)).build());
        RedisCommands<String, String> cmd = client.connect().sync();
        cmd.flushall();

        long acked = 0, notReplicated = 0;
        long start = System.nanoTime();
        try {
            while (System.nanoTime() - start < Duration.ofSeconds(30).toNanos()) {
                cmd.set("order:" + acked, payload);     // ← master 回 OK 才算數
                if (useWait) {
                    long n = cmd.waitForReplication(1, 100);   // WAIT 1 100
                    if (n < 1) notReplicated++;
                }
                acked++;
            }
        } catch (Exception e) {
            System.out.println("寫入中斷：" + e.getClass().getSimpleName());
        }
        System.out.println("master 回過 OK 的筆數 = " + acked);
        if (useWait) System.out.println("其中 WAIT 回報「沒複製到」的筆數 = " + notReplicated);
    }
}
```

跑的時候，中途讓兩台 replica 停止處理複製流 1 秒，然後 `kill -9` master：

```bash
# 讓兩台 replica 凍結 1 秒（模擬：GC 停頓 / 正在 fork 做 RDB / 跨機房網路抖動）
P1=$(redis-cli -p 6381 info server|grep process_id|tr -d 'process_id:\r')
P2=$(redis-cli -p 6382 info server|grep process_id|tr -d 'process_id:\r')
kill -STOP $P1; kill -STOP $P2
sleep 1
kill -9 $(redis-cli -p 6380 info server|grep process_id|tr -d 'process_id:\r')
kill -CONT $P1; kill -CONT $P2
```

結果（value 10 KB，跑兩次）：

```
═══ 13.2.3 非同步複製會丟掉多少「已經回 OK」的寫入 ═══
  第一次： master 回過 OK 15,197 筆 → 切換後新 master 9,117 筆   丟 6,080 筆（40.0%）
  第二次： master 回過 OK 15,583 筆 → 切換後新 master 9,602 筆   丟 5,981 筆（38.4%）

  客戶端看到的錯誤：只有最後那一筆 RedisCommandTimeoutException
  前面 15,582 筆全部是 OK
```

⚠️ **請看清楚這件事的形狀：**

```
   你的程式                     master                    replica
      │                           │                          │
      ├── SET order:9602 ───────▶ │                          │
      │                           ├─ 寫進記憶體               │
      │ ◀────── OK ───────────────┤                          │
      │  ← 你的程式繼續往下走       ├─ 「等一下再複製過去」 ⋯⋯▶ │（還沒送到）
      │                           │                          │
      │                          💥 kill -9                  │
      │                                                      │
      │                                            Sentinel 把它升成 master
      │                                                      │
      │                                            ⚠️ 它從來沒聽過 order:9602
```

📌 **「master 回 OK」的意思是「我收到了」，不是「這筆資料安全了」。**
Redis 的複製是**非同步**的：master 把命令寫進自己的記憶體、回你 `OK`，
**然後才**把命令丟進複製緩衝送給 replica。這中間的所有東西，都是主機掛掉時會消失的。

> 📌 **在你自己的機器上跑，數字會很不一樣。**
> 如果不做那個 `kill -STOP`，在 localhost 上你很可能量到 **0 筆遺失**——
> 因為 master 跟 replica 在同一台機器、同一顆 CPU，複製流幾乎是瞬間送達的。
>
> ⚠️ **這正是最危險的地方：這個問題在你的開發環境測不出來。**
> 它在正式環境會出現，因為那裡有跨機房的 3 毫秒、有 replica 正在 `fork`
> 做 RDB 的兩秒（04 章 4.5.3）、有 GC 停頓、有網路重傳。
> `kill -STOP` 只是把那些東西壓縮成一個你看得到的一秒。

### 13.2.4 為什麼不能同步複製

看到這裡的第一個反應通常是：「那就等 replica 收到再回 OK 不就好了？」

**因為那會把 Redis 變成另一個東西。** 算一下：

```
現在（非同步）：    客戶端 ──▶ master ──▶ 回 OK              延遲 = 1 個 RTT
同步複製：          客戶端 ──▶ master ──▶ replica ──▶ ACK ──▶ 回 OK
                                                              延遲 = 2 個 RTT（同機房）
                                                              延遲 = 2 個跨機房 RTT（異地）
```

同機房 RTT 約 0.2 毫秒，跨機房約 2～30 毫秒。**同步複製會讓每一個寫入都慢一個 RTT，
而且任何一台 replica 卡住，整個服務就跟著卡住。**

Redis 的定位是「快」。它選了**非同步**，並且明白地告訴你：
**如果你需要不丟資料，Redis 不是那個東西。**

> 📌 **這句話要記住，因為它決定了後面所有的設計：**
> **任何「丟了會出事」的資料，最終事實不能只存在 Redis 裡。**
> 12 章 12.3.3 講的「Redis 是過濾器，資料庫是帳本」，根因就在這一節。

### 13.2.5 `WAIT`：它能做什麼，不能做什麼

Redis 提供了 `WAIT numreplicas timeout`：**等到至少 N 台 replica 確認收到為止**。

```bash
$ redis-cli -p 6380 set w1 v1
OK
$ redis-cli -p 6380 wait 2 1000        # 等 2 台，最多等 1000 毫秒
(integer) 2                             # ← 兩台都收到了

$ redis-cli -p 6380 wait 3 1000        # 等 3 台，但只有 2 台
(integer) 2                             # ← 逾時後回「實際收到的台數」
                                        #    耗時 1,015 毫秒
```

Lettuce 這一側：

```java
long n = cmd.waitForReplication(1, 100);   // WAIT 1 100
if (n < 1) {
    // ⚠️ 這筆寫入「已經在 master 上發生了」，只是還沒複製出去
}
```

把 13.2.3 那個實驗加上 `WAIT 1 100` 再跑一次：

```
═══ 13.2.5 WAIT 1 100 的效果與代價（value 10 KB，replica 凍結 1 秒）═══
  設定            | 回過 OK | 切換後存活 | 丟失      | 吞吐
  ----------------+---------+------------+-----------+-------------
  沒有 WAIT        |  15,583 |      9,602 | 5,981 筆  | 4,808 筆/秒
  每筆 WAIT 1 100  |      41 |         40 |     1 筆  |    13 筆/秒   ⚠️ 慢 380 倍
                                              ↑
                              其中 16 筆 WAIT 回報「沒複製到」
```

⚠️ **兩個結論，兩個都很重要：**

**① `WAIT` 的代價在 replica 出事的時候最大。** 平常 replica 正常時，`WAIT 1 100`
只多花一個 RTT（微秒等級）；但 replica 一卡住，**每一筆寫入都要等滿 100 毫秒逾時**——
於是吞吐從 4,808 筆/秒掉到 13 筆/秒。**你的服務在 replica 出問題時會直接停擺。**

**② `WAIT` 回 0 的時候，那筆寫入已經發生了。** 它**不會**回滾：

```java
cmd.set("order:1", data);            // ← 這一行已經在 master 上生效了
long n = cmd.waitForReplication(1, 100);
if (n < 1) {
    // ⚠️ 你現在能做的只有三件事，沒有一件是「取消剛才那筆寫入」：
    //   (a) 回報使用者「處理中，結果未定」
    //   (b) 記一筆待對帳（12.5.5）
    //   (c) 假裝沒事（大部分人實際做的）
}
```

📌 **所以 `WAIT` 的正確用途是「知情」，不是「保證」。**
它讓你在關鍵路徑上**知道**這一筆有沒有安全落地，而不是讓資料變得安全。

**什麼時候值得用：**

| 場景 | 建議 |
|---|---|
| 一般快取寫入 | ❌ 不要用。丟了重新查資料庫就好 |
| 限流計數（10 章） | ❌ 不要用。丟了頂多多放行幾個請求 |
| 冪等鍵（10 章 10.8） | ⚠️ **考慮**。丟了會變成重複扣款——但更好的解法是把冪等鍵放進資料庫 |
| 分散式鎖（09 章） | ❌ 沒有用。13.5.6 會證明為什麼 |
| 庫存預扣（12 章） | ❌ 不需要。因為 12.2.6 那條 SQL 才是帳本 |

### 13.2.6 `min-replicas-to-write`：用「拒絕寫入」換「不丟資料」

`WAIT` 是**每一筆**做判斷。另一個做法是在 master 上設一道門檻：

```bash
$ redis-cli -p 6380 config get min-replicas-to-write
1) "min-replicas-to-write"
2) "0"                      # ← ⚠️ 預設是 0：一台 replica 都沒有也照樣寫

$ redis-cli -p 6380 config get min-replicas-max-lag
1) "min-replicas-max-lag"
2) "10"                     # 「健康的 replica」= 最近 10 秒內有 ACK 的
```

把它設成 1，然後把兩台 replica 都關掉：

```bash
$ redis-cli -p 6380 config set min-replicas-to-write 1
OK
$ redis-cli -p 6381 shutdown nosave
$ redis-cli -p 6382 shutdown nosave
# 等 10 秒（min-replicas-max-lag）

$ redis-cli -p 6380 set k v
(error) NOREPLICAS Not enough good replicas to write.     # ⚠️

$ redis-cli -p 6380 get foo
"hello"                                                    # ← 讀還是可以
```

⚠️ **`NOREPLICAS` 在 Java 這一側是 `RedisCommandExecutionException`**，
訊息開頭是 `NOREPLICAS`。你的程式**必須**認得它：

```java
try {
    redis.opsForValue().set(key, value);
} catch (RedisSystemException | InvalidDataAccessApiUsageException e) {
    if (String.valueOf(e.getMessage()).contains("NOREPLICAS")) {
        // Redis 現在沒有健康的 replica，它拒絕寫入以免資料只有一份
        // ⚠️ 這不是「Redis 掛了」，快取讀取仍然正常（08 章的降級邏輯要分得出來）
    }
}
```

**這個設定的本質是一個取捨：**

| | `min-replicas-to-write 0`（預設） | `min-replicas-to-write 1` |
|---|---|---|
| replica 全掛時 | ✅ 照常服務 | ❌ **所有寫入回錯誤** |
| 那段時間的寫入 | ⚠️ 只有一份，master 掛了就沒了 | ✅ 不會有「只有一份」的資料 |
| 適合 | 快取（丟了重算） | Session、冪等鍵、佇列 |

📌 **它跟 08 章的降級是同一件事的兩端。**
08 章談的是「Redis 掛了，你的服務怎麼活下去」；
這裡談的是「Redis 還活著，但它自己知道自己不可靠了，要不要繼續收」。

⚠️ **設了它，就一定要在 08 章那個 `CacheErrorHandler` 裡處理 `NOREPLICAS`**，
否則 replica 一掛，你的寫入全部變成 500——**明明 Redis 好好的**。

### 13.2.7 ⚠️ replica 上的過期 key：一個很容易誤判的行為

01 章 1.6.1 講過過期的兩套機制（惰性刪除 + 定期抽樣）。在主從架構下，
**replica 不會自己刪除任何 key**——它等 master 把 `DEL` 複製過來。

```bash
$ redis-cli -p 6380 set ek v px 300      # 0.3 秒後過期
OK
# 等 0.6 秒

$ redis-cli -p 6381 exists ek            # replica 上
(integer) 0                              # ← 讀得到「它不存在」
$ redis-cli -p 6381 get ek
(nil)                                    # ← 也讀不出值
$ redis-cli -p 6381 dbsize
(integer) 7                              # ⚠️ 但它還算在 dbsize 裡！
```

**replica 的讀取路徑會自己判斷「這個 key 邏輯上過期了」而回 nil**，
但**不會真的把它刪掉**（刪掉是 master 的權力）。於是：

| 你看到的 | 真相 |
|---|---|
| `GET` / `EXISTS` 回 nil / 0 | ✅ 正確，跟 master 一致 |
| ⚠️ `DBSIZE` 比 master 大 | key 還佔著記憶體，等 master 的 `DEL` |
| ⚠️ `INFO keyspace` 的數量 | 同上 |
| ⚠️ `SCAN` / `KEYS` 掃出已過期的 key | **會掃到**，然後你 `GET` 它得到 nil |
| ⚠️ `MEMORY USAGE` / `used_memory` | replica 的記憶體會比 master 高 |

📌 **實務上這造成兩種誤判：**

**① 監控報警「主從資料筆數不一致」。** 不是不一致，是過期 key 還沒被清。
比對主從要看 `master_repl_offset`，**不是 `DBSIZE`**。

**② 你寫的巡檢程式 `SCAN` 到一個 key，然後 `GET` 回 nil，程式 NPE。**

```java
// ⚠️ 這段在 replica 上會 NPE（在 master 上也會，但機率低得多）
for (String key : scan("session:*")) {
    String v = redis.opsForValue().get(key);
    process(v.length());                 // 💥 v 可能是 null
}
```

### 13.2.8 全量同步與部分重同步

replica 連上 master 時有兩條路：

```
replica 連上來，送 PSYNC <replid> <offset>
   │
   ├─ master 認得這個 replid，而且 offset 還在 backlog 裡
   │     → ✅ 部分重同步（Partial resync）：只補送缺的那一段
   │
   └─ 認不得，或 offset 已經被 backlog 擠掉了
         → ⚠️ 全量同步（Full resync）：
              ① master fork 出子行程做 RDB          ← 04 章 4.5.3 的延遲尖峰
              ② 把整份 RDB 傳給 replica（幾 GB 的網路流量）
              ③ 期間的新命令堆在 client-output-buffer 裡
              ④ replica 清空自己的資料，載入 RDB
```

用 `INFO stats` 看這兩個數字：

```bash
$ redis-cli -p 6380 info stats | grep sync
sync_full:2              # ⚠️ 發生過 2 次全量同步
sync_partial_ok:0        # 部分重同步成功
sync_partial_err:0       # ⚠️ 想做部分重同步但失敗了 → 退化成全量
```

⚠️ **`sync_full` 持續增加是一個必須查的訊號。** 常見原因：

| 原因 | 症狀 | 處理 |
|---|---|---|
| `repl-backlog-size` 太小（預設 **1 MB**） | 網路抖一下就 `sync_partial_err` + `sync_full` | 調大到 64～256 MB |
| `client-output-buffer-limit replica` 被打爆 | replica 反覆斷線重連，`sync_full` 一直漲 | 預設 `256mb 64mb 60`，寫入量大時要調 |
| replica 重啟 | 每次重啟一次 `sync_full` | ⚠️ 見下方 |

📌 **`repl-backlog-size` 的預設 1 MB 是這一節最值得改的一個值。**
以 5 MB/秒的寫入量算，1 MB 的 backlog 只能容忍 **0.2 秒**的斷線。
超過就是全量同步——**而全量同步會讓 master `fork`，那就是 04 章那個延遲尖峰。**

```bash
# 一個比較合理的起點（依你的寫入速率調）
redis-cli -p 6380 config set repl-backlog-size 67108864     # 64 MB
redis-cli -p 6380 config set repl-backlog-ttl 3600
```

> 📌 **Redis 4.0 起有「重啟後仍可部分重同步」的機制**（replid 與 offset 存進 RDB），
> 但它只在**乾淨關閉**（`SHUTDOWN`）時有效。`kill -9` 或 OOM killer 之後，
> **一定是全量同步。** 這就是為什麼「重啟一台 replica」在大 instance 上是一件要排期的事。

---

## 13.3 讀寫分離：省下來的與換來的

### 13.3.1 ⚠️ 實測：一次斷線，100% 的讀都是舊的

有了 replica，很自然會想「讀的流量分過去吧」。先看代價。

實驗：斷開複製鏈路（`CLIENT KILL TYPE replica`，模擬一次網路抖動 / replica 正在 fork），
然後在 master 上寫 500 次、每次寫完立刻讀，統計**讀到舊值**的比例：

```java
for (Mode m : new Mode[]{
        new Mode("MASTER",             ReadFrom.MASTER),
        new Mode("REPLICA_PREFERRED",  ReadFrom.REPLICA_PREFERRED),
        new Mode("ANY",                ReadFrom.ANY)}) {

    StatefulRedisMasterReplicaConnection<String, String> conn =
            MasterReplica.connect(client, StringCodec.UTF8, uri);   // uri 是 Sentinel URI
    conn.setReadFrom(m.rf());
    RedisCommands<String, String> cmd = conn.sync();

    cmd.set("cnt", "OLD");
    Sh.sleep(300);
    Sh.inHa("redis-cli -p 6380 client kill type replica");   // ← 斷開複製鏈路

    int stale = 0, n = 500;
    for (int i = 0; i < n; i++) {
        cmd.set("cnt", "NEW-" + i);                          // 寫 master
        if (!("NEW-" + i).equals(cmd.get("cnt"))) stale++;   // 立刻讀
    }
    System.out.printf("ReadFrom.%-18s %3d / %d 次讀到舊值（%.1f%%）%n",
            m.name(), stale, n, 100.0 * stale / n);
}
```

```
═══ 13.3.1 複製鏈路斷開的那一瞬間，讀到的是什麼 ═══
  ReadFrom.MASTER               0 / 500 次讀到舊值（  0.0%）
  ReadFrom.REPLICA_PREFERRED  500 / 500 次讀到舊值（100.0%）  ⚠️
  ReadFrom.ANY                324 / 500 次讀到舊值（ 64.8%）  ⚠️
```

📌 **`ANY` 的 64.8% 不是巧合：三個節點（1 主 2 從）隨機挑，2/3 ≈ 66.7%。**

⚠️ **注意「複製鏈路斷開」有多平常。** 這個實驗用 `CLIENT KILL` 製造它，
但在正式環境每天都會自然發生：replica 在做 RDB、網路抖一下、
replica 那台機器的 CPU 被別人吃滿。**每一次都是一段「讀得到舊值」的窗口。**

而在**沒有**任何異常的情況下（同一台機器、localhost），
同樣的實驗跑 2,000 次，三種模式都是 **0% 陳舊**——
**這就是為什麼讀寫分離在開發環境測不出問題。**

### 13.3.2 Lettuce 的 `ReadFrom` 與 Spring 的設法

| `ReadFrom` | 讀去哪 | 適合 |
|---|---|---|
| `MASTER` | 只讀 master | **預設，而且大多數情況這就是對的** |
| `MASTER_PREFERRED` | 優先 master，master 不可用時讀 replica | ⚠️ master 掛掉時讀到舊資料，但至少能讀 |
| `REPLICA` | 只讀 replica | replica 全掛就讀不到了 |
| `REPLICA_PREFERRED` | 優先 replica | 報表、離線分析 |
| `ANY` | 隨機 | ⚠️ 幾乎沒有正確的用途 |
| `ANY_REPLICA` | 隨機挑一台 replica | 同 `REPLICA` |
| `LOWEST_LATENCY` | 延遲最低的節點 | 跨機房時「就近讀」 |

Spring Boot 這一側**沒有** yml 設定鍵，只能用 customizer：

```java
@Bean
LettuceClientConfigurationBuilderCustomizer readFromCustomizer() {
    return builder -> builder.readFrom(ReadFrom.MASTER);   // ← 明著寫出來
}
```

📌 **就算你要的是預設值，也建議明著寫一次。**
理由跟 06 章 6.7.3 的 `pool.enabled` 一樣：
**「因為是預設所以沒寫」跟「有人改了」在 code review 時長得一模一樣。**

### 13.3.3 哪些資料可以讀 replica

先講結論：**預設全部讀 master，只有被證明可以的才放行。**

```
可以讀 replica（讀到 200 毫秒前的值不會出事）
  ✅ 商品目錄、分類、設定檔這類「本來就有快取 TTL」的資料
  ✅ 排行榜、統計數字（12.7）
  ✅ 熱度計數、瀏覽數（12.6）

⚠️ 絕對不能讀 replica
  ❌ 分散式鎖（09 章）      —— 讀到「鎖不存在」就等於鎖失效
  ❌ 冪等鍵（10 章 10.8）   —— 讀到「還沒做過」就等於做第二次
  ❌ 限流計數（10 章）      —— 讀到舊的計數就等於放行超額請求
  ❌ 庫存預扣（12 章）      —— 讀到舊庫存就等於超賣
  ❌ Session（11 章）       —— 剛登入的人會看到自己沒登入（11.2 那個實測的另一個版本）
  ❌ 任何「寫完立刻讀」的流程
```

⚠️ **請特別注意上面那五個 ❌ 的共同點：它們全部是這一站後半段教的東西。**
09～12 章所有的原子性保證（`SET NX`、`INCR`、Lua）都建立在
「所有人看到的是同一份資料」上——**而 replica 上的那一份不是。**

📌 **結論：讀寫分離解決的是「讀流量太大」這一個問題，
而且它只對「可以容忍舊值」的讀流量有效。**
如果你的瓶頸不是這個，讀寫分離只會替你換來一類極難重現的 bug。

---

## 13.4 Sentinel：自動切換

### 13.4.1 起三台 Sentinel

Sentinel 是**同一個 `redis-server` 執行檔**，加上 `--sentinel` 參數：

```bash
docker exec redis-ha sh -c '
for p in 26379 26380 26381; do
cat > /lab/s$p.conf <<CONF
port $p
dir /lab
sentinel monitor mymaster 127.0.0.1 6380 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 10000
sentinel parallel-syncs mymaster 1
CONF
redis-server /lab/s$p.conf --sentinel --daemonize yes --logfile /lab/s$p.log
done'
```

四個參數，每一個都會直接影響你的服務中斷多久：

| 參數 | 值 | 意思 | ⚠️ |
|---|---|---|---|
| `monitor mymaster <ip> <port> <quorum>` | 2 | 監控哪台、幾票才算「客觀下線」 | **`<ip>` 必須是你的 Java 程式連得到的位址**（13.5.5） |
| `down-after-milliseconds` | 5000 | 幾毫秒沒回應算「主觀下線」 | **這就是你的服務中斷時間的下限**（13.4.3） |
| `failover-timeout` | 10000 | 一次切換最多做多久；也是同一個 master 兩次切換的最小間隔 | 太短會切到一半重來 |
| `parallel-syncs` | 1 | 切換後同時有幾台 replica 去跟新 master 同步 | ⚠️ 設大會讓多台 replica 同時做全量同步，把新 master 打爆 |

只設定三個 key 就夠了：`sentinel` 只需要知道 **master** 的位址，
**replica 與其他 sentinel 它會自己發現**（透過 master 的 `INFO` 與 `__sentinel__:hello` 頻道）。

```bash
$ redis-cli -p 26379 sentinel master mymaster | head -8
name
mymaster
ip
127.0.0.1
port
6380
...
$ redis-cli -p 26379 sentinel replicas mymaster | grep -E '^(name|127)' 
$ redis-cli -p 26379 sentinel get-master-addr-by-name mymaster
1) "127.0.0.1"
2) "6380"                # ← 客戶端問的就是這一個
```

### 13.4.2 一次切換的完整時間軸（實測）

`kill -9` master，然後讀 Sentinel 的日誌：

```
═══ 13.4.2 Sentinel failover 時間軸（down-after-milliseconds = 5000）═══

  11.861  💥 kill -9 master(6380)
  ────────────────────────────────────────────── ⏳ 這 5 秒什麼都沒發生
  16.944  +sdown master mymaster 127.0.0.1 6380          ← 主觀下線（+5.08s）
  17.001  +odown master ... #quorum 2/2                  ← 客觀下線（+5.14s）
  17.001  +new-epoch 1
  17.001  +try-failover master ...
  17.006  +vote-for-leader e0e00de6… 1                   ← 選 Sentinel leader
  17.066  +elected-leader master ...                     ← 選出來了（+5.21s）
  17.066  +failover-state-select-slave
  17.169  +selected-slave slave 127.0.0.1:6382           ← 挑中 6382（+5.31s）
  17.169  +failover-state-send-slaveof-noone             ← 對它送 REPLICAOF NO ONE
  17.241  +failover-state-wait-promotion
  17.382  +promoted-slave slave 127.0.0.1:6382           ← ✅ 新 master 可以寫了（+5.52s）
  17.382  +failover-state-reconf-slaves
  17.462  +slave-reconf-sent slave 127.0.0.1:6381        ← 叫 6381 改跟 6382
  18.425  +slave-reconf-done slave 127.0.0.1:6381
  18.487  +failover-end
  18.487  +switch-master mymaster 127.0.0.1 6380 127.0.0.1 6382   ← 廣播給客戶端（+6.63s）
  23.557  +sdown slave 127.0.0.1:6380 ...                ← 舊 master 被標成「下線的 replica」
```

📌 **把這 6.63 秒拆開來看：**

```
  ├─ 5.08 秒  等 down-after-milliseconds ← ⚠️ 佔 77%，而且是你設出來的
  ├─ 0.44 秒  選舉 + 挑 replica + 升主   ← Sentinel 真正在工作的時間
  └─ 1.11 秒  叫其他 replica 改跟新 master + 收尾
```

⚠️ **切換慢不慢，幾乎完全由 `down-after-milliseconds` 決定。**
Sentinel 的選舉只花了 0.44 秒。

### 13.4.3 那 5 秒該設多少

```
down-after-milliseconds 太短  →  ⚠️ 一次 GC 停頓、一次網路抖動就觸發切換
                                  而每一次切換都是一次資料遺失（13.2.3）+ 一次服務中斷

down-after-milliseconds 太長  →  ⚠️ master 真的掛了，你的服務要中斷這麼久
```

| 設定 | 切換總時間（約） | 誤判機率 |
|---|---|---|
| 1,000 ms | ~2.5 秒 | ⚠️ 高。一次 1 秒的 GC 就會誤判 |
| **5,000 ms** | **~6.6 秒** | **本站用這個** |
| 30,000 ms（**Redis 預設**） | ~31.6 秒 | 低，但 ⚠️ **你的服務要掛半分鐘** |

📌 **選法：`down-after-milliseconds` 要大於你的「最長可容忍的 JVM / Redis 停頓」。**
先去看 04 章 4.5.3 量到的 `latest_fork_usec`，以及你的 GC 日誌裡最長的那一次 STW。
**取那個值的 2～3 倍。**

⚠️ **然後把這個數字寫進你的 SLA。** 「Redis 高可用」不等於「不中斷」——
它等於「中斷 `down-after` + 1.5 秒，而且不用叫人起床」。

### 13.4.4 ⚠️ quorum 不是你以為的那個東西

這是 Sentinel 最常被誤解的一件事。`sentinel monitor mymaster 127.0.0.1 6380 2`
裡面那個 `2` 是 **quorum**。很多人以為它的意思是「有 2 票就能切換」。**不是。**

```
quorum   = 要幾台 Sentinel 同意，才把 master 標成「客觀下線（odown）」
majority = 要幾票，才能選出「執行切換的那一台 Sentinel（leader）」
           ⚠️ 這個值是「已知 Sentinel 總數的過半」，不是 quorum，而且你改不了
```

實測。三台 Sentinel、quorum = 2，**把其中兩台關掉**，然後 kill master：

```
═══ 情境 A：quorum=2，只剩 1 台 Sentinel ═══
  06:57:37.317  +sdown master mymaster 127.0.0.1 6380
  06:57:37.317  +sdown sentinel ... 26380

  20 秒後：Sentinel 認為 master 還是 127.0.0.1:6380
          6381 的角色 = role:slave
  ⚠️ 沒有 +odown、沒有 failover。服務永遠不會恢復。
```

那把 quorum 改成 1 呢？

```
═══ 情境 B：quorum=1，仍然只剩 1 台 Sentinel ═══
  06:58:15.103  +sdown master mymaster 127.0.0.1 6380
  06:58:15.103  +odown master mymaster ... #quorum 1/1      ← ✅ 這次宣告成功了
  06:58:15.103  +try-failover master ...                    ← ✅ 開始嘗試切換
  06:58:15.109  +vote-for-leader 939fb2cd… 1                ← 自己投自己（1 票）
  06:58:25.264  ⚠️ -failover-abort-not-elected master ...    ← 10 秒後放棄
  06:58:25.342  Next failover delay: I will not start a failover before 06:58:35

  25 秒後：Sentinel 認為 master 還是 127.0.0.1:6380
```

📌 **看懂 `-failover-abort-not-elected` 這一行，就懂了 Sentinel 的設計：**
它**宣告**了客觀下線（quorum 1/1 達成），也**嘗試**了切換，
但拿不到「已知 3 台 Sentinel 的過半（2 票）」，所以**放棄**。

⚠️ **所以：**

| 想法 | 實際 |
|---|---|
| 「我設 quorum=1，一台 Sentinel 就夠了」 | ❌ 它連自己都說服不了 |
| 「兩台 Sentinel 應該夠了吧」 | ❌ 掛一台就剩 1 票，過不了 2 票的門檻 |
| ✅ **Sentinel 至少要 3 台，而且要放在 3 個故障域** | 掛 1 台還能切換 |
| quorum 該設多少 | 通常 = `N/2 + 1`（3 台設 2）。**設小於它只會讓你更容易誤判，不會讓你更容易切換** |

⚠️ **「3 個故障域」是重點：三台 Sentinel 跟 master 放同一台機器，
等於一台機器掛掉時三票同時消失。**

### 13.4.5 ⚠️ 舊 master 回來的那 20 秒

切換完成了，你把舊 master 修好、重新啟動。這時候發生什麼？

```
═══ 13.4.5 舊 master 重新上線 ═══
  ① 正常狀態：master(6380)=100 筆  6381=100  6382=100
  ② kill -9 master(6380)，Sentinel 切換……
  ③ 新 master = 6381（dbsize=100）
  ④ 舊 master 重啟（AOF 載回來了）：role=role:master     ← ⚠️
     ⚠️ 這個窗口裡它是一台可寫的 master —— 寫 100 筆進去：
        errors: 0, replies: 100                          ← ⚠️ 全部成功
     舊 master dbsize = 200
     新 master 上有 ghost 嗎 → 0
  ⑤ 25 秒後（Sentinel 已經把它變成 replica）：
     6380: role=role:slave  dbsize=100
     ghost:9001 還在嗎（1=在 0=不在）→ 0                  ← ⚠️ 100 筆全部消失
     同步方式：Full resync from master ... Finished with success
```

⚠️ **那 100 筆寫入：客戶端全部收到成功，25 秒後全部消失，沒有任何錯誤。**

這件事的形狀是這樣的：

```
  舊 master 重啟
       │
       ├─ Redis 啟動，從 RDB/AOF 載入資料
       ├─ ⚠️ 它的設定檔裡沒有 replicaof，所以它認為自己是 master
       │
       │   ┌──── 這個窗口有多長？ ────────────────────────┐
       │   │  Sentinel 要先「發現」它回來了（下一次 INFO） │
       │   │  然後才對它送 REPLICAOF <新master>            │
       │   │  實測約 10～25 秒                              │
       │   └───────────────────────────────────────────────┘
       │
       ├─ 這段時間裡，任何連到它的客戶端都在對一台「孤兒 master」讀寫
       │
       └─ Sentinel 接手 → REPLICAOF → ⚠️ Full resync → 本機資料全部清掉
```

**誰會在這個窗口裡連到它？** 比你想的多：

- 用**寫死 IP** 連 Redis 的舊服務（沒走 Sentinel）——13.5.1 那個實驗的反面。
- DNS / VIP 還指著舊位址。
- 連線池裡**還沒被清掉的舊連線**。
- 監控腳本、備份腳本、某個同事的 `redis-cli`。

📌 **正確做法：舊 master 修好之後，不要「啟動它然後等 Sentinel 接手」。**

```bash
# ✅ 用 replicaof 啟動，讓它一上線就是 replica
redis-server --port 6380 --replicaof 127.0.0.1 6381 ...

# ✅ 或在設定檔裡留下 replicaof（Sentinel 切換時會自動改寫設定檔，
#    所以正常流程下這一行已經在裡面了——⚠️ 除非你用的是唯讀的 configmap）
```

⚠️ **最後這一點是 Kubernetes 上最常見的坑**：
Sentinel 需要**改寫** `redis.conf`（寫入 `replicaof`）與 `sentinel.conf`（寫入 `myid`、已知節點），
**把設定檔掛成唯讀的 ConfigMap，Sentinel 會啟動失敗或無法持久化它的決定。**
設定檔必須放在可寫的 volume，ConfigMap 只能當「初始範本」。

---

## 13.5 Java 這一側：切換的那幾秒你看到什麼

Sentinel 在 6.63 秒完成了切換。**但那是 Redis 那一側的事。**
這一節量你的 Java 程式——它才是使用者看到的東西。

### 13.5.1 ⚠️ 實測：直連 master —— 43 秒後仍未恢復

實驗程式：每 50 毫秒送一個 `INCR`，記錄每一種錯誤出現的時刻：

```java
public class FailoverClient {
    public static void run(String[] args) throws Exception {
        String mode = args.length > 1 ? args[1] : "sentinel";
        RedisURI uri = mode.equals("direct")
                ? RedisURI.builder().withHost("127.0.0.1").withPort(6380)
                        .withTimeout(Duration.ofMillis(500)).build()
                : RedisURI.Builder.sentinel("127.0.0.1", 26379, "mymaster")
                        .withSentinel("127.0.0.1", 26380).withSentinel("127.0.0.1", 26381)
                        .withTimeout(Duration.ofMillis(500)).build();
        RedisCommands<String, String> cmd = RedisClient.create(uri).connect().sync();
        // …每 50 ms 一次 cmd.incr("hb")，記錄成功 / 各種例外
    }
}
```

先看**直連 master**（也就是 06 章 6.9.1 那份設定，`host: localhost / port: 6380`）：

```
═══ 13.5.1 直連 master：kill -9 之後 ═══
  [ 2008 ms] >>> kill -9 master(6380)
  [ 2160 ms] ❌ RedisException / SocketException: java.net.SocketException: Connection reset
  ……
  成功 39 次，失敗 799 次
  ⏱  ⚠️ 直到 45 秒結束都沒有恢復
```

⚠️ **Sentinel 明明在 6.6 秒就把服務切到 6381 了，這個客戶端 43 秒後還在失敗。**
因為它連的是 `6380` 這個**位址**，而不是「mymaster 這個角色」。

📌 **這是「有 Sentinel」跟「用 Sentinel」的差別。**
架 Sentinel 只是讓 Redis 那一側會自動切換；
**客戶端如果不問 Sentinel，切了也沒有用。**

> ⚠️ **一個常見的中間狀態更危險**：有些團隊用 VIP / DNS 指向 master，
> 靠一段腳本在切換時改 DNS。這時客戶端的 JVM **DNS 快取**（`networkaddress.cache.ttl`，
> 某些設定下是**永久**）會讓它繼續連舊位址——症狀跟上面一模一樣，
> 但你會花三個小時去查 Redis 為什麼沒切換。

### 13.5.2 走 Sentinel：9,289 毫秒

同一個程式，換成 Sentinel URI：

```
═══ 13.5.2 走 Sentinel：kill -9 之後 ═══
  [ 2006 ms] >>> kill -9 master(6380)
  [ 2126 ms] ❌ RedisCommandTimeoutException: Command timed out after 500 millisecond(s)
  [ 2682 ms] ❌ RedisException / SocketException: java.net.SocketException: Connection reset
  [ 8463 ms] 🔀 Sentinel 已經把 master 切到 6382
  [11289 ms] ✅ 命令又成功了（前一種錯誤持續 8,607 ms）
  成功 66 次，失敗 162 次
  ⏱  從 kill 到第一次成功：9,289 ms
```

三件事值得拆開：

**① 第一個錯誤是 `RedisCommandTimeoutException`，不是連線錯誤。**
`kill -9` 的那一瞬間，已經送出去的那個命令**永遠不會有回應**，
它會一直等到 `timeout: 500ms` 才放棄。**06 章 6.8.3 沒設逾時的那個版本，這裡會等 60 秒。**

**② 接下來是一連串 `Connection reset`。** 每一個命令都立刻失敗——
Lettuce 的 `disconnectedBehavior` 預設會把命令收下來排隊，
但連線已經明確斷開時就直接拒絕（06 章 6.8.4）。

⚠️ **注意這裡的訊息是 `Connection reset` 而不是 `Connection refused`**，
這是 Docker port forwarding 造成的（`docker-proxy` 還在監聽，後面沒人了）。
**在沒有 Docker 的環境，你會看到 `ConnectException: Connection refused`。**
兩個都要在 catch 裡認得。

**③ 最重要的一個數字：**

```
   Sentinel 完成切換       6,463 ms   （8,463 - 2,000）
   客戶端第一次成功         9,289 ms   （11,289 - 2,000）
   ────────────────────────────────
   ⚠️ 落差                 2,826 ms   ← 這 2.8 秒是 Lettuce 自己的
```

### 13.5.3 ⚠️ 那 2,826 毫秒是誰的：`reconnectDelay`

Lettuce 斷線後由 `ConnectionWatchdog` 負責重連，而它的**預設重連間隔是指數退避**：

```
io.lettuce.core.resource.Delay.exponential()
    lowerBound = 1 ms，upperBound = 30 秒，base = 2

    第 1 次重連：  1 ms 後
    第 2 次：      2 ms 後
    ...
    第 11 次：  1,024 ms 後
    第 12 次：  2,048 ms 後
    第 13 次：  4,096 ms 後       ← ⚠️ 到這裡已經在「每 4 秒才試一次」
    ...
    上限：     30,000 ms 後       ← ⚠️ 最糟情況：新 master 好了，你還要等 30 秒
```

日誌裡看得很清楚（重連嘗試落在第 0.1 秒、第 5.1 秒、第 9.4 秒）：

```
14:43:24.206  ConnectionWatchdog - Reconnecting, last destination was /127.0.0.1:6380
14:43:24.225  Cannot reconnect to [127.0.0.1:6380]: Connection reset
14:43:29.206  ConnectionWatchdog - Reconnecting, last destination was /127.0.0.1:6380   ← 5 秒後才第二次
14:43:29.249  Cannot reconnect to [127.0.0.1:6380]: Connection reset
14:43:33.457  ReconnectionHandler - Reconnected to 127.0.0.1:6382                       ← ✅
```

📌 **注意 `last destination was 6380`：在 Sentinel 通知「新 master 是 6382」之前，
Lettuce 一直在重試舊位址。** 它是在 Sentinel 的 `+switch-master` 事件
（Lettuce 有訂閱）送達之後，才改連新位址的。

**指數退避的設計是對的**（避免把剛恢復的服務打爆），
⚠️ **但它的預設參數是給「單機重啟」調的，不是給「6 秒的 failover」調的。**

### 13.5.4 調完：6,676 毫秒

```java
ClientResources res = ClientResources.builder()
        .reconnectDelay(Delay.constant(Duration.ofMillis(200)))   // 固定 200 ms
        .build();
RedisClient client = RedisClient.create(res, uri);
```

```
═══ 13.5.4 reconnectDelay 調成固定 200 ms ═══
  [ 2002 ms] >>> kill -9 master(6380)
  [ 2121 ms] ❌ RedisCommandTimeoutException: Command timed out after 500 ms
  [ 2675 ms] ❌ RedisException / SocketException: Connection reset
  [ 8496 ms] 🔀 Sentinel 已經把 master 切到 6381
  [ 8676 ms] ✅ 命令又成功了                                    ← 180 ms 之內就跟上了
  ⏱  從 kill 到第一次成功：6,676 ms
```

| 設定 | Sentinel 切換完成 | 客戶端恢復 | **落差** |
|---|---|---|---|
| 預設（指數退避，上限 30 秒） | 6,463 ms | 9,289 ms | **2,826 ms** |
| `Delay.constant(200ms)` | 6,496 ms | **6,676 ms** | **180 ms** |

⚠️ **但不要無腦把它設成 `Delay.constant(10ms)`。** 那樣在 Redis 長時間掛掉時，
你的每一個應用實例都會每秒對它送 100 次連線嘗試——
**Redis 一恢復就被連線風暴打回去**（08 章 8.7 的「恢復才是第二波」）。

📌 **本站的建議：有上界的指數退避。**

```java
@Bean(destroyMethod = "shutdown")
ClientResources lettuceClientResources() {
    return ClientResources.builder()
            // 50 ms 起跳，最多退到 1 秒 —— 既跟得上 failover，也不會打爆恢復中的 Redis
            // ⚠️ 注意參數順序：(lower, upper, TimeUnit, base)，TimeUnit 在第三個
            .reconnectDelay(Delay.exponential(50, 1000, TimeUnit.MILLISECONDS, 2))
            .build();
}
```

> 📌 Spring Boot 會自動用 context 裡的 `ClientResources` bean。
> ⚠️ **記得 `destroyMethod = "shutdown"`**，否則 JVM 關閉時 netty 的執行緒不會停。

### 13.5.5 Spring Boot 的 Sentinel 設定

```yaml
spring:
  data:
    redis:
      sentinel:
        master: mymaster                    # ← 對應 sentinel.conf 裡的名字
        nodes:
          - 127.0.0.1:26379
          - 127.0.0.1:26380
          - 127.0.0.1:26381
        # password: ...                     # Sentinel 自己的密碼（6.2+ 的 sentinel auth-pass）
      # password: ...                       # ⚠️ 這是 Redis 節點的密碼，兩個是分開的
      timeout: 500ms                        # 06 章 6.9.1
      connect-timeout: 2s
      client-name: shop-service
      lettuce:
        pool:
          enabled: true
          max-active: 16
          max-idle: 16
          min-idle: 4
          max-wait: 200ms
```

⚠️ **`host` 與 `port` 要拿掉。** 設了 `sentinel.master` 之後它們完全不生效，
但**它們的預設值還在**，會誤導看設定的人：

```
connectionFactory        = LettuceConnectionFactory
isRedisSentinelAware()   = true
master                   = mymaster
sentinels                = [127.0.0.1:26379, 127.0.0.1:26380, 127.0.0.1:26381]
getHostName()/getPort()  = localhost:6379   ⚠️ 這兩個在 sentinel 模式下是沒有意義的
clientConfiguration.readFrom = Optional.empty     ← 全部讀 master（13.3.2）
shareNativeConnection    = true                   ← 06 章 6.7.2
寫讀測試                  = world
Sentinel 說 master 是      = 127.0.0.1:6380
   replica               = 127.0.0.1:6382
   replica               = 127.0.0.1:6381
```

📌 **除錯時最有用的一段程式**——直接問 Sentinel：

```java
@Autowired LettuceConnectionFactory factory;

public void dumpTopology() throws IOException {
    RedisSentinelConfiguration sc = factory.getSentinelConfiguration();
    try (RedisSentinelConnection sen = factory.getSentinelConnection()) {
        for (RedisServer m : sen.masters())
            log.info("Sentinel 說 master = {}:{}", m.getHost(), m.getPort());
        for (RedisServer r : sen.replicas(sc.getMaster()))
            log.info("           replica = {}:{}", r.getHost(), r.getPort());
    }
}
```

⚠️ **最常見的 Sentinel 設定事故，只有一個：`sentinel monitor` 裡的位址，
是「Sentinel 自己連得到」的，但不是「你的 Java 程式連得到」的。**

```
   sentinel monitor mymaster 172.18.0.3 6379 2
                             ↑
                    容器內部 IP。Sentinel 自己連得到，
                    ⚠️ 但你的 Java 程式（在容器外 / 在別的網段）連不到。

   症狀：Sentinel 看起來一切正常，`SENTINEL get-master-addr-by-name` 也回得出來，
        但 Java 端一直 Connection timed out，而且錯誤訊息裡是一個你沒設定過的 IP。

   解法：Redis 節點加 replica-announce-ip / replica-announce-port，
        Sentinel 加 sentinel announce-ip / announce-port，
        讓它們對外宣告的是「客戶端連得到的位址」。
```

📌 **這就是 13.2.1 為什麼把所有節點放在同一個容器裡：** 容器內的 `127.0.0.1:6380`
剛好等於你主機的 `127.0.0.1:6380`（因為 port 號一樣），
**整個 announce 的問題就不存在了。** 正式環境沒這麼好命，請務必設 announce。

### 13.5.6 ⚠️ 切換時的鎖：09 章那個預告

09 章 9.10.1 說過：

> **Redis 的複製是非同步的。只要「主回 OK」跟「從收到」之間有落差，切換就會丟鎖。
> 這不是 bug，是設計。**

現在你有 13.2.3 的數字了：**15,583 筆已經回 OK 的寫入，切換後只剩 9,602 筆。**

📌 **你的鎖 key 就是那 15,583 個 key 裡的一個。**
沒有任何東西保證它是存活的那 9,602 個，而不是消失的那 5,981 個。

實測（`SET NX PX` 版本的鎖，也就是 09 章 9.4 寫的那個）：

```java
String tokenA = "A-" + System.nanoTime();
String okA = cmd.set(LOCK, tokenA, SetArgs.Builder.nx().px(30000));   // A 拿到鎖
// …… kill -9 master，Sentinel 切換 ……
String tokenB = "B-" + System.nanoTime();
String okB = cmd.set(LOCK, tokenB, SetArgs.Builder.nx().px(30000));   // B 在新 master 上拿鎖
```

```
① 凍結兩台 replica（模擬複製延遲）
② 客戶端 A：SET lock:order:1 A-379818046484291 NX PX 30000 → OK
   A 現在認為自己持有鎖，開始做事……
③ kill -9 master，並解凍 replica
④ 等 Sentinel 切換……
   [  510 ms] RedisCommandTimeoutException: Command timed out after 500 ms
   [ 2592 ms] RedisException: Connection reset
   [ 4662 ms] RedisException: Connection reset
   [ 6740 ms] RedisException: Connection reset
   [ 8818 ms] RedisException: Connection reset
⑤ 客戶端 B：SET lock:order:1 B-379818112706000 NX PX 30000 → OK（切換後第 9,342 ms）
   鎖現在的值 = B-379818112706000

=== 結論 ===
⚠️ A 與 B 同時持有 lock:order:1：A 以為自己有（它沒收到任何錯誤），
   B 拿到的是一把新的鎖。兩個人一起進了同一段臨界區。
```

⚠️ **這個實驗我在同一台機器上跑了六次，只有一次重現。**

**而那正是它最危險的地方。** 在 localhost 上，master 跟 replica 共用同一顆 CPU、
同一塊記憶體，複製流幾乎是瞬間送達——**所以你的壓測永遠測不出這件事。**

真實環境的窗口大得多：跨機房 3～30 毫秒、replica 正在 `fork` 做 RDB 的那兩秒（04 章 4.5.3）、
一次 Full GC、一次網路重傳。**每一次主從切換，都是對這個窗口的一次抽獎。**

📌 **而且它的機率不是均勻分布的**——它跟「切換發生時的寫入速率」正相關。
**主掛掉最常發生在負載最高的時候，而那正是複製落後最多的時候。**

📌 **請把這一節跟 12 章 12.11 那張表合起來看：**

| 這一章拿掉的東西 | 症狀 | 誰會發現 |
|---|---|---|
| 12 章 ④ `UPDATE … WHERE stock > 0` | 超賣 | ⚠️ 出貨時 |
| **13 章：切換時鎖失效** | **超賣、重複扣款、重複發送** | ⚠️ **對帳時，而且你會先怪 09 章的鎖寫錯了** |

**這就是 12 章那句「Redis 的鎖負責減少衝突，資料庫負責保證正確」的最後一塊拼圖：**
**多節點的 Redis 連「鎖還在」都不保證，所以它更不可能負責正確性。**

### 13.5.7 Redisson 有處理這件事（而且預設是開的）

09 章 9.7 用的 Redisson，從 **3.24** 起加了一個叫 `checkLockSyncedSlaves` 的設定，
**預設值是 `true`**。它做的事就是 13.2.5 那個 `WAIT`：

```
RLock.tryLock()
   ├─ 執行加鎖的 Lua（09 章 9.7.2 那一段）
   └─ ⚠️ 然後對 master 送 WAIT，確認鎖已經複製到 replica
         ├─ 有複製到  → 回 true
         └─ 沒複製到  → 丟 IllegalStateException，並把鎖刪掉
```

實測①：**正常環境下，切換後鎖還在**：

```java
Config cfg = new Config();
cfg.useSentinelServers()
   .setMasterName("mymaster")
   .addSentinelAddress("redis://127.0.0.1:26379", "redis://127.0.0.1:26380", "redis://127.0.0.1:26381")
   .setReadMode(ReadMode.MASTER)          // ⚠️ 13.3.3：鎖絕對不能讀 replica
   .setTimeout(500).setRetryAttempts(3).setRetryInterval(200);
cfg.setCheckLockSyncedSlaves(true);       // 預設就是 true，這裡明著寫
```

```
checkLockSyncedSlaves = true（slavesSyncTimeout 預設 1000 ms）
① A tryLock = true
② kill -9 master，等 Sentinel 切換……
[ 1313 ms] StacklessClosedChannelException: null
[ 6611 ms] A.isHeldByCurrentThread()=true  isLocked()=true     ← ✅ 鎖還在新 master 上
[ 7120 ms] A.isHeldByCurrentThread()=true  isLocked()=true
……
```

📌 **順帶一個數字：Redisson 在 6,611 ms 就恢復了，比 Lettuce 的預設設定（9,289 ms）快。**
Redisson 自己管重連與重試（`setRetryAttempts(3).setRetryInterval(200)`），
**沒有用 Lettuce 那套指數退避。**

實測②：**replica 追不上的時候，`tryLock` 直接失敗**：

```
checkLockSyncedSlaves = true
⏸  先凍結兩台 replica（模擬複製延遲）
① A tryLock 丟例外 = IllegalStateException:
     None of slaves were synced.
     Try to increase slavesSyncTimeout setting or set checkLockSyncedSlaves = false.
```

⚠️ **這是 fail-closed：拿不到「確定安全」的鎖，就不給你鎖。** 兩個後果：

| | 後果 |
|---|---|
| ✅ 好處 | 不會出現 13.5.6 那種「兩個人同時持鎖」 |
| ⚠️ 代價 | **replica 出問題時，你的所有加鎖操作全部失敗**——業務直接停擺 |
| ⚠️ 代價 | 每次加鎖多一個 `WAIT`（正常時是微秒級，**但 replica 卡住時是 `slavesSyncTimeout` 那一整秒**） |

**這跟 13.2.6 的 `min-replicas-to-write` 是同一個取捨，只是換了一層。**

```java
// 你必須明確決定這件事，而不是讓它是預設值
cfg.setCheckLockSyncedSlaves(true);   // ✅ 鎖保護的是錢 → 寧可拿不到鎖
cfg.setSlavesSyncTimeout(1000);       //    ⚠️ 這一秒會加在你的 P99 上

cfg.setCheckLockSyncedSlaves(false);  // ⚠️ 鎖只是「減少重複工作」 → 可以接受偶爾失效
                                      //    但你必須有 12 章那條 SQL 兜底
```

📌 **09 章 9.11 的結論在這裡再說一次，而且現在有數字了：**

> **不要用 Redis 的鎖保證正確性。**
> 就算你用 Redisson、開了 `checkLockSyncedSlaves`，
> `WAIT` 也只保證「複製到了 N 台」，不保證「升主的是那 N 台之一」。
> **要正確性，就把最後那道判斷放在資料庫的一條 SQL 裡（12 章 12.2.6）。**

---

## 13.6 Cluster：16384 個槽

Sentinel 解決的是**可用性**：一台 master，掛了換一台。
**它不解決容量與吞吐**——資料還是全部在同一台機器上，
寫入還是全部打在同一顆 CPU 上（03 章：Redis 是單執行緒的）。

Cluster 解決的是那個問題：**把資料切開，放在多台 master 上。**

### 13.6.1 起一組 Cluster

```bash
docker run -d --name redis-cluster \
  -p 7001-7006:7001-7006 -p 17001-17006:17001-17006 \
  redis:7.2 tail -f /dev/null

docker exec redis-cluster sh -c '
for p in 7001 7002 7003 7004 7005 7006; do
  mkdir -p /lab/$p
  redis-server --port $p --daemonize yes --dir /lab/$p \
    --cluster-enabled yes --cluster-config-file nodes.conf \
    --cluster-node-timeout 5000 \
    --cluster-announce-ip 127.0.0.1 --cluster-announce-port $p --cluster-announce-bus-port 1$p \
    --logfile /lab/$p/redis.log
done
yes yes | redis-cli --cluster create \
  127.0.0.1:7001 127.0.0.1:7002 127.0.0.1:7003 \
  127.0.0.1:7004 127.0.0.1:7005 127.0.0.1:7006 \
  --cluster-replicas 1'
```

三個參數要注意：

| 參數 | 意思 |
|---|---|
| `--cluster-enabled yes` | ⚠️ **這是啟動時就決定的，不能用 `CONFIG SET` 改**。單機轉 Cluster 要重啟 |
| **bus port**（`17001`） | 節點之間的**內部通訊埠**，固定是 `客戶端埠 + 10000`。⚠️ **防火牆常常只開了 7001 卻忘了 17001，症狀是「叢集永遠建不起來」** |
| `--cluster-announce-*` | 對外宣告的位址。⚠️ **跟 Sentinel 一樣，容器 / NAT 環境一定要設** |

```bash
$ redis-cli -p 7001 cluster nodes | awk '{print $2" "$3" "$9}' | sort -k2
127.0.0.1:7001@17001 myself,master 0-5460
127.0.0.1:7002@17002 master 5461-10922
127.0.0.1:7003@17003 master 10923-16383
127.0.0.1:7004@17004 slave
127.0.0.1:7005@17005 slave
127.0.0.1:7006@17006 slave

$ redis-cli -p 7001 cluster info | head -2
cluster_state:ok
cluster_slots_assigned:16384
```

📌 **`--cluster-replicas 1` 不是可選的。** 沒有 replica 的 Cluster，
任何一台 master 掛掉，**`cluster_state` 會變成 `fail`，整個叢集停止服務**
（預設 `cluster-require-full-coverage yes`）——**不是只有那 1/3 的資料不能用，是全部不能用。**

### 13.6.2 key 落在哪：`CRC16(key) mod 16384`

```bash
$ redis-cli -p 7001 cluster keyslot user:1
(integer) 10778        # → 7002（5461-10922）
$ redis-cli -p 7001 cluster keyslot user:2
(integer) 6777         # → 7002
$ redis-cli -p 7001 cluster keyslot user:3
(integer) 2648         # → 7001（0-5460）
$ redis-cli -p 7001 cluster keyslot stock:1
(integer) 1603         # → 7001
$ redis-cli -p 7001 cluster keyslot stock:2
(integer) 13856        # → 7003（10923-16383）
$ redis-cli -p 7001 cluster keyslot lock:order:1
(integer) 10688        # → 7002
```

⚠️ **請看 `stock:1` 與 `stock:2`：同一個業務的兩個 key，落在兩台不同的機器上。**
這件事就是 13.7 整節的內容。

📌 **為什麼是 16384 而不是 65536？**
因為節點之間每秒都要互相交換「我負責哪些槽」的 bitmap。
16384 bits = 2 KB，65536 bits = 8 KB。以每秒十次心跳、幾十個節點算，
**這個差別是頻寬上的 4 倍。** antirez 的原話：叢集節點通常不會超過 1000 個，16384 夠了。

### 13.6.3 `MOVED`：連錯節點

```bash
$ redis-cli -p 7001 set user:1 v            # 用「非 cluster 模式」的 redis-cli
(error) MOVED 10778 127.0.0.1:7002          # ← 伺服器告訴你該去哪

$ redis-cli -c -p 7001 set user:1 v         # -c = cluster 模式
-> Redirected to slot [10778] located at 127.0.0.1:7002
OK
```

📌 **`MOVED` 不是錯誤，是路由資訊。** 正確的客戶端（Lettuce、Redisson、`redis-cli -c`）
會在啟動時抓一份「槽 → 節點」的地圖，之後**直接連到對的節點，不會產生任何 `MOVED`**。
`MOVED` 只在地圖過期時出現——而它出現的那一刻，就是客戶端該更新地圖的訊號（13.8）。

### 13.6.4 `ASK`：槽正在搬家

擴容（加一台機器）時，槽要從舊節點搬到新節點。搬的過程中，
同一個槽裡有些 key 已經在新節點、有些還在舊節點。這時候會看到 `ASK`：

```bash
# 手動製造「槽 1603 正在從 7001 搬到 7002」的狀態
$ redis-cli -p 7002 cluster setslot 1603 importing <7001 的 node id>
$ redis-cli -p 7001 cluster setslot 1603 migrating <7002 的 node id>

$ redis-cli -p 7001 get stock:1                  # key 還在來源節點
"100"                                             # ← 直接回答

$ redis-cli -p 7001 get '{stock:1}:absent'       # 同一個槽，但來源節點沒有這個 key
(error) ASK 1603 127.0.0.1:7002                  # ← 「去 7002 問問看」

$ redis-cli -p 7002 get stock:1                  # 目標節點，但槽還不是它的
(error) MOVED 1603 127.0.0.1:7001                # ← 「這個槽還是 7001 的」
```

⚠️ **`ASK` 與 `MOVED` 的差別，是客戶端實作裡最容易寫錯的一段：**

| | 意思 | 客戶端該做什麼 |
|---|---|---|
| `MOVED <slot> <node>` | 這個槽**已經**是別人的了 | ✅ **更新拓樸快取**，之後都去新節點 |
| `ASK <slot> <node>` | 這個槽**正在**搬，這一個 key 可能已經過去了 | ⚠️ **只有這一次**去新節點（而且要先送 `ASKING`）。**不要更新快取** |

**寫錯的症狀**：把 `ASK` 當 `MOVED` 處理 → 客戶端在遷移期間把整個槽的流量都導去目標節點
→ 目標節點回一堆 `MOVED` 導回來 → **兩邊互踢，延遲爆炸**。
（你自己不會寫這段，但你會在 `max-redirects` 的錯誤訊息裡看到它的後果，13.8.4。）

### 13.6.5 Cluster 拿走的三件事

```bash
$ redis-cli -p 7001 select 1
(error) ERR SELECT is not allowed in cluster mode        # ① 只有 db 0

$ redis-cli -p 7001 dbsize
(integer) 1                                              # ② ⚠️ 只算這個節點的
$ redis-cli -p 7001 keys '*'
1) "stock:1"                                             #    ⚠️ 只看得到 1/3

$ redis-cli -p 7001 multi ; set stock:1 1 ; set user:1 1 ; exec
OK
OK
(error) MOVED 10778 127.0.0.1:7002                       # ③ ⚠️ 交易不能跨節點
(error) ERR EXEC without MULTI
```

| 拿走的 | 影響到你的哪一段程式 |
|---|---|
| ① **多資料庫（`SELECT`）** | ⚠️ 用 `database: 1` 隔離環境的專案，上 Cluster 時要改成 key 前綴 |
| ② **全域的 `KEYS` / `SCAN` / `DBSIZE` / `FLUSHDB`** | 01 章 1.5 的 `SCAN` 巡檢腳本、任何「掃全部 key」的維運工具 |
| ③ **跨節點的 `MULTI`／Lua／多 key 命令** | ⚠️ **05、09、10、12 章的大部分內容** |

---

## 13.7 ⚠️ 你前面寫的程式，哪些在 Cluster 上會壞

### 13.7.1 `CROSSSLOT` 一覽（`redis-cli` 這一側）

```bash
$ redis-cli -c -p 7001 mset user:1 a user:2 b
(error) CROSSSLOT Keys in request don't hash to the same slot
$ redis-cli -c -p 7001 mget user:1 user:2
(error) CROSSSLOT Keys in request don't hash to the same slot
$ redis-cli -c -p 7001 del user:1 user:2
(error) CROSSSLOT Keys in request don't hash to the same slot
$ redis-cli -c -p 7001 sinterstore d s1 s2
(error) CROSSSLOT Keys in request don't hash to the same slot
$ redis-cli -c -p 7001 rename user:1 user:2
(error) CROSSSLOT Keys in request don't hash to the same slot
```

### 13.7.2 ⚠️ 但 Lettuce 會幫你拆一部分——而這件事比你想的危險

同樣的命令換成 Lettuce 的 `RedisAdvancedClusterCommands`：

```java
RedisClusterClient client = RedisClusterClient.create(seeds);
RedisAdvancedClusterCommands<String, String> cmd = client.connect().sync();
```

```
═══ 13.7.2 同樣的命令，redis-cli 失敗，Lettuce 成功 ═══

  ① 客戶端可以自己拆開的
     MSET user:1 a user:2 b user:3 c   → ✅ 成功（Lettuce 拆成三個請求送到三個節點）
     MGET user:1 user:2 user:3         → ✅ [a, b, c]
     EXISTS user:1 user:2 user:3       → ✅ 3
     DEL    user:1 user:2 user:3       → ✅ 3

  ② 有伺服器端語意、客戶端拆不開的
     SINTER s1 s2                      → ❌ CROSSSLOT
     RENAME s1 s3                      → ❌ CROSSSLOT

  ③ Lua
     單 key 的 Lua                      → ✅ OK
     KEYS[1]、KEYS[2] 在不同槽           → ❌ CROSSSLOT
     KEYS[1]、KEYS[2] 同一個 hash tag    → ✅ "100/A"

  ④ Lettuce 會 fan-out 到每一個 master 的
     dbsize()  → 7        （把每個 master 加總）
     keys("*") → [stock:1, s2, {order:1}:lock, {a}:k1, {order:1}:stock, {a}:k2, s1]
                          （掃過每個 master 再合併）⚠️ 這是 N 倍的 KEYS，見 01 章 1.5
```

📌 **請特別注意 ① 這一組「幫你拆」的行為，它有兩個代價：**

**代價一：一個命令變成 N 個往返。**
`MGET k1 k2 … k100` 在單機上是**一次**網路往返；
在 Cluster 上會變成**最多 3 次**（3 個 master）——而且你的延遲是**最慢那一個**的延遲。
key 分散在越多節點，尾延遲越糟。

**代價二：⚠️ 它不再是原子的。**

```java
// 在單機上：這是一個命令，要嘛全部寫進去，要嘛都沒有
cmd.mset(Map.of("user:1", "a", "user:2", "b", "user:3", "c"));

// 在 Cluster 上：Lettuce 拆成三個請求送到三個節點
//   → ⚠️ 可能第一個成功、第二個逾時、第三個成功
//   → ⚠️ 而 mset() 只會丟一個例外，你不知道哪些成功了
```

⚠️ **這是本章最容易被忽略的一個坑：程式沒有報錯、測試也過了，
但你以為的原子性已經消失了。** 05 章整章在講「什麼是真的原子」，
而 Cluster 把那個結論改成了：**只有「同一個槽」的操作才是原子的。**

### 13.7.3 Lua 在 Cluster 上的兩條規則

**規則一：`KEYS` 裡的所有 key 必須在同一個槽。**

```bash
$ redis-cli -c -p 7001 eval "local t=0 for i=1,#KEYS do t=t+(tonumber(redis.call('get',KEYS[i])) or 0) end return t" \
    3 stock:1:b0 stock:1:b1 stock:1:b2
(error) CROSSSLOT Keys in request don't hash to the same slot
```

⚠️ **這就是 12 章 12.8.5 那段「掃過所有桶」的 Lua。** 它在單機上是對的，
**在 Cluster 上永遠不會執行成功。**

**規則二：⚠️ Lua 裡不能碰沒有宣告在 `KEYS` 裡的 key——而且它的失敗方式會騙你。**

```bash
# stock:1 的槽 = 1603  → 屬於 7001
# user:1  的槽 = 10778 → 屬於 7002

$ redis-cli -p 7001 eval "return redis.call('get', 'stock:1')" 0
"100"                                                       # ⚠️ 成功了！

$ redis-cli -p 7001 eval "return redis.call('get', 'user:1')" 0
(error) ERR Script attempted to access a non local key in a cluster node script: 176ac00e…
```

📌 **同一段程式碼，換一個 key 就是不同結果。**

**因為判斷條件是「這個 key 的槽剛好不剛好在這台節點上」**，而那是由
`CRC16(key)` 決定的——**等於是隨機的**。於是：

```
   你在測試環境寫了一段 Lua，裡面 hardcode 了一個 key           → ✅ 測試通過
   上線後 80% 的請求正常                                       → ✅ 沒人發現
   某個使用者的 key 剛好被 hash 到別的節點                       → 💥 這一個使用者永遠失敗
```

⚠️ **這是所有 Cluster 問題裡最難查的一種：它不是「壞了」，是「對某些 key 壞了」。**

**所以：Lua 裡碰到的每一個 key，都必須從 `KEYS` 傳進來。** 這條規則在單機上是
「好習慣」，**在 Cluster 上是硬性要求**。回去檢查你在 05、09、10、12 章寫的每一段 Lua。

### 13.7.4 hash tag：把該在一起的 key 綁在一起

```bash
$ redis-cli -p 7001 cluster keyslot '{order:1}:stock'
(integer) 14374
$ redis-cli -p 7001 cluster keyslot '{order:1}:lock'
(integer) 14374        # ← 一樣
$ redis-cli -p 7001 cluster keyslot '{order:1}:idem'
(integer) 14374        # ← 一樣
```

**規則：如果 key 裡有 `{...}`，就只拿第一對大括號中間的內容去算 CRC16。**

```
   {order:1}:stock   →  CRC16("order:1") mod 16384
   stock:{1}         →  CRC16("1")       mod 16384
   user:1            →  CRC16("user:1")  mod 16384      （沒有大括號 = 整個 key）
   {}:foo            →  CRC16("{}:foo")  mod 16384      ⚠️ 空的大括號不算 tag
```

有了 hash tag，13.7.1 那些失敗全部可以修好：

```bash
$ redis-cli -c -p 7001 mset '{order:1}:stock' 100 '{order:1}:lock' A
OK
$ redis-cli -c -p 7001 mget '{order:1}:stock' '{order:1}:lock'
1) "100"
2) "A"
$ redis-cli -c -p 7001 eval "return redis.call('get',KEYS[1])..'/'..redis.call('get',KEYS[2])" \
    2 '{order:1}:stock' '{order:1}:lock'
"100/A"
```

### 13.7.5 ⚠️ hash tag 的代價：你自己造了一個 hot key

```bash
$ for i in 1 2 3 4 5; do redis-cli -p 7001 cluster keyslot "{order:$i}:stock"; done
(integer) 14374     # order:1 → 7003
(integer)  2117     # order:2 → 7001
(integer)  6244     # order:3 → 7002
(integer) 10371     # order:4 → 7002
(integer) 14498     # order:5 → 7003
```

以「訂單」為 tag 是健康的：不同訂單散在不同節點。**但很多人會這樣寫：**

```java
// ⚠️ 想讓所有商品的庫存都能被同一段 Lua 處理，於是用了固定的 tag
String key = "{inventory}:stock:" + productId;      // 💥 全部落在同一個槽
```

**結果：**

```
   ✅ 你的多 key Lua 可以跑了
   ⚠️ 但所有庫存操作都打在同一個 master 上
   ⚠️ 那台 master 是單執行緒的（03 章）
   ⚠️ 你花錢加的另外兩台 master，對這個業務完全沒有幫助
   ⚠️ 而且 12.8 那個 hot key 問題，你剛剛親手把它製造出來了
```

📌 **hash tag 的選法只有一條原則：**

> **選一個「業務上本來就會一起操作，而且數量夠多、分布夠均勻」的東西當 tag。**
> 訂單號、使用者 ID、租戶 ID 通常是對的。
> ⚠️ **「商品類別」「城市」「固定字串」通常是錯的——它們的分布不均勻。**

⚠️ **另外：hash tag 綁住的是「槽」，不是「節點」。** 擴容搬槽時它們會一起搬，
所以 hash tag 用得太重（一個 tag 底下幾十萬個 key）會讓**單一槽變得很大，搬不動**。

### 13.7.6 逐章檢查：09～12 章的程式在 Cluster 上

| 章節 | 程式 | Cluster 上 | 怎麼修 |
|---|---|---|---|
| 09 分散式鎖 | `SET lock:x token NX PX` | ✅ 單 key，沒問題 | —— |
| 09 釋放鎖的 Lua | `KEYS[1]` 一個 key | ✅ 沒問題 | —— |
| 09 Redisson `RLock` | 單 key Hash | ✅ 沒問題 | ⚠️ 但 `RedissonMultiLock` 要注意 |
| 10 限流（滑動窗 / 令牌桶） | `KEYS[1]` 一個 key | ✅ 沒問題 | —— |
| 10 多維度限流 | ⚠️ 一次檢查 `user:x` + `ip:y` + `api:z` | ❌ **CROSSSLOT** | 拆成三次呼叫，或用 hash tag 綁在一起（⚠️ 但那會讓同一個 tag 的流量集中） |
| 10 冪等鍵 | `SET idem:x NX` | ✅ 單 key | —— |
| 11 Spring Session | `spring:session:sessions:<id>` + `…:sessions:expires:<id>` + `…:expirations:<ts>` | ⚠️ **同一個 session 的 key 分散在不同節點**（13.7.7 實測），但**能用**——因為每個操作都是單 key 的 | 不用改，但要知道它散開了 |
| 11 Session 過期事件 | `__keyevent@0__:expired` | ❌ **只收得到 1/3 的事件**（13.7.8 實測） | 必須對**每一個 master** 訂閱 |
| 12 `deduct-stock.lua` | `KEYS[1]` 一個 key | ✅ 沒問題 | —— |
| 12 分桶掃描的 Lua（12.8.5） | `KEYS[1..N]` = `stock:1:b0…bN` | ❌ **CROSSSLOT** | `stock:{1}:b0` … `stock:{1}:bN`（⚠️ 然後所有桶又回到同一個節點——12.8.2 已經說過分桶在單節點上買不到吞吐量） |
| 12 排行榜 `ZUNIONSTORE` | 多個 ZSet | ❌ **CROSSSLOT** | 用 `{rank}` 綁在一起，或改成在應用端合併 |
| 07 快取 | `@Cacheable` 的單 key | ✅ 沒問題 | —— |
| 07 `@CacheEvict(allEntries = true)` | ⚠️ 需要掃 key | ⚠️ **變成對每個 master 掃一次** | 用版本化前綴（07 章 7.6.3）取代 evict all |
| 01 `SCAN` 巡檢腳本 | `SCAN` | ⚠️ 只掃得到一個節點 | 對每個 master 各掃一次 |

📌 **把這張表當成「上 Cluster 前的 checklist」。**
⚠️ **重點是最後三列：它們不會報錯，只會「少做一部分」——
`@CacheEvict(allEntries=true)` 清掉了 1/3 的快取，然後你以為清乾淨了。**

### 13.7.7 實測：Spring Session 在 Cluster 上，key 是散開的

11 章的 Spring Session（`indexed` 模式）有四種 key（11.4.3）。把它接上 Cluster，建三個 session：

```java
@SpringBootApplication
@EnableRedisIndexedHttpSession
public class SessionCluster {
    // spring.data.redis.cluster.nodes = 127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003
}
```

```
repository = RedisIndexedSessionRepository
  建立 session 27d015e5-…
  建立 session 65a82382-…
  建立 session 69ffab88-…

每個節點上的 key：
  7001 → spring:session:sessions:65a82382-…
         spring:session:sessions:27d015e5-…
  7002 → spring:session:sessions:expires:69ffab88-…
         spring:session:sessions:expires:27d015e5-…        ⚠️
         spring:session:expirations:1789717860000
  7003 → spring:session:sessions:69ffab88-…
         spring:session:sessions:expires:65a82382-…        ⚠️
```

📌 **注意 session `27d015e5`：它的本體在 7001，它的 `expires` 影子在 7002。**
**Spring Session 沒有加 hash tag。**

**這樣可以嗎？可以**——因為 Spring Session 對這些 key 的每一個操作都是**單 key** 的
（`HGETALL` 一個、`EXISTS` 一個、`SREM` 一個），從來沒有一個命令同時碰兩個。

⚠️ **但代價是：一次讀 session 變成最多兩次網路往返，打到兩台不同的機器。**
11 章 11.4.3 量到的「每請求 6～8 個命令」，在 Cluster 上會散到 2～3 台機器上——
**你的 P99 變成那幾台裡最慢的那一台。**

### 13.7.8 ⚠️ 實測：Cluster 上的 keyspace 通知，你只收得到 1/3

11 章的 `RedisIndexedSessionRepository` 靠 `__keyevent@0__:expired` 事件
來發出 `SessionDestroyedEvent`（11.4.1、11.6.2）。**而 Redis 的 keyspace 事件
只會在「key 所在的那個節點」上發布。**

在三個 master 上各放一個會過期的 key，然後用最常見的寫法訂閱：

```java
StatefulRedisClusterPubSubConnection<String, String> ps = client.connectPubSub();
ps.addListener(/* … */);
ps.sync().psubscribe("__keyevent@0__:expired");     // ← 大多數人寫的
```

```
=== ① 一般的 psubscribe ===
  放了 3 個 key（各落在 7001 / 7002 / 7003），等它們過期……
  收到 1 個 expired 事件：[stock:2]
  ⚠️ 只收到 1 / 3
```

⚠️ **這一段程式在單機上 100% 正確，在 Cluster 上默默地漏掉 2/3 的事件。**
**沒有任何錯誤、沒有任何警告。**

正確的寫法是對**每一個 master** 都訂閱：

```java
StatefulRedisClusterPubSubConnection<String, String> ps = client.connectPubSub();
ps.setNodeMessagePropagation(true);                             // ← 把各節點的訊息轉給 listener
ps.sync().nodes(n -> n.is(RedisClusterNode.NodeFlag.UPSTREAM))  // ← 對每個 master 訂閱
         .commands().psubscribe("__keyevent@0__:expired");
```

```
=== ② 對「每一個 master」都訂閱 ===
  收到 3 個 expired 事件：[stock:2, user:1, user:3]
  ✅ 三個節點的事件都收到了
```

📌 **影響到的東西比你想的多：**

| 用到 keyspace 事件的地方 | 在 Cluster 上會怎樣 |
|---|---|
| 11 章 Spring Session 的 `SessionDestroyedEvent` | ⚠️ 只有 1/N 的登出事件會被處理 |
| 「快取失效就通知其他實例清本地快取」 | ⚠️ 大部分實例不會被通知（08 章 8.5.3 的本地快取會不一致） |
| 用 `expired` 事件做延遲佇列 | ⚠️ **大部分任務不會被觸發** |

⚠️ **另外，這還不是最糟的：Redis 的過期事件本來就不保證送達**
（01 章 1.6：key 過期後可能很久才被真的刪掉；而且 pub/sub 是 fire-and-forget，
訂閱者斷線期間的事件永遠不會補送）。
**Cluster 只是把「不可靠」放大成「不可靠，而且只有 1/N」。**

📌 **結論：不要把「一定要發生」的事情建在 keyspace 事件上**，
不管是不是 Cluster。

---

## 13.8 Lettuce 的 topology refresh：本章最貴的一個預設值

### 13.8.1 ⚠️ 實測：Cluster 切換完成，客戶端 58 秒都沒恢復

實驗：客戶端每 100 毫秒對 `user:1`（在 7002 上）送一個 `INCR`，
然後 `kill -9` 7002。**Lettuce 用預設設定**：

```
═══ 13.8.1 Lettuce 預設 topology refresh ═══
  topology refresh = Lettuce 預設（⚠️ periodic 關閉、adaptive 關閉）

  [ 2001 ms] >>> kill -9 7002（user:1 所在的 master）
  [ 2111 ms] ❌ RedisCommandTimeoutException: Command timed out after 500 ms
  [ 2719 ms] ❌ SocketException: Connection reset
  [11346 ms] 🔀 Cluster 已經把 7002 的槽交給別人：7001 / 7003 / 7006
  成功 20，失敗 553
  ⏱  ⚠️ 58 秒內都沒恢復
```

📌 **Cluster 那一側在 9.3 秒就完成切換了**（7006 從 replica 升成 master，接手 5461-10922）。
**但客戶端 58 秒後還在失敗。**

因為 Lettuce 在啟動時抓了一份「槽 → 節點」的地圖，**而它預設不會自己更新那份地圖**。
於是它一直把 `user:1` 的命令送去 7002——**那台機器已經不存在了。**

### 13.8.2 開啟 adaptive refresh

```java
ClusterTopologyRefreshOptions topo = ClusterTopologyRefreshOptions.builder()
        .enablePeriodicRefresh(Duration.ofSeconds(30))    // 每 30 秒主動抓一次
        .enableAllAdaptiveRefreshTriggers()               // MOVED / ASK / 重連 / 未覆蓋的槽 / 未知節點
        .adaptiveRefreshTriggersTimeout(Duration.ofSeconds(5))   // ⚠️ 兩次 adaptive refresh 的最小間隔
        .dynamicRefreshSources(true)
        .build();
client.setOptions(ClusterClientOptions.builder().topologyRefreshOptions(topo).build());
```

```
═══ 13.8.2 開啟 adaptive topology refresh ═══
  [ 2006 ms] >>> kill -9 7002
  [ 2194 ms] ❌ SocketException: Connection reset
  [10427 ms] 🔀 Cluster 已經把 7002 的槽交給別人：7001 / 7003 / 7004
  [11307 ms] ✅ user:1 的寫入恢復了
  ⏱  從 kill 到恢復：9,307 ms
```

| 設定 | Cluster 完成切換 | 客戶端恢復 | 落差 |
|---|---|---|---|
| **Lettuce 預設** | 9,345 ms | ⚠️ **58 秒內都沒有** | **∞** |
| periodic 30s + all adaptive | 8,421 ms | **9,307 ms** | **886 ms** |

⚠️ **這是本章 CP 值最高的一個設定。** 一行設定，把「服務不會自己恢復」變成「1 秒內跟上」。

五個 adaptive 觸發條件分別對應什麼：

| 觸發條件 | 什麼時候發生 |
|---|---|
| `MOVED_REDIRECT` | 收到 `MOVED` = 我的地圖過期了 |
| `ASK_REDIRECT` | 收到 `ASK` = 有槽正在搬 |
| `PERSISTENT_RECONNECTS` | 對某個節點一直重連失敗 = 它可能死了 |
| `UNCOVERED_SLOT` | 我的地圖裡有槽找不到主人 |
| `UNKNOWN_NODE` | 被導向一個我不認識的節點 |

📌 **`adaptiveRefreshTriggersTimeout` 是節流閥**（預設 30 秒）。
沒有它的話，一次 failover 會讓幾百個命令同時觸發 refresh，
**把剛恢復的叢集用 `CLUSTER NODES` 打爆**（又是 08 章 8.7 那個「恢復的第二波」）。
⚠️ **但它也是那 886 毫秒的來源：設成 5 秒是一個折衷。**

### 13.8.3 ⚠️ Spring Boot 的預設值：跟 Lettuce 一樣是關的

```
########## Spring Boot 預設（只設了 spring.data.redis.cluster.nodes）##########
isClusterAware()          = true
cluster nodes             = [127.0.0.1:7001, 127.0.0.1:7002, 127.0.0.1:7003]
maxRedirects              = 3
periodicRefreshEnabled    = false          ⚠️
adaptiveRefreshTriggers   = []             ⚠️
dynamicRefreshSources     = true
closeStaleConnections     = true
```

⚠️ **這就是 13.8.1 那個「58 秒都沒恢復」的狀態，而它是 Spring Boot 的預設值。**

打開它：

```yaml
spring:
  data:
    redis:
      cluster:
        nodes:
          - 127.0.0.1:7001
          - 127.0.0.1:7002
          - 127.0.0.1:7003
        max-redirects: 3
      lettuce:
        cluster:
          refresh:
            period: 30s                     # ← ⚠️ 不設就是「永不更新」
            adaptive: true                  # ← ⚠️ 不設就是「不會對 MOVED 反應」
            dynamic-refresh-sources: true
```

```
########## 加上 refresh 設定 ##########
periodicRefreshEnabled    = true   （每 PT30S）
adaptiveRefreshTriggers   = [PERSISTENT_RECONNECTS, MOVED_REDIRECT, UNCOVERED_SLOT,
                             ASK_REDIRECT, UNKNOWN_NODE]
dynamicRefreshSources     = true
```

📌 **`spring.data.redis.lettuce.cluster.refresh.adaptive: true` 這一行，
是這一整章裡你最應該現在就去加的一行設定。**

> ⚠️ **`dynamic-refresh-sources` 的意思**：抓拓樸時要問「所有已知節點」還是「只問設定檔裡的種子節點」。
> 預設 `true`（問所有節點）。⚠️ **在節點很多的叢集上，這會產生 N × N 的 `CLUSTER NODES` 流量**；
> 如果你的叢集超過 20 個節點，考慮設成 `false`。

### 13.8.4 `max-redirects`

```yaml
max-redirects: 3     # Spring Boot 預設就是 3
```

一個命令最多被 `MOVED` / `ASK` 導向幾次。超過就丟：

```
TooManyClusterRedirectionsException: Too many cluster redirections
```

⚠️ **看到這個例外，不要去調大 `max-redirects`。** 它幾乎一定代表下列之一：

| 原因 | 怎麼確認 |
|---|---|
| 拓樸正在變（擴容搬槽中） | ✅ 正常，搬完就好 |
| **topology refresh 沒開**，客戶端地圖一直是舊的 | 13.8.3 |
| ⚠️ **兩個節點互相 `MOVED`**（槽的歸屬沒收斂） | `redis-cli --cluster check` 會報 open slots |

---

## 13.9 Sentinel 還是 Cluster

| | Sentinel | Cluster |
|---|---|---|
| 解決什麼 | **可用性** | **可用性 + 容量 + 寫入吞吐** |
| 資料 | 每個節點都是**完整的一份** | 切成 16384 個槽，**每個節點只有一部分** |
| 最少幾台 | 1 主 1 從 + **3 台 Sentinel** | **3 主 3 從**（6 台） |
| 多 key 命令 / Lua | ✅ 完全沒有限制 | ⚠️ **只能在同一個槽內**（13.7） |
| `SELECT` 多資料庫 | ✅ 16 個 | ❌ 只有 db 0 |
| 切換時間（本章實測） | Redis 側 6.6 秒 / 客戶端 6.7～9.3 秒 | Redis 側 ~9 秒 / 客戶端 9.3 秒（⚠️ 沒開 refresh 就是永遠） |
| 客戶端設定 | `spring.data.redis.sentinel.*` | `spring.data.redis.cluster.*` + ⚠️ **`lettuce.cluster.refresh.*`** |
| 維運複雜度 | 中 | ⚠️ 高（擴容要搬槽、`--cluster check`、槽不平衡） |

📌 **選法，三個問題：**

```
① 單一台 Redis 的記憶體裝得下你的資料嗎（含成長）？
     裝不下 ──────────────────▶ Cluster
     裝得下 ──▶ ②

② 單一台 Redis 的吞吐撐得住嗎？（03 章：單執行緒，約 10 萬 QPS 是個量級）
     撐不住 ──────────────────▶ 先做讀寫分離（13.3）；還是不夠 ──▶ Cluster
     撐得住 ──▶ ③

③ ✅ 用 Sentinel。
```

⚠️ **不要因為「Cluster 聽起來比較高級」就上 Cluster。**
13.7 那張表裡的每一列，都是你要付的稅——
**而其中大部分要等到上線之後、某個特定的 key 被 hash 到某個特定的節點時，才會炸給你看。**

> 📌 **雲端託管的 Redis（ElastiCache、MemoryDB、阿里雲 / 騰訊雲的 Redis）
> 通常提供「主從版」與「叢集版」兩種**，對應的就是這一節的兩欄。
> **選錯之後要換，是一次資料遷移，不是改設定。**

---

## 13.10 落地：shop-service 的高可用設定

### 13.10.1 三種拓樸，同一份程式

**業務程式不應該知道 Redis 是單機、Sentinel 還是 Cluster。**
用 profile 把差別關在設定檔裡：

```yaml
# application.yml —— 所有拓樸共用的部分
spring:
  data:
    redis:
      client-name: shop-service       # 03 章 3.6：CLIENT LIST 上認得出是誰
      timeout: 500ms                  # 06 章 6.9.1
      connect-timeout: 2s
      lettuce:
        pool:
          enabled: true
          max-active: 16
          max-idle: 16
          min-idle: 4
          max-wait: 200ms
          time-between-eviction-runs: 30s
        shutdown-timeout: 200ms

---
spring:
  config:
    activate:
      on-profile: single              # 開發機（00～12 章）
  data:
    redis:
      host: localhost
      port: 16379

---
spring:
  config:
    activate:
      on-profile: sentinel            # 測試 / 正式（13.4、13.5）
  data:
    redis:
      sentinel:
        master: mymaster
        nodes: [127.0.0.1:26379, 127.0.0.1:26380, 127.0.0.1:26381]

---
spring:
  config:
    activate:
      on-profile: cluster             # 資料放不下一台的時候（13.6～13.8）
  data:
    redis:
      cluster:
        nodes: [127.0.0.1:7001, 127.0.0.1:7002, 127.0.0.1:7003]
        max-redirects: 3
      lettuce:
        cluster:
          refresh:
            period: 30s               # ⚠️ 13.8.3：不設 = 永不更新
            adaptive: true            # ⚠️ 13.8.3：不設 = 對 MOVED 沒反應
            dynamic-refresh-sources: true
```

```java
@Configuration
public class RedisHaConfig {

    /** 13.5.4：把 failover 後的恢復從 9.3 秒縮到 6.7 秒，同時不打爆剛恢復的 Redis。 */
    @Bean(destroyMethod = "shutdown")
    ClientResources lettuceClientResources() {
        return ClientResources.builder()
                .reconnectDelay(Delay.exponential(50, 1000, TimeUnit.MILLISECONDS, 2))
                .build();
    }

    /** 13.3.2：明著寫出來，即使它是預設值。 */
    @Bean
    LettuceClientConfigurationBuilderCustomizer haCustomizer() {
        return builder -> builder
                .readFrom(ReadFrom.MASTER)                     // ⚠️ 13.3.3
                .clientOptions(ClientOptions.builder()
                        .socketOptions(SocketOptions.builder()
                                .keepAlive(true)               // 06 章 6.8.6
                                .connectTimeout(Duration.ofSeconds(2))
                                .build())
                        .disconnectedBehavior(DisconnectedBehavior.REJECT_COMMANDS)  // 08 章 8.4.7
                        .build());
    }
}
```

⚠️ **`clientOptions(...)` 在 Cluster profile 下會蓋掉 topology refresh 的設定**，
因為 `spring.data.redis.lettuce.cluster.refresh.*` 產生的是一個 `ClusterClientOptions`，
而你這裡給的是普通的 `ClientOptions`。**Cluster profile 要這樣寫：**

```java
@Bean
@Profile("cluster")
LettuceClientConfigurationBuilderCustomizer clusterCustomizer(
        RedisProperties props) {
    var refresh = props.getLettuce().getCluster().getRefresh();
    ClusterTopologyRefreshOptions topo = ClusterTopologyRefreshOptions.builder()
            .enablePeriodicRefresh(refresh.getPeriod())
            .enableAllAdaptiveRefreshTriggers()
            .adaptiveRefreshTriggersTimeout(Duration.ofSeconds(5))
            .dynamicRefreshSources(refresh.isDynamicRefreshSources())
            .build();
    return builder -> builder.clientOptions(ClusterClientOptions.builder()   // ← ⚠️ Cluster 版
            .topologyRefreshOptions(topo)
            .socketOptions(SocketOptions.builder().keepAlive(true).build())
            .disconnectedBehavior(DisconnectedBehavior.REJECT_COMMANDS)
            .maxRedirects(props.getCluster().getMaxRedirects())
            .build());
}
```

📌 **然後用一個測試把它釘住**（14 章會用 Testcontainers 把它變成 CI 的一部分）：

```java
@Test
void cluster_profile_必須開著_topology_refresh() {
    var opts = (ClusterClientOptions) factory.getClientConfiguration()
            .getClientOptions().orElseThrow();
    var t = opts.getTopologyRefreshOptions();
    assertThat(t.isPeriodicRefreshEnabled()).isTrue();          // 13.8.3
    assertThat(t.getAdaptiveRefreshTriggers()).isNotEmpty();    // 13.8.3
}
```

### 13.10.2 Redisson 那一側（09 章起）

```java
@Bean(destroyMethod = "shutdown")
@Profile("sentinel")
RedissonClient redissonSentinel() {
    Config cfg = new Config();
    cfg.useSentinelServers()
       .setMasterName("mymaster")
       .addSentinelAddress("redis://127.0.0.1:26379", "redis://127.0.0.1:26380", "redis://127.0.0.1:26381")
       .setReadMode(ReadMode.MASTER)            // ⚠️ 13.3.3：鎖絕對不能讀 replica
       .setTimeout(500).setRetryAttempts(3).setRetryInterval(200);
    cfg.setCheckLockSyncedSlaves(true);         // 13.5.7：預設就是 true，明著寫
    cfg.setSlavesSyncTimeout(1000);             // ⚠️ replica 卡住時，這一秒會加在 P99 上
    return Redisson.create(cfg);
}

@Bean(destroyMethod = "shutdown")
@Profile("cluster")
RedissonClient redissonCluster() {
    Config cfg = new Config();
    cfg.useClusterServers()
       .addNodeAddress("redis://127.0.0.1:7001", "redis://127.0.0.1:7002", "redis://127.0.0.1:7003")
       .setScanInterval(5000)                   // ← Redisson 自己的 topology refresh，預設 5,000 ms
       .setReadMode(ReadMode.MASTER)
       .setTimeout(500).setRetryAttempts(3).setRetryInterval(200);
    return Redisson.create(cfg);
}
```

📌 **一個值得注意的對照：**

| | topology refresh 預設 |
|---|---|
| **Lettuce（Spring Boot 預設）** | ⚠️ **關閉**（13.8.3） |
| **Redisson** | ✅ **開著，每 5 秒一次**（`scanInterval`） |

**這就是為什麼「同一個 Cluster，Redisson 的服務恢復了，Lettuce 的還在 500」。**

Redisson 在 Cluster 上的實測：

```
① 單一 RLock（單 key）→ tryLock = true          槽 10688 ✅
② RedissonMultiLock（lock:a / lock:b / lock:c，三個不同槽 6035 / 10224 / 14289）
   → tryLock = true
   ✅ 可以——因為 MultiLock 是「一把一把分開鎖」，不是一個多 key 命令
③ RMap("cart:{user:1}") → 槽 10778，內容 {p1=2}  ✅
④ RBatch 兩個不同槽的 key → ✅ 成功（Redisson 拆開送，⚠️ 但不是原子的）
```

⚠️ **請注意 ④：跟 13.7.2 的 `MSET` 一樣——它成功了，但它不再是原子的。**

### 13.10.3 六條規約（接續 12 章 12.9.3 的第 35 條）

36. ⚠️ **上 Cluster 之前，先把 13.7.6 那張表逐列走過一次。**
    **code review 時看到新的多 key 命令或多 key Lua，要問「這些 key 保證同槽嗎」。**
37. **Lua 裡碰到的每一個 key，都必須從 `KEYS` 傳進來**（13.7.3）。
    這在單機是好習慣，**在 Cluster 是硬性要求，而且違反它的症狀是「只有部分 key 會失敗」**。
38. ⚠️ **Cluster profile 一定要開 `lettuce.cluster.refresh.adaptive`**（13.8.3）。
    **這一條要有測試釘住**（13.10.1）。
39. ⚠️ **任何「一定要發生」的邏輯，不可以建在 keyspace 事件上**（13.7.8）。
40. **任何「丟了會出事」的資料，最終事實不能只在 Redis**（13.2.3、13.2.4）。
    12 章第 33 條的根因就是這一條。
41. ⚠️ **Sentinel / Cluster 的節點位址，必須是「應用程式連得到」的位址**（13.5.5、13.6.1）。
    **設定檔要能被 Sentinel 寫入，不可以掛成唯讀的 ConfigMap**（13.4.5）。

### 13.10.4 六個該接告警的指標（接續 12 章 12.9.4）

| 指標 | 從哪裡來 | 告警條件 | 代表什麼 |
|---|---|---|---|
| **複製落後量** | `master_repl_offset` − `slaveN.offset` | 持續 > 幾 MB | ⚠️ **現在主掛掉會丟這麼多資料**（13.2.1） |
| **`sync_full`** | `INFO stats` | 持續增加 | ⚠️ backlog 太小 / replica 反覆斷線（13.2.8） |
| **`connected_slaves`** | `INFO replication` | **< 預期值就告警** | 少一台 replica = 少一層保護 |
| **`+switch-master` 事件** | Sentinel 的 pub/sub | **發生就告警** | ⚠️ **切換不是「自動處理好了」，它是一次事故**（13.2.3 的資料遺失） |
| **`cluster_state`** | `CLUSTER INFO` | `!= ok` 就告警 | ⚠️ 有槽沒有主人 = **整個叢集停止服務**（13.6.1） |
| **`TooManyClusterRedirections` / `MOVED` 速率** | 應用端 | > 0 持續出現 | ⚠️ 拓樸快取沒更新（13.8.4） |

📌 **第四列值得單獨說：很多團隊把「Sentinel 自動切換了」當成好消息。**
它不是。**每一次切換都代表：一次資料遺失（13.2.3）、一段服務中斷（13.5.2）、
可能一次鎖失效（13.5.6）。** 它該進事故記錄，不是該被忽略的 INFO log。

### 13.10.5 驗收

```bash
# ① Sentinel：切換時服務恢復得夠快
docker exec redis-ha sh -c 'kill -9 $(redis-cli -p 6380 info server|grep process_id|tr -d "process_id:\r")'
# → 應用端錯誤持續時間應 ≈ down-after(5s) + 1.5s + reconnectDelay，而不是「永遠」

# ② Cluster：kill 一個 master，客戶端要在 10 秒內恢復
docker exec redis-cluster sh -c 'kill -9 $(redis-cli -p 7002 info server|grep process_id|tr -d "process_id:\r")'

# ③ 檢查叢集健康
docker exec redis-cluster redis-cli --cluster check 127.0.0.1:7001

# ④ 檢查複製落後
docker exec redis-ha redis-cli -p 6380 info replication | grep -E 'offset|lag'
```

---

## 13.11 常見誤區

**① 「架了主從就不會丟資料」**

13.2.3 實測：**15,583 筆已經回 `OK` 的寫入，切換後只剩 9,602 筆。**
複製是非同步的，**這不是 bug，是設計**（13.2.4）。

**② 「用 `WAIT` 就安全了」**

13.2.5：`WAIT` 回 0 時那筆寫入**已經發生了**，它不會回滾。
而且 replica 一卡住，吞吐從 4,808 筆/秒掉到 13 筆/秒（**380 倍**）。

**③ 「讀寫分離可以無腦打開」**

13.3.1 實測：複製鏈路斷開的那一瞬間，`REPLICA_PREFERRED` 讀到舊值的比例是 **100%**。
⚠️ 而且**在開發環境是 0%**——這個問題只在正式環境出現。

**④ 「鎖、冪等鍵、限流計數也可以讀 replica」**

13.3.3：這五樣東西讀 replica 等於**把 09～12 章的保證全部拿掉**。

**⑤ 「quorum 設 1，一台 Sentinel 就夠了」**

13.4.4 實測：`+odown` 宣告成功、`+try-failover` 開始了，
**10 秒後 `-failover-abort-not-elected`**——拿不到「已知 Sentinel 過半」的授權。
⚠️ **Sentinel 至少 3 台，而且要在 3 個故障域。**

**⑥ 「Sentinel 切換了，我的服務就恢復了」**

13.5.1：**直連 master 的客戶端，43 秒後仍未恢復。**
13.5.2：走 Sentinel 的客戶端，比 Sentinel 慢 **2,826 毫秒**（Lettuce 的指數退避）。

**⑦ 「切換是自動的，所以不用告警」**

13.10.4：每一次切換 = 一次資料遺失 + 一段中斷 + 可能一次鎖失效。

**⑧ 「舊 master 修好了，啟動它就好」**

13.4.5 實測：那個窗口裡它是一台**可寫的 master**，寫進去的 **100 筆全部成功、25 秒後全部消失**。
⚠️ **用 `replicaof` 啟動它。**

**⑨ 「Cluster 不能用 `MGET`」**

13.7.2：`redis-cli` 會 `CROSSSLOT`，**但 Lettuce 會自動幫你拆**。
⚠️ **代價是它不再是原子的**，而且一次往返變成 N 次。

**⑩ 「Lua 在 Cluster 上只要 key 不多就沒事」**

13.7.3：**Lua 裡碰到沒宣告在 `KEYS` 的 key**，會依那個 key 的槽在不在本節點
而**時好時壞**——`ERR Script attempted to access a non local key`。
⚠️ **同一段程式，換一個 key 就是不同結果。**

**⑪ 「加 hash tag 就解決了」**

13.7.5：用固定字串當 tag（`{inventory}:stock:123`），
**所有流量會落在同一個節點**——你花錢加的機器完全沒用上，還親手造了一個 hot key（12.8）。

**⑫ 「Lettuce 會自己發現新的拓樸」**

13.8.1 實測：⚠️ **Lettuce 與 Spring Boot 的預設是「永不更新」。**
Cluster 在 9.3 秒完成切換，**客戶端 58 秒都沒恢復。**

**⑬ 「`TooManyClusterRedirections` 就把 `max-redirects` 調大」**

13.8.4：它幾乎一定代表拓樸快取沒更新，或槽的歸屬沒收斂。**調大只是把症狀藏起來。**

**⑭ 「Cluster 比 Sentinel 高級，直接上 Cluster」**

13.9：Cluster 買到的是容量與寫入吞吐。**如果你的瓶頸不是那兩個，
你買到的只有 13.7 那張表。**

**⑮ 「Session 換 Cluster 只是改設定」**

13.7.8 實測：⚠️ **`__keyevent@0__:expired` 只收得到 1/3。**
Session 過期事件、快取失效廣播、延遲佇列**全部默默地少做 2/3**，沒有任何錯誤。

---

## 13.12 本章小結

**這一章只有一句話：**

> 📌 **「Redis 高可用」的意思是「會自動換一台」，不是「不會中斷」，更不是「不會丟資料」。**

```
   一次主從切換，實際發生的事：

   ①  0.0 秒   master 死掉
   ②  5.1 秒   Sentinel 才確定它死了      ← down-after-milliseconds（13.4.3）
   ③  5.5 秒   新 master 可以寫了          ← 選舉只花 0.44 秒
   ④  6.6 秒   switch-master 廣播出去
   ⑤  9.3 秒   ⚠️ 你的 Java 程式才恢復      ← Lettuce 的重連退避（13.5.3）

   而在 ① 之前的那一瞬間：
   ⚠️ 38.4% 已經回過 OK 的寫入，永遠消失了（13.2.3）
   ⚠️ 你的分散式鎖，可能是消失的那一批（13.5.6）
   ⚠️ 期間任何連到舊 master 的客戶端，寫進去的東西會被 Full resync 清掉（13.4.5）
```

**三層設定，三個不同的問題：**

| 層 | 設定 | 沒設的症狀 |
|---|---|---|
| **Redis 那一側** | `down-after-milliseconds`、`min-replicas-to-write`、`repl-backlog-size` | 切換太慢 / 資料只有一份 / 一直全量同步 |
| **客戶端連線** | `sentinel.*` 或 `cluster.*` + **`reconnectDelay`** / **`refresh.adaptive`** | ⚠️ **Redis 好了，你的服務沒好** |
| **業務程式** | 同槽的 key、`KEYS` 傳進 Lua、不依賴 keyspace 事件、資料庫兜底 | ⚠️ **不報錯，只是少做一部分** |

📌 **而第三層是唯一不能靠設定解決的一層。**

### 13.12.1 驗收清單

- [ ] 用 `INFO replication` 算出「現在主掛掉會丟多少資料」。
- [ ] 重現 13.2.3，說出你自己機器上的遺失比例，以及為什麼不加干擾時量到 0。
- [ ] 說得出 `WAIT` 保證什麼、不保證什麼，以及它的吞吐代價。
- [ ] 說得出 `min-replicas-to-write` 把什麼換成了什麼，並在程式裡認得 `NOREPLICAS`。
- [ ] ⚠️ 說得出哪五類資料絕對不能讀 replica，以及理由。
- [ ] 畫出 Sentinel 的切換時間軸，並指出哪一段是設定出來的。
- [ ] ⚠️ 說得出 quorum 與 majority 的差別，以及為什麼 Sentinel 至少要 3 台。
- [ ] 說得出舊 master 重新上線的那幾秒為什麼是事故，以及正確的重啟方式。
- [ ] ⚠️ 量出你的客戶端從 kill 到恢復花了多久，並說出比 Sentinel 慢的那一段是誰的。
- [ ] 說得出 `MOVED` 與 `ASK` 的差別，以及客戶端該怎麼處理。
- [ ] ⚠️ 指出你自己專案裡哪些命令 / Lua 在 Cluster 上會 `CROSSSLOT`。
- [ ] 說得出 hash tag 的規則，以及選錯 tag 的代價。
- [ ] ⚠️ 檢查你的 Cluster 設定有沒有開 topology refresh，並說出沒開的後果。
- [ ] 說得出在什麼情況下該選 Sentinel、什麼情況下該選 Cluster。

### 13.12.2 本章練習

**練習一（20 分鐘）**：照 13.2.1 起一組主從，寫一段程式持續寫入，
用 `INFO replication` 每秒印一次 `master_repl_offset − slave0.offset`。
**然後對 replica 送 `DEBUG SLEEP 3`，看那個數字長到多大。**

**練習二（30 分鐘，核心）**：重現 13.2.3。跑三次，記錄遺失比例。
然後：① 把 `kill -STOP` 拿掉再跑一次——**遺失多少？**
② 加上 `WAIT 1 100` 再跑一次——**吞吐掉多少？遺失多少？**
③ 回答：你的業務可以接受哪一組數字？

**練習三（20 分鐘）**：把 `min-replicas-to-write` 設成 1，關掉所有 replica，
然後用你自己的服務打一個寫入 API。**它回什麼？使用者看到什麼？**
接著在 08 章的 `CacheErrorHandler` 裡處理 `NOREPLICAS`，再打一次。

**練習四（25 分鐘）**：重現 13.3.1 的三種 `ReadFrom`。
然後把你專案裡**某一個**讀取路徑改成 `REPLICA_PREFERRED`，
**並說明你為什麼認為那一個可以。**

**練習五（30 分鐘）**：重現 13.4.4 的兩個情境（quorum=2 / quorum=1，只剩一台 Sentinel）。
**然後把 Sentinel 開回三台，再跑一次，比較日誌。**

**練習六（30 分鐘，核心）**：重現 13.5.2 與 13.5.4。
在你自己的機器上量出「預設」與「調過 `reconnectDelay`」的恢復時間。
⚠️ **然後把 `down-after-milliseconds` 從 5000 改成 1000，再量一次——
總時間變成多少？你願意承擔誤判的風險嗎？**

**練習七（40 分鐘，核心）**：起一組 Cluster，然後把你專案裡
**所有**的 Lua 腳本拿出來，一段一段在 Cluster 上跑。
記錄：哪些直接成功、哪些 `CROSSSLOT`、哪些「有時候成功」。

**練習八（40 分鐘）**：重現 13.8.1 與 13.8.2。
⚠️ **先用預設設定跑，看著它 58 秒不恢復**，再加上 `refresh.adaptive: true` 跑一次。
**然後去看你正式環境的設定檔有沒有這一行。**

**練習九（進階，40 分鐘）**：重現 13.7.8。
然後檢查你的專案有沒有用到 keyspace 事件（Spring Session、快取失效廣播、延遲佇列），
**列出「如果只收到 1/N 的事件」會發生什麼。**

**練習十（進階，60 分鐘）**：把 13.10.1 的三個 profile 都設好，
用同一份業務程式在 `single` / `sentinel` / `cluster` 三種拓樸下各跑一次整合測試。
⚠️ **記下每一個在 `cluster` 下失敗的測試——那就是你上線前要修的清單。**

---

## 13.13 下一章預告

這一章（以及前面每一章）的結論，全都建立在**你自己跑過的實驗**上。
14 章要回答的是：**這些實驗怎麼變成 CI 裡每天都會跑的測試？**

- **Testcontainers Redis**：讓整合測試真的起一台 Redis，而不是 mock。
  ⚠️ **包含起一組 Sentinel 與 Cluster**——13.10.1 那三個 profile 都要能被測到。
- `@DataRedisTest` 的限制，以及 embedded Redis 為什麼不推薦。
- ⚠️ **併發測試怎麼寫才測得出超賣**——12 章那張表裡的每一列，都要能在 CI 裡重跑。
- 連線池與命令延遲的指標：06 章那些設定值，上線後怎麼知道對不對。
- Java 端看到的 big key / hot key 症狀（02、03、12 章）。
- **上線檢查清單**：從 00 章到 13 章，每一條都對應到一節實測。

> 📌 **14 章的核心問題只有一個**：
> **這十四章講的每一個「⚠️」，怎麼讓它在上線之前就被一個紅色的測試擋下來？**
