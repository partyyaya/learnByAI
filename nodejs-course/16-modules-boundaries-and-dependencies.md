# 16 — 功能模組、依賴邊界與文章功能遷移

第 15 章把 Repository 與 Service 的建立規則交給 Nest 容器。現在新增一個 Controller，只要注入 ARTICLE_SERVICE 就能使用文章規則。但當健康檢查、文章、使用者與其他功能放進同一份 providers 清單時，另一個問題出現了：**誰可以依賴誰？哪些實作應該留在功能內部？**

本章先用可失敗的模組測試理解可見性，再完成文章端點的 Nest 遷移。業務規則、資料表與 HTTP 契約沿用第 13–15 章；主要改變是依賴的組織方式，以及 HTTP handler 的註冊位置。

完整可執行快照在 [examples/16](examples/16/README.md)，原有契約記錄在 [BASELINE.md](examples/16/BASELINE.md)。先讀過 [15 — Provider 與 scope](15-providers-di-tokens-and-scopes.md)，並能執行前章的 Docker check。

## 1. 本章要完成什麼？

完成後，你應該能：

- 分清 TypeScript 的 import／export 與 Nest 的 imports／exports。
- 說明 Provider 的擁有模組、可見範圍，以及重複註冊的結果。
- 以明確設定物件組裝動態模組，避免功能程式到處讀環境變數。
- 判斷模組、Provider 與檔案三種循環依賴，優先調整責任方向。
- 讓文章查詢、建立、修改、發佈、封存、preview、匯出與健康檢查都進入 Nest Controller。
- 保留 32 項 HTTP 基準，並以新的 Nest fixture 驗證非法 UTF-8、慢速 body、下載中斷與關閉競態。

本章仍固定使用示範作者 u_demo。沒有新增登入、權限、留言或永久 DELETE；認證會在第 18 章加入。標題中的「CRUD 遷移」指現有文章操作整體搬遷，刪除語意仍是既有封存。

## 2. 第一個問題：有這個 Provider，為什麼還不能注入？

先看一個縮小的例子：

```ts
@Module({
  providers: [{ provide: ARTICLE_SERVICE, useValue: service }],
})
class ArticleCoreModule {}

@Module({
  imports: [ArticleCoreModule],
  controllers: [ArticlesController],
})
class ArticlesModule {}
```

ArticlesController 需要 ARTICLE_SERVICE。ArticleCoreModule 雖然建立了它，但沒有公開給其他模組。結果不是「讀不到文章」，而是應用建立時就無法解析依賴。

加入公開契約：

```ts
@Module({
  providers: [{ provide: ARTICLE_SERVICE, useValue: service }],
  exports: [ARTICLE_SERVICE],
})
class ArticleCoreModule {}
```

這裡的 exports 表示「匯入我的模組，可以注入這個 token」。它不會額外建立一個 Service。Nest 預設把 Provider 封裝在所屬模組內，匯出的 Provider 才形成模組對外的介面。[官方模組說明](https://docs.nestjs.com/modules)

### 兩種 import 的責任

| 寫法 | 解決的問題 |
|------|------------|
| `import { ARTICLE_SERVICE } from './tokens.js'` | 讓這份 TypeScript 檔案能使用同一個 token 值 |
| `imports: [ArticleCoreModule]` | 把另一個模組匯出的 Provider 納入目前模組的依賴解析範圍 |
| `providers: [articleServiceProvider]` | 由目前模組擁有這份建立規則與實例 |
| `exports: [ARTICLE_SERVICE]` | 允許匯入目前模組的消費者注入此 token |
| `controllers: [ArticlesController]` | 讓 Nest 掃描並註冊這個 Controller 的 HTTP handler |

只寫第一行 import 不會建立 Provider。把 class 匯出成 TypeScript export，也不等於 Nest 的 exports。

### 父模組不會把所有 Provider 自動送進子模組

假設根模組同時寫了 `providers: [articleServiceProvider]` 與 `imports: [ArticlesModule]`，ArticlesModule 仍不能因此注入根模組的 Service。依賴可見性依模組的 imports／exports 決定，不是把父模組想成所有子模組的變數作用域。

本章的 [modules.test.ts](examples/16/test/modules.test.ts) 直接測兩種失敗：未 exports，以及 Provider 只放在父模組。測試要在 compile 時拒絕，而不是等第一個請求才失敗。

## 3. 先畫本章的依賴方向

以下箭頭代表「匯入並使用對方公開的 Provider」：

```text
AppModule
  ├─ ArticlesModule：公開／管理 Controller、寫入 body middleware
  │    ├─ ArticleCoreModule：Service、Repository factory
  │    │    └─ DatabaseModule：async DATABASE、readiness
  │    └─ RuntimeModule：HTTP 設定、工作追蹤協調器
  └─ HealthModule：live、ready Controller
       ├─ 同一份 DatabaseModule 註冊結果
       └─ 同一份 RuntimeModule 註冊結果
```

各模組的公開面：

| 模組 | 擁有的責任 | exports |
|------|------------|---------|
| DatabaseModule | 等待資料庫連線、建立 readiness 函式 | DATABASE、CHECK_READY |
| ArticleCoreModule | Prisma Repository 與純業務 Service 的組裝 | ARTICLE_SERVICE |
| RuntimeModule | 每個應用的 HTTP 設定與關閉協調器 | HTTP_OPTIONS、REQUEST_LIFECYCLE |
| ArticlesModule | 文章 HTTP 操作與 body 讀取規則 | 無 |
| HealthModule | 存活與就緒回應 | 無 |
| AppModule | 把兩個 HTTP 功能組合起來 | 無 |

ArticleCoreModule 是文章功能內部的組裝模組；ArticlesModule 是它的 HTTP 入口。這樣 HTTP 測試可以匯入公開 ARTICLE_SERVICE 的替身模組，而正式應用會使用同一個 ArticleCoreModule 實作。它們仍在同一個程序與同一份快照中。

沒有建立「所有東西都放進去」的 SharedModule，也沒有使用 @Global() 讓缺少的 imports 自動消失。依賴一多，能從模組宣告看出來源，比少寫一行更有幫助。

模組封裝是 DI 組織規則，不是安全沙箱。TypeScript 檔案仍可能直接 import 不該使用的程式；程式審查與後續 lint 邊界仍有價值。

## 4. 把 Provider 放回它的擁有者

### 4.1 DatabaseModule：只公開可供使用的能力

第 15 章的連線 factory 沒有改成每個 Controller 自行 connect。現在由 [database.module.ts](examples/16/src/database.module.ts) 集中擁有：

```text
DATABASE_INPUT：application 接手的 client
  → DATABASE async factory：await client.$connect()
      → 給 Repository 使用
      → CHECK_READY factory：回傳查詢 Article 表的函式
```

DATABASE_INPUT 留在模組內部。匯出的是連線初始化完成後的 DATABASE，以及供健康檢查使用的 CHECK_READY。

初始化順序仍由 inject 關係決定。使用 async factory 不表示資料表已經存在，所以 main.ts 在 listen 前仍查詢 Article 表，讓缺少 migration 的程序拒絕監聽。

### 4.2 ArticleCoreModule：公開 Service，保留 Repository

完整宣告很短：

```ts
@Module({
  providers: [articleRepositoryProvider, articleServiceProvider],
  exports: [ARTICLE_SERVICE],
})
export class ArticleCoreModule {
  static register(databaseModule: DynamicModule): DynamicModule {
    return { module: ArticleCoreModule, imports: [databaseModule] };
  }
}
```

Repository factory 注入 DATABASE；Service factory 注入 ARTICLE_REPOSITORY。這兩個 factory 都由本模組擁有，外面的 Controller 只依賴 ARTICLE_SERVICE。

因此，想從 ArticlesModule 直接注入 ARTICLE_REPOSITORY，會在建立時失敗。這個失敗是我們要的邊界：Controller 不應繞過 Service 直接修改資料庫。

Service 與 Repository 的介面、實作、交易及 schema 沿用前章。換框架不需要把純業務函式全部改成帶裝飾器的 class。

### 4.3 AppModule：負責組合，不負責查詢

application.ts 只建立一次動態資料庫模組描述，再傳給需要的地方：

```ts
const databaseModule = DatabaseModule.register(database);

const dependencies = {
  articles: ArticleCoreModule.register(databaseModule),
  readiness: databaseModule,
};
```

server.ts 建立 HTTP Server 與 shutdown 協調器後，建立 RuntimeModule，再交給 AppModule.register。根模組匯入 ArticlesModule 與 HealthModule，不再用 `nest.get(ARTICLE_SERVICE)` 把依賴取出來交給舊 Express Controller。

這裡把動態模組描述明確向下傳，是為了讓每個測試應用可以有自己的資料庫 schema、設定與生命週期，不靠程序全域變數。

## 5. singleton 不表示「到處註冊都只有一份」

以下兩種結構不同：

```text
A imports Core
B imports 同一份 Core
  → A、B 使用 Core 匯出的同一個 Provider

A providers: [serviceProvider]
B providers: [serviceProvider]
  → A、B 各擁有一份 Provider 註冊
```

第二種即使 scope 是 DEFAULT，也可能建立兩份 Service、兩個快取或兩個連線池。遇到「為什麼狀態不同步」時，除了查看 scope，也要查看是否把同一個 Provider 重複放進多個模組。

本章測試使用 factory 呼叫次數與物件身分比較，而不是只看兩個物件的內容相同。共享匯入案例應建立一次；重複 providers 案例應建立兩次。

動態模組的註冊方法是一般函式。不要假設在不同地方重新呼叫 register，框架一定會把結果合併。本章需要共享時，就傳遞同一個已建立的 DynamicModule 物件，並以固定 Nest 版本實測。

### 重新匯出與直接匯入

如果 FacadeModule 匯入 CoreModule，但沒有重新匯出，另一個只匯入 FacadeModule 的模組不會因此取得 Core 的公開 Provider。

```ts
@Module({
  imports: [CoreModule],
  exports: [CoreModule],
})
class FacadeModule {}
```

只有確實要提供統一入口時才建立這種 facade。若沒有額外責任，消費者直接匯入 CoreModule 更容易閱讀。modules.test.ts 同時驗證「只有 imports 會失敗」與「重新匯出後可注入」。

## 6. 設定如何進入模組？

HTTP 限制不應由不同 Controller 各自讀 `process.env`。本章使用 [runtime.module.ts](examples/16/src/runtime.module.ts) 的明確物件：

```ts
export interface HttpOptions {
  readonly maxBodyBytes: number;
  readonly bodyTimeoutMs: number;
  readonly exportFile: string;
  readonly onExportFinished?: (result: ExportResult) => void;
}
```

resolveHttpOptions 做三件事：補上預設值、檢查正整數限制與非空路徑、複製並 freeze 設定。預設仍是 16 KiB 與 2000 ms。

```text
main 解析 PORT／HOST／停止期限／DATABASE_URL
  → application 接手 database
  → server 驗證 HTTP options
  → RuntimeModule 以 useValue 公開 HTTP_OPTIONS
  → ArticlesModule 與 Controller 注入需要的設定
```

readonly 是 TypeScript 約束；Object.freeze 提供這份扁平物件的執行期保護。若以後加入巢狀物件，淺層 freeze 不會自動凍結所有內層資料。設定中的 callback 仍是函式參照。

DATABASE_URL 只用於建立 client，不放進 HTTP_OPTIONS，也不透過 API 回傳。測試直接傳 bodyTimeoutMs: 100，不必修改整個程序的環境變數。

register 是我們選的名稱，不是特殊關鍵字。它回傳包含 module、imports、providers、exports 的 DynamicModule，讓呼叫端提供組態；靜態 @Module 宣告與動態內容共同構成模組。[官方動態模組說明](https://docs.nestjs.com/fundamentals/dynamic-modules)

這一章沒有新增 @nestjs/config。等設定來源與管理需求變多時可以引入，但套件不能代替「先驗證、明確提供、限制可見範圍」的設計。

## 7. 完成文章 HTTP 遷移

### 7.1 移除過渡期的 Express 業務 handler

第 14–15 章使用 Express Router 驗證後，以 `next('router')` 讓公開單篇查詢交給 Nest。第 16 章移除這條交接線與舊 createArticleController。

現在由 [articles.controller.ts](examples/16/src/articles.controller.ts) 註冊：

| Controller | 路徑／操作 |
|------------|-----------|
| ArticlesController | 公開列表、單篇、建立、PATCH、publish、archive、preview、export |
| ManagedArticlesController | `/api/me/articles` 列表與單篇 |
| HealthController | `/health/live`、`/health/ready` |

Express 仍是 Nest 的 HTTP adapter；request context、JSON parser 與串流也仍使用平台能力。這裡的「遷移完成」表示應用端點都由 Nest Controller 註冊，不表示移除 Express 套件。

### 7.2 從 Controller 回傳資料

建立草稿的核心流程：

```text
POST /api/articles
  → 限制並解析 JSON body
  → draftSchema 驗證並修剪輸入
  → lifecycle.track 登記 Service 工作
  → Service.create
  → 設定 Location
  → present 明列公開欄位與 ISO 日期
  → Nest 回傳 201 JSON
```

Controller 使用 `@Res({ passthrough: true })` 設定 Location，並回傳普通資料物件，讓 Nest 完成 JSON 回應。[官方 Controller 回應說明](https://docs.nestjs.com/controllers)

Nest 的 POST 預設成功碼是 201；preview、publish、archive 的既有成功碼則是 200，所以這三個方法明列 `@HttpCode(200)`。這些差異都由原契約測試約束，不能只看成功 body 相同。

管理查詢傳 publicOnly: false，公開查詢傳 true；真正的可見性與固定作者規則仍由 Service 處理。Controller 不會自行拼 Prisma 條件。

### 7.3 暫時保留驗證策略，下一章再引入 Pipe

parseInput 使用原有 Zod schema，回傳標準化結果，失敗仍產生同樣的 field／code／message。Controller 把這個回傳值傳給 Service，不直接使用未驗證的 req.body。

這一章不再把驗證結果存在 res.locals；res.locals 留給 request ID 與追蹤資訊。17 章會把參數解析放進 Pipe，繼續維持目前的輸入與錯誤契約。

JSON parser 屬於更前面的傳輸層。NestFactory 關閉預設 bodyParser，由 ArticlesModule.configure 針對既有寫入路徑與方法掛上原 jsonBody。它仍負責：

- application/json 與 UTF-8、拒絕壓縮。
- 原始 bytes 的 16 KiB 限制。
- 非法 UTF-8 與 strict JSON 的錯誤分類。
- body 讀取期限與相關 listener／timer 清理。

欄位長度驗證不能代替 byte 上限；Pipe 也不能讓一個永遠傳不完的 body 自動結束。

## 8. 最容易在遷移時改變的四個細節

### 8.1 固定路徑與 405 的優先順序

export、preview 要先於 `:id` 註冊，而且固定路徑自己的 `@All()` 也要排在 `:id` 前面。否則 GET preview 可能被當成查詢 ID 為 preview 的文章。

每個已知路徑都保留不支援方法時的 405 與 Allow。例如：

```text
GET /api/articles/preview
  → 405，Allow: POST

DELETE /api/articles/a_1
  → 405，Allow: GET, HEAD, PATCH
```

Nest middleware 的 `:id` 比對也會碰到保留名稱。因此 PATCH preview／export 必須略過 body parser，讓固定路徑的 405 生效；不能因為呼叫端沒有 Content-Type 就先變成 415。

同樣地，原本不接受的詳細路徑尾斜線應走 404，不應先等待 body。這些案例另外放在 nest-query.test.ts。

### 8.2 集合根路徑的尾斜線

原 Express Router 同時接受 `/api/articles` 與 `/api/articles/`，詳細路徑多一個尾斜線則回 404。Nest 的路徑正規化不能直接靠 `@Get('/')` 表達這個差異。

server.ts 只將集合根路徑的尾斜線別名正規化，保留 query；其他路徑仍使用 case sensitive／strict routing。這個相容處理是由 B12 明確要求，不是把所有路徑都改成寬鬆比對。

### 8.3 框架可能先包裝 parser 的錯誤

實作時，原有測試抓到 malformed JSON 與非法 URL 從 400 變成 500。原因是固定 Nest 11.2.8 的外部錯誤入口會先把 SyntaxError／URIError 包成 BadRequestException；原錯誤的 type 與類別已經不在 Filter 看見的外層。

本章的 [contract-express.adapter.ts](examples/16/src/contract-express.adapter.ts) 在 adapter.setErrorHandler 邊界先執行 normalizeError，再交給 Nest 的錯誤流程：

```text
body-parser entity.parse.failed
  → HttpError(400, INVALID_JSON)
  → Nest Filter
  → 原有 error envelope

Express 路徑解碼 URIError
  → HttpError(400, INVALID_URL)
  → Nest Filter
  → 原有 error envelope
```

這是針對本課契約與固定 adapter 的相容處理，仍需在升級 Nest 或更換 adapter 時重跑測試。未知錯誤維持 500，不把任意 error.status 或內部 message 原樣送給客戶端。

### 8.4 串流不能回傳第二份 JSON

export 方法使用一般 `@Res()`，由 streamExport 完整擁有回應；不能再 return 一個普通物件讓 Nest 追加 JSON。

```text
GET export → 驗證沒有 query → 開檔 → pipeline → 結束／中斷 → 關檔
HEAD export → 開檔 → 讀 metadata → 不讀整份檔案 → 關檔
```

streamExport 整段工作也登記進 lifecycle.track。下載中斷後仍要等 finally 關閉檔案。onExportFinished 提供 bytesRead、fileClosed 與 outcome，讓測試不只看客戶端是否斷線。

匯出的仍是獨立 NDJSON 教學檔，不是 PostgreSQL 備份，也不會因新增文章而自動更新。

## 9. 循環依賴先分清是哪一種

| 類型 | 例子 | 先檢查什麼 |
|------|------|------------|
| 檔案載入循環 | a.ts import b.ts，b.ts 又經 index.ts import a.ts | token、型別是否混在會載入模組的 barrel 中 |
| Module 循環 | ArticlesModule imports NoticesModule，反向也 imports | 是否把跨功能流程塞進其中一個功能 |
| Provider 循環 | ArticlesService 注入 NoticesService，反向也注入 | 兩者是否各自承擔太多責任 |

例如設計成「文章服務發通知；通知服務又呼叫文章服務取得資訊」，兩邊容易互相依賴。先問：通知是否只需要一份文章摘要？整個流程是否可以由第三個協調者安排？

```text
原本：ArticleWriter ↔ NoticeBuilder

調整：PublishingWorkflow
        → ArticleWriter
        → NoticeBuilder

ArticleWriter 回傳必要結果
  → Workflow 把結果傳給 NoticeBuilder
  → 兩個葉模組不互相匯入
```

modules.test.ts 的最後一個案例是一個獨立流程實驗：先呼叫寫入替身，再把回傳 ID 交給通知替身，驗證順序與輸入。它沒有在文章 API 新增通知，也沒有宣稱這兩步具備交易原子性；真實外部通知的可靠交付留到後續 Outbox 章。

Nest 提供 forwardRef 延後解析循環參照，也能用 ModuleRef 延後取得依賴。但延後解析不會自動修正責任重疊；建構順序也不能作為業務保證。檔案 barrel 的載入循環更需要獨立檢查。[官方循環依賴說明](https://docs.nestjs.com/fundamentals/circular-dependency)

本章模組沒有循環，不需要 forwardRef。token 獨立放在 tokens.ts，模組與 Provider 直接 import 明確檔案。

## 10. 資源生命週期仍由原協調器負責

拆成模組不會讓資料庫的關閉責任消失。application 接手傳入的 database：建立失敗就 disconnect；正常關閉則依序等待。

```text
SIGTERM／SIGINT
  → HTTP Server 停止接受新連線
  → 等待已接受的 HTTP 請求結束
  → 持續等待登記中的工作
  → nest.close()
  → 其他共用資源清理
  → database.$disconnect()
```

為什麼要先等 HTTP，再檢查工作？請求可能已接受，但 body 還沒收完。停止開始時工作集合是空的，後來 Controller 才登記寫入；即使用戶端此時離線，也不能提早關閉資料庫。

controller.test.ts 直接用完整 Nest server 重現：先送半份 JSON、開始 shutdown、補完 body、等 Service 進入、讓客戶端離線；直到釋放 Service 的 Promise，資源清理才可以發生。

原 shutdown.ts 與其回歸測試維持不變，整體停止期限仍涵蓋 HTTP、工作與資源。Nest 只 init，不另外 listen，也不啟用第二組 shutdown hooks。

## 11. 用 Docker 執行

所有指令在本章目錄執行：

```bash
cd nodejs-course/examples/16
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose up -d api
```

API 使用主機 **3016**，開發 PostgreSQL 使用 **15416**。測試資料庫不公開主機端口；Compose 專案、node_modules 與開發資料 volume 都與前章分開。

固定版本沿用第 15 章，沒有新增套件：Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Nest common／core／platform-express／testing 11.2.8。Express 5.3.0、Zod 4.6.7、Prisma 7.10.1 與其他版本見範例 README；不執行安裝 latest。

check 會 generate、型別檢查、跑 Jest、build，再執行程序與兩個框架實驗。test:runtime 依賴前面的編譯結果，不能與會清除 `.test-dist` 的 npm test 並行執行。

### 讀取與錯誤

```bash
curl -i http://127.0.0.1:3016/health/ready
curl -i http://127.0.0.1:3016/api/articles/a_1
curl -I http://127.0.0.1:3016/api/articles/a_1
curl -i http://127.0.0.1:3016/api/articles/a_draft
curl -i http://127.0.0.1:3016/api/me/articles/a_draft
curl -i -X DELETE http://127.0.0.1:3016/api/articles/a_1
```

乾淨 seed 的預期依序是 200、200、HEAD 200、404、200、405。seed 不覆寫既有文章，若你已改過資料，應依目前狀態判讀。

### 建立、發佈與封存

```bash
curl -i -X POST http://127.0.0.1:3016/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"模組邊界","content":"由 Nest Controller 建立"}'
```

記下回傳的 id 與 Location，用實際 id 替換以下 ID_FROM_RESPONSE：

```bash
curl -i -X PATCH http://127.0.0.1:3016/api/articles/ID_FROM_RESPONSE \
  -H 'Content-Type: application/json' \
  --data '{"content":"修改後內容","expectedVersion":1}'

curl -i -X POST http://127.0.0.1:3016/api/articles/ID_FROM_RESPONSE/publish \
  -H 'Content-Type: application/json' --data '{"expectedVersion":2}'

curl -i -X POST http://127.0.0.1:3016/api/articles/ID_FROM_RESPONSE/archive \
  -H 'Content-Type: application/json' --data '{"expectedVersion":3}'
```

成功後版本依序為 2、3、4。重送舊版本得到 409 VERSION_CONFLICT；封存後公開查詢為 404，管理查詢仍可讀。沒有永久 DELETE。

### 匯出與停止

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3016/api/articles/export -o /tmp/chapter-16-articles.ndjson
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

stop 保留開發 volume。不要用 down -v 當一般停止方式。

## 12. 驗證分成哪些層？

| 證據 | 主要驗證 |
|------|----------|
| modules.test.ts | exports 缺漏、父子模組可見性、re-export、共享與重複 Provider、正式 Repository 邊界、設定與無循環流程 |
| providers／scopes 測試 | async 初始化、替換、清理、不同 scope 與多應用隔離 |
| migration-baseline.test.ts | 逐位元保留的兩份 HTTP 契約，共 32 項 |
| database 測試 | 真實 PostgreSQL 約束、版本條件、不同 pool 併發、回滾與持久化 |
| nest-query／controller 測試 | Nest handler 證據、回應碼、方法優先序、輸入與關閉競態 |
| http.test.ts | 第 10 章 26 項案例，改接完整 Nest＋隔離 PostgreSQL fixture |
| export.test.ts | 第 10 章 5 項串流案例，改接同一正式 Nest 組裝方式 |
| test:runtime | 真實程序入口、初始化失敗拒絕監聽、信號與停止期限 |

HTTP 與 export 傳輸案例保留原斷言，改的是非同步建立、資料庫 fixture 與 lifecycle 清理。下載測試建立 64 MiB 稀疏檔案，收到第一段後中斷，驗證 bytesRead 小於整份檔案且 fileClosed 為 true。

每套資料庫測試使用 TEST_DATABASE_URL，僅接受 course_test，建立隨機 test_* schema，最後只刪自己的 schema。不能把開發 public 當成測試可重置的資料。

原有錯誤 middleware 實驗仍是小型 Express 測試，用來保留平台層教學；它不能代替本章的 Nest 端點與傳輸驗收。測試通過也不代表已窮盡所有可能的 HTTP bytes 或完成效能壓測。

## 13. 練習與驗收

### 練習一：讓可見性錯誤真的發生

在自己的副本移除 ArticleCoreModule 的 exports，執行 `npm test -- --testPathPatterns=modules.test.js`。讀錯誤訊息中的 token 與消費端模組，再恢復 exports。

驗收：能說明「Provider 已建立」為什麼不等於「任意模組都能注入」。不能以到處重複 providers 或加 @Global() 當成答案。

### 練習二：比較共享與重複註冊

先讓兩個消費端 imports 同一個 Core，再改成各自 providers 註冊同一個 factory。加入建立次數與身分斷言。

驗收：共享時一次，重複註冊時兩次；能連回第 15 章 DEFAULT 的範圍概念。

### 練習三：提供每個應用自己的設定

建立兩個 Nest server，一個 maxBodyBytes: 128，另一個維持預設。送出合法但超過 128 bytes 的 preview JSON，並在 finally 關閉兩者。

驗收：前者 413、後者 200；不透過修改 process.env 或共用可變物件切換設定。

### 練習四：從雙向依賴抽出流程

仿照 modules.test.ts 的最後一例，把兩個互相需要的測試服務改成「協調者 → 兩個葉模組」。把所需資料透過方法參數傳遞。

驗收：沒有 forwardRef，葉模組沒有互相 imports，仍能驗證順序與參數。說明這個調整為何不自動提供跨資源交易。

### 練習五：閱讀傳輸失敗的證據

執行以下測試，找到非法 bytes、body 不 end、下載中斷及晚登記工作各自的 assertion：

```bash
docker compose run --rm tools npm test -- --testPathPatterns='(http|export|controller).test.js'
```

驗收：能指出真正測到 Nest 組裝的地方；能說明一般 Supertest JSON 成功案例為何不足以取代這些測試。

### 本章完成檢查

- [ ] 能畫出模組依賴方向與各模組 exports。
- [ ] Controller 不能直接注入內部 Repository，健康模組不依賴文章 Controller。
- [ ] 所有既有文章端點已經由 Nest 註冊，原 32 項契約保持不變。
- [ ] 正常 JSON、非法 UTF-8、慢速 body、下載中斷都已測試。
- [ ] HTTP 斷線後仍等待登記工作，再關閉共用資源。
- [ ] 已執行完整 check、migration、seed 與 API 操作。
- [ ] 能說明為何這個模組設計不需要循環依賴。

下一章：[17 — DTO、Pipe、轉型與執行期驗證](17-dto-pipes-and-runtime-validation.md)：把目前 Controller 的驗證呼叫整理成 DTO／Pipe，釐清轉型、白名單、optional、nullable 與 PATCH 語意。

---

[上一章：Provider、DI token 與 scope](15-providers-di-tokens-and-scopes.md) · [返回課程總覽](README.md) · [本章範例](examples/16/README.md) · [本章契約](examples/16/BASELINE.md)
