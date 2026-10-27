# 08 — Express 路由與 HTTP 契約

> 用 Express 接手重複的 HTTP 工作，並把文章操作寫成呼叫端可以驗證的契約。

05–07 章已經親手處理 method、URL、body、回應與程序關閉。本章開始第二階段：以 Express 組合這些能力，再加入記憶體文章的建立、讀取、修改、發佈與封存。

完成本章後，你應能：

- 說明 Express app、Router 與 Node HTTP server 的關係。
- 分清 params、query、body 與 headers 的用途。
- 使用 GET／POST／PATCH 路由，以及明確的成功與失敗回應。
- 建立草稿，依版本修改、發佈與封存，並確認公開列表的可見範圍。
- 理解記憶體資料的生命週期，保留下一階段遷移與測試的基準。

前置：[07 章](07-process-signals-and-graceful-shutdown.md)。本章固定 **Express 5.3.0**、`@types/express` **5.0.6**，沿用 Node 24.22.1、npm 11.19.1、TypeScript 5.9.3 與 Jest 30.2.0。套件版本與相依樹已寫入 package.json／lockfile，讀者直接執行 `npm ci`。

## 08.1 這一章實作到哪裡？

本章開始真正修改文章資料，但保存位置先是程序內的 `Map`。

| 項目 | 本章範圍 |
|------|----------|
| 文章建立與修改 | 寫入本服務實例的記憶體；重啟後重置 |
| 文章狀態 | draft → published／archived；封存後不可再編輯或發佈 |
| 文章移除 | 沿用 00 章的封存，不新增永久 DELETE 端點 |
| 作者 | 伺服器固定為 `u_demo`，用戶不能從 body 指定 |
| `/api/me/articles` | 本機示範作者的管理查詢，尚未驗證登入身分 |
| 認證、角色、留言、資料庫 | 後續章節加入 |
| 預覽與檔案匯出 | 保留 05–06 章的實驗功能 |
| 停止服務 | 沿用 07 章的排空與等待期限 |

**本章的寫入與管理端點尚未加登入授權，只供本機教學。** `/me` 現在不代表真正的 Session，也不是安全邊界；它讓 00 章的 URL 契約先有可操作的示範。18 章才改由可信的登入結果決定作者與權限，加入 401／403 等案例。

本章不是一次實作完最終專題。重點是先把路由、輸入與可觀察的結果連起來；09 章深化 middleware 與驗證，10 章深化錯誤與 HTTP 測試，11 章再持久化。

## 08.2 Express 幫我們做了什麼？

原生 HTTP 裡，我們自己比較方法與路徑：

```ts
if (req.method === 'GET' && path === '/api/articles') {
  // 查資料、組 JSON、設定標頭、結束回應。
}
```

Express 可以把這個分支寫成一條路由：

```ts
app.get('/api/articles', (req, res) => {
  res.json(articles.list(req.query, true));
});
```

這裡 `articles` 是本章的記憶體文章操作物件。Express 負責匹配路由及提供回應方法；哪些文章能公開、何時發生版本衝突，仍是我們自己的規則。

| 元件 | 責任 |
|------|------|
| `express()` 建立的 app | 組合 middleware 與路由，接收 Node 交來的請求 |
| `Router()` | 將一組相關路徑放在一起，再掛到共同前綴 |
| `http.createServer(app)` | 建立實際監聽連線的 Node HTTP server |
| `server.listen(...)` | 開始監聽 |
| `server.lifecycle.shutdown()` | 本課自行加入的關閉協調器；不是 Express 內建 API |

Express 的 request／response 是對 Node 物件的擴充，因此串流與 HTTP 生命週期觀念仍然適用。[Express request 文件](https://expressjs.com/en/5x/api/request/)、[response 文件](https://expressjs.com/en/5x/api/response/)

最小用法常是 `http.createServer(app)`。完整範例在交給 app 前加了一層非法 URL 檢查，保留 05 章的 400 契約；此外保留 server 的控制權，方便沿用 07 章的關閉流程。

## 08.3 安裝與啟動

完整範例：[examples/08](examples/08/README.md)。從倉庫根目錄執行：

```bash
cd nodejs-course/examples/08
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose up api
```

另一個終端機：

```bash
curl -i http://127.0.0.1:3008/health/live
curl -i 'http://127.0.0.1:3008/api/articles?page=1&pageSize=20'
```

主機連接埠為 **3008**，容器內仍是 3000。初始公開文章是 `a_1`、`a_2`，另有一篇 `a_draft`；公開列表只能看到兩篇。

本機路線使用同版 Node／npm，執行 `npm ci`、`npm run check`、`npm start`，預設連接埠 3000。停止 Docker 服務可在另一個終端機執行 `docker compose stop api`。

| 檔案 | 閱讀重點 |
|------|----------|
| [server.ts](examples/08/src/server.ts) | app、Router、方法、狀態碼與錯誤出口 |
| [articles.ts](examples/08/src/articles.ts) | Map、公開範圍、部分更新、版本與狀態規則 |
| [json-body.ts](examples/08/src/json-body.ts) | express.json 與既有大小、編碼、逾時限制 |
| [http.ts](examples/08/src/http.ts) | HttpError 與最小的輸入驗證 |
| [shutdown.ts](examples/08/src/shutdown.ts) | 沿用 07 章的關閉流程 |
| [articles.test.ts](examples/08/test/articles.test.ts) | 從 HTTP 驗證文章操作與失敗結果 |

建議先讀 server 的路由，再追一個 `articles.create()`；不用第一遍就掌握 parser 與所有錯誤轉換細節。

## 08.4 用 Router 組織一組文章路徑

範例把文章路由掛到 `/api/articles`：

```ts
const router = Router({ caseSensitive: true, strict: true });

router.get('/', (req, res) => {
  res.json(articles.list(req.query, true));
});

router.get('/:id', (req, res) => {
  res.json({ data: articles.detail(req.params.id, true) });
});

app.use('/api/articles', router);
```

這是摘錄式用法；完整範例以 `router.route(...).get(...).post(...)` 將同一路徑的多個方法排在一起。

| Router 裡的路徑 | 外部呼叫路徑 |
|----------------|--------------|
| `/` | `/api/articles` |
| `/:id` | `/api/articles/a_1` |
| `/:id/publish` | `/api/articles/a_1/publish` |
| `/preview` | `/api/articles/preview` |

`app.use()` 的前綴已提供 `/api/articles`，不要在 Router 內再寫一遍。query string 不參與路由路徑匹配；`?page=2` 是輸入資料，不是另一條路由。[Express routing 文件](https://expressjs.com/en/guide/routing/)

### 固定路徑先於參數路徑

`/export` 與 `/preview` 先註冊，接著才是 `/:id`。如果先讓 `/:id` 回應，`export` 可能被當成文章 ID，之後的匯出 handler 就不會執行。

同樣地，404 收尾要在全部路由之後；錯誤處理要在它們之後。Express 依註冊順序往下處理，不會自動猜測你認為哪條比較重要。

本章使用普通路徑與命名參數，不需要 wildcard。不要直接搬用 Express 4 的字串模式範例，Express 5 的路徑語法有差異；遇到進階匹配再查對應版本文件。

## 08.5 params、query、body、headers 不要混在一起

以這個請求為例：

```http
PATCH /api/articles/a_1 HTTP/1.1
Content-Type: application/json

{"title":"修訂標題","expectedVersion":1}
```

| 輸入位置 | Express 取得方式 | 本課用途 |
|----------|-----------------|----------|
| path parameter | `req.params.id` | 指定要修改哪篇文章 |
| query | `req.query.page` | 列表分頁 |
| body | `req.body` | 可修改欄位與 expectedVersion |
| header | `req.get('Content-Type')` | 描述 body 的媒體格式 |

這些值仍然是不可信的外部輸入。Express 幫忙解析，不會自動證明某個 ID 存在，也不會把 `page` 保證成數字。[Express request API](https://expressjs.com/en/5x/api/request/)

本章明確使用 simple query parser，再自行驗證：

```text
?page=2                 → 字串 "2"，驗證後轉成數字
?page=1&page=2          → 多個值，拒絕
?pageSize=101           → 超出上限，拒絕
?authorId=u_other       → 非允許參數，拒絕
```

不要用 `parseInt('2abc')` 默默接受非法值，也不要把整份 query 傳進資料查詢。公開列表的 `total` 只計公開文章；自己的管理列表則含固定作者的草稿與封存文章。

## 08.6 JSON parser 與資料驗證是兩道工作

Express 不會憑空讀完 JSON body。一般用法會先放 parser：

```ts
app.use(express.json({ limit: 16 * 1024, inflate: false }));
```

這段是最小示意。`limit` 控制解析大小，`inflate: false` 不接受壓縮 body；parser 處理 JSON 語法，並不驗證文章欄位。[Express JSON parser 文件](https://expressjs.com/en/5x/api/express/#expressjsonoptions)

完整範例把 parser 包成 `jsonBody()`，只放在需要 body 的 POST／PATCH 路由前：

```ts
router.route('/').post(body, (req, res) => {
  const article = articles.create(req.body as unknown);
  res.location(`/api/me/articles/${article.id}`)
    .status(201)
    .json({ data: article });
});
```

此處 `body` 是 `jsonBody(...)` 建立的 middleware。它保留 05 章的限制：JSON／UTF-8、16 KiB 上限、不接受壓縮、讀取逾時與非法 UTF-8 拒絕。用戶中斷或 parser 結束時會清掉自己的 timer。

`req.body as unknown` 不是驗證，它只是讓型別不要掩蓋驗證責任。真正的檢查在 `validateDraft()` 與文章操作函式裡：

- 必須是物件；`null`、陣列與其他形狀拒絕。
- 只接受白名單欄位；不接受 authorId、status、role、version 注入。
- title／content 去除首尾空白後不能為空。
- title 上限 120、content 上限 4000 個 Unicode code point；body bytes 上限是另一項限制。

本章先保留手寫驗證，讓路由與契約可以跑完。09 章再拆解 middleware 順序與 schema 驗證，避免同時引入太多抽象。

## 08.7 先固定方法、路徑與成功狀態

| 方法與路徑 | 行為 | 成功 |
|------------|------|------|
| `GET /api/articles` | 已發佈文章列表 | 200 |
| `GET /api/articles/:id` | 已發佈文章詳情 | 200 |
| `GET /api/me/articles` | 固定示範作者的管理列表 | 200 |
| `GET /api/me/articles/:id` | 固定示範作者的文章，包含非公開狀態 | 200 |
| `POST /api/articles` | 建立草稿 | 201＋Location |
| `PATCH /api/articles/:id` | 修改 title／content；附 expectedVersion | 200 |
| `POST /api/articles/:id/publish` | 草稿發佈；附 expectedVersion | 200 |
| `POST /api/articles/:id/archive` | 草稿或已發佈文章封存；附 expectedVersion | 200 |
| `POST /api/articles/preview` | 驗證並預覽，不新增文章 | 200 |
| `GET /api/articles/export` | 下載獨立的教學 NDJSON 檔案 | 200 |

`GET` 路由同時接受 HEAD：回應中繼資料而沒有 body。Express 在沒有另行定義 HEAD handler 時，可以由對應 GET 路由處理；匯出程式仍會辨識 HEAD，避免讀完整個檔案。[Express 方法路由](https://expressjs.com/en/5x/api/application/#appmethodpath-callback-callback)

### 狀態碼也是契約

| 狀態 | 本章例子 |
|------|----------|
| 200 | 查詢、修改、發佈、封存、預覽成功 |
| 201 | 建立新文章，Location 指向可查詢的管理端點 |
| 400 | 無效 JSON、非法欄位／query／路徑編碼 |
| 404 | 未知路由，或公開端點找不到可見文章 |
| 405 | 已知路由不接受該方法；附 Allow |
| 408／413／415 | body 讀取逾時／過大／格式不支援 |
| 409 | 舊版本或非法狀態轉換 |
| 503 | 關閉中仍經既有連線進到入口的新請求 |

本章沒有永久刪除文章，因此沒有為文章硬加 204。未來留言的 DELETE 可以成功回 204，且不得附 body。

Express 不會替所有已知路徑自動實作本課需要的 405；範例在已支援方法之後加 `.all(methodNotAllowed(...))`。未知路徑則走最後的 404。這讓呼叫端能分辨「資源路徑不認識」與「方法用錯」。

## 08.8 親手走完一篇文章的生命週期

以下在服務啟動後執行。請從建立回應複製真正的 ID；各次啟動與建立的 ID 都可能不同。

### 1. 建立草稿

```bash
curl -i http://127.0.0.1:3008/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"第一篇 Express 文章","content":"先把 HTTP 契約跑通。"}'
```

應收到 201，`data.status` 為 `draft`、`version` 為 1、`authorId` 為 `u_demo`。Location 類似 `/api/me/articles/a_...`，指向管理查詢；草稿還不能從公開端點取得。

在同一個終端機設定變數，把值替換成回應中的 ID：

```bash
ARTICLE_ID='貼上剛建立的文章ID'
curl -i "http://127.0.0.1:3008/api/me/articles/$ARTICLE_ID"
curl -i "http://127.0.0.1:3008/api/articles/$ARTICLE_ID"
```

前者回 200，後者回 404。不要把 `/me` 現階段的成功誤認為已完成登入授權。

### 2. 部分修改

```bash
curl -i -X PATCH "http://127.0.0.1:3008/api/articles/$ARTICLE_ID" \
  -H 'Content-Type: application/json' \
  --data '{"title":"修訂後的標題","expectedVersion":1}'
```

成功後 version 變成 2；沒有提供 content，原內容保留。

| PATCH 輸入 | 語意 |
|------------|------|
| 沒有提供 content | 保留原內容 |
| `content: null` | 非法；本課不接受 null |
| `content: ""` | 非法；內容不能清空 |
| 只有 expectedVersion | 非法；至少修改一個欄位 |
| 直接提供 status | 非法；使用明確的 publish／archive 操作 |

把相同的 PATCH 再送一次，舊的 expectedVersion 1 會得到 `409 VERSION_CONFLICT`。即使想寫入相同文字，也不能省略本課的版本條件。

### 3. 發佈

```bash
curl -i "http://127.0.0.1:3008/api/articles/$ARTICLE_ID/publish" \
  -H 'Content-Type: application/json' \
  --data '{"expectedVersion":2}'
curl -i "http://127.0.0.1:3008/api/articles/$ARTICLE_ID"
```

發佈後 status 為 published、version 為 3，公開詳情可以取得。用 version 3 再發佈一次，會得到 `409 INVALID_STATE`；只有草稿能發佈。

### 4. 封存

```bash
curl -i "http://127.0.0.1:3008/api/articles/$ARTICLE_ID/archive" \
  -H 'Content-Type: application/json' \
  --data '{"expectedVersion":3}'
curl -i "http://127.0.0.1:3008/api/articles/$ARTICLE_ID"
curl -i "http://127.0.0.1:3008/api/me/articles/$ARTICLE_ID"
```

封存後 version 為 4。公開詳情回 404，管理查詢仍可看到 archived；之後的編輯、發佈與再次封存都被拒絕。封存成功會回傳更新後的文章，因此使用 200。

## 08.9 記憶體版本檢查的保證到哪裡？

文章更新遵循以下順序：

```text
驗證輸入 → 找到文章 → 比對 expectedVersion → 檢查狀態 → 更新並增加版本
```

檢查到寫入之間沒有 `await`，因此在這個 Node 程序內，這段同步操作不會被另一個請求 handler 插入。測試會同時送兩個版本 1 的更新，確認只有一個成功，另一個回 409。

這份證據只適用於目前的程序內 Map。它不等於已完成跨程序或資料庫的併發控制：

- 開兩個 API 實例，會有兩份互不相通的資料。
- 重啟程序，新建文章就消失，固定種子重新出現。
- 改成資料庫後，不能把「讀取、檢查、無條件更新」當成原子操作；20 章會練習帶版本條件的寫入與交易。

`createdAt`／`updatedAt` 由伺服器產生，以 UTC ISO 字串回傳；排序按建立時間降冪，再按 ID 降冪。同一毫秒內兩次修改的 updatedAt 可能相同，因此衝突判定使用 version，不使用時間字串猜測。

## 08.10 一次請求只走到一個回應結果

成功時以 `res.status(...).json(...)` 回應。輸入與業務規則失敗時拋出 `HttpError`，交給最後的錯誤 middleware 轉成一致結構：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "文章已更新，請重新讀取",
    "details": []
  },
  "requestId": "由伺服器產生"
}
```

本章錯誤出口保留四個參數 `(error, req, res, next)`；即使暫時不用 next，也不能任意刪掉成三參數。Express 以這個形式辨識錯誤處理。Express 5 也會處理回傳 Promise 的 handler rejection，但離開該 Promise 鏈的 timer／背景工作，仍需要自己的錯誤責任。[Express 錯誤處理文件](https://expressjs.com/en/guide/error-handling/)

範例在送出錯誤前檢查 `headersSent`／`writableEnded`／`destroyed`，保留「下載已送出一部分後不能再追加 JSON」的規則。10 章會把錯誤來源與測試案例再展開。

### 07 章的清理追蹤怎麼接到 Express？

一般記憶體文章操作是同步完成的；尚未結束的 body／HTTP 回應由 server 的關閉流程等待。匯出則另外追蹤它的完整 Promise，包含關檔：

```ts
await lifecycle.track((async () => {
  const result = await streamExport(res, filename, req.method === 'HEAD');
  onExportFinished?.(result);
})());
```

這是呼叫輪廓，filename 與 callback 由 server options 決定。以後增加非同步資料查詢或背景工作時，要再次確認 handler 結束與資源釋放的關係；換了框架不會讓這件事自動消失。

## 08.11 用測試固定這一階段的行為

```bash
docker compose run --rm tools npm run check
```

本章保留上一階段的 HTTP、匯出、串流與關閉測試，新增文章操作案例。因為 `POST /api/articles` 現在已支援建立，原來測 405 的案例改用不支援的 DELETE，並更新 Allow；這是明確的功能擴充。

| 案例 | 驗證重點 |
|------|----------|
| 建立到封存的完整流程 | 201、Location、200、公開可見範圍與版本遞增 |
| 兩個相同版本更新 | 一個成功，一個衝突；失敗不覆蓋成功結果 |
| 空 PATCH、null、非法版本、非白名單欄位 | 回 400，資料維持原樣 |
| 重複發佈與封存後操作 | 回 409，狀態規則不被繞過 |
| 未知文章與未知路由 | 正確的 404 |
| DELETE 已知文章路徑 | 405 與明確 Allow |
| 公開分頁與管理查詢 | 草稿不出現在公開資料與 total |
| 兩個服務實例 | 記憶體資料不共享 |
| 非法 URL、body、下載中斷、停止信號 | 框架遷移後仍保留既有行為 |

本章先沿用 `node:http` 呼叫真正服務，讓讀者專注 Express 本身；Supertest 的測試整理留在 10 章。每個會修改文章的測試建立自己的服務實例，不依賴上一個測試留下的資料。

匯出端點仍下載 06 章產生器建立的獨立檔案，**不會包含本章剛建立的 Map 文章**。不要用它驗證文章寫入是否持久化。需要觀察新文章時使用公開或管理查詢。

## 08.12 常見問題、練習與驗收

| 現象 | 優先檢查 |
|------|----------|
| POST 後查公開端點是 404 | 新文章是否仍為草稿？先讀 Location |
| req.body 沒有預期物件 | Content-Type、parser 位置與 JSON 格式是否正確？ |
| `/export` 被當成文章 ID | 固定路由是否放在 `/:id` 前面？ |
| PATCH 後其他欄位消失 | 是否把部分更新當成整份取代？ |
| 明明有登入畫面卻能任意寫入 | 本章尚未加入伺服器授權，前端畫面不能代替它 |
| 重啟後新文章消失 | 目前保存於 Map，11 章才接資料庫 |
| 換成 Express 後輸入錯誤變成 HTML | 是否保留 JSON 錯誤出口，且註冊順序正確？ |

### 練習一：找到一個請求的完整路線

從 `POST /api/articles` 開始，依序找出 parser、驗證、Map 寫入、201 與 Location 的程式位置。再說明 authorId 為什麼不能由 body 提供。

### 練習二：測試未知路由與方法錯誤

```bash
curl -i -X DELETE http://127.0.0.1:3008/api/articles/a_1
curl -i http://127.0.0.1:3008/api/not-a-route
```

前者應為 405 並帶 Allow；後者為 404。兩者的 JSON 錯誤格式相同，但含義不同。

### 練習三：為什麼還不能部署兩份 API 共用資料？

<details>
<summary>參考答案</summary>

每次建立 server 都會建立自己的 Map；兩個程序沒有共享資料，程序重啟也不保存資料。需要真正的持久化來源與原子寫入規則，不能把程序內的同步版本檢查推廣成分散式保證。

</details>

### 本章完成檢查

- [ ] 能分清 app、Router 與 Node HTTP server 的責任。
- [ ] 能追蹤 params、query、body、headers 到各自的驗證位置。
- [ ] 已親手完成建立、修改、發佈與封存。
- [ ] 能解釋 201／Location、404／405、409 的差別。
- [ ] 知道固定作者不是認證，Map 不是持久化資料庫。
- [ ] 已通過 `npm run check`，且保留原有匯出與停止服務行為。

下一章預定為 `09-middleware-order-and-input-validation.md`，會把本章已用到的 middleware 順序、next 與輸入 schema 拆開練習。

---

[上一章：程序與關閉流程](07-process-signals-and-graceful-shutdown.md) · [返回課程總覽](README.md) · [本章範例](examples/08/README.md)
