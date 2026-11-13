# Redis 教材修正版驗證

驗證工程每次從目前 Markdown 擷取 Java、SQL、Lua、redis.conf、ACL 及 HA 啟動指令。
測試確認修正後的預期行為，不沿用審閱時「確認 bug 存在」的斷言。

```bash
bash java/10-redis/verification/run.sh
```

需要 JDK 21、Maven、Python 3、Docker 與 ripgrep。Maven 依賴首次需下載；本機快取已備齊時可離線執行：

```bash
MAVEN_OFFLINE=1 bash java/10-redis/verification/run.sh
```

腳本建立一次性 Redis 容器，使用隨機 localhost port；測試會清除這個專用 Redis 的資料。
不要將位址改為既有業務服務。CLI 驗證的 HA、三主 Cluster、設定檔及 ACL 都在同一個
隔離容器內執行，不增加主機 port；成功或失敗均會移除容器。
可用 REDIS_IMAGE 指定相同 7.2 系列的映像。

## 檢查範圍

| 審閱問題 | 修正及驗證 |
|---|---|
| 1 | 從 06 章擷取 RedisJson 包裝 bean；實際 MVC GET 不輸出私有 password／@class，普通 POST JSON 可解析 |
| 2、3、6 | 從 10 章擷取 DurableIdempotency、IdempotencyService 與兩段 Lua；DONE 發布失敗、提交與發布間崩潰、舊 owner、scope 隔離、回滾、持久化指紋、併發唯一鍵、狀態與回應重放 |
| 4 | 實際 fencing 授予／釋放 Lua；租約過期後舊 owner 無法刪新鎖，資源端拒絕舊 fence |
| 5 | 實際令牌桶 Lua 使用 Redis TIME；Hash 時間在未來時不倒退、不重複補額 |
| 7 | 擷取實際對帳方法；正常在途預扣不被補回，兩個觀測排程不會重複修庫存 |
| 8 | 擷取章末秒殺與交易完成補償方法；售罄不回補、確定回滾補一次、補償失敗保留原始錯誤、未知完成不盲補 |
| 9、10 | 擷取實際 cache 裝飾鏈與熔斷器；回滾不發布 L1、提交後仍可 fallback、HALF_OPEN 唯一試探、忽略過期回應 |
| 11 | 編譯並使用 07 章 typed serializer 配方，確認無類別 metadata，通用 mapper 不被改動 |
| 12、20 | 擷取 12 章 List bean、扣庫存方法及實際腳本；成功／售罄／未初始化契約，拒絕負數、零、小數及非數字且不改庫存 |
| 13 | 真實三主 Cluster 執行滑動計數器；無共用 tag 回 CROSSSLOT，有 tag 可成功 |
| 14、15 | 共用 redis.conf 加兩種角色各別啟動；實際 app／monitor ACL 驗證業務命令與 Lua、禁止 CONFIG SET／FLUSHDB／ACL、拒絕 namespace 外寫入 |
| 16 | 執行擷取的 HA 啟動指令，確認目錄建立與各節點工作目錄隔離 |
| 17 | 同時匯入 HA 與 metrics 設定，唯一 ClientResources、正確 reconnect delay；不匯入自訂 metrics 時也有 Boot 預設指標 |
| 18、19、21 | 真實 JPA 代理提交例外可由外層捕捉；基線選 Redis、指定 simple 選 ConcurrentMap；快取 clear 發出 SCAN 且不發 KEYS |

## Fixture 與限制

完整類別直接擷取；片段只補 imports、建構子、Cache 介面的其他 overload、領域介面與測試 DTO。
TwoLevelCache、CircuitBreakingCache 與裝飾順序取自課文；未宣稱這些省略片段本身已是一份可獨立啟動的完整應用。
秒殺測試使用真實 Redis 預扣與 H2 交易，訂單 DAO 為在同一交易插入測試表的 fixture，限流器固定允許，
以隔離補償行為。未知完成的分支以交易同步 callback 的 STATUS_UNKNOWN 驗證，未模擬所有網路分割。
樂觀鎖使用最小 JPA @Version 交易代理案例，驗證課文的提交／catch 說明。

基線 Boot 3.2.5 加 Caffeine、Actuator；不加入後續 Redisson 的 JCache provider，以維持前期 cache provider 基線。
未執行完整 Sentinel failover 演練或重測教材效能數據；單機 fence 測試不證明切換後序號不倒退。
庫存對帳目前只觀測，修復需依 12.5.5 停止全部寫入、排空並查證結果；沒有宣稱已實作線上 reservation 帳本。
資料庫冪等只涵蓋同一資料庫交易，外部付款／寄信仍需外部冪等或 outbox。

產物位於被忽略的 target/：擷取原碼、資源、fences.json、surefire-reports、verification.log、cli-results.json。

## 本輪結果

JDK Temurin 21.0.5、Maven 3.9.16、Redis 7.2.16、Boot 3.2.5。
**28 個 JUnit 測試通過，0 failures／errors／skipped；17 項 CLI 檢查通過。**
預期故障注入會輸出 DONE 發布失敗、業務回滾、補償失敗等日誌，不代表測試失敗；
以 JUnit XML 與腳本最後的總計判定結果。

框架行為可對照 [Spring Data Redis cache 文件](https://docs.spring.io/spring-data/redis/reference/redis/redis-cache.html)
與 [Redis ACL 文件](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/)；
本輪測試另外釘住課程固定版本，沒有以最新文件取代 3.2.5 的實際行為驗證。
