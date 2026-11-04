# 30 — Redis 快取、cache-aside 與失效競爭

> 先決定資料是否仍可公開，再決定能否使用快取；Redis 失效不能改變授權結果。

前置：[20 交易](20-persistence-transactions-and-concurrency.md)、[21 查詢契約](21-api-contracts-pagination-and-openapi.md)、[24 觀測](24-logging-health-and-observability.md)、[29 完整專題](29-capstone-failure-drills-and-operations.md)。本章提供[獨立快照](examples/30/README.md)，在主線文章 API 加入公開資料快取；私人列表、管理查詢、認證與 Session 繼續直接使用 PostgreSQL。

完成後應能建立 Redis 容器、使用 Node client 與 Nest Provider、觀察命中及回源、處理 TTL／壞資料／中斷，並解釋為什麼「寫入後 DEL」仍可能被晚到讀取補回舊資料。本章沒有新增 JSON API 或 migration；OpenAPI 維持 21 paths／38 operations、28.0.0。

## 30.1 cache-aside 從哪裡開始？

最基本流程：

```text
讀取：GET cache → 命中則回傳；miss → 查 DB → SET cache＋TTL
寫入：提交 DB → 失效 cache → 後續讀取重新建立
```

快取不是新的真實來源。若把 /api/me/articles 的整份 HTTP 回應只按 URL 存起來，Alice 和 Bob 可能共用同一份私人內容；若快取 Set-Cookie 或登入回應，還會混入 Session／CSRF。本章只在 ArticleRepository 的公開讀取邊界快取資料，不安裝全域 CacheInterceptor，不快取整個 response。

Redis 的 cache-aside 與失效原則可對照[官方快取說明](https://redis.io/docs/latest/develop/get-started/data-store/)。實際行為以本章固定版本與測試為準，不能從範例推論所有產品都應加 Redis。

## 30.2 啟動獨立 Redis 與資料庫

先完成[00 的 nvm／Node](00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[01 的 Docker](01-runtime-tooling-and-project-setup.md)。從倉庫根目錄：

```bash
cd nodejs-course/examples/30
nvm install
nvm use
docker compose build tools browser-tests
docker compose up -d --wait postgres test-db cache-redis
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api
```

工作台 http://127.0.0.1:3030，PG 15430；外部 lab 3130／upstream 3230／效能 lab 3330／CORS lab 4030。專案 nodejs-course-30，volume 與其他章分開。帳密沿用18章，seed 不覆寫既有資料，Cookie 不按 port 隔離；同時操作多章時使用不同瀏覽器 profile，或一次只操作一章。[Cookie 的 port 邊界](https://www.rfc-editor.org/rfc/rfc6265.html#section-8.5)

新增 ioredis **5.8.2**；Node／npm／Nest／Prisma 等版本不升級，lockfile 固定新增節點。Redis 使用 **7.2 的固定映像 digest**，無主機 port、64 MiB maxmemory、allkeys-lru、不做 AOF 或 RDB 持久化；丟失快取應可回源重建。容器本身 memory limit 128 MiB，不能把 maxmemory 當成程序全部記憶體。

```bash
docker compose exec cache-redis redis-cli PING
docker compose exec cache-redis redis-cli INFO memory
docker compose exec cache-redis redis-cli --scan --pattern 'course30:*'
```

這些命令只看本章私有 Redis。不要使用 FLUSHALL，也不要在共用環境使用無限制 KEYS *；測試的少量 key 清理只針對自己的隨機前綴。

## 30.3 把連線交給 Nest 生命週期

[public-cache.ts](examples/30/src/public-cache.ts)提供 PublicCacheModule／PUBLIC_CACHE token。Provider 建構時只建立 lazy client；到 onModuleInit 才開始連線，onModuleDestroy 結束 client。

這個順序很重要：TestingModule.compile 若因其他 Provider 失敗，Nest application 尚未取得完整容器；在 constructor 就開始背景重連，可能留下無人關閉的 socket／timer。本章有對應的初始化失敗測試，不能以 Jest --forceExit 掩蓋資源問題。

主要連線設定：

| 設定 | 本章值與理由 |
|------|--------------|
| enableOfflineQueue | false；離線時不把大量快取命令留在記憶體 |
| connectTimeout | 200 ms，限制單次連線等待 |
| commandTimeout | 150 ms，快取命令失敗便回源 |
| maxRetriesPerRequest | 0，不重送同一筆快取命令 |
| retryStrategy | 1 秒後嘗試恢復連線；不是無界命令佇列 |
| payload | 寫入／解碼門檻512 KiB；過大結果不儲存，過大的既有值刪除後回源 |

512 KiB 是應用層門檻：GET 先取回字串才檢查大小，並非 Redis socket 的串流讀取上限。

參數屬於本機實驗預算，不是保證150 ms整個API必定完成。重連、offline queue 與關閉語意見 [ioredis 官方文件](https://github.com/redis/ioredis#auto-reconnect)。本例私有網路使用無密碼的 local Redis URL；公開／跨主機環境需要另設認證、TLS 與網路授權。

## 30.4 為什麼只有 DEL 還不夠？

```text
R 查到舊文章v1，尚未SET
  → W修改為v2，提交後DEL
  → R晚到，SET回v1
  → 後續請求又讀到舊資料
```

只調整 DEL 與 COMMIT 的先後，無法消除所有跨系統競爭。DB 與 Redis 也沒有共享本章的資料交易。

本章採用[帶版本指紋的 Repository](examples/30/src/cached-article-repository.ts)：

```text
公開單篇
  → PostgreSQL只讀id／version，並確認status=published
  → key = hash(schema、article、id、version)
  → Redis命中：驗證格式、ID與版本，復原Date
  → miss：查完整公開文章；仍符合指紋才寫入cache
```

寫入提交後會盡力刪除舊單篇 key；即使 DEL 失敗或舊讀取晚到，新請求也只會選目前版本的 key。封存後 DB gate 不再找到公開文章，直接404，不能因 Redis 留有 v1 就公開它。資料庫不可達時也不採用 Redis 繞過可見性判斷。

這個讀取仍有 PostgreSQL 成本，並非「命中時零 SQL」。它省下完整正文的重讀與傳輸，換取較容易驗證的可見性與版本一致性。是否值得採用，要依25章的方法量測；不宣稱這比所有其他方案都快。

已開始的讀取仍可能與封存重疊，其判斷基準是該次 DB snapshot；不能要求回應送達時所有並行交易都尚未改變資料。

## 30.5 列表 key 要包含哪些東西？

公開列表先以 RepeatableRead 取得目前這一頁的 id／version 與 total，再以 query＋這份指紋產生 key。q 仍是標題字面搜尋，sort、分頁與排序規則不變，私人 status 篩選不能混進公開範圍。

cached page 必須符合目前的 ID／version 序列、page／pageSize／total；否則丟棄並回源。建立、編輯、發佈或封存會改變後續指紋，舊列表 key 因而不再被選中，等待 TTL 清除。

同樣地，count 與搜尋成本沒有消失。本章用它教「指紋與一致性」，而不是用 Redis 掩蓋昂貴查詢；也不保證跨請求 offset 不重複或不漏項。

## 30.6 私人查詢、壞資料與大量 miss

- author／all scope 直接走原 Repository，不碰公開快取；admin 的本人列表也仍只查本人。
- JSON 經明列欄位的 schema 驗證，日期轉回 Date，才能沿用既有 presenter；額外欄位不流入 HTTP。
- 壞 JSON、錯誤版本或過大的 cache value 當成 miss，嘗試刪除並回源。
- null／不存在不寫快取，避免負面快取政策與權限判斷混在一起。
- 相同 key 的 miss 在單程序合併；registry 最多64筆。更多不同 key 直接回源，不建立無界等待佇列。
- TTL 隨機20–30秒，降低大量同時到期；不把 TTL 當成主要授權或失效機制。

合併只在同一程序有效，多副本仍可能各自回源。此策略也不限制整台 HTTP 服務的所有請求；DB pool／admission 的觀念仍見25章。Redis 是受信任的基礎設施，schema 驗證不等於對惡意 cache 管理者的內容簽章。

snapshot 提供 hits／misses／bypass／invalid／errors／writes／coalesced 等有限數值，供測試與量測；不把 key、使用者、Cookie 或文章內容印成日誌 label，也沒有新增公開 debug API。

## 30.7 真正停止 Redis

正式部署沿用26章的本機TLS演練，HTTP30830／HTTPS localhost:34430：

```bash
docker compose run --rm tools npm run deploy:init
docker compose -f compose.production.yaml build api migrate verifier
sh scripts/deploy-local.sh
sh scripts/check-runtime.sh
sh scripts/check-cache-outage.sh
```

cache-outage 腳本先驗證目前 HTTPS 文章與 Session，再停止本章 production 的 cache-redis、重驗同一基準，最後啟動 Redis 再驗一次。PG 持續運作，ready仍200；Redis故障不能把已提交的寫入誤報為失敗，也不影響Session來源。

如果先執行完整CI，使用它的映像時保留 `export RELEASE_ID=local-ci`。Session固定30分鐘，過期後需一般verifier建立新基準，不略過到期檢查。

```bash
sh ci/check.sh
```

完整CI還包括主線全部Jest、兩個worker隔離測試、原生client、真Chromium、runtime限制、TLS、PG故障與備份隔離還原。快取不是備份，Redis容器停止不刪除PG volume；29章的操作限制繼續適用。

## 30.8 練習與驗收

### 練習一：停在最危險的位置

讓讀取R拿到v1後暫停；另一個請求編輯／封存並提交，再讓R繼續補cache。比較只DEL與版本指紋：哪個key仍可能留下？後續讀取是否能選到它？

<details><summary>參考答案</summary>

舊v1 key可能留到TTL；新請求先查DB，版本變為v2或已非published，就不會選v1。這不依賴DEL成功，也不允許Redis故障時跳過DB gate。

</details>

### 練習二：快取整個登入回應

列出至少三項不可快取的資料；再以Alice／Bob各自Cookie jar讀本人列表，確認沒有公開cache hit增加。

<details><summary>參考答案</summary>

Session Cookie、CSRF、密碼資料、私人列表及管理查詢不能按公開URL共用。登入成功的Set-Cookie更不能被下一位使用者重用。

</details>

### 練習三：有Redis為什麼還會慢？

對照 fingerprint查詢、count、JSON編解碼與 cache command 耗時。說明是否真的減少正文讀取，並保留命中率、回源數與失敗率；不要只比較最快的一次。

### 驗收與停止

[test/public-cache.test.ts](examples/30/test/public-cache.test.ts)使用真Redis／PG，驗證命中、TTL到期、壞JSON、公開／私人分流、編輯／封存及不可達降級；只刪自己的隨機前綴。全量主線契約也必須通過。

```bash
docker compose -f compose.production.yaml stop proxy api postgres cache-redis restore-db
docker compose stop api cors-lab performance-lab external-lab upstream postgres test-db cache-redis
```

保留資料與proof，不用down -v。下一章將Redis用於工作佇列；可被淘汰的快取與不可任意丟失的工作會使用不同Redis服務。

---

[上一章：故障與維運](29-capstone-failure-drills-and-operations.md) · [下一章：BullMQ與Outbox](31-background-jobs-outbox-and-idempotency.md) · [課程總覽](README.md) · [範例](examples/30/README.md) · [契約](examples/30/BASELINE.md)
