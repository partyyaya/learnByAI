# 05 — 原生 HTTP：請求、回應與輸入邊界

> 一個請求不只是呼叫函式：資料可能分批到達、格式可能錯誤，用戶也可能在途中離線。

前面已學過執行模型、錯誤與資源清理。本章第一次啟動真正的 HTTP 服務，讓瀏覽器或 curl 可以透過連接埠呼叫我們的程式。

完成本章後，你應能：

- 從 method、path、query、headers 與 body 找到請求資訊。
- 使用 `node:http` 建立 GET／HEAD 與 POST 端點。
- 把分批到達的 body 轉成經過驗證的 JSON 輸入。
- 區分未知路由、錯誤方法、無效輸入、大小限制與逾時。
- 讓一次請求只完成一次回應，並測試上傳中斷後的行為。

前置：[04 章](04-async-errors-and-resource-lifecycle.md)。版本與工具沿用前章；本章不需要 Express、Session 或資料庫。

## 05.1 本章完成哪一部分契約？

我們先提供固定的公開文章資料，以及**不保存資料的草稿預覽**。這讓讀者能完整練習 GET 與 POST，又不需要同時引入持久化與登入。

| 方法與路徑 | 行為 | 成功狀態 |
|------------|------|----------|
| `GET /health/live` | 程序能否回應 | `200` |
| `GET /api/articles` | 查詢固定公開文章，可用 `page`／`pageSize` 分頁 | `200` |
| `GET /api/articles/:id` | 讀取一篇公開文章 | `200` |
| `HEAD`＋上述 GET 路徑 | 回傳對應 headers，不傳 body | `200` |
| `POST /api/articles/preview` | 驗證標題與內容，回傳標準化的草稿預覽 | `200` |

預覽端點是本章的 HTTP 練習，不是 00 章最終契約中的「新增文章」。它沒有新增 ID、寫入資料或建立可讀取的資源，因此不回傳 `201 Created`。`POST /api/articles` 的真正新增操作留到 Express 階段。

固定資料也只是教材樣本：目前沒有時間、作者與版本等完整欄位，列表依樣本順序回傳。完整專題會逐步落實 00 章的資料模型、排序與權限。

## 05.2 安裝、驗證與啟動

完整範例：[examples/05](examples/05/README.md)。從倉庫根目錄執行：

```bash
cd nodejs-course/examples/05
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose up api
```

最後一條會持續顯示服務日誌。看到 `LISTENING` 後，在**主機的另一個終端機**執行：

```bash
curl -i http://127.0.0.1:3005/health/live
```

預期狀態是 `200`，body 為：

```json
{ "data": { "status": "ok" } }
```

| 位置 | 位址 |
|------|------|
| 容器內服務監聽 | `0.0.0.0:3000` |
| 主機 curl／瀏覽器呼叫 | `127.0.0.1:3005` |

Compose 把主機 3005 映射到容器 3000，且主機端只綁定 loopback。`tools` 用於安裝與測試，`api` 用同一份依賴與建置檔持續執行服務。

`npm run check` 會完成建置。修改 TypeScript 後，先停止服務、重新 `docker compose run --rm tools npm run build`，再啟動；`npm start` 不會自動編譯。

本機 Node 路線則執行 `npm ci`、`npm run check`、`npm start`，預設呼叫 `127.0.0.1:3000`。後文 curl 以 Docker 的 3005 為例，本機需自行換成 3000。`Ctrl+C` 可停止前景服務；程序如何有序關閉進行中的工作，會在 07 章處理。

### 檔案分工

| 檔案 | 責任 |
|------|------|
| [main.ts](examples/05/src/main.ts) | 驗證 HOST／PORT，建立服務並開始監聽 |
| [server.ts](examples/05/src/server.ts) | 路由、固定資料、方法判斷與統一錯誤回應 |
| [http.ts](examples/05/src/http.ts) | JSON 回應、有限大小的 body 讀取與草稿驗證 |
| [http.test.ts](examples/05/test/http.test.ts) | 透過真實 HTTP 連線檢查成功與失敗契約 |

匯入 `server.ts` 只提供建立服務的函式，不會自動開連接埠。測試因此能建立獨立實例，交由作業系統分配可用連接埠。

## 05.3 一個請求裡有哪些資訊？

以這個請求為例：

```http
POST /api/articles/preview HTTP/1.1
Host: 127.0.0.1:3005
Content-Type: application/json

{"title":"第一篇文章","content":"認識原生 HTTP"}
```

| 資訊 | Node 中的位置 | 用途 |
|------|----------------|------|
| method | `req.method` | 判斷 GET、POST、HEAD 等操作 |
| path 與 query | `req.url`，再交給 `URL` 解析 | 決定路由與查詢條件 |
| headers | `req.headers` | 內容格式、長度等中繼資料；常見欄位名稱為小寫 |
| body | `req` 的資料串流 | 分批讀入內容；不是已經存在的 `req.body` |

例如 `/api/articles?page=2&pageSize=1` 應拆成：

```text
pathname：/api/articles
page：2
pageSize：1
```

若直接用整段 `req.url === '/api/articles'` 判斷，帶 query 的請求就不會匹配。範例使用 `new URL(req.url, 'http://course.local')`；固定 base 只用來解析相對 URL，不表示真的向這個網域連線，也不信任用戶提供的 Host 作為伺服器設定。

無法解析的 URL 回傳 `400 INVALID_URL`。query 也仍是外部輸入，不能因為成功解析成 URL，就當作已經是合法數字。

## 05.4 req 與 res 分別做什麼？

HTTP server 的核心形式是：

```ts
createServer((req, res) => {
  // req：讀取用戶送來的請求。
  // res：設定並傳送我們要回覆的結果。
});
```

`req` 是 `IncomingMessage`，具有可讀串流能力；`res` 是 `ServerResponse`，具有可寫串流能力。Node 原生 HTTP 主要提供協定與串流介面，不會替你完成 JSON schema 驗證或業務路由。[Node.js HTTP 文件](https://nodejs.org/api/http.html)

本章把處理流程拆成：

```text
收到請求
  → 建立 request ID
  → 解析 URL，找到路由
  → 檢查 method
  → 必要時讀取、解析與驗證 body
  → 執行本章的查詢或預覽
  → 設定 status／headers，結束回應
```

其中任何可回報的失敗，會交給統一錯誤處理。若連線已經中斷，就沒有必要再嘗試送 JSON。

### async listener 的錯誤仍要接回來

回想 04 章：事件來源不會自動處理 async listener 的 rejection。本章使用：

```ts
void route(req, res).catch((error: unknown) => {
  // 判斷回應狀態，再轉成適當錯誤回應。
});
```

不能只把 `createServer` 的 callback 改成 `async`，就期待所有錯誤都會自動成為 HTTP `500`。框架之後會協助處理這一層，但在原生 Node 裡，需要清楚指定錯誤出口。

## 05.5 GET、HEAD、未知路由與錯誤方法

先試幾個不帶 body 的請求：

```bash
curl -i 'http://127.0.0.1:3005/api/articles?page=2&pageSize=1'
curl -i http://127.0.0.1:3005/api/articles/a_1
curl -I http://127.0.0.1:3005/api/articles/a_1
curl -i http://127.0.0.1:3005/api/articles/a_draft
curl -i -X POST http://127.0.0.1:3005/api/articles
```

預期結果：

| 請求 | 結果 |
|------|------|
| 第 2 頁、每頁 1 筆 | 取得 `a_2`，`meta.total` 為公開文章數量 2 |
| 詳情 `a_1` | `200` 與文章資料 |
| HEAD `a_1` | `200`，有內容類型與長度，但沒有 body |
| 公開端點讀草稿 | `404` |
| 對已知列表路由 POST | `405`，`Allow: GET, HEAD` |

未知路徑與不存在資源使用 `404`；路由存在但方法不支援使用 `405`。本章將 HEAD 納入 GET 路由，回傳同一份內容的長度，但不送出內容本身。

分頁預設 `page=1`、`pageSize=20`，每頁上限 100；練習中另外限制 page 至 1000000。重複參數、未知參數、非整數與越界值都回 `400`。這是記憶體樣本的規格，資料庫分頁成本留到後續處理。

## 05.6 body 不是一次就完整到達的物件

HTTP 傳輸會分批交付資料。一次 `data` 事件可能只有半個字元，也可能包含一大段 JSON；不能假設一個 chunk 就是一份 JSON。

本章的讀取順序：

1. 確認內容類型為 `application/json`，編碼使用 UTF-8。
2. 不接受壓縮 body，避免現在同時引入解壓縮與大小語意。
3. 有 Content-Length 時先檢查，但仍逐塊累計實際 bytes。
4. 大小合法且收到 `end` 後，才合併 Buffer。
5. 嚴格解碼 UTF-8，再執行 `JSON.parse`。
6. 把解析結果視為 `unknown`，交給執行期驗證。

```text
Buffer chunk 1 ─┐
Buffer chunk 2 ─┼─ 累計 bytes，不超過 16 KiB
Buffer chunk 3 ─┘
        │ end
        ▼
合併 → UTF-8 解碼 → JSON.parse → unknown → 驗證欄位
```

本章的 body 很小且有明確上限，所以先收完整份再解析是合理取捨；06 章會討論大檔案為什麼不適合這樣做。

### 三種不同的非法輸入

| 輸入 | 錯誤 |
|------|------|
| 不是有效 UTF-8 bytes | `400 INVALID_ENCODING` |
| 有效文字，但不是合法 JSON，例如 `{` | `400 INVALID_JSON` |
| 合法 JSON，但不符合業務欄位，例如 `null` 或數字 title | `400 VALIDATION_ERROR` |

`JSON.parse` 能成功，不代表資料就能使用。它可以回傳陣列、數字、布林值或 null，而不一定是文章物件。

## 05.7 送出草稿預覽

```bash
curl -i http://127.0.0.1:3005/api/articles/preview \
  -H 'Content-Type: application/json' \
  --data '{"title":" 第一篇文章 ","content":" 認識原生 HTTP "}'
```

預期回應：

```json
{
  "data": {
    "title": "第一篇文章",
    "content": "認識原生 HTTP",
    "status": "draft",
    "preview": true
  }
}
```

這裡的規則是：

- 只接受 `title` 與 `content`，必須是字串。
- 去除首尾空白後，兩者都不能為空。
- title 上限 120、content 上限 4000 個 Unicode code point。
- 不接受 `authorId`、`role`、`status` 等額外欄位。

code point 數量不是使用者看到的字形數量，也不是 UTF-8 bytes；本章明確採用 `[...text].length` 作為欄位長度規則。整份 HTTP body 另外受 16 KiB 上限約束。

再送出兩個失敗請求：

```bash
curl -i http://127.0.0.1:3005/api/articles/preview \
  -H 'Content-Type: application/json' --data '{'

curl -i http://127.0.0.1:3005/api/articles/preview \
  -H 'Content-Type: application/json' \
  --data '{"title":"測試","content":"內容","authorId":"u_other"}'
```

分別應得到 `INVALID_JSON` 與 `VALIDATION_ERROR`。這些操作都不會改變公開文章數量。

## 05.8 大小限制與時間限制，是兩個邊界

只檢查 Content-Length 不夠。用戶可能使用 chunked 傳輸而不提供長度，所以 reader 每收到一塊都會累計 `chunk.length`，超過 **16 × 1024 bytes** 就拒絕。

只檢查大小也不夠。用戶可以送出開頭的 `{` 後一直不結束，所以本章 reader 另外設 **2 秒的 body 讀取期限**。

| 失敗 | 回應 |
|------|------|
| body 超過限制 | `413 PAYLOAD_TOO_LARGE` |
| body 讀取期限到達 | `408 REQUEST_TIMEOUT` |
| 非 JSON 內容或不支援的 charset | `415 UNSUPPORTED_MEDIA_TYPE` |
| 壓縮 request body | `415 UNSUPPORTED_ENCODING` |

reader 的期限從開始讀 body 算起；另外設定的 `headersTimeout` 與 `requestTimeout` 由 Node 處理較前面的 HTTP 接收階段。HTTP parser 拒絕、headers 逾時等情況可能由 Node 直接回應，並不保證都經過本章的 JSON 錯誤格式。

提早拒絕時，程式先完成錯誤回應，再以 `Connection: close` 結束這條連線，不再拿未讀完的連線處理下一個請求。不能先 `req.destroy()` 再期待對方一定收到完整的 `413`；先破壞連線可能只讓對方看到 reset。

本章選用事件方式讀 body，讓大小、期限、來源錯誤與中斷都能走同一套清理。若改用 async iterator，也要理解提早離開迭代可能銷毀來源串流的行為。

## 05.9 回應只能完成一次

JSON 回應 helper 主要做四件事：

```ts
const body = JSON.stringify(data);
res.statusCode = status;
res.setHeader('Content-Type', 'application/json; charset=utf-8');
res.setHeader('Content-Length', Buffer.byteLength(body));
res.end(req.method === 'HEAD' ? undefined : body);
```

Content-Length 必須是傳輸的 byte 長度，不能使用字串 `.length`。包含中文或 emoji 時，兩者可能不同。

`res.end()` 表示應用不再寫入這個回應；它不保證遠端已完整收到或處理資料。呼叫 `end` 後程式仍會繼續執行，所以每條已完成的路由分支都要 `return`，避免掉進下一個分支再次送出資料。

錯誤出口會先檢查：

| 狀態 | 處理方向 |
|------|----------|
| `res.destroyed` | 連線／串流已破壞，不再寫入 |
| `res.writableEnded` | 已呼叫 end，不再結束第二次 |
| `res.headersSent` | 已經送出 headers，不能再改 status／headers |
| 尚未開始回應 | 可轉成對應的 JSON 錯誤 |

這些檢查是最後一道邊界，不能取代正確的單一回應流程。下一章的檔案串流會特別遇到「200 與部分內容已送出，之後才發生錯誤」的情況。

本章回應帶有 `X-Request-ID`；錯誤 body 也包含相同的 `requestId`。錯誤格式是 `{ error: { code, message, details }, requestId }`，不把堆疊或內部檔案路徑交給呼叫端。

## 05.10 用真實 HTTP 測試，不只直接呼叫函式

本章測試會 `listen(0, '127.0.0.1')`，由作業系統分配可用連接埠，再使用 Node HTTP client 發出請求。`PORT=0` 在本章入口也被允許，方便程序測試；一般 Docker 映射仍使用固定的容器 3000。

目前共有 **26 個 HTTP 測試**，包括：

- 成功回應、query 分頁、HEAD 與 byte 長度。
- 未知路由、隱藏草稿、錯誤 method 與 Allow header。
- 非法 URL、JSON、UTF-8、欄位與媒體類型。
- 有／沒有 Content-Length 的超大 body。
- 不結束 body 時的逾時，以及上傳途中離線後服務仍可回應。

另以真實入口子程序檢查非法設定不能啟動，以及啟動後能回覆健康請求。整合測試使用短的 reader 期限縮短等待，但不拿精準毫秒數當作通過條件。

測試結束後關閉自己建立的 server 與連線，避免留下持續監聽的程序。這是測試清理，不是正式服務完整的優雅關閉流程。

## 05.11 常見問題、練習與驗收

| 現象 | 優先檢查 |
|------|----------|
| curl 連不上 Docker 服務 | 是否已啟動 api？主機用 3005，容器內用 3000 |
| 新增 `?page=1` 後路由失效 | 是否把整個 req.url 當 pathname 比較？ |
| req.body 是 undefined | 原生 Node 不會自動解析 body |
| 中文回應長度錯誤 | Content-Length 是否用了字串 length？ |
| `ERR_HTTP_HEADERS_SENT` | 是否已經 write/end 後又設定 headers 或送第二次回應？ |
| 預覽成功卻查不到新文章 | 預覽本來不持久化，不是新增端點 |
| 請求一直掛著 | 是否收到 body end？是否有回應 end 與讀取期限？ |
| 用戶離線後仍有 timer | reader 是否在 end、error、aborted 與 timeout 都清理？ |

### 練習一：選擇正確結果

請判斷：未知路由、已知路由錯誤方法、JSON 語法錯誤、body 過大、text/plain 預覽，各應使用什麼狀態碼？

<details>
<summary>參考答案</summary>

依序是 404、405、400、413、415。405 同時提供 Allow，讓呼叫端知道支援的方法。

</details>

### 練習二：檢查回應 byte 長度

將預覽 title 改成包含中文與 emoji，觀察回應 Content-Length，再對照 `Buffer.byteLength(result.text)`。找出測試中驗證這件事的位置，說明為什麼 `.length` 不適用。

### 練習三：確認未知欄位不會被接收

在原本成功的預覽 body 補上 `status: "published"`，預期為 400。這個檢查應放在輸入邊界，不能只靠 TypeScript 介面或前端欄位限制。

### 本章完成檢查

- [ ] 能從主機成功呼叫 Docker 內的 HTTP 服務。
- [ ] 能分清 path、query、headers 與串流 body。
- [ ] 知道 JSON.parse 成功後仍需要執行期驗證。
- [ ] 能說明大小限制、body 期限與 Node 接收期限的差別。
- [ ] 每條路由只完成一次回應，錯誤分支也有明確出口。
- [ ] 已通過 `npm run check`，知道預覽不會建立文章。

下一章：[06 — 檔案、Buffer、串流與背壓](06-files-buffers-streams-backpressure.md)，會加入文章匯出，處理大檔傳輸與用戶中斷。

---

[上一章：非同步錯誤與清理](04-async-errors-and-resource-lifecycle.md) · [返回課程總覽](README.md) · [本章範例](examples/05/README.md)
