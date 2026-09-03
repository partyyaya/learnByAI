# 10 — Redis 應用（Spring 視角）

> 這一站**不教 Redis 本身**，教的是「Redis 進到一個 Spring 專案裡之後，會怎麼用、怎麼壞」。
> Redis 的資料結構、持久化、Cluster、記憶體模型請看 [../../database-course/redis-course/](../../database-course/redis-course/)；
> 本站假設你已經知道 `SETNX` 是什麼，要回答的是：**序列化器選錯為什麼上線三天後才炸、鎖到底該包在交易裡面還是外面、Redis 掛掉的那 40 秒你的 API 應該長什麼樣子。**

> **與 [05-service/05](../05-service/05-caching-in-service-layer.md) 的關係**：那一章講的是 Spring 的**快取抽象**（`@Cacheable` 與交易的互動、key 設計、擊穿雪崩穿透），刻意不綁定實作。
> 這一站把那層抽象**接到真的 Redis 上**，並往抽象管不到的地方走：分散式鎖、限流、Session、預扣庫存。

---

## 學完你可以

- 說明 `RedisTemplate` 的四個序列化器分別在哪裡、選錯會在什麼時候爆，並選出一組不會被 Java 類名綁死的設定。
- 設定 Lettuce 的連線池與**三層逾時**，並說明為什麼「Redis 只是快取，掛了不影響主流程」這句話在預設設定下是錯的。
- 設計 Redis 不可用時的降級策略，讓快取層故障不會變成整站 503。
- 把 `@Cacheable` 接上 `RedisCacheManager`，做到 per-cache TTL、null 值處理與 key 前綴，並讓快取資料在服務改版後仍讀得回來。
- 實作正確的分散式鎖：知道自己寫的 Lua 版本與 Redisson 差在哪、watchdog 續期解決什麼、**鎖與 `@Transactional` 的先後順序為什麼只有一種是對的**。
- 用 Lua 實作滑動窗與令牌桶限流，並接上 [03-rest-api/08](../03-rest-api/08-idempotency-caching-and-rate-limit.md) 的限流回應標準。
- 用 Redis 做 Session 共享與 JWT 撤銷，補上 [09-spring-security](../09-spring-security/) 留下的無狀態缺口。
- 用「Redis 預扣 + DB 落帳」處理搶購，並說出它與 [07-mysql](../07-mysql/) 悲觀鎖、[08-jpa-mybatis](../08-jpa-mybatis/) 樂觀鎖三者的取捨。
- 用 Testcontainers 寫出真的會跑 Redis 的整合測試，並在 Java 端觀測連線池、big key 與 hot key 的症狀。

## 前置知識

[05-service/05](../05-service/05-caching-in-service-layer.md)（快取抽象）、[05-service/06](../05-service/06-async-and-external-api-calls.md)（逾時與重試）、[07-mysql/04](../07-mysql/)（交易與鎖）。
Redis 本身零基礎的話，先讀 [redis-course](../../database-course/redis-course/) 的 01～03、09、10 章。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | `00-course-map-redis-in-a-spring-app.md` | 課程地圖與邊界 | 這站教什麼／不教什麼、與 redis-course 的分工、四個真實事故預告、Docker 起 Redis 與 `spring.data.redis` 設定 |
| 01 | `01-spring-data-redis-and-lettuce.md` | 連線與序列化（核心章） | `RedisTemplate` vs `StringRedisTemplate`、四個序列化器的位置、JDK 序列化的三個坑、Jackson 序列化與型別資訊、Lettuce 連線池、command / connect / socket 三層逾時 |
| 02 | `02-cache-abstraction-on-redis.md` | 快取抽象接上 Redis | `RedisCacheManager` 設定、per-cache TTL、`cacheNull` 與空值、key 前綴與多環境共用實例、**改版後反序列化失敗**的處理、與 05-service/05 的三大災難對照 |
| 03 | `03-redis-failure-and-degradation.md` | 故障與降級 | Redis 掛掉時 `@Cacheable` 的預設行為、`CacheErrorHandler`、熔斷與降級開關、「快取故障不能變成資料庫雪崩」的實作、演練腳本 |
| 04 | `04-distributed-lock.md` | 分散式鎖（核心章） | `SET NX PX` + Lua 釋放、誤刪他人鎖、**過期時間怎麼估與 watchdog 續期**、Redisson 的 `RLock`、可重入與公平鎖、⚠️ 鎖必須包住交易（順序反了等於沒鎖）、RedLock 的爭議與失效邊界 |
| 05 | `05-rate-limit-and-idempotency.md` | 限流與冪等 | 固定窗的邊界問題、滑動窗與令牌桶的 Lua 實作、Bucket4j、多維度限流（IP / 使用者 / API key）、Redis 版冪等鍵與 [03-rest-api/08](../03-rest-api/08-idempotency-caching-and-rate-limit.md) 的對接 |
| 06 | `06-session-and-token-revocation.md` | Session 與 Token | Spring Session Redis、多實例共享 Session、JWT 黑名單與 refresh token 撤銷、登出與強制下線、與 [09-spring-security/04～05](../09-spring-security/) 的接法 |
| 07 | `07-hot-inventory-and-counters.md` | 熱點與計數 | Redis 預扣庫存 + DB 落帳的完整流程、對不上帳時的補償、原子計數與排行榜、hot key 的識別與拆分、**三種防超賣方案（悲觀鎖 / 樂觀鎖 / Redis 預扣）決策表** |
| 08 | `08-testing-and-operations.md` | 測試與維運 | Testcontainers Redis、`@DataRedisTest` 的限制、embedded Redis 為什麼不推薦、連線池與命令延遲指標、Java 端看到的 big key 症狀、上線檢查清單 |

---

## 常見誤區（課程會逐一破解）

- 用預設的 `RedisTemplate` 存物件，`redis-cli` 看到一串 `\xac\xed\x00\x05`，改個套件名整個快取全部讀不回來。
- 以為「Redis 只是快取，掛了頂多變慢」—— 實際上預設沒設逾時，Redis 一卡，執行緒全部堵在那裡。
- 分散式鎖寫成 `if (get == null) set(...)`，兩行之間就是超賣的縫。
- 鎖包在交易裡面（`@Transactional` 在外、加鎖在內）—— 鎖放掉時交易還沒提交，下一個人讀到舊資料。
- 鎖設 30 秒過期，業務跑 35 秒，兩個執行緒同時持有鎖而且都覺得自己有鎖。
- 用固定窗限流，窗口交界的那一瞬間可以打進兩倍流量。
- Session 換成 Redis 之後忘了設 TTL，記憶體一路長到 `maxmemory` 開始驅逐 —— 驅逐掉的是別人的購物車。
- 快取穿透靠「快取 null」解決，但 null 沒設較短的 TTL，商品上架後半小時查不到。

## 產出

替訂單系統加上一整層 Redis 能力並附**可重現的實驗**：

1. 一份序列化設定，附「舊資料 / 新版本程式」的相容性測試。
2. 一個分散式鎖實作（自寫 Lua 版 + Redisson 版各一），附 200 執行緒併發下的**超賣壓測對照**，以及一次「鎖與交易順序寫反」的故障重現。
3. 一組限流器，附壓測曲線與 `429` 回應標頭。
4. 一份「Redis 拔掉 60 秒」的降級演練報告：哪些 API 該降級、哪些該直接失敗、資料庫 QPS 漲了幾倍。
