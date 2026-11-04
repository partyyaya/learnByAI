# 19 — Interceptor、Exception Filter、回應序列化與最小必要 RxJS

第 18 章已建立 Session、CSRF 與文章權限。現在每個 Controller 除了呼叫 Service，還要選擇公開欄位、轉換日期、包裝 data；錯誤則經由 Nest Filter 接到既有 Express 錯誤出口。這些工作已能運作，但責任邊界需要再整理。

本章把指定 JSON 路由的回應投影交給 Interceptor，將錯誤資料轉換與 HTTP 寫出分開，並用獨立實驗理解 RxJS 與 Filter 的作用範圍。**不新增業務功能，也不改變第 18 章的認證、權限及 HTTP 契約。**

完整快照在 [examples/19](examples/19/README.md)，驗收邊界在 [BASELINE.md](examples/19/BASELINE.md)。前置為 [18 — Session 與 Guard](18-authentication-sessions-and-guards.md)，並理解第 14 章請求生命週期與第 17 章 Pipe。

## 1. 先把責任放回正確位置

考慮一個 PATCH 文章請求：

```text
合法的 JSON bytes？            → parser middleware
有登入、CSRF 正確？            → Guard
title／expectedVersion 合法？  → Pipe
是本人或 admin、版本／狀態允許？→ Service
交易與條件 UPDATE 成功？       → Repository／PostgreSQL
哪些欄位可以送出去？           → presenter＋Interceptor
失敗如何表達為 HTTP？          → Filter＋錯誤契約＋傳輸出口
```

這裡的跨路由共用工作，是序列化、錯誤呈現與工作結束處理。不要因此把授權、版本檢查或交易也搬到同一個全域 Interceptor。

完成本章後，應能：

- 解釋 Interceptor 進入與回傳的方向，並分辨成功通知、錯誤通知與結束處理。
- 使用 map、tap、catchError、throwError、finalize，不在 Interceptor 手動 subscribe。
- 明確選擇回應欄位，保留分頁 metadata、Location、HEAD、204 與串流行為。
- 區分 route／controller／global Filter，理解它們不是 middleware 的 next 鏈。
- 讓已知業務錯誤維持既有代碼，讓未知錯誤不洩漏內部訊息。
- 證明客戶端離線、串流已送 header、Guard 失敗時仍有正確清理行為。

沿用 Nest 11.2.8、RxJS 7.8.2 與既有依賴，不安裝 class-transformer，也不增加資料庫 migration。

## 2. Interceptor 包住的是哪一段？

Interceptor 的核心介面有兩個參數：

```ts
intercept(context: ExecutionContext, next: CallHandler) {
  return next.handle();
}
```

ExecutionContext 提供目前 handler、Controller 與 HTTP request／response 等資訊。`next.handle()` 回傳 Observable，代表後續攔截層及 handler 的結果；不呼叫它，就不會正常繼續後面的處理。回傳這個 Observable，由 Nest 管理訂閱。[Nest Interceptors](https://docs.nestjs.com/interceptors)

本章有三層 Interceptor 的獨立實驗：

```text
global:before
  → controller:before
    → route:before
      → Pipe／handler
    ← route:next
  ← controller:next
← global:next
```

進入由外到內，成功值通知由內到外。若內層丟出錯誤，外層可以觀察或轉換該錯誤；不要把「after」理解成一定成功或回應已送完。

Guard 在 Interceptor 之前。Guard 拒絕時，不會執行這些 before／next／finalize；適用的 Filter 仍可能處理它的錯誤。middleware 的錯誤又更早，不能期待路由 Interceptor 一定看得到。[Nest 請求生命週期](https://docs.nestjs.com/faq/request-lifecycle)

### 為什麼不在裡面 subscribe？

下面不是正確的請求攔截寫法：

```ts
// 反例：自行啟動一份訂閱，又把 Observable 交回 Nest。
const result = next.handle();
result.subscribe(value => console.log(value));
return result;
```

額外訂閱可能再次執行底層工作；若工作包含寫入，後果不只是印兩次日誌。另一份訂閱的錯誤與清理也可能不在原請求的控制流程裡。

本章所有正式 Interceptor 都只回傳組合後的 Observable。測試中的訂閱是為了觀察 RxJS 行為，不把測試寫法搬進 Controller。

## 3. 只學這一章用得到的 RxJS

可以先把 Observable 想成一個會送出通知的來源。來源可送出值，最後完成或失敗；消費者也可以取消訂閱。一般 JSON handler 通常只有一個結果，不需要把整個 Service 都改成 Observable。

| 工具 | 本章用途 | 容易誤解的地方 |
|------|----------|----------------|
| `map` | 把 handler 結果轉成公開回應 | callback 回傳值才是新結果 |
| `tap` | 記錄事件，不改變值 | callback 的 return 不會替換回應；丟錯仍會中斷流程 |
| `catchError` | 決定錯誤繼續傳出或改為另一個來源 | 回傳 `of(...)` 就是恢復，不只是記錄 |
| `throwError(() => error)` | 建立失敗來源，保留錯誤路徑 | 不會自動轉成 HTTP JSON |
| `finalize` | 訂閱結束時釋放同步登記狀態 | 完成、失敗、取消訂閱都可能執行 |
| `defer` | 在訂閱時才建立來源 | 用來觀察多次訂閱會重新開始工作 |
| `of`／`from` | 建立示範來源／包住 Promise | 包住 Promise 不表示能取消原工作 |

### map 與 tap 的對照

```ts
const source = of(3).pipe(
  tap(value => {
    console.log(value);
    return 99; // 不是新回應。
  }),
  map(value => value * 2),
);
// 訂閱後得到 6，不是 198。
```

本章用 map 呼叫 presenter，用 tap 記錄實驗事件。正式 API 不把完整 body、Cookie 或資料庫物件寫進 tap 的日誌。

### catchError 不是只有 catch

```ts
// 保留失敗，由外層或 Filter 處理。
catchError(error => throwError(() => error))

// 明確恢復成一個成功值；這會改變後續觀察到的結果。
catchError(() => of({ data: { recovered: true } }))
```

RxJS 的 catchError 會以回傳的來源接續流程。用 of 回傳錯誤訊息不會自動保留原失敗語意。[RxJS 7.8.2 catchError 原始碼與說明](https://github.com/ReactiveX/rxjs/blob/7.8.2/src/internal/operators/catchError.ts)

獨立實驗的 recovered 端點刻意回 200，讓你觀察 Filter 沒有執行。正式文章 API 沒有這種恢復：版本衝突仍是 409、未登入仍是 401。

### finalize 不等於成功，也不等於取消資料庫工作

finalize 在來源完成、失敗或訂閱取消時執行。它適合清除同步登記或記錄終止事件，不能用來宣告「業務提交成功」。[RxJS 7.8.2 finalize 原始碼與說明](https://github.com/ReactiveX/rxjs/blob/7.8.2/src/internal/operators/finalize.ts)

```text
一個 Promise 已經開始寫資料
  → from(promise) 建立 Observable
  → 消費者取消訂閱
  → finalize 執行
  → 原 Promise 仍可能繼續執行與寫入
```

因此，不要直接在全域加上 timeout 或取消訂閱，就聲稱資料庫查詢已停止。本章的 [rxjs-boundaries.test.ts](examples/19/test/rxjs-boundaries.test.ts) 用可控制的 Promise 證明：訂閱已結束，原工作仍會完成。外部 HTTP 的取消與重試留到第 23 章。

finalize 的同步 callback 也不會替你等待隨意啟動的非同步清理 Promise。資料庫關閉仍由原 shutdown 協調器明確 await。

## 4. 從重複 presenter 呼叫，到明確的回應政策

前章 Controller 的查詢方法類似：

```ts
const article = await this.articles.detail(id, true);
return { data: present(article) };
```

本章讓 handler 回傳應用結果，路由標記要使用的 presenter：

```ts
@Get(':id')
@SerializeResponse(articleResponse)
detail(/* Param Pipe 與 Response 參數 */) {
  return this.run(res, () => this.articles.detail(id, true));
}
```

這是概念片段，完整可編譯方法在 [articles.controller.ts](examples/19/src/articles.controller.ts)。Controller 仍負責必要的 HTTP 狀態與 Location；欄位投影交給 presenter。

[response-projection.ts](examples/19/src/response-projection.ts) 的核心為：

```ts
intercept(context: ExecutionContext, next: CallHandler) {
  const project = this.reflector.get<(value: unknown) => unknown>(
    responsePresenter,
    context.getHandler(),
  );
  return project
    ? next.handle().pipe(map(value => project(value)))
    : next.handle();
}
```

SerializeResponse 以 SetMetadata 儲存 presenter，Reflector 讀取目前 handler 的設定。本章只允許 method decorator，不從 Controller 層級預設套用，避免整個 Controller 裡的 export 或 204 被意外改寫。

未標記路由保留原回傳值。這不是全站自動資料防漏工具：新增會回傳內部資料的路由時，必須明確選擇投影並加上 HTTP 測試。

### 裝飾器的泛型沒有驗證 handler

`SerializeResponse<T, R>` 能描述 presenter 的輸入與輸出，卻不能替 TypeScript 證明相鄰 handler 一定回傳 T。把錯誤的 presenter 掛到某個路由，仍可能在執行期失敗。

因此，本章不以型別註記取代綁定測試。正式 HTTP 測試會逐一驗證文章單篇、列表、建立、修改、發佈、封存、admin 與認證端點。

## 5. 回應序列化先決定欄位，再決定格式

Article presenter 沿用第 12 章開始的白名單：

```ts
export function present(article: Article) {
  return {
    id: article.id, authorId: article.authorId,
    title: article.title, content: article.content,
    status: article.status, version: article.version,
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
  };
}
```

不要改成 `{ ...article }` 再刪 passwordHash。將來 model 新增 internalNote、關聯 author、權限資料或自訂 toJSON 時，黑名單可能漏掉新欄位；明列輸出只會加入已決定公開的內容。

本章有四種回應投影：

| presenter | handler 回傳 | HTTP body |
|-----------|--------------|-----------|
| articleResponse | Article | `{ data: 公開文章 }` |
| articlePageResponse | ArticlePage | `{ data: 公開文章[], meta: 分頁 }` |
| userResponse | PublicUser | `{ data: id/email/displayName/role }` |
| loginResponse | user＋csrfToken | `{ data: { user: 公開使用者, csrfToken } }` |

列表的 meta 也只選 page、pageSize、total，避免 Repository 或 Service 新增內部統計資訊時一起送出。

Service 與 Repository 原有的公開使用者投影仍保留；HTTP 投影是額外邊界，不鼓勵先把所有秘密讀進記憶體，再期待 Interceptor 幫忙清除。

### 輸入驗證與輸出投影不同

Pipe 驗證外部輸入並回傳 DTO；presenter 選擇可信應用結果的公開欄位。presenter 不是完整的輸出 schema 驗證器，不會重新驗證 title 長度、角色或全部欄位型別。

如果內部資料包含無效 Date，`toISOString()` 會失敗；這是內部錯誤，不能回 400 指責客戶端。測試確認它經 Filter 回安全的 500，沒有把原始資料或錯誤堆疊送出。

### 與 ClassSerializerInterceptor 的關係

Nest 也提供 ClassSerializerInterceptor，搭配 class-transformer 的規則與類別實例進行序列化。使用它時，要理解實例、普通物件、巢狀物件及序列化選項的差異；Prisma 查詢結果不會因為 TypeScript 標註成某個 class，就自動具備該類別的執行期行為。[Nest Serialization](https://docs.nestjs.com/techniques/serialization)

本課已經有純函式 presenter，這一章繼續使用它，避免同時維護兩套輸出規則。不安裝 class-transformer，也不示範一套未加入專案的裝飾器設定。

## 6. 哪些回應不能盲目包成 data？

全域使用 `map(value => ({ data: value }))` 看起來方便，但會造成幾個問題：

| 原回應 | 盲目包裝的後果 | 本章處理 |
|--------|----------------|----------|
| `{ data, meta }` 列表 | 變成 `{ data: { data, meta } }` | 指定 articlePageResponse |
| login 的 user／csrfToken | 消費端找不到原路徑 | 指定 loginResponse |
| logout 204 | 產生不該有的回應資料 | 不標記投影 |
| preview／health | 原本就有固定 envelope | 保留原結果 |
| `@Res()` 串流 | handler 已直接寫 socket | 不套 JSON 投影 |
| 錯誤 | 可能被偽裝成成功資料 | 交給 Filter，不以 of 吞掉 |

`@Res({ passthrough: true })` 允許 Controller 設定 Cookie 或 Location，同時把 body 交回 Nest。直接使用 `@Res()` 並自行 send／write，回應就由該路由負責；不能期待一般回傳值映射替換已送出的內容。[Nest 回應映射](https://docs.nestjs.com/interceptors#response-mapping)

本章建立文章仍回 201 與原 Location。HEAD 仍由相同投影產生必要 metadata，但不送 body；測試比較 GET／HEAD 的 Content-Length。匯出維持串流及檔案關閉流程，不把整份檔案讀進記憶體做 map。

## 7. Exception Filter 不是另一個業務 Service

Service 仍拋 ArticleError 或 AuthError；它們沒有 Express Response 或 HTTP status。HTTP 邊界才決定狀態碼。

本章將錯誤處理分成三段：

```text
ContractExceptionFilter
  → 處理 Nest 邊界差異，例如未知路由的 NotFoundException
  → errorResponse：normalizeError＋安全 envelope
  → sendHttpError：判斷 socket 狀態，寫入或中止傳輸
```

[errors.ts](examples/19/src/errors.ts) 中的 errorResponse 不操作 Request 或 Response，回傳 `{ status, body }`。錯誤的 details 也重新選出 field、code、message，不把未定義的額外資訊帶到 HTTP。

```ts
{
  error: {
    code: 'VERSION_CONFLICT',
    message: '文章已更新，請重新讀取',
    details: [],
  },
  requestId: '與 X-Request-ID 相同',
}
```

這份 envelope 沿用前章，不加 timestamp、path 或另一層 data。回應格式如果要演進，應明確更新契約及消費端，而不是在重構時順便修改。

### 已知與未知錯誤

| 來源 | 邊界結果 |
|------|----------|
| ArticleError 的版本／狀態衝突 | 原 409 及既有代碼 |
| AuthError 的認證／限流／忙碌 | 原 401／409／429／503 |
| 課程自己的 HttpError | 使用明確的狀態、代碼與公開訊息 |
| parser 的已知錯誤分類 | 原 400／413 等傳輸錯誤 |
| Nest 未知路由 NotFoundException | 404 NOT_FOUND／找不到路由 |
| 一般 Error、任意物件或其他未映射錯誤 | 500 INTERNAL_ERROR／內部錯誤 |

即使任意錯誤物件帶 `status: 418`、`message: '資料庫連線字串'`，也不能直接信任。未列入契約的 Nest HttpException 也不自動把 getResponse() 原封不動回傳；新增框架錯誤時要決定公開映射。

本章沒有試圖保證所有 Error 物件都能安全公開。相反地，未知錯誤預設隱藏細節，日誌只記錄 requestId、分類與傳輸階段。

## 8. Filter 的作用範圍：就近匹配，不是接力賽

Filter 可以綁在 route、Controller 或 global；`@Catch(SomeError)` 限定錯誤型別，`@Catch()` 接住未處理的各種錯誤。當較近的 Filter 已匹配並處理，不會像 Express middleware 一樣再呼叫 next 傳給其他 Filter。[Nest Exception Filters](https://docs.nestjs.com/exception-filters)

本章獨立實驗有三個 Filter：

```text
/responses/route-error       → route Filter
/responses/controller-error  → controller Filter
/outside/error               → global Filter
```

每個回應明確包含 handledBy，測試確認一次只有一個 Filter 處理。實驗的 Filter 使用固定 422 與安全的 LAB_REJECTED，方便辨識；它不掛入文章 API，也不是新的正式錯誤格式。

`/responses/denied` 的 Guard 先丟錯，所以沒有任何 Interceptor 事件，但 route Filter 可以處理。`/responses/recovered` 的錯誤被 catchError 恢復成成功值，所以不再進 Filter。

不要在多個同範圍 Filter 之間依賴含糊的處理順序，也不要用 Filter 補做交易或授權。讓每個 Filter 的匹配條件與回應責任保持明確。

## 9. APP_INTERCEPTOR 與 APP_FILTER 的 DI 註冊

正式 [AppModule](examples/19/src/app.module.ts) 登記：

```ts
providers: [
  { provide: APP_GUARD, useClass: RequestWorkGuard },
  { provide: APP_INTERCEPTOR, useClass: RequestWorkInterceptor },
  { provide: APP_INTERCEPTOR, useClass: ResponseProjectionInterceptor },
  { provide: APP_FILTER, useClass: ContractExceptionFilter },
]
```

ResponseProjectionInterceptor 由容器注入 Reflector。ContractExceptionFilter 則從 RuntimeModule 注入 ERROR_REPORTER；server 把外部提供的 onError callback 放入該 Provider，不再自己 new 一份正式全域 Filter。

APP_FILTER／APP_INTERCEPTOR 即使宣告在模組中，仍是全域註冊。好處是依賴由 Nest 管理，不代表它們只對該模組的 Controller 生效。官方文件也區分模組內 Provider 註冊與容器外 `useGlobalFilters(new ...)` 的依賴取得方式。[Nest 全域 Filter 與 DI](https://docs.nestjs.com/exception-filters#binding-filters)

獨立 lab 可以自行建立簡單 Filter；它沒有正式 ERROR_REPORTER 的依賴。正式 API 的測試則驗證 callback 確實取得安全的 ErrorReport。

### 仍然是 Express adapter

errorResponse 是純資料轉換，但 sendHttpError 明確使用 Express／Node 的 headersSent、writableEnded、destroyed 與 destroy。這不是一份宣稱可直接切換到 Fastify、WebSocket 或 microservice 的全平台 Filter。

若未來更換傳輸平台，可保留業務錯誤與公開 envelope，再替換實際寫出策略。本課維持既有 Express adapter，沒有為了抽象而拿掉已驗證的串流保護。

## 10. 已送 header，就不能再補一份 JSON

sendHttpError 的順序是：

```text
response 已離線        → 記錄 disconnected，不再寫
response 已 end        → 記錄 ended，不再寫
header 已送、尚未結束  → 記錄 streaming，中止連線
尚未送出              → 寫入安全的錯誤 JSON
```

開始傳送 NDJSON 之後若出錯，不能回頭改 status，也不能在檔案尾巴接一個 JSON 錯誤 envelope。那會產生混合格式，讓客戶端誤以為下載成功。

實驗 partial 端點故意先寫部分內容再失敗，驗證 Filter 中止連線。原匯出測試繼續確認下載中斷後停止讀取、關閉檔案；正式匯出並沒有被一般 JSON Interceptor 接管。

Filter 不是處理任意背景錯誤的萬用出口。脫離請求的 setTimeout、事件監聽器或沒有 await 的 Promise，仍必須在自己所屬的工作生命週期裡處理；不要期待它們一定回到當前請求的 Filter。

## 11. 回應結束與工作結束不能混為一談

第 18 章已加入 RequestWorkGuard：在認證 Guard 查資料庫之前登記工作，再由 RequestWorkInterceptor 或失敗 Filter 釋放。本章保留這個機制。

```text
RequestWorkGuard 登記
  → Session／CSRF Guard
  → RequestWorkInterceptor 包住後續流程
  → ResponseProjectionInterceptor
  → Pipe → handler → Service
  → presenter 成功或失敗
  → finalize 釋放登記
```

Guard 若提前失敗，尚未進入 Interceptor，由 Filter 的 finally 釋放登記。資料庫關閉仍等 HTTP 與已登記工作完成，不能只因 socket close 就 disconnect。

本章沒有在客戶端離線時主動取消整個 Observable，也沒有加全域 timeout。前文的 Promise 實驗說明了原因：取消結果通知與停止實際 I/O 是不同事情。若未來加入取消策略，必須重新驗證進行中工作是否仍被追蹤。

同樣地，Interceptor 的 finalize 不保證回應 bytes 已到達客戶端。HTTP 的 finish／close 仍由 middleware 記錄，業務是否提交則由 Service／交易結果決定。

## 12. Docker 操作與可執行實驗

在專案根目錄執行：

```bash
cd nodejs-course/examples/19
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose up -d api
```

本章 API 使用主機 **3019**，PostgreSQL **15419**；Compose 專案與 volume 為 nodejs-course-19，不共用第 18 章資料。APP_ORIGIN 改為 `http://127.0.0.1:3019`。

沿用本機示範帳號與密碼：Alice 為 `alice@example.test`／`Alice-course-18!`，Bob 為 `bob@example.test`／`Bob-course-18!!`，admin 為 `admin@example.test`／`Admin-course-18!`。密碼名稱沿用前章，不因範例目錄改成 19 而更換；僅供本機課程。

### 獨立回應實驗

```bash
docker compose run --rm tools npm run lab:responses
```

指令建立臨時 Nest app、監聽隨機端口，逐一送 HTTP 請求、列出事件順序，最後關閉。它不讀資料庫，也不會把實驗路由掛入文章 API。

預期可觀察：

| 路徑 | 結果 |
|------|------|
| `/responses/ok` | 200，只有 data.value；三層 before／next |
| `/responses/route-error` | 422，route Filter |
| `/responses/controller-error` | 422，controller Filter |
| `/outside/error` | 422，global Filter |
| `/responses/denied` | Guard 拒絕、沒有 Interceptor 事件 |
| `/responses/recovered` | 200，catchError 恢復、不進 Filter |
| `/responses/raw` | 純文字 plain |
| `/responses/empty` | 204，沒有 body |

實際完整 trace 以本章鎖定版本的執行結果為準。不要從 before／next 的順序推論所有 teardown callback 必然有同樣的巢狀排列。

### 檢查正式 API 的回應

```bash
curl -i http://127.0.0.1:3019/health/ready
curl -i 'http://127.0.0.1:3019/api/articles?page=1&pageSize=1'
curl -I http://127.0.0.1:3019/api/articles/a_1
curl -i http://127.0.0.1:3019/api/me/articles
curl -i http://127.0.0.1:3019/responses/ok
```

預期為 200、200、200 且 HEAD 無 body、401、404。列表仍只有一層 data 與同層 meta；錯誤仍是 error＋requestId。

登入與 Cookie jar 的完整流程沿用[第 18 章操作](18-authentication-sessions-and-guards.md#11-docker-啟動與第一次登入)，在本章目錄執行，將 chapter18_origin 設為 `http://127.0.0.1:3019`。密碼不變，登入後仍要更新 Cookie 與 CSRF token。

### 匯出與停止

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3019/api/articles/export -o /tmp/chapter-19-articles.ndjson
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

匯出仍為獨立 NDJSON 教學檔，不是資料庫備份。停止保留 volume；不使用 down -v 作一般收尾。

## 13. 驗收不能只看成功的 JSON

本章新增三組測試：

| 測試 | 證明什麼 |
|------|----------|
| response-http.test.ts | 正式路由綁定正確，內部欄位不外洩，成功／失敗 envelope 不混淆 |
| response-lab.test.ts | 三層 Interceptor、Filter 範圍、Guard 早退、恢復、raw／204、部分傳輸與並行隔離 |
| rxjs-boundaries.test.ts | 訂閱次數、map／tap、恢復／重拋、finalize 與 Promise 取消邊界、安全錯誤投影 |

HTTP 測試刻意把 passwordHash、巢狀 Session、內部統計欄位與自訂 toJSON 放進替身結果。確認回應沒有這些欄位，比單純檢查 presenter 被呼叫更有用。另確認原物件沒有被刪欄位或改日期型別，避免污染共用物件。

原 32 項文章 HTTP 基準與第 18 章安全測試繼續跑真正 PostgreSQL，沒有改掉業務預期。既有傳輸、交易、版本競態、登出撤銷與 shutdown 案例也保持執行。

```bash
docker compose run --rm tools npm test -- --testPathPatterns=response
docker compose run --rm tools npm test -- --testPathPatterns=rxjs-boundaries
docker compose run --rm tools npm run test:baseline
docker compose run --rm tools npm run check
```

check 依序 generate、typecheck、Jest、build、test:runtime、lab:nest、lab:scopes、lab:validation、lab:responses。test:runtime 需要編譯輸出，不要與會刪 `.test-dist` 的 npm test 並行。

## 14. 練習與完成檢查

### 練習一：預測通知方向

先不執行，寫下 ok、route-error、denied、recovered 的 before、next、error、Filter 事件。再跑 lab:responses 比較。

驗收：能說明 denied 沒有 Interceptor，以及 recovered 為何回 200。不要把 finalize 當成成功證據。

### 練習二：模擬 model 增加內部欄位

在測試替身的文章與 user 增加 internalNote、passwordHash、巢狀 sessions，再加入自訂 toJSON。

驗收：HTTP 回應仍只有白名單欄位，原物件未被修改。不要以「目前資料表沒有這欄」作為省略測試的理由。

### 練習三：故意掛錯 presenter

在自己的副本把列表改用 articleResponse，再執行正式 HTTP 測試。

驗收：理解 metadata 泛型不能保證 handler 的回傳形狀；錯誤不能洩漏內部資料，恢復正確綁定後測試通過。

### 練習四：讓錯誤繼續往外，或刻意恢復

把實驗 recovered 的 of 改成 throwError，觀察狀態、外層 next／error 與 Filter。

驗收：能區分「記錄錯誤」「重新拋出」「恢復成成功結果」，並說明正式版本衝突不能被吞掉。

### 練習五：觀察取消訂閱的限制

閱讀 from(Promise) 的測試，在取消訂閱後才釋放 Promise。

驗收：finalize 已執行，但工作仍完成；能說明為什麼不能因此提早關資料庫，以及 AbortSignal 是否需要底層真正支援。

### 完成檢查

- [ ] parser、Guard、Pipe、Service 與回應投影各有明確責任。
- [ ] Interceptor 不自行 subscribe，不無意恢復業務錯誤。
- [ ] 回應白名單涵蓋文章、分頁 metadata 與使用者資料。
- [ ] Location、Cookie、HEAD、204 與 NDJSON 契約保持不變。
- [ ] 未知錯誤不信任任意 status／message，不洩漏內部資料。
- [ ] Filter 的就近匹配與 DI 註冊已經真實 HTTP 驗證。
- [ ] 串流已送 header、Guard 早退及客戶端離線仍有正確清理。
- [ ] 完整 Docker check、資料庫初始化與實驗均通過。

下一章：[20 — Prisma Provider、連線生命週期、交易與併發](20-persistence-transactions-and-concurrency.md)，擴大文章狀態變更與稽核紀錄的交易情境，深入連線、唯一約束與併發驗收。

---

[上一章：Session 與 Guard](18-authentication-sessions-and-guards.md) · [返回課程總覽](README.md) · [本章範例](examples/19/README.md) · [本章契約](examples/19/BASELINE.md)
