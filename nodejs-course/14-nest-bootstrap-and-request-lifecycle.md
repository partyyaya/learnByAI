# 14 — Nest 啟動、裝飾器與請求生命週期

> 第 13 章留下了可重用的 HTTP 契約。現在先搬一條查詢路由，觀察 Nest 如何找到 Controller、呼叫方法並送出回應，再確認原有使用者操作仍然成立。

## 14.1 本章目標與前置知識

完成本章後，你應能：

- 分清 Node HTTP Server、Express、Nest 與 HTTP adapter 的責任。
- 說明 `NestFactory.create()`、`app.init()` 與監聽端口的差別。
- 用 `@Module()`、`@Controller()`、`@Get()` 宣告一條可執行路由。
- 解釋裝飾器、metadata 與 TypeScript 型別的差別。
- 追蹤成功、輸入失敗、Guard 拒絕與業務拋錯時的執行順序。
- 在獨立 Docker 環境跑完 HTTP 基準、真實資料庫與程序關閉測試。

先完成 [12 章分層](12-service-repository-and-manual-di.md) 與 [13 章遷移基準](13-express-capstone-and-migration-baseline.md)。若還不熟悉裝飾器，可先閱讀 [TypeScript 課程](../typescript/README.md) 的相關章節。

完整範例：[examples/14](examples/14/README.md)。本章從 examples/13 複製成獨立快照，不會從上一章的 src 匯入程式，也不共用其資料庫 volume。

### 這次實際搬了什麼？

| 範圍 | 第 14 章實作 |
|------|---------------|
| `GET /api/articles/:id` 與對應 HEAD | Nest Controller；回傳公開文章或原有錯誤 |
| 公開列表、管理列表／單篇、建立、PATCH、publish、archive | 保留 Express 路由與手動組裝 |
| health、preview、獨立 NDJSON 匯出 | 保留 Express 實作 |
| 未知路由 | Nest 的最後路由處理，再由相容 Filter 轉成原錯誤格式 |
| Service、Repository、Prisma schema／migration | 保留第 13 章內容 |
| 認證、Provider token、完整模組拆分 | 尚未新增；分別留在 18、15、16 章 |

這是**逐條遷移中的應用**。32 項 HTTP 基準通過，代表這個組合符合目前基準，不能宣稱整個 API 都已搬到 Nest。Nest 官方所稱的 hybrid application 另有微服務語境，本章只是 Express 路由與 Nest Controller 暫時共存。

## 14.2 固定版本，先確認能一起工作

本章沿用 Node **24.22.1**、npm **11.19.1**、TypeScript **5.9.3**、Jest **30.2.0**、Express **5.3.0**、Zod **4.6.7**、Supertest **7.3.1**、Prisma CLI／Client／adapter-pg **7.10.1**、pg **8.23.1** 與 PostgreSQL **17**。

新增套件：

| 套件 | 固定版本 | 用途 |
|------|----------|------|
| `@nestjs/common` | 11.2.8 | 裝飾器、框架介面與例外型別 |
| `@nestjs/core` | 11.2.8 | 建立應用、掃描 Module 與註冊請求流程 |
| `@nestjs/platform-express` | 11.2.8 | 將 Nest 路由與回應接到 Express |
| `reflect-metadata` | 0.2.2 | 供裝飾器與框架讀寫執行期 metadata |
| `rxjs` | 7.8.2 | Nest 所需相依；生命週期實驗用來觀察 Interceptor |

Nest 11 支援 Node 20 以上。本課繼續使用既有 CommonJS 輸出與 Jest 30，不需要全域安裝 Nest CLI，也不以 `nest new` 覆蓋已驗證的專案。[Nest 11 起步文件](https://docs.nestjs.com/v11/first-steps)

套件版本不能只看 Node engines。本章確認 CommonJS 建置、Jest 載入、Express 路由與 Prisma 測試能一起執行，才固定版本。Nest 12 的 ESM 載入方式不直接符合本課目前的 Jest 組裝，因此這裡選用 11.2.8。

`package.json` 另外明列範圍限定的覆寫：

```json
"overrides": {
  "@nestjs/platform-express": {
    "express": "$express",
    "multer": "2.5.0"
  }
}
```

`$express` 表示跟隨本專案直接依賴的 **5.3.0**，不是 latest；Multer 固定 **2.5.0**，避開 adapter 原先傳遞依賴的已知問題。本章沒有檔案上傳端點，也沒有對外提供 multipart 功能。覆寫、完整 lockfile 與實際測試一起保存；日後更新 Nest 時要重新檢查，不應把覆寫當成永久不需維護的設定。

讀者直接跑 `npm ci`。不要另外執行沒有版本的 `npm install @nestjs/core`，也不要用 `npm audit fix --force` 連帶改變已固定的 Jest 等依賴。

## 14.3 Nest 放在請求的哪一層？

先用目前實作畫出責任：

```text
用戶端 HTTP 請求
  → Node HTTP Server：連線、header／request 時限、停止接收
  → Express app：request ID、舊路由、parser、原有驗證
  → Express adapter 註冊的 Nest 路由
  → Nest Controller：取得已驗證輸入、呼叫既有 Service
  → Service → Repository → PostgreSQL
  → Controller 回傳物件
  → Nest 經 adapter 送出 JSON
```

Nest 沒有取代 Node 的事件迴圈，也沒有讓同步 CPU 工作自動變成非阻塞。Adapter 則負責把框架的 HTTP 操作接到平台。這一章選 Express adapter，讓第 08–13 章的底層平台保持一致。[Nest HTTP adapter 說明](https://docs.nestjs.com/faq/http-adapter)

本章仍使用 `Response`、`res.locals` 與 Express middleware，因此並非平台無關。未來選修 Fastify 時，需要重新處理這些平台接點與契約測試。

## 14.4 從手動路由走到 Controller

第 13 章的單篇查詢在 Router 裡直接掛 handler：

```ts
router.route('/:id').get(
  validate(idSchema, 'params'),
  step('handler:detail'),
  tracked(controller.detail(true)),
);
```

第 14 章把「由哪個方法處理 GET」交給 Nest。以下節錄 [article-query.module.ts](examples/14/src/article-query.module.ts)，外層函式已傳入 `articles` 與 `lifecycle`：

```ts
@Controller('api/articles')
class ArticleQueryController {
  @Get(':id')
  async detail(@Res({ passthrough: true }) res: Response) {
    res.locals.steps.push('nest:controller');
    const { id } = res.locals.params as ArticleParams;
    return lifecycle.track((async () => {
      const article = await articles.detail(id, true);
      res.locals.steps.push('nest:return');
      return { data: present(article) };
    })());
  }
}

@Module({ controllers: [ArticleQueryController] })
class AppModule {}
```

逐步閱讀：

1. `@Controller('api/articles')` 宣告 Controller 的路徑前綴。
2. `@Get(':id')` 宣告方法與相對路徑，組合後是 `/api/articles/:id`。
3. Module 的 `controllers` 告訴 Nest 要建立及掃描哪個 Controller。只宣告 class、不列入 Module，不會自動出現路由。
4. `detail(id, true)` 沿用公開可見範圍：草稿、封存與不存在文章都回 404。
5. `present()` 明列公開欄位、把日期轉成 ISO 字串；沒有直接展開整筆 Prisma 物件。
6. 方法回傳 `{ data: ... }`；成功的 GET 由 Nest 經 adapter 回 200 JSON。

`@Res({ passthrough: true })` 是遷移橋接：我們需要讀取既有驗證放入的 `res.locals`，但仍讓 Nest 傳送方法回傳值。若改成普通 `@Res()`，就進入自行處理回應的模式；不能只 `return` 物件卻期待框架照常送出。這個 Controller 沒有再呼叫 `res.json()`，因此只有一個回應出口。

### 依賴目前從哪裡來？

`createArticleQueryModule(articles, lifecycle)` 在每次組裝時建立上述類別。方法透過 JavaScript closure 讀取這次傳入的依賴，仍是第 12 章的手動組裝：

```text
database
  → createPrismaArticleRepository(database)
  → createArticleService(repository)
  → createArticleQueryModule(articles, lifecycle)
```

沒有全域變數，也沒有把 Service 存成 static 欄位。測試會同時建立兩個應用，驗證各自使用自己的依賴。

這個 factory 是本章過渡設計，方便先集中理解 Controller 與啟動。第 15 章再把依賴寫成 Provider／DI token，第 16 章整理功能模組；現在不必猜測 interface 如何被框架自動注入。

## 14.5 裝飾器與 metadata：宣告不等於驗證

裝飾器會在類別定義被載入時執行。Nest 的路由裝飾器把資訊記錄起來，框架初始化時才依這些資訊註冊 handler。不是每個請求都重新執行 `@Controller()`。

```text
載入編譯後的模組，建立 class
  → 執行裝飾器，留下路徑、方法等 metadata
  → Nest 掃描 Module 與 Controller
  → 註冊 HTTP handler
  → 請求到達時呼叫對應方法
```

本章的 `tsconfig.json` 增加：

```json
{
  "experimentalDecorators": true,
  "emitDecoratorMetadata": true
}
```

第一個選項啟用這套 TypeScript 裝飾器語意；第二個讓編譯器額外輸出設計型別 metadata。執行入口在載入裝飾器類別前先 `import 'reflect-metadata'`。它們與 Nest 自己寫入的「路徑 metadata」是相關但不同的資訊。[TypeScript：emitDecoratorMetadata](https://www.typescriptlang.org/tsconfig/emitDecoratorMetadata.html)

這裡使用 experimentalDecorators 的傳統裝飾器模式，包含 Nest 的參數裝飾器；不能直接換成 TypeScript 5 的標準裝飾器模式，再期待 emitDecoratorMetadata 與參數裝飾器照常工作。升級編譯設定時，要連同框架與測試一起驗證。[TypeScript 5 裝飾器差異](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#differences-with-experimental-legacy-decorators)

例如實驗中的 `value: number` 會留下 `[Number]` 的參數設計資訊，但 HTTP 路徑原始值仍是字串。`"bad"` 不會因為型別註記自動成為合法數字，interface 也不會變成可執行的輸入 schema。

可以在建置後查看輸出：

```bash
docker compose run --rm tools node -e 'console.log(require("node:fs").readFileSync("dist/lifecycle-lab.js", "utf8"))'
```

找出 `__decorate`、`__metadata`、`design:paramtypes`。不需要背誦編譯器產物；重點是分辨「編譯期檢查」「留下執行期資訊」「真的驗證及轉型輸入」三件事。`nest-lifecycle.test.ts` 會確認 metadata 存在，也確認非法數字仍被 Pipe 拒絕。

## 14.6 Bootstrap：建立、初始化與監聽

Bootstrap 是把設定、資源與框架接好，最後開始服務的程序。一般全新 Nest 應用可以寫成：

```ts
// 概念示意：AppModule 必須是已宣告的根模組。
const app = await NestFactory.create(AppModule);
await app.listen(3000, '127.0.0.1');
```

`create()` 建立框架與模組依賴；`init()` 完成路由等初始化；`listen()` 會先確保初始化完成，再讓框架管理的 HTTP Server 開始監聽。建立成功不等於端口已開放。

### 本章為何使用 app.init()？

第 13 章已經有自行建立的 Node HTTP Server，包含 URL 前置檢查、header 大小、請求時限與有界關閉。本章保留它，將**同一個 Express app** 傳給 adapter：

```ts
// 節錄 server.ts；前面已建立 app、server、lifecycle 及舊路由。
nest = await NestFactory.create(
  createArticleQueryModule(options.articles, lifecycle),
  new ExpressAdapter(app),
  { bodyParser: false, logger: false, abortOnError: false },
);
nest.useGlobalFilters(new ContractExceptionFilter(options.onError));
await nest.init();
```

完成後，`main.ts` 才對既有 `server` 呼叫 `listen()`。Nest 官方也提供「Express instance＋app.init()＋外部 HTTP Server」的組裝方式；外部 Server 的關閉責任由建立者管理。[Nest 多 Server 組裝](https://docs.nestjs.com/v11/faq/multiple-servers)

三個設定都有具體理由：

| 設定 | 本章用途 |
|------|----------|
| `bodyParser: false` | 寫入端點仍由原 parser 處理，保留 16 KiB、strict JSON、UTF-8 與逾時規則 |
| `logger: false` | 使用本課既有 REQUEST_TRACE／HTTP_ERROR，讓實驗輸出容易對照 |
| `abortOnError: false` | 建立失敗時交由外層捕捉並清理資料庫，避免框架直接中止程序 |

本章沒有呼叫 `nest.listen()`；不要再開第二個監聽端口。`nest.getHttpServer()` 是 Nest adapter 自己建立的 Server，並非本章帶有 URL 前置檢查與協調器的外部 Server，因此文章契約測試使用組裝函式回傳的 `server`。獨立生命週期實驗則完全由 Nest 管理 Server，可使用 `app.getHttpServer()`。

由於框架建立與初始化需要等待，`createArticleServer()`、`createArticleApplication()` 現在都是非同步函式。呼叫處要加 `await`；測試型別使用 `Awaited<ReturnType<typeof createArticleApplication>>` 取得真正的 Server 型別。

## 14.7 先後順序決定請求由誰處理

在同一個 Express app 上，先註冊的 middleware／路由先有機會處理。若舊的 GET handler 仍然送出 JSON，新 Controller 就算存在，也不會被請求走到。

本章把舊單篇 GET 改成：

```ts
router.route('/:id')
  .get(
    validate(idSchema, 'params'),
    step('handoff:nest'),
    (_req, _res, next) => next('router'),
  )
  .patch(/* 原本的更新 handler */)
  .all(methodNotAllowed('GET, HEAD, PATCH'));
```

上面 PATCH 以註解省略，完整可執行內容見 [server.ts](examples/14/src/server.ts)。`next('router')` 離開這個已掛載的 Router，讓請求繼續前往 Nest 註冊的路由。普通 `next()` 會繼續同一條 route 的後續 handler，落到 `.all()` 變成 405；`next('route')` 則只跳過當前 route，並非離開整個 Router。

固定路徑 `/export`、`/preview` 仍先註冊，避免被 `:id` 吃掉。POST、PATCH 等也保留原方法與 Allow 規則。Express 的大小寫與 strict routing 設定繼續套用，詳細路徑多一個尾斜線仍回 404。

`req.params` 在離開 Router 後可能由下一層重設，因此保留「驗證輸出放在 `res.locals.params`」的做法。ID 是不透明字串，沒有因為搬到 Nest 就改成只接受 UUID。

整體註冊順序是：

```text
requestContext → draining 檢查
  → 舊 Express 路由（單篇 GET／HEAD 交出控制權）
  → 舊 Express errorHandler
  → Nest Controller 路由
  → Nest 未知路由與錯誤處理
```

原本無條件回 404 的 Express middleware 已移除，否則 Nest 永遠接不到請求。不是把 Nest 路由寫在任何位置都會生效。

## 14.8 錯誤由哪個出口回去？

框架的預設錯誤格式不等於第 13 章的 API 契約。本章加入很小的 [ContractExceptionFilter](examples/14/src/contract-exception.filter.ts)，把 Nest 的錯誤接回既有 `errorHandler()`，而不改 Service 去依賴 Nest。[Nest 例外處理](https://docs.nestjs.com/exception-filters)

```text
舊 Express parser／validate 拒絕
  → 原 errorHandler → 原 HTTP envelope

Nest Controller 呼叫 Service，Service 拋出 ArticleError
  → Nest Filter → 原 normalizeError／errorHandler → 原 HTTP envelope

沒有路由匹配
  → Nest NotFoundException
  → Filter 轉成 HttpError(404, NOT_FOUND)
  → 原 HTTP envelope
```

Filter 的 `@Catch()` 表示可接收各種例外；`host.switchToHttp()` 取得這次 HTTP 的 request／response。詳細作用範圍留到第 19 章。本章只做保持契約所需的橋接：

- `ArticleError('NOT_FOUND')` 仍回 404，業務衝突仍回 409。
- 未知錯誤仍回 `500 INTERNAL_ERROR`，不回傳 SQL、連線資訊或堆疊。
- 回應保留 `error.code／message／details` 與 `requestId`。
- 不把任意物件的 `status` 當成可公開的 HTTP 狀態。
- 已送 header、已結束或用戶端離線的情況仍沿用原錯誤出口處理。

Filter 不是每次成功回應後必跑的一站。只有交給它處理的例外才會進來；成功查詢的 trace 沒有 `nest:filter`。

## 14.9 用一個獨立實驗看完整生命週期

文章查詢目前只需要 Controller 與相容 Filter，尚未新增 Guard、Pipe 或 Interceptor。為了先認識它們的位置，[lifecycle-lab.ts](examples/14/src/lifecycle-lab.ts) 提供獨立 `/lab/:value` 實驗，**沒有掛進文章 API**。

成功路徑可先理解成：

```text
Middleware
  → Guard
  → Interceptor 的前半段
  → Pipe
  → Controller（需要時再呼叫 Service）
  → Interceptor 的回程
  → HTTP 回應完成
```

這是本實驗單一作用範圍的順序；多層 global／controller／route 與多參數 Pipe 不宜只由這張簡圖推論。官方文件列出完整順序與例外分支。[Nest 請求生命週期](https://docs.nestjs.com/faq/request-lifecycle)

| 元件 | 先掌握的問題 | 本實驗行為 |
|------|--------------|------------|
| Middleware | 進入路由前做什麼？ | 記錄開始與 response finish |
| Guard | 是否允許繼續？ | 依實驗參數回 true／false，並非登入授權實作 |
| Interceptor | 如何包住後續處理？ | 記錄進入、成功回程或錯誤 |
| Pipe | 外部輸入是否合格？ | 檢查非負安全整數字串，再轉成 number |
| Controller | 這條 HTTP 路由要做什麼？ | 回傳數字與其型別；13 用來觸發錯誤 |
| Filter | 例外最後如何回 HTTP？ | 回實驗專用錯誤，不改文章契約 |

Interceptor 中的 `next.handle()` 代表後續 Nest 處理，並不是 Express 的 `next()`。本實驗只用 RxJS `tap` 觀察成功與錯誤，沒有改結果、吞錯或重試；完整 RxJS 與攔截器使用留到第 19 章。

執行方式（先完成下節的安裝與建置）：

```bash
docker compose run --rm tools npm run lab:nest
```

這個指令為每個情境建立自己的 app，監聽臨時端口、送一個真實 HTTP 請求，做斷言後關閉。依序看到：

```text
200: middleware → guard → interceptor:before → pipe → controller → interceptor:after → response:finish
400: middleware → guard → interceptor:before → pipe → interceptor:error → filter → response:finish
403: middleware → guard → filter → response:finish
500: middleware → guard → interceptor:before → pipe → controller → interceptor:error → filter → response:finish
```

觀察兩個重點：Guard 拒絕時，後面的 Interceptor、Pipe、Controller 都未執行；Pipe 或 Controller 拋錯時，已進入的 Interceptor 可觀察錯誤，再交給 Filter。本實驗中的錯誤沒有被攔截器恢復成成功值。

實驗用 `events` 只服務「一個 app、一個請求」的情境，不是多請求日誌設計。文章 API 繼續把 trace 放在各請求自己的 `res.locals`，不會把不同請求混成同一串。

## 14.10 用 Docker 完整執行

從倉庫根目錄開始：

```bash
cd nodejs-course/examples/14
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose up api
```

`check` 依序執行 Prisma generate、型別檢查、Jest、應用建置、程序信號驗證與四條生命週期實驗。`db:seed` 使用建置後程式，因此先完成 check 或 build。

| 用途 | 位址／隔離 |
|------|------------|
| API | `http://127.0.0.1:3014` |
| 開發 PostgreSQL | 主機 `127.0.0.1:15414`；容器內 `postgres:5432/course` |
| 測試 PostgreSQL | `test-db:5432/course_test`，沒有公開主機端口 |
| Compose 專案 | `nodejs-course-14`，使用本章自己的 volume |

測試只接受 `TEST_DATABASE_URL` 且資料庫名稱必須是 `course_test`。每套測試建立隨機 schema、套用 migration，最後只移除自己建立的 schema。開發 seed 只補缺少的資料，不覆寫讀者的修改。

### 呼叫搬到 Nest 的查詢

另一個終端機執行：

```bash
curl -i http://127.0.0.1:3014/api/articles/a_1
curl -I http://127.0.0.1:3014/api/articles/a_1
curl -i http://127.0.0.1:3014/api/articles/a_draft
curl -i http://127.0.0.1:3014/api/me/articles/a_draft
curl -i -X DELETE http://127.0.0.1:3014/api/articles/a_1
```

在乾淨 seed 狀態下，依序是 200、無 body 的 HEAD 200、公開草稿 404、管理草稿 200、405 且 Allow 為 `GET, HEAD, PATCH`。HEAD 由 Express GET 路由行為承接到同一 Nest handler；它不會傳 body，但目前仍會執行查詢。

若以前已修改 seed 文章，請依現有狀態判讀，不要刪除 volume 來強行配合範例。自動測試有自己的乾淨 schema。

查看 API 的 REQUEST_TRACE。公開已發佈文章應包含：

```text
request → accept → router:articles → validate:params → handoff:nest
  → nest:controller → nest:return → response:finish
```

公開草稿則在 `nest:controller` 後出現 `nest:filter → error:NOT_FOUND`。管理查詢仍是 Express，不會有 `nest:controller`。這比「回 200，所以應該搬成功」提供更直接的證據。

### 沿用寫入與狀態流程

```bash
curl -i http://127.0.0.1:3014/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"開始使用 Nest","content":"查詢先搬，業務規則保留。"}'
```

建立回 201，抄下回應的 ID，將下列 `ARTICLE_ID` 換成該值：

```bash
curl -i http://127.0.0.1:3014/api/articles/ARTICLE_ID
curl -i http://127.0.0.1:3014/api/me/articles/ARTICLE_ID
curl -i -X PATCH http://127.0.0.1:3014/api/articles/ARTICLE_ID \
  -H 'Content-Type: application/json' \
  --data '{"title":"修訂後標題","expectedVersion":1}'
curl -i http://127.0.0.1:3014/api/articles/ARTICLE_ID/publish \
  -H 'Content-Type: application/json' --data '{"expectedVersion":2}'
curl -i http://127.0.0.1:3014/api/articles/ARTICLE_ID
curl -i http://127.0.0.1:3014/api/articles/ARTICLE_ID/archive \
  -H 'Content-Type: application/json' --data '{"expectedVersion":3}'
curl -i http://127.0.0.1:3014/api/articles/ARTICLE_ID
```

公開查詢從草稿 404，經發佈後 200，再到封存後 404。PATCH 與狀態操作仍走 Express，但讀取結果已經由 Nest 處理；Service／Repository 仍共同保護版本、狀態與交易。

匯出仍是獨立 NDJSON 教學檔，不是 PostgreSQL 匯出或備份：

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3014/api/articles/export -o /tmp/chapter-14-articles.ndjson
```

## 14.11 關閉時先等誰？

本章沒有同時啟用 `enableShutdownHooks()`，因為 `main.ts` 已由既有信號 handler 統一啟動有界關閉：

```text
SIGINT／SIGTERM
  → 標記 draining，停止接收
  → 等實際 HTTP Server 關閉
  → 持續等登記中的非同步工作
  → 關閉 Nest application context
  → 關閉其他共用資源與 Prisma client
  → 正常結束；若整體期限到，強制斷線並非零結束
```

`nest.close()` 不會代替我們關閉自行建立的外部 Server，也不會自動知道任意背景 Promise。查詢仍透過 `lifecycle.track()` 登記，所以用戶端離線後，尚未完成的 Service 工作仍會被等待。這項測試現在實際經過 Nest 查詢路由。

保留第 07–13 章的修正：先等 HTTP，再持續檢查 tasks。已接受的慢 body 可能在 shutdown 開始後才完成並登記工作，不能只等停止當下的快照。背景工作也必須在所屬 handler／已追蹤工作完成前登記，不能期待協調器預知未追蹤 timer。

初始化失敗時，server 組裝會關閉已建立的 Nest context；application 組裝會釋放 database。若監聽失敗，main 也會走清理流程。這是將 bootstrap 改成非同步時必須一起處理的責任。

正常收工：

```bash
docker compose stop api postgres test-db
```

開發資料保留在 volume。`down -v` 會刪除資料，不作一般停止指令。

## 14.12 測試證明了什麼？

| 檔案／指令 | 證據 |
|-------------|------|
| `test/api-contract.ts` | 與第 10–13 章逐位元相同，3 項核心操作 |
| `test/migration-contract.ts` | 與第 13 章逐位元相同，B01–B15 展開為 29 項 |
| `test/migration-baseline.test.ts` | 改為等待本章非同步組裝，仍執行以上 32 項 HTTP 基準 |
| `test/nest-query.test.ts` | 7 項：GET／HEAD 的 Nest trace、編碼錯誤、Filter、平台分界與多實例隔離 |
| `test/nest-lifecycle.test.ts` | 5 項：四條生命週期與 metadata／執行期驗證 |
| 原資料庫、Service、Controller、shutdown 等測試 | 真實併發與回滾、錯誤契約、離線等待、共用資源清理 |
| `npm run test:runtime` | 真實入口、缺設定／migration、信號、進行中請求與停止期限 |
| `npm run lab:nest` | 建置後另以真實 HTTP 執行四條生命週期，完成即關閉 |

完整 Jest 共 **104 項**：第 13 章的 92 項加本章 12 項。數量包含跨組裝重跑的既有契約，並不等於 104 個不同功能。

單獨排查：

```bash
docker compose run --rm tools npm run test:baseline
docker compose run --rm tools npm test -- --testPathPatterns=nest-query.test.js
docker compose run --rm tools npm test -- --testPathPatterns=nest-lifecycle.test.js
```

先執行 generate；基準測試還需要 test-db。`test:runtime` 需要 `.test-dist` 與 `dist`，一般直接執行完整 check。Jest 所需 `--experimental-vm-modules` 已寫在 scripts，一般 API 啟動不需要這個旗標。

**尚未完成的驗收範圍**：第 10 章的非法 UTF-8 bytes、慢速 body 逾時與下載中斷後關檔等底層傳輸案例，仍須在第 16 章接到完整 Nest fixture 重新執行。本章的部分遷移、一般 JSON 基準與獨立生命週期實驗，都不能代替那項工作。

## 14.13 新增與調整的檔案

| 檔案 | 責任 |
|------|------|
| `src/article-query.module.ts` | 暫時用 factory 接住手動依賴，宣告查詢 Controller 與根 Module |
| `src/contract-exception.filter.ts` | Nest 錯誤接回既有 envelope |
| `src/server.ts` | 路由交接、Nest create／init、關閉 Nest context |
| `src/application.ts`、`src/main.ts` | 非同步組裝、初始化／監聽失敗清理 |
| `src/article-controller.ts` | 匯出原有 present，讓兩種 Controller 共用公開序列化 |
| `src/lifecycle-lab.ts`、`scripts/check-nest-lifecycle.cjs` | 獨立生命週期實驗 |
| `test/nest-query.test.ts`、`test/nest-lifecycle.test.ts` | 新增框架行為證據 |
| `package.json`、lockfile、`tsconfig.json` | 固定 Nest 相依、明列覆寫、啟用裝飾器與 metadata |

Service、Repository、schema、migration 與 `shutdown.ts` 保持第 13 章內容。完整契約及過渡範圍另見 [本章 BASELINE](examples/14/BASELINE.md)。

## 14.14 常見錯誤

| 現象 | 優先檢查 |
|------|----------|
| Nest Controller 寫好了卻從未執行 | 是否列入 Module？舊 handler 或 404 是否先結束回應？ |
| GET 變成 405 | 交接是否用了普通 next()，落入舊 route 的 `.all()`？ |
| Controller 回傳物件卻一直等待 | 是否用了普通 `@Res()`，卻沒有自行送出回應？ |
| `number` 參數仍收到字串 | 型別／metadata 不等於轉型；檢查 Pipe 是否真的執行 |
| 驗證後 Controller 拿不到 params | 離開 Router 後仍讀 req.params，或沒有使用既有 res.locals 輸出？ |
| 啟動可用、測試卻報 ESM 載入錯誤 | 是否自行改了 Nest major 或模組設定，沒有沿用 lockfile？ |
| 未知路由回 Nest 預設 JSON | 是否註冊相容 Filter？不要修改舊測試去接受新的 envelope |
| shutdown 太早斷開 Prisma | 是否漏登記 Nest 非同步工作，或讓多套信號 handler 各自關閉資源？ |

## 14.15 練習與驗收

### 練習一：證明實際執行的是哪一個 Controller

分別呼叫公開單篇、公開列表、管理單篇，列出各自 REQUEST_TRACE。指出哪一條經 Nest、哪幾條仍由 Express 處理。

驗收：公開單篇有 `handoff:nest → nest:controller`；另外兩條沒有。不能只以回應狀態判斷框架。

### 練習二：觀察路由交接錯誤

只修改 examples/14，暫時把 `next('router')` 改成 `next()`，重跑 nest-query 測試，再復原。

驗收：說明為什麼原本成功的查詢變成 405，以及 `.all()` 在哪個階段執行。復原後測試必須通過；不要修改基準的預期值。

### 練習三：型別註記與 Pipe

在獨立 lab 將 `Pipe.transform()` 的 Number 轉型暫時移除，再觀察成功回應的 type。即使 Controller 仍宣告 `value: number`，執行期輸入也不會自動改變。完成後復原。

驗收：能指出哪段程式真的做轉型，並確認非法輸入不進 Controller。若編譯器因 Pipe 的回傳型別阻擋修改，先把實驗的 Pipe／參數型別改成 string，再比較輸出；不要用 any 繞過檢查。

### 練習四：寫下例外分支

分別畫出：Guard 拒絕、Pipe 拒絕、Controller 拋錯的文字流程，執行 `lab:nest` 對照。解釋為什麼 403 沒有 `interceptor:error`，而另外兩種錯誤有。

驗收：能指出 Guard 拒絕發生於進入 Interceptor 之前；Filter 不屬於成功必經路徑。

### 練習五：新增成功查詢的輸出保護

在 nest-query 測試的 Service 替身回傳物件中加入一個模擬內部欄位，檢查 HTTP JSON 沒有該欄位。保留實際 model 型別，可先建立含額外欄位的變數再傳給替身，觀察明列欄位的 present 如何保護回應。

驗收：即使資料來源增加內部欄位，公開回應仍只有既有欄位，不依賴 Prisma 剛好沒有敏感資料。

### 本章完成檢查

- [ ] 已從 Docker 跑完 npm ci、完整 check、migration、seed 與查詢。
- [ ] 能說明 create／init／listen，以及本章實際監聽的 Server 是誰。
- [ ] 能從 trace 證明公開單篇經過 Nest Controller。
- [ ] 原有 32 項 HTTP 基準不改 assertion 仍通過。
- [ ] 理解裝飾器 metadata 不等於輸入驗證或自動注入 interface。
- [ ] 已執行四條生命週期實驗，能解釋被跳過的階段。
- [ ] 知道本章只搬一條查詢，仍無認證、完整 DI 與完整功能模組。
- [ ] 能說明離線請求的資料工作為何仍需登記與等待。

下一章為 [15 — Provider、DI token、非同步初始化與 scope](15-providers-di-tokens-and-scopes.md)：從目前的手動依賴開始，改用 Provider 與明確的 DI token，並觀察依賴替換、初始化與 scope。

---

[上一章：Express 遷移基準](13-express-capstone-and-migration-baseline.md) · [返回課程總覽](README.md) · [本章範例](examples/14/README.md) · [本章契約](examples/14/BASELINE.md)
