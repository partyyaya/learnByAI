# 09 — Middleware 順序、next 與輸入驗證

> 把請求經過的步驟排清楚：解析成功不等於驗證成功，驗證成功也不等於符合業務規則。

08 章已用 Express 完成記憶體文章 API。本章沿用同一份功能，將欄位檢查整理成 schema，再透過執行紀錄觀察請求在哪一步繼續、在哪一步停止。

完成本章後，你應能：

- 解釋 app、Router 與路由 middleware 的執行順序。
- 分清 `next()`、`next(error)`、結束回應與 JavaScript 的 `return`。
- 說明 JSON parser、輸入 schema、業務規則各自的責任。
- 拒絕額外欄位，明確處理部分更新、null、預設值與數字轉型。
- 使用驗證後的資料，並以 request ID 對照成功與失敗的執行紀錄。

前置：[08 章](08-express-routing-and-http-contracts.md)。本章新增 **Zod 4.6.7**，沿用 Express 5.3.0、Node 24.22.1 與既有工具版本，全部寫入 package.json／lockfile。

仍使用固定作者 `u_demo` 與程序內 Map，寫入及管理端點只供本機教學；登入授權、資料庫與正式日誌設計留在後續章節。

## 09.1 先看到一個請求經過哪些步驟

建立文章時，完整路線是：

```text
收到請求，產生 request ID
    ↓
確認服務仍接受工作
    ↓
進入文章 Router
    ↓
檢查媒體類型、讀取並解析 JSON
    ↓
驗證欄位，取得標準化後的資料
    ↓
執行文章操作
    ↓
送出回應，記錄這次請求的步驟
```

如果 JSON 語法不合法，流程不會走到欄位驗證。如果欄位驗證失敗，則不會走到文章寫入。這些不是靠文件約定而已：範例會記錄步驟，測試會確認 handler 沒有被執行，資料也沒有變動。

本章新增的主要檔案：

| 檔案 | 責任 |
|------|------|
| [schemas.ts](examples/09/src/schemas.ts) | 草稿、PATCH、版本、ID 與分頁的輸入規格 |
| [validation.ts](examples/09/src/validation.ts) | 把 schema 接成 middleware，產生驗證結果或欄位錯誤 |
| [request-context.ts](examples/09/src/request-context.ts) | request ID、每次請求獨立的步驟紀錄、finish／close 觀察 |
| [json-body.ts](examples/09/src/json-body.ts) | 沿用大小、編碼與等待上限，解析 JSON |
| [middleware-lab.ts](examples/09/src/middleware-lab.ts) | 用小型服務觀察 next、短路與錯誤路徑 |
| [middleware.test.ts](examples/09/test/middleware.test.ts) | 驗證順序、輸入邊界與 request ID 隔離 |

完整路由仍在 [server.ts](examples/09/src/server.ts)，文章狀態與版本規則仍在 [articles.ts](examples/09/src/articles.ts)。

## 09.2 安裝、啟動與觀察紀錄

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/09
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run lab
docker compose up api
```

主機連接埠為 **3009**，容器內仍為 3000。另一個終端機執行：

```bash
curl -i http://127.0.0.1:3009/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"  認識 middleware  ","content":"  先驗證再寫入。  "}'
```

應回 201，標題與內容已去除首尾空白。伺服器終端機會出現一筆 `REQUEST_TRACE`；若使用背景啟動，可用 `docker compose logs api` 查看。

紀錄中的 steps 應為：

```json
[
  "request",
  "accept",
  "router:articles",
  "json:start",
  "json:parsed",
  "validate:body",
  "handler:create",
  "response:finish"
]
```

`REQUEST_TRACE` 也包含 requestId、outcome 與已送出標頭時的 status；可以和回應的 `X-Request-ID` 對照。它是本章的教學觀察工具，沒有記錄 body、Cookie 或完整 URL。

本機路線使用 `.nvmrc` 的 Node 與 npm 11.19.1，執行 `npm ci`、`npm run check`、`npm run lab`、`npm start`；預設連接埠 3000。信號檢查建議使用 Linux Docker。修改原始碼後須重新建置再啟動。

## 09.3 Middleware 是函式，也是一個控制流程的決定

最常見形式：

```ts
app.use((req, res, next) => {
  // 做一件共通工作。
  next();
});
```

Express 依註冊順序尋找下一個匹配的處理函式。middleware 可以處理資料、完成回應，或交給下一個函式；如果既沒有回應也沒有繼續，請求就可能停在這裡。[Express middleware 文件](https://expressjs.com/en/guide/using-middleware/)

| 寫法 | 意義 |
|------|------|
| `next()` | 繼續匹配一般處理流程 |
| `next(error)` | 轉往錯誤處理，跳過後面的普通 handler |
| `res.status(...).json(...)` | 送出這次回應；不會自動替你 return |
| `return` | 結束目前 JavaScript 函式；本身不送回應，也不呼叫 next |
| `return next(error)` | 交出錯誤後離開目前函式，避免繼續往下做 |

例如，拒絕請求後就不要繼續執行業務：

```ts
if (!allowed) {
  res.status(403).json({ error: 'forbidden' });
  return;
}
next();
```

這是控制流程示意，不是本章已加入的登入授權。不要在送出回應後無條件 `next()`，否則後面的 handler 可能嘗試再送一次回應。

Express 也有 `next('route')`／`next('router')` 等跳過機制；本章先掌握普通繼續、拒絕與錯誤路徑，不用特殊跳轉來代替清楚的路由設計。

## 09.4 next 後面的程式不代表「全部做完了」

下面的想法很容易出錯：

```ts
app.use((_req, _res, next) => {
  console.log('開始');
  next();
  console.log('結束'); // 只表示 next 呼叫返回，不能代表非同步 handler 已完成。
});
```

執行實驗：

```bash
docker compose run --rm tools npm run lab
```

`async` 情境的結果是：

```text
before next
handler start
after next
handler end
response finish
```

handler 遇到 `await` 時先讓出執行權，因此外層 next 後面的程式先繼續。寫成 `await next()` 也不會把 Express 變成等待下游完成的機制。

另外兩個情境會看到：

| 實驗 | 主要觀察 |
|------|----------|
| stop | 第一個路由 handler 直接回應並 return，後面的 handler 不執行 |
| error | `next(error)` 進入四參數錯誤 middleware，普通 handler 不執行 |

兩個情境中，外層 middleware 的 `after next` 仍會執行。這提醒我們：「停止往下一個 handler 走」和「外層函式停止執行」不是同一件事。

真正要觀察回應完成時，範例使用 `res.once('finish', ...)`；若尚未 finish 就 close，則記錄 interrupted。finish 只代表資料交給底層傳送，不代表遠端已保存內容，也不代表所有應用資源都已清理；07 章的 handler 清理追蹤仍有它的責任。

## 09.5 app、Router 與路由內的順序

本章將共通工作依需要放到不同範圍：

| 註冊位置 | 本章工作 |
|----------|----------|
| `app.use(requestContext(...))` | 先產生 request ID，建立這次請求的紀錄 |
| 後面的 app middleware | 檢查是否正在關閉 |
| `router.use(...)` | 記錄已進入文章 Router |
| POST／PATCH 的 handler 陣列 | 讀取 body、驗證、文章操作 |
| GET 列表的 handler 陣列 | 驗證 query、查詢 |
| 所有路由之後 | 404 收尾，再由錯誤 middleware 統一回應 |

建立路由的核心結構如下；此處省略步驟標記與型別註記：

```ts
router.post('/',
  body,
  validate(draftSchema, 'body'),
  (_req, res) => {
    const article = articles.create(res.locals.body);
    res.location(`/api/me/articles/${article.id}`)
      .status(201).json({ data: article });
  },
);
```

`body` 是 middleware 陣列，包含開始標記、JSON parser 與成功標記；Express 支援在 handler 清單內使用陣列。

為什麼不能任意交換？

- **schema 放在 parser 前面**：尚未解析就讀 req.body，合法請求也可能被拒絕。
- **寫入放在 schema 前面**：驗證失敗時資料可能早已改動。
- **request ID 放在 parser 後面**：非法 JSON 可能在取得 ID 前就離開一般流程。
- **404 放在 Router 前面**：請求先被收尾，後面的正常路由沒有機會處理。

本章把 body parser 放在實際需要 body 的 POST／PATCH 路由，不會讓未知路徑先解析 body。錯誤方法仍走 405，未知路徑走 404；這是沿用 08 章的選擇，而不是每個 Express 專案都必須如此。

## 09.6 三種檢查，回答三種問題

| 層次 | 問題 | 例子 |
|------|------|------|
| body 讀取與 JSON parser | 格式與傳輸是否可接受？ | 415 媒體類型、413 過大、408 逾時、400 非法 JSON |
| 輸入 schema | 這份資料是否符合此操作的輸入規格？ | title 是字串、版本是正整數、不接受 authorId |
| 文章操作 | 根據目前資料，現在能不能做？ | 找不到文章 404、版本衝突 409、封存後不可編輯 |

例如 `{"title":"新標題","expectedVersion":99}` 的形狀可能完全合法，但資料裡的文章仍是版本 1。schema 應該讓它通過，再由文章操作回 `409 VERSION_CONFLICT`。

不要把所有失敗都改成 400，也不要在 schema 裡塞入讀資料庫、查登入者與執行狀態轉換。這一章只使用同步 schema；日後若使用非同步 refinement，呼叫方式與錯誤責任也要一起調整。

沿用 08 章的 strict JSON parser：整份 body 為 `null` 會在 parser 被拒絕，回 INVALID_JSON；`{"title":null,"content":"內容"}` 則能通過 parser，再由 Zod 回 VALIDATION_ERROR。兩者都是 400，但失敗步驟不同；不要把所有 null 都當成相同的輸入位置。

## 09.7 用 schema 固定建立、修改與狀態操作的規格

Zod 可以將執行期規格與 TypeScript 推導型別放在同一個定義中。`safeParse()` 成功時提供驗證後的 data，失敗時提供 issues；本章用它決定繼續還是交出錯誤。[Zod 基本用法](https://zod.dev/basics)

草稿規格的形狀：

```ts
export const draftSchema = z.strictObject({ title, content });
export type DraftInput = z.output<typeof draftSchema>;
```

`title`、`content` 是 [schemas.ts](examples/09/src/schemas.ts) 中定義的字串規則：先確認是字串，再 trim，最後檢查 1–120／1–4000 個 Unicode code point。程式明確使用 `[...value].length`，與 08 章保持一致；body 的 16 KiB 限制則由 parser 負責。

### 額外欄位：拒絕與忽略是不同契約

Zod 的一般 object schema 預設會移除不認識的欄位；`strictObject` 則拒絕它們。本課要求傳入 authorId、status、role 等非允許欄位時回 400，所以選擇 strictObject。[Zod object 規格](https://zod.dev/api#objects)

```json
{"title":"文章","content":"內容","authorId":"u_other"}
```

這份輸入不應悄悄成功。作者仍由伺服器設定，不能由用戶任意指定；拒絕也能讓呼叫端及早發現欄位用錯。

### PATCH 不是把整份建立規格都變成 optional

本章明確寫出：

```ts
export const patchSchema = z.strictObject({
  title: title.optional(),
  content: content.optional(),
  expectedVersion,
}).refine(value => value.title !== undefined || value.content !== undefined);
```

此片段省略錯誤訊息。expectedVersion 仍必填，而且 title／content 至少要有一個。

| 輸入 | 結果 |
|------|------|
| 缺少 content，但有合法 title 與 expectedVersion | 只改 title，保留 content |
| `content: null` | 拒絕，optional 不等於 nullable |
| `title: "   "` | trim 後為空，拒絕 |
| 只有 expectedVersion | 拒絕，沒有要修改的欄位 |
| `expectedVersion: "1"` | 拒絕，JSON body 要求數字 |
| publish body 帶 title | 拒絕，狀態操作只接受 expectedVersion |

不要為 PATCH 欄位加入空字串預設值，否則「沒有提供」可能被變成「覆蓋原值」。

## 09.8 query 轉型要保留輸入規則

query 原本就是文字；body 的 JSON 數字則已經是數字，因此兩者採用不同策略。

分頁規格依序做：

```text
確認是單一字串 → 只接受十進位數字 → 轉 Number → 安全整數與範圍檢查
```

在完全未提供參數時，page 預設 1、pageSize 預設 20；pageSize 上限 100。範例另外保留既有的 page 上限 1000000。

| 輸入 | 本章結果 |
|------|----------|
| `?page=2` | 轉為數字 2 |
| 沒有 page | 使用預設 1 |
| `?page=` | 拒絕，不把空字串視為未提供 |
| `?page=1&page=2` | 拒絕，不挑其中一個值 |
| `?page=1e2`、`?page=0x10` | 拒絕，不接受其他數字表示法 |
| `?page=1.5`、`?page=0` | 拒絕，不是允許的正整數 |
| `?authorId=x` | 拒絕，分頁規格沒有此欄位 |

直接用 `Number(...)` 或寬鬆的 coercion 容易接受原本不打算支援的值，例如空字串或指數表示法。因此本課先檢查原始格式，再轉型。

Express 的 query 內容來自用戶輸入，形狀與解析器設定有關；本章明確設定 simple parser，並在每次查詢前驗證。[Express query 文件](https://expressjs.com/en/5x/api/request/)

## 09.9 驗證後，應該用哪一份資料？

validation middleware 的核心邏輯是：

```ts
const result = schema.safeParse(req[source]);
if (!result.success) {
  return next(new HttpError(400, 'VALIDATION_ERROR', '輸入驗證失敗', details));
}
res.locals[source] = result.data;
next();
```

這是摘錄式示意；完整 details 轉換見 [validation.ts](examples/09/src/validation.ts)。

不要驗證通過後又使用原始 req.body。schema 可能已經 trim 字串或將 query 轉成數字，真正要交給文章操作的是 `result.data`。

本章將結果放進這次回應獨立的 `res.locals.body`／`query`／`params`，保留原始輸入。handler 中的 `as DraftInput` 是局部型別斷言：它依賴前面已註冊對應的驗證 middleware，**斷言本身不會驗證資料，也不會讓錯誤的 middleware 順序變正確**。

Express 的型別系統不會自動證明「前一個 middleware 已寫入這個欄位」，所以本章用清楚的路由順序與整合測試支撐這個前提。後續做型別封裝時，也要保留執行期的驗證邊界。

文章操作函式現在接受已驗證的型別；它們仍負責找資料、檢查版本與狀態。若未來新增背景工作、CLI 或其他入口，也必須驗證那個入口的外部資料，不能直接強制轉型後呼叫。

## 09.10 用錯誤欄位與 request ID 找到失敗位置

用這個請求觀察 schema 失敗：

```bash
curl -i http://127.0.0.1:3009/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":123,"content":"內容"}'
```

回應結構如下，requestId 每次不同：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "輸入驗證失敗",
    "details": [
      {"field":"body.title","code":"INVALID_VALUE","message":"欄位格式或內容不符合規則"}
    ]
  },
  "requestId": "伺服器產生的ID"
}
```

本章將 08 章原本空的 details 擴充為欄位線索；HTTP 狀態與最上層錯誤 code 保留。未知欄位回 `UNKNOWN_FIELDS`，field 指向所屬物件，例如 body；不直接回傳原始值、完整 ZodError 或未知欄位清單。schema 內的細部訊息可供開發時閱讀，HTTP 對外訊息由 validation middleware 統一整理。

這次 steps 會經過 `json:parsed`、`validate:body`、`error:VALIDATION_ERROR`，不會有 `handler:create`。再把 body 改成單獨的 `{`，會得到 `INVALID_JSON`，連 `validate:body` 都不會執行。

### Request ID 與完成紀錄的界線

- 服務自行產生 ID，放入回應標頭與錯誤 body；外部傳入的同名標頭不直接沿用。
- 每個請求的 steps 都是獨立陣列，避免並行請求混在一起。
- finish 與提前 close 只記錄其中一種結果，完成後移除自己的另一個 listener。
- steps 只記錄執行到的位置，不代表資料已持久化，也不代表遠端完整收到回應。

這份 middleware 紀錄涵蓋已進入 Express 的請求。08 章保留的非法 URL 檢查在 Express 之前，仍回應帶 request ID 的 400，但不會產生此 middleware 的 trace；HTTP 層就被拒絕的資料也不在這份紀錄範圍內。

## 09.11 測試如何證明順序正確？

```bash
docker compose run --rm tools npm run check
```

本章保留上一章的 57 項案例，新增 21 項，共 **78 項 Jest 測試**，並繼續執行真實程序的信號檢查。

| 測試 | 驗收重點 |
|------|----------|
| 成功建立 | parser → schema → handler，且保存的是 trim 後的值 |
| 非法 JSON | 不進 schema、不寫入，request ID 一致 |
| schema 失敗 | 有欄位線索、不進 handler、不洩漏原始內容 |
| 不支援媒體類型 | 保留 415，不被誤報成欄位錯誤 |
| 同時送兩個請求 | ID 與 steps 不共用 |
| query 邊界 | 空字串、指數、十六進位、不安全整數等被拒絕 |
| Unicode 長度 | 120 個 emoji 可接受，121 個拒絕 |
| 狀態操作額外欄位 | 拒絕且不增加文章版本 |
| 合法輸入但舊版本 | schema 通過後仍回業務衝突 409 |
| next 實驗 | 非同步順序、直接回應、錯誤分流符合預期 |

測試不只比較回傳碼，也驗證執行路徑與資料結果。既有測試持續涵蓋 body 逾時、大小限制、下載中斷、檔案清理與程序停止，避免重構驗證時破壞前面章節的功能。

## 09.12 常見問題、練習與驗收

| 現象 | 優先檢查 |
|------|----------|
| middleware 印出訊息後請求卡住 | 是否忘記回應或呼叫 next？ |
| after next 太早出現 | 是否誤把 next 當成等待下游完成？ |
| 合法 body 也驗證失敗 | parser 是否在 schema 之前？Content-Type 是否正確？ |
| 傳 authorId 卻成功 | 是否使用會移除未知欄位的一般 object schema？ |
| trim 後結果沒保存 | handler 是否又讀回原始 req.body？ |
| 未提供 PATCH 欄位卻清空舊值 | 是否加入了不適合部分更新的預設值？ |
| 驗證過的資料仍收到 409 | 版本與狀態檢查是否按預期拒絕目前操作？ |

### 練習一：先預測，再查紀錄

分別送出合法建立、非法 JSON、title 為 null、額外 role 四種請求。先寫下預期最後到達的步驟，再對照 REQUEST_TRACE。失敗後查管理列表，確認沒有新增文章。

### 練習二：交換 middleware 順序

暫時把 preview 路由的 schema 放到 body parser 前面，重新建置後送合法 JSON，觀察它為什麼失敗。完成後恢復原順序，再執行 `npm run check`。

### 練習三：輸入正確為何仍不能修改？

對 a_1 送出合法的 PATCH，但使用 expectedVersion 99。觀察紀錄確實進入 handler，再說明為什麼 schema 不應提前把這個值當成格式錯誤。

<details>
<summary>參考答案</summary>

99 是合法的正安全整數；它是否等於目前文章版本，必須查看資料。這屬於文章操作的狀態判斷，應回 409 VERSION_CONFLICT，而不是 400 VALIDATION_ERROR。

</details>

### 本章完成檢查

- [ ] 能畫出成功、JSON 失敗與 schema 失敗的請求流程。
- [ ] 能說明 next、next(error)、return 與完成回應的差別。
- [ ] 已執行 lab，知道 next 後面的程式不是完成通知。
- [ ] 能拒絕未知欄位，區分 optional、null、空值與 PATCH 缺省欄位。
- [ ] query 先驗證格式再轉型，handler 使用 schema 輸出。
- [ ] 能以 request ID 對照紀錄，並通過 `npm run check`。

下一章：[錯誤處理與 HTTP 契約測試](10-error-handling-and-api-tests.md)，會進一步整理同步／非同步錯誤來源、錯誤 middleware 與 Supertest 契約測試。

---

[上一章：Express 路由](08-express-routing-and-http-contracts.md) · [返回課程總覽](README.md) · [本章範例](examples/09/README.md)
