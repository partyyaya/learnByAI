# 10 — Redis：從命令列到 Spring 專案

> **Redis 零基礎可以直接進來。** 這一站從 `docker run` 起第一台 Redis、在 `redis-cli` 裡敲第一個 `SET` 開始，
> 一路做到分散式鎖、限流、預扣庫存與故障降級。
>
> 前半段在**命令列裡**把 Redis 本身弄懂：資料結構怎麼選、TTL 為什麼會不見、
> 單執行緒代表什麼、記憶體滿了誰被踢掉、`MULTI` 為什麼不是交易。
> 後半段把這些東西**接進一個 Spring Boot 專案**，回答真正會讓人加班的問題：
> **序列化器選錯為什麼上線三天後才炸、鎖到底該包在交易裡面還是外面、Redis 掛掉的那 40 秒你的 API 應該長什麼樣子。**
>
> 前半段不是暖身。後半段每一個事故的根因，都在前半段的某一節裡。

---

## 學完你可以

**Redis 本體**

- 用 Docker 起一台 Redis，並在 `redis-cli` 裡讀懂 `INFO`、`MEMORY USAGE`、`OBJECT ENCODING`、`SLOWLOG` 告訴你的事。
- 替一個需求選出正確的資料結構，並說明同一份資料用 String 存和用 Hash 存，記憶體差幾倍、改一個欄位的代價差多少。
- 說明 key 過期的兩套機制（惰性刪除 + 定期抽樣），以及為什麼 `SET` 一次就把你精心設定的 TTL 洗掉了。
- 解釋「單執行緒」到底單在哪裡，並指出哪些命令是 O(N)、一個 big key 的 `DEL` 會讓其他人等多久。
- 設定 `maxmemory` 與淘汰策略，說出八種策略的差別，以及沒設的話記憶體長滿之後會發生什麼。
- 說明 RDB 與 AOF 各自會掉多少資料、`fork` 為什麼會造成延遲尖峰，並選出一組符合你資料容忍度的設定。
- 分清楚 pipeline、`MULTI/EXEC`、Lua 三者的差別——**只有一個是真的原子**，而 `MULTI` 失敗時不會回滾。

**接進 Spring**

- 說明 `RedisTemplate` 的四個序列化器分別在哪裡、選錯會在什麼時候爆，並選出一組不會被 Java 類名綁死的設定。
- 設定 Lettuce 的連線池與**三層逾時**，並說明為什麼「Redis 只是快取，掛了不影響主流程」這句話在預設設定下是錯的。
- 設計 Redis 不可用時的降級策略，讓快取層故障不會變成整站 503、也不會變成資料庫雪崩。
- 把 `@Cacheable` 接上 `RedisCacheManager`，做到 per-cache TTL、null 值處理與 key 前綴，並讓快取資料在服務改版後仍讀得回來。
- 實作正確的分散式鎖：知道自己寫的 Lua 版本與 Redisson 差在哪、watchdog 續期解決什麼、**鎖與 `@Transactional` 的先後順序為什麼只有一種是對的**。
- 用 Lua 實作滑動窗與令牌桶限流，並回出一組讓客戶端有辦法退讓的 `429` 標頭。
- 用 Redis 做多實例 Session 共享與 token 撤銷，並說出「無狀態」換來什麼、又失去什麼。
- 用「Redis 預扣 + 資料庫落帳」處理搶購，並在對不上帳的時候把帳補回來。
- 說明主從、Sentinel、Cluster 在 Java 這一側分別長什麼樣子，以及切換的那幾秒鐘客戶端會看到什麼錯誤。
- 用 Testcontainers 寫出真的會跑 Redis 的整合測試，並在 Java 端觀測連線池、big key 與 hot key 的症狀。

## 前置知識

**Redis 不需要任何基礎。** 只需要：

- 會寫 Spring Boot 應用（`@RestController`、`@Service`、`@Transactional` 的基本用法）。
- 知道「一筆資料在資料庫裡被兩個請求同時改」是個問題——這一站會用 Redis 回答它，不預設你已經知道資料庫那邊怎麼解。
- 電腦上有 Docker 與 JDK 21。

資料庫端只用 H2（跟著專案一起跑，不用另外裝），**不需要先學會任何特定資料庫**。

---

## 章節目錄

### 第一部分：Redis 本體（在命令列裡把它弄懂）

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | [`00-course-map-and-first-redis.md`](./00-course-map-and-first-redis.md) | 課程地圖與第一台 Redis | 這站教什麼、`docker run` 起 Redis 與 `redis-cli`、第一個 `SET`／`GET`、`INFO` 怎麼讀、**四個真實事故預告**（每一個都對應後面一章）、本站基準專案的骨架 |
| 01 | [`01-keys-ttl-and-expiration.md`](./01-keys-ttl-and-expiration.md) | key、TTL 與過期機制 | key 的命名與 `SCAN`（以及 ⚠️ `KEYS *` 為什麼在正式環境是事故）、`EXPIRE` / `TTL` / `PERSIST`、**惰性刪除 + 定期抽樣兩套機制**、⚠️ `SET` 覆寫會清掉 TTL、過期不等於立刻消失、`DEL` vs `UNLINK` |
| 02 | [`02-data-structures-and-encoding.md`](./02-data-structures-and-encoding.md) | 五大結構與它們的場景（核心章） | String / Hash / List / Set / ZSet 各自的命令與**該用在哪**、同一份資料三種存法的記憶體實測、`OBJECT ENCODING` 與 listpack → hashtable 的轉換門檻、Bitmap 與 HyperLogLog 的省法、⚠️ 一個 key 塞十萬個元素之後 |
| 03 | [`03-single-thread-and-slow-commands.md`](./03-single-thread-and-slow-commands.md) | 單執行緒與慢命令（核心章） | 「單執行緒」單在哪、為什麼這樣還很快、O(N) 命令清單、**一個 big key 的 `DEL` 讓其他人等多久（實測）**、`SLOWLOG` 與 `--latency`、網路往返才是瓶頸、pipeline 一次打包的實測差距 |
| 04 | [`04-memory-eviction-and-persistence.md`](./04-memory-eviction-and-persistence.md) | 記憶體、淘汰與持久化 | `maxmemory` 沒設會怎樣、**八種淘汰策略的差別與選法**、LRU 是近似的、記憶體碎片、RDB 與 AOF 各掉多少資料、`fork` 造成的延遲尖峰、重啟後資料還在不在、什麼情況下「快取不需要持久化」是錯的 |
| 05 | [`05-atomicity-transaction-and-lua.md`](./05-atomicity-transaction-and-lua.md) | 原子性：交易、Lua 與 pipeline（核心章） | pipeline 只是打包**不保證原子**、`MULTI/EXEC` 中間別人插不進來但**失敗不回滾**、`WATCH` 的樂觀鎖、Lua 為什麼是真原子、Lua 的限制與寫法規範、⚠️ 慢 Lua 會卡住整台 Redis——後面的鎖、限流、預扣庫存全部建在這一章上 |

### 第二部分：接進 Spring 專案

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 06 | `06-spring-data-redis-and-lettuce.md` | 連線與序列化（核心章） | `spring.data.redis` 設定、`RedisTemplate` vs `StringRedisTemplate`、**四個序列化器的位置**、JDK 序列化的三個坑（`\xac\xed`、改套件名、跨語言）、Jackson 序列化與型別資訊、Lettuce 連線池、**command / connect / socket 三層逾時** |
| 07 | `07-cache-abstraction-on-redis.md` | 快取抽象接上 Redis | `@Cacheable` / `@CacheEvict` / `@CachePut` 的行為與**它與交易的互動**、`RedisCacheManager` 設定、per-cache TTL、`cacheNull` 與空值、key 前綴與多環境共用實例、**改版後反序列化失敗**的處理、穿透／擊穿／雪崩三種災難與對策 |
| 08 | `08-redis-failure-and-degradation.md` | 故障與降級 | Redis 掛掉時 `@Cacheable` 的預設行為、`CacheErrorHandler`、熔斷與降級開關、「快取故障不能變成資料庫雪崩」的實作、**拔掉 Redis 60 秒的演練腳本** |
| 09 | `09-distributed-lock.md` | 分散式鎖（核心章） | 為什麼 `if (get == null) set(...)` 中間就是超賣的縫、`SET NX PX` + Lua 釋放、誤刪他人鎖、**過期時間怎麼估與 watchdog 續期**、Redisson 的 `RLock`、可重入與公平鎖、⚠️ **鎖必須包住交易（順序反了等於沒鎖）**、RedLock 的爭議與失效邊界 |
| 10 | `10-rate-limit-and-idempotency.md` | 限流與冪等 | 固定窗的邊界問題（交界一秒打進兩倍流量）、滑動窗與令牌桶的 Lua 實作、Bucket4j、多維度限流（IP／使用者／API key）、`429` 與 `Retry-After` 該怎麼回、Redis 版冪等鍵與「同一個請求送兩次」的收斂 |
| 11 | `11-session-and-token-revocation.md` | Session 與 token 撤銷 | 為什麼多實例之後 Session 會「登入了又沒登入」、Spring Session Redis、Session 的 TTL 與序列化、token 黑名單與 refresh token 撤銷、登出與強制下線、⚠️ Session 沒設 TTL 時記憶體怎麼長爆 |
| 12 | `12-hot-inventory-and-counters.md` | 熱點、計數與預扣庫存（核心章） | Redis 預扣庫存 + 資料庫落帳的完整流程、**對不上帳時的補償**、原子計數與排行榜（ZSet）、hot key 的識別與拆分、**三種防超賣方案（資料庫悲觀鎖／樂觀鎖／Redis 預扣）決策表**——三種都會在這章從零寫一次 |
| 13 | `13-replication-sentinel-and-cluster.md` | 高可用在 Java 這一側 | 主從複製是**非同步**的（主掛掉會掉哪些寫入）、Sentinel 的切換流程與客戶端重連、Cluster 的 16384 個槽、⚠️ **跨槽的 Lua 與多 key 命令直接失敗**、hash tag 怎麼救、Lettuce 的 topology refresh、切換那幾秒你的 API 會看到什麼例外 |
| 14 | `14-testing-and-operations.md` | 測試與維運 | Testcontainers Redis、`@DataRedisTest` 的限制、embedded Redis 為什麼不推薦、併發測試怎麼寫才測得出超賣、連線池與命令延遲指標、Java 端看到的 big key／hot key 症狀、**上線檢查清單** |

> 📌 **第一部分是後半段的根因索引。**
> 06 章的序列化爆炸、09 章的鎖失效、12 章的超賣，
> 追下去都會停在 02、03、05 這三章的某一節。跳過前半段的話，後半段會變成抄設定。

---

## 常見誤區（課程會逐一破解）

**Redis 本體**

- 在正式環境敲 `KEYS *` 找 key——那一瞬間**整台 Redis 不服務任何人**（01 章）。
- 以為 `EXPIRE` 設好就固定了，結果業務再 `SET` 一次，TTL 靜靜地被清成永久（01 章）。
- 所有東西都用 String 存 JSON，改一個欄位要讀回整包再寫回去，而且記憶體是 Hash 版的好幾倍（02 章）。
- 一個 key 塞十萬個元素，直到某天 `DEL` 它的那一毫秒，所有人一起卡住（02、03 章）。
- 沒設 `maxmemory`——記憶體一路長到被 OOM killer 收掉，或是開始瘋狂 swap（04 章）。
- 以為 `MULTI/EXEC` 是交易，中間一條命令錯了會回滾——**它不會，前面的都已經生效了**（05 章）。

**接進 Spring**

- 用預設的 `RedisTemplate` 存物件，`redis-cli` 看到一串 `\xac\xed\x00\x05`，改個套件名整個快取全部讀不回來（06 章）。
- 以為「Redis 只是快取，掛了頂多變慢」——實際上預設沒設逾時，Redis 一卡，執行緒全部堵在那裡（06、08 章）。
- 快取穿透靠「快取 null」解決，但 null 沒設較短的 TTL，商品上架後半小時查不到（07 章）。
- 分散式鎖寫成 `if (get == null) set(...)`，兩行之間就是超賣的縫（09 章）。
- 鎖包在交易裡面（`@Transactional` 在外、加鎖在內）——鎖放掉時交易還沒提交，下一個人讀到舊資料（09 章）。
- 鎖設 30 秒過期，業務跑 35 秒，兩個執行緒同時持有鎖而且都覺得自己有鎖（09 章）。
- 用固定窗限流，窗口交界的那一瞬間可以打進兩倍流量（10 章）。
- Session 換成 Redis 之後忘了設 TTL，記憶體一路長到 `maxmemory` 開始驅逐——驅逐掉的是別人的購物車（11 章）。
- 在單機測得好好的 Lua 腳本，上了 Cluster 直接回 `CROSSSLOT`（13 章）。

---

## 基準專案

**整站只有一個專案**，每一章在它上面累加。00 章會帶你把它建起來：

```
docker run       Redis 7.2（00 章第一件事，整站都用它）
pom.xml          Boot 3.2.5 + spring-boot-starter-data-redis + H2
RedisProbe       在 Java 端印出 INFO / MEMORY USAGE / SLOWLOG —— 課文的數字都從這裡來
一張商品表        庫存 100 件，用來被 200 個執行緒同時搶（09、12 章的主角）
```

資料庫刻意用 H2：這一站要看的是 Redis，落帳只需要一個「會真的做交易」的地方。

前半段（00～05）大多在 `redis-cli` 裡進行，Java 只負責重現與量測；
後半段（06～14）才把東西搬進 Spring，每一章最後都有一節「落地到 shop-service」。

## 本站的實驗環境

| 項目 | 版本 |
|------|------|
| Redis | 7.2（Docker） |
| Spring Boot | 3.2.5 |
| Lettuce | Boot 3.2.5 內建（6.3.x） |
| Redisson | 3.27.x（09 章起） |
| JDK | Temurin 21 |
| 資料庫 | H2（內嵌，隨專案啟動） |

> ⚠️ **效能數字會因機器而異。** 03 章的 big key 阻塞時間、04 章的 `fork` 尖峰、
> 09 章的併發壓測結果都附有「在你自己的機器上重跑」的步驟，**請照著做**——
> 直接抄課文裡的逾時與過期時間會出事。

## 產出

一個能扛住搶購的訂單／商品服務，並附**可重現的實驗**：

1. 一份序列化設定，附「舊資料 / 新版本程式」的相容性測試。
2. 一個分散式鎖實作（自寫 Lua 版 + Redisson 版各一），附 200 執行緒併發下的**超賣壓測對照**，以及一次「鎖與交易順序寫反」的故障重現。
3. 一組限流器，附壓測曲線與 `429` 回應標頭。
4. 一份「Redis 拔掉 60 秒」的降級演練報告：哪些 API 該降級、哪些該直接失敗、資料庫 QPS 漲了幾倍。
5. 一份上線檢查清單（14 章），每一條都對應到前面某一節的實測。
