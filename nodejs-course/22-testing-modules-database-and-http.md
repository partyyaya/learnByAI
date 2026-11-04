# 22 — TestingModule、資料庫、HTTP 測試與資料隔離

第 21 章已經有 339 項測試。本章不再增加業務功能，而是回答：**這些測試究竟證明了哪一層？測試替身會不會跳過真正的 HTTP 規則？初始化失敗與兩個 worker 同時執行時，資料與資源是否仍正確隔離？**

我們保留既有 API，讓 TestingModule 共用正式的 HTTP 啟動流程，建立可清理的 fixture，再用兩個真正的 Jest worker 驗證資料隔離。[完整範例](examples/22/README.md)與[本章契約](examples/22/BASELINE.md)均可用 Docker 執行。

## 22.1 本章完成後應能做到什麼？

- 依需求選擇 Service 單元、模組組裝、真實資料庫、HTTP 或程序測試。
- 在 compile 前替換 Provider，理解 compile、init 與 close 的差別。
- 讓測試與正式入口共用 parser、adapter、Guard、Pipe、presenter 與關閉流程。
- 為 schema、client、server、Cookie jar 與暫存檔建立明確所有權。
- 驗證初始化失敗也會清理，而不是靠 forceExit 結束測試。
- 區分同篇文章的更新競爭與不同測試 worker 的資料隔離。

前置閱讀：[12 — 分層與替身](12-service-repository-and-manual-di.md)、[15 — Provider／DI](15-providers-di-tokens-and-scopes.md)、[18 — Session／權限](18-authentication-sessions-and-guards.md)、[20 — 交易](20-persistence-transactions-and-concurrency.md)、[21 — 文件與查詢契約](21-api-contracts-pagination-and-openapi.md)。

技術版本沿用 Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Nest 11.2.8、Prisma 7.10.1、pg 8.23.1、PostgreSQL 17。沒有新增套件或 migration，密碼 KDF 與安全限制不因測試而降低。

## 22.2 先寫出測試要證明的行為

「有跑過程式」與「驗證需求」不同。以發佈文章為例，至少要知道測的是哪個問題：

| 測試層次 | 保留什麼 | 適合證明什麼 |
|----------|----------|--------------|
| Service 單元 | 真 Service、Repository 替身 | 權限／版本／狀態檢查順序，失敗不繼續寫入 |
| TestingModule 組裝 | 真 token／Module／factory | 依賴是否正確注入，覆寫是否真的生效 |
| Repository 整合 | 真 Prisma／PostgreSQL | 條件 UPDATE、唯一／外鍵、交易與回滾 |
| HTTP＋替身 | 真 parser／Guard／Pipe／Controller／投影 | wire 驗證、狀態碼、header、錯誤出口與資料投影 |
| HTTP＋真 DB | 上述流程加真 Session／資料庫 | 登入、資料權限、持久化與跨表一致性 |
| 程序／Docker | 真入口、設定、信號與環境 | 啟動失敗、停止、重啟保存與容器連線 |

這些名稱不代表固定速度，也沒有一套命名能自動保證測試品質。重點是明確指出哪些是真的、哪些被替換，以及斷言能支持什麼結論。

例如 Repository 的 mock 回傳「更新成功」，只能證明 Service 接受該結果。它沒有經過 PostgreSQL，不足以證明兩個請求不會互相覆蓋，也不能證明稽核失敗時文章會回滾。

### 用 Given／When／Then 設計斷言

```text
Given：Alice 的草稿，version 1，沒有狀態稽核
When：真正登入 Alice，發佈時在稽核 INSERT 之後拋錯
Then：HTTP 安全 500
      文章 status／version／updatedAt 完全不變
      稽核仍為 0 筆
      相同 expectedVersion 在故障移除後可以成功
```

最後幾個資料斷言不能只用 `expect(status).toBe(500)` 取代。反過來，直接呼叫 Repository 回滾成功，也不足以證明 HTTP 不洩漏 SQL、Cookie 或原始錯誤。

## 22.3 TestingModule：compile 不等於完整 HTTP 服務

[Nest 官方測試文件](https://docs.nestjs.com/fundamentals/testing)提供 Test.createTestingModule、Provider 替換與 createNestApplication 等方式。本章沿用固定的 @nestjs/testing 11.2.8，不新增測試框架。

```text
Test.createTestingModule
  → overrideProvider
  → compile：建立與解析 Provider，等待 async factory
  → createNestApplication：建立 HTTP 應用
  → init：執行初始化、註冊 HTTP 流程
  → 請求與斷言
  → 關閉應用與外部資源
```

compile 期間就可能執行 DATABASE async factory 的 $connect；不能以為還沒 init 就一定沒有外部 I/O。另一方面，onModuleInit 是初始化 hook，不能把建立實例與執行 hook 混為一談。

[testing-overrides.test.ts](examples/22/test/testing-overrides.test.ts)以 Probe 實際觀察 construct → init → destroy，並測試 async Provider 失敗後的 client 清理。

### 在 compile 前覆寫真正的 token

```ts
builder
  .overrideProvider(DATABASE).useValue(databaseDouble)
  .overrideProvider(ARTICLE_REPOSITORY).useValue(repositoryDouble)
  .overrideProvider(AUTH_SERVICE).useValue(authDouble())
  .overrideProvider(CHECK_READY).useValue(async () => {});
```

token 必須是模組真正使用的同一個 Symbol，不能另外建立同名 Symbol。覆寫只影響這個測試容器，不會修改正式 API 接受的 Cookie 或驗證規則。

只覆寫 Repository 並不會從模組圖移除 DATABASE Provider，原本的 async 初始化仍可能執行。因此離線組裝測試會明確替換 DATABASE；真實 DB 測試則保留它。

使用 factory 覆寫時，注意兩個不同 API：

```ts
// 正式 Provider 定義
{ provide: ARTICLE_REPOSITORY, inject: [DATABASE], useFactory: makeRepository }

// TestingModule 的 override API
builder.overrideProvider(ARTICLE_REPOSITORY).useFactory({
  inject: [DATABASE],
  factory: makeRepository,
});
```

在第二種寫成 useFactory 欄位會被本章型別檢查拒絕。不要因為兩者名稱接近，就跳過工具與版本提供的型別。

## 22.4 測試要共用正式的 HTTP 組裝

若測試自己 new 一個寬鬆 Express app，正式入口卻有不同 parser、strict routing 或錯誤 adapter，測試通過也不能證明上線後行為相同。

本章只在 [server.ts](examples/22/src/server.ts)增加一個可選的 applicationFactory 組裝參數：

```text
createArticleServer
  → 建立同一個 Express app 與原始 HTTP server
  → 設定 query parser、strict routing、傳輸與 shutdown
  → 建立同一 AppModule 與 ContractExpressAdapter
      正式：預設 NestFactory.create
      測試：TestingModule.compile → createNestApplication
  → 加 requestContext、既有 middleware
  → 同一 nest.init
```

正式 main 不傳入 applicationFactory，原本的 NestFactory 行為不變。這是可信程式的組裝參數，不是 HTTP header、query 或環境變數的驗證繞過開關。

[testing-application.ts](examples/22/test/testing-application.ts)的核心是：

```ts
applicationFactory: async (root, adapter, settings) => {
  const builder = Test.createTestingModule({ imports: [root] });
  configure(builder);
  context = await builder.compile();
  return context.createNestApplication(adapter, settings);
}
```

完整檔案包含失敗清理；上述為結構節錄。settings 仍含 bodyParser:false、logger:false 等設定，初始化與關閉由同一正式流程處理。正式 source 只宣告 factory 型別，不匯入 @nestjs/testing。

### 不要先關閉測試容器

```text
等進行中 HTTP／已登記工作完成
  → 關 Nest context
  → disconnect database
  → 才清理測試 schema 與檔案
```

如果測試先 context.close 或關 pool，仍在執行的 Guard／Service 可能被中途切斷。fixture 透過既有 lifecycle.shutdown 關閉，不另外建立第二套資源關閉責任。

## 22.5 替身要保留真正想測的邊界

本章的離線 HTTP 組裝測試替換 Repository、AuthService 與 readiness，保留真正 Guard、Pipe、Service、presenter 與 Filter。

```text
固定測試 Cookie
  → 真 SessionGuard
  → 明確的 AuthService 替身
  → 真 Pipe／Controller／Service
  → Repository 替身
  → 真 presenter／Filter
```

這可以測到未登入 401、錯誤 CSRF 403、未知欄位 400、trim、Location、白名單投影與安全 500。固定 test token 只由 test/ 的 AuthService 替身接受，正式 AuthService 沒有後門。

但它不能證明密碼雜湊、Session 輪替、真實資料權限查詢或 DB readiness；這些仍由真實 PostgreSQL 測試負責。覆寫 CHECK_READY 得到 200，更不能寫成「資料庫已驗證」。

### 直接呼叫 Controller 會略過什麼？

```ts
await controller.create(input, actor, responseDouble);
```

這只是方法呼叫，不會執行 decorator 綁定的 Guard、Pipe 或 presenter，也沒有 HTTP 201／header 的傳輸過程。

測試刻意直接傳空白 title，替身 Repository 會收到它；相同資料改走真 HTTP，則由 Pipe 回 400，而且 Repository 沒有再被呼叫。這個案例用來辨認測試範圍，並不是正式 API 接受空白標題。

### Mock 的呼叫紀錄與實作要分清

mockClear 清除呼叫紀錄，mockReset 還會重設 mock 實作，mockRestore 適合恢復 spy 的原方法。測試若依賴預設回傳值，不能隨意開全域 resetMocks，再以到處補 mock 掩蓋依賴問題。

本章每次建立自己的替身，不改全域 mock 設定。資料庫交易替身也不以一個沒有回滾能力的 Map 冒充 PostgreSQL；未知錯誤必須往外傳，不能被測試工具吞成成功。

## 22.6 databaseFixture：每次擁有自己的 schema

[database-fixture.ts](examples/22/test/database-fixture.ts)沿用專用測試資料庫，新增 protocol 檢查、非同步 migration 與可重複 dispose：

```text
只讀 TEST_DATABASE_URL
  → PostgreSQL protocol＋精確 /course_test
  → UUID 產生 test_... schema
  → 建 schema → await migrate deploy
  → 依該 schema 建 client
  → 清理時只 DROP 自有 schema，關管理 pool
```

沒有 TEST_DATABASE_URL 就失敗，不回退到開發 DATABASE_URL。輸入 URL 的 schema 會被移除，再換成本次自有名稱；不能依 workerId 使用長期固定 schema，否則重跑或不同工作仍可能碰撞。

這是本機防誤用機制，不是資料庫權限隔離，也不能只靠名稱辨認正式環境。實際團隊仍需提供專用測試資料庫與適當憑證。[Prisma v7 整合測試文件](https://www.prisma.io/docs/orm/v7/prisma-client/testing/integration-testing)

### 非同步 migration 需要真正等待

原 fixture 使用 execFileSync。本章改為 promisify(execFile)，避免在同一 Node 程序建立兩份 fixture 時阻塞事件迴圈。

```ts
await runFile(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  env: { ...process.env, DATABASE_URL: connectionString },
  timeout: 30000,
});
```

deploy() 現在回傳 Promise，重跑 migration 的測試也必須改為 `await fixture.deploy()`。改了非同步 API 卻漏 await，可能讓斷言提早執行、清理先於 migration，或漏掉 rejection。

fixture 的 dispose 共用同一個 Promise，重複或同時呼叫不會再次 DROP 或重複結束管理 pool。這不表示可在 dispose 後繼續查詢；client 的關閉仍由持有它的應用負責。

### Prisma schema 與 raw SQL search_path 不同

adapter 的 schema 設定不代表 raw SQL 自動位於該 schema。故障觸發器等 raw SQL 明確限定程式產生的自有 schema；資料值則使用參數化查詢。

不要把未限定 schema 的 DROP／DELETE 當成通用清理方式。名稱來自程式產生的 UUID，不接受用戶任意指定。

## 22.7 httpFixture：連初始化失敗也要清理

[http-fixture.ts](examples/22/test/http-fixture.ts)把真實 DB、TestingModule、loopback 隨機 port 與臨時檔案放在一個可清理的範圍：

```ts
test('真實 HTTP 情境', async () => {
  const fixture = await httpFixture();
  try {
    // 請求與 DB 斷言
  } finally {
    await fixture.dispose();
  }
});
```

建立 fixture 本身若失敗，函式內部也會清理，因為呼叫端可能還沒拿到 fixture，無法在外層 finally 呼叫 dispose。

| 資源 | 所有權與清理 |
|------|--------------|
| schema、管理 pool | databaseFixture 擁有，只刪本次 UUID schema |
| PrismaClient | 交給 application 後，由 application 負責正常與初始化失敗的 disconnect |
| HTTP server、Nest context | 既有 shutdown 協調器負責排空與關閉 |
| 暫存 NDJSON 目錄 | httpFixture 建立，只刪自己的 mkdtemp 目錄 |
| Cookie jar | 每個登入 agent 自己持有，不寫入 proof |

清理會依序嘗試應用關閉、schema 清理、臨時目錄刪除；若有錯誤，以 AggregateError 報告。若初始化與清理都失敗，也保留兩者，避免只看到最後一個 rm 錯誤。

[fixture-lifecycle.test.ts](examples/22/test/fixture-lifecycle.test.ts)實際驗證 configure 拋錯、DATABASE 初始化後 Provider 拋錯、重複清理、disconnect 早於 DROP，以及關掉第一份 fixture 後第二份仍可服務。

這些是程式能執行 finally 時的保證。SIGKILL、主機當機或 Docker 引擎中止可能略過清理；不能因此宣稱任何失敗都絕不殘留，也不能在一般收尾刪掉整個資料 volume。

### Hook 的 Promise 也必須等待

beforeAll／beforeEach／afterEach／afterAll 可回傳 Promise，Jest 才能知道何時進入下一步。不要在 hook 裡啟動清理卻沒有 return 或 await。[Jest setup／teardown 文件](https://jestjs.io/docs/30.0/setup-teardown)

同一 fixture 的 reset 會依序刪 Session、稽核、文章、User，再 seed。它需要該 fixture 沒有進行中工作，不能讓多個 test.concurrent 共用它並互相清表。

reset 也會撤銷先前 Cookie 的資料庫 Session，因此必須重新登入。測試不能因瀏覽器仍帶 Cookie，就假設登入狀態還有效。

## 22.8 真正登入要使用獨立 Cookie jar

若 Alice 與 Bob 共用一個可變的「目前使用者」全域變數，並行測試可能在另一個請求前把身分改掉。這不符合不同瀏覽器 Session 的真實行為。

loginSession 使用各自 Supertest agent：

```ts
const alice = await loginSession(fixture.server);
const bob = await loginSession(fixture.server, demoAccounts[1]);

await bob.agent.post('/api/articles')
  .set(bob.writeHeaders)
  .send({ title: 'Bob 的草稿', content: '本文' })
  .expect(201);
```

每個 agent 保存自己的 Cookie，helper 真正執行 GET csrf → POST login，writeHeaders 使用登入輪替後的 CSRF。寫入仍需明確帶 header，不能把「測試 client 自動放行」當作認證。

測試會確認 Alice／Bob 的 me 各自正確、Alice 無法讀 Bob 的管理單篇，以及 Bob 的 Cookie 配 Alice 的 CSRF 會被拒絕。管理員也真正登入；me 仍只看本人，跨作者需走 admin 單篇入口。

密碼中的 18 沿用既有帳號。沒有為了加速而取消 scrypt、修改正式角色或讓 Session token 固定；測試程序內的 seed hash 快取仍只是減少重建同一份示範資料的成本。

## 22.9 故障注入仍要經過真正交易

本章透過 TestingModule 只替換 Repository 的一個失敗步驟，保留真正 tx：

```text
正式 Service → 原 Prisma Repository 的 transaction
  → 真 Article UPDATE
  → 真 ArticleStatusAudit INSERT
  → 測試專用 append 包裝器拋錯
  → callback 拒絕 → ROLLBACK
  → 正式 Filter 回安全 500
```

案例用計數確認 INSERT 已執行，再檢查文章整筆與原值相同、稽核為零。單次故障移除後，相同 expectedVersion 能成功，證明先前沒有偷增版本。

若只是 mockRejectedValue 一個完全沒有連資料庫的方法，即使 HTTP 500 正確，也不能宣稱驗證了回滾。相同原則也適用 SQL trigger 故障：觸發器只能安裝在本次自有 schema，finally 移除，正式 API 沒有故障入口。

### 兩種「並行」要分清

| 情境 | 共用哪些資料 | 要證明什麼 |
|------|--------------|------------|
| 兩個 app／pool 更新同篇文章 | 同一 schema、同一 id／version | 條件 UPDATE 只讓一個成功 |
| 兩個測試 worker 各跑案例 | 不同 schema，但 seed ID 相同 | 測試不會互相覆寫、越權或清掉對方資料 |

本章真實 HTTP 案例保留第一種，使用 Promise.all 看到 200／409。它不保證兩邊一定都先完成 SELECT；第 20 章已有受控 SELECT 屏障，提供更強的特定交錯證據，原案例仍保留。

## 22.10 用兩個真正的 Jest worker 驗證隔離

`Promise.all([requestA, requestB])` 不代表測試已跨 Jest worker。Jest 通常以檔案分配工作，因此本章提供 parallel-alpha 與 parallel-beta 兩份檔案，匯入同一組三項案例。

```text
runner 建立自己的暫存協調目錄
  → Jest maxWorkers=2，限定 alpha／beta
    → worker A：自有 schema＋app＋port → ready
    → worker B：自有 schema＋app＋port → ready
  → 兩份 ready 都存在、PID 不同，才進行寫入
  → 各自 reset、登入、案例、清理
  → runner 檢查 closed 與 schema 已刪除
  → 保存非憑證 proof
```

每份案例都使用相同 a_draft ID：

1. 編輯標題後發佈，確認自己的標題、版本 3 與一筆稽核。
2. Bob 越權被拒絕，文章與稽核不變。
3. 自有 schema 的 AFTER INSERT trigger 故障，文章與稽核一起回滾。

跨程序屏障有 15 秒期限，以 ready 檔案條件判斷，不用固定 sleep 猜測另一個 worker 是否完成。runner 最後確認兩個 PID、workerId、schema、port 都不同，server 關閉，兩份 schema 都不存在。

```bash
docker compose run --rm tools npm run test:parallel
```

maxWorkers 是上限，不是單憑旗標就證明恰好建立兩個 worker，所以本章會讀取實際證據。CLI 選項與 runInBand 的意義可對照 [Jest 30 CLI 文件](https://jestjs.io/docs/30.0/cli)。

結果在 `.data/parallel-proof.json`，只包含非憑證的 PID、workerId、schema、port、closed 與 remainingSchemas。runner 另清空子程序 DATABASE_URL，確認案例只依賴 TEST_DATABASE_URL。

### 為什麼不把所有測試直接開最大 worker？

每個 worker 有自己的 Node 程序、pool 與 KDF 上限，總連線與記憶體會增加。兩個 worker 的 scrypt 並不共享「每程序最多兩個」的限制；提高 worker 數需要重新評估資源。

本章只對這兩份自有 fixture 案例提供跨 worker 證據。一般全量測試仍使用 runInBand，沒有宣稱整個測試集可任意並行，也沒有為測試降低密碼成本。

## 22.11 測試指令、數量與診斷

| 指令 | 用途 |
|------|------|
| test:compile | 刪 .test-dist，再編譯 src 與 test |
| test | 編譯後以 runInBand 跑全量 368 項 |
| test:focused | 本章新增 29 項，依序執行 |
| test:parallel | 重新編譯，以兩個 worker 重跑 6 項並行案例 |
| test:baseline | 原 32 項文章 HTTP 基準 |
| check | 全量測試、build、程序、lab、文件與並行驗收 |

原 339 項保留，新增 testing-overrides 8、testing-http 7、fixture-lifecycle 8、兩份 parallel 共 6，合計 **32 套、368 項**。後面的並行重跑不再算新增六項，不能把重跑次數當不同測試數。

test、focused、parallel 都會重建 .test-dist，不能彼此同時跑，也不能與 test:runtime 或 lab:queries 同時跑。測試內部的 worker 並行與外部同時啟動兩個編譯指令，是不同問題。

### 測試結束不了時檢查什麼？

| 現象 | 檢查方向 |
|------|----------|
| assertions 通過但程序不結束 | server、pool、timer、未完成 Promise 或 child process 是否關閉 |
| 第二個測試使用舊登入 | 是否共用 Cookie jar，reset 後是否重新登入 |
| 偶發 409／重複唯一鍵 | 是否共享固定 schema 或相同測試資料 |
| 只有並行時 AUTH_BUSY | 是否讓同程序超過 KDF 上限，或錯誤無界啟動登入 |
| fixture 建立失敗留下資料 | 建立函式內部是否也有清理，不只呼叫端 finally |
| fake ready 200 被當成 DB 證據 | 是否明列 Provider 替換範圍 |
| migration 尚未完成就開始查詢 | 改成 async 後是否漏 await |

detectOpenHandles 可作針對性診斷，forceExit 不能代替清理。不要用 retry、通用 sleep 或大幅拉長全域 timeout 來掩蓋資源所有權問題。本章只給 migration、fixture 建立與跨程序協調明確的局部期限。

## 22.12 Docker 完整驗收

從倉庫根目錄開始：

```bash
cd nodejs-course/examples/22
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose run --rm tools npm run seed
docker compose up -d api
docker compose run --rm tools npm run test:query-api
docker compose run --rm tools npm run test:status-api
```

Compose 為 nodejs-course-22，API http://127.0.0.1:3022，開發 PostgreSQL 主機 15422；test-db 不公開端口。APP_ORIGIN 必須精確符合 3022，版本更新提示不改變本課依賴。

check 依序執行 generate → typecheck → 全量序列 Jest → build → test:runtime → 四個原 lab → lab:queries → openapi:export → test:parallel。

### 確認正式入口也沒有改壞

```bash
curl -i http://127.0.0.1:3022/health/ready
curl -i 'http://127.0.0.1:3022/api/articles?pageSize=1&sort=oldest'
curl -fsS http://127.0.0.1:3022/api/openapi.json -o /tmp/chapter-22-openapi.json
curl -i http://127.0.0.1:3022/api/me/articles
```

最後一項未登入仍是 401。OpenAPI 仍為 17 paths／30 operations，info.version 保留 21.0.0，因為本章不改業務契約；只把本機 origin 範例調整為 3022。

API 驗收仍真正登入三角色，驗證列表／文件與狀態稽核，不因測試組裝而接受固定 test token。接著驗證重啟保存：

```bash
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:query-persistence
docker compose run --rm tools npm run test:status-persistence
```

先成功執行對應 API 驗收再比對 persistence。proof 只保存文章、稽核與搜尋前綴，不保存 Cookie／CSRF；重啟比對重新登入，不宣稱測過保存在 proof 裡的舊 Session。

完成後正常停止：

```bash
curl -f http://127.0.0.1:3022/api/articles/export -o /tmp/chapter-22-articles.ndjson
curl -I http://127.0.0.1:3022/api/articles/export
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

公開 NDJSON 仍是獨立教學檔，不是資料庫或稽核備份。stop 保留 volume 與驗收資料；關閉順序仍為 draining → http-drained → closed，不使用 down -v 作一般收尾。

## 22.13 練習與完成檢查

### 練習一：判斷測試證據

測試覆寫 AuthService 與 CHECK_READY，呼叫 /health/ready 得 200，又成功讀取私人文章。這證明了真實密碼登入與資料庫 readiness 嗎？

<details>
<summary>參考答案</summary>

沒有。它證明替身接到正確 token，HTTP 流程可用指定結果工作。真實 KDF、Session 查詢、角色與必要資料表，仍需保留真實 Provider 的整合測試。

</details>

### 練習二：讓隔離測試抓到錯誤

在練習副本把 fixture schema 改成固定名稱，或讓兩個測試共用一個 HTTP port，再執行 test:parallel。確認它會因碰撞、證據不獨立或初始化失敗而失敗，完成後恢復正確版本。

只能使用專用 course_test，不得為了練習修改開發 public 或其他章的資料。不要以重跑直到成功取代修正。

### 練習三：驗證失敗也能清理

閱讀 DATABASE 已初始化後 Provider 拋錯的案例。再於自己的練習副本加入另一個明確的初始化失敗點，確認沒有回傳可用 server、schema 已刪除，也沒有留下自己的暫存目錄。

驗收：不只檢查 rejects，還要檢查外部資源結果。若自訂 Provider 自己建立外部資源，也必須明定其失敗時清理責任。

### 練習四：區分資料競爭與測試競爭

畫出兩種情境：兩個 app 共用 schema 發佈 a_draft，以及兩個 worker 各自發佈自己的 a_draft。分別寫出預期的成功數、衝突數與稽核結果。

<details>
<summary>參考答案</summary>

同一 schema／舊版本應一個成功、一個 VERSION_CONFLICT，只有成功的狀態稽核。不同自有 schema 應各自成功，各保存自己的文章與稽核，不因 seed ID 相同而互相衝突。

</details>

### 完成檢查

- [ ] 每個測試都能說明保留與替換了哪些依賴。
- [ ] Provider 在 compile 前覆寫，理解 async factory 與 init hook 的差別。
- [ ] 正式與 TestingModule 共用 HTTP 設定、adapter、init 與 shutdown。
- [ ] 不以直接呼叫 Controller 或 mock 交易當成真實 HTTP／回滾證據。
- [ ] fixture 在建立失敗、重複清理與同時建立時都能正確管理自有資源。
- [ ] Alice／Bob 使用獨立 agent，CSRF 與 Session 不混用。
- [ ] 兩個 worker 的 PID、schema、port 與清理已有實際 proof。
- [ ] 原 339 項回歸、368 項全量、6 項並行重跑及程序測試通過。
- [ ] 正式 API、重啟保存與正常停止完成，資料 volume 保留。

下一章：[23 — 外部 HTTP、期限、取消、有限重試與冪等條件](23-external-http-timeouts-and-retries.md)，串接可控制的本機外部服務，練習取消、期限、有限重試與錯誤轉換。

---

[上一章：API 契約與 OpenAPI](21-api-contracts-pagination-and-openapi.md) · [返回課程總覽](README.md) · [本章範例](examples/22/README.md) · [本章契約](examples/22/BASELINE.md)
