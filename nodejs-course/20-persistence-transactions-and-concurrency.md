# 20 — Prisma Provider、連線生命週期、交易與併發

第 19 章把回應投影與錯誤出口整理清楚。本章回到資料庫：**一次發佈不能只改文章，也必須保存「誰把哪個版本從草稿變成公開」；任何一邊失敗，整次操作都要回滾。**

我們延伸已有的 ArticleService、條件 UPDATE 與 Prisma Repository，保留認證、權限、版本及 HTTP 契約。[完整獨立範例](examples/20/README.md)與[本章契約](examples/20/BASELINE.md)可直接用 Docker 執行。

## 20.1 本章完成後應能做到什麼？

- 解釋 PrismaClient、連線池、Nest Provider 與交易 client 的生命週期。
- 為文章狀態變更新增稽核 migration，保留既有文章、使用者與 Session。
- 讓條件 UPDATE 與稽核 INSERT 使用同一個交易 client。
- 區分交易原子性、隔離等級、版本控制與唯一約束各自解決的問題。
- 用真實 PostgreSQL 驗證回滾，以及兩個連線池在同一版本上的競爭。
- 在 Docker 上驗證完整 API、重啟持久化與正常停止。

前置閱讀：[00 — 專題契約](00-course-map-and-project-contract.md)、[11 — migration](11-postgres-prisma-and-migrations.md)、[12 — 分層](12-service-repository-and-manual-di.md)、[18 — Session 與權限](18-authentication-sessions-and-guards.md)、[19 — 回應邊界](19-interceptors-filters-and-cross-cutting-concerns.md)。

技術版本完全沿用前章：Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Nest 11.2.8、Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17。沒有新增依賴或第二套 ORM。

## 20.2 先定義「成功」包含哪些資料

假設 Alice 發佈草稿 a_draft，讀取時版本為 1。成功後必須同時存在：

```text
Article：draft／version 1 → published／version 2
ArticleStatusAudit：Alice、publish、draft → published、1 → 2
```

若更新 Article 成功，但新增稽核失敗，不能回 200，也不能讓文章停在 published。這才是本章要擴充的原子性。前章雖已把 SELECT／UPDATE／讀回放在交易裡，還沒有第二份業務資料需要一起提交。

| 情境 | 文章結果 | 稽核結果 |
|------|----------|----------|
| 建立草稿 | draft、version 1 | 不新增 |
| 編輯草稿／公開文章 | 保持狀態、version + 1 | 不新增 |
| 發佈草稿 | published、version + 1 | publish 一筆 |
| 封存草稿／公開文章 | archived、version + 1 | archive 一筆 |
| 權限、版本或狀態不符 | 不變 | 不新增 |
| 稽核 INSERT 失敗 | 更新回滾 | 不新增 |
| 兩份資料寫完，callback 又拋錯 | 全部回滾 | 不保留 |

稽核只涵蓋狀態轉換。PATCH 不是狀態轉換，所以 publish 1 → 2、PATCH 2 → 3、archive 3 → 4，只會有目標版本 2、4 兩筆稽核。不能要求稽核版本一定連續，也不能靠這張表還原每次正文修訂。

既有 seed 文章可能已經是 published；新增表不替它們補造操作者與時間。歷史不存在就明確保留這個界線。

## 20.3 一個應用、一個 client，請求共用連線池

先看已有的組裝方式：

```text
main 建立 PrismaClient＋pg adapter
  → createArticleApplication 接手關閉責任
    → DatabaseModule.register(database)
      → DATABASE async factory 等待 $connect
      → Article／Auth／Health 共用同一 DATABASE
  → main 檢查必要資料表與欄位 → listen
```

PrismaClient 是應用操作資料庫的入口，並不代表永遠占用一條固定連線。這份範例的 adapter 使用 pg 連線池；請求按需要取得連線，交易在其期間使用同一條連線。[Prisma v7 連線池文件](https://docs.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-pool)

[database.ts](examples/20/src/database.ts)沿用：

```ts
const adapter = new PrismaPg({
  connectionString: url.toString(),
  max: 5,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
}, { schema });
return new PrismaClient({ adapter });
```

max 5 是每個這類 client／pool 的上限。如果啟動三個應用副本，不能把它們合計當作最多五條連線；migration CLI、測試與管理工具也可能使用連線。提高 pool 上限不是免費增加資料庫吞吐量。

Nest 的 DEFAULT scope 只是容器中的實例生命週期。必須讓功能模組匯入同一份 DatabaseModule、使用同一個 DATABASE token，才能共享 client；在兩個模組各自 new PrismaClient，仍會有兩個 pool。

本章保留現有 factory Provider，沒有再引入另一個 PrismaService。[Nest 官方 Prisma 範例](https://docs.nestjs.com/data/prisma)可用來對照 Provider 的封裝方式；本課資源所有權已有統一入口，不需要為了使用框架而重複管理同一 client。

### 連上資料庫，還不等於可以服務

$connect 能檢查連線，但不能證明 migration 已完成。本章在 [main.ts](examples/20/src/main.ts) 的 listen 前、以及 [DatabaseModule](examples/20/src/database.module.ts) 的 readiness 中，都加入 ArticleStatusAudit 可讀檢查。

```text
資料庫連線成功，但沒有 ArticleStatusAudit
  → main：STARTUP_FAILED，不開始監聽
  → 已建立的測試 app：live 200，ready 503 NOT_READY
```

live 表示程序能回應；ready 表示目前必要資料可讀。這些查詢也不是所有 migration、索引與 CHECK 都正確的完整證明，仍需 deploy／status 與測試。

### 誰負責關閉？

```text
SIGTERM／SIGINT → draining：停止接新工作
  → 等既有 HTTP 與已登記工作 → http-drained
  → 關閉 Nest app 與資源 → database.$disconnect() → closed
```

[application.ts](examples/20/src/application.ts)接手傳入 database 的關閉責任，初始化失敗也會 disconnect。不要在 Controller finally 裡斷線，也不要額外增加另一套 Nest shutdown hook 搶先關 pool。

第 18–19 章的工作追蹤仍涵蓋 Guard → handler。瀏覽器斷線不等於已開始的 Promise 或交易被取消；本章沒有增加 RxJS timeout 或取消策略。

## 20.4 設計稽核表與增量 migration

[schema.prisma](examples/20/prisma/schema.prisma)新增 ArticleStatusAction 與 ArticleStatusAudit，Article、User 各加入反向關聯。重點欄位如下：

| 欄位 | 來源與用途 |
|------|------------|
| id | Service 產生 asa_＋UUID |
| articleId | 交易內查到的文章 |
| actorId | 已驗證的實際操作者；可能為 admin |
| action | publish／archive |
| fromStatus／toStatus | 更新前文章與成功更新結果 |
| fromVersion／toVersion | 更新前版本與遞增後版本 |
| createdAt | 資料庫預設時間 |

actorId 與 authorId 不同：管理員封存 Alice 的文章，稽核應記 u_admin，文章作者仍為 u_demo。外部 body 仍只能傳 expectedVersion，不能指定 actor、狀態或稽核欄位。

不把正文、email、密碼、Cookie、CSRF、Session token 或摘要複製到稽核。createdAt 也不是精確 commit 時間或可供跨文章全域排序的流水號；同一文章的轉換先以 toVersion 判斷。

新增 migration [202611020001_article_status_audit](examples/20/prisma/migrations/202611020001_article_status_audit/migration.sql)，保留前兩份原檔。它只新增 enum、表、索引與外鍵，不改舊資料、不刪表、不回填歷史。

```sql
CREATE UNIQUE INDEX "ArticleStatusAudit_articleId_toVersion_key"
ON "ArticleStatusAudit"("articleId", "toVersion");
```

唯一鍵保證同一篇文章的同一目標版本不能重複記錄，但**不會自動替 Article 更新補稽核**。外鍵採 Restrict，避免刪除文章或 actor 後悄悄連帶刪去稽核；本課沒有永久 DELETE 端點。

版本 CHECK 使用：

```sql
CHECK (
  "fromVersion" > 0
  AND "toVersion"::BIGINT = "fromVersion"::BIGINT + 1
)
```

先轉 BIGINT 再加一，避免 fromVersion 已達 PostgreSQL Int 上限時，加法先溢位。Service 仍在 UPDATE 前以 409 VERSION_LIMIT 拒絕上限，不把資料庫錯誤當正常業務分支。

另一個 CHECK 限定 publish 為 draft → published，archive 為 draft／published → archived。這只驗證該稽核列的欄位組合，不跨表比對當前文章；原子交易仍是必要條件。

CHECK 寫在 migration SQL，Prisma schema 沒有直接表達它。後續調整資料模型時必須檢查產出的 SQL，不能因 schema 中沒看到就刪掉約束。

## 20.5 Service 決定交易要做什麼

Controller 繼續處理 HTTP；Service 負責業務順序；Repository 負責用同一個交易 client 實作資料操作。

[ArticleTransaction](examples/20/src/article-repository.ts)新增：

```ts
appendStatusAudit(input: StatusAuditInput): Promise<void>;
```

callback 內可讀文章、條件更新、追加稽核；這個應用介面不暴露 Express 或 Prisma 型別。[ArticleService](examples/20/src/article-service.ts)在既有更新成功後加入：

```ts
if (action !== 'edit') {
  await tx.appendStatusAudit({
    id: `asa_${randomUUID()}`,
    articleId: article.id,
    actorId: currentActor.id,
    action,
    fromStatus: article.status,
    toStatus: updated.status,
    fromVersion: article.version,
    toVersion: updated.version,
  });
}
return updated;
```

這段位於原本的 repository.withTransaction callback 內。必須 await，INSERT 失敗才會讓 callback 拒絕並回滾；不能 fire-and-forget，也不能在回傳成功後交給背景工作補寫。

完整業務順序沒有更動：

```text
要求 actor
  → 交易內 SELECT
  → 不存在 404
  → 不是作者也不是 admin：403
  → expectedVersion 不符：409 VERSION_CONFLICT
  → 狀態不允許：409 INVALID_STATE
  → 版本上限：409 VERSION_LIMIT
  → 條件 UPDATE、讀回
  → 未匹配：409 VERSION_CONFLICT
  → publish／archive 追加稽核
  → callback 完成、COMMIT
  → 回傳原本的八個文章公開欄位
```

保留 INVALID_STATE，不在此章暗中改成第 00 章預定的 INVALID_ARTICLE_STATE。admin 也不能跳過版本、狀態與上限。

## 20.6 Repository 決定交易如何執行

[Prisma Repository](examples/20/src/prisma-article-repository.ts)把 callback 的 tx 包成應用介面，所有方法都使用這個 tx：

```ts
withTransaction: work => db.$transaction(async tx => work({
  async appendStatusAudit(input) {
    await tx.articleStatusAudit.create({ data: input });
  },
  findById: id => tx.article.findUnique({ where: { id } }),
  // updateIfCurrent 也使用 tx.article，見完整檔案。
  updateIfCurrent,
}), {
  isolationLevel: 'ReadCommitted',
  maxWait: 2000,
  timeout: 5000,
})
```

這是結構節錄；updateIfCurrent 的完整實作保留在連結的檔案內。不能把稽核改成根 db.articleStatusAudit.create：那可能取得另一條連線，脫離目前交易，甚至在外鍵等待未提交的資料。

callback 的回傳值先交給 Prisma；外層 $transaction Promise 在 commit 成功後才完成。callback 裡的 return 並不是已經提交。交易 client 只能在 callback 期間使用，不能保存到 singleton 欄位或傳給之後執行的 timer。[Prisma v7 交易文件](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)

### 三種時間限制不是同一件事

| 設定 | 本章值 | 限制範圍 |
|------|--------|----------|
| pg connectionTimeoutMillis | 2000 ms | driver 等待取得／建立連線的限制 |
| 交易 maxWait | 2000 ms | Prisma 取得 interactive transaction 的等待限制 |
| 交易 timeout | 5000 ms | interactive transaction 的執行期限 |
| PostgreSQL statement_timeout | 5000 ms | 單一 SQL statement 的執行限制 |

這些值可能在不同層先觸發，不應將它們相加當作 HTTP 回應期限。設定期限也不代表任意 JavaScript、外部 HTTP 或 CPU 工作會自動停止；不要在交易中呼叫遠端服務、跑密碼 KDF 或等待人工輸入。

同一交易只有一條連線；把多個 tx 查詢放進 Promise.all，不能因此讓同一連線同時執行 SQL。本章依業務順序 await，讓錯誤與依賴關係清楚。

## 20.7 交易不會自動防止舊版本覆蓋

ReadCommitted 下，兩個交易都可能先讀到 draft／version 1。如果 UPDATE 只帶 id，後執行的請求仍可能覆蓋前者。原子性與防止遺失更新是兩個問題。

本課保留：

```ts
where: {
  id: current.id,
  authorId: current.authorId,
  version: current.version,
  status: current.status,
}
```

```text
A SELECT draft／1 ─┐
B SELECT draft／1 ─┴→ 兩邊都通過前置檢查
A UPDATE 條件匹配 → published／2 → INSERT 稽核 → COMMIT
B UPDATE 等待 A 釋放鎖，再檢查條件 → 0 筆
B 拋 VERSION_CONFLICT → ROLLBACK，不新增稽核
```

PostgreSQL 的 Read Committed UPDATE 會在並行更新後，針對更新後資料重新檢查條件；這是此處條件 UPDATE 的基礎。[PostgreSQL 17 隔離等級文件](https://www.postgresql.org/docs/17/transaction-iso.html)

本章三組競爭為 publish／publish、publish／archive、PATCH／publish。最後一組若 PATCH 勝出，狀態仍為 draft、版本變 2，稽核應為 0 筆；不能因另一邊曾嘗試 publish 就記成功稽核。

這不代表所有跨列規則都能靠單篇版本解決。像「所有文章只能有一篇置頂」這種跨列不變量，需要另外設計資料庫約束、鎖或隔離與重試策略。

### 為什麼列表仍用 RepeatableRead？

列表的資料與 total 需要同一請求快照，所以沿用 findMany＋count 的 RepeatableRead。文章狀態變更使用 ReadCommitted＋條件 UPDATE，兩者目的不同。

提高到 Serializable 也不能取消版本契約；它可能帶來需要辨識與處理的序列化失敗。本章沒有加入通用 retry，更不會自動把用戶的 expectedVersion 改成最新版本。舊版本回 409，讓用戶重新讀取或決定合併。

## 20.8 回滾、錯誤與外部副作用

稽核 INSERT 的外鍵、CHECK、唯一鍵或底層資料庫失敗，都沿用第 19 章未知錯誤出口：500 INTERNAL_ERROR、安全訊息、空 details、正確 requestId。不把任意 Prisma 錯誤都改成 409，也不把 SQL 或 driver message 傳回用戶。

```text
UPDATE 已完成，但 INSERT 失敗
  → callback 拒絕 → ROLLBACK
  → status／version／updatedAt 恢復
  → HTTP 500，不回半套成功文章
```

稽核與一般應用日誌也不同。Filter 可以報告一次 HTTP 錯誤，但失敗操作不會留下「成功狀態轉換」稽核；拒絕與安全事件記錄是另一項需求。

資料庫交易不能回滾已寄出的 email、第三方 API 或已送出的 HTTP response。未來若需要可靠通知，應設計 Outbox 等流程；本章只提交同一資料庫裡的兩份資料，不提前加入背景工作。

另一種情況是 commit 成功，但連線在回應前中斷。用戶沒收到 200，不等於資料庫已回滾。重送舊版本可能得到 409，應重新查詢確認；UNIQUE(articleId, toVersion) 也不是完整的 HTTP 冪等鍵設計。

## 20.9 用 Docker 操作 API

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/20
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose run --rm tools npm run seed
docker compose up -d api
docker compose run --rm tools npm run test:status-api
```

API 為 http://127.0.0.1:3020，開發 PostgreSQL 主機 15420；test-db 不公開端口。專案名稱 nodejs-course-20，與其他章的資料 volume 分開。npm ci 的新版提示不改變本課固定版本。

test:status-api 會真正登入 Alice、Bob、admin，驗證並行 publish 200／409、權限、公開範圍、Location、HEAD、admin 封存、兩筆稽核與登出。腳本只在記憶體保存憑證，保留的 proof JSON 沒有 Cookie 或 CSRF。

### 手動發佈與封存

以下在同一個 shell 執行，需本機 curl、python3；Node 與 npm 都在 Docker。暫存目錄只存本次操作檔案：

```bash
chapter20_origin=http://127.0.0.1:3020
chapter20_dir=$(mktemp -d)
chmod 700 "$chapter20_dir"
json_value() {
  python3 -c 'import json,sys; value=json.load(sys.stdin)
for key in sys.argv[1].split("."): value=value[key]
print(value)' "$1"
}

curl -fsS -c "$chapter20_dir/cookies" \
  "$chapter20_origin/api/auth/csrf" > "$chapter20_dir/csrf.json"
chapter20_csrf=$(json_value data.csrfToken < "$chapter20_dir/csrf.json")
curl -fsS -b "$chapter20_dir/cookies" -c "$chapter20_dir/cookies" \
  -H "Origin: $chapter20_origin" -H "X-CSRF-Token: $chapter20_csrf" \
  -H 'Content-Type: application/json' \
  --data '{"email":"alice@example.test","password":"Alice-course-18!"}' \
  "$chapter20_origin/api/auth/login" > "$chapter20_dir/login.json"
chapter20_csrf=$(json_value data.csrfToken < "$chapter20_dir/login.json")

curl -fsS -b "$chapter20_dir/cookies" \
  -H "Origin: $chapter20_origin" -H "X-CSRF-Token: $chapter20_csrf" \
  -H 'Content-Type: application/json' \
  --data '{"title":"交易草稿","content":"狀態與稽核一起提交"}' \
  "$chapter20_origin/api/articles" > "$chapter20_dir/article.json"
chapter20_article=$(json_value data.id < "$chapter20_dir/article.json")

curl -i -b "$chapter20_dir/cookies" \
  -H "Origin: $chapter20_origin" -H "X-CSRF-Token: $chapter20_csrf" \
  -H 'Content-Type: application/json' --data '{"expectedVersion":1}' \
  "$chapter20_origin/api/articles/$chapter20_article/publish"
curl -i -b "$chapter20_dir/cookies" \
  -H "Origin: $chapter20_origin" -H "X-CSRF-Token: $chapter20_csrf" \
  -H 'Content-Type: application/json' --data '{"expectedVersion":2}' \
  "$chapter20_origin/api/articles/$chapter20_article/archive"
```

依序得到 200 published／2、200 archived／3；再以 expectedVersion 2 封存應回 409 VERSION_CONFLICT，以 3 再封存則回 409 INVALID_STATE。成功文章仍只有八個公開欄位，不把稽核關聯加進 response。

登入後 CSRF 已輪替，不能沿用匿名 token。Cookie、Origin 與 X-CSRF-Token 的角色仍與第 18 章相同；示範密碼中的 18 沿用原值。

直接觀察資料庫：

```bash
docker compose exec -T postgres psql -U course -d course -c 'SELECT "articleId", "actorId", action, "fromStatus", "toStatus", "fromVersion", "toVersion" FROM "ArticleStatusAudit" ORDER BY "articleId", "toVersion";'
```

手動與自動驗收會各保留自己的文章，表中可能不只兩筆。每篇完成一次 publish／archive 的文章應各有兩筆，不以全表筆數代替單篇驗證。

完成手動操作後登出並清理本次暫存：

```bash
curl -i -b "$chapter20_dir/cookies" -c "$chapter20_dir/cookies" \
  -H "Origin: $chapter20_origin" -H "X-CSRF-Token: $chapter20_csrf" \
  -H 'Content-Type: application/json' --data '{}' \
  "$chapter20_origin/api/auth/logout"
rm -r "$chapter20_dir"
unset chapter20_csrf
```

### 重啟與正常停止

```bash
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:status-persistence
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

test:status-persistence 需要先成功執行 test:status-api。它讀取 `.data/status-api-proof.json`，重新登入 admin，比對文章與稽核逐欄位相同；驗證的是資料保存，沒有把舊 Session 寫入 proof。

正常停止應看到 draining → http-drained → closed。stop 保留 volume、驗收文章及 NDJSON，不用 down -v 作一般收尾。公開 NDJSON 仍是獨立教學檔，不隨文章或稽核變動，不是備份。

## 20.10 測試如何證明交易真的有效？

只 mock appendStatusAudit 並檢查「有被呼叫」，無法證明共用同一條交易連線。因此本章分成應用層與真實 PostgreSQL 兩部分：

| 測試位置 | 驗證內容 |
|----------|----------|
| article-service.test.ts | 正確 actor、前後狀態／版本、拒絕不寫、edit 不稽核、錯誤傳播 |
| status-transactions.test.ts | 真實回滾、HTTP、安全錯誤、約束、雙 pool 競爭、持久化、readiness、tx 範圍 |
| status-migration.test.ts | 從舊 schema 升級保留資料，不回填歷史，SQL CHECK 真正執行 |
| check-database-runtime.cjs | 缺稽核表時 main 拒絕監聽，原信號測試保留 |
| check-status-api.cjs | 執行中 Compose API 與開發 DB 的驗收及重啟比對 |

[交易測試](examples/20/test/status-transactions.test.ts)有兩種不同的失敗：

1. Article UPDATE 成功，稽核因真實外鍵或測試觸發器而 INSERT 失敗。檢查整筆原文章完全相同，包含 updatedAt，稽核為 0。
2. 文章及稽核都寫完，callback 才拋錯。檢查兩張表都回滾，不能只驗證第二次寫入失敗的路徑。

HTTP 故障觸發器只裝在該 suite 的隨機 schema，finally 會移除。它不掛入正式 API，也不以測試後門讓使用者注入 actor。移除故障後，用相同 expectedVersion 再發佈可成功，證明先前沒有偷增版本。

併發測試不是單純 Promise.all：先用兩個不同 pool，讓兩邊 SELECT 都完成，再解除屏障進 UPDATE，強迫發生「都讀到版本 1」的交錯。屏障只存在測試，正式交易不等待另一請求。

升級測試執行兩份舊 migration SQL，建立保留 nullable 憑證的使用者、既有 Session 與 version 7 的公開文章，再套本章 SQL。一般 fixture 則以 migrate deploy 驗證完整 migration 序列。

```bash
docker compose up -d --wait test-db
docker compose run --rm tools npm test -- --testPathPatterns=status-
docker compose run --rm tools npm run test:baseline
docker compose run --rm tools npm run check
```

完整 Jest **25 套、304 項**：原 283 項保留，新增 Service 1、交易／HTTP 19、migration 1。兩份文章 HTTP 契約與第 19 章逐位元相同，原 32 項基準繼續通過。

npm test 會刪除 .test-dist，不可與 test:runtime 並行。資料庫測試僅接受 TEST_DATABASE_URL／course_test，建立與清理自有隨機 schema，絕不清理開發 public。test:status-api／test:status-persistence 另需執行中的 API，因此不納入一般 check。

## 20.11 常見誤解與排查

| 現象或誤解 | 檢查方向 |
|------------|----------|
| 文章變了，稽核沒有 | INSERT 是否使用根 db，是否漏 await，是否離開交易後才呼叫 |
| 兩個舊版本都成功 | UPDATE 是否只有 id，是否檢查受影響筆數 |
| admin 被記成作者 | actorId 應取 currentActor.id，不取 article.authorId |
| $connect 成功就開始監聽 | 必須檢查新 migration，缺稽核表也要拒絕啟動 |
| 每次請求最後 disconnect | client 應由應用共用，等待工作完成後才關閉 |
| 稽核版本不是連續數字 | PATCH 不記狀態稽核，間隔合法 |
| 舊 published 文章沒有稽核 | migration 不補造歷史，seed 也不回填 |
| SQL CHECK 沒出現在 schema | 它由 migration SQL 維護，需保留並測試 |
| 交易失敗都是 409 | 只有已知版本／狀態等業務衝突映射 409，其餘保持安全 500 |
| retry 可以自動解決舊版本 | 不可偷偷替換 expectedVersion，應讓用戶重新讀取與判斷 |
| 沒收到 HTTP 成功就代表回滾 | commit 可能成功，需重新查詢確認結果 |
| 唯一鍵等於不可竄改稽核 | 管理者仍能直接改表，本章沒有 WORM 或法遵保證 |

## 20.12 練習與完成檢查

### 練習一：找出錯誤的交易邊界

把流程寫在紙上：先用 db.article.update，再呼叫 db.$transaction 只新增稽核。當 INSERT 失敗，哪些資料能回滾？

<details>
<summary>參考答案</summary>

只有交易內的稽核寫入受該次交易管理；之前的 UPDATE 已提交。兩份寫入必須都使用 callback 的 tx，並 await 完成。請用既有故障測試確認這種錯誤實作會失敗，再恢復正確程式。

</details>

### 練習二：預測兩個分頁的結果

兩個 pool 都讀到 draft／1，A 發佈，B 編輯標題。分別推演 A 勝出與 B 勝出的文章狀態、版本、稽核筆數。

<details>
<summary>參考答案</summary>

A 勝出是 published／2、一筆 publish 稽核；B 勝出是 draft／2、標題更新、零筆稽核。另一方皆為 VERSION_CONFLICT。不能替失敗的 publish 寫成功稽核。

</details>

### 練習三：加入明確的狀態案例

在自己的練習副本新增「admin 封存他人的 published 文章」，檢查 actorId 是 admin、authorId 不變、fromStatus 是 published、toStatus 是 archived，並確認再次封存不增加紀錄。

驗收時同時檢查 HTTP 回應、Article 與 ArticleStatusAudit；只看 200 不足以證明資料正確。

### 練習四：從資料庫限制判斷保證範圍

說明 UNIQUE(articleId, toVersion)、外鍵、CHECK、Service 交易各自能保證什麼；再指出哪些限制無法阻止管理者直接改寫資料。不要在正式示範 DB 做破壞實驗，可在隔離測試 schema 驗證。

### 完成檢查

- [ ] 能指出 client 的建立者、共用方式與唯一關閉責任。
- [ ] 新 migration 保留既有資料，沒有編造歷史稽核。
- [ ] 成功 publish／archive 與稽核同一交易提交；edit 不新增狀態稽核。
- [ ] 使用實際 actor，保留原文章作者、版本與狀態檢查順序。
- [ ] 真實 INSERT 失敗、callback 後段失敗都已驗證回滾。
- [ ] 兩個 pool 已讀相同版本後仍只有一個成功。
- [ ] readiness／啟動檢查包含新表，未知資料錯誤不洩漏內部訊息。
- [ ] Docker 完整 check、API 驗收、重啟持久化與正常停止均已完成。

下一章：[21 — API 契約、分頁／篩選、OpenAPI 與查詢成本](21-api-contracts-pagination-and-openapi.md)，整理 DTO 與回應契約、OpenAPI、分頁／篩選、相容性與查詢成本。

---

[上一章：Interceptor 與 Filter](19-interceptors-filters-and-cross-cutting-concerns.md) · [返回課程總覽](README.md) · [本章範例](examples/20/README.md) · [本章契約](examples/20/BASELINE.md)
