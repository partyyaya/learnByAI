# 10 — 錯誤處理與 HTTP 契約測試

> 錯誤不是另一條隨便補上的回應路徑。呼叫端需要穩定的結果，而服務要清楚知道哪些工作失敗、回應是否還能修改。

09 章已經分開 JSON 解析、schema 驗證與文章操作。本章把錯誤出口整理成可重用的 middleware，並加入 Supertest，以真正的 HTTP 回應驗證契約。

完成本章後，你應能：

- 區分同步 throw、回傳 Promise 的 rejection、callback 與事件錯誤。
- 設計可預期的錯誤回應，避免把內部訊息當成公開 API。
- 判斷 headersSent、writableEnded、destroyed 之後還能做什麼。
- 用 Supertest 測成功與失敗，並正確管理測試服務的生命週期。
- 保留一份能套用到下一章 PostgreSQL 實作的 HTTP 契約。

前置：[09 章](09-middleware-order-and-input-validation.md)。新增 **Supertest 7.3.1**、`@types/supertest` **7.2.1**；Express、Zod、Node 與 Jest 沿用前章固定版本。

仍使用固定作者 `u_demo` 與記憶體 Map，尚未加入登入授權；文章資料重啟後重置。本章的故障路由只存在於測試 app，不會掛到讀者啟動的文章 API。

## 10.1 安裝、測試與啟動

完整範例：[examples/10](examples/10/README.md)。從倉庫根目錄執行：

```bash
cd nodejs-course/examples/10
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose up api
```

主機連接埠為 **3010**，容器內為 3000。另一個終端機：

```bash
curl -i http://127.0.0.1:3010/api/articles/missing
curl -i -X PATCH http://127.0.0.1:3010/api/articles/a_1 \
  -H 'Content-Type: application/json' \
  --data '{"title":"修訂","expectedVersion":99}'
```

前者回 404，後者回 409。錯誤 JSON 仍包含 error 與 requestId；伺服器另外記錄 `HTTP_ERROR`，可和 09 章的 `REQUEST_TRACE` 對照。

本機路線使用 `.nvmrc` 的 Node 與 npm 11.19.1，執行 `npm ci`、`npm run check`、`npm start`，預設 3000。信號測試建議用 Linux Docker。

| 檔案 | 閱讀重點 |
|------|----------|
| [errors.ts](examples/10/src/errors.ts) | 錯誤分類、公開回應與傳輸階段判斷 |
| [http.ts](examples/10/src/http.ts) | 可預期錯誤 HttpError 與欄位 details |
| [error-contract.test.ts](examples/10/test/error-contract.test.ts) | 隔離的故障 app，測不同錯誤來源 |
| [api-contract.ts](examples/10/test/api-contract.ts) | 不依賴儲存方式的文章契約 |
| [api.test.ts](examples/10/test/api.test.ts) | 啟動、注入目前 server、測後關閉 |

## 10.2 錯誤在哪裡發生，決定誰負責接住

| 錯誤來源 | 正確連接方式 | 本章驗證 |
|----------|--------------|----------|
| 同步 handler throw | Express 接住後進入錯誤 middleware | sync 案例 |
| async handler throw／await rejection | 回傳 handler Promise，Express 5 轉交錯誤 | async 案例 |
| 傳統 callback 的 error 參數 | 在 callback 內呼叫 next(error) | readFile 案例 |
| EventEmitter 的 error 事件 | 由來源擁有者註冊 error listener | event 案例 |
| 串流途中失敗 | 交給 pipeline／來源清理，依回應階段處理 | 保留 06 章案例 |

Express 5 會處理 handler 回傳的 Promise rejection；但這不代表任意背景工作都會自動歸入這次請求。[Express 錯誤處理文件](https://expressjs.com/en/guide/error-handling/)

例如：

```ts
app.get('/example', async (_req, res) => {
  const result = await loadData();
  res.json({ data: result });
});
```

這是呼叫輪廓。loadData 若失敗，會讓 handler 的 Promise reject。相反地，`void loadData()` 後就送成功回應，既不能讓 Express 等待，也無法把後來的失敗改成原請求的 500。

### Callback 要在自己的錯誤來源處轉交

```ts
readFile(filename, (error, content) => {
  if (error) {
    next(error);
    return;
  }
  res.send(content);
});
```

外面包一個 try/catch，不能接住未來 callback 執行時才拋出的錯誤。不要在 callback 中直接 throw，期待外層 async handler 接住。

EventEmitter 也需要自己的 error listener。測試中使用一次性 emitter，`once('error', next)` 後觸發錯誤；真實的長生命週期來源還要處理 listener 移除、取消與多次通知，沿用 04 章的資源責任。

## 10.3 可預期錯誤與未知錯誤

本課使用 `HttpError` 表達刻意設計過的對外錯誤：

```ts
throw new HttpError(409, 'VERSION_CONFLICT', '文章已更新，請重新讀取');
```

它的 status、code、message 是服務程式決定的，不是從 request body 直接抄過來。

| 類別 | 例子 | 對外處理 |
|------|------|----------|
| 輸入錯誤 | JSON 不合法、schema 失敗 | 400，保留可讀的 code／details |
| 資源或規則錯誤 | 找不到文章、舊版本、封存後修改 | 404／409 |
| 傳輸限制 | body 過大、逾時、格式不支援 | 413／408／415 |
| 未知例外 | driver 內部錯誤、程式缺陷 | 500 INTERNAL_ERROR，不回傳原始例外 |

不要把所有 exception 都回 400，也不要直接使用任意 `error.status` 或 `error.message`。某個套件的 Error 可能含 SQL、路徑、連線設定；這些不是穩定的公開 API。

本章的 normalizeError 只辨識明確的 HttpError、已知 parser 錯誤類型與 URIError，其餘轉成通用 500。未知物件即使聲稱自己有 status 418，也不會因此改變回應。

## 10.4 一個統一的錯誤出口

錯誤 middleware 放在正常路由與 404 收尾之後，保留四個參數：

```ts
const errors: ErrorRequestHandler = (error, req, res, _next) => {
  // 分類、判斷傳輸階段、記錄，再決定是否還能回應。
};
app.use(errors);
```

`_next` 暫時沒有使用，仍保留位置，讓 Express 正確辨識錯誤 middleware。

當尚未送出回應時，格式固定為：

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "內部錯誤",
    "details": []
  },
  "requestId": "本次請求的ID"
}
```

requestId 必須與 `X-Request-ID` 一致。JSON parser 失敗與業務錯誤都經過同一出口，不應一種回 JSON，另一種突然回 HTML。

本章維持提前拒絕後關閉該連線的策略；錯誤出口設定 Connection: close 並丟棄剩餘 request 資料，避免把尚未處理完的 body 留給下一個請求。

## 10.5 已開始回應之後，不能再送一份 JSON

| 回應階段 | 本章行為 |
|----------|----------|
| before-response | 可以設定狀態碼，送出 JSON 錯誤 |
| streaming | 標頭已送出，仍在傳送；記錄並中斷連線 |
| ended | 已呼叫 end；只記錄，不再寫第二份回應 |
| disconnected | 連線已銷毀；只記錄，不再嘗試回應 |

範例依序檢查 destroyed、writableEnded、headersSent。這些值的用途是判斷還能不能修改傳輸，不是證明遠端已收到資料。

假設已送出一段檔案：

```text
HTTP 200 標頭 → 一部分檔案內容 → 讀取失敗
```

此時無法把先前的 200 收回，也不能把 `{ "error": ... }` 接在檔案尾端。用戶端應觀察到傳輸失敗，而不是得到一份表面成功、內容混雜的檔案。

Express 預設錯誤處理也會在回應已開始時結束連線。本課保留自己的終端錯誤出口，明確呼叫 res.destroy；若使用框架的預設出口，則應採用官方文件中的 headersSent 分支轉交方式，不要兩種都做。[Express 預設錯誤處理](https://expressjs.com/en/guide/error-handling/#the-default-error-handler)

## 10.6 日誌和公開回應是兩個用途

本章 `HTTP_ERROR` 只記錄 requestId、正規化後的 status／code 與 phase。這足以觀察錯誤走哪一條路，不會把原始例外內容直接送出。

有一個重要差別：若 phase 是 streaming，report 裡的 status 500 代表錯誤分類，不代表已送出的 HTTP 200 被改成 500。

這仍是教學用的最小觀察。正式的內部堆疊、遮蔽規則、日誌傳輸與告警，會在 24 章處理；不要因為看到了 HTTP_ERROR，就認為已經具備完整的故障診斷系統。記錄 callback 本身也應保持簡單、不可任意拋錯。

未處理的程序層錯誤不是普通 HTTP 400。不要加一個全域 handler 把錯誤吞掉後繼續接受流量，假裝程式仍處於可信狀態；這也不能取代請求與背景工作的錯誤責任。

## 10.7 Supertest 測的是可觀察的 HTTP 行為

Supertest 可接收 Express app 或 Node HTTP server，使用鏈式 API 描述請求與預期結果。[Supertest 官方 README](https://github.com/forwardemail/supertest)

```ts
const result = await supertest(server)
  .post('/api/articles')
  .send({ title: '契約', content: '內容' })
  .expect(201);

expect(result.headers.location).toBe(`/api/me/articles/${result.body.data.id}`);
expect(result.body.data.status).toBe('draft');
```

本章的文章測試先將 server 監聽於系統分配的連接埠 0，避免固定連接埠衝突。每個案例有自己的 Map，結束時 await 關閉流程。

不要只測「沒有 throw」：呼叫端真正依賴的是狀態碼、標頭、body 與資料效果。也不要快照整份動態回應，把 UUID、時間與 request ID 固定成容易碎裂的比較；應針對契約欄位斷言。

### Promise 測試一定要等待

測試函式使用 async／await 等待 HTTP 請求。不能啟動請求後直接讓測試返回，也不要混用 done callback 與回傳 Promise，造成成功或失敗被回報兩次。

需要壓力、連線中斷、串流或未完成上傳時，仍保留 `node:http` 的底層測試。換成 Supertest 不表示要刪掉前面章節已建立的特殊傳輸驗證。

## 10.8 把契約和儲存實作分開

[api-contract.ts](examples/10/test/api-contract.ts) 接受 `getServer()`，註冊以下共同案例：

1. 建立草稿、Location、公開不可見、修改、發佈、封存。
2. JSON、schema、404、405 與版本衝突的錯誤分類。
3. 公開分頁與 HEAD 沒有 body。

[api.test.ts](examples/10/test/api.test.ts) 負責建立記憶體 server。下一章保留同一份契約內容，只換成 PostgreSQL 的測試準備與清理。

這並不是把所有測試都抽象化。10 章的「不同 Map 不共享資料」屬於記憶體實作特性；11 章必須另外測「不同實例可讀到同一份資料」。共用測試應描述真正穩定的對外契約。

## 10.9 用隔離 app 演練錯誤

[error-contract.test.ts](examples/10/test/error-contract.test.ts) 建立只供測試的 Express app，沒有把故障開關加入正式文章路由。

| 案例 | 驗證結果 |
|------|----------|
| 同步 throw、async rejection | 穩定的 JSON 500 與 request ID |
| callback／EventEmitter error | 已轉交錯誤出口，請求能結束 |
| 可預期 HttpError | 保留 409 與公開 code |
| 任意物件自帶 status／message | 不直接當成可信的公開錯誤 |
| 傳到一半失敗 | Supertest 觀察到傳輸失敗，phase 為 streaming |
| 已 end 後再交出錯誤 | 仍只有原本的一份成功回應 |

本章共 **89 項 Jest 測試**：保留前章 78 項，再加入 8 項錯誤情境與 3 項共用契約。`npm run check` 同時驗證型別、建置及真實子程序的停止信號。

## 10.10 常見問題、練習與驗收

| 現象 | 優先檢查 |
|------|----------|
| async handler 錯誤沒有進 middleware | Promise 是否有 return／await？是否離開請求鏈？ |
| callback 失敗讓程序退出 | 是否在 callback 內 throw，而不是 next(error)？ |
| 測試通過後才出現錯誤 | 是否忘記 await 請求？ |
| Cannot set headers after they are sent | 是否送出後仍 next，或第二個錯誤路徑又回應？ |
| Jest 跑完不退出 | server、timer 或其他資源是否由測試回收？ |
| 錯誤回應含 SQL／路徑 | 是否直接序列化原始 Error？ |

### 練習一：分清格式錯誤與狀態衝突

分別傳入 expectedVersion 為字串 `"1"` 與數字 `99`，確認前者為 400，後者為 409，並從 REQUEST_TRACE 找出是否進入文章 handler。

### 練習二：為什麼已送出的 200 改不掉？

閱讀 partial 測試及 errors.ts 的 streaming 分支，說明為什麼這裡不應斷言收到一份 JSON 500。

### 練習三：新增一條失敗契約

為「發布已封存文章」補一個 Supertest 案例，確認 409、錯誤 code、資料版本維持不變。不要讓案例依賴上一個測試留下的文章。

### 本章完成檢查

- [ ] 能指出四種錯誤來源各由誰轉交。
- [ ] 已知錯誤與未知錯誤具有不同的對外處理規則。
- [ ] 能解釋傳輸開始後只能中斷、不能追加 JSON。
- [ ] Supertest 案例有 await，服務與資源確實清理。
- [ ] 能指出哪些契約適合沿用到資料庫實作。
- [ ] 已通過 `npm run check`。

下一章：[PostgreSQL、Prisma 與 migration](11-postgres-prisma-and-migrations.md)，將同一份 API 的資料從 Map 搬到資料庫。

---

[上一章：Middleware 與驗證](09-middleware-order-and-input-validation.md) · [返回課程總覽](README.md) · [本章範例](examples/10/README.md)
