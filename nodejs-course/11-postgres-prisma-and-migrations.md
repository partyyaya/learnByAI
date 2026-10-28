# 11 — PostgreSQL、Prisma 與 migration

> 將資料保存到程序之外，並讓空資料庫也能依照版本化的結構重新建立。

前幾章的 Map 很適合觀察 API，但服務重啟就會丟失新增文章，兩個實例也不共享資料。本章換成 PostgreSQL，保留 10 章的 HTTP 契約，並開始管理資料庫結構、連線與測試隔離。

完成本章後，你應能：

- 分清 Docker 主機與容器的資料庫連線位置。
- 讀懂 Prisma schema、外鍵、預設值與索引。
- 區分 generate、migration 與 seed，從空資料庫啟動服務。
- 使用 Prisma 保存、查詢與條件更新文章，避免拼接用戶輸入成 SQL。
- 驗證服務重啟後資料仍在，並隔離測試資料。
- 在程序停止時先等待請求，再關閉資料庫連線池。

前置：[10 章](10-error-handling-and-api-tests.md)，以及基本 SQL、主鍵、外鍵與交易概念。

## 11.1 本章版本與功能範圍

| 項目 | 固定選擇 |
|------|----------|
| PostgreSQL | 官方 17 bookworm 映像，Compose 固定 digest |
| Prisma CLI／Client／adapter-pg | 7.10.1，三者保持一致 |
| PostgreSQL driver | pg 8.23.1 |
| Node／npm／TypeScript | 24.22.1／11.19.1／5.9.3 |
| Express／Zod／Supertest | 沿用 10 章固定版本 |

本章採用 Prisma 7 的 schema、config、driver adapter 與 migration 指令，文件連結也指向 v7。不要在實作途中直接安裝 `@latest` 或依 CLI 的大版本升級提示改版，否則設定與指令可能不同。

功能仍是固定作者的文章 API，沒有登入授權；僅供本機教學。新增最小 User 表以建立文章作者外鍵，尚未加入密碼、Session、留言與稽核紀錄。

這一章開始需要最小的條件更新與交易，才能保持原本的版本衝突行為。20 章會再深入多筆業務資料的一致性與交易設計。

## 11.2 程序、容器與資料分別在哪裡？

```text
主機 curl → 127.0.0.1:3011 → API 容器 :3000
                                  ↓
                         postgres:5432/course
                                  ↓
                         postgres_data volume

測試容器 → test-db:5432/course_test
                  ↓
          每次測試建立的獨立 schema
```

| 誰在連線 | 位置 |
|----------|------|
| Compose 的 API／tools | postgres:5432 |
| 主機上的 Node／資料庫工具 | 127.0.0.1:15411 |
| 測試容器 | test-db:5432，資料庫 course_test |
| 瀏覽器 | 只呼叫 HTTP API，不直接連資料庫 |

容器內的 localhost 指向自己，不會自動指向主機或 postgres 容器。Compose 的服務名稱提供容器間連線所需的名稱解析。

開發 PostgreSQL 使用 named volume，保存資料；測試 PostgreSQL 使用獨立容器與 tmpfs，停止後不保留測試資料。兩者再加上不同資料庫與隨機 schema，避免把開發文章當成可任意重置的 fixture。

## 11.3 從空環境完整啟動

完整範例：[examples/11](examples/11/README.md)。從倉庫根目錄執行：

```bash
cd nodejs-course/examples/11
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose up api
```

這些步驟各有用途：

1. **build tools**：使用固定 Node 基底，安裝 Prisma migration engine 所需的 OpenSSL 與憑證。
2. **啟動資料庫**：等待 PostgreSQL 可接受連線；尚未代表應用表格已存在。
3. **npm ci**：按 lockfile 安裝套件。
4. **check**：產生 Prisma Client、型別檢查、隔離測試、建置與程序驗證。
5. **db:deploy**：把已提交的 migration 套用到開發資料庫。
6. **db:seed**：補上示範作者與三篇初始文章。
7. **啟動 API**：只有連線與 Article 查詢成功後才開始監聽。

如果只要建置及啟動、不跑測試，可將 check 換成 `npm run generate`、`npm run build`；後續仍須 deploy 與 seed。

在另一個終端機：

```bash
curl -i http://127.0.0.1:3011/health/ready
curl -i 'http://127.0.0.1:3011/api/articles?page=1&pageSize=20'
```

初始公開列表仍有 a_1、a_2，草稿 a_draft 只在示範管理端點可見。API 端口 **3011**，主機資料庫端口 **15411**。

### 為什麼多了一份 Dockerfile？

之前的 Node slim 映像沒有提供 Prisma migration engine 需要的 OpenSSL。本章的 [Dockerfile](examples/11/Dockerfile) 補上它。Node 基底與 PostgreSQL 固定 digest；apt 安裝的系統套件仍依套件庫當時版本解析，因此這是可重建的教學環境，不宣稱每次 build 都產生完全相同的映像 bytes。

## 11.4 三種容易混淆的 schema

| 名稱 | 意義 |
|------|------|
| Zod schema | 09 章的 HTTP 輸入驗證規格 |
| Prisma schema | model、欄位、關聯、enum、索引與 client generator 的描述 |
| PostgreSQL schema | 一個資料庫內的命名空間，可容納多張表 |

PostgreSQL 的 schema 類似同一個資料庫內不同目錄：不同 schema 可以有同名 Article 表。它不是天然的安全隔離牆，能否互相存取仍取決於權限；本章用來隔離測試資料。[PostgreSQL schema 文件](https://www.postgresql.org/docs/17/ddl-schemas.html)

正式資料預設位於 public。測試則由程式產生 `test_<隨機值>`，不使用讀者指定的 schema 名稱做清空操作。

## 11.5 讀懂最小資料模型

[prisma/schema.prisma](examples/11/prisma/schema.prisma) 的核心結構：

```prisma
model User {
  id          String    @id
  displayName String
  articles    Article[]
}

model Article {
  id        String        @id @default(uuid())
  authorId  String
  author    User          @relation(fields: [authorId], references: [id], onDelete: Restrict)
  title     String
  content   String
  status    ArticleStatus @default(draft)
  version   Int           @default(1)
  createdAt DateTime      @default(now()) @db.Timestamptz(3)
  updatedAt DateTime      @updatedAt @db.Timestamptz(3)

  @@index([status, createdAt, id])
  @@index([authorId, createdAt, id])
}
```

完整檔案另外包含 ArticleStatus enum、datasource 與 generator。

- id 使用文字欄位；API 保留 `a_<UUID>` 的產生方式，種子仍可用 a_1。用戶端把 ID 當成不透明字串。
- authorId 是資料庫外鍵，不能指向不存在的 User。
- onDelete: Restrict 避免刪掉仍被文章引用的作者；文章本身仍使用封存。
- status 使用 enum；version 預設 1，migration 額外加上正數 CHECK。
- createdAt／updatedAt 回 HTTP 時轉成 ISO UTC 字串，保留既有契約。
- 兩組索引分別對應公開列表與作者管理列表，索引仍有寫入與空間成本。

`@updatedAt` 是 Prisma 在更新時管理的行為，不是資料庫自動更新的 trigger。若直接使用 SQL 寫入資料，也必須處理相應欄位。

Zod 驗證與資料庫約束不互相取代：前者提供友善的輸入錯誤，後者保護所有寫入來源共同遵守的關聯與基本結構。

## 11.6 Prisma Client 與資料庫結構不是同一件事

本章 generator 使用 `prisma-client`，輸出到 `src/generated/prisma`，明確設定 CommonJS 與 `.js` 匯入副檔名，銜接既有 TypeScript 建置。產生結果由 Git 排除，schema 與 migration 則提交版本控制。[Prisma 7 generator 文件](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators)

| 指令 | 改變什麼 | 不會做什麼 |
|------|----------|------------|
| `npm run generate` | 依 model 產生 TypeScript client | 不建立資料表 |
| `npm run db:deploy` | 套用待執行的 migration SQL | 不產生 client、不填入種子文章 |
| `npm run db:seed` | 補上示範資料 | 不改變表格結構 |
| `npm run build` | 編譯程式與已產生的 client | 不連線檢查資料庫結構 |

因此，generate 成功之後若直接啟動未 migration 的資料庫，程式仍會失敗。改 model 後也不能只改 TypeScript 型別，必須一起考慮資料庫變更。

[prisma.config.ts](examples/11/prisma.config.ts) 提供 CLI 的 datasource URL；[database.ts](examples/11/src/database.ts) 則建立實際執行期 client：

```ts
const adapter = new PrismaPg({ connectionString, max: 5 });
const db = new PrismaClient({ adapter });
```

這是最小輪廓。完整程式還處理 schema 名稱、連線等待上限與 SQL statement timeout。每個程序建立一份 client／pool，不應每次 HTTP 請求都建立再銷毀一個連線池。[Prisma 7 PostgreSQL adapter](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)

## 11.7 migration 是結構變更的歷史

本章已提交：

```text
prisma/
  schema.prisma
  migrations/
    migration_lock.toml
    202610280001_init/
      migration.sql
```

初始 SQL 建立 enum、User、Article、主鍵、外鍵、版本 CHECK 與索引。資料庫另保存 `_prisma_migrations`，記錄套用結果；重跑 deploy 不會重建已完成的表格。

```bash
docker compose run --rm tools npm run db:status
docker compose run --rm tools npm run db:deploy
```

### 開發結構變更與套用既有歷史

| 情境 | Prisma 7 指令 |
|------|---------------|
| 開發者修改 model，產生新的 migration | `prisma migrate dev --name <名稱>` |
| 先產生 SQL 供檢查 | `prisma migrate dev --name <名稱> --create-only` |
| 從倉庫取得既有 migration，套用到環境 | `prisma migrate deploy` |
| 查看 migration 狀態 | `prisma migrate status` |

migrate dev 需要開發環境，可能利用 shadow database 檢查歷史，遇到結構漂移時也可能要求 reset。部署與本章自動化測試使用 migrate deploy；它套用已存在的 SQL，不替你偵測所有手動資料庫變更。[Prisma 7 migration 工作流程](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production)

本章開發帳號由官方容器建立，方便練習 migration；正式環境的應用帳號與 migration 權限應另外規劃。讀者不必先執行 reset，也不需要 `down -v` 才能繼續課程。

已套用的 migration 不應任意修改成另一份內容。想改結構時新增 migration；涉及刪欄、改型別或新增必填欄位，先處理既有資料，再考慮程式前後版本相容性。資料庫結構變更不等於「重新建立一張空表」而已。

## 11.8 seed 是教學資料，不是重置命令

本章有兩種名稱不同的 seed：

| 指令 | 內容 |
|------|------|
| `npm run db:seed` | PostgreSQL 的 u_demo、a_1、a_2、a_draft |
| `npm run seed` | 沿用 06 章的獨立 NDJSON 檔案，用於匯出練習 |

[seed-database.ts](examples/11/src/seed-database.ts) 使用 upsert，但 update 分支為空：已存在的示範文章不會被還原。讀者改過 a_1，重跑 db:seed 仍保留修改。

這表示重跑 seed 不能保證初始列表永遠有兩篇公開文章；如果你已把種子封存，它會保持封存。測試需要乾淨初始狀態時，使用自己建立的隔離 schema，不拿開發 seed 當作清空資料的工具。

## 11.9 查詢與寫入：保留輸入邊界

建立文章時，明確挑選 schema 驗證後的欄位：

```ts
await db.article.create({
  data: {
    id: `a_${randomUUID()}`,
    authorId: demoAuthorId,
    title: input.title,
    content: input.content,
  },
});
```

不要把整份 req.body 直接交給 ORM。查詢的 ID、title 等值經由 Prisma 查詢 API 傳入，不要自己把用戶輸入拼接到 SQL 字串。

測試刻意把像 `DROP TABLE` 的文字當作標題，確認它被保存成資料，Article 表也仍存在。這個案例驗證目前路徑的行為，不代表之後任意新增的 raw SQL 都自動安全。

公開列表先用 where 限定 published，再做排序、skip／take 與 count。管理列表則限定示範作者。兩個查詢使用短交易的 RepeatableRead，讓同一次回應中的 rows 與 total 看到一致快照；這不保證使用者隔幾秒翻頁仍看到完全不變的資料。

## 11.10 為什麼不能先 SELECT，再無條件 UPDATE？

Map 版本的同步函式中沒有 await；改成資料庫後，每一次查詢都有其他請求插入的機會：

```text
請求 A 讀到 version 1
請求 B 讀到 version 1
A 寫入，改成 version 2
B 如果無條件寫入，就會覆蓋 A
```

本章保留先查資料，以區分 404、舊版本與非法狀態，但真正寫入時仍帶條件：

```ts
const result = await tx.article.updateMany({
  where: { id, version: input.expectedVersion, status: article.status },
  data: { /* 允許修改的欄位 */, version: { increment: 1 } },
});
if (result.count !== 1) {
  throw new HttpError(409, 'VERSION_CONFLICT', '文章已更新，請重新讀取');
}
```

這是摘錄式示意。完整函式在交易中做條件更新與讀回結果；同一筆文章的兩個舊版本更新，最多一個能符合寫入條件。[Prisma 交易 API](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)

version 的資料庫型別是 PostgreSQL INTEGER。輸入仍接受正安全整數，先與當前版本比較，因此過大的舊版本會回 409，不會把超出 Int 範圍的條件直接交給 driver；當目前版本達欄位上限時，也明確拒絕再增加。

這裡先完成單篇文章的最小保證。稽核、跨多筆業務資料的交易、重試策略與鎖的取捨，會在 20 章深入處理。

## 11.11 連線生命週期與健康檢查

[main.ts](examples/11/src/main.ts) 先驗證 DATABASE_URL、連線並查 Article，再開始 HTTP 監聽；沒有套用 migration 時以退出碼 1 結束，不會假裝已就緒。

| 探測 | 本章意義 |
|------|----------|
| PostgreSQL healthcheck | PostgreSQL 可接受連線 |
| `/health/live` | Node 可處理 HTTP |
| `/health/ready` | 目前能執行 Article 查詢；失敗回 503 NOT_READY |
| `db:status` | migration 歷史是否還有待套用項目 |

Article 查詢成功不代表所有 schema 變更已同步，也不會保證示範作者已 seed；每個檢查有自己的範圍。

停止服務時，07 章的協調器先等待 HTTP 與登記中的資料操作，再呼叫 `$disconnect()`。即使用戶端已離線，正在收尾的查詢仍會被追蹤；不是等 response close 就立即關掉連線池。

資料庫操作仍可能超過關閉期限。driver 的等待限制、SQL timeout 與整體 shutdown 預算是不同層次，不能宣稱一個 AbortSignal 就能取消所有 SQL。本章最終失敗路徑仍由入口以非零狀態結束。

## 11.12 親手驗證 API 與 PostgreSQL 重啟

先建立一篇文章，複製回應中的真實 ID：

```bash
curl -i http://127.0.0.1:3011/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"重啟後仍存在","content":"這次保存到 PostgreSQL。"}'
```

在同一個終端機設定：

```bash
ARTICLE_ID='貼上剛建立的文章ID'
docker compose stop api
docker compose restart postgres
docker compose up -d --wait postgres
docker compose up -d api
```

等 API 日誌出現 LISTENING，再查：

```bash
docker compose logs api
curl -i "http://127.0.0.1:3011/api/me/articles/$ARTICLE_ID"
```

應仍能讀到同一篇草稿。這裡使用管理查詢，是因為新文章還沒發佈；公開端點回 404 並不代表資料丟失。

正常收工可執行 `docker compose stop api postgres test-db`。開發資料在 volume 裡；不要把刪除 volume 當成一般停止步驟。volume 能跨容器停止保留資料，但不等於已完成備份。

## 11.13 真實資料庫測試如何隔離？

[database-fixture.ts](examples/11/test/database-fixture.ts) 只接受 TEST_DATABASE_URL，且資料庫名稱必須為 course_test；缺少設定就失敗，不會自動改用 DATABASE_URL。

流程是：

```text
產生隨機 schema → 建立 schema → 套用同一份 migration
    ↓
每個案例清理自己 schema 的資料，重新 seed
    ↓
執行真正 HTTP／Prisma／PostgreSQL 操作
    ↓
關閉 server 與 client → 移除本次擁有的 schema
```

這裡的 schema 名稱只由程式產生，並記錄是否成功建立；清理不接受任意名稱，也不對 public 執行重置。SQL identifier 不能直接當一般值參數使用，故這段 DDL 僅插入由程式控制的 UUID 名稱；業務查詢仍透過 Prisma 傳值。

本章共 **27 項 Jest 測試**：保留錯誤、串流基礎與關閉協調器測試，將共用 HTTP 契約接到資料庫，再增加持久化、併發、migration、約束與回滾案例。10 章全部 89 項仍保留在原章節，兩章測試數量不應直接當成品質高低的比較。

| 資料庫案例 | 證明什麼 |
|------------|----------|
| 關閉並重建服務與 client | 新實例可讀到原資料 |
| 不同 pool 同時更新 | 同一版本只有一個成功 |
| 重跑 deploy 與 seed | 結構不重建，讀者修改不覆寫 |
| 唯一鍵／外鍵 | 真正的資料庫約束會拒絕非法資料 |
| 交易後半失敗 | 前半修改回滾 |
| SQL 形狀的文字 | 當成值保存，不當成 SQL 執行 |
| 缺表與缺設定 | 就緒檢查與實際入口正確失敗 |

`npm run test:runtime` 使用前面 test 產生的 `.test-dist`，另外建立獨立 schema，再驗證建置後入口的 SIGINT／SIGTERM 與期限。一般直接執行 `npm run check` 即可。

Prisma 7 client 內部使用動態 import；本章 Jest 指令加上 `--experimental-vm-modules`，避免 CommonJS 測試環境無法載入查詢編譯器。這是測試執行器設定，API 的一般 Node 啟動不需要該旗標。

## 11.14 本機 Node 路線與設定

若 API 在主機執行、資料庫在 Docker，先啟動 postgres，使用固定 Node／npm，並在同一個終端機設定：

```bash
export DATABASE_URL='postgresql://course:course_local@127.0.0.1:15411/course?schema=public'
npm ci
npm run generate
npm run build
npm run db:deploy
npm run db:seed
npm start
```

API 預設 3000。CLI config 與應用都讀程序環境；只建立 `.env` 檔不會自動載入它。本章 Compose 已直接注入教學環境設定，帳密僅供本機範例。

test-db 沒有對主機公開連接埠，所以完整 check 仍建議由 Docker tools 執行；不要把開發 DATABASE_URL 當作測試 URL 來繞過檢查。

## 11.15 常見問題、練習與驗收

| 現象 | 優先檢查 |
|------|----------|
| 容器連不到 localhost 的資料庫 | 是否應使用 postgres:5432？ |
| 主機連不到 postgres 這個名稱 | 主機應使用 127.0.0.1:15411 |
| generate 成功但啟動失敗 | 是否已 deploy？資料庫是否可連線？ |
| Prisma 提示 OpenSSL | 是否先 build 本章工具映像？ |
| 找不到 generated client | 是否先執行 generate，再 typecheck／build？ |
| 建立文章發生外鍵問題 | 是否先執行 db:seed 建立 u_demo？ |
| seed 後文章沒有恢復原樣 | 本章 seed 故意不覆寫既有資料 |
| Jest dynamic import 失敗 | 是否使用 package script 的 VM modules 旗標？ |
| 測試拒絕連線設定 | TEST_DATABASE_URL 是否指向獨立 course_test？ |

### 練習一：區分四個步驟

用自己的話說明 generate、build、deploy、seed 各自改變哪一份東西，並指出哪個步驟不應在每次 HTTP 請求中執行。

### 練習二：閱讀 migration

在 migration.sql 找出外鍵、版本 CHECK 與索引。說明哪些規則由 PostgreSQL 保護，哪些仍留在 Zod 或文章狀態函式。

### 練習三：規劃新增可選摘要欄位

先描述「舊資料沒有摘要」應如何回應，再考慮 schema、migration、驗證與 API 測試需要哪些調整。不要直接把舊 migration 改成新欄位版本。

### 本章完成檢查

- [ ] 能從空資料庫依序建立結構、種子與 API。
- [ ] 知道三種 schema 與不同連線位置的差別。
- [ ] 已驗證 API／PostgreSQL 重啟後文章仍存在。
- [ ] 能說明 SELECT 檢查與條件 UPDATE 的不同責任。
- [ ] 測試不清理開發資料，連線會在停止流程關閉。
- [ ] 已通過 `npm run check` 與 `db:status`。

下一章：[Controller、Service、Repository 與手動依賴注入](12-service-repository-and-manual-di.md)，將 HTTP、業務與資料存取的責任拆清楚，同時保留既有契約與交易保證。

---

[上一章：錯誤與 HTTP 測試](10-error-handling-and-api-tests.md) · [下一章：分層與手動 DI](12-service-repository-and-manual-di.md) · [返回課程總覽](README.md) · [本章範例](examples/11/README.md)
