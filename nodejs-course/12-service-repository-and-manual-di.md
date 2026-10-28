# 12 — Controller、Service、Repository 與手動依賴注入

> 第 11 章讓資料進入 PostgreSQL。本章保持相同 HTTP 契約，把「如何回應 HTTP」「什麼操作合法」「如何存取資料」拆開。最後不啟動資料庫，也能測試文章狀態規則；連上真實資料庫時，仍保有交易與版本衝突保護。

## 12.1 本章目標與前置知識

讀完並完成範例後，你應能：

- 追蹤 Controller → Service → Repository 的呼叫，而不是只記住三個資料夾名稱。
- 讓 Service 使用普通資料與 Promise，不依賴 req／res、HTTP 狀態碼或 Prisma Client。
- 用函式參數手動注入依賴，說明由誰建立物件、誰負責關閉連線。
- 把業務錯誤轉成原有的 404／409，未知錯誤仍回安全的 500。
- 在分層之後保留條件 UPDATE、交易回滾與列表一致快照。
- 區分 Service 單元測試、HTTP 測試與真實 PostgreSQL 測試的證明範圍。

先完成 [09 章的驗證](09-middleware-order-and-input-validation.md)、[10 章的錯誤與測試](10-error-handling-and-api-tests.md)、[11 章的資料庫](11-postgres-prisma-and-migrations.md)。本章完整快照在 [examples/12](examples/12/README.md)，不引用前章的程式檔案。

版本維持 Node **24.22.1**、npm **11.19.1**、TypeScript **5.9.3**、Jest **30.2.0**、Express **5.3.0**、Zod **4.6.7**、Supertest **7.3.1**、Prisma CLI／Client／adapter-pg **7.10.1**、pg **8.23.1**、PostgreSQL **17**。本章不新增套件、不修改既有 migration。

## 12.2 先看問題：為什麼測狀態規則也要啟動資料庫？

第 11 章的 `articles.ts` 同時做了這些事：

```text
呼叫 Prisma 查文章
  → 判斷版本與狀態
  → 呼叫 Prisma 更新
  → 把 Date 轉成 HTTP 的 ISO 字串
  → 出錯時拋出帶 HTTP status 的 HttpError
```

程式仍能運作，但要測「已封存不能再發佈」，就必須先準備 Prisma、資料庫與資料。若日後從排程呼叫同一規則，排程還會碰到與 HTTP 有關的錯誤型別。

先確定責任，再搬動程式：

| 位置 | 本章負責 | 具體例子 |
|------|----------|----------|
| Router／middleware | URL、方法、驗證、執行順序、追蹤工作 | PATCH 先跑 Zod，輸出放 res.locals |
| Controller | 讀驗證結果、呼叫 Service、呈現 HTTP | 建立成功回 201 與 Location，日期轉 ISO |
| Service | 文章用例、可見範圍、狀態與版本規則 | 封存後不能修改；舊版本優先回衝突 |
| Repository 介面 | 描述用例需要的資料操作與保證 | 條件更新沒匹配回 null，交易失敗須回滾 |
| Prisma Repository | 實作查詢、條件 UPDATE、資料庫交易 | where 帶 id＋version＋status |
| 組裝入口 | 建立與串接依賴、接上資源關閉 | 一份 database → 一份 repository → 一份 service |

Controller 不需要是 class，Repository 也不必做成通用 CRUD 基底類別。本章使用函式與物件，讓依賴方向可以直接看見。

## 12.3 先固定外部行為，再重構內部

本章沿用 `test/api-contract.ts`，內容與 10、11 章相同；另補測分層後的風險。以下行為不因換檔案而改變：

| 操作 | 保留的契約 |
|------|------------|
| 建立草稿 | 固定作者 u_demo，201，Location 指向 `/api/me/articles/:id` |
| 公開列表／詳細查詢 | 只提供 published；草稿、封存與不存在的文章均不可由公開詳細端點讀取 |
| 管理查詢 | 只列固定示範作者的文章；尚無認證授權 |
| PATCH／publish／archive | 必須提供 expectedVersion；成功加 1，舊版本回 409 |
| 封存文章 | 不能編輯、重新發佈或再次封存；不提供永久 DELETE |
| 輸入驗證 | JSON body 上限 16 KiB，Zod 拒絕額外欄位，驗證輸出放 res.locals |
| preview／export | preview 不寫入；export 讀獨立 NDJSON 教學檔，並非資料庫匯出 |
| 停止程序 | 沿用 07 章協調器，等待 HTTP 與登記工作，再清理共享資源 |

固定作者只是本機教學前提。管理查詢的作者條件不代表已完成授權；本章也不新增寫入端的身分判斷。18 章才會加入真正認證與擁有者權限。

## 12.4 先定義應用自己的資料型別

[article-model.ts](examples/12/src/article-model.ts) 定義 Article、輸入、查詢範圍與 ArticleError。Article 的時間欄位保留 Date，直到 HTTP 邊界才轉字串：

```ts
export type ArticleStatus = 'draft' | 'published' | 'archived';
export interface VersionInput { expectedVersion: number }
export interface PatchInput extends VersionInput {
  title?: string;
  content?: string;
}
export type ArticleScope =
  | { kind: 'public' }
  | { kind: 'author'; authorId: string };
```

這是完整型別檔的局部摘錄。Service 匯入這些應用型別，不匯入 Prisma 產生的 Article 型別，也不需要知道 Express 的 Response。

Zod 的輸出型別仍在 `schemas.ts`。Controller 接到它後，傳入結構相容的 Service 參數；TypeScript 依物件結構檢查相容性。若日後輸入格式不同，就在邊界明確轉換，不以強制型別轉換掩蓋差異。[TypeScript 介面與結構型別](https://www.typescriptlang.org/docs/handbook/interfaces.html)

TypeScript 型別不會在執行期清理資料。Controller 裡的 `as DraftInput` 只描述「先前 middleware 已驗證的 res.locals.body」，不能代替 Zod。若日後加入 CLI 或工作佇列入口，也要在該入口驗證外部輸入。本章 Service 假設收到已驗證的輸入；它負責的狀態規則仍會再次查詢當前資料後判斷。

## 12.5 Repository 介面要描述保證，不只列出方法名稱

完整介面在 [article-repository.ts](examples/12/src/article-repository.ts)。一般查詢與建立包含 list、findVisible、create；需要交易的更新另提供：

```ts
export interface ArticleTransaction {
  findById(id: string): Promise<Article | null>;
  updateIfCurrent(
    current: Article,
    changes: ArticleChanges,
  ): Promise<Article | null>;
}

// ArticleRepository 的其中一個方法：
withTransaction<T>(
  work: (tx: ArticleTransaction) => Promise<T>,
): Promise<T>;
```

這是介面摘錄，最後一個方法寫在 ArticleRepository 裡，不是單獨可執行的程式。

三個重要約定：

1. `findById` 找不到回 null，讓 Service 決定業務上的錯誤。
2. `updateIfCurrent` 必須同時比對 id、version、status；成功遞增版本並回傳更新後資料，沒匹配回 null。
3. `withTransaction` 等 callback 成功才提交；callback 拋錯就回滾。只能在 callback 期間使用傳入的 tx。

泛型 T 表示「callback 回傳什麼，交易完成後就取得什麼」。本例更新回 Article，測試也能回傳其他結果；不是把 Prisma 的 transaction client 往上傳。

接口本身無法保證實作者真的用了交易。所以我們會直接測試 Prisma Repository 的回滾與條件更新，不能只靠型別編譯成功。

## 12.6 Service 保留業務判斷與錯誤順序

[article-service.ts](examples/12/src/article-service.ts) 的工廠函式收下 Repository：

```ts
export function createArticleService(repository: ArticleRepository) {
  // list、detail、create、change 共用這個注入的 repository。
  // 回傳各用例函式；完整程式見範例檔。
}
```

這就是手動依賴注入：使用者從外面把依賴傳進來，Service 不在內部建立資料庫，也不從全域容器尋找 Repository。閉包保留傳入的物件，之後每次呼叫使用同一份依賴。

`change()` 的流程是：

```text
要求 Repository 開啟交易
  → tx.findById(id)
  → 不存在：NOT_FOUND
  → expectedVersion 不同：VERSION_CONFLICT
  → 已封存，或非草稿卻要求發佈：INVALID_STATE
  → 當前版本已達 2147483647：VERSION_LIMIT
  → tx.updateIfCurrent(剛才讀到的文章, 允許的變更)
  → 沒匹配：VERSION_CONFLICT
  → 回傳更新後文章，交易成功提交
```

這裡刻意保留第 11 章的錯誤優先順序。例如封存文章收到舊版本時，先回 VERSION_CONFLICT；用最新版本重試，才回 INVALID_STATE。重構不能無意中改變這些外部可觀察結果。

Service 只挑選 title／content，決定目標 status。Repository 負責實際版本遞增；沒有在 Service 算一次，又讓 Prisma increment 再加一次。建立文章也明確挑選輸入欄位，再由應用指定 ID 與固定作者。

## 12.7 分層之後，交易邊界不能散掉

容易出問題的拆法：

```text
Service 讀取文章 → 第一個交易結束
Service 判斷規則
Service 呼叫無條件 update(id, changes) → 覆蓋另一請求的新內容
```

本章透過 `withTransaction` 保留同一段交易：Service 決定哪些步驟是一個用例，Repository 決定如何用 Prisma 執行。Service 在 callback 裡使用的兩個方法都綁定到同一個 tx。

[prisma-article-repository.ts](examples/12/src/prisma-article-repository.ts) 的關鍵寫入如下，這是方法內的局部摘錄：

```ts
const result = await tx.article.updateMany({
  where: {
    id: current.id,
    version: current.version,
    status: current.status,
  },
  data: {
    // 完整程式另外挑選 title／content。
    status: changes.status,
    version: { increment: 1 },
  },
});
if (result.count !== 1) return null;
return tx.article.findUniqueOrThrow({ where: { id: current.id } });
```

不要因為外層有 transaction，就移除 UPDATE 的版本條件。兩個交易仍可能先後讀到同一版本，條件 UPDATE 才決定誰能寫入。更新與讀回結果都使用同一個 tx；callback 拋錯時，前面的寫入也會回滾。Prisma 的 interactive transaction 支援這種讀取、判斷、寫入流程；交易應保持短小。[Prisma 7 交易文件](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)

列表的 rows 與 total 仍在 RepeatableRead 交易中查詢。Repository 先套用 published 或 authorId 篩選，再排序、分頁與計數；不能先取一頁，再在 Service 過濾，否則筆數與 total 容易失真。

本章的介面只涵蓋文章操作。未來需要「文章變更與稽核紀錄一起提交」時，必須設計能涵蓋兩者的交易邊界，不能讓兩個 Repository 各自開交易就宣稱整體原子化。交易內也不要等待寄信或外部 HTTP。

## 12.8 Controller 與錯誤出口處理 HTTP

[article-controller.ts](examples/12/src/article-controller.ts) 的建立方法：

```ts
create: async (_req: Request, res: Response) => {
  const article = await service.create(res.locals.body as DraftInput);
  res.location(`/api/me/articles/${article.id}`)
    .status(201)
    .json({ data: present(article) });
},
```

這段寫在回傳物件裡。present 明列公開欄位，將 createdAt／updatedAt 轉 ISO 字串；未來資料模型增加內部欄位，不會因為展開整個 ORM 物件就自動加入 HTTP 回應。

Service 拋出的 ArticleError 只有業務代碼與訊息，不帶 HTTP status。[errors.ts](examples/12/src/errors.ts) 在原有集中出口補上轉換：

```text
ArticleError(NOT_FOUND) → 404
ArticleError(VERSION_CONFLICT／INVALID_STATE／VERSION_LIMIT) → 409
既有 HttpError → 保留原處理方式
未知錯誤 → 500 INTERNAL_ERROR，不公開 driver 訊息
```

Controller 不必每個方法都寫相同 try/catch。Express 5 會接住 handler 回傳 Promise 的 rejection；因此 server 的 tracked 包裝也必須把 Promise 回傳給 Express。[Express 錯誤處理](https://expressjs.com/en/guide/error-handling/)

```ts
const tracked = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res) => lifecycle.track(handler(req, res));
```

不要改成 `{ void handler(req, res); }`。那樣會丟掉 Promise，既破壞錯誤傳遞，也可能遺失停止時要等待的工作。callback／事件錯誤的處理方式仍依第 10 章；分層不會替背景回呼自動建立錯誤邊界。

## 12.9 手動組裝依賴與資源所有權

[application.ts](examples/12/src/application.ts) 是組裝入口，主線如下：

```text
main：驗證環境 → 建立 database → 連線與啟動前查詢
  → application：建立 Prisma Repository(database)
    → 建立 Article Service(repository)
      → server：接收 Service → 建立 Controller(service) → 掛路由
```

這裡的組裝入口也常稱 composition root。正式程式與資料庫整合測試都走這條路；HTTP 邊界測試可以直接呼叫 createArticleServer，注入假的 Service。

server 只需要 `articles`、`checkReady` 與 shutdown options。它不匯入 Database 或建立 Prisma Repository。application 把 `checkReady` 接成 Article 查詢，把 `closeResources` 接到資料庫 disconnect。

```text
停止信號
  → 停止接受新工作
  → 等待 HTTP 與 lifecycle.track 登記的 Promise
  → 執行額外 closeResources
  → finally 關閉 database
```

createArticleApplication 接收 database 後，也承接該應用停止時的關閉責任。因此不要讓兩個會各自 shutdown 的應用共用同一個 client；資料庫測試會替每個服務建立獨立 client／pool。main 若在開始監聽前失敗，則負責關閉自己建立的 client。

Repository 不會每次操作都 connect／disconnect，Controller 也不保存 req／res 作為跨請求欄位。工廠建立的依賴可以共用，請求資料則留在每次函式呼叫裡。這些生命週期選擇，之後可對照 NestJS 的 Provider 與 scope。

## 12.10 測試替身：只替換需要控制的依賴

[article-service.test.ts](examples/12/test/article-service.test.ts) 建立符合 ArticleRepository 的物件，控制讀取結果與更新結果。最關鍵的競態測試是：

```ts
const { service, tx } = setup();
tx.updateIfCurrent.mockResolvedValue(null);
await expect(service.change('a_test', { expectedVersion: 1 }, 'publish'))
  .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
```

這段使用測試檔內的 setup。讀取回傳有效草稿，但更新回 null，模擬「檢查後被搶先修改」。如果 Service 忘了檢查更新結果，這個測試就會失敗。

另有表格化案例驗證：找不到、舊版本、非法狀態、版本上限、合法轉換，以及失敗時不呼叫 update。如果只測「Repository 方法有被呼叫」，卻不檢查拒絕、回傳資料與版本，就很難保護用例行為。

測試裡的 withTransaction stub 只執行 callback。它**沒有實作鎖、隔離級別或回滾**；測試通過只能證明 Service 在指定依賴結果下做出正確決策，不能證明 PostgreSQL 行為。

| 測試檔 | 使用真實什麼 | 主要驗證 |
|--------|--------------|----------|
| article-service.test.ts | 真實 Service，Repository 替身 | 業務規則、錯誤優先序、衝突與拒絕寫入 |
| controller.test.ts | 真實 HTTP／middleware／Controller，Service 替身 | 驗證結果、日期、Location、錯誤映射、離線後工作追蹤 |
| database.test.ts | 完整組裝、Prisma、PostgreSQL | 原 HTTP 契約、持久化、併發、Repository 條件更新與回滾 |
| 既有 error／streams／shutdown 測試 | 對應元件 | 錯誤出口、串流與關閉基礎 |
| check-database-runtime.cjs | 建置後的真實子程序與隔離資料庫 | 設定失敗、缺 migration、SIGINT／SIGTERM、停止期限 |

資料庫測試新增一個同步屏障：讓兩個不同 pool 的交易都完成 SELECT 才一起 UPDATE，確認恰好一筆成功。這個等待只存在測試；正式用例不應故意把交易停在那裡。

另有測試先完成條件 UPDATE，再在同一 callback 拋錯，最後重新查資料，確認標題、版本與時間都回到更新前。它能抓出「介面宣稱 transaction，實作卻偷偷使用外層 db」的錯誤。

## 12.11 Docker：從乾淨的第 12 章環境開始

本章使用獨立 Compose 專案與 volume。第 11 章資料不會自動複製過來，原章節仍可獨立執行。從倉庫根目錄：

```bash
cd nodejs-course/examples/12
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose up api
```

本章共 **58 項 Jest 測試**：19 項 Service、8 項 Controller、15 項資料庫／HTTP，以及 16 項沿用的錯誤、串流與 shutdown 測試。check 依序執行 generate、typecheck、Jest、build 與真實程序測試。測試仍只接受 TEST_DATABASE_URL，限制資料庫名稱為 course_test，建立隨機 schema，最後刪除自己建立的 schema。它不替開發資料庫 deploy 或 seed，因此兩個步驟仍須另外執行。

| 使用位置 | 位址 |
|----------|------|
| 主機呼叫 API | http://127.0.0.1:3012 |
| 主機連開發 PostgreSQL | 127.0.0.1:15412 |
| tools／api 容器連開發資料庫 | postgres:5432/course |
| 測試容器連測試資料庫 | test-db:5432/course_test，不公開主機端口 |

PostgreSQL 17 映像與 Node 基底沿用固定 digest，Dockerfile 仍加裝 OpenSSL。Jest 透過 script 使用 `--experimental-vm-modules`，API 啟動不需要此旗標。完整設定可對照 [compose.yaml](examples/12/compose.yaml) 與 [package.json](examples/12/package.json)。

### 只跑 Service 測試，不啟動 PostgreSQL

安裝依賴後執行：

```bash
docker compose run --rm tools npm run generate
docker compose run --rm tools npm test -- --testPathPatterns=article-service.test.js
```

generate 與本例的全專案 TypeScript 編譯仍需要產生的型別；CLI 設定也會讀 DATABASE_URL，但這兩步不連線查詢 PostgreSQL。tools 沒有 depends_on，因此以上命令不會啟動資料庫容器。完整 check 則仍需要 test-db。

若用主機 Node 跑 API，固定 Node／npm 版本後設定：

```bash
export DATABASE_URL='postgresql://course:course_local@127.0.0.1:15412/course?schema=public'
export PORT=3012
npm ci
npm run generate
npm run build
npm run db:deploy
npm run db:seed
npm start
```

先以 Docker 啟動 postgres。環境變數須設在同一個終端機，本章不會自動載入 `.env`。完整資料庫測試建議使用 tools，因為 test-db 不公開主機端口。

## 12.12 親手觀察契約與失敗路徑

在另一個終端機先建立草稿：

```bash
curl -i http://127.0.0.1:3012/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"手動 DI","content":"HTTP 與業務分開。"}'
```

應回 201、version 1 與管理端點 Location。複製真實 ID 後依序執行：

```bash
ARTICLE_ID='貼上剛建立的文章ID'
curl -i "http://127.0.0.1:3012/api/articles/$ARTICLE_ID"
curl -i "http://127.0.0.1:3012/api/me/articles/$ARTICLE_ID"
curl -i -X PATCH "http://127.0.0.1:3012/api/articles/$ARTICLE_ID" \
  -H 'Content-Type: application/json' \
  --data '{"title":"修訂標題","expectedVersion":1}'
curl -i -X POST "http://127.0.0.1:3012/api/articles/$ARTICLE_ID/publish" \
  -H 'Content-Type: application/json' --data '{"expectedVersion":1}'
curl -i -X POST "http://127.0.0.1:3012/api/articles/$ARTICLE_ID/publish" \
  -H 'Content-Type: application/json' --data '{"expectedVersion":2}'
curl -i "http://127.0.0.1:3012/api/articles/$ARTICLE_ID"
curl -i -X POST "http://127.0.0.1:3012/api/articles/$ARTICLE_ID/archive" \
  -H 'Content-Type: application/json' --data '{"expectedVersion":3}'
curl -i -X PATCH "http://127.0.0.1:3012/api/articles/$ARTICLE_ID" \
  -H 'Content-Type: application/json' --data '{"title":"不能再改","expectedVersion":4}'
```

依序應得到：404、200、200（version 2）、409 VERSION_CONFLICT、200（version 3）、200、200（version 4）、409 INVALID_STATE。這些 HTTP 結果與第 11 章一致。

獨立檔案匯出仍可練習：

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3012/api/articles/export -o /tmp/chapter-12-articles.ndjson
```

檔案內容由 generate-export 產生，不包含剛才寫入 PostgreSQL 的文章。一般停止使用：

```bash
docker compose stop api postgres test-db
```

開發資料保留在本章 postgres_data volume。不要把 `down -v` 當作一般收工步驟。

## 12.13 常見問題、練習與驗收

| 現象 | 原因與修正方向 |
|------|----------------|
| 拆三個檔案後，Service 還是需要 res | HTTP 責任尚未移走；改成回傳 Article，再由 Controller 呈現 |
| Service 自己 new PrismaClient | 依賴仍藏在內部；由組裝入口傳入 Repository |
| 為每個請求建立一份 pool | 共享資源生命週期放錯位置；每個應用建立並在 shutdown 關閉 |
| Promise 錯誤沒有進集中出口 | 檢查 handler／tracked 是否回傳 Promise |
| 單元測試全過，資料庫卻覆蓋新版本 | 替身不能證明 SQL；檢查 UPDATE 條件與 affected count |
| callback 拋錯，資料卻保留修改 | 可能用了外層 db；所有交易內操作須使用同一個 tx |
| 管理分頁筆數不足或 total 錯誤 | 應在 Repository 先篩選再分頁，而不是 Service 事後過濾 |
| 12 章查不到 11 章建立的文章 | 本章有獨立 Compose 專案與資料 volume |

### 練習一：用測試觀察分層價值

只在第 12 章副本中，暫時移除 Service 的 archived 判斷，執行 article-service.test.js，確認封存後修改／發佈案例失敗，再還原。過程不需要啟動資料庫。

驗收：指出失敗的是哪條業務規則，而不只說「測試變紅」。

### 練習二：增加只修改 content 的案例

在 Service 測試呼叫 change，僅提供 content 與 expectedVersion。驗證 title 保留、content 更新、version 增加 1；再補 HTTP 案例確認相同結果。

驗收：說明為什麼 PATCH 缺少 title 代表保留原值，而不是清空 title；也說明 Zod 為什麼仍拒絕 title: null。

### 練習三：親手破壞 Repository 的保證

暫時從 updateMany 的 where 移除 status，再跑 database.test.js，觀察「同時檢查 version 與 status」案例失敗。還原後，再觀察交易 callback 拋錯案例如何確認資料回滾。

驗收：能解釋 Service 替身測試與真實 Repository 測試抓到的錯誤為何不同。只修改本章程式，不修改舊章節或 migration。

### 練習四：在紙上設計第二個入口

假設日後要做「排程封存文章」，畫出「排程輸入驗證 → Service → Repository」文字流程。指出它不需要 Controller 的哪些行為，以及它如何處理 VERSION_CONFLICT。先不新增背景排程或新的授權規則。

### 本章完成檢查

- [ ] 能說明同一請求經過的驗證、Controller、Service 與 Repository。
- [ ] Service 不匯入 Express、Zod、Prisma 或 HttpError。
- [ ] 能用普通物件替換 Repository，獨立測試成功與拒絕情境。
- [ ] 知道 interface 不會在執行期自動建立物件或保證交易。
- [ ] 條件 UPDATE、交易回滾與公開／管理列表範圍通過真實資料庫測試。
- [ ] 能指出 database 的建立與關閉責任，沒有每個請求建立 pool。
- [ ] 原 HTTP 契約、完整 check 與手動呼叫流程皆通過。

下一章：[Express 專題驗收與 NestJS 遷移基準](13-express-capstone-and-migration-baseline.md)，整理完整驗收、測試資料隔離與可重用契約，再帶著實際依賴問題進入 NestJS。

---

[上一章：PostgreSQL、Prisma 與 migration](11-postgres-prisma-and-migrations.md) · [下一章：Express 專題驗收](13-express-capstone-and-migration-baseline.md) · [返回課程總覽](README.md) · [本章範例](examples/12/README.md)
