# 10 — Redis：從命令列到 Spring 專案

> **Redis 零基礎可以直接進來。** 這一站從 `docker run` 起第一台 Redis、
> 在 `redis-cli` 裡敲第一個 `SET` 開始，一路做到分散式鎖、限流、預扣庫存與故障降級。
>
> 前半段（00～05）在**命令列裡**把 Redis 本身弄懂：資料結構怎麼選、TTL 為什麼會不見、
> 單執行緒代表什麼、記憶體滿了誰被踢掉、`MULTI` 為什麼不是交易。
> 後半段（06～14）把這些東西**接進一個 Spring Boot 專案**。
>
> **前半段不是暖身。後半段每一個事故的根因，都在前半段的某一節裡。**

---

## 學完你可以

**Redis 本體**

- 用 Docker 起一台 Redis，讀懂 `INFO`、`MEMORY USAGE`、`OBJECT ENCODING`、`SLOWLOG` 告訴你的事。
- 替一個需求選出正確的資料結構，並說出同一份資料換個結構存，記憶體與併發安全性差在哪。
- 說明 key 過期的兩套機制，以及為什麼 `SET` 一次就把你設好的 TTL 洗掉了。
- 解釋「單執行緒」到底單在哪裡，並指出哪些命令會讓所有人一起等。
- 設定 `maxmemory` 與淘汰策略，說出八種策略的差別與選法。
- 說明 RDB 與 AOF 各自會掉多少資料，並選出一組符合你資料容忍度的設定。
- 分清楚 pipeline、`MULTI/EXEC`、Lua——**只有一個是真的原子**，而且沒有一個會回滾。

**接進 Spring**

- 說明 `RedisTemplate` 的四個序列化器分別在哪裡、選錯會在什麼時候爆。
- 設定 Lettuce 的連線池與**三層逾時**，並說明預設值為什麼危險。
- 設計 Redis 不可用時的降級策略，讓快取層故障不會變成整站 503、也不會變成資料庫雪崩。
- 把 `@Cacheable` 接上 `RedisCacheManager`，處理 per-cache TTL、null 值、改版相容與交易順序。
- 實作正確的分散式鎖，並判斷一段程式的**鎖與交易順序**是對是錯。
- 用 Lua 實作限流與冪等，並回出一組讓客戶端有辦法退讓的 `429`。
- 用 Redis 做多實例 Session 共享與 token 撤銷，並說出「無狀態」換來什麼、又失去什麼。
- 用「Redis 預扣 + 資料庫落帳」處理搶購，並在對不上帳的時候把帳補回來。
- 說明主從、Sentinel、Cluster 在 Java 這一側分別長什麼樣子，以及切換的那幾秒會發生什麼。
- 用 Testcontainers 寫出真的會跑 Redis 的整合測試，並在 Java 端觀測 big key 與 hot key。

## 前置知識

**Redis 不需要任何基礎。** 只需要：

- 會寫 Spring Boot 應用（`@RestController`、`@Service`、`@Transactional` 的基本用法）。
- 知道「一筆資料在資料庫裡被兩個請求同時改」是個問題——這一站會用 Redis 回答它。
- 電腦上有 Docker 與 JDK 21。

資料庫端只用 H2（跟著專案一起跑，不用另外裝）。

---

## 章節目錄

### 第一部分：Redis 本體（在命令列裡把它弄懂）

| 章節 | 檔案 | 主題 | 這一章最值得看的 |
|------|------|------|------|
| 00 | [`00-course-map-and-first-redis.md`](./00-course-map-and-first-redis.md) | 課程地圖與第一台 Redis | Redis 慢但共享、**四個真實事故預告**、`docker run` 每個參數的理由、`INFO` 怎麼讀、基準專案與 `RedisProbe` |
| 01 | [`01-keys-ttl-and-expiration.md`](./01-keys-ttl-and-expiration.md) | key、TTL 與過期機制 | key 的成本與命名、`KEYS` vs `SCAN`、⚠️ `SET` 覆寫會清掉 TTL、惰性刪除 + 定期抽樣、`DEL` vs `UNLINK` |
| 02 | [`02-data-structures-and-encoding.md`](./02-data-structures-and-encoding.md) | 五大結構與它們的場景（核心章） | 五種結構各該用在哪、JSON vs Hash 的併發差別、`OBJECT ENCODING` 與編碼轉換門檻、Bitmap / HyperLogLog、big key |
| 03 | [`03-single-thread-and-slow-commands.md`](./03-single-thread-and-slow-commands.md) | 單執行緒與慢命令（核心章） | 「單執行緒」單在哪、O(N) 命令清單、`SLOWLOG` 的三個盲點、⚠️ Redis 卡住時你的應用會安靜地陪它等、pipeline |
| 04 | [`04-memory-eviction-and-persistence.md`](./04-memory-eviction-and-persistence.md) | 記憶體、淘汰與持久化 | 八種淘汰策略的差別與選法、LRU 是近似的、記憶體碎片、RDB / AOF 各掉多少資料、`fork` 的延遲尖峰 |
| 05 | [`05-atomicity-transaction-and-lua.md`](./05-atomicity-transaction-and-lua.md) | 原子性：交易、Lua 與 pipeline（核心章） | 四個工具一張對照表、⚠️ `MULTI` 失敗不回滾、`WATCH` 的重試代價、Lua 為什麼是真原子、⚠️ 慢 Lua 卡住整台 |

### 第二部分：接進 Spring 專案

| 章節 | 檔案 | 主題 | 這一章最值得看的 |
|------|------|------|------|
| 06 | [`06-spring-data-redis-and-lettuce.md`](./06-spring-data-redis-and-lettuce.md) | 連線與序列化（核心章） | 四個序列化器分別在哪裡、JDK 序列化的三個坑、Jackson 的四種寫法與 `@class`、Lettuce 的多工連線模型、**三層逾時** |
| 07 | [`07-cache-abstraction-on-redis.md`](./07-cache-abstraction-on-redis.md) | 快取抽象接上 Redis（核心章） | 三個註解的精確時機、⚠️ 自呼叫無效、per-cache TTL 與快取 `null`、改版後讀不回來的兩種解法、⚠️ 快取與交易的競態、穿透／擊穿／雪崩 |
| 08 | [`08-redis-failure-and-degradation.md`](./08-redis-failure-and-degradation.md) | 故障與降級（核心章） | **兩種故障的形狀完全不同**、`CacheErrorHandler`、熔斷器、本地快取兜底、⚠️ readiness 探針不能含 Redis、恢復的第二波、降級決策表 |
| 09 | [`09-distributed-lock.md`](./09-distributed-lock.md) | 分散式鎖（核心章） | 六種寫法的超賣對照、釋放鎖為什麼要 Lua、TTL 與 watchdog、Redisson 的 `RLock`、⚠️ **鎖與交易的順序**、RedLock 與 fencing token、⚠️ 鎖不能降級 |
| 10 | [`10-rate-limit-and-idempotency.md`](./10-rate-limit-and-idempotency.md) | 限流與冪等（核心章） | 四種限流演算法的三維對照、限流器該放 Filter 還是 Interceptor、`429` 該回什麼、⚠️ 「先查再做」不是冪等、冪等鍵的三個狀態 |
| 11 | [`11-session-and-token-revocation.md`](./11-session-and-token-revocation.md) | Session 與 token 撤銷 | 多實例下的「登入了又沒登入」、Spring Session 的兩種 repository、⚠️ 序列化與記憶體成本、強制下線、JWT 撤不掉與兩種撤銷做法 |
| 12 | [`12-hot-inventory-and-counters.md`](./12-hot-inventory-and-counters.md) | 熱點、計數與預扣庫存（核心章） | **六種防超賣方案一次跑完**（⚠️ 分散式鎖最慢）、Redis 預扣真正買到什麼、落帳失敗的回補與對帳、原子計數與排行榜、hot key 與分桶的代價 |
| 13 | [`13-replication-sentinel-and-cluster.md`](./13-replication-sentinel-and-cluster.md) | 高可用在 Java 這一側（核心章） | ⚠️ 非同步複製會丟掉「已回 OK」的寫入、`WAIT` 的代價、讀寫分離的陳舊讀、Sentinel 切換時間軸、⚠️ 切換時鎖會失效、Cluster 的槽與 `CROSSSLOT`、⚠️ topology refresh 預設是關的 |
| 14 | [`14-testing-and-operations.md`](./14-testing-and-operations.md) | 測試與維運（收尾章） | ⚠️ 四個「測試是綠的但什麼都沒測到」、Testcontainers、快取與併發的正確測法、把 13 章搬進 CI、Lettuce 指標、big key / hot key 巡檢、**上線檢查清單** |

> 📌 **第一部分是後半段的根因索引。**
> 06 章的序列化爆炸、09 章的鎖失效、12 章的超賣，
> 追下去都會停在 02、03、05 這三章的某一節。跳過前半段的話，後半段會變成抄設定。

---

## 常見誤區（課程會逐一破解）

- 在正式環境敲 `KEYS *` 找 key——那一瞬間**整台 Redis 不服務任何人**（01 章）。
- 以為 `EXPIRE` 設好就固定了，結果業務再 `SET` 一次，TTL 靜靜地被清成永久（01 章）。
- 所有東西都用 String 存 JSON——改一個欄位要整包讀寫，而且併發下會掉更新（02 章）。
- 沒設 `maxmemory`，或設了卻沒想過「誰會先被踢掉」（04 章）。
- 以為 `MULTI/EXEC` 是交易，中間一條命令錯了會回滾——**它不會**（05 章）。
- 用預設的 `RedisTemplate` 存物件，改個套件名整個快取全部讀不回來（06 章）。
- 以為「Redis 只是快取，掛了頂多變慢」——預設設定下，**它會變成整個服務的停頓**（06、08 章）。
- 快取穿透靠「快取 null」解決，但 null 沒設較短的 TTL，商品上架後半小時查不到（07 章）。
- 分散式鎖寫成 `if (get == null) set(...)`，兩行之間就是超賣的縫（09 章）。
- 鎖包在交易裡面——鎖放掉時交易還沒提交，下一個人讀到舊資料（09 章）。
- 用固定窗限流，窗口交界的那一瞬間可以打進兩倍流量（10 章）。
- Session 跟快取放同一台 Redis——記憶體滿了，被驅逐的是別人的購物車（11 章）。
- 以為「有 Redis 預扣就不用在資料庫判斷庫存」（12 章）。
- 在單機測得好好的 Lua 腳本，上了 Cluster 直接回 `CROSSSLOT`（13 章）。

---

## 基準專案

**整站只有一個專案**，每一章在它上面累加。00 章 0.7 會帶你把它建起來：

```
docker run       Redis 7.2（00 章第一件事，整站都用它）
pom.xml          Boot 3.2.5 + spring-boot-starter-data-redis + H2
RedisProbe       在 Java 端印出 INFO / MEMORY USAGE / SLOWLOG —— 課文的數字都從這裡來
一張商品表        庫存 100 件，用來被 200 個執行緒同時搶（09、12 章的主角）
```

資料庫刻意用 H2：這一站要看的是 Redis，落帳只需要一個「會真的做交易」的地方。

前半段（00～05）大多在 `redis-cli` 裡進行，Java 只負責重現與量測；
後半段（06～14）才把東西搬進 Spring，每一章最後都有一節「落地到 shop-service」。

## 引用慣例

- **實測輸出的標頭就是節號**：每段輸出都印 `═══ 節號 標題 ═══`，可以直接對回課文。
- **套件名分開實驗與成品**：`com.example.lab10.chNN` 是**刻意寫壞的實驗變體**，
  `com.example.lab10.shop` 才是本站建議的樣子（每章最後的落地小節）。
- **規約是累加的**：從 01 章開始編號，每一章往上加幾條，14 章的上線檢查清單是它們的總表。
- **本站所有引用都是站內引用**，寫成「01 章 1.5.3」。這一站不依賴任何其他課程。

## 本站的實驗環境

| 項目 | 版本 |
|------|------|
| Redis | 7.2（Docker） |
| Spring Boot | 3.2.5 |
| Lettuce | Boot 3.2.5 內建（6.3.x） |
| Redisson | 3.27.x（09 章起，⚠️ 用 `org.redisson:redisson` 而非 starter，見 09 章 9.7.1） |
| Bucket4j | 8.10.1（10 章，選用） |
| Spring Session | 3.2.2（11 章，Boot 3.2.5 內建） |
| Testcontainers | 1.20.6（14 章；⚠️ 遇到 Docker Engine 29 要加 `-Dapi.version=1.44`，見 14.2.5） |
| JDK | Temurin 21 |
| 資料庫 | H2（內嵌，隨專案啟動） |

> ⚠️ **課文裡的效能數字會因機器而異。**
> 每一個實驗都附有可重跑的步驟，**請在你自己的機器上跑一次**——
> 直接抄課文裡的逾時與過期時間會出事。

## 產出

一個能扛住搶購的訂單／商品服務，並附**可重現的實驗**：

1. 一份序列化設定，附「舊資料 / 新版本程式」的相容性測試。
2. 一個分散式鎖實作（自寫 Lua 版 + Redisson 版各一），附併發壓測對照與一次故障重現。
3. 一組限流器與冪等鍵，附 `429` 的完整回應標頭。
4. 一份「Redis 拔掉 60 秒」的降級演練報告。
5. 一份上線檢查清單（14 章 14.9），每一條都對應到前面某一節的實測。
