# 00 — 課程地圖、執行環境與專題契約

> 先回答「程式在哪裡執行、誰能做什麼、成功與失敗如何呈現」，再開始選路由與框架。

本章使用 JavaScript 基礎與少量 HTTP 概念。你只需要能執行終端機指令，並有可運作的 Docker；不必先在電腦安裝 Node.js、Express 或 NestJS。

完成本章後，你應能：

- 分清 JavaScript、Node.js、Express、NestJS 與 Docker 的角色。
- 畫出瀏覽器、API 與資料庫的責任與資料流。
- 用 Docker 執行範例，觀察 Node 與瀏覽器提供的能力。
- 根據文章狀態與使用者身分，判斷操作是否允許。
- 將需求寫成可驗收的 API 成功與失敗契約。

**本章交付的是專題規格與可執行的規則練習。** 下文的 HTTP 範例是後續實作目標，目前還沒有可呼叫的 API、登入機制或資料庫。第一個 HTTP 服務會在 05 章建立。

閱讀後續成果時，請以 [13 章遷移基準](examples/13/BASELINE.md) 確認已完成範圍：目前作者固定為 u_demo，尚無登入授權；非法狀態代碼為 INVALID_STATE，而本章最終規格預定為 INVALID_ARTICLE_STATE。框架遷移先保留現有契約，名稱與認證要求的變更須另行記錄。

## 00.1 從一個容易漏掉的問題開始

假設你已經做出文章編輯頁面，只有作者能看見「儲存」按鈕。Bob 看不到 Alice 的按鈕，是否代表他不能修改 Alice 的文章？

不能這樣判斷。Bob 可以離開你的畫面，直接送出 HTTP 請求。伺服器需要自行確認：

1. 這個請求的使用者是誰？
2. 文章是否存在，是否屬於他？管理員有什麼額外權限？
3. 文章現在是否允許修改？
4. 輸入是否合法？使用者是否正拿舊版本覆蓋新資料？

框架能協助組織這些檢查，但不會替專題決定答案。本課會先訂出規則，再依序用原生 Node、Express、NestJS 實作。

## 00.2 這些名稱各自負責什麼？

| 名稱 | 角色 | 本課如何使用 |
|------|------|--------------|
| JavaScript | 程式語言 | 寫函式、物件、Promise 與業務規則 |
| Node.js | 在瀏覽器之外執行 JavaScript 的環境 | 啟動 HTTP 服務、讀寫檔案、連接資料庫 |
| npm | 套件與專案指令工具 | 安裝依賴、執行建置與測試指令；01 章開始使用 |
| TypeScript | 為 JavaScript 加上型別檢查的語言與工具 | 協助開發時檢查；外部輸入仍要在執行期驗證 |
| Express | HTTP 應用框架 | 看清路由、middleware、錯誤與回應的流程 |
| NestJS | 提供 Module、Controller、Provider 等結構的應用框架 | 練習依賴注入、模組邊界與正式專案整合 |
| Docker | 以映像檔建立容器，提供執行環境 | 本章執行 Node；11 章啟動資料庫；26 章練習服務部署 |
| PostgreSQL | 關聯式資料庫 | 保存使用者、文章、留言與 Session 等資料 |

TypeScript 的型別不能阻止使用者送出錯誤 JSON。例如程式將 `title` 宣告為 `string`，外部請求仍可能傳入數字。驗證工作會在 Express 09 章與 NestJS 17 章具體實作。

Express 也能建立正式服務；本課先用它呈現請求流程，再用 NestJS 練習另一層專案組織方式。完整階段安排見[課程總覽](README.md)。

### 相同語言，不代表相同執行環境

| 能力 | 一般瀏覽器頁面 | 本章的 Node.js 24 |
|------|----------------|------------------|
| `window`、`document` | 可操作頁面與 DOM | 預設沒有這兩個全域物件 |
| `fetch` | 可送出 HTTP 請求，受瀏覽器安全規則約束 | 可送出 HTTP 請求；不因此具備 DOM |
| `process` | 一般頁面沒有 Node 的 `process` | 可取得程序與環境資訊 |
| `node:fs` | 不能直接載入 Node 的檔案系統模組 | 可依執行權限存取檔案 |

因此，在 Node 裡直接寫 `document.querySelector(...)` 會失敗；把資料庫密碼放進前端程式，也不會因為使用 TypeScript 就變成秘密。兩種環境的差異可對照 [Node.js 官方說明](https://nodejs.org/en/learn/getting-started/differences-between-nodejs-and-the-browser)。

## 00.3 一個請求經過哪些地方？

假設你在網站上點開一篇已發佈的文章。畫面上的標題與內容，是怎麼從資料庫來到瀏覽器的？先認識三個參與者：

- **瀏覽器**：執行前端程式，向後端取得資料，再把資料顯示成畫面。
- **Node API**：我們接下來要寫的後端程式。API 是提供給其他程式呼叫的介面；這裡透過 HTTP 接收請求，判斷可以提供哪些資料。
- **PostgreSQL**：保存文章的資料庫，依照後端的查詢找出資料。

依序閱讀以下文字流程；每一步都標出負責的參與者：

```text
1. 瀏覽器 → API：請給我這篇文章
2. API：檢查請求中的文章 ID
3. API → PostgreSQL：查詢這個 ID 的已發佈文章
4. PostgreSQL → API：回傳找到的文章資料
5. API → 瀏覽器：回傳成功狀態與 JSON 文章資料
6. 瀏覽器：把標題與內容顯示在畫面上
```

對照實際程式，這六步會是：

1. 前端送出 `GET /api/articles/a_1001`，表示「我要讀取 ID 為 `a_1001` 的文章」。
2. 後端檢查請求格式。這是公開閱讀端點，所以不要求先登入。
3. 後端向資料庫查詢，條件包含「ID 相符」與「狀態是已發佈」，避免讀出草稿或封存文章。
4. 資料庫把符合條件的資料交給後端，不會直接替瀏覽器畫出頁面。
5. 後端挑選可公開的欄位，透過 HTTP 回傳 `200` 與 JSON 格式的文章資料。
6. 前端收到 JSON 後，才把資料放到畫面上的標題與內文區域。

圖中示範的是成功路徑。如果第 3 步找不到符合條件的文章，後端就回傳 `404`，前端顯示「找不到文章」。因此，前端要處理成功與失敗兩種回應；瀏覽器也不需要直接連接資料庫。

理解資料怎麼往返後，再整理三者的責任：

| 邊界 | 應負責 | 不能依賴它完成的事 |
|------|--------|--------------------|
| 瀏覽器 | 顯示資料、收集輸入、提示錯誤 | 單靠隱藏按鈕保護資料權限 |
| API | 驗證輸入、確認身分與權限、執行業務、決定回應 | 信任用戶端聲稱的角色或作者 ID |
| 資料庫 | 持久化、約束、交易與查詢 | 從任意 HTTP 請求自動推導完整業務權限 |

例如新增文章時，瀏覽器只送標題與內容。API 從已驗證的 Session 得到作者身分，檢查輸入後才寫入資料庫。回應可以包含 `authorId`，但不能包含密碼雜湊、資料庫連線字串或 Session 憑證。

Express 與 NestJS 都在圖中的 API 位置。把路由改成 Controller，不會讓瀏覽器、API、資料庫的責任自動改變。

## 00.4 先用 Docker 執行第一個練習

### 本章的檔案與執行方式

本章只有一個可執行檔：[runtime-and-contract.mjs](examples/00/runtime-and-contract.mjs)。它使用 Node 內建的斷言工具，沒有第三方依賴，也不需要 `npm install`。`.mjs` 表示使用 ECMAScript Module；02 章再深入模組規則。

這裡使用與 01 章相同的固定映像，提供 Node **24.22.1** 與 npm **11.19.1**。`node:24-bookworm-slim` 後面加上 digest，避免可移動的 tag 日後指向不同修補版本。01 章會再解釋版本檔與 lockfile；現在可直接複製指令。

以下指令適用於 Bash／zsh。請先開啟 Docker Desktop 或啟動 Docker Engine，再在**倉庫根目錄 `learnbyai`** 執行：

```bash
docker version
docker compose version
docker pull node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
```

`docker version` 應顯示 Client 與 Server；只有 Client 不代表容器引擎已可使用。01 章開始用 Compose 執行工具容器，11 章再加入資料庫，本章先確認工具存在。

接著執行：

```bash
docker run --rm --network none \
  --mount "type=bind,source=${PWD}/nodejs-course/examples/00,target=/work,readonly" \
  --workdir /work \
  node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 \
  node runtime-and-contract.mjs
```

| 指令片段 | 意義 |
|----------|------|
| `--rm` | 程式結束後移除這次的容器；下載的映像檔仍保留 |
| `--network none` | 範例執行時不使用外部網路；前面的下載仍需要網路 |
| `--mount ... readonly` | 把本章範例目錄唯讀掛進容器的 `/work` |
| `--workdir /work` | 在容器的 `/work` 目錄執行指令 |
| `node runtime-and-contract.mjs` | 使用容器內的 Node 執行程式 |

使用上面的固定映像，成功輸出如下：

```text
執行環境： {"node":"v24.22.1","window":"undefined","document":"undefined","fetch":"function","process":"object"}
PASS：4 項環境檢查、7 項權限案例、6 項狀態轉換案例
本章尚未啟動 HTTP 服務，也沒有建立資料庫。
```

程式結束回到命令提示字元是正常結果。這是一次性的練習，不是持續監聽連接埠的服務。

也可以在一般瀏覽器頁面的開發者工具 Console 觀察：

```js
({
  window: typeof window,
  document: typeof document,
  fetch: typeof fetch,
  process: typeof process,
})
```

一般頁面的 `window`、`document` 是 `object`，`fetch` 是 `function`，`process` 是 `undefined`。若網站自行提供同名變數，結果可能不同；比較時可使用空白頁面。

### 容器與資料的幾個基本觀念

- **Image（映像檔）**：建立容器使用的環境，例如本章的 Node 映像檔。
- **Container（容器）**：由映像檔建立的執行實例；停止、移除容器與刪除映像檔是不同操作。
- **Bind mount**：把主機上的指定目錄掛入容器；本章用它讀取程式碼。
- **Volume**：由 Docker 管理的資料儲存空間；之後用來保存資料庫資料。資料可跨容器生命週期保留，但仍需要另外備份。[Docker volumes 文件](https://docs.docker.com/engine/storage/volumes/)

11 章主要以 Compose 同時執行 API 與 PostgreSQL，也提供主機 Node 路線。該章把主機的 `15411` 映射到資料庫容器的 `5432`，連線位置會是：

| 誰在連資料庫 | 連線位置範例 |
|--------------|--------------|
| 主機上的 Node API | `127.0.0.1:15411` |
| 同一 Compose 網路中的 API 容器 | `postgres:5432`，假設資料庫服務名為 `postgres` |
| 瀏覽器 | 不直接連資料庫；呼叫 API |

這是 11 章的環境預覽，**本章尚未建立這些服務或連接埠映射**。各章使用自己的主機端口，請依該章範例操作。容器內的 `localhost` 指向該容器自己的網路環境，不是自動指向你的主機或另一個容器。[Docker 網路文件](https://docs.docker.com/engine/network/)

## 00.5 用使用者故事固定專題範圍

我們要建立「文章與留言管理 API」。先用三個角色描述最終行為：

| 角色 | 使用者故事 | 驗收重點 |
|------|------------|----------|
| 訪客 | 我想瀏覽已發佈文章與留言 | 公開列表與詳情都不能洩漏草稿或封存文章 |
| Alice（會員） | 我想寫草稿、修改自己的文章，再發佈或封存 | 作者由登入身分決定；狀態轉換必須合法 |
| Bob（另一位會員） | 我想在公開文章下留言，並刪除自己的留言 | 不能修改 Alice 的文章或刪除她的留言 |
| 管理員 | 我想查看非公開文章、處理文章與違規留言 | 額外權限要明文定義，仍須遵守文章狀態規則 |
| 已登入使用者 | 我想登出，讓舊 Session 失效 | 不是只清除畫面上的登入狀態 |

認證主線使用 Cookie 與伺服器端 Session。瀏覽器攜帶 Session 憑證，API 查驗後取得使用者身分；Cookie 的保護設定、CSRF、密碼雜湊與撤銷會在 18 章實作。

### 最小資料模型

| 資料 | 本課關心的欄位與用途 |
|------|----------------------|
| User | `id`、登入識別、密碼雜湊、`role`；一般註冊者固定為會員 |
| Article | `id`、`authorId`、`title`、`content`、`status`、`version`、建立與更新時間 |
| Comment | `id`、`articleId`、`authorId`、`content`、建立時間 |
| Session | 使用者關聯、到期與撤銷資訊；具體憑證儲存方式在認證章設計 |
| AuditLog | 操作者、文章、動作、前後狀態與時間，供追查狀態變更 |

此處先定義業務資料，不急著寫 ORM schema。範例中的 `u_alice`、`a_1001` 都是示意 ID；用戶端應把 ID 當作不透明字串，不應從格式推導權限。

## 00.6 狀態與權限要分開考慮

### 文章狀態

```text
建立文章 → draft（草稿）
draft → publish → published（已發佈）
draft 或 published → archive → archived（已封存）
archived → 不可編輯、重新發佈或再次封存
```

本課明確採用以下規則：

1. 新文章一定是 `draft`；作者可編輯自己的草稿與已發佈文章。
2. `publish` 只接受草稿；`archive` 接受草稿或已發佈文章。
3. 封存後不公開，也不能繼續修改或重新發佈；管理員同樣遵守。
4. 重複發佈、重複封存等非法轉換回傳 `409`。
5. 文章使用封存保留資料，主線不另做永久刪除文章；留言則提供刪除操作。

這些是本專題的產品決定，不是所有內容系統都必須採用的通則。若之後要增加「復原封存」，應一起修改規格、程式與測試。

### 權限矩陣

| 操作 | 訪客 | 文章／留言擁有者 | 其他會員 | 管理員 |
|------|------|------------------|----------|--------|
| 從公開端點讀已發佈文章 | 可以 | 可以 | 可以 | 可以 |
| 讀草稿／封存文章 | 不行 | 經自己的管理端點 | 不行 | 經管理員端點 |
| 建立草稿 | 不行 | 可以 | 可以，建立自己的 | 可以，建立自己的 |
| 修改、發佈、封存文章 | 不行 | 可以，但須符合狀態 | 不行 | 可以，但須符合狀態 |
| 在已發佈文章下留言 | 不行 | 可以 | 可以 | 可以 |
| 刪除留言 | 不行 | 可以刪自己的留言 | 不可刪別人的留言 | 可以刪任何留言 |

文章作者沒有刪除他人留言的額外權限。文章封存後不能新增留言，但留言作者與管理員仍可刪除既有留言。

範例程式中的 `canEditArticle` 把身分與狀態合併成「是否能編輯」的布林判斷，適合先練規則；正式 API 還要分辨未登入、無權限、狀態不符，才能回傳不同錯誤。程式內的 `actor` 是可信的測試資料，不能改成直接相信 request body 的 `role` 或 `id`。

## 00.7 把需求寫成 HTTP 契約

契約是呼叫端與服務共同遵守的可觀察行為，包括路徑、輸入、輸出與失敗結果。它不應依賴後端目前使用 Express 還是 NestJS。

以下是**專題完成時的目標契約**；各階段落實範圍見 00.9。為了讓規格可閱讀，先列主要操作，詳細欄位與 OpenAPI 在後續章節補齊。

### 主要端點

| 方法與路徑 | 行為 | 成功狀態 |
|------------|------|----------|
| `GET /health/live` | 確認程序可回應；不代表資料庫已就緒 | `200` |
| `POST /api/auth/register` | 註冊會員；不接受自行指定管理員角色 | `201` |
| `POST /api/auth/login` | 驗證登入資料，建立 Session 與 Cookie | `200` |
| `POST /api/auth/logout` | 撤銷目前 Session 並清除 Cookie；已無有效 Session 也可完成登出 | `204` |
| `GET /api/auth/me` | 取得目前登入者的公開個人資料 | `200` |
| `GET /api/articles` | 公開文章列表，可分頁 | `200` |
| `GET /api/articles/:id` | 公開文章詳情；非公開或不存在都回 `404` | `200` |
| `GET /api/me/articles` | 登入者自己的文章列表，含草稿與封存 | `200` |
| `GET /api/me/articles/:id` | 登入者自己的文章；不屬於自己或不存在回 `404` | `200` |
| `GET /api/admin/articles/:id` | 管理員查閱任意狀態的文章 | `200` |
| `POST /api/articles` | 建立自己的草稿 | `201` |
| `PATCH /api/articles/:id` | 修改標題或內容，需 `expectedVersion` | `200` |
| `POST /api/articles/:id/publish` | 發佈草稿，需 `expectedVersion` | `200` |
| `POST /api/articles/:id/archive` | 封存文章，需 `expectedVersion` | `200` |
| `GET /api/articles/:id/comments` | 查公開文章的留言；文章非公開或不存在回 `404` | `200` |
| `POST /api/articles/:id/comments` | 登入者留言；文章非公開或不存在回 `404` | `201` |
| `DELETE /api/comments/:id` | 留言作者或管理員刪除留言；不存在回 `404` | `204` |

公開端點對所有角色都只提供公開資料。即使 Alice 已登入，讀自己的草稿也要走 `/api/me/articles/:id`，讓「公開查詢」的語意一致。

文章寫入端點先確認登入與輸入，再查文章：不存在回 `404`；存在但不是作者或管理員回 `403`；通過授權後才檢查版本與狀態。這是本課刻意選擇的錯誤規則，後續測試應固定它。

### 新增文章：請求與成功回應

以下 HTTP 片段是規格示意，不是本章已啟動的服務。已登入的 Alice 送出：

```http
POST /api/articles HTTP/1.1
Content-Type: application/json
Cookie: session=<有效的 Session 憑證>

{
  "title": "我的第一篇文章",
  "content": "先把責任與契約說清楚。"
}
```

`title` 與 `content` 必須是字串，去除首尾空白後不能為空。`authorId`、`role`、`status`、`version` 等非允許欄位一律拒絕，回傳 `400`；不要把整份 body 直接交給資料庫更新。05 章起使用 title 120、content 4000 個 Unicode code point 與 body 16 KiB 上限；09 章再以 Zod 表達欄位規則。

成功回應：

```http
HTTP/1.1 201 Created
Content-Type: application/json
Location: /api/me/articles/a_1001

{
  "data": {
    "id": "a_1001",
    "authorId": "u_alice",
    "title": "我的第一篇文章",
    "content": "先把責任與契約說清楚。",
    "status": "draft",
    "version": 1,
    "createdAt": "2026-01-01T09:00:00.000Z",
    "updatedAt": "2026-01-01T09:00:00.000Z"
  }
}
```

`Location` 指向作者可讀的管理端點，因為新草稿尚未公開。ID、作者、狀態、版本與時間均由伺服器決定；時間以 UTC 格式傳輸，畫面再轉成本地時區。

### 更新與版本衝突

修改文章時，除了至少一個可修改欄位，還要附上讀取時看到的版本：

```json
{
  "title": "修訂後的標題",
  "expectedVersion": 1
}
```

`expectedVersion` 必須是正整數。成功後 `version` 加一，回傳更新後的文章；發佈與封存同樣要求版本並在成功時加一。當前狀態與版本檢查都通過後，才能寫入資料。

假設 Alice 開了兩個分頁，都讀到版本 1。第一個儲存成功後變成版本 2，第二個仍傳 1，就應收到 `409 VERSION_CONFLICT`。前端應提示重新載入或合併，而不是默默覆蓋第一個分頁的內容。

真正避免併發覆蓋需要在資料庫寫入時原子比對版本；「先 SELECT，再不帶條件地 UPDATE」仍可能出錯。11–13 章已用帶 id、version、status 條件的 UPDATE 與不同 pool 併發測試，驗證單篇文章的更新保證；20 章再擴充文章與稽核等跨資料交易。

### 列表回應

列表使用 `page`、`pageSize`，預設分別為 1、20，`pageSize` 上限為 100；必須為範圍內的整數，無效值回 `400`。排序固定為建立時間由新到舊，再以 ID 降冪打破同時間的平手。

例如公開列表 `GET /api/articles?page=1&pageSize=20` 在沒有公開文章時回傳：

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "total": 0
  }
}
```

`total` 只計算符合該查詢可見範圍的資料，不能透過公開列表的數量洩漏非公開文章。相同結構用於自己的文章列表與公開留言列表；21 章再討論分頁期間資料變動與查詢成本。

### 失敗也需要固定格式

例如未授權欄位造成的驗證錯誤，其 JSON body 為：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "輸入驗證失敗",
    "details": [
      { "field": "body", "code": "UNKNOWN_FIELDS", "message": "包含不允許的欄位" }
    ]
  },
  "requestId": "req_example"
}
```

前端以穩定的 `code` 分支處理，不應依賴會調整措辭的 `message`。`details` 沒有可公開的欄位資訊時使用空陣列；`requestId` 用來對照日誌，不是身分憑證。

此處 details 與 09–13 章一致，使用 field／code／message；未知欄位指向所屬物件，不回傳用戶原始欄位名稱或值。錯誤 body 的 requestId 與回應標頭 X-Request-ID 相同。

| 狀態碼 | 本課的使用情境 | 錯誤代碼範例 |
|--------|----------------|--------------|
| `400` | JSON 格式錯誤、缺少欄位、型別或欄位不合法 | `INVALID_JSON`、`VALIDATION_ERROR` |
| `401` | 受保護操作缺少有效登入；Session 到期或撤銷 | `UNAUTHENTICATED` |
| `403` | 已登入，但沒有操作權限 | `FORBIDDEN` |
| `404` | 資源不存在，或在該查詢端點不可見 | `NOT_FOUND` |
| `409` | 文章版本衝突、非法狀態轉換、重複註冊識別 | `VERSION_CONFLICT`、`INVALID_ARTICLE_STATE`、`USER_ALREADY_EXISTS` |
| `500` | 未預期的內部錯誤 | `INTERNAL_ERROR` |
| `503` | 服務因必要依賴不可用而暫時無法處理 | `SERVICE_UNAVAILABLE` |

成功的單筆資料用 `{ "data": ... }`，列表另附 `meta`；`204` 不帶 response body。錯誤回應不提供堆疊、SQL、密碼或憑證，詳細原因留在適當遮蔽的伺服器日誌。

## 00.8 把契約改寫成驗收案例

驗收要描述「給定什麼狀態、做什麼操作、應看到什麼結果」。先寫下這些案例，後續才知道重構有沒有改壞行為。

| 給定條件與操作 | 應觀察到的結果 | 主要實作階段 |
|----------------|----------------|--------------|
| 資料中只有草稿與封存文章，查詢公開列表 | `200`，`data` 為空、`total` 為 0 | 08–10、21 |
| 從公開詳情端點查草稿 | `404`，作者也須改用自己的管理端點 | 08–10、18 |
| 新增文章時 `title` 是數字 | `400 VALIDATION_ERROR`，沒有新增資料 | 09–10 |
| 新增文章時夾帶 `authorId` | `400 VALIDATION_ERROR`，不能指定他人為作者 | 09–10、18 |
| 訪客新增文章 | `401 UNAUTHENTICATED` | 18 |
| Bob 修改 Alice 的既有文章 | `403 FORBIDDEN`，文章不變 | 18 |
| Alice 以正確版本發佈自己的草稿 | `200`，狀態變為 `published`，版本加一 | 08–13、20 |
| 管理員以正確版本修改封存文章 | `409 INVALID_ARTICLE_STATE`，文章不變 | 18–20 |
| 同一篇文章同時收到兩個相同版本的更新 | 一個成功，另一個 `409 VERSION_CONFLICT` | 11–13；20、22 深化 |
| 狀態變更時，稽核紀錄寫入失敗 | 狀態與版本回滾，不留下半套結果 | 20、22 |
| Bob 刪除 Alice 的留言 | `403 FORBIDDEN`，留言仍存在 | 18、28 |
| 留言作者刪除自己的留言後再次刪除 | 第一次 `204` 且無 body，第二次 `404` | 28 |
| 登出後拿原本 Session 呼叫 `/api/auth/me` | `401 UNAUTHENTICATED` | 18、22 |

回傳成功不代表已驗證資料保存正確。涉及寫入的案例還要檢查資料庫結果；涉及權限拒絕的案例，則要確認資料沒有被修改。

本章範例目前只執行 **4 項環境、7 項編輯權限、6 項狀態轉換檢查**。上表是專題驗收目標，還不是已通過的 HTTP 或資料庫測試。

## 00.9 同一份專題如何逐步實作？

| 階段 | 新增能力 | 當階段的界線 |
|------|----------|--------------|
| 00 | 契約、權限矩陣、純函式規則與環境練習 | 沒有 HTTP 服務、Session、資料庫 |
| 01–07 | 工具、模組、非同步、原生 HTTP、資源與程序 | HTTP 練習先回固定資料，建立請求與回應的理解 |
| 08–13 | Express 文章 CRUD、驗證、錯誤、PostgreSQL、分層與測試 | 先用固定的示範使用者；僅供本機學習；凍結已實作的契約子集 |
| 14–16 | 把同一份 CRUD 搬到 Nest Controller、Provider、Module | 沿用資料模型與測試，不同時加入登入要求 |
| 17–23 | Nest 驗證、Session、權限、交易、併發、文件與整合測試 | 明確加入新的成功與失敗條件，逐項落實最終契約 |
| 24–29 | 觀測、效能、部署、前端與完整專題驗收 | 整合留言等功能並演練失敗情境 |

例如 08–10 章先在單一程序的 Map 檢查 `expectedVersion`，11–13 章再以 PostgreSQL 條件更新與併發測試驗證跨 pool 行為。20 章擴大交易情境；不能把單一請求或測試替身通過，當作已驗證資料庫競爭問題。

遷移 Nest 時保留的是「13 章已完成的行為」，不是宣稱從第一個 Express 路由起就具備最終所有功能。18 章新增認證後，原本能直接呼叫的寫入測試會改成先登入，並補上未登入與越權測試。

## 00.10 常見問題與練習

### 常見問題

| 現象或誤解 | 檢查方式或修正方向 |
|------------|--------------------|
| Docker 顯示無法連接 daemon 或 socket 權限錯誤 | 確認引擎啟動、目前使用者可存取 Docker；尚未進入 Node 程式 |
| 找不到映像檔或拉取失敗 | 先確認網路可完成 `docker pull`；範例執行本身才停用網路 |
| 掛載來源不存在、找不到 `.mjs` | 確認從倉庫根目錄執行，`${PWD}/nodejs-course/examples/00` 必須存在 |
| 有 `fetch`，所以 Node 應該也能操作網頁 | `fetch` 是 HTTP 能力，DOM 是另一組環境能力 |
| 容器跑完立刻消失，是否啟動失敗？ | 本章程式執行完即結束，`--rm` 會移除容器；查看輸出與結束狀態 |
| 管理員可以跳過所有規則 | 管理員有額外資料權限，但仍不能編輯封存文章 |
| TypeScript 有型別就不需要驗證 JSON | 型別檢查不能約束外部請求，必須有執行期驗證 |
| 在畫面禁用按鈕就算完成授權 | 伺服器仍需驗證每次操作，並以直接 HTTP 請求測試越權 |

### 練習一：找出責任放錯的位置

以下設計有哪些問題？

1. 瀏覽器新增文章時送出 `{ "title": "Hello", "content": "World", "authorId": "u_alice" }`。
2. 前端判斷使用者是管理員，便在 body 加入 `role: "admin"`。
3. API 將輸入直接傳給資料庫，因為 TypeScript 介面已經定義好。

<details>
<summary>參考答案</summary>

作者與角色應由伺服器查驗身分後決定，不能從 body 取得。本課會拒絕這些額外欄位。API 還需要驗證輸入、確認資料擁有者與狀態，再用明確挑選的欄位執行寫入；TypeScript 介面不會驗證收到的 JSON。

</details>

### 練習二：判斷回應

請先寫出狀態碼，再對照規格：

1. 訪客呼叫新增文章。
2. Bob 以合法輸入修改 Alice 的既有文章。
3. Alice 從公開端點讀自己的草稿。
4. Alice 已通過授權，但更新時帶的是舊版本。
5. 管理員用正確版本重新發佈已封存文章。
6. 留言作者成功刪除自己的留言。

<details>
<summary>參考答案</summary>

依序為 `401`、`403`、`404`、`409 VERSION_CONFLICT`、`409 INVALID_ARTICLE_STATE`、`204`。最後一項不應再回傳 JSON body。

</details>

### 練習三：讓規則變得可驗證

打開範例的 `permissionCases`，補上「管理員能修改別人的已發佈文章」案例，預期為 `true`，再執行 Docker 指令。權限案例數應從 7 變為 8。

接著暫時把這個案例的預期值改成 `false` 再執行，確認會出現 `AssertionError` 並以非零狀態結束。最後恢復正確值。這能確認你的驗證真的會對錯誤結果失敗。

### 本章完成檢查

- [ ] 能解釋為什麼 Node 有 `fetch`，卻沒有 `document`。
- [ ] 能畫出瀏覽器 → API → 資料庫，並指出授權應在哪裡執行。
- [ ] 已用 Docker 執行範例，看到環境與規則檢查通過。
- [ ] 能區分角色權限、文章狀態與版本衝突。
- [ ] 能依規格判斷 `400`、`401`、`403`、`404`、`409`。
- [ ] 知道本章規格與後續實作的差別，沒有把純函式檢查當作 HTTP／資料庫驗收。

下一章：[01 — Node 版本、npm、TypeScript 建置與專案入口](01-runtime-tooling-and-project-setup.md)，將建立可安裝、建置、執行與測試的專案。

---

[返回課程總覽](README.md) · [查看本章可執行範例](examples/00/runtime-and-contract.mjs)
