# 15 — Provider、DI token、非同步初始化與 scope

> 第 14 章已讓 Nest 呼叫查詢 Controller，但它的 Service 仍藏在外層 factory 的 closure 裡。這一章把依賴關係明確交給容器，同時問清楚：誰建立物件、誰等待初始化、誰共用實例，以及誰負責關閉資源？

## 15.1 本章目標與前置知識

完成本章後，你應能：

- 區分業務 Service、Provider 定義、注入 token 與實際物件。
- 用 `useValue`、`useFactory`、`useClass`、`useExisting` 表達不同建立方式。
- 解釋為什麼 TypeScript interface 不能直接當成執行期 DI token。
- 讓非同步 Provider 完成後，才建立依賴它的物件與開始監聽。
- 用 TestingModule 替換 Repository，保留真正的 Service 規則。
- 以 HTTP 實驗區分 DEFAULT、REQUEST、TRANSIENT，並說明實例數量增加的來源。
- 保留既有 HTTP、交易與有界關閉契約。

先完成 [12 章手動 DI](12-service-repository-and-manual-di.md)、[13 章遷移基準](13-express-capstone-and-migration-baseline.md) 與 [14 章 Nest 入口](14-nest-bootstrap-and-request-lifecycle.md)。完整獨立快照在 [examples/15](examples/15/README.md)，契約在 [BASELINE.md](examples/15/BASELINE.md)。

本章**沒有再搬其他路由**：公開單篇 GET／HEAD 仍是 Nest，其餘文章端點、health、preview、匯出仍由 Express 處理。改變的是依賴組裝；Nest Controller 與舊 Express handler 會共用容器建立的同一個 Service。完整文章路由與功能模組在第 16 章完成，認證仍留到第 18 章。

版本沿用第 14 章：Node **24.22.1**、npm **11.19.1**、TypeScript **5.9.3**、Jest **30.2.0**、Express **5.3.0**、Zod **4.6.7**、Supertest **7.3.1**、Nest common／core／platform-express **11.2.8**、reflect-metadata **0.2.2**、RxJS **7.8.2**、Prisma CLI／Client／adapter-pg **7.10.1**、pg **8.23.1**、PostgreSQL **17**。只新增開發依賴 **`@nestjs/testing` 11.2.8**。

CommonJS／NodeNext、裝飾器設定、Docker digest 與 adapter 的 Express 5.3.0／Multer 2.5.0 覆寫全部沿用；沒有把現有套件升級 latest。

## 15.2 手動 DI 已經存在，容器接手什麼？

第 12 章已經做了依賴注入：

```ts
const repository = createPrismaArticleRepository(database);
const articles = createArticleService(repository);
```

Service 沒有自己建立資料庫，而是接受外面傳入的 Repository。這個設計讓測試可以使用替身，並不是到了 Nest 才有 DI。

第 14 章再把 `articles` 傳給外層函式，在裡面宣告 Controller。它可以運作，但從 Controller 的建構子看不出依賴；要替換資料存取時，仍要沿外層組裝一路找。

第 15 章改成：

```text
註冊「token 對應哪個值／建立規則」
  → Nest 解析依賴圖
  → 先取得下游依賴
  → 建立需要這些依賴的物件
  → 把依賴傳入 Controller 建構子
```

容器主要接手建立與連接物件。業務規則、交易正確性、資料庫資源所有權仍要由程式明確表達，不能因為用了框架就省略。

## 15.3 先分清四個名稱

| 名稱 | 本章例子 | 責任 |
|------|----------|------|
| 業務 Service | `createArticleService()` 的回傳物件 | 實作可見範圍、版本與狀態規則 |
| Token | `ARTICLE_SERVICE` | 在執行期識別要取得哪個依賴 |
| Provider 定義 | `{ provide, inject, useFactory }` | 告訴容器如何供應該 token 的值 |
| Provider 實例／值 | 容器執行 factory 後保存的 Service 物件 | 真正被 Controller 呼叫 |

Provider 不限定是名為 Service 的 class，也可以供應物件、函式或非同步建立的值。Nest 的一般 class Provider 常用 `@Injectable()` 宣告 metadata，再列入 Module 的 providers；裝飾器本身不會讓類別自動成為全應用可見的依賴。[Nest Providers](https://docs.nestjs.com/providers)

本章既有 Service 是普通函式建立的物件，沒有必要為了 DI 把所有函式改成 class。讓 factory Provider 呼叫它，就能繼續保留 Service 不依賴 Nest 的邊界。

## 15.4 TypeScript 型別不是執行期 token

目前的 Service 型別是：

```ts
export type ArticleService = ReturnType<typeof createArticleService>;
```

`ArticleRepository` 則是 interface。這些型別在 JavaScript 執行時不存在，Nest 無法拿它們當查找鍵。

本章在 [tokens.ts](examples/15/src/tokens.ts) 集中建立 Symbol：

```ts
export const ARTICLE_REPOSITORY = Symbol('ARTICLE_REPOSITORY');
export const ARTICLE_SERVICE = Symbol('ARTICLE_SERVICE');
```

型別回答「這個值應該有哪些方法」，token 回答「向容器索取哪個值」。兩者在建構子同時出現：

```ts
constructor(
  @Inject(ARTICLE_SERVICE) private readonly articles: ArticleService,
) {}
```

`@Inject()` 提供執行期識別；`ArticleService` 提供編譯期檢查。只寫型別，不會自動建立這份映射。

### Symbol 的說明文字不是身分

```ts
Symbol('ARTICLE_SERVICE') === Symbol('ARTICLE_SERVICE'); // false
```

所以註冊端與使用端都必須匯入同一個匯出的 token。不要在每個檔案各自宣告同名 Symbol。本章有一個負向測試，確認相同文字但不同 Symbol 會在 compile 時出現缺少依賴的錯誤。

Class 與字串也能作為 token。本課對 interface／函式物件使用集中匯出的 Symbol，對 scope 實驗中的 class 使用 class 本身；重點是註冊和注入採用同一個身分。[Nest 自訂 Provider](https://docs.nestjs.com/fundamentals/custom-providers)

## 15.5 把手動組裝改成依賴圖

[article.providers.ts](examples/15/src/article.providers.ts) 註冊以下關係。箭頭表示「左邊提供完成後，右邊才能使用它」：

```text
DATABASE_INPUT：已建立、由 application 接手關閉責任的 Prisma client
  → DATABASE：await client.$connect()
      → ARTICLE_REPOSITORY：createPrismaArticleRepository(database)
          → ARTICLE_SERVICE：createArticleService(repository)
              → ArticleQueryController
      → CHECK_READY：回傳會執行 Article count 的函式

REQUEST_LIFECYCLE：外部 HTTP Server 的關閉協調器
  → ArticleQueryController
```

`DATABASE_INPUT` 與 `DATABASE` 最後指向同一個 client，但前者是輸入物件，後者代表其 `$connect()` 已完成。Repository 依賴後者，避免在連線初始化完成前被建立。

Service Provider 的完整定義很短：

```ts
export const articleServiceProvider: FactoryProvider<ArticleService> = {
  provide: ARTICLE_SERVICE,
  inject: [ARTICLE_REPOSITORY],
  useFactory: (repository: ArticleRepository) => createArticleService(repository),
};
```

逐項閱讀：

1. `provide` 是容器對外辨識的 token。
2. `inject` 列出 factory 所需依賴，依陣列順序傳入參數。
3. `useFactory` 是建立方法，等依賴可用後由容器呼叫。
4. 回傳值就是 `ARTICLE_SERVICE` 對應的值。

不要把它寫成 `useFactory: createArticleService(repository)`；那是在註冊當下自行呼叫函式，而不是交給容器建立。

Provider 陣列的排列也不是可靠的初始化順序。必須以 `inject` 描述真正依賴，不能只把資料庫 Provider 放在前面，期待其他 factory 一定等它。

`FactoryProvider<ArticleService>` 與 `satisfies` 幫助檢查定義、回傳型別，但 Symbol 本身不會自動攜帶「對應值必定是 ArticleService」的完整型別關聯。錯誤 token、錯誤值形狀仍需要清楚的組裝與測試保護。

## 15.6 useValue：沿用已存在的值

兩個實際例子：

```ts
{ provide: DATABASE_INPUT, useValue: database }
{ provide: REQUEST_LIFECYCLE, useValue: lifecycle }
```

`useValue` 沒有複製物件，也不呼叫建構子；消費者取得的是同一個參考。測試替身也能透過相同方式注入：

```ts
{ provide: ARTICLE_REPOSITORY, useValue: repositoryDouble }
```

這不代表容器「自動知道該怎麼釋放這個值」。Nest 可以呼叫已實作的生命週期 hook，但不會看見一般物件就推測要呼叫 `$disconnect()`、`end()` 或 `close()`。

本章 Prisma client 的所有權明確留在 application 組裝層。它把 client 交給 Provider 使用，並在初始化失敗或有界關閉時釋放。一般呼叫端一旦交給 `createArticleApplication()`，就不再另外安排正常路徑的 disconnect。

## 15.7 非同步 Provider：先等待，再提供

DATABASE Provider：

```ts
{
  provide: DATABASE,
  inject: [DATABASE_INPUT],
  useFactory: async (input: Database): Promise<Database> => {
    await input.$connect();
    return input;
  },
}
```

Factory 回傳 Promise，Nest 會等待它完成，再建立依賴 `DATABASE` 的 Provider。Controller 不會收到一個需要自己 await 的「半完成 client」。[Nest 非同步 Provider](https://docs.nestjs.com/fundamentals/async-providers)

錯誤示意：

```ts
// 不要這樣做：回傳時尚未等待連線，rejection 也失去正常的啟動錯誤路徑。
useFactory: (input: Database) => {
  void input.$connect();
  return input;
}
```

這個 `void` 只是告訴型別檢查忽略 Promise，不會讓初始化自動完成，也不會自動處理 rejection。

### 完整的啟動順序

```text
main 驗證設定，建立 Prisma client
  → createArticleApplication 接手 client 的關閉責任
  → createArticleProviders 產生 Provider 定義
  → NestFactory.create 解析依賴圖
      → DATABASE_INPUT → await DATABASE
      → Repository → Service → Controller
  → 取出 Service，掛上暫留的 Express 路由
  → nest.init 註冊 Nest 路由與錯誤出口
  → main 執行 Article count，確認 migration 後的表格可用
  → 外部 server.listen
```

`$connect()` 完成不等於資料表已存在，所以 main 仍要在監聽前執行查詢。這也不代表此後資料庫永遠正常；執行中的 `/health/ready` 仍會透過 `CHECK_READY` Provider 檢查。

`createArticleApplication()` 可供測試獨立組裝，因此只等待連線初始化；正式入口 `main.ts` 再做啟動時的資料表查詢。既有「缺表時 live 200、ready 503」測試刻意直接使用組裝函式，模擬服務已存在但資料不可用的狀態。真正啟動程序遇到缺表，仍拒絕監聽。

### async Provider 與 onModuleInit 不同

Factory 解決的是「依賴值準備好，才能注入」。`onModuleInit()` 是模組依賴建立後、應用初始化時的 hook；不是讓其他建構子等待某個半成品物件的替代品。TestingModule 的 `compile()` 會解析 Provider，但不等於已完成 HTTP app 的 `init()` 或 `listen()`。[Nest 生命週期](https://docs.nestjs.com/fundamentals/lifecycle-events)

本章沒有增加自行重試或忽略初始化錯誤。失敗就沿外層清理路徑退出；有限重試與外部依賴失效策略在後續章節討論。

## 15.8 靜態 Controller 與暫留的 Express 路由

第 14 章在 factory 裡宣告 Controller。本章改為檔案層級的類別，建構子直接列出依賴：

```ts
@Controller('api/articles')
export class ArticleQueryController {
  constructor(
    @Inject(ARTICLE_SERVICE) private readonly articles: ArticleService,
    @Inject(REQUEST_LIFECYCLE)
    private readonly lifecycle: ReturnType<typeof createShutdown>,
  ) {}

  // detail 方法仍使用 this.articles 與 this.lifecycle，HTTP 行為不變。
}
```

完整方法在 [article-query.module.ts](examples/15/src/article-query.module.ts)。Service 不再來自外層 closure，Controller 也不自行 `new` Repository。

`ArticleQueryModule.register(providers, lifecycle)` 回傳一個帶有 Provider 清單的根模組設定，讓正式組裝與測試都可使用。這裡只使用最小的 DynamicModule 形式來接入值；功能模組的 imports／exports、循環依賴與擁有者邊界留到第 16 章。

### 舊 Express handler 如何拿到同一個 Service？

`server.ts` 在 Nest 建立完成後、掛路由時做一次：

```ts
const articles = nest.get<ArticleService>(ARTICLE_SERVICE);
const checkReady = nest.get<ReadinessCheck>(CHECK_READY);
const controller = createArticleController(articles);
```

這是組裝邊界的過渡橋接。不要在每個業務方法裡到處 `get()`，否則依賴又會藏進函式內。Nest Controller 用建構子注入，舊 Express Controller 暫時接受上面取出的同一物件。

本章的 HTTP 測試替換 Repository 後，分別呼叫公開單篇與管理單篇，確認 factory 只建立一次 Service，兩條路由仍分別傳入 public 與 author 可見範圍。

## 15.9 useClass 與 useExisting：新建還是別名？

獨立 scope 實驗中有：

```ts
@Injectable()
export class SingletonStamp {
  readonly id = randomUUID();
}

// providers 的節錄
SingletonStamp,
{ provide: STAMP_ALIAS, useExisting: SingletonStamp },
{ provide: SECOND_STAMP, useClass: SingletonStamp },
```

三種註冊的差異：

| 寫法 | 效果 |
|------|------|
| `SingletonStamp` | class Provider 的簡寫，以 class 當 token，建立並保存實例 |
| `useExisting: SingletonStamp` | 為已註冊的 Provider 加另一個 token，取得同一實例 |
| `useClass: SingletonStamp` | 在 SECOND_STAMP 這個 Provider 註冊下另建實例 |

因此本實驗中 `singleton === alias`，但 `singleton !== secondSingleton`。兩個註冊都用 DEFAULT，也不會因此合併成「這個 class 在全程序只有一份」。完整測試同時比對 JavaScript 物件參考與 HTTP 回傳的實例 ID。

若只是替既有 Provider 換一個查找名稱，用 useExisting；若要依設定選擇某個實作類別，可用 useClass。這裡不以字串名稱猜測應該共用哪一個實例。

## 15.10 用 TestingModule 替換資料存取

第 12 章的純 Service 單元測試仍然有價值，不必全部包進 Nest。當要驗證 token、factory、建構子注入與替換規則時，再使用 `@nestjs/testing`。

最小組裝可以是：

```ts
const context = await Test.createTestingModule({
  providers: [
    { provide: ARTICLE_REPOSITORY, useValue: repositoryDouble },
    articleServiceProvider,
  ],
}).compile();

try {
  const service = context.get<ArticleService>(ARTICLE_SERVICE);
  await service.detail('a_di', true);
} finally {
  await context.close();
}
```

這是 [providers.test.ts](examples/15/test/providers.test.ts) 的節錄。`repositoryDouble` 提供可見文章與可觀察的呼叫紀錄，真正的 Service 仍負責把 publicOnly 轉成 public／author 範圍，以及把空結果轉成 NOT_FOUND。

### 覆寫已註冊的 Provider

若使用正式的 Provider 清單，必須在 `compile()` 之前替換：

```ts
const context = await Test.createTestingModule({
  imports: [ArticleQueryModule.register(createArticleProviders(database), lifecycle)],
})
  .overrideProvider(DATABASE).useValue(database)
  .overrideProvider(ARTICLE_REPOSITORY).useValue(repositoryDouble)
  .compile();
```

這裡 `database` 是測試建立、未開連線的 client。測試將 `$connect` 設成「一旦執行就失敗」的 spy，再確認它沒有被呼叫；DATABASE token 的 factory 已被 useValue 取代。測試最後自行釋放它建立的 client 與協調器，不把這項責任藏在 TestingModule 裡。

為什麼連 DATABASE 也要替換？因為**替換 Repository 不會自動從 Module 移除其他 Provider**。Nest 仍會初始化已註冊的 DATABASE，CHECK_READY 也仍依賴它。本章另有負向測試，故意只替換 Repository，確認原連線 factory 仍執行並拒絕建立。[Nest TestingModule 與 overrideProvider](https://docs.nestjs.com/fundamentals/testing)

測試安排可分成三層：

| 測試方式 | 能回答什麼 | 不能代替什麼 |
|----------|------------|--------------|
| 純 Service＋Repository 替身 | 業務判斷與呼叫資料是否正確 | Nest token 是否接對、SQL 是否正確 |
| TestingModule＋Provider 替換 | 容器組裝、注入與替換是否成立 | 真實交易、連線池、回滾與併發 |
| 真實 PostgreSQL＋HTTP | 完整契約、資料約束與一致性 | 所有傳輸極端情況與未實作功能 |

本章 Repository 替身不假裝實作交易；若測試誤呼叫 `withTransaction()`，就直接失敗。第 11–14 章的真實資料庫測試繼續驗證條件 UPDATE、RepeatableRead 與回滾。

## 15.11 Scope 決定哪些消費者共用實例

| Scope | 基本行為 | 本章採用方式 |
|-------|----------|--------------|
| DEFAULT | 同一 Provider 註冊在同一應用容器中共用實例 | 文章 Service、Repository、database、協調器 |
| REQUEST | 同一請求 context 共用，另一請求建立另一份 | 只在獨立 scope lab 示範 |
| TRANSIENT | 不同注入消費者取得各自的實例 | 只在獨立 scope lab 示範 |

DEFAULT 常被稱為 singleton，但不是「某個 class 在整個作業系統只有一個物件」。另一個應用容器會有自己的實例；另一個獨立 Provider 註冊也可能建立另一份。前面 useClass／useExisting 的實驗正好能驗證這點。[Nest Injection scopes](https://docs.nestjs.com/fundamentals/injection-scopes)

### REQUEST 會沿依賴鏈影響消費者

獨立實驗的依賴圖：

```text
ScopeController
  → RequestConsumer
      → RequestStamp（REQUEST）
  → RequestStamp（同請求的同一實例）
  → SingletonStamp（仍共用）
```

RequestConsumer 雖然沒有宣告 REQUEST，因為它需要每請求不同的 RequestStamp，也必須隨請求建立。Controller 依賴這條鏈，因此也隨之建立。沒有依賴 RequestStamp 的 SingletonStamp 不會因此被改成 REQUEST。

這個方向很重要：scope 影響需要該依賴的上層消費者，不是把整個應用所有物件一律變成每請求建立。本課的資料庫與 Repository 不應為了取得使用者資訊就輕率地改成每請求建立連線池。

### TRANSIENT 不是每次呼叫方法都 new

實驗另外有兩個 DEFAULT 消費者：

```text
ConsumerA（DEFAULT） → TransientStamp A
ConsumerB（DEFAULT） → TransientStamp B
```

A 與 B 各有一份不同的 TransientStamp。但 A 與 B 自己是 singleton，跨請求仍是原消費者，因此各自持有的 TransientStamp 也保持原物件。單純呼叫 A 的方法，不會重新注入一次。

ScopeController 因 REQUEST 依賴而每請求建立，若它直接注入 TransientStamp，新的 Controller 消費者便取得自己的 transient 實例。這說明 scope 成本要連同消費者的生命週期一起看。

### 實例成本與狀態保存

若 N 個請求各自建立 RequestStamp、RequestConsumer 與 ScopeController，就會產生這些類別各 N 個實例；DEFAULT Provider 則不會因這 N 次請求而重建。本實驗觀察實例身分，沒有宣稱已量出固定的延遲百分比。

建構子、初始化邏輯與依賴鏈越重，每請求重新建立的成本越值得注意。也不要為省成本把請求特有資訊寫到 singleton 的 `currentUser`、`currentRequest` 等可變欄位；不同非同步請求可能交錯讀寫。文章 Service 目前不保存每請求狀態，作者仍固定 u_demo，沒有在本章引入登入。

REQUEST 物件不再被引用後可交給垃圾回收，這不等於外部資源會自動關閉。請求取消、串流與連線池的生命週期仍需明確處理。

request-scoped 類別不會收到一般應用生命週期的 onModuleInit／onModuleDestroy 等 hook。因此不能把每請求開啟的檔案或連線，寄望在 onModuleDestroy 自動釋放；應由持有資源的工作以 finally 明確關閉。共用 pool 則仍由應用層負責。[Nest 生命週期限制](https://docs.nestjs.com/fundamentals/lifecycle-events)

## 15.12 執行 scope 實驗

[scope-lab.ts](examples/15/src/scope-lab.ts) 提供獨立 `/scope` Controller；它不掛進文章 API，也不建立資料庫連線。每個物件以 UUID 標記身分，回應包括：

| 欄位 | 觀察對象 |
|------|----------|
| singleton／alias／secondSingleton | DEFAULT、useExisting 與另一個 useClass 註冊 |
| request／requestViaConsumer | 同請求從兩條依賴路徑取得的 RequestStamp |
| requestConsumer／controller | 被 REQUEST 依賴影響的消費者 |
| transientA／transientB | 兩個 DEFAULT 消費者各自持有的 transient |
| transientController | 每請求 Controller 持有的 transient |
| label | 該次 X-Lab-Label，用來觀察並行隔離，不代表使用者身分 |

安裝及建置後執行：

```bash
docker compose run --rm tools npm run lab:scopes
```

指令建立一個 Nest app、監聽臨時端口，並行送出兩個 HTTP 請求，做完比較便關閉。成功輸出：

```text
PASS：DEFAULT 跨請求共享；useExisting 是同一實例，另一個 useClass 註冊有自己的實例。
PASS：REQUEST 在同請求共享、不同請求隔離，依賴它的 Consumer／Controller 隨之重建。
PASS：TRANSIENT 依消費者分開；singleton 消費者保留原實例，request 消費者每請求取得自己的實例。
```

判讀關係而不是比對固定 UUID：

```text
同一請求：singleton = alias；singleton ≠ secondSingleton
同一請求：request = requestViaConsumer；transientA ≠ transientB
跨請求：singleton、secondSingleton、transientA、transientB 各自保持相同
跨請求：request、requestConsumer、controller、transientController 各自不同
```

Jest 另以四個並行請求與兩個應用容器驗證隔離。label 沒有放進全域變數或共用 singleton 欄位，不會把另一個請求的資料當成自己的。

## 15.13 get、resolve 與 context 的差別

`get()` 適合取得已建立的靜態 Provider；REQUEST／TRANSIENT 等有 scope 的 Provider 應使用 `resolve()`，必要時明確傳入 context。這裡是進階實驗入口，正常 HTTP Controller 仍以建構子注入為主。[Nest ModuleRef](https://docs.nestjs.com/fundamentals/module-ref)

本章測試節錄：

```ts
const contextId = ContextIdFactory.create();
app.registerRequestByContextId(
  { headers: { 'x-lab-label': 'first' } },
  contextId,
);

const first = await app.resolve(RequestStamp, contextId);
const again = await app.resolve(RequestStamp, contextId);
// first === again
```

人工建立 context 時，要補上 REQUEST token 所需的 request 物件；否則需要 request 資訊的 Provider 沒有來源。同一 context 內解析得到同一份 RequestStamp；換另一個 context 就取得另一份。

context 不是認證使用者 ID，也不是前端可任意指定的授權邊界。正常 HTTP 由 Nest 管理每次請求的 context；不要為了重用物件，把不同使用者的請求硬塞進同一個 context。

測試中也確認 `app.get(RequestStamp)` 會失敗。不要以 `as any` 繞過這個差異，它涉及實例生命週期，而不只是 TypeScript 寫法。

## 15.14 初始化與關閉：容器不取代資源所有權

本章保留外部 Node HTTP Server 與原有協調器。正常關閉順序仍是：

```text
SIGINT／SIGTERM → draining
  → 等 HTTP 關閉
  → 持續等登記中的非同步工作
  → nest.close()
  → application 的 closeResources
  → database.$disconnect()
```

公開 Nest 查詢透過注入的 REQUEST_LIFECYCLE 登記工作；舊 Express handler 也使用同一個協調器。因此用戶端離線，不會讓仍在執行的資料查詢失去追蹤。整體停止期限與第 07–14 章相同。

初始化失敗分成兩種：

| 時機 | 清理責任 |
|------|----------|
| DATABASE async Provider、路由組裝或 Nest init 失敗 | server 組裝關閉已取得的 Nest app；application 釋放已接手的 database |
| application 已建立，但 main 的資料表檢查／listen 失敗 | main 呼叫 server.lifecycle.shutdown，依正常資源順序清理 |

若 `NestFactory.create()` 尚未成功回傳，外層可能沒有 Nest app 可以 close。這也是為什麼已建立的 database 必須有框架之外的失敗清理路徑，不能把一切押在尚未完成建立的 Provider hook。

本章只有 DATABASE 這個持有 client 的非同步初始化來源，其他業務 factory 是同步組裝。未來如果加入彼此無依賴、同時建立外部資源的 async Provider，還要設計各自的失敗清理與取消，不能假設一個 rejection 會自動取消所有正在進行的初始化。

測試以可控制的 Promise 確認：DATABASE 未完成時 application 不交出 Server；初始化拒絕時會 disconnect；正常 shutdown 重複呼叫仍只清理一次。真實程序測試另外確認缺設定、資料庫不可達與缺 migration 都不會開始監聽。

沒有同時啟用第二套 shutdown signal hook，也沒有在 Repository／Service 再加自己的 disconnect。Provider 值可被多個地方使用，資源關閉仍應有清楚的負責者。

## 15.15 Docker 操作與 API 驗收

從倉庫根目錄：

```bash
cd nodejs-course/examples/15
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose up api
```

| 用途 | 位址／隔離 |
|------|------------|
| API | `http://127.0.0.1:3015` |
| 開發 PostgreSQL | 主機 `127.0.0.1:15415`；容器內 postgres:5432/course |
| 測試 PostgreSQL | test-db:5432/course_test，不公開主機端口 |
| Compose 專案 | nodejs-course-15，使用自己的資料與依賴 volume |

`check` 包含 Prisma generate、型別檢查、Jest、build、程序驗證、前章生命週期實驗與本章 scope 實驗。先 build 才能執行 db:seed；完整 check 已包含 build。

另一個終端機，在乾淨 seed 下：

```bash
curl -i http://127.0.0.1:3015/health/ready
curl -i http://127.0.0.1:3015/api/articles/a_1
curl -I http://127.0.0.1:3015/api/articles/a_1
curl -i http://127.0.0.1:3015/api/articles/a_draft
curl -i http://127.0.0.1:3015/api/me/articles/a_draft
curl -i -X DELETE http://127.0.0.1:3015/api/articles/a_1
```

依序為 200、200、HEAD 200、公開草稿 404、管理草稿 200、405／Allow: GET, HEAD, PATCH。公開單篇的 REQUEST_TRACE 仍包含 `handoff:nest → nest:controller`；管理查詢仍由 Express 處理。

開發 seed 不覆寫已有文章。若你已改過狀態，請按現有資料判讀，不要刪除 volume 來湊範例結果。自動測試使用自己的乾淨 schema。

### 確認寫入之後仍由 Nest 讀回

建立草稿：

```bash
curl -i http://127.0.0.1:3015/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"Provider 練習","content":"兩種入口使用同一組業務依賴。"}'
```

將回應的 ID 代入 `ARTICLE_ID`：

```bash
curl -i http://127.0.0.1:3015/api/articles/ARTICLE_ID
curl -i http://127.0.0.1:3015/api/articles/ARTICLE_ID/publish \
  -H 'Content-Type: application/json' --data '{"expectedVersion":1}'
curl -i http://127.0.0.1:3015/api/articles/ARTICLE_ID
curl -i http://127.0.0.1:3015/api/articles/ARTICLE_ID/archive \
  -H 'Content-Type: application/json' --data '{"expectedVersion":2}'
curl -i http://127.0.0.1:3015/api/articles/ARTICLE_ID
```

公開查詢仍是草稿 404 → 發佈後 200 → 封存後 404。這些狀態與版本限制沒有因為改用 Provider 而消失；實際 UPDATE 仍保留 id＋version＋status 條件與交易。

### 單獨排查與停止

```bash
docker compose run --rm tools npm test -- --testPathPatterns=providers.test.js
docker compose run --rm tools npm test -- --testPathPatterns=scopes.test.js
docker compose run --rm tools npm run test:baseline
docker compose run --rm tools npm run lab:scopes
```

上述測試先執行 generate；基準需要 test-db。`test:runtime` 依賴已編譯的 `.test-dist` 與 `dist`，不能與會刪除重建 `.test-dist` 的 npm test 同時執行。通常直接跑 check，讓步驟循序完成。

獨立 NDJSON 匯出操作仍相同，不是資料庫備份：

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3015/api/articles/export -o /tmp/chapter-15-articles.ndjson
docker compose stop api postgres test-db
```

停止保留開發資料，不以 `down -v` 作一般收工指令。

## 15.16 檔案與測試證據

| 檔案 | 本章責任 |
|------|----------|
| `src/tokens.ts` | 集中定義執行期 token |
| `src/article.providers.ts` | useValue、async DATABASE、Repository／Service factory 與 readiness |
| `src/article-query.module.ts` | 靜態 Controller、建構子 @Inject、根模組 Provider 註冊 |
| `src/application.ts` | 提供正式 Provider 清單與 database 所有權 |
| `src/server.ts` | 建立容器、取出舊路由需要的 singleton，再 init |
| `src/main.ts` | Provider 初始化後、listen 前檢查資料表；失敗走清理 |
| `src/scope-lab.ts`、`scripts/check-scopes.cjs` | useClass／useExisting、三種 scope 與真實 HTTP 比較 |
| `test/providers.test.ts` | 8 項 Provider 組裝、替換、初始化與資源清理 |
| `test/scopes.test.ts` | 5 項實例身分、並行隔離、context 與多應用驗證 |

完整 Jest 共 **117 項**，由前章 104 項加本章 13 項組成，包含重跑既有 HTTP 契約的案例。`test/api-contract.ts` 與 `test/migration-contract.ts` 保持第 13–14 章內容，32 項基準不因 DI 遷移改 assertion。

業務 model、Service、Repository 介面、Prisma Repository、schema／migration 與 shutdown 協調器都保持前章內容。這讓本章的變動可以集中驗證依賴組裝，而不是同時更改業務與資料模型。

限制仍須保留：這是部分路由遷移；第 16 章要把第 10 章的非法 UTF-8 bytes、慢速 body、下載中斷後關檔等案例接到完整 Nest fixture 重新執行。Provider 測試或目前 32 項 HTTP 基準通過，都不能取代這項工作。

## 15.17 常見錯誤與練習

| 現象 | 優先檢查 |
|------|----------|
| Nest 無法解析建構子參數 | token 是否同一個？有沒有註冊 Provider？是否只寫了消失於執行期的 interface？ |
| Factory 收到錯誤依賴 | inject 順序是否對應參數？型別註記不會修正錯誤 token |
| 測試換了 Repository 卻仍嘗試連線 | DATABASE 仍在 Provider 清單且會初始化，是否也要覆寫？ |
| 兩個名稱本應共用卻出現兩個實例 | 是否用了 useClass 重新註冊，而非 useExisting？ |
| singleton 中出現另一個請求的資訊 | 是否把每請求資料存入共用可變欄位？ |
| 改成 REQUEST 後很多物件都重建 | 追蹤誰依賴它，檢查 scope 是否沿消費者鏈傳遞 |
| transient 沒有每次呼叫都變 | 確認消費者是否仍是同一個 singleton，方法呼叫不是重新注入 |
| 資源過早關閉或重複 disconnect | 是否新增了另一套所有權／信號 hook，跳過既有工作追蹤？ |

### 練習一：故意使用不同的同名 token

只在 examples/15 的測試中把 Repository 註冊 token 改成新的 `Symbol('ARTICLE_REPOSITORY')`，觀察 compile 錯誤，再恢復為匯入值。

驗收：能解釋文字相同不代表 Symbol 相同；不以改成 any 或把依賴設成 optional 掩蓋問題。

### 練習二：替換 Repository，保留 Service

擴充 providers.test.ts 的替身，讓 `findVisible()` 回 null，呼叫真正 Service 的 detail，確認 NOT_FOUND；再回傳文章，確認成功與傳入的可見範圍。

驗收：沒有改成整個 Service 都是 mock；不使用真實資料庫，也不宣稱替身證明了交易回滾。

### 練習三：比較 useClass 與 useExisting

在 scope lab 暫時把 STAMP_ALIAS 改成 useClass，再執行 scopes 測試與 lab:scopes，最後復原。

驗收：原本 alias 與 singleton 相同的斷言應失敗；能說明哪一個註冊新建了物件。恢復後所有檢查通過。

### 練習四：觀察 scope 傳遞方向

畫出 ScopeController、RequestConsumer、RequestStamp、SingletonStamp 的依賴圖，標示兩次請求中哪些 ID 相同、哪些不同。再說明為什麼 ConsumerA 的 transient 不隨每次 HTTP 改變。

驗收：以 lab 與測試輸出支持答案，不把 REQUEST 說成會使全部下層資料庫依賴重建。

### 練習五：等待初始化，不靠固定 sleep

閱讀 providers.test.ts 的 deferred 測試，先等待 `$connect` 替身進入，再確認 application 尚未交出 Server，最後釋放 Promise。

驗收：不用猜測「睡 100 ms 應該夠了」；即使中間斷言失敗，也要在 finally 釋放阻擋並清理建立中的應用。

### 本章完成檢查

- [ ] 能從 Controller 建構子指出依賴 token 與 TypeScript 型別。
- [ ] 能畫出 DATABASE → Repository → Service 的建立順序。
- [ ] 明白 Provider 清單順序不取代 inject 依賴關係。
- [ ] 已執行 Provider 替換測試，知道只換 Repository 不一定隔離資料庫。
- [ ] 已執行 scope lab，能區分三種 scope、別名與另一個註冊。
- [ ] 已跑完完整 check、migration、seed 與 API 操作。
- [ ] 原 32 項 HTTP 基準、真實交易與離線工作追蹤仍通過。
- [ ] 能說明初始化失敗及正常 shutdown 的資源所有權。

下一章：[16 — 功能模組、依賴邊界與文章功能遷移](16-modules-boundaries-and-dependencies.md)：將剩餘文章路由搬到 Nest，以功能模組的 imports／exports 管理依賴，並承接完整遷移與底層傳輸驗收。

---

[上一章：Nest 啟動與請求生命週期](14-nest-bootstrap-and-request-lifecycle.md) · [返回課程總覽](README.md) · [本章範例](examples/15/README.md) · [本章契約](examples/15/BASELINE.md)
