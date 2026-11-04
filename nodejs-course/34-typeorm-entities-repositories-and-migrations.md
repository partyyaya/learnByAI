# 34 — TypeORM Entity、Repository、migration 與交易

> ORM 可以改變資料存取方式；權限、版本競爭、交易與 HTTP 契約仍要由實作與測試保證。

前置：[11 PostgreSQL／Prisma](11-postgres-prisma-and-migrations.md)、[20 交易](20-persistence-transactions-and-concurrency.md)、[21 查詢](21-api-contracts-pagination-and-openapi.md)、[29 主線完成](29-capstone-failure-drills-and-operations.md)。[獨立快照](examples/34/README.md)**從 29 分支**，以 TypeORM 0.3.28、@nestjs/typeorm 11.0.0 及原 pg 8.23.1 實作同一組文章、認證、留言與稽核契約。不要求先完成 30–33。

本章的目的，是能讀懂 Entity／DataSource／Repository／QueryBuilder 與交易作用域，並比較 Prisma。不是建議把已運作的服務全部換 ORM。

## 34.1 先建立獨立資料庫

開發及正式環境都使用本章專用 **course_orm**，不使用主線 course。測試只接受 course_test 下的 `orm34_<隨機 UUID>` schema。連線組裝會拒絕指向主線 DB。

```text
Prisma 對照：prisma/schema.prisma + 4 份歷史 migration
TypeORM 實作：src/orm/entities.ts + migration.ts
部署目標：course_orm，history=typeorm_migrations
```

保留 Prisma 依賴是為了編譯與執行主線參考測試。`npm run generate` 產生參考 client，不對資料庫執行 migration。本章 db:deploy、db:status、db:seed 明確改由 ORM release task 執行。

同一資料庫不能一邊讓 Prisma migrate、一邊讓 TypeORM synchronize 管理相同表。要做真實既有資料遷移，需另外設計 baseline、資料轉換、校驗與回退；本章沒有替既有 course 資料做這項搬遷。

## 34.2 Prisma 與 TypeORM 的對照位置

| 問題 | Prisma 主線 | TypeORM 本章 |
|------|-------------|--------------|
| 表與欄位 | schema.prisma | 裝飾器 Entity |
| 連線生命週期 | PrismaClient + adapter | DataSource initialize／destroy |
| 一般資料存取 | client.article 等 delegate | Repository／EntityManager |
| 組合查詢 | where／orderBy／select | QueryBuilder + 命名參數 |
| 交易 | $transaction 的 tx client | transaction 的 manager／QueryRunner |
| Schema 歷史 | _prisma_migrations | typeorm_migrations |
| SQL 行為保證 | 條件 UPDATE + affected count | 同樣必須明確實作 |

裝飾器描述對應關係，不會自動解決授權與查詢成本。TypeScript 欄位型別也不等於 HTTP 回應白名單。

## 34.3 Entity：欄位、關聯與敏感資料

[entities.ts](examples/34/src/orm/entities.ts)定義 User、Session、Article、ArticleStatusAudit、Comment 五個 Entity。

- `@PrimaryColumn` 保留既有文字 ID；Session 使用 tokenHash 作主鍵。
- enumName 對應 SQL enum；Date 欄位為 PostgreSQL timestamp with time zone、精度 3。
- Article.authorId、Comment.authorId 明列，配合 ManyToOne／JoinColumn；外鍵仍由 migration 建立。
- 關聯型別用 Relation<T>，避免 decorator metadata 在類別尚未初始化時讀取循環關係。
- User.passwordHash 設 select:false，登入時才 addSelect；HTTP 仍經既有 presenter 投影。
- 關聯沒有開 eager、沒有自動 cascade 寫入，刪除規則明確由 FK 管理。

select:false 是一層讀取限制，不是資料遮蔽的唯一保證。登入 Repository 會取到雜湊，故不能直接把該 Entity 序列化給 client。Session 關聯讀到的 user 也只投影身份欄位。

Article.version 刻意不用 @VersionColumn 代替原契約；版本是否匹配，必須出現在實際更新條件。

## 34.4 DataSource 與 Nest Provider

[data-source.ts](examples/34/src/orm/data-source.ts)固定：

```ts
synchronize: false
migrationsRun: false
migrationsTableName: 'typeorm_migrations'
migrationsTransactionMode: 'all'
```

PG pool 上限 5、連線期限兩秒、statement timeout 五秒。schema 先驗證再用於 search_path；HTTP 輸入不能指定 schema、SQL、資料庫或 table。

[application.ts](examples/34/src/orm/application.ts)透過 TypeOrmModule.forRootAsync 管理現有 DataSource，forFeature 提供 Entity Repository。Article／Auth／Comments 各組裝成同一組 Service token，HTTP Controller 不必知道下方是哪種 ORM。

初始化失敗要 destroy；正常 drain 先等請求結束，再關閉 DataSource。檢查 isInitialized 避免 Nest 與外層清理重複關閉。readiness 對每個 Entity 明列所有欄位（含 select:false passwordHash），以 `WHERE 1 = 0` 驗證 SQL 欄位參照，不讀回私人資料；空表也能檢出缺 Session.expiresAt 或 Comment.content。只做 count 不能證明必要欄位都存在。這不檢查索引／CHECK 或完整 schema 漂移，migration status 與 schema 審閱仍需另做。

## 34.5 Repository 與 QueryBuilder

[article-repository.ts](examples/34/src/orm/article-repository.ts)實作既有 ArticleRepository interface：

```text
public scope → WHERE status='published'
author scope → WHERE authorId=:authorId
all scope    → 只由明確授權的管理入口取得
```

query 值使用參數。標題搜尋對 `%`、`_`、反斜線做 literal escape；不能把搜尋字串直接拼成 SQL。排序只從既有 enum 選 ASC／DESC，加上 id 作同時間 tie-breaker。

list 的 count 與資料頁使用同一 REPEATABLE READ transaction；預設兩次普通查詢可能看到不同快照。頁碼、pageSize、filter 與日期格式仍由原 DTO／Service／presenter 決定。

Entity 的 createdAt／updatedAt 是 Date，HTTP 仍輸出 ISO 字串。更新不靠 ORM 暗中修補日期；SQL 明確更新 updatedAt，建立時明列時間。

## 34.6 transaction manager 必須一路傳下去

```ts
await source.transaction('READ COMMITTED', async manager => {
  // 這裡的讀取、UPDATE、Audit INSERT 都使用 manager。
});
```

進入 transaction callback 後若又呼叫外層 source.getRepository，該查詢可能走另一條連線，離開目前交易。官方也要求在交易內使用提供的 transactional manager。[TypeORM 交易文件](https://typeorm.io/docs/transactions/)

本章狀態變更流程：

```text
Service 先按既有順序檢查身份／可見性／expectedVersion／狀態
→ transaction manager 讀取目前資料
→ UPDATE ... WHERE id AND authorId AND version AND status
→ affected 必須是 1
→ INSERT Audit
→ commit；任何一步失敗 rollback
```

兩個 client 先 SELECT 到相同 version，不代表都可以成功 UPDATE。真正排除覆蓋的是條件 UPDATE。affected=0 時由原 Service 回版本衝突，不把「執行 SQL 沒拋錯」當成成功。

Audit INSERT 若因 DB CHECK 失敗，文章狀態與版本也必須回滾。測試實際修改隔離 schema 的 constraint，並非 mock Repository throw。

## 34.7 認證與留言也要移植

[auth-repository.ts](examples/34/src/orm/auth-repository.ts)保留：密碼 KDF、email 唯一、Session 輪替、撤銷與到期。輪替先以 tokenHash／未撤銷／未到期條件更新，affected=1 才建立新 Session，兩者同 transaction。

每次解析 Session 讀取目前 user role；登入後角色調整不必等 Cookie 到期。公開 user 回應不包含 passwordHash；tokenHash 也不回傳。

[comment-store.ts](examples/34/src/orm/comment-store.ts)新增留言時取得 Article pessimistic_write row lock，再判斷 published。若 archive 已持鎖，留言會等提交後看到 archived 而拒絕；不以 transaction 外的舊狀態繼續 INSERT。

刪留言只允許本人／admin，並檢查 DELETE affected。文章作者不能因擁有文章而刪除其他作者留言。封存不新增留言，但已知 ID 的合法刪除仍可進行。

## 34.8 Migration：可審閱 SQL 與獨立歷史

[migration.ts](examples/34/src/orm/migration.ts)將主線四份 DDL 的最終結構整理成一份本章 initial migration，保留欄位、FK、CHECK、UNIQUE 與索引。這是全新 DB 的初始化，不是主線 migration history 的替代紀錄。

```bash
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:status
```

本例採手寫 migration：Entity metadata 沒有逐一標示 SQL 的 CHECK 與全部 constraint 名稱，不能假設 migration:generate 會產生空差異。未來要使用自動產生工具，先補齊 metadata，再逐行檢查它是否打算刪除 CHECK、重建索引或重新命名 FK；不能直接將差異套到正式 DB。[TypeORM 產生 migration 的比較方式](https://typeorm.io/docs/migrations/generating/)

SQL 明列在 migration，API 不執行 synchronize 或自動 migration。實際正式部署仍是「獨立 migration 成功 → 啟動 API → TLS 驗收」。TypeORM 官方說明 migration 與 synchronize 的用途及部署風險。[Migration 說明](https://typeorm.io/docs/migrations/why/)

down 只允許本次測試所擁有的 orm34_UUID schema，且五張業務表全部為空。CLI 不提供 production revert。資料已寫入後的回退應先設計相容 schema 與前向修復，不能為了回到舊程式直接 DROP 資料。

## 34.9 QueryRunner 與 N+1

需要手動控制連線時，QueryRunner 的生命週期是：

```text
connect → startTransaction → commit 或 rollback → finally release
```

本章測試實際 rollback 後確認資料不存在。不要只 rollback 而忘記 release，否則 pool 容量會逐漸耗盡。

N+1 實驗先讀所有文章，再逐筆查作者，量到 1+N 次 SQL；第二組明列 JOIN 與欄位投影，量到一次 SQL。logger 只計數，不記錄密碼、query 參數或連線字串。

JOIN 並非永遠更快；一對多 JOIN 可能放大列數並影響分頁。先確定要回傳的資料形狀，再決定查詢與索引，而不是把所有 relations 都打開。

## 34.10 可執行驗收

在 `examples/34` 依 README 安裝後：

```bash
docker compose run --rm tools npm run check
docker compose run --rm browser-tests npm run test:browser
sh ci/check.sh
```

TypeORM 專屬 HTTP 測試共用 articleContract／migrationContract，再驗證登入、留言、角色變更與 admin actor；另有雙 pool 版本競爭、Audit rollback、空 schema up/down/up、非空拒絕 revert、留言 archive row lock 與真查詢次數。

專屬 runtime 腳本用 orm-main 執行 SIGINT／SIGTERM、有界 drain、未完成 body 及缺認證欄位拒絕監聽。Chromium 透過 TypeORM 組裝操作同一工作台；TLS verifier 驗證獨立 ORM migration 後的交付映像與 PG／API 重啟持久化。

歷史 Prisma 測試也保留作對照；其通過數不能全部算成 TypeORM 覆蓋。本章未複製 29 的 Prisma 專用備份／還原腳本到 ORM production，沒有聲稱已完成 TypeORM 的備份演練。實際備份策略需沿 29 的校驗原則另外實作與驗證。

## 34.11 練習與完成條件

1. 畫出 DataSource、transaction manager、QueryRunner 與 Repository 的連線關係。
2. 找出一個在 transaction 內誤用外層 Repository 的例子，說明它為何可能沒有一起 rollback。
3. 觀察兩個 pool 同版本更新的結果；指出 SQL WHERE 與 affected 的責任。
4. 比較 Entity 與 migration 的 FK／CHECK；說明 synchronize:false 時新增裝飾器不會自行更新 DB。
5. 比較 1+N 與 JOIN 的真 query count，並列出公開回應允許的欄位。

完成 00–34 後，可回 [29 主線驗收](29-capstone-failure-drills-and-operations.md)檢查整體能力；30→31→32 是累積通知選修，33／34 是各自從 29 分支的比較選修。

[上一章](33-fastify-adapter-and-platform-boundaries.md) · [課程總覽](README.md) · [範例](examples/34/README.md) · [契約](examples/34/BASELINE.md)
