# 17 — DTO、Pipe、轉型與執行期驗證

第 16 章已完成文章端點的 Nest 遷移，但每個 Controller 方法仍要先呼叫 parseInput。規則有集中管理，呼叫位置卻散在各個方法內；新方法若忘了這一步，TypeScript 型別也不會替我們攔住非法 HTTP 輸入。

本章把這一步移到 Nest Pipe。Controller 參數宣告會同時顯示「從哪裡取值、使用哪份 schema、取得什麼 DTO」，方法本體再處理業務呼叫與 HTTP 回應。

完整快照在 [examples/17](examples/17/README.md)，既有 HTTP 與資料規則在 [BASELINE.md](examples/17/BASELINE.md)。前置為 [16 — 功能模組與依賴邊界](16-modules-boundaries-and-dependencies.md)，並理解第 09 章 Zod 與第 14 章請求生命週期。

## 1. 本章目標與範圍

完成後，你應該能：

- 分清 DTO 型別、執行期 schema、資料庫 model 與回應格式。
- 實作 PipeTransform，讓驗證結果成為 Controller 的實際參數。
- 將 body、query、params 分別綁定正確 schema，拒絕未知欄位。
- 解釋轉型前後的型別，以及為什麼不能對所有輸入都直接 Number()。
- 區分欄位省略、undefined、null、空字串與有效值。
- 保留 PATCH 的局部修改與版本要求，不因「可選」而意外清空資料。
- 透過真實 HTTP 證明驗證失敗時不執行 Controller／Service。

本章沿用 Nest 11.2.8 與 Zod 4.6.7，沒有新增依賴，也沒有重新設計 API 契約。作者仍是固定 u_demo，登入與授權從第 18 章開始。

## 2. 先觀察：型別正確不代表收到的資料正確

以下宣告看起來很完整：

```ts
class UncheckedDraftDto {
  title!: string;
  content!: string;
}

@Post('unchecked')
unchecked(@Body() dto: UncheckedDraftDto) {
  return dto;
}
```

但 HTTP 客戶端仍可以送：

```json
{ "title": 123, "content": "本文", "extra": true }
```

屬性上的 `string` 幫助編譯器檢查程式碼；它不會在網路入口執行 typeof，也不會自動拒絕 extra。`!` 只是告訴 TypeScript 不必報告屬性尚未初始化，不是輸入驗證。

就算 class 出現在 design:paramtypes metadata 中，也需要某個執行期元件真正使用規則。單靠 `@Body()` 與 class 型別，收到的仍是 parser 產生的普通物件。

本章提供獨立 [validation-lab.ts](examples/17/src/validation-lab.ts)，可以看到這個反例真的回傳非法輸入。它不連資料庫，也不匯入正式文章 AppModule；文章 API 沒有這個未驗證端點。

建置後執行：

```bash
docker compose run --rm tools npm run lab:validation
```

指令會建立臨時 Nest app、監聽隨機端口、送真實 HTTP 請求並在最後關閉。完整環境步驟見後文。

## 3. DTO 放在哪個邊界？

DTO 是 Data Transfer Object，用來描述某個邊界傳遞的資料。本章用 DTO 命名 HTTP 驗證完成後交給 Controller 的參數。

```text
網路 bytes
  → JSON parser／URL query 解析
  → unknown 輸入
  → schema 驗證與必要轉型
  → DTO
  → Controller → Service 的應用輸入
  → Repository → PostgreSQL
```

不要把文章資料表的全部欄位直接當成建立文章 DTO：

| 內容 | 包含什麼 | 由誰決定 |
|------|----------|----------|
| CreateArticleDto | title、content | HTTP 輸入契約 |
| PatchArticleDto | 可選 title／content、必要 expectedVersion | 局部更新契約 |
| ChangeArticleStateDto | expectedVersion | publish／archive 契約 |
| ArticlePaginationDto | 驗證後的數字 page、pageSize | 查詢契約 |
| Article model | id、authorId、status、version、Date 等 | 應用與持久化需求 |
| 公開 Article 回應 | 明列可公開欄位，日期轉 ISO 字串 | presenter 與 HTTP 回應契約 |

authorId、status、version 不是建立草稿時可任意指定的欄位。Service 仍負責作者、狀態與版本規則；輸入 DTO 不等同於授權檢查。

### 從 schema 推導型別

[article.dto.ts](examples/17/src/article.dto.ts) 使用原 schema 作為來源：

```ts
export type CreateArticleDto = z.output<typeof draftSchema>;
export type PatchArticleDto = z.output<typeof patchSchema>;
export type ArticlePaginationDto = z.output<typeof paginationSchema>;
export type PaginationQueryInput = z.input<typeof paginationSchema>;
```

不需要再手寫一套相同欄位的 interface，避免修改 schema 後忘記同步型別。這些 type alias 在編譯後不會成為 class；本章 Pipe 透過明確傳入的 schema 驗證，不依賴 metatype 推測規則。

Service 的應用型別仍位於 article-model.ts，沒有因此依賴 Nest。兩者目前的資料形狀相容；未來若 HTTP 命名與業務輸入不同，可以在 Controller 做明確映射。

## 4. Pipe 的責任：把輸入轉成參數，或拒絕請求

Nest Pipe 的 transform 會收到值與 ArgumentMetadata，回傳值成為下一步參數；拋出的錯誤進入框架例外流程。Pipe 可用於驗證與轉型。[Nest 官方 Pipe 說明](https://docs.nestjs.com/pipes)

本章 [zod-validation.pipe.ts](examples/17/src/zod-validation.pipe.ts) 的核心只有兩步：決定錯誤欄位的來源前綴，呼叫共用解析函式。

```ts
export class ZodValidationPipe<T extends z.ZodType>
  implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.output<T> {
    if (metadata.data !== undefined ||
        !['body', 'query', 'param'].includes(metadata.type)) {
      throw new Error('ZodValidationPipe 必須綁定完整 Body、Query 或 Param 物件');
    }
    const source = metadata.type === 'param'
      ? 'params'
      : metadata.type as 'body' | 'query';
    return parseInput(this.schema, source, value);
  }
}
```

metadata.type 的路徑參數名稱是 param，而本課 error.details 的前綴是 params，所以需要映射。metatype 不參與這個實作。

這個 Pipe 刻意只接受完整 body／query／params 物件。若誤綁成 `@Body('title', pipe)`，會是程式設定錯誤，回到未知錯誤處理，不偽裝成客戶端輸入錯誤。完整物件驗證才能發現額外欄位；只抽出 title 會看不到同時傳入的 authorId。

### 為什麼回傳解析結果？

parseInput 的 safeParse 成功後回傳 result.data，其中包含 trim、數字轉換與預設值。若只驗證成功後 return value，就會把原始字串或未補預設值的物件交給 Controller。

實驗會比較：

```text
raw body：{ title: " 標題 ", content: " 本文 " }
DTO：     { title: "標題",   content: "本文" }

raw query：{ page: "2", pageSize: "3" }
DTO：      { page: 2,   pageSize: 3 }
```

本章不覆寫 req.body／req.query。Controller 應使用 Pipe 回傳的參數，不要在方法內又回頭讀 raw request 當作業務輸入。

### 為什麼不把所有錯誤都 catch 成 400？

parseInput 只把 schema 驗證失敗映射成 HttpError。程式本身的設定錯誤或意外例外仍是 500。否則 schema 寫錯或使用方式錯誤，也會被誤報為使用者輸入問題。

這個 Pipe 使用同步 schema，沒有查資料庫、發網路請求或保存請求狀態。查文章存在與否、判斷版本及交易仍在 Service；本章不把有副作用的工作移進 Pipe。

## 5. 把 Controller 改成接收 DTO

第 16 章的建立方法先讀 raw body：

```ts
create(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
  const input = parseInput(draftSchema, 'body', req.body);
  // 呼叫 Service，再組織 HTTP 回應。
}
```

第 17 章改為參數上的宣告：

```ts
@Post()
create(
  @Body(new ZodValidationPipe(draftSchema)) input: CreateArticleDto,
  @Res({ passthrough: true }) res: Response,
) {
  return this.run(res, async () => {
    const article = await this.articles.create(input);
    res.location(`/api/me/articles/${article.id}`);
    return { data: present(article) };
  });
}
```

run 沿用第 16 章的工作追蹤與 Controller 日誌；只有 Pipe 成功後才進入方法本體。201、Location、日期序列化與資料庫所有權都沒有改變。

### 每個參數使用自己的 schema

```ts
@Patch(':id')
edit(
  @Param(new ZodValidationPipe(idSchema)) params: ArticleParamsDto,
  @Body(new ZodValidationPipe(patchSchema)) input: PatchArticleDto,
  @Res({ passthrough: true }) res: Response,
) {
  return this.change('edit', params, input, res);
}
```

列表用 Query＋paginationSchema；單篇用 Param＋idSchema；export 用 Query＋emptyQuerySchema，拒絕任意指定檔案的 query。export 唯一仍使用 Req 的地方是判斷 GET／HEAD，不再從 Req 讀取業務輸入。

並非所有端點都新增 query 驗證。原契約中單篇查詢忽略未知 query，本章仍維持；不能因為新增通用 Pipe 就偷偷改變其他端點的接受範圍。

### 為什麼選擇參數層級？

若把 draftSchema 的 Pipe 放到整個 Controller，就可能連 params 或 query 都套上草稿規則。參數綁定直接標示每份資料的來源與 schema，讀起來也能看出哪些參數接受驗證。

本章 Pipe 沒有 DI 依賴，所以在裝飾器中建立實例即可；它只持有不可變的 schema 參照。若將來 Pipe 需要 Provider，應交由容器建立，再討論其模組與 scope。

## 6. parser 與 Pipe 各自處理哪一層？

```text
POST /api/articles
  → request context／關閉狀態檢查
  → body parser：媒體類型、bytes、編碼、JSON 語法、期限
  → Body Pipe：欄位、未知欄位、trim、長度與數值規則
  → Controller：DTO → Service、狀態碼、Location
  → Service／Repository：狀態、版本與交易
```

一般 Nest 生命週期先經 middleware，再到 Guard／Interceptor／Pipe，最後進入 Controller。Pipe 失敗時，方法本體不執行；有未捕捉例外時由 Filter 處理。[官方請求生命週期](https://docs.nestjs.com/faq/request-lifecycle)

目前文章 API 尚未加入認證 Guard；第 14 章的生命週期實驗仍是獨立 app。

| 輸入問題 | 處理層 | 本課回應 |
|----------|--------|----------|
| text/plain 或非 UTF-8 charset | parser | 415 UNSUPPORTED_MEDIA_TYPE |
| 壓縮 request body | parser | 415 UNSUPPORTED_ENCODING |
| 非法 UTF-8 bytes | parser | 400 INVALID_ENCODING |
| JSON 缺右括號、頂層 primitive | strict JSON parser | 400 INVALID_JSON |
| 已解析陣列、欄位型別錯誤、未知欄位 | Pipe/schema | 400 VALIDATION_ERROR |
| body 超過 16 KiB | parser | 413 PAYLOAD_TOO_LARGE |
| body 不結束 | parser | 408 REQUEST_TIMEOUT |
| 輸入合法，但版本已過期 | Service／交易 | 409 VERSION_CONFLICT |

Pipe 看見的是 parser 之後的值，不能代替 byte 上限或讀取期限。Nest 預設 parser 仍關閉，ArticlesModule 繼續掛上原 jsonBody；ContractExpressAdapter 與 Filter 仍負責保留錯誤分類。

多個參數的 Pipe 不應透過修改 req 或共用變數彼此傳遞結果。不要依賴跨參數的完成順序決定業務；需要同時比較多個欄位時，把它們放在同一份 schema 的物件規則中。未來若需要跨來源檢查，也應明確定義流程，而不是假設左邊參數一定先完成。

## 7. 轉型前要先決定允許什麼輸入

### query 原本是字串

page 與 pageSize 的原規則是：先確認單一十進位字串，再轉數字、檢查安全整數與範圍。

```text
"2" → 字串格式合法 → Number → 2 → 範圍合法
缺少 page → 預設 1
"" → 格式錯誤，不是缺少
"1e2" → 格式錯誤，即使 Number 可轉成 100
["1", "2"] → 不是單一字串
```

本章的測試同時拒絕 0x10、小數、負數、空白包住的數字、超出範圍與不安全整數。原規則允許前置零，因此 `page=0002` 仍得到 2，不因重構順便改掉。

預設 page: 1、pageSize: 20；page 上限 1000000，pageSize 上限 100。預設值只用在缺少欄位，不把錯誤值改成預設值來掩蓋問題。

### JSON body 的版本原本就是數字

expectedVersion 的合法 JSON 是：

```json
{ "expectedVersion": 1 }
```

`"1"`、true、null 不會自動轉換。版本必須是正安全整數；若傳入很大但仍安全的整數，schema 可以接受，再由 Service 比對目前版本。

不要把資料庫 version 的 2147483647 上限直接加成輸入驗證上限，否則某些原本回 409 VERSION_CONFLICT 的請求會變成 400。當資料列本身已達版本上限時，Service 維持 409 VERSION_LIMIT。

### 為什麼不用一律 coerce？

Number('') 是 0、Number(true) 是 1；Boolean('false') 也不是你直覺想像的 false。Zod 的 coerce 以 JavaScript 轉換規則為基礎，是否接受這些輸入必須由契約決定。[Zod schema 說明](https://zod.dev/api)

本章只轉換契約允許的 query，body 數字維持原型別要求。不要把「能轉成功」等同於「使用者送了合法格式」。

### ID 也不應任意換成內建數字／UUID Pipe

本課 ID 是不透明的非空字串，包含 a_demo 這類 seed ID。因此 Param 使用 idSchema，不改成 ParseIntPipe 或 ParseUUIDPipe。換驗證工具仍必須保留既有 ID 接受範圍。

## 8. 白名單：拒絕、剝除與保留是三個決策

假設建立草稿收到：

```json
{ "title": "x", "content": "y", "authorId": "u_other" }
```

本課使用 strictObject，整個請求回 400。它不會偷偷移除 authorId 後建立文章，也不會把 authorId 傳進 Service。

strictObject 檢查的是 JSON 解析後的物件，並不偵測原始文字中的重複 key。例如同一物件寫兩次 title，現有 JSON parser 只留下最後一個值，再交給 schema；這與重複 query 被解析成陣列後遭拒不同。本課沒有宣告「拒絕重複 JSON key」的傳輸契約，若未來需要，必須在解析階段另外處理。

| 策略 | 遇到未知欄位的結果 | 適合本課目前契約？ |
|------|--------------------|--------------------|
| 拒絕 | 400，呼叫端修正輸入 | 是 |
| 剝除 | 繼續執行，只留下允許欄位 | 會改變原有失敗語意 |
| 保留 | 額外欄位仍存在 | 不符合輸入白名單 |

驗證需針對整份物件，才能發現額外欄位。Controller、Service 與 Repository 也不應直接把整份 request body 展開成資料庫更新內容。

### 與 Nest ValidationPipe 的對照

本章使用 schema 型別與自訂 Zod Pipe。另一種常見做法是 class DTO 搭配 class-validator／class-transformer 及 Nest ValidationPipe，依 metadata 找到 class 的驗證規則。

ValidationPipe 的 whitelist 可剝除未宣告驗證規則的欄位；配合 forbidNonWhitelisted 才會拒絕。transform 控制轉換，而 skipMissingProperties 會略過 null／undefined，不能直接當作本課 PATCH 的同義設定。[官方 ValidationPipe 文件](https://docs.nestjs.com/techniques/validation)

本章沒有安裝這兩個套件，也沒有開啟兩套驗證器。若要改用 class 方案，需要固定相容版本、設計錯誤映射，再用本課契約檢查 trim、Unicode、null、版本與未知欄位行為，不能只替換裝飾器就宣稱完全相同。

## 9. optional、nullable 與空字串

先分清四種資料：

```json
{}
```

```json
{ "title": null }
```

```json
{ "title": "" }
```

```json
{ "title": "新標題" }
```

第一個沒有 title。第二個明確提供 null。第三個是存在但空的字串。第四個才是有效內容。

JSON 沒有 undefined 值；JavaScript 物件可以有 `title: undefined`，但 JSON.stringify 通常會省略該物件屬性。討論 HTTP PATCH 時，要分清程式內部物件與實際傳送的 JSON。

### 本課文章的規則

| 輸入 | 建立文章 title | PATCH title |
|------|----------------|-------------|
| 省略 | 400，必要欄位 | 保留舊 title；仍須有另一個修改欄位 |
| null | 400 | 400 |
| 空字串 | 400 | 400 |
| 全空白 | trim 後 400 | trim 後 400 |
| 合法字串 | trim 後使用 | trim 後更新 |

optional 允許缺少／undefined，不自動允許 null；nullable 則表示允許 null。是否能把 null 解讀成「清空欄位」，必須由應用規格與資料模型明確決定。

### 獨立 nullable 實驗

validation lab 使用一個不屬於文章 API 的 nickname：

```ts
const nicknameSchema = z.strictObject({
  nickname: z.string().trim().min(1).nullable().optional(),
});
```

實驗回傳 data 與 hasNickname，讓你看見省略和 null 不是同一件事：

```text
{}                    → hasNickname: false
{ nickname: null }    → hasNickname: true，值是 null
{ nickname: " 小明 " } → hasNickname: true，值是 "小明"
{ nickname: "" }      → 400
```

這只是表示輸入意圖，沒有真的修改使用者資料，也沒有改變文章 title／content 拒絕 null 的契約。

## 10. PATCH 不能只寫 Partial<CreateArticleDto>

Partial 是 TypeScript 工具型別；不會新增執行期驗證。而且本課 PATCH 除了部分欄位可選，還有兩項要求：expectedVersion 必填，title／content 至少提供一項。

原 patchSchema 相當於：

```ts
const examplePatchSchema = z.strictObject({
  title: draftSchema.shape.title.optional(),
  content: draftSchema.shape.content.optional(),
  expectedVersion: versionSchema.shape.expectedVersion,
}).refine(value => value.title !== undefined || value.content !== undefined);
```

DTO 不會幫未提供的 title 補上空字串，也不會先讀文章再把所有欄位合成一份完整更新。Service 仍只傳遞有提供的欄位，並在交易中檢查版本與狀態。

```text
PATCH { content: "新內容", expectedVersion: 1 }
  → DTO 不包含 title
  → Service 只修改 content
  → UPDATE 比對 id＋version＋status
  → title 保留，version 增加
```

以下都應拒絕：

- 只有 expectedVersion：沒有修改欄位。
- 只有 title：缺版本要求。
- title: null：不支援清空。
- expectedVersion: "1"：不支援字串版本。
- status: "published"：狀態轉換要走 publish，不是任意 PATCH。

Pipe 驗證資料形狀，交易檢查目前資料狀態；兩者缺一不可。輸入驗證通過後仍可能因另一個請求先更新而回 409。

## 11. 錯誤回應與可觀察證據

schema 驗證失敗維持原回應：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "輸入驗證失敗",
    "details": [
      { "field": "body.title", "code": "INVALID_VALUE", "message": "欄位格式或內容不符合規則" }
    ]
  },
  "requestId": "與 X-Request-ID 相同"
}
```

未知欄位使用 UNKNOWN_FIELDS，field 是 body 或 query；不回傳原始 body、未知欄位名稱、值或完整 ZodError。nested schema 的合法欄位路徑則可組成 params.nested.count 這類位置資訊。

輸入失敗的實際 trace 會有 json:parsed 與 nest:filter，但沒有 nest:controller；Service mock 的呼叫次數也是零。這兩份證據一起確認 Pipe 真正位於 handler 之前，而不只是把 Controller 裡的 helper 換個名字。

正常請求仍使用原工作追蹤。慢速 body 之後才登記的寫入、客戶端離線、下載中斷與關檔，繼續由第 16 章完整 Nest 測試驗證。

## 12. Docker 操作與成功／失敗案例

本章使用主機 API **3017**、開發 PostgreSQL **15417**；測試資料庫不公開端口。依賴與 lockfile 節點沿用第 16 章，Compose 專案與 volume 獨立。

```bash
cd nodejs-course/examples/17
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose up -d api
```

check 會依序 generate、型別檢查、Jest、build、程序驗證與三個實驗。不要把 npm test 與 test:runtime 並行；前者會清除後者需要的 `.test-dist`。

### 查詢與預設值

```bash
curl -i 'http://127.0.0.1:3017/api/articles?page=2&pageSize=1'
curl -i 'http://127.0.0.1:3017/api/articles?page=1e2'
curl -i 'http://127.0.0.1:3017/api/articles?page=1&page=2'
curl -i 'http://127.0.0.1:3017/api/articles?page='
```

依序為 200、400、400、400。第一個回應 meta 中 page 與 pageSize 是數字；其餘應包含 query 的錯誤欄位。

### 建立與未知欄位

```bash
curl -i -X POST http://127.0.0.1:3017/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":" Pipe 草稿 ","content":" 本文 "}'

curl -i -X POST http://127.0.0.1:3017/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"x","content":"y","authorId":"u_other"}'
```

前者回 201、修剪後內容與管理 Location；後者回 400 UNKNOWN_FIELDS 細項，不建立文章。

### 局部更新

用剛建立的 id 替換 ID_FROM_RESPONSE：

```bash
curl -i -X PATCH http://127.0.0.1:3017/api/articles/ID_FROM_RESPONSE \
  -H 'Content-Type: application/json' \
  --data '{"content":" 新內容 ","expectedVersion":1}'

curl -i -X PATCH http://127.0.0.1:3017/api/articles/ID_FROM_RESPONSE \
  -H 'Content-Type: application/json' \
  --data '{"title":null,"expectedVersion":2}'

curl -i -X PATCH http://127.0.0.1:3017/api/articles/ID_FROM_RESPONSE \
  -H 'Content-Type: application/json' \
  --data '{"title":"新標題","expectedVersion":"2"}'
```

依序為 200、400、400。第一次只改 content 並把版本升為 2；後兩次不修改資料。若再次使用版本 1 做合法更新，應回 409，而不是驗證錯誤。

### 實驗、匯出與停止

```bash
docker compose run --rm tools npm run lab:validation
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3017/api/articles/export -o /tmp/chapter-17-articles.ndjson
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

NDJSON 仍為獨立教學檔，與資料庫文章不自動同步。stop 保留開發資料 volume；不要以 down -v 作一般停止。

## 13. 測試如何證明本章改變？

完整 Jest 共 204 項：前章 160 項加本章 44 項。原 32 項 HTTP 契約函式逐位元保留，Service／Repository／schema／migration 與傳輸 helper 都不因 Pipe 重構而改規則。

| 測試 | 新增案例 | 證據 |
|------|----------|------|
| pipes.test.ts | 30 | schema 輸出、數字格式、來源欄位、安全錯誤、PATCH、省略／null、版本與 Unicode |
| validation-http.test.ts | 10 | 正式模組的 Pipe 綁定、handler 前拒絕、傳給 Service 的實際參數、原 query 接受範圍 |
| validation-lab.test.ts | 4 | class metadata 不等於驗證、raw 值未覆寫、數字預設值與 nullable 實驗 |

另有 lab:validation 以真實監聽端口重跑實驗。原有資料庫、32 項基準、31 項 HTTP／匯出傳輸與程序信號測試都在完整 check 中執行。

```bash
docker compose run --rm tools npm test -- --testPathPatterns='(pipes|validation-http|validation-lab).test.js'
docker compose run --rm tools npm run test:baseline
```

單獨執行測試前先 generate 並啟動 test-db。資料庫 fixture 僅接受 TEST_DATABASE_URL 的 course_test，以隨機 schema 隔離與清理，不使用開發 public。

## 14. 練習與驗收

### 練習一：移除 Pipe，觀察型別是否保護你

在自己的副本，把 checked 實驗的 `@Body(new ZodValidationPipe(...))` 改成 `@Body()`，保留 DTO 型別，再送 title: 123。

驗收：編譯可以通過，但執行期資料不再受驗證；恢復 Pipe 後測試重新通過。說明 class、type alias 與 schema 各自在什麼時候存在。

### 練習二：區分轉型與原始輸入

送 `page=0002`、`page=1e2`、空字串與重複參數。對照 schema 的先後順序，並觀察 lab 的 data 與 raw。

驗收：前置零依舊有契約接受，其餘不被寬鬆 Number() 掩蓋；不能只用 `as number` 當作轉型。

### 練習三：設計一個 nullable 欄位

只在獨立 lab 新增 description 規則，明確決定省略、null、空字串、空白字串各代表什麼。

驗收：至少測五種輸入，使用欄位是否存在來區分「不修改」與「清空」。不要直接把文章 title 改成 nullable。

### 練習四：檢查 PATCH 失敗不會寫入

以真實資料庫 fixture 建立文章，送只有版本、null title、未知 status 與舊版本。每次失敗後重新讀取管理端點。

驗收：輸入錯誤回 400，合法但舊版本回 409；文章欄位與版本維持不變。沿用 migration-contract 的測試模式，不清理開發資料庫。

### 練習五：定位驗證發生的位置

閱讀 validation-http.test.ts，指出 json:parsed、nest:filter、缺少 nest:controller 與 Service 零呼叫各能證明什麼。

驗收：能區分 parser 失敗、Pipe 失敗與 Service 業務衝突，並說明單純直接呼叫 Controller 方法為什麼不會自動執行裝飾器的 Pipe。

### 本章完成檢查

- [ ] DTO 型別與執行期 schema 來源一致，但沒有把型別當成驗證。
- [ ] Controller 使用 Pipe 回傳的 DTO，沒有重新讀 raw body 作業務輸入。
- [ ] query 轉型、預設值、未知欄位與重複參數符合原契約。
- [ ] PATCH 保留 expectedVersion、至少一個修改欄位與 null 拒絕規則。
- [ ] Pipe 拒絕時不執行 Controller／Service，錯誤格式仍一致。
- [ ] 原基準、資料庫、傳輸及關閉競態測試均通過。
- [ ] 已執行 Docker check、migration、seed、API 操作與驗證實驗。

下一章 [18 — 密碼雜湊、Cookie／Session、Guard 與資料權限](18-authentication-sessions-and-guards.md)：加入登入、Session、Guard、角色與擁有者權限，明確擴充目前固定作者的 API 契約。

---

[上一章：功能模組與依賴邊界](16-modules-boundaries-and-dependencies.md) · [返回課程總覽](README.md) · [本章範例](examples/17/README.md) · [本章契約](examples/17/BASELINE.md)
