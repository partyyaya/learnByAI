# 第 08 章：故障與降級

> 06 章與 07 章都小心地繞開同一句話：**「如果 Redis 掛了呢？」**
>
> 這一章正面回答它。而第一件事，是先把「快取掛掉」這個說法拆成**兩種完全不同的故障**：
>
> | | Redis **行程消失**（`docker stop`、OOM killer、機器重開） | Redis **還在但不回話**（`fork` 尖峰、慢 Lua、big key、swap、網路） |
> |---|---|---|
> | 你的請求 | **0 毫秒就失敗** | **每一個等滿 500 毫秒** |
> | 執行緒 | 沒被佔住 | **50 / 50 全滿** |
> | 使用者看到 | 100% 錯誤 | 36% 錯誤（其中一半是**根本排不進來**） |
> | 資料庫 | **一次都沒被查** | **一次都沒被查** |
>
> 📌 **注意最後一列。** 直覺會說「Redis 掛了，流量就全部壓到資料庫」——
> **在什麼都不做的預設設定下，資料庫連一次都沒被查到**，
> 因為請求在「讀快取」那一步就死了。**掛掉的不是快取，是你的服務。**
>
> 這一章用一個每秒 200 請求的壓測骨架，把三層防線一層一層加上去，每一層都量一次：
>
> | 做法 | 錯誤率 | 被拒絕 | p50 延遲 | 資料庫 |
> |---|---|---|---|---|
> | 什麼都不做（Redis 消失） | **100%** | 0% | 0 ms | 0 次/秒 |
> | 什麼都不做（Redis 不回話） | 18.9% | 17.5% | **503 ms** | 0 次/秒 |
> | ＋ `CacheErrorHandler`（Redis 消失） | **0%** | 0% | 34 ms | **200 次/秒（12.3 倍）** |
> | ＋ `CacheErrorHandler`（Redis 不回話） | 0% | **26.4%** | **1,042 ms** | 50 次/秒 |
> | ＋ 熔斷器（Redis 不回話） | **0%** | **0%** | **34 ms** | 200 次/秒 |
> | ＋ 本地快取兜底 | **0%** | **0%** | **0 ms** | **22 次/秒（1.0 倍）** |
>
> 最後一列的意思是：**Redis 整台消失 60 秒，使用者與資料庫都感覺不到。**
> 這一章的產出就是那份演練報告（8.10）。
>
> ⚠️ **本章會 `docker stop` / `pause` 你的 `redis-lab` 容器，而且每個演練要跑 20～90 秒。**
> **每個實驗請單獨跑**（`mvn -Dtest=類別#方法 test`）——
> 上一個演練會讓 Lettuce 停在重連狀態，影響下一個的數字。

---

## 8.1 學習目標

完成本章後，你應該可以：

- 分辨「Redis 行程消失」與「Redis 不回話」兩種故障，並說出它們對你的服務**完全不同**的影響（8.2）。
- 說出為什麼在預設設定下，Redis 掛掉時**資料庫一次都不會被查到**（8.2.3）。
- 用 `CacheErrorHandler` 讓快取故障降級成「沒有快取」，並說出它的**四個方法裡哪一個不能只是吞掉**（8.3）。
- 說明為什麼「把逾時設短」不等於「有保護」，並用 Little's Law 算出你的服務在什麼延遲下會開始拒絕請求（8.4.1）。
- 寫出一個快取熔斷器，說明它為什麼要**丟例外而不是回 `null`**，以及它與 `CacheErrorHandler` 的依賴關係（8.4）。
- 說出熔斷期間 `evict` **為什麼不能跳過**（8.4.4）。
- 算出「快取命中率 95% 的服務，快取掛掉時資料庫承受幾倍流量」，並用本地快取把它壓回 1 倍（8.5）。
- 指出 `/actuator/health` 的預設行為會讓**整個叢集一起從負載平衡上消失**，並設定正確的 readiness 群組（8.6）。
- 說出「Redis 回來了」之後還有第二波，以及本地快取**救不了**哪一種（8.7）。
- 針對不同的 API 決定降級成什麼：舊資料、預設值、503、還是直接擋住（8.8）。
- 跑完一次「Redis 消失 60 秒」的演練，並產出一份報告（8.10）。

---

## 8.2 先量一次：Redis 掛掉的那幾十秒

### 8.2.1 演練骨架

要看到真正的失敗模式，壓測骨架必須長得像一個真的 Web 應用：

```java
class Drill {

    static final int THREADS = 50;        // ≒ Tomcat 的 maxThreads
    static final int QUEUE   = 100;       // ≒ acceptCount
    static final int RATE    = 200;       // 每秒打進來的請求數

    // 固定速率送進來（使用者不會因為你變慢就少按幾次），
    // 用一個「有上限的執行緒池 + 有上限的佇列」處理，滿了就直接拒絕（＝ 503）
    ThreadPoolExecutor pool = new ThreadPoolExecutor(THREADS, THREADS, 0, SECONDS,
            new ArrayBlockingQueue<>(QUEUE), new ThreadPoolExecutor.AbortPolicy());
    ...
}
```

> 📌 **這個設計有一個關鍵**：**送進來的速率是固定的，不會因為你變慢而變慢。**
>
> 很多壓測工具是「跑完一個再送下一個」（closed model），
> 那種壓測**永遠測不出執行緒耗盡**——因為你變慢，它就自動少送一點。
> **真實世界不是那樣。** 使用者按了沒反應會再按一次，而不是耐心等你。

每一秒印一列：送出 / 完成 / 失敗 / **被拒絕** / p50 / p99 / **這一秒資料庫被查幾次** / **忙碌執行緒**。

被測的就是 07 章那個 `ProductService.findById()`（`@Cacheable`，資料庫查詢固定 30 毫秒）。

### 8.2.2 實測①：什麼都不做，Redis 行程消失

```java
Drill.run("", 25,
        id -> service.findById(id),
        service::getDbHits,
        Map.of(
                5,  new Object[]{"◀ docker stop redis-lab",  (Runnable) () -> Drill.docker("stop", "redis-lab")},
                15, new Object[]{"◀ docker start redis-lab", (Runnable) () -> Drill.docker("start", "redis-lab")}
        ));
```

```
═══ 8.2.2 什麼都不做：Redis 掛掉 10 秒 ═══
（每秒 200 個請求，50 個工作執行緒 + 100 個佇列，資料庫查詢固定 30 毫秒）

  秒 | 送出  完成  失敗  拒絕 |  p50    p99  | DB查詢 | 忙碌執行緒 | 事件
  ---+----------------------+--------------+--------+------------+------
   0 |  200   200     0     0 |     1     64 |     20 |      0/50  |
   1 |  200   200     0     0 |     1      2 |      0 |      0/50  |
   ...
   4 |  200   200     0     0 |     0      1 |      0 |      0/50  |
   5 |  200   200   200     0 |     0      0 |      0 |      0/50  | ◀ docker stop redis-lab
   6 |  200   200   200     0 |     0      2 |      0 |      0/50  |
   ...
  15 |  200   200   200     0 |     0      0 |      0 |      0/50  | ◀ docker start redis-lab
   ...
  21 |  200   200   200     0 |     0      0 |      0 |      0/50  |
  22 |  200   200   112     0 |     0     37 |     20 |      0/50  |
  23 |  200   200     0     0 |     1      1 |      0 |      0/50  |
  24 |  200   200     0     0 |     0      1 |      0 |      0/50  |
  總計：送出 5,000，失敗 3,523（70.5%），被拒絕 0（0.0%），使用者看得到的錯誤率 = 70.5%，耗時 25.6 秒
  失敗的種類：
     3,523 次  RedisSystemException → SocketException: Connection reset
```

### 8.2.3 三個違反直覺的數字

**① 錯誤率 100%，而且是「每一個請求」**

```
   5 |  200   200   200     0 |
              └───┴── 完成 200 個，失敗 200 個
```

**不是「快取沒命中所以變慢」，是「這個 API 壞了」。**
`@Cacheable` 讀不到快取時的預設行為是**把例外往上丟**——
07 章 7.6.1 已經在「反序列化失敗」上看過同一件事，這裡是「連不上」的版本。

**② 資料庫一次都沒被查到**

```
  DB查詢 | 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
```

> ⚠️ **這是這一章最需要先破除的直覺。**
> 「Redis 掛了，流量就全部壓到資料庫」——**在預設設定下不會**，
> 因為 `@Cacheable` 的順序是：
>
> ```
> 讀快取 ──✗ 拋例外──▶ 請求結束（500）
>        └─ 你的方法根本沒被呼叫，所以資料庫沒被查
> ```
>
> **資料庫雪崩要等到你把第一層防線裝上去才會發生**（8.3.2 就會看到 12.3 倍）。
> 換句話說：**這兩個問題必須一起解決**，只解一半會從「服務掛掉」變成「資料庫掛掉」。

**③ 失敗只花 0 毫秒，執行緒一個都沒被佔住**

```
  p50 = 0 ms，忙碌執行緒 = 0/50，拒絕 = 0
```

連線已經確定斷了，所以 `getConnection()` 直接拋例外——**它是一個很「健康」的失敗**：
快、不佔資源、不會拖垮別人。

> 📌 **記住這個組合：100% 錯誤率 + 0 毫秒延遲 + 0 資源佔用。**
> 它代表**這個故障很好處理**——你只要接住那個例外就好（8.3）。
> 下一節那個才是難的。

**另外注意恢復**：`docker start` 在第 15 秒，但要到**第 22 秒**才恢復正常。
中間那 7 秒是 Lettuce 的重連退避（06 章 6.8.4 的 `ConnectionWatchdog`）。
**「Redis 起來了」跟「你的服務好了」之間有好幾秒的落差。**

### 8.2.4 實測②：Redis 還在，但不回話

`docker pause` 把容器裡的行程凍結（06 章 6.8.3）。這模擬的是更常見的那一種故障：
**04 章的 `fork` 尖峰、05 章的慢 Lua、03 章的 big key `DEL`、機器開始 swap。**

```
═══ 8.2.4 另一種故障：Redis 還在，但不回話 ═══

  秒 | 送出  完成  失敗  拒絕 |  p50    p99  | DB查詢 | 忙碌執行緒 | 事件
  ---+----------------------+--------------+--------+------------+------
   4 |  200   200     0     0 |     0      1 |      0 |      0/50  |
   5 |  200    50    50     0 |   503    505 |      0 |     50/50  | ◀ docker pause redis-lab
   6 |  200   100   100   100 |   504    505 |      0 |     50/50  |
   7 |  200   100   100   100 |   503    505 |      0 |     50/50  |
   8 |  200   100   100   100 |   504    505 |      0 |     50/50  |
   9 |  200   100   100   100 |   503    505 |      0 |     50/50  |
  10 |  200   100   100   100 |   503    505 |      0 |     50/50  |
  11 |  200   100   100   100 |   503    505 |      0 |     50/50  |
  12 |  200   100   100   100 |   503    505 |      0 |     50/50  |
  13 |  200   200     0     0 |     0      1 |      0 |      0/50  | ◀ docker unpause redis-lab
  總計：送出 4,000，失敗 756（18.9%），被拒絕 700（17.5%），使用者看得到的錯誤率 = 36.4%，耗時 20.2 秒
  失敗的種類：
       756 次  QueryTimeoutException → RedisCommandTimeoutException: Command timed out after 500 millisecond(s)
```

**這一次完全不一樣**：

| | 行程消失 | **不回話** |
|---|---|---|
| p50 | 0 ms | **503 ms**（＝你設的 `timeout: 500ms`） |
| 忙碌執行緒 | 0 / 50 | **50 / 50** |
| 每秒完成 | 200 | **100**（吞吐量腰斬） |
| 被拒絕 | 0 | **100 / 秒** |

> ⚠️ **「被拒絕」那一欄是新東西**，而它代表的是**真正的災難**：
> 50 個執行緒全部卡在 Redis 上 → 佇列（100）在 0.6 秒內塞滿 →
> **接下來每秒有 100 個請求連排隊都排不進去，直接 503。**
>
> 而且這 100 個被拒絕的請求裡，**大部分根本不需要碰 Redis**——
> 它們可能是健康檢查、可能是登入、可能是完全不用快取的 API。
> **一個快取的問題，變成整台機器的問題。**
>
> 📌 這正是 03 章 3.7.2 那個實驗的完整版：
> 那時候只看到「20 個執行緒全部卡住」，現在你看到了後果。

### 8.2.5 兩種故障，兩種完全不同的形狀

```
行程消失 ──▶ 快速失敗 ──▶ 錯誤率 100%，但資源沒被佔用
                          └── 好處理：接住例外就好（8.3）

不回話   ──▶ 慢速失敗 ──▶ 執行緒被佔滿 ──▶ 連不相關的 API 一起死
                          └── 難處理：必須「主動放棄」（8.4 熔斷）
```

> 📌 **一句話**：
> **「Redis 掛掉」比「Redis 變慢」好處理得多。**
> 而正式環境裡，**「變慢」發生的次數遠多於「掛掉」**——
> 04 章的每一次 `fork`、05 章的每一段慢 Lua、03 章的每一個 big key，都是一次小型的 8.2.4。

---

## 8.3 第一層：`CacheErrorHandler`

### 8.3.1 四個方法，四種語意

Spring Cache 有一個專門的擴充點，處理「快取層自己出錯」：

```java
public interface CacheErrorHandler {
    void handleCacheGetError(RuntimeException e, Cache cache, Object key);
    void handleCachePutError(RuntimeException e, Cache cache, Object key, Object value);
    void handleCacheEvictError(RuntimeException e, Cache cache, Object key);
    void handleCacheClearError(RuntimeException e, Cache cache);
}
```

**預設實作是 `SimpleCacheErrorHandler`，它四個方法都只做一件事：`throw e;`**
——這就是 8.2.2 那個 100% 錯誤率的來源。

換掉它：

```java
public class DegradingCacheErrorHandler implements CacheErrorHandler {

    @Override
    public void handleCacheGetError(RuntimeException e, Cache cache, Object key) {
        getErrors.incrementAndGet();
        log.debug("快取讀取失敗，當作沒命中：{}::{}", cache.getName(), key, e);
    }

    @Override
    public void handleCachePutError(RuntimeException e, Cache cache, Object key, Object value) {
        putErrors.incrementAndGet();
        log.debug("快取寫入失敗，這一筆沒寫進去：{}::{}", cache.getName(), key, e);
    }

    @Override
    public void handleCacheEvictError(RuntimeException e, Cache cache, Object key) {
        evictErrors.incrementAndGet();
        // ⚠️ 這一個不能只是 debug —— 它代表快取裡可能留著已經過期的資料
        log.warn("快取清除失敗，快取裡可能留著舊資料：{}::{}", cache.getName(), key, e);
    }

    @Override
    public void handleCacheClearError(RuntimeException e, Cache cache) {
        evictErrors.incrementAndGet();
        log.warn("快取清空失敗：{}", cache.getName(), e);
    }
}
```

⚠️ **四個方法的語意不一樣，這是這一節最重要的一件事**：

| 方法 | 吞掉之後會怎樣 | 安全嗎 |
|---|---|---|
| `get` 失敗 | 等於「沒命中」→ 呼叫端去資料庫拿 | ✅ **安全**，只是慢一點 |
| `put` 失敗 | 等於「這次沒寫進快取」→ 下次還是沒命中 | ✅ **安全** |
| **`evict` 失敗** | **快取裡留著舊資料，而資料庫已經改了** | ❌ **不安全——這是資料不一致** |
| `clear` 失敗 | 同上 | ❌ 同上 |

> ⚠️ **`evict` 失敗是唯一會造成「錯誤資料」的一個**，而且它會一直錯到 TTL 到期
> （07 章 7.7.3 那個 stale forever 的另一個入口）。
>
> **所以 `evict` 的失敗必須記 `warn` 以上、必須接告警，而且理想上要重試。**
> 07 章 7.9.4 那張「該接告警的指標」要再加一條：**快取清除失敗次數**。

掛上去：

```java
@Configuration
@EnableCaching
public class CacheConfig implements CachingConfigurer {

    @Value("${lab10.cache.degrade-on-failure:false}")
    private boolean degradeOnFailure;

    /** ⚠️ 回傳 null 代表「用 Spring 的預設」＝ SimpleCacheErrorHandler ＝ 把例外原封不動往上丟 */
    @Override
    public CacheErrorHandler errorHandler() {
        return degradeOnFailure ? degradingCacheErrorHandler() : null;
    }
}
```

📌 **`CachingConfigurer` 在一個應用裡只能有一個**（有兩個會啟動失敗），
所以它通常就實作在你的 `CacheConfig` 上。

### 8.3.2 實測：Redis 消失

```
═══ 8.3.2 裝上 CacheErrorHandler：Redis 掛掉 ═══

  秒 | 送出  完成  失敗  拒絕 |  p50    p99  | DB查詢 | 忙碌執行緒 | 事件
  ---+----------------------+--------------+--------+------------+------
   4 |  200   200     0     0 |     0      2 |      0 |      0/50  |
   5 |  200   194     0     0 |    34     36 |    200 |      6/50  | ◀ docker stop
   6 |  200   199     0     0 |    34     36 |    200 |      7/50  |
   7 |  200   199     0     0 |    34     36 |    200 |      7/50  |
   ...
  13 |  200   194     0     0 |    34     36 |    200 |      6/50  | ◀ docker start
  14 |  200   206     0     0 |     1     36 |     54 |      0/50  |
  15 |  200   200     0     0 |     1      2 |      0 |      0/50  |
  總計：送出 4,000，失敗 0（0.0%），被拒絕 0（0.0%），使用者看得到的錯誤率 = 0.0%，耗時 20.6 秒

  快取層吞掉的錯誤：get 1,840 次、put 1,834 次、evict 0 次
```

**錯誤率 70.5% → 0%。一行設定。**

| | 8.2.2 | 8.3.2 |
|---|---|---|
| 錯誤率 | **70.5%** | **0%** |
| p50 | 0 ms | 34 ms（＝資料庫查詢時間） |
| **資料庫** | **0 次/秒** | **200 次/秒** ⚠️ |

⚠️ **看最後一列**：資料庫從 0 變成 200 次/秒。
**「服務掛掉」換成了「資料庫承受全部流量」**——8.5 會量這是幾倍、以及怎麼辦。

順帶一提 `get 1,840 次、put 1,834 次`：**一個沒命中的請求會碰兩次 Redis**（讀一次、寫一次）。
這個「兩次」在下一節會變成 1042 毫秒。

### 8.3.3 實測：Redis 不回話——它**沒有**解決

```
═══ 8.3.3 裝上 CacheErrorHandler：Redis 還在但不回話 ═══

  秒 | 送出  完成  失敗  拒絕 |  p50    p99  | DB查詢 | 忙碌執行緒 | 事件
  ---+----------------------+--------------+--------+------------+------
   4 |  200   200     0     0 |     0      2 |      0 |      0/50  |
   5 |  200     0     0    50 |     -      - |     50 |     50/50  | ◀ docker pause
   6 |  200    50     0   150 |  1042   1052 |     50 |     50/50  |
   7 |  200    50     0   150 |  1042   1046 |     50 |     50/50  |
   8 |  200    50     0   150 |  1043   1046 |     50 |     50/50  |
   ...
  11 |  200    50     0   150 |  1039   1045 |     50 |     50/50  |
  12 |  200   200     0     0 |     0      2 |      0 |      0/50  | ◀ docker unpause
  總計：送出 3,600，失敗 0（0.0%），被拒絕 950（26.4%），使用者看得到的錯誤率 = 26.4%，耗時 18.1 秒
```

**`失敗 = 0`，但 `拒絕 = 150 / 秒`，p50 = 1042 毫秒。**

> 📌 **`CacheErrorHandler` 把「明確的失敗」換成了「很慢的成功」，而慢本身就是一種故障。**
>
> 使用者看到的錯誤率從 36.4% 變成 26.4%——**只降了 10 個百分點**，
> 因為主要的錯誤來源不是例外，是**排不進來**。

### 8.3.4 那 1042 毫秒是誰的

把一個請求拆成三段，在壓力下分別量：

```java
long t1 = System.nanoTime();
Cache.ValueWrapper w = null;
try { w = cache.get(id); } catch (Exception ignored) {}     // ① 讀快取
long t2 = System.nanoTime();
if (w == null) {
    Product p = service.findByIdWithoutCache(id);           // ② 查資料庫
    long t3 = System.nanoTime();
    try { cache.put(id, p); } catch (Exception ignored) {}  // ③ 寫快取
}
```

```
【停掉之前】讀快取平均     1.1 ms（1,000 次）／查資料庫平均   33.7 ms（20 次）／寫快取平均     3.0 ms（20 次）
【故障期間】讀快取平均     0.1 ms（1,200 次）／查資料庫平均   34.0 ms（1,194 次）／寫快取平均     0.1 ms（1,194 次）
```

這是 **`docker stop`** 的情況——三段都很快，所以 8.3.2 的 p50 才會是 34 毫秒。

換成 **`docker pause`** 就完全不同了：

```
1042 ms  ≈  500 ms（讀快取逾時）  +  30 ms（資料庫）  +  500 ms（寫快取逾時）
             ↑ timeout: 500ms                            ↑ 同一個逾時，再付一次
```

> ⚠️ **一個「沒命中」的請求要付兩次逾時。**
> 這是 06 章 6.8.3 那句「命令逾時是每次呼叫的，不是熔斷」的具體代價：
> 你把逾時從 60 秒調到 500 毫秒，**一個請求還是要花 1 秒**。
>
> 📌 **而且你不能把逾時再調小**：
> 逾時要能容忍正常的網路抖動與 GC（06 章 6.9.1 選 500 毫秒是有理由的），
> 調到 50 毫秒的話，**平常就會開始出現假性逾時**。
>
> **所以逾時這條路到這裡走到底了。下一層必須是「主動不去碰它」。**

### 8.3.5 ⚠️ `CacheErrorHandler` 管不到 `RedisTemplate`

```java
@Autowired StringRedisTemplate redis;

public boolean tryLock(String key) {
    return redis.opsForValue().setIfAbsent(key, token, Duration.ofSeconds(30));   // ← 這一行
}
```

**`CacheErrorHandler` 只攔 `@Cacheable` / `@CacheEvict` / `@CachePut` 這一套。**
任何直接用 `RedisTemplate` 的程式碼——分散式鎖（09 章）、限流（10 章）、
Session（11 章）、預扣庫存（12 章）——**例外會照樣往上丟。**

而那才是對的，因為**它們不該降級**：

| 用途 | Redis 掛掉時該怎麼辦 |
|---|---|
| 物件快取（`@Cacheable`） | ✅ **降級**：去資料庫拿 |
| 限流（10 章） | ⚠️ **看你的取捨**：放行（可能被打爆）還是拒絕（誤殺正常使用者）。8.8 會決定 |
| **分散式鎖（09 章）** | ❌ **絕對不能降級**。拿不到鎖就是拿不到鎖，「當作拿到了」等於超賣 |
| **預扣庫存（12 章）** | ❌ **不能降級**。直接失敗 |
| Session（11 章） | ⚠️ 等於「所有人被登出」。通常選擇直接失敗 |

> 📌 **這張表是 8.8 那張降級決策表的雛形**，而它的分界線是：
> **快取是「效能優化」，掉了只是變慢；鎖與計數是「正確性機制」，掉了就是錯。**

---

## 8.4 第二層：熔斷

### 8.4.1 先算一次：你的服務在什麼延遲下開始拒絕請求

不需要壓測就能算出 8.3.3 那個結果。用 **Little's Law**：

```
需要的並行數 = 到達速率 × 每個請求的耗時
```

| | 平常 | Redis 不回話時 |
|---|---|---|
| 到達速率 | 200 req/s | 200 req/s（**使用者不會因為你慢就少按**） |
| 每個請求耗時 | 0.001 s | **1.042 s** |
| **需要的並行數** | **0.2 個執行緒** | **208 個執行緒** |
| 你有幾個 | 50 | 50 |
| 結果 | 綽綽有餘 | **差 158 個** → 佇列（100）在 0.6 秒內填滿 → **之後每秒拒絕 150 個** |

實測：`拒絕 150 / 秒`。**算出來的跟量到的一樣。**

> 📌 **把這個公式記起來，它可以直接算你自己的系統**：
>
> ```
> 你撐得住的最大延遲 = 執行緒數 ÷ 到達速率
>                    = 50 ÷ 200 = 0.25 秒
> ```
>
> **也就是說：只要每個請求超過 250 毫秒，這台機器就開始堆積。**
> 而你的 Redis 逾時是 500 毫秒，一個請求要付兩次 = 1 秒。
>
> **結論：逾時設多少都救不了，因為「一個請求要等 Redis 兩次」這件事本身就超標。**
> 唯一的辦法是**根本不要去等**——這就是熔斷。

### 8.4.2 一個夠用的熔斷器

三個狀態、三個參數，一百行以內：

```java
public class CacheCircuitBreaker {

    public enum State { CLOSED, OPEN, HALF_OPEN }

    private final int failureThreshold;    // 連續失敗幾次就跳閘
    private final long openMillis;         // 跳閘後多久才試探

    private volatile State state = State.CLOSED;
    private final AtomicInteger consecutiveFailures = new AtomicInteger();
    private final AtomicLong openedAt = new AtomicLong();
    private final AtomicInteger probeInFlight = new AtomicInteger();   // HALF_OPEN 只放一個出去

    /** 這一次要不要真的去碰 Redis */
    public boolean allowRequest() {
        State s = state;
        if (s == State.CLOSED) return true;
        if (s == State.OPEN) {
            if (System.currentTimeMillis() - openedAt.get() < openMillis) { skipped.incrementAndGet(); return false; }
            state = State.HALF_OPEN;
            probeInFlight.set(0);
        }
        if (probeInFlight.compareAndSet(0, 1)) return true;   // HALF_OPEN：只放一個
        skipped.incrementAndGet();
        return false;
    }

    public void onSuccess() {
        consecutiveFailures.set(0);
        if (state != State.CLOSED) { state = State.CLOSED; probeInFlight.set(0); }
    }

    public void onFailure() {
        probeInFlight.set(0);
        if (state == State.HALF_OPEN || consecutiveFailures.incrementAndGet() >= failureThreshold) {
            state = State.OPEN;
            openedAt.set(System.currentTimeMillis());
        }
    }
}
```

```
   CLOSED（正常）──連續失敗 >= 5 次──▶ OPEN（跳閘，5 秒內完全不碰 Redis）
        ▲                                    │
        │                              過了 5 秒
        │                                    ▼
        └──────成功────── HALF_OPEN（只放一個請求出去試）
                                 └──失敗──▶ OPEN（重新計時）
```

### 8.4.3 ⚠️ 跳閘的時候要回 `null` 還是丟例外

包在 `Cache` 外面：

```java
public class CircuitBreakingCache implements Cache {

    private <T> T guard(Supplier<T> call) {
        if (!breaker.allowRequest()) throw new CacheUnavailableException(getName());   // ← 注意這裡
        try {
            T r = call.get();
            breaker.onSuccess();
            return r;
        } catch (RuntimeException e) {
            breaker.onFailure();
            throw e;                      // 交給 CacheErrorHandler 吞掉（8.3）
        }
    }

    @Override public ValueWrapper get(Object key) { return guard(() -> delegate.get(key)); }
    @Override public void put(Object key, Object value) { guard(() -> { delegate.put(key, value); return null; }); }
    ...
}
```

**跳閘時直接 `return null` 看起來更自然**（`null` 就是「沒命中」嘛），但那是錯的：

| | `return null` | **`throw CacheUnavailableException`** |
|---|---|---|
| 意思 | 「快取裡沒這一筆」 | 「**這一刻我不去問快取**」 |
| 上層有本地兜底時（8.5.3） | ❌ **兜底永遠不會被用到** | ✅ 兜底接得到 |
| 統計 | 混進正常的 miss 裡，看不出來 | ✅ 熔斷次數是獨立指標 |
| 沒有兜底時 | 直接當 miss | `CacheErrorHandler` 吞掉，效果一樣 |

> ⚠️ **所以熔斷器必須跟 `CacheErrorHandler` 一起上線。**
> 只裝熔斷器不裝 `CacheErrorHandler`，跳閘的那一刻**每個請求都會拿到 `CacheUnavailableException`**——
> 你會親手造出 8.2.2 那個 100% 錯誤率。

### 8.4.4 ⚠️ `evict` 不能跳過

```java
/** ⚠️ evict 與 clear 即使跳閘也要試 —— 跳過它等於讓舊資料留在快取裡 */
@Override public void evict(Object key) { delegate.evict(key); }
@Override public void clear() { delegate.clear(); }
```

理由跟 8.3.1 那張表一樣，但更嚴重：

```
熔斷跳閘中
  → 有人改了商品價格
  → @CacheEvict 被「跳過」（因為熔斷）
  → 5 秒後 Redis 恢復
  → 快取裡那筆舊價格還在，而且沒有任何人會再去清它
  → 錯到 TTL 到期（30 分鐘）
```

> 📌 **熔斷器保護的是「讀」的路徑，不是「寫」的路徑。**
> 讀失敗的代價是「慢」，寫（清除）失敗的代價是「錯」。
> **能被熔斷跳過的，只有那些「跳過了也只是變慢」的操作。**
>
> 代價是：跳閘期間每一次 `evict` 還是會付一次逾時。
> 但 `evict` 的頻率遠低於 `get`（讀多寫少才需要快取），所以這個代價是划算的。

### 8.4.5 實測

```java
@SpringBootTest(properties = {
        "lab10.cache.degrade-on-failure=true",
        "lab10.cache.circuit-breaker.enabled=true",
        "lab10.cache.circuit-breaker.failure-threshold=5",
        "lab10.cache.circuit-breaker.open-millis=3000"
})
```

```
═══ 8.4.5 加上熔斷器：Redis 還在但不回話 ═══
（連續 5 次失敗就跳閘，跳閘後 3 秒內完全不碰 Redis）

  秒 | 送出  完成  失敗  拒絕 |  p50    p99  | DB查詢 | 忙碌執行緒 | 事件
  ---+----------------------+--------------+--------+------------+------
   4 |  200   200     0     0 |     0      2 |      0 |      0/50  |
   5 |  200   194     0     0 |    35    545 |    200 |      6/50  | ◀ docker pause
   6 |  200   200     0     0 |    34     36 |    200 |      6/50  |
   7 |  200   199     0     0 |    34     36 |    200 |      7/50  |
   8 |  200   199     0     0 |    34     35 |    199 |      7/50  |
   ...
  11 |  200   200     0     0 |    34     36 |    200 |      6/50  |
  12 |  200   200     0     0 |     0     36 |     36 |      0/50  | ◀ docker unpause
  總計：送出 3,600，失敗 0（0.0%），被拒絕 0（0.0%），使用者看得到的錯誤率 = 0.0%，耗時 18.2 秒

  熔斷器：跳閘 2 次，期間直接跳過 Redis 2,814 次，最後狀態 = CLOSED
```

**同一個故障，三種結果**：

| | 錯誤率 | 被拒絕 | p50 | 每秒完成 |
|---|---|---|---|---|
| 什麼都不做 | 18.9% | 17.5% | 503 ms | 100 |
| ＋ `CacheErrorHandler` | 0% | **26.4%** | **1,042 ms** | 50 |
| **＋ 熔斷器** | **0%** | **0%** | **34 ms** | **200** |

三個細節值得看：

**① 第 5 秒的 `p99 = 545 ms`。** 跳閘之前總要先失敗幾次——
那是「連續 5 次失敗」的學費，付一次就好。

**② 「跳閘 2 次」。** 第一次跳閘 3 秒後進 HALF_OPEN，探針出去發現 Redis 還是不回話（又付了一次 500 毫秒），
於是**重新跳閘**。整個故障期間只有 2 個請求真的去碰了 Redis。

**③ 最後狀態 = CLOSED。** `unpause` 之後，下一次 HALF_OPEN 的探針成功，自動恢復——
**不需要任何人去按按鈕。**

> 📌 **`open-millis` 怎麼選**：
> 太短（0.5 秒）→ 探針太頻繁，每次探針都要付一次逾時，等於沒熔斷。
> 太長（60 秒）→ Redis 恢復了你還要再等一分鐘。
> **3～10 秒是合理的區間**，而且要滿足：`open-millis ≫ 一次逾時`（500 毫秒）。

### 8.4.6 要不要用 Resilience4j

上面那一百行足以說明機制，但正式環境建議用現成的：

```java
CircuitBreakerConfig config = CircuitBreakerConfig.custom()
        .slidingWindowType(SlidingWindowType.COUNT_BASED)
        .slidingWindowSize(100)
        .failureRateThreshold(50)                          // 100 次裡有 50 次失敗才跳
        .slowCallDurationThreshold(Duration.ofMillis(200))  // ⚠️ 「慢」也算失敗
        .slowCallRateThreshold(50)
        .waitDurationInOpenState(Duration.ofSeconds(5))
        .permittedNumberOfCallsInHalfOpenState(3)
        .build();
```

| | 自己寫的（8.4.2） | Resilience4j |
|---|---|---|
| 觸發條件 | **連續**失敗 N 次 | **滑動窗內的失敗率**（更穩，不會被偶發失敗誤觸） |
| **把「慢」當失敗** | ❌ 要自己加 | ✅ `slowCallDurationThreshold` |
| HALF_OPEN 放幾個 | 1 個 | 可設 |
| 指標 | 自己數 | ✅ 內建 Micrometer |
| 相依 | 無 | 一個 jar |

> 📌 **`slowCallDurationThreshold` 是自己寫的版本最該補上的東西。**
> 因為 8.2.4 那種故障不是「失敗」，是「**很慢但成功**」——
> Redis 花 450 毫秒回了一個正確答案，你的熔斷器**永遠不會跳**，
> 但你的執行緒已經在耗盡了。**「慢」必須算失敗。**

### 8.4.7 回到 06 章：`REJECT_COMMANDS` 這時候可以打開了

06 章 6.9.2 留了一個 TODO：

```java
.disconnectedBehavior(ClientOptions.DisconnectedBehavior.DEFAULT)  // 08 章會改
```

06 章 6.8.4 量過：Redis 停掉之後，`DEFAULT` 每個請求等 507 毫秒，`REJECT_COMMANDS` 只要 1 毫秒。
當時不敢改，因為「快速失敗」在沒有降級邏輯時等於「快速出錯」。

**現在三層都有了，可以改了**：

```java
.disconnectedBehavior(ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
```

| 這三個東西的分工 | 擋什麼 |
|---|---|
| `REJECT_COMMANDS`（Lettuce 層） | **連線確定斷掉**時，不要把命令收下來排隊 |
| **熔斷器**（應用層） | **連線還在、但對面很慢**時，主動不去碰 |
| `CacheErrorHandler`（Spring Cache 層） | 上面兩者丟出來的例外，**不要變成使用者的錯誤** |

⚠️ **`REJECT_COMMANDS` 的代價**：連線抖動的那 0.2 秒，本來會自動補上的命令現在會失敗。
有了 `CacheErrorHandler` 之後這個代價是可以接受的——**它只是一次快取沒命中**。
但這也是 8.3.5 那張表的理由：**分散式鎖的路徑上，這 0.2 秒的失敗是真的失敗。**

---

## 8.5 第三層：不要讓快取故障變成資料庫雪崩

### 8.5.1 算一次：命中率決定倍數

8.3.2 讓錯誤率歸零，代價是資料庫從 0 變成 200 次/秒。**那是幾倍？**

```
平常資料庫承受的 =  總流量 × (1 - 命中率)
快取掛掉時       =  總流量
倍數             =  1 ÷ (1 - 命中率)
```

| 快取命中率 | 快取掛掉時資料庫承受 |
|---|---|
| 80% | **5 倍** |
| 90% | **10 倍** |
| 95% | **20 倍** |
| 99% | **100 倍** |
| 99.9% | **1000 倍** |

> ⚠️ **這張表要倒過來讀**：
> **你的快取命中率越高，快取掛掉時的災難越大。**
>
> 一個命中率 99% 的服務，資料庫平常只承受 1% 的流量——
> 所以**沒有人會替資料庫準備 100 倍的餘裕**，
> 於是快取一掛，資料庫在幾秒內就會連線池滿、查詢排隊、然後一起掛掉。
>
> **而資料庫掛掉之後，Redis 就算馬上恢復也沒有用**——
> 快取是空的，恢復的第一波流量又會把剛爬起來的資料庫再打一次（8.7）。

### 8.5.2 實測：12.3 倍

換一個更真實的資料集：**500 個商品，八二分布**（80% 的流量集中在 20 個熱門商品）。

```java
private static long pick(int i) {
    ThreadLocalRandom r = ThreadLocalRandom.current();
    return r.nextInt(100) < 80 ? BASE + r.nextLong(HOT)      // 80% 打在前 20 個
                               : BASE + r.nextLong(TOTAL);   // 20% 散在 500 個
}
```

```
═══ 8.5 Redis 故障時資料庫承受多少（本地兜底 = 沒有）═══
（500 個商品、八二分布、每秒 200 個請求）

  秒 | 送出  完成  失敗  拒絕 |  p50    p99  | DB查詢 | 忙碌執行緒 | 事件
  ---+----------------------+--------------+--------+------------+------
   0 |  200   200     0     0 |     1     38 |     15 |      0/50  |
   1 |  200   199     0     0 |     0     38 |     23 |      1/50  |
   2 |  200   201     0     0 |     1     39 |     18 |      0/50  |
   3 |  200   200     0     0 |     0     38 |      9 |      0/50  |
   4 |  200   194     0     0 |    34    544 |    200 |      6/50  | ◀ docker stop
   5 |  200   199     0     0 |    34     36 |    200 |      7/50  |
   ...
  11 |  200   194     0     0 |    34     36 |    200 |      6/50  | ◀ docker start
  12 |  200   200     0     0 |    34     35 |    200 |      6/50  |
  13 |  200   200     0     0 |    34     36 |    200 |      6/50  |
  14 |  200   205     0     0 |    33     36 |    152 |      1/50  |
  15 |  200   199     0     0 |     0     36 |     42 |      2/50  |
  總計：送出 3,200，失敗 0（0.0%），被拒絕 0（0.0%），使用者看得到的錯誤率 = 0.0%，耗時 16.6 秒

  故障前資料庫平均 16 次/秒 → 故障期間 200 次/秒（12.3 倍）
```

使用者完全沒事（0% 錯誤），**但資料庫承受了 12.3 倍**。

順帶注意 **11～13 秒**：`docker start` 之後資料庫還是 200 次/秒，
要到第 14 秒才降下來——**又是那幾秒的重連落差**（8.2.3）。

### 8.5.3 本地快取兜底

Redis 讀不到的時候，還有一個地方可以問：**這台機器自己的記憶體。**

```java
public class TwoLevelCache implements Cache {

    private final Cache redis;                          // Spring 的 RedisCache
    private final com.github.benmanes.caffeine.cache.Cache<Object, Object> local;

    @Override
    public ValueWrapper get(Object key) {
        try {
            ValueWrapper v = redis.get(key);
            if (v != null) {
                local.put(key, v.get() == null ? NULL : v.get());   // 順手備份一份
                return v;
            }
            return null;                                            // ⚠️ Redis 說「沒有」就是沒有
        } catch (RuntimeException e) {
            // ⚠️ 只有在「Redis 讀不到」的時候才拿本地的
            Object cached = local.getIfPresent(key);
            if (cached != null) {
                localHits.incrementAndGet();
                return new SimpleValueWrapper(cached == NULL ? null : cached);
            }
            throw e;                                                // 交給 CacheErrorHandler
        }
    }

    @Override public void put(Object key, Object value) { local.put(key, ...); redis.put(key, value); }

    /** ⚠️ 清除一定要兩級都清，而且本地要先清 */
    @Override public void evict(Object key) { local.invalidate(key); redis.evict(key); }
    @Override public void clear() { local.invalidateAll(); redis.clear(); }
}
```

**三個設計決定，每一個都有理由**：

| 決定 | 理由 |
|---|---|
| **Redis 回 `null` 時不看本地** | `null` 的意思是「快取裡沒有」，不是「快取壞了」。看本地會讀到**已經被別人清掉的舊資料** |
| **只有拋例外時才看本地** | 這就是 8.4.3 為什麼要丟 `CacheUnavailableException` 而不是回 `null` |
| **`evict` 先清本地再清 Redis** | 反過來的話，中間那一瞬間本地還留著舊值，而且會被讀到 |

**包覆順序也不能反**：

```
TwoLevelCache（本地兜底）
  └── CircuitBreakingCache（熔斷）
        └── TransactionAwareCacheDecorator（07 章 7.7.4）
              └── FailSoftRedisCache（07 章 7.6.4）
                    └── RedisCache
```

> ⚠️ **熔斷必須在本地兜底的「裡面」。**
> 反過來的話，跳閘時最外層就直接回了，**本地那一份永遠不會被用到**。

### 8.5.4 實測：1.0 倍

```
═══ 8.5 Redis 故障時資料庫承受多少（本地兜底 = 200 筆）═══

  秒 | 送出  完成  失敗  拒絕 |  p50    p99  | DB查詢 | 忙碌執行緒 | 事件
  ---+----------------------+--------------+--------+------------+------
   3 |  200   198     0     0 |     1     41 |     20 |      2/50  |
   4 |  200   200     0     0 |     0     38 |     29 |      0/50  | ◀ docker stop
   5 |  200   198     0     0 |     0     36 |     25 |      2/50  |
   6 |  200   202     0     0 |     0     37 |     18 |      0/50  |
   7 |  200   199     0     0 |     0     37 |     24 |      1/50  |
   ...
  11 |  200   199     0     0 |     0     37 |     21 |      1/50  | ◀ docker start
  總計：送出 3,200，失敗 0（0.0%），被拒絕 0（0.0%），使用者看得到的錯誤率 = 0.0%，耗時 16.5 秒

  故障前資料庫平均 22 次/秒 → 故障期間 22 次/秒（1.0 倍）
  本地兜底：命中 2,095 次、沒命中 263 次（命中率 88.8%），目前存了 200 筆
```

**12.3 倍 → 1.0 倍。** 而且 p50 從 34 毫秒回到 0 毫秒——
因為熱門商品**根本沒去資料庫**，直接從本機記憶體回。

📌 **只用了 200 筆的本地快取**（八二分布裡那 20 個熱門商品加上一些長尾），
就擋掉了 88.8% 的請求。**這就是為什麼本地快取兜底的投資報酬率極高**：
你不需要複製整個 Redis，只需要接住那幾個最熱的 key。

### 8.5.5 ⚠️ 本地兜底的三個限制

**① 它不能跨機器失效——所以 TTL 必須很短。**

這正是 00 章 0.2.2 選擇 Redis 的理由：四台機器要看到同一份資料。
本地那一份**不會**因為別台機器清了快取就跟著清。

```java
Caffeine.newBuilder()
        .maximumSize(1000)
        .expireAfterWrite(Duration.ofSeconds(120))    // ⚠️ 短，而且只在故障時才被讀到
        .build()
```

| TTL | 後果 |
|---|---|
| 60～120 秒 | ✅ 故障期間夠用，資料最多舊兩分鐘 |
| 10 分鐘 | ⚠️ 平常也會讀到兩分鐘前的資料嗎？**不會**（只有 Redis 拋例外時才讀），但故障期間會看到很舊的價格 |

**② 它救不了「Redis 還活著但資料沒了」**——8.7 會實測這件事。

**③ 它是一份重複的記憶體。** 1000 筆商品在每一台應用機器上各存一份。
所以 `maximumSize` 要保守，而且**只放那些「舊一點也沒關係」的東西**。

> 📌 **絕對不要放進本地兜底的**：庫存數量、餘額、權限、任何「錯了會出事」的資料。
> 本地兜底的語意是「**故障期間給你一份可能有點舊的資料，總比 500 好**」。
> 那句話對商品名稱成立，對庫存不成立。

### 8.5.6 最後一道：併發閘

本地兜底擋掉 88.8%，剩下的 11.2% 還是會打到資料庫。
如果連這個都要擋（例如資料庫本來就很吃緊），再加一個閘：

```java
private final Semaphore dbGate = new Semaphore(20);       // 最多 20 個查詢同時打資料庫

public Product findByIdGuarded(Long id) {
    if (!dbGate.tryAcquire()) {
        throw new ServiceUnavailableException("資料庫忙碌中");   // 明確的 503
    }
    try { return repo.findById(id).orElse(null); }
    finally { dbGate.release(); }
}
```

> 📌 **這是「艙壁（bulkhead）」模式**：與其讓資料庫被打爆、所有人一起死，
> **不如明確地放棄一部分請求，讓另一部分活下來。**
>
> 而且 `tryAcquire()` 是**立刻回**的——它不佔用執行緒（回到 8.4.1 的公式）。
> ⚠️ **不要用 `acquire()`**（會等），那等於把問題從資料庫搬到執行緒池。

---

## 8.6 ⚠️ 健康檢查：讓整個叢集一起消失的那一招

三層防線都做好了，服務在 Redis 掛掉時完全正常。**然後 Kubernetes 把你的每一個 Pod 都拿掉了。**

### 8.6.1 實測：Redis 掛掉，`/actuator/health` 回什麼

```java
@SpringBootTest(properties = {
        "management.endpoint.health.show-details=always",
        // readiness 只看「這台機器還能不能服務請求」—— 快取壞了還是能服務
        "management.endpoint.health.group.readiness.include=db"
})
```

```
═══ 8.6.1 Redis 掛掉，/actuator/health 回什麼 ═══
  【Redis 正常】
    /actuator/health                 → UP
        db         UP
        diskSpace  UP
        ping       UP
        redis      UP
    /actuator/health/readiness       → UP

  【Redis 掛掉】
    /actuator/health                 → DOWN          ← ⚠️
        db         UP
        diskSpace  UP
        ping       UP
        redis      DOWN
    /actuator/health/readiness       → UP            ← ✅

  【Redis 回來】
    /actuator/health                 → UP
        redis      UP
    /actuator/health/readiness       → UP
```

> ⚠️ **`spring-boot-starter-actuator` 一進 classpath，`RedisHealthIndicator` 就自動掛上去了**，
> 而且它是**聚合健康狀態的一部分**：**任何一個 indicator DOWN，整個 `/actuator/health` 就 DOWN。**
>
> 於是這條鏈就成立了：
>
> ```
> Redis 掛掉
>   → 你的降級做得很完美，服務照常回應 200
>   → 但 /actuator/health 回 DOWN
>   → Kubernetes 的 readinessProbe 失敗
>   → 這個 Pod 被從 Service 的 endpoints 拿掉
>   → 每一個 Pod 都連同一台 Redis，所以「每一個 Pod」都被拿掉
>   → 100% 的流量沒有地方去
> ```
>
> **你花了整整一章做的降級，被一個健康檢查端點抵銷了。**
> 而且更糟的是——這次**真的**全掛了，連本地兜底都沒機會被用到。

### 8.6.2 liveness、readiness 與「總健康」是三件事

| | 問題 | 答錯的後果 | Redis 掛掉時該回什麼 |
|---|---|---|---|
| **liveness** | 「這個行程是不是死了？要不要重啟？」 | **重啟你的服務**（重啟不會讓 Redis 回來，只會清空本地兜底） | **UP** |
| **readiness** | 「要不要把流量送進來？」 | **把這台機器從負載平衡上拿掉** | **UP**（你還能服務） |
| **總健康** `/actuator/health` | 「有沒有哪裡不對？」 | 給監控看的，觸發告警 | **DOWN**（確實不對，值得告警） |

> 📌 **三個問題的答案不一樣，所以不能用同一個端點。**
> 預設的 `/actuator/health` 是為了**第三個**問題設計的，
> 而大部分人把它接到**第二個**問題上。

### 8.6.3 怎麼設

```yaml
management:
  endpoint:
    health:
      show-details: when-authorized
      probes:
        enabled: true                 # 開啟 /health/liveness 與 /health/readiness
      group:
        readiness:
          # ⚠️ 只列出「壞了就真的不能服務」的東西
          include: readinessState, db
        liveness:
          include: livenessState
  health:
    redis:
      enabled: true                   # 保留它 —— 它該出現在總健康與告警裡
```

```yaml
# Kubernetes 那一側
readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 8080 }   # ⚠️ 不是 /actuator/health
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 8080 }
```

**三個常見的錯誤設定**：

| 設定 | 問題 |
|---|---|
| `readinessProbe → /actuator/health` | **本節整節在講的那件事** |
| `management.health.redis.enabled: false` | 解決了 readiness，但**也把 Redis 從告警裡拿掉了**——你再也不會知道 Redis 掛了 |
| readiness 包含 `db` 以外的一堆東西 | 任何一個下游服務抖一下，你的機器就被拿掉 |

> 📌 **判斷一個 indicator 該不該進 readiness，只問一句話**：
> **「它壞了的時候，把流量送到這台機器上，是不是比送到別台更糟？」**
> Redis 壞了時，**每一台都一樣壞**，所以把誰拿掉都沒有意義——**它不該進 readiness。**
>
> 反過來，如果是「這台機器自己的資料庫連線池壞了」，那把它拿掉是對的。

---

## 8.7 恢復才是第二波

### 8.7.1 實測：Redis 還活著，但快取空了

Redis 重啟、切換到一台空的從庫（13 章）、或是有人 `FLUSHALL`——
**這些情況下 Redis 完全健康，只是裡面沒有東西。**

```java
Drill.run("--- 正式演練 ---", 14,
        id -> service.findById(id),
        service::getDbHits,
        Map.of(4, new Object[]{"◀ 快取整個不見了", (Runnable) () -> srt.delete(srt.keys("lab10:v1:*"))}),
        F9RecoveryTest::pick);
```

```
═══ 8.7.1 Redis 還活著，但快取空了（重啟／切換到空的從庫／被 FLUSH）═══
  預熱完成：快取裡有 500 筆

  秒 | 送出  完成  失敗  拒絕 |  p50    p99  | DB查詢 | 忙碌執行緒 | 事件
  ---+----------------------+--------------+--------+------------+------
   0 |  200   200     0     0 |     1     35 |      0 |      0/50  |
   1 |  200   200     0     0 |     1      3 |      0 |      0/50  |
   2 |  200   200     0     0 |     0      2 |      0 |      0/50  |
   3 |  200   200     0     0 |     1      2 |      0 |      0/50  |
   4 |  200   200     0     0 |     0     38 |     54 |      0/50  | ◀ 快取整個不見了
   5 |  200   199     0     0 |     1     40 |     34 |      1/50  |
   6 |  200   201     0     0 |     0     37 |     28 |      0/50  |
   7 |  200   200     0     0 |     0     39 |     25 |      0/50  |
   8 |  200   199     0     0 |     0     39 |     30 |      1/50  |
   9 |  200   200     0     0 |     1     39 |     25 |      1/50  |
  10 |  200   201     0     0 |     1     39 |     30 |      0/50  |
  11 |  200   200     0     0 |     0     38 |     19 |      0/50  |
  12 |  200   199     0     0 |     1     39 |     26 |      1/50  |
  13 |  200   201     0     0 |     1     37 |     13 |      0/50  |

  快取沒掉之前的 4 秒：資料庫總共被查 0 次
  快取掉了之後 10 秒：資料庫總共被查 312 次，尖峰那一秒 67 次
  ⚠️ 注意曲線的形狀：尖峰只有一秒，但『高於平常』的狀態拖了十幾秒
```

**曲線的形狀比尖峰重要**：`54 → 34 → 28 → 25 → 30 → 25 → 30 → 19 → 26 → 13`。

> 📌 **尖峰只有一秒，但「高於平常」拖了十幾秒**，
> 因為八二分布的長尾要慢慢才會被重新載入。
> 真實系統的 key 數量是幾十萬，**這條尾巴會拖上幾分鐘到幾十分鐘。**
>
> 這就是 04 章 4.8.2 的**冷啟動雪崩**，也是 07 章 7.6.3
> 「版本化改版要搭配離峰時段 + 預熱」的理由。

### 8.7.2 ⚠️ 本地兜底救不了這一種

同一個實驗，把本地兜底打開：

```
  沒有本地兜底 : 快取掉了之後 10 秒，資料庫總共被查 312 次，尖峰 67 次/秒
  本地兜底 200 : 快取掉了之後 10 秒，資料庫總共被查 298 次，尖峰 58 次/秒
```

**幾乎沒有差別。** 原因在 8.5.3 那三個設計決定的第一條：

> **Redis 回 `null` 時不看本地。**
> `FLUSHALL` 之後 Redis 的回答是「**我沒有這一筆**」（`null`），不是「我壞了」（例外）。
> 而「Redis 說沒有」是必須被尊重的——**否則你會讀到已經被別人主動清掉的舊資料**（07 章 7.7）。

| 故障 | Redis 的回答 | 本地兜底 |
|---|---|---|
| Redis 掛了 / 不回話 | **例外** | ✅ 接手 |
| Redis 活著但快取空了 | **`null`** | ❌ **不接手，而且這是對的** |

**那要靠什麼？** 回到 07 章那幾招：

| 對策 | 哪一章 | 說明 |
|---|---|---|
| **預熱** | 本節 | 重啟／切換之後，先用背景工作把熱門資料灌回去，**再**放流量進來 |
| **漸進放流量** | 本節 | 負載平衡權重從 10% 慢慢加上去，讓快取一邊被填一邊承受流量 |
| `sync = true` | 07 章 7.8.2 | 同一個 JVM 內只讓一個執行緒去載入 |
| **分散式鎖** | **09 章** | 全站只讓一個請求去載入 |
| **TTL 抖動** | 07 章 7.8.3 | 讓重新載入的那批資料不要又同時到期（**預熱時特別重要**） |
| **併發閘** | 8.5.6 | 最後一道：明確放棄一部分請求，保住資料庫 |

⚠️ **預熱時一定要配 TTL 抖動**：你在 30 秒內灌進去 50 萬筆，
如果 TTL 都是 30 分鐘，**30 分鐘後它們會在同一個 30 秒裡一起過期**——
你剛剛親手安排了下一次雪崩。

---

## 8.8 降級決策表

「降級」不是一個開關，是**每一個 API 各自的決定**。三個問題就能決定：

```
① 這個資料舊一點會怎樣？
     沒關係（商品描述、分類）           → 回舊資料（本地兜底 / stale-while-revalidate）
     會出事（庫存、餘額、權限）          → ② ↓

② 這個功能不能用的話，使用者還能做別的事嗎？
     能（推薦、排行榜、瀏覽紀錄）        → 回空值 / 預設值，讓頁面照樣渲染
     不能                             → ③ ↓

③ 讓它失敗 vs 讓它繞過去，哪一個比較糟？
     繞過去比較糟（鎖、預扣庫存、冪等）   → 直接失敗（503），⚠️ 絕對不要繞過
     失敗比較糟（限流、稽核記錄）        → 放行，但記下來
```

套到本站的十五章：

| 功能 | 章 | Redis 掛掉時 | 理由 |
|---|---|---|---|
| 商品／分類快取 | 07 | **回本地兜底的舊資料**，沒有就查資料庫 | 舊幾分鐘沒關係 |
| 搜尋結果、列表 | 07 | 查資料庫，**必要時併發閘擋一部分** | 同上，但成本高 |
| 推薦、排行榜 | 12 | **回空的**，前端不顯示那一區 | 少一塊比整頁 500 好 |
| 瀏覽紀錄、埋點 | —— | **丟掉** | 掉了就掉了 |
| **限流** | 10 | ⚠️ **看服務**：對外 API 選「拒絕」（保護後端），內部服務選「放行」 | 兩種都錯得起，但錯的方向不同 |
| **Session** | 11 | **直接失敗（401/503）** | 「當作已登入」是安全漏洞 |
| **分散式鎖** | **09** | **❌ 直接失敗** | 「拿不到鎖就當作拿到了」＝ 超賣 |
| **預扣庫存** | **12** | **❌ 直接失敗** | 同上 |
| 冪等鍵 | 10 | **❌ 直接失敗** | 「查不到就當作沒做過」＝ 重複扣款 |

> 📌 **這張表只有一條原則**：
> **快取是效能優化，掉了只是變慢；鎖、計數、冪等是正確性機制，掉了就是錯。**
>
> **前者要盡力降級，後者要盡快失敗。**
> 而最危險的是把後者「降級」掉——
> 那不會出現在錯誤率圖表上，會出現在對帳單上。

**還有一個常被忽略的維度：降級要能被「手動打開」。**

```java
@Component
public class DegradationSwitch {
    // 從設定中心 / 資料庫 / 環境變數讀，可以在不重新部署的情況下切換
    private volatile boolean skipCache = false;
    private volatile boolean disableRecommendation = false;
}
```

熔斷器是**自動**的，但有些狀況它偵測不到：Redis 沒壞、只是**變慢一點點**，
或是你正要對 Redis 做維護。**手動開關讓你在事故當下有一個不需要部署的選項。**

---

## 8.9 落地：shop-service 的完整降級設定

### 8.9.1 `application.yml`

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 16379
      client-name: shop-service
      timeout: 500ms                # 06 章 6.9.1
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

lab10:
  redis:
    disconnected-behavior: REJECT_COMMANDS     # 8.4.7（三層都上線之後才開）
  cache:
    prefix: "lab10:v1:"                        # 07 章 7.4.2
    transaction-aware: true                    # 07 章 7.7.4
    degrade-on-failure: true                   # 8.3
    circuit-breaker:
      enabled: true                            # 8.4
      failure-threshold: 5
      open-millis: 5000
    local-fallback:
      size: 1000                               # 8.5.3
      seconds: 120

management:
  endpoint:
    health:
      probes:
        enabled: true
      group:
        readiness:
          include: readinessState, db          # ⚠️ 8.6.3：不要放 redis
        liveness:
          include: livenessState
```

### 8.9.2 三層防線分別在哪裡

```
    請求
     │
     ├─ ③ Spring Cache 層：DegradingCacheErrorHandler（8.3）
     │      「快取層丟出來的例外，不要變成使用者的錯誤」
     │
     ├─ ② 應用層：TwoLevelCache（8.5.3）→ CircuitBreakingCache（8.4）
     │      「Redis 不回話時，主動不去碰它；碰不到時，拿本地那一份」
     │
     └─ ① Lettuce 層：timeout 500ms + REJECT_COMMANDS + requestQueueSize 1000（06 章 6.9）
            「連線斷了就快速失敗，不要把命令收下來排隊」
```

### 8.9.3 驗收

```
═══ 8.9.3 三層防線：驗收 ═══
① Lettuce 層
    命令逾時              : PT0.5S
    disconnectedBehavior  : REJECT_COMMANDS
    requestQueueSize      : 1000
② 應用層（熔斷）
    熔斷器狀態            : CLOSED
    products 這個 cache 的裝飾鏈 :
      → TwoLevelCache
      → CircuitBreakingCache
      → TransactionAwareCacheDecorator
      → FailSoftRedisCache
③ Spring Cache 層
    errorHandler          : DegradingCacheErrorHandler
    吞掉的錯誤（目前）    : get 0、put 0、evict 0
    cacheManager          : FailSoftRedisCacheManager（transactionAware = 07 章 7.7.4）
```

**那條裝飾鏈是這兩章的成果**，由外到內每一層都對應一節：

| 層 | 負責 | 哪一節 |
|---|---|---|
| `TwoLevelCache` | Redis 讀不到時拿本地那一份 | 8.5.3 |
| `CircuitBreakingCache` | Redis 很慢時主動不碰 | 8.4 |
| `TransactionAwareCacheDecorator` | 清除延到交易提交後 | 07 章 7.7.4 |
| `FailSoftRedisCache` | 反序列化失敗當作沒命中 | 07 章 7.6.4 |
| `RedisCache` | 真的去 Redis | 07 章 7.4 |

### 8.9.4 本章的四條規約（接續 07 章 7.9.3 的第 16 條）

17. **`CacheErrorHandler` 一定要裝，而且 `evict` / `clear` 的失敗必須 `warn` 以上並接告警**（8.3.1）。
18. **熔斷器必須跟 `CacheErrorHandler` 一起上線**，而且**`evict` 不走熔斷**（8.4.3、8.4.4）。
19. **readiness 探針不可以包含 Redis**（8.6.3）。
20. **任何「正確性機制」（鎖、冪等、預扣庫存）不可以降級**——它們要快速失敗（8.8）。

### 8.9.5 五個該接告警的指標（接續 07 章 7.9.4）

| 指標 | 正常值 | 不正常代表 |
|---|---|---|
| **快取清除失敗次數** | **0** | 快取裡正在累積錯誤資料（8.3.1） |
| **熔斷器跳閘次數** | **0** | Redis 在抖；跳閘後**不會有錯誤率**，所以這是唯一看得到的訊號 |
| 熔斷器處於 OPEN 的時間比例 | 0% | 同上 |
| **本地兜底的命中次數** | **0** | 它不為 0 就代表 Redis 正在出問題 |
| 資料庫 QPS | 平穩 | 突然變 10 倍 = 快取層出事了（8.5.1） |

> ⚠️ **注意這五個指標的共同點**：**降級做得越好，錯誤率越看不出問題。**
> 8.10 的演練裡，使用者看到的錯誤率是 **0%**——
> **如果你只監控錯誤率與延遲，Redis 消失 60 秒你不會知道。**

---

## 8.10 演練：把 Redis 拿掉 60 秒

### 8.10.1 演練腳本

**目的**：驗證「Redis 完全不可用 60 秒」時，使用者與資料庫都不受影響。

**前置**：

- [ ] 8.9 的設定全部上線（三層防線 + readiness 群組）。
- [ ] 準備好一個**穩定速率**的流量產生器（8.2.1；不要用 closed model 的壓測工具）。
- [ ] 打開這五個儀表板：**錯誤率、p99 延遲、資料庫 QPS、熔斷器狀態、執行緒池使用率**。
- [ ] 確認你知道怎麼把 Redis 叫回來（`docker start` / 雲端主控台 / 找誰）。
- [ ] ⚠️ **在測試環境做第一次。** 正式環境的演練要先跟所有人說。

**步驟**：

| 時間 | 動作 | 要看的 |
|---|---|---|
| T-10 分 | 讓流量跑穩，記錄基準值 | 命中率、資料庫 QPS、p99 |
| T+0 | `docker stop redis-lab` | **錯誤率有沒有跳**（應該沒有） |
| T+0～10 秒 | —— | **熔斷器多久跳閘**、p99 的那一個尖峰有多高 |
| T+10～60 秒 | —— | **資料庫 QPS 變幾倍**、本地兜底命中率 |
| T+30 秒 | 檢查 `/actuator/health` 與 `/actuator/health/readiness` | **readiness 必須還是 UP**（8.6） |
| T+60 秒 | `docker start redis-lab` | **多久才恢復**（8.2.3 量到 7 秒） |
| T+60～90 秒 | —— | **恢復後的第二波**：資料庫 QPS 會不會再衝一次（8.7） |

**通過標準**（沒達到就是還有東西沒做）：

- [ ] 使用者看到的錯誤率 **< 1%**。
- [ ] 沒有任何請求**被拒絕**（執行緒池沒有耗盡）。
- [ ] 資料庫 QPS **< 平常的 3 倍**。
- [ ] `/actuator/health/readiness` 全程 **UP**。
- [ ] 恢復之後 **30 秒內**回到基準值。
- [ ] **五個告警至少有一個響了**（8.9.5）——沒響代表你根本不會知道出事。

### 8.10.2 本次演練結果

```java
@SpringBootTest(properties = {
        "lab10.cache.degrade-on-failure=true",
        "lab10.cache.circuit-breaker.enabled=true",
        "lab10.cache.circuit-breaker.failure-threshold=5",
        "lab10.cache.circuit-breaker.open-millis=5000",
        "lab10.cache.local-fallback.size=1000",
        "lab10.cache.local-fallback.seconds=120"
})
// 500 個商品、八二分布、每秒 200 個請求、85 秒
```

```
═══ 8.10 演練：把 Redis 拿掉 60 秒 ═══

  秒 | 送出  完成  失敗  拒絕 |  p50    p99  | DB查詢 | 忙碌執行緒 | 事件
  ---+----------------------+--------------+--------+------------+------
   0 |  200   200     0     0 |     1      4 |      0 |      0/50  |
   ...（0～9 秒：正常）
   9 |  200   200     0     0 |     0      2 |      0 |      0/50  |
  10 |  200   196     0     0 |     0    505 |      0 |      4/50  | ◀ docker stop redis-lab
  11 |  200   204     0     0 |     0    506 |      0 |      0/50  |
  12 |  200   200     0     0 |     0      0 |      0 |      0/50  |
  ...（12～69 秒：p50 = 0 ms，p99 = 0 ms，資料庫 0 次/秒，忙碌執行緒 0）
  69 |  200   200     0     0 |     0      0 |      0 |      0/50  |
  70 |  200   199     0     0 |     0      0 |      0 |      1/50  | ◀ docker start redis-lab
  71 |  200   199     0     0 |     0      0 |      0 |      1/50  |
  ...
  76 |  200   200     0     0 |     0      0 |      0 |      0/50  |
  77 |  200   199     0     0 |     0     37 |     35 |      1/50  |   ← 熔斷器合上，開始重建快取
  78 |  200   200     0     0 |     0     46 |     35 |      1/50  |
  79 |  200   198     0     0 |     0     38 |     45 |      3/50  |
  80 |  200   199     0     0 |     0     37 |     45 |      3/50  |
  81 |  200   203     0     0 |     0     37 |     26 |      0/50  |
  82 |  200   199     0     0 |     0     39 |     24 |      1/50  |
  83 |  200   200     0     0 |     0     38 |     25 |      1/50  |
  84 |  200   201     0     0 |     0     39 |     18 |      0/50  |
  總計：送出 17,000，失敗 0（0.0%），被拒絕 0（0.0%），使用者看得到的錯誤率 = 0.0%，耗時 85.7 秒

  ══════ 演練報告 ══════
  ① 正常   （0～9 秒）    錯誤率 0.0%  拒絕率 0.0%  p50  1 ms  p99  2 ms  資料庫  0 次/秒
  ② 故障中 （10～69 秒）  錯誤率 0.0%  拒絕率 0.0%  p50  0 ms  p99  0 ms  資料庫  0 次/秒
  ③ 恢復後 （70～84 秒）  錯誤率 0.0%  拒絕率 0.0%  p50  0 ms  p99 28 ms  資料庫 18 次/秒
  熔斷器跳閘 13 次，期間跳過 Redis 12,942 次
  本地兜底命中 12,959 次 / 沒命中 0 次（命中率 100.0%）
```

**逐條對通過標準**：

| 標準 | 結果 |
|---|---|
| 錯誤率 < 1% | ✅ **0.0%**（17,000 個請求，一個都沒失敗） |
| 沒有請求被拒絕 | ✅ **0** |
| 資料庫 QPS < 3 倍 | ✅ **0 次/秒**（本地兜底 100% 命中） |
| readiness 全程 UP | ✅（8.6.1 單獨驗證過） |
| 30 秒內恢復 | ⚠️ **看下面** |
| 至少一個告警響了 | ✅ **熔斷器跳閘 13 次** |

**三件要拿出來討論的事**：

**① 第 10～11 秒的 `p99 = 505 ms`。**
那是熔斷器跳閘之前的學費：連續 5 次失敗才跳閘，那幾個請求各付了一次逾時。
**這是無法消除的**——熔斷器必須先觀察到失敗才能跳。
能做的是讓它**只發生一次**（8.4.5 的「跳閘 2 次」與這裡的「13 次」都符合預期：
每 5 秒探一次，60 秒就是 12～13 次，**每次探針付一次逾時，但那是探針自己付的，不影響其他人**）。

**② `docker start` 在第 70 秒，資料庫到第 77 秒才開始被查。**
那 7 秒是「熔斷器還在 OPEN + Lettuce 還在重連」。
**對使用者是好事**（他們仍然拿到本地兜底的資料），但也代表：
**「Redis 起來了」不等於「恢復了」，中間有 5～10 秒。**
演練時不要在 `docker start` 之後三秒就宣布成功。

**③ 資料庫在 77～84 秒是 35 → 45 → 26 → 18，沒有回到 0。**
這是 8.7 的第二波：Redis 回來了，但**裡面是空的**，快取要重新建。
這次很溫和（尖峰 45 次/秒，平常是 0），因為只有 500 個商品。
**幾十萬個 key 的系統，這條尾巴會拖很久**——所以 8.7.2 那些預熱手段是必要的。

**④ 本地兜底「沒命中 0 次」是這個實驗的極限。**
500 個商品全部塞得進 1000 筆的本地快取，所以命中率是 100%。
**真實系統不會這麼好**——8.5.4 那個 200 筆的版本（命中率 88.8%）比較有參考價值。
**在你自己的系統上重跑時，要用真實的 key 數量。**

### 8.10.3 演練要定期做

> 📌 **這一章的所有設定都有一個共同的性質：平常完全看不出它有沒有在運作。**
>
> `CacheErrorHandler` 平常不會被呼叫、熔斷器平常是 CLOSED、本地兜底平常不會被讀到。
> **一個寫壞了的降級設定，跟一個寫對了的，在平常的監控上一模一樣。**
>
> 所以它必須**定期演練**——每一次改動快取設定、每一季、每一次上線前。
> **沒有演練過的降級邏輯，等於沒有降級邏輯。**

---

## 8.11 常見誤區

**① 「Redis 只是快取，掛了頂多變慢」**

8.2.2：**錯誤率 100%**。這句話要成立，需要這一整章的東西。

**② 「Redis 掛了，資料庫會被打爆」**

8.2.2：**資料庫一次都沒被查到**，因為請求在讀快取那一步就死了。
**資料庫雪崩要等你裝上第一層防線之後才會發生**（8.3.2 的 12.3 倍）——
所以這兩件事必須一起處理。

**③ 「把逾時設短就安全了」**

8.3.4：一個沒命中的請求要碰兩次 Redis，逾時 500 毫秒 = 一個請求 1 秒。
8.4.1：50 個執行緒撐 200 QPS，**每個請求超過 250 毫秒就開始堆積**。
**逾時再怎麼調都救不了，必須主動不去碰。**

**④ 「裝了 `CacheErrorHandler` 就做完降級了」**

8.3.3：它把「明確失敗」換成「很慢的成功」，**被拒絕率反而從 17.5% 升到 26.4%**。

**⑤ 「熔斷器跳閘時，`evict` 也一起跳過比較乾淨」**

8.4.4：那會讓**舊資料留在快取裡**，而且沒有人會再去清它。
**熔斷只能跳過「跳過了只是變慢」的操作。**

**⑥ 「熔斷器回 `null` 就好，何必丟例外」**

8.4.3：回 `null` 的意思是「快取裡沒有」，**本地兜底就永遠接不到了**。

**⑦ 「Redis 慢一點沒關係，它還是有回應」**

「慢但成功」是最危險的狀態——**你的熔斷器不會跳，但執行緒已經在耗盡**。
所以 Resilience4j 的 `slowCallDurationThreshold` 是必須的（8.4.6）。

**⑧ 「readinessProbe 指到 `/actuator/health` 最直覺」**

8.6.1：Redis 掛掉 → 每個 Pod 都 DOWN → **整個叢集從負載平衡上消失**。
你做的降級全部白做，而且這次是真的全掛。

**⑨ 「那就把 `management.health.redis.enabled` 關掉」**

那也把 Redis 從**告警**裡拿掉了。正確做法是**分開 readiness 與總健康**（8.6.3）。

**⑩ 「本地快取兜底可以解決所有快取故障」**

8.7.2：**它救不了「Redis 活著但快取空了」**——那時候 Redis 回的是 `null` 不是例外，
而尊重那個 `null` 是對的。

**⑪ 「Redis 起來了就恢復了」**

8.2.3：7 秒的重連落差。8.10.2：熔斷器還要再等一個 `open-millis`。
8.7.1：然後還有冷啟動的第二波。

**⑫ 「分散式鎖也該降級，不然 Redis 掛了整個功能都不能用」**

8.8：**「拿不到鎖就當作拿到了」＝ 超賣。**
那不會出現在錯誤率圖表上，會出現在對帳單上。

**⑬ 「錯誤率沒動，代表沒事」**

8.10.2：Redis 消失 60 秒，**使用者看到的錯誤率是 0.0%**。
**降級做得越好，錯誤率越看不出問題**——要看的是 8.9.5 那五個指標。

---

## 8.12 本章小結

> **降級不是一個開關，是「把一種失敗換成另一種比較能接受的失敗」。**

這一章做了四次交換：

| 從 | 換成 | 用什麼 | 代價 |
|---|---|---|---|
| 服務 100% 錯誤 | 資料庫承受 12.3 倍 | `CacheErrorHandler`（8.3） | 資料庫壓力 |
| 執行緒耗盡、26% 被拒絕 | 快速跳過快取 | **熔斷器**（8.4） | 跳閘前的那一個 p99 尖峰 |
| 資料庫 12.3 倍 | **1.0 倍** | **本地快取兜底**（8.5） | 故障期間讀到最多兩分鐘前的資料 |
| 整個叢集被下線 | 只是告警 | **readiness 群組**（8.6） | 要多設一段 yml |

而四次交換底下是同一個判斷：

> **「這個東西壞掉的時候，我寧願放棄什麼？」**
>
> 快取壞了，我寧願**放棄新鮮度**（讀舊資料）。
> 資料庫要被打爆了，我寧願**放棄一部分請求**（併發閘）。
> 但鎖壞了，我**不能放棄正確性**——那只能失敗。

**這一章與前兩章的關係**：

| 章 | 一句話 |
|---|---|
| 06 | Redis 不回話時，你的執行緒預設會等 **60 秒**，而且不留痕跡 |
| 07 | 快取與資料庫是兩份資料，**它們不會自己同步** |
| **08** | **快取故障必須被換成「變慢」，而不是「出錯」或「資料庫掛掉」** |

📌 **06 章 6.9.2 那個 `disconnectedBehavior` 的 TODO，到這一章才有資格改掉**——
因為「快速失敗」只有在「失敗會被接住」之後才是好事。

### 8.12.1 驗收清單

- [ ] 說出「Redis 行程消失」與「Redis 不回話」對你的服務有什麼**完全不同**的影響。
- [ ] 解釋為什麼預設設定下 Redis 掛掉時**資料庫一次都不會被查到**。
- [ ] 說出 `CacheErrorHandler` 四個方法裡，哪一個吞掉之後會造成**資料錯誤**。
- [ ] 用 Little's Law 算出你的服務「每個請求最多能花多久」。
- [ ] 說出為什麼一個沒命中的請求要付**兩次**逾時。
- [ ] 說出熔斷器跳閘時為什麼要**丟例外**而不是回 `null`。
- [ ] 說出熔斷期間為什麼 `evict` 不能跳過。
- [ ] 算出命中率 99% 的服務，快取掛掉時資料庫承受幾倍。
- [ ] 說出本地兜底為什麼「Redis 回 `null` 時不看本地」。
- [ ] 說出 readiness、liveness、總健康三者的差別，以及 Redis 該出現在哪一個裡。
- [ ] 說出「Redis 起來了」到「服務真的恢復」中間有哪幾段延遲。
- [ ] 說出哪三種功能**絕對不可以降級**，以及理由。
- [ ] 說出為什麼「錯誤率沒動」不代表沒事，以及該改看哪五個指標。

### 8.12.2 本章練習

**練習一（20 分鐘）**：在你自己的機器上重跑 8.2.2 與 8.2.4，
**把兩份輸出貼在一起比較**。接著把 `THREADS` 從 50 改成 200（Tomcat 的預設值），
重跑 8.2.4，用 8.4.1 的公式**先預測**拒絕率，再對照實測。

**練習二（20 分鐘）**：把 `CacheErrorHandler` 的 `handleCacheEvictError` 改成
「吞掉 + 記錄到一個重試佇列，背景每 5 秒重試一次」。
**驗證**：熔斷期間改一個商品的價格，Redis 恢復之後那筆快取有沒有被清掉。

**練習三（25 分鐘）**：把 8.4.2 那個熔斷器換成 **Resilience4j**，
並打開 `slowCallDurationThreshold(200ms)`。
接著製造一個 8.4.6 提到的情境：**用 `docker exec redis-lab redis-cli DEBUG SLEEP 0.3`
讓 Redis「慢但成功」**，驗證自己寫的版本不會跳閘、Resilience4j 的會。

**練習四（25 分鐘）**：量出**你的系統**的 8.5.1 倍數。
方法：記下平常的資料庫 QPS 與快取命中率，用公式算出預期倍數，
然後跑一次 8.5 的演練驗證。**接著回答：你的資料庫撐得住那個倍數嗎？**

**練習五（進階，30 分鐘）**：實作 8.8 的**手動降級開關**，
讓它可以在不重新部署的情況下切換三種模式：`正常` / `跳過快取` / `只讀本地`。
⚠️ 想清楚開關本身放在哪裡——**放在 Redis 裡是不行的。**

**練習六（進階，40 分鐘）**：實作 8.7.2 的**預熱 + 漸進放流量**。
① 應用啟動時，背景把最熱門的 1000 個商品灌進快取（**記得 TTL 抖動**）；
② 預熱完成前 `/actuator/health/readiness` 回 DOWN；
③ 量一次「有預熱」與「沒預熱」在重啟後 60 秒內的資料庫總查詢次數。

---

## 8.13 下一章預告

這一章最後那張決策表（8.8）留下了三個「**不可以降級**」的東西，
而它們有一個共同點：**它們都是用 Redis 來保證「同一時間只有一個人能做某件事」。**

09 章從最基本的那個開始：**分散式鎖**。

- 為什麼 `if (get() == null) set(...)` 這兩行之間**就是超賣的縫**——05 章 5.2 說過了，
  09 章要看的是**你以為封住了、但其實沒有**的那幾種寫法。
- `SET NX PX` + Lua 釋放，以及**誤刪別人的鎖**（05 章 5.10 那段 `release-lock.lua` 的完整理由）。
- **過期時間該設多久**：設短了業務還沒做完鎖就沒了，設長了服務掛掉要等很久。
  **watchdog 續期**解決哪一半。
- Redisson 的 `RLock`：可重入、公平鎖，以及它跟自己寫的版本差在哪。
- ⚠️ **鎖與 `@Transactional` 的順序**——07 章 7.7 已經證明「交易還沒提交」是一道縫，
  09 章會證明**鎖包在交易裡面等於沒鎖**。
- RedLock 的爭議，以及一句話：**Redis 的鎖在什麼前提下才是安全的。**

而這一章的結論會在 09 章被用到一次：
**分散式鎖不能降級，所以它的逾時、重試與失敗處理，必須在寫下第一行的時候就想清楚。**
