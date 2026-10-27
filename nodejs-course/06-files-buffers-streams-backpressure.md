# 06 — 檔案、Buffer、串流與背壓

> 大檔案傳輸的重點，是讓讀取速度配合接收速度，並在接收者離開時停止工作。

上一章用有大小上限的 Buffer 收集 request body。本章面對另一種情境：文章匯出檔可能很大，不能每次下載都先把整份資料讀進記憶體。

完成本章後，你應能：

- 使用 `fs/promises`、FileHandle 與 `path` 處理檔案。
- 區分字串長度、Unicode code point 與 UTF-8 byte 長度。
- 解釋 chunk 邊界為什麼不等於字元、JSON 或資料列邊界。
- 使用 `pipeline` 串接來源與目的地，理解背壓與 highWaterMark。
- 在 HTTP 下載中斷或串流失敗時，停止來源並關閉檔案。
- 分清開始回應前與部分內容已送出後的錯誤處理。

前置：[05 章](05-native-http-request-response.md)。本章沿用原生 HTTP 服務，新增固定檔案的 NDJSON 匯出，仍不使用資料庫或 Express。

## 06.1 為什麼不能所有資料都先 readFile？

如果先讀完整個檔案再回應：

```ts
const data = await readFile(filename);
res.end(data);
```

程式很短，但每個下載都可能持有一份完整檔案的 Buffer。若再轉成字串、解析成物件，還會建立其他表示形式；多個下載同時發生時，記憶體需求會繼續增加。

小而有界的設定檔可以使用 `readFile`。對大檔傳輸，我們希望改成：

```text
磁碟檔案 → 讀取一部分 → HTTP 回應 → 用戶端接收
                ↑             │
                └─ 接收端慢時，降低後續讀取速度
```

這裡的「一部分」是 chunk。串流不代表沒有任何緩衝，而是不必在應用裡先收集完整結果。

## 06.2 安裝、建立資料與啟動

完整範例：[examples/06](examples/06/README.md)。從倉庫根目錄執行：

```bash
cd nodejs-course/examples/06
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run seed
docker compose up api
```

`seed` 預設串流產生 20000 筆公開文章樣本，保存到本章 `.data/articles.ndjson`；`.data` 已由 Git 排除。這是獨立的教學匯出資料集，並不是上一章固定兩篇文章列表的持久化結果。之後的正式專題會讓列表與匯出來自一致的資料來源。

在主機另一個終端機、同樣位於本章範例目錄時：

```bash
curl -I http://127.0.0.1:3006/api/articles/export
curl -f http://127.0.0.1:3006/api/articles/export \
  --output .data/download.ndjson
```

第 06 章主機使用 **3006**，容器仍監聽 3000。原有健康檢查、文章查詢與預覽端點也保留。若未 seed，匯出會回 `404 EXPORT_NOT_FOUND`。

本機 Node 路線先使用同版 Node／npm，執行 `npm ci`、`npm run check`、`npm run seed`、`npm start`，預設連接埠是 3000。後文以 Docker 路線為例。

| 新增檔案 | 責任 |
|----------|------|
| [files-demo.ts](examples/06/src/files-demo.ts) | 暫存檔案的寫入、讀取與清理 |
| [encoding-demo.ts](examples/06/src/encoding-demo.ts) | byte、字元與跨 chunk 解碼 |
| [generate-export.ts](examples/06/src/generate-export.ts) | 逐筆產生 NDJSON，不先建立完整文章陣列 |
| [export.ts](examples/06/src/export.ts) | 開檔、設定回應、串流、取消與關檔 |
| [streams.test.ts](examples/06/test/streams.test.ts) | 編碼、慢速接收與串流錯誤 |
| [export.test.ts](examples/06/test/export.test.ts) | 真實 HTTP 下載、HEAD、缺檔與中斷清理 |

## 06.3 檔案 API：選擇等待方式，也要管理資源

Node 檔案系統有同步、callback 與 Promise 形式。伺服器處理請求時，通常避免在每次請求內使用大型同步讀寫，否則可能阻塞其他工作。

```ts
import { readFile, writeFile } from 'node:fs/promises';

await writeFile(filename, '文章內容', { encoding: 'utf8', flag: 'wx' });
const data = await readFile(filename);
```

這段是 API 用法示意，`filename` 由呼叫端提供。沒有指定文字編碼的 `readFile` 回傳 Buffer；指定 `'utf8'` 則回傳文字。`flag: 'wx'` 表示只建立新檔，已存在時失敗，避免這個示範意外覆蓋既有檔案。

執行完整的暫存檔練習：

```bash
docker compose run --rm tools npm run files
```

預期輸出：

```json
{ "isBuffer": true, "bytes": 7, "text": "中🙂" }
```

範例用 `mkdtemp` 建立自己的暫存目錄，最後在 `finally` 移除。清理只作用於它自己建立的目錄。

### 自己 open，就需要明確 close

```ts
const handle = await open(filename, 'r');
try {
  const stat = await handle.stat();
  // 使用這個已開啟的檔案。
} finally {
  await handle.close();
}
```

FileHandle 讓我們對同一個開啟中的檔案取得資訊與建立串流。先判斷路徑存在、之後再 open，兩個動作之間仍可能有變動；本章直接 open 並處理錯誤，再從 handle 取得資訊。[Node.js 檔案系統文件](https://nodejs.org/api/fs.html)

## 06.4 path 處理位置，不決定誰有權讀檔

本章的匯出來源由伺服器固定為：

```ts
const defaultExportFile = resolve(__dirname, '..', '.data', 'articles.ndjson');
```

應用建置後的 `__dirname` 位於 `dist`，因此檔案位置以模組目錄為基準，不依賴你從哪個工作目錄執行 Node。測試則明確注入測試自己的暫存檔案路徑。

| 工具 | 用途 |
|------|------|
| `path.join` | 組合路徑片段，處理平台分隔符 |
| `path.resolve` | 依片段與必要的工作目錄基準得到絕對路徑 |
| `__dirname` | 本章 CommonJS 模組所在目錄 |
| `process.cwd()` | 程序目前的工作目錄，可能與模組位置不同 |

`join` 或 `normalize` 不會自動授權檔案存取。若把用戶傳入的 `../../...` 當成可讀路徑，即使正規化成功，也可能指向不該提供的檔案。

因此，本章只有固定的 `GET /api/articles/export`，不接受 query 指定檔名；`?file=../../package.json` 直接回 400。未來若支援多個匯出，應先以業務 ID 查詢允許的資源與權限，再取得伺服器管理的路徑。[Node.js path 文件](https://nodejs.org/api/path.html)

## 06.5 Buffer 儲存 bytes，文字需要編碼

執行：

```bash
docker compose run --rm tools npm run encoding
```

對 `中🙂` 而言：

| 量測方式 | 結果 | 意義 |
|----------|------|------|
| `text.length` | 3 | JavaScript 字串的 UTF-16 code unit 數 |
| `[...text].length` | 2 | Unicode code point 數 |
| `Buffer.byteLength(text, 'utf8')` | 7 | UTF-8 傳輸需要的 bytes |

這三個數字回答不同問題。HTTP Content-Length 與串流大小要看 bytes；畫面上使用者看到的字形還可能由多個 code point 組成。

常用操作：

| 操作 | 意義 |
|------|------|
| `Buffer.from(text, 'utf8')` | 將文字編成 bytes |
| `buffer.toString('utf8')` | 將 bytes 解成文字 |
| `Buffer.alloc(size)` | 建立指定大小且初始化為零的 Buffer |
| `buffer.subarray(start, end)` | 取得共享底層記憶體的檢視，不是獨立拷貝 |
| `Buffer.from(existingBuffer)` | 複製 bytes，取得獨立資料 |

若用 subarray 取得片段後修改內容，原 Buffer 的對應位置也會受影響。不要把它當成免費又完全獨立的複製。[Node.js Buffer 文件](https://nodejs.org/api/buffer.html)

### chunk 可以切在一個中文字的中間

本章把 UTF-8 bytes 切在第 2 個 byte。逐塊呼叫 `toString()` 再拼接，會把不完整字元解成替代字元，不能恢復成原文。

需要跨 chunk 保留解碼狀態時，可以使用 `StringDecoder`：

```ts
const decoder = new StringDecoder('utf8');
const result = decoder.write(first) + decoder.write(second) + decoder.end();
```

輸出應恢復成 `中🙂`。最後的 `end()` 用來處理剩餘狀態。[StringDecoder 文件](https://nodejs.org/api/string_decoder.html)

StringDecoder 處理字元邊界，不等於嚴格驗證所有 bytes 合法；遇到無效序列仍可能產生替代字元。上一章對有界 JSON body 使用 `TextDecoder` 的 `fatal: true`，目的是拒絕非法 UTF-8，兩者用途不同。

## 06.6 Stream 的四種角色與 chunk 邊界

| 類型 | 作用 | 本課例子 |
|------|------|----------|
| Readable | 提供資料 | request body、檔案讀取串流 |
| Writable | 接收資料 | HTTP response、檔案寫入串流 |
| Duplex | 同時可讀可寫 | 網路 socket |
| Transform | 接收資料並轉換後輸出 | 壓縮、編碼轉換等處理階段 |

一個 chunk 不保證是一行、一個 JSON 物件或一個完整字元。來源、緩衝與網路都可能改變交付邊界。

本章採用 **NDJSON**：每一行是一個獨立 JSON 值，以換行分隔，例如：

```text
{"id":"a_1","title":"文章 1"}
{"id":"a_2","title":"文章 2"}
```

它適合逐筆產生與處理，不必先建立一個包含所有文章的 JSON 陣列。但接收端仍不能直接 `JSON.parse(chunk)`；若要逐行解析，必須保留尚未完成的行，且要限制單行大小。

本章下載端點只傳送檔案 bytes，不在傳輸途中重新解析資料，因此不需要把檔案整體轉成字串。

## 06.7 背壓：接收端慢時，來源也要慢下來

假設檔案每秒能讀取很多資料，但用戶端每秒只能接收一小部分。如果來源持續讀取、目的地持續累積，記憶體就可能被待送資料占滿。

Writable 的 `write(chunk)` 回傳 `false`，表示目前應暫停繼續寫，等待 `'drain'` 再前進。這個 chunk 已被接受進入緩衝，不應收到 drain 後再寫一次同一塊。[Node.js 背壓說明](https://nodejs.org/en/learn/modules/backpressuring-in-streams)

手動處理時還要接上 error、close 與取消，容易漏掉某條路徑。大多數直線資料流可交給 `pipeline`：

```ts
import { pipeline } from 'node:stream/promises';

await pipeline(source, destination, { signal });
```

`pipeline` 協調背壓、完成與串流失敗；錯誤時會處理鏈上串流的銷毀，並讓 Promise 拒絕。單純 `.pipe()` 雖然也有背壓機制，卻不提供相同的一個 Promise 完成／錯誤出口。[Node.js Stream 文件](https://nodejs.org/api/stream.html)

### highWaterMark 不是程序記憶體上限

本章檔案來源設定 `highWaterMark: 16 * 1024`，作為緩衝與讀取的調節門檻，但不表示整個下載只使用 16 KiB 記憶體。

來源、目的地、HTTP、socket 與作業系統都可能有自己的緩衝；單一 chunk 也可能超過門檻。object mode 的 highWaterMark 計算的是物件數，而非每個物件實際占用 bytes。

因此，背壓保證的是可協作的流量調節，不是對整個程序的固定記憶體承諾。若上游早已把所有資料載入陣列，再包成 Readable，前面的完整記憶體成本仍然存在。

## 06.8 從產生資料到下載，都保留串流

[seed 工具](examples/06/src/generate-export.ts) 使用 generator 每次建立一筆文章，交給 `Readable.from`，再 pipeline 到檔案寫入端。它不先建立 20000 筆的大陣列，也不先組成完整的大字串。

```text
逐筆產生 JSON + 換行
       → Readable（byte mode）
       → pipeline
       → 暫存檔
       → 完成後 rename 成固定匯出檔
```

`Readable.from` 在這裡明確設定 `objectMode: false`，讓輸出的 Buffer 以 byte 模式處理。工具先寫到自己的唯一暫存檔，成功後才替換固定入口；失敗時刪除暫存檔，不把半成品當作可下載檔案。

`rename` 是本章完成檔案的發布步驟，不代表已處理備份、磁碟耐久性與跨平台部署的所有情境。傳輸時應把這個匯出檔視為不再原地修改的成品；否則先取得的 Content-Length 可能與後續讀到的內容不一致。

### 下載端點的步驟

1. 開啟固定檔案。不存在時，尚未傳 headers，可以回 JSON 404。
2. 從 FileHandle 取得檔案資訊，確認來源是一般檔案。
3. 設定 NDJSON 類型、下載檔名與檔案 byte 長度。
4. HEAD 只回 headers；GET 才建立讀取串流。
5. 使用 `pipeline(source, res, { signal })` 傳送。
6. 最後關閉 FileHandle，回報讀取 bytes 與完成狀態。

本章使用 `handle.createReadStream({ autoClose: false })`，讓 FileHandle 的關閉責任集中在函式的 `finally`。一般 `createReadStream` 可自動關閉檔案，但這裡既然選擇手動管理，就必須確保成功與失敗都 close。

## 06.9 用戶端離線時，應該監聽哪個 close？

我們關心的是「回應還沒完成，接收端就離開」，所以觀察 `res` 的 close，並檢查 `res.writableFinished`：

```ts
const onClose = () => {
  if (!res.writableFinished) {
    controller.abort(new Error('response closed before finish'));
  }
};
res.once('close', onClose);
```

正常回應也可能 close，所以不能看到 close 就一律當成失敗。也不要直接把 `req` 的 close 當成「下載被取消」：請求訊息讀取完成與回應下載完成，是不同生命週期。

signal 取消後，pipeline 停止串流處理，函式在 `finally` 移除自己的 close listener、銷毀來源並關閉檔案。若用戶在 open／stat 期間已經離開，程式也會檢查 `res.destroyed`，避免漏掉較早發生的中斷。

伺服器終端機會輸出：

```text
EXPORT_RESULT {"outcome":"complete","bytesRead":... ,"fileClosed":true}
```

中斷時 outcome 為 `interrupted`，另保留 `errorCode`。它代表串流未完整完成，不單憑這個欄位斷定一定是用戶取消；讀取錯誤也可能造成中斷。`fileClosed` 用來觀察資源已釋放，`bytesRead` 則是來源已讀取的 bytes，不等於用戶實際收到的 bytes。

### 手動觀察慢速下載與中斷

若想讓現象更明顯，先停止服務、產生較大的樣本，再啟動：

```bash
docker compose run --rm tools npm run seed -- 200000
docker compose up api
```

在另一個主機終端機執行：

```bash
curl --limit-rate 4k --max-time 1 \
  http://127.0.0.1:3006/api/articles/export \
  --output .data/partial.ndjson
```

這條指令預期因 curl 的時間上限而失敗，並留下不完整下載檔。觀察服務端是否記錄中斷與 `fileClosed: true`，接著呼叫健康檢查，確認服務仍可回應。

接收端限速不代表伺服器立刻每秒只讀同樣數量；中間仍有緩衝，小檔可能在 curl 停止前就已被伺服器送完。自動測試因此使用較大的暫存檔，在第一批資料抵達後主動斷線，檢查沒有讀完整份來源。

## 06.10 部分內容已送出，不能再補一份 JSON 錯誤

| 失敗時機 | 可採取的行為 |
|----------|--------------|
| 開檔前後，尚未開始串流 | 由 HTTP 錯誤出口回傳 404／500 等 JSON |
| pipeline 已開始並傳出 headers／部分內容 | 結束失敗的串流，記錄結果；不能改寫成另一個狀態碼與 JSON body |
| 用戶端已離線 | 停止來源並釋放資源，沒有可再送達的錯誤回應 |

`pipeline` 失敗時可能已銷毀 HTTP response／socket，即使尚未看見完整 headers，也不能假設 catch 裡還能安全 `res.end(JSON.stringify(...))`。

若先送出 200 與半份 NDJSON，再接上一段錯誤 JSON，下載者拿到的只會是損壞資料。正確做法是讓傳輸明確不完整，保留可追查的日誌與錯誤代碼。

本章在串流開始前完成 open／stat 檢查，減少可提前發現的失敗；但這不保證後面的磁碟或網路永遠不出錯。

## 06.11 如何驗證背壓與清理？

本章共有 **34 個測試**：沿用前章 26 個 HTTP 契約，再新增 8 個 Buffer／串流／匯出測試。

| 案例 | 驗證方式 |
|------|----------|
| UTF-8 跨 chunk | 刻意切在字元中間，對照錯誤拼接與 StringDecoder 結果 |
| 慢速 writable | 暫停第一筆寫入完成 callback，確認來源沒有把 1000 個 chunk 全部產生完 |
| 目的地失敗 | pipeline 拒絕，來源與目的地都進入 destroyed 狀態 |
| 正常下載 | 檔案 bytes 完全一致、headers 正確、FileHandle 關閉 |
| HEAD | 不傳 body，來源 bytesRead 為 0，仍關閉檔案 |
| 缺檔與不允許的檔案 query | 串流開始前就拒絕 |
| 用戶中斷 | bytesRead 小於檔案大小、FileHandle 已關閉，之後健康檢查仍成功 |

中斷測試的 64 MiB 暫存檔只用於傳輸與資源清理，內容不是完整 NDJSON 業務資料；正常下載案例另用合法 Unicode NDJSON 驗證內容。測試不要求中斷後恰好讀了幾個 chunk，因為系統緩衝可能不同。

背壓測試直接控制目的地何時完成寫入，不以不穩定的固定睡眠或 RSS 數值判定。這能證明生產速度會配合消費速度，還不能替代正式負載下的記憶體量測。

## 06.12 常見問題、練習與驗收

| 現象 | 優先檢查 |
|------|----------|
| 匯出回 404 | 是否先建置並執行本章 seed？ |
| 換個工作目錄就找不到檔案 | 路徑基準是 cwd 還是模組位置？ |
| 中文在 chunk 接縫變成替代字元 | 是否逐塊獨立解碼？需要保留解碼狀態 |
| 用了 stream，記憶體仍很高 | 上游是否先讀完整檔案／建立大陣列？是否忽略背壓？ |
| write 回傳 false 後資料重複 | false 不代表該 chunk 沒寫入，不應重送同一塊 |
| 用戶離線後來源仍持續讀取 | 是否把 response 中斷接到 signal 與 pipeline？ |
| 下載後程序或檔案資源沒釋放 | FileHandle 與 stream 的關閉責任是否明確？ |
| 檔案尾端混入 JSON 錯誤 | 是否在部分內容送出後仍嘗試新的 HTTP 回應？ |

### 練習一：猜長度再驗證

將 `encoding-demo.ts` 的文字改成含不同 emoji 的短句，先預測 UTF-16 units、code points 與 UTF-8 bytes，再重新建置執行。完成後恢復原始文字，避免影響教材對照。

### 練習二：為何 `readFile` 再包 Readable 不夠？

先 `await readFile(filename)`，再 `Readable.from([data])`，是否就避免了一次載入整個大檔？

<details>
<summary>參考答案</summary>

沒有。完整檔案在建立 Readable 之前已進入記憶體。需要從來源端就逐步產生或讀取，並讓下游背壓能限制後續讀取。

</details>

### 練習三：分清三個完成狀態

`res.end()`、`res.writableFinished` 與用戶端成功保存下載檔，是否表示同一件事？

<details>
<summary>參考答案</summary>

不是。end 表示應用不再寫入；writableFinished 表示資料已從該 writable 的緩衝交給底層；遠端完整收到並保存仍是另一端的狀態，不能只靠伺服器這兩個值推論。

</details>

### 本章完成檢查

- [ ] 能用 fs/promises 操作小檔案，並指出誰負責 close／清理。
- [ ] 能區分文字、code point 與 bytes，理解跨 chunk 解碼。
- [ ] 已產生並下載 NDJSON，知道它與固定列表是獨立教學資料。
- [ ] 能解釋背壓、write false 與 highWaterMark 的限制。
- [ ] 用戶端中斷時會停止讀取並關檔，服務仍可回應。
- [ ] 能區分串流開始前後的錯誤處理，並通過 `npm run check`。

下一章：[程序生命週期、信號與有界關閉](07-process-signals-and-graceful-shutdown.md)，會處理程序停止接收請求、等待進行中工作與有界關閉的順序。

---

[上一章：原生 HTTP](05-native-http-request-response.md) · [返回課程總覽](README.md) · [本章範例](examples/06/README.md)
