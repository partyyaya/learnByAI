# 13 — Express 專題驗收與 NestJS 遷移基準

> 我們已經有資料庫、分層與測試。進入下一個框架前，先回答一個問題：換完之後，要用什麼證明使用者仍能完成同一件事？本章把文章 API 收成一個可重建、可驗收的 Express 快照，並留下能帶到 NestJS 的契約測試。

## 13.1 本章目標與前置知識

完成本章後，你應能：

- 以使用者操作驗收完整垂直切片：HTTP → 驗證 → 業務 → 資料庫 → HTTP 回應。
- 列出目前真正完成的契約，區分最終規劃與當前行為。
- 使用同一組 HTTP 測試驗證不同組裝方式，而不綁住 Express 或 Prisma 內部函式。
- 解釋測試資料如何建立、重設與清理，並確認不同 fixture 互不影響。
- 從 Docker 乾淨環境完成建置、測試、migration、seed、API 操作與停止。
- 說明 Express 已經解決什麼、哪些工程責任仍需自己管理，以及 NestJS 階段要處理的依賴與模組問題。

先完成 [11 章資料庫](11-postgres-prisma-and-migrations.md) 與 [12 章分層及手動 DI](12-service-repository-and-manual-di.md)。完整範例在 [examples/13](examples/13/README.md)，契約清單在 [BASELINE.md](examples/13/BASELINE.md)。

本章從第 12 章建立**獨立快照**。應用程式 src、Prisma schema 與 migration 維持相同內容，主要新增遷移契約、隔離測試與驗收文件。Node **24.22.1**、npm **11.19.1**、TypeScript **5.9.3**、Jest **30.2.0**、Express **5.3.0**、Zod **4.6.7**、Supertest **7.3.1**、Prisma CLI／Client／adapter-pg **7.10.1**、pg **8.23.1**、PostgreSQL **17** 全部沿用。本章尚未安裝 NestJS。

## 13.2 一個路由能回 200，不代表專題已完成

假設你把 `POST /api/articles` 搬到新框架，看到 201 與 JSON。這只能證明一條路徑有回應，還不能回答：

- 文章真的保存了嗎？服務關閉再開還找得到嗎？
- 回傳的 Location 能否讀到剛建立的草稿？
- 草稿會不會誤出現在公開列表？
- PATCH 沒提供 title 時，原標題是否保留？
- 兩個請求用相同版本修改，是否會互相覆蓋？
- 失敗後有沒有留下部分修改？
- 用戶端離線後，尚未完成的資料工作是否仍會被等待？

這些問題跨越多個檔案。因此「垂直切片」是從入口到儲存與回應都能運作的一個使用情境，不是先把所有 Controller 寫完、再補全部資料庫操作。

以「修訂文章」為例：

```text
PATCH /api/articles/:id
  → 讀取最多 16 KiB 的 JSON
  → Zod 驗證 params 與 body，把輸出放 res.locals
  → Controller 取出已驗證資料
  → Service 在交易裡檢查存在、版本、狀態
  → Repository 用 id＋version＋status 做條件 UPDATE
  → 成功讀回新版本，提交交易
  → Controller 序列化日期，回傳 200
```

任何一層失敗，都要能沿原有錯誤路徑結束，不能一面回錯誤、一面悄悄改了資料。

## 13.3 先寫出本階段的完成定義

本章驗收的是文章功能。所謂 CRUD 在這個專題中，刪除方向採「封存」，沒有永久刪除文章的 HTTP DELETE。

| 使用情境 | 成功或拒絕的觀察點 | 主要證據 |
|----------|------------------|----------|
| 建立草稿 | 201、固定作者、version 1、Location 可讀回同一筆 | 原 HTTP 契約、B01 |
| 公開與管理查詢 | 公開只有 published；管理可讀固定作者的草稿與封存文章 | B02、B04、資料庫範圍測試 |
| 修改文章 | 只改提供欄位；合法更新版本加 1 | B03、Service 測試 |
| 發佈與封存 | 合法轉換成功，封存後不可修改或再發佈 | 原 HTTP 契約、B04–B05 |
| 拒絕不合法輸入 | 400／413／415，資料保持不變 | B06–B09 |
| 保留 HTTP 邊界 | 405／Allow、HEAD、request ID、preview 與檔案匯出 | B10–B15 |
| 保存與一致性 | 重建服務仍有資料，相同版本只有一個更新成功，失敗交易回滾 | database.test.ts |
| 資源生命週期 | 等待登記工作，關閉 client；期限到時非零結束 | Controller／shutdown／程序測試 |

B01–B15 是 [migration-contract.ts](examples/13/test/migration-contract.ts) 的測試群組編號，不是 API 版本號。

作者仍固定為 `u_demo`，`/api/me` 是示範管理入口，尚無登入與授權。留言、Session、稽核、前端整合、快取、背景工作與正式部署留在後續課程。不能因為現在的寫入 API 可直接呼叫，就把它當成已具備完整權限的成品。

### 對照第 00 章時，保留「現在」與「最終目標」的差別

[第 00 章](00-course-map-and-project-contract.md) 描述整門課的最終方向。其中非法狀態的預定代碼是 `INVALID_ARTICLE_STATE`，目前 Express 實作是 `INVALID_STATE`。本章記錄並凍結當前值，純框架遷移時不改名；若之後統一名稱，要另外記錄契約變更。

另外，11–12 章已經完成真實 PostgreSQL 的單篇條件更新與併發測試。20 章會擴充交易與稽核情境，不代表之前只有記憶體版本檢查。閱讀課程地圖時，應把規劃與已完成的驗收證據一起看。

## 13.4 什麼是遷移基準？

遷移基準是一組能回答「新實作是否仍符合原有約定」的資料。本章包含三部分：

1. **可執行的舊實作**：examples/13 的應用、lockfile、Dockerfile、schema 與 migration。
2. **可重用的外部契約測試**：只從 HTTP 觀察結果，不要求內部函式名稱相同。
3. **可閱讀的契約與限制**：BASELINE.md 說明端點、輸入、回應、狀態、資料準備與尚未完成項目。

要凍結的是使用者可觀察的承諾，例如 status、Location、欄位、排序、錯誤 code、失敗後不寫入；不是把隨機 request ID、目前時間或臨時 schema 名稱硬編成快照。

例如建立文章的時間應是合法 ISO UTC 字串，但不要求每次都等於某個時間常數。ID 是不透明字串，用回應給的值繼續查詢，不要求每次建立同一個 UUID。

內部改用 Nest Controller、Provider 或另一個組裝函式，不必改變這些期待。若測試直接 spy Express handler 名稱，換框架時即使行為正確也會失敗，這就不是合適的遷移契約。

## 13.5 把契約與應用組裝分開

我們保留原本 [api-contract.ts](examples/13/test/api-contract.ts)，與第 10–12 章的內容完全相同。它提供三項核心案例：完整文章操作、錯誤分類、公開分頁與 HEAD。

新增的 [migration-contract.ts](examples/13/test/migration-contract.ts) 使用相同方式：

```ts
export function migrationContract(
  getServer: () => Server,
  exportText: string,
) {
  // 在這裡註冊 Jest 測試。
  // 每個測試執行時才呼叫 getServer()，取得當次已啟動的 Server。
}
```

這是函式輪廓；完整測試在範例檔。匯入的只有 Jest、Supertest 與 Node Server 型別，不匯入 Express、Prisma、Service 或 Repository。

為什麼傳入函式，而不是直接傳 server？因為 Jest 載入測試檔時，beforeEach 尚未啟動服務。傳 `() => server`，能讓每個測試在執行時取得自己的實例。

組裝檔 [migration-baseline.test.ts](examples/13/test/migration-baseline.test.ts) 則負責具體環境：

```text
beforeAll
  → 建立隨機 PostgreSQL schema，套用 migration
  → 建立本套測試自己的暫存 NDJSON 檔
beforeEach
  → 清理自己 schema 的文章與作者，重新 seed
  → 建立 client、Repository、Service 與 Express server
  → 監聽系統分配的臨時端口
執行同一組契約測試
  → 原有 articleContract(getServer)
  → 新增 migrationContract(getServer, exportText)
afterEach
  → shutdown server，等工作完成並關閉 client
afterAll
  → 移除自己建立的 schema 與暫存目錄
```

之後 Nest 的組裝可以不同，但 HTTP 契約函式仍可使用。Nest 官方也以 `app.getHttpServer()` 搭配 Supertest 做端到端測試；本課先把測試與組裝分離，後面再接上 TestingModule。[NestJS 測試文件](https://docs.nestjs.com/fundamentals/testing)

## 13.6 好的契約測試也會檢查「沒有發生什麼」

以 B03 為例，流程如下：

```text
讀到原文章 title、content、version 1
  → 只 PATCH content，預期 title 不變、version 2
  → 再以 version 1 PATCH title，預期 409
  → 重新 GET，預期仍等於上一個成功更新結果
```

最後一次 GET 很重要。若 API 回 409，卻已把標題寫進資料庫，只檢查狀態碼就抓不到問題。

本章也驗證：

- 非白名單欄位與不合法 PATCH 被拒絕後，文章全部公開欄位保持不變。
- preview 回傳修剪後資料，但管理列表 total 不增加。
- 建立資料庫文章後，下載的 NDJSON 仍完全等於測試準備的檔案 bytes。
- 已封存文章回 409 後，version 不會再次遞增。

HTTP 再查詢能證明外部可見狀態；資料庫是否用了同一交易，仍由 Repository 整合測試確認。兩種證據各有範圍。

### 三個特別容易漏掉的細節

**第一，限制 bytes 與驗證欄位長度是兩回事。** B09 使用合法的小 JSON，再補空白至 16 KiB，preview 應接受；超過上限回 413。這能抓出遷移時只保留 Zod 字數限制、忘了 body 上限的問題。

**第二，PATCH 的缺少與 null 不相同。** 沒有 title 代表保留；title: null 是不合法輸入。不要讓新 DTO 預設值意外清空資料。

**第三，POST 不全都建立新資源。** 建立文章回 201，preview、publish、archive 都回 200。Nest 的標準回應模式預設 POST 為 201，因此遷移時要明確處理這些操作的狀態碼。[NestJS Controller 回應狀態](https://docs.nestjs.com/controllers)

## 13.7 資料隔離要靠擁有範圍，不只靠循序執行

Jest 的 runInBand 讓同一個執行器循序跑測試，但另一個終端機仍可能同時跑一份測試。因此「測試不平行」不足以保護資料。

本章沿用 [database-fixture.ts](examples/13/test/database-fixture.ts)：

- 只讀 TEST_DATABASE_URL；缺少就失敗，不能回退到開發 DATABASE_URL。
- 資料庫名稱必須是 course_test。
- 每套 fixture 產生獨立 UUID schema，URL 裡原有 schema 不作為清理對象。
- 套用已提交的同一份 migration，記錄自己是否成功建立 schema。
- 結束時先關閉 client，最後只刪自己建立的 schema。

在自己 schema 裡，每個測試先刪 Article、再刪 User，以符合外鍵；接著重新 seed。這個測試重設流程與開發 `db:seed` 不同：開發 seed 的 update 分支為空，不覆寫已存在文章。

新增的 [database-isolation.test.ts](examples/13/test/database-isolation.test.ts) 做兩種檢查：

```text
沒有 TEST_DATABASE_URL 或資料庫名稱是 course
  → 在建立 schema 前拒絕

fixture A 與 B 都有 a_1
  → 修改 A.a_1
  → B.a_1 仍保留原值
  → 關閉 A client，刪除 A schema
  → B 仍能讀取、更新並保持三篇文章
  → 關閉 B client，刪除 B schema
```

這證明的是本測試工具的命名空間與清理行為，不是建立了資料庫權限隔離。測試帳號仍有建立／刪除 schema 的能力，所以連線位置與資料庫名稱必須另外分清楚。

Prisma 的交易能讓一組寫入成功或一起回滾，但不會替不同測試自動分配資料。交易與 fixture 隔離解決不同問題。[Prisma 7 交易文件](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)

## 13.8 Docker：執行完整驗收

從倉庫根目錄開始：

```bash
cd nodejs-course/examples/13
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose up api
```

這些命令各自負責不同階段：

```text
build tools → 固定 Node 與 OpenSSL 環境
啟動 PostgreSQL → 資料庫可接受連線
npm ci → 依 lockfile 安裝
generate → 產生 Prisma Client
型別／測試／build／程序驗證 → 確認程式與測試資料庫可運作
db:deploy → 套用開發資料庫的結構
db:seed → 補上開發資料，不覆寫已有文章
db:status → 查看 migration 是否同步
啟動 API → 通過連線與 Article 查詢才監聽
```

check 裡的 migration 是套用在隔離測試 schema，不會替開發資料庫建表。因此不能因 check 通過，就省略開發環境的 deploy。

| 用途 | 本章位址 |
|------|----------|
| 主機呼叫 API | http://127.0.0.1:3013 |
| 主機連開發 PostgreSQL | 127.0.0.1:15413 |
| tools／api 連開發 PostgreSQL | postgres:5432/course |
| tools 連測試 PostgreSQL | test-db:5432/course_test，不公開主機端口 |

本章的 Compose 專案、node_modules 與 postgres_data volume 都與前章分開。不要為了取得新資料而刪除前章 volume。

固定映像、OpenSSL、Prisma 7 與 Jest VM modules 設定沿用第 11–12 章。API 的一般 Node 啟動不需要 `--experimental-vm-modules`，測試指令已處理該旗標。

### 只執行遷移基準

先安裝依賴、generate，並啟動 test-db，再執行：

```bash
docker compose run --rm tools npm run test:baseline
```

這會重新編譯測試並執行 migration-baseline.test.js，共 **32 項案例**。若只排查某個群組，例如 B03：

```bash
docker compose run --rm tools npm run test:baseline -- --testNamePattern=B03
```

群組篩選只供開發時定位失敗；交付前仍要跑完整 check，不把被篩掉的案例當作已通過。

### 完整測試數量與證明範圍

本章共 **92 項 Jest 測試**：

| 組成 | 數量 | 說明 |
|------|------|------|
| 沿用第 12 章 | 58 | Service、Controller、資料庫、錯誤、串流與 shutdown |
| 遷移基準 | 32 | 原有 3 項 HTTP 契約＋新增 29 項；透過新的組裝入口執行 |
| 資料隔離 | 2 | URL 防護與兩套 schema 的清理邊界 |

原有三項 HTTP 契約也會在 database.test.ts 執行，所以 92 是測試執行案例數，不代表 92 種互不重複的需求。check 還另外執行建置後程序的信號測試，不包含在 Jest 數量內。

## 13.9 用實際 API 完成一輪驗收

開另一個終端機，先看 readiness，再建立一篇專用驗收草稿：

```bash
curl -i http://127.0.0.1:3013/health/ready
curl -i http://127.0.0.1:3013/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"Express 驗收","content":"先留下可重複驗證的契約。"}'
```

建立應回 201，記下 Location 與 id。以下 ID 要換成剛才的真實值：

```bash
ARTICLE_ID='貼上剛建立的文章ID'
curl -i "http://127.0.0.1:3013/api/articles/$ARTICLE_ID"
curl -i "http://127.0.0.1:3013/api/me/articles/$ARTICLE_ID"
curl -i -X PATCH "http://127.0.0.1:3013/api/articles/$ARTICLE_ID" \
  -H 'Content-Type: application/json' \
  --data '{"content":"只改內文，標題應保留。","expectedVersion":1}'
curl -i -X POST "http://127.0.0.1:3013/api/articles/$ARTICLE_ID/publish" \
  -H 'Content-Type: application/json' --data '{"expectedVersion":1}'
curl -i -X POST "http://127.0.0.1:3013/api/articles/$ARTICLE_ID/publish" \
  -H 'Content-Type: application/json' --data '{"expectedVersion":2}'
curl -I "http://127.0.0.1:3013/api/articles/$ARTICLE_ID"
curl -i -X POST "http://127.0.0.1:3013/api/articles/$ARTICLE_ID/archive" \
  -H 'Content-Type: application/json' --data '{"expectedVersion":3}'
curl -i "http://127.0.0.1:3013/api/articles/$ARTICLE_ID"
curl -i "http://127.0.0.1:3013/api/me/articles/$ARTICLE_ID"
```

預期依序是：404、200、200（version 2）、409 VERSION_CONFLICT、200（version 3）、HEAD 200 無 body、200（version 4）、404、200（archived）。這條路徑同時覆蓋可見性、部分更新、衝突、狀態與保留資料。

`curl -i` 只顯示結果，不會替你驗證預期值；自動化測試才負責在行為不符時回傳非零退出碼。

### 驗證持久化與停止

保留同一個 ARTICLE_ID，替換 API 容器並重啟開發 PostgreSQL：

```bash
docker compose stop api
docker compose restart postgres
docker compose up -d --wait postgres
docker compose up -d --force-recreate api
docker compose logs api
```

等日誌出現 LISTENING，再查管理端點，應仍是同一篇 archived、version 4 的文章：

```bash
curl -i "http://127.0.0.1:3013/api/me/articles/$ARTICLE_ID"
```

範例沒有文章永久 DELETE。手動驗收文章可以留在開發資料庫作紀錄；自動化測試則只在自己的 schema 裡清理資料。

### 驗證獨立檔案匯出

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3013/api/articles/export -o /tmp/chapter-13-articles.ndjson
curl -I http://127.0.0.1:3013/api/articles/export
```

這份 NDJSON 由 generate-export 產生，**不是資料庫備份，也不是 PostgreSQL 文章的匯出**。它不應因剛才的文章建立、發佈或封存而改變；B15 會以固定測試檔 bytes 驗證這件事。

正常收工：

```bash
docker compose stop api postgres test-db
```

開發資料保留於 volume。不要用 down -v 代替一般停止，也不要以測試通過作為已完成備份的證明。

### 使用主機 Node 的路線

先以 Docker 啟動 postgres，切到 examples/13，使用固定 Node／npm 版本：

```bash
export DATABASE_URL='postgresql://course:course_local@127.0.0.1:15413/course?schema=public'
export PORT=3013
npm ci
npm run generate
npm run build
npm run db:deploy
npm run db:seed
npm start
```

環境變數設在同一終端機，不會自動讀取 `.env`。完整測試仍建議由 tools 執行，因為 test-db 沒有對主機公開端口。

## 13.10 Express 已經做到什麼？還有哪些責任要自行組織？

Express 已經提供路由與 middleware 的組合方式；一條路由也能串接多個 handler，讓請求依序經過處理。[Express 路由文件](https://expressjs.com/en/guide/routing/)

本課另外建立了驗證、錯誤出口、手動 DI、資料庫與停止協調器。這樣的 Express 專案可以持續演進，並不是到了某個規模就必然失效。

但功能增加時，團隊仍要維護這些約定：

| 現在要自己回答的問題 | 本課已有做法 | Nest 階段要學的組織方式 |
|----------------------|--------------|------------------------|
| Repository 由誰建立？Service 要用哪一份？ | application.ts 手動傳入 | Provider、token、useFactory |
| 文章與使用者功能可以互相使用什麼？ | 靠匯入與團隊約定 | Module imports／exports 與可見性 |
| 測試如何替換一份依賴？ | 傳入普通物件或 factory | TestingModule、Provider override |
| 哪些邏輯屬於每次請求？ | middleware、Controller、區域變數 | middleware、Pipe、Guard、Interceptor 的生命週期 |
| 停止時誰負責等待與關閉？ | main＋shutdown＋application | 接到框架生命週期，維持原有等待與期限 |

Nest 的自訂 Provider 可以用值或 factory 等方式供應依賴，Module 則組織 Provider 的可見性；它們能對照本章已經看得見的依賴關係。[NestJS Custom providers](https://docs.nestjs.com/fundamentals/custom-providers)、[Modules](https://docs.nestjs.com/modules)

框架不會替我們決定「封存後不能修改」，也不會因為用了 Provider 就自動保證 UPDATE 有版本條件。這些規則與驗收仍由應用負責。

## 13.11 下一階段的遷移順序

```text
保留第 13 章快照與基準
  → 14：建立 Nest 入口，先遷移查詢路徑，觀察請求生命週期
  → 15：把手動組裝接到 Provider，練習 token 與替換依賴
  → 16：以 Module 完成文章功能遷移，跑完整契約
  → 17 以後：深化驗證、認證、權限與其他新能力
```

部分路由搬完時，只能宣稱該部分已驗證；尚未搬完的路由應列為未完成，不能刪掉測試來宣稱全部相容。16 章整合完成時，要回來執行全部基準、資料庫與程序驗證。

初次遷移要保留：資料模型、migration、狀態規則、條件 UPDATE、輸入限制、錯誤 envelope、Location、HEAD、405 與 shutdown 保證。對照表已收在 BASELINE.md。

32 項基準未重複搬入所有底層傳輸案例，例如非法 UTF-8 bytes、慢速 body 逾時與下載中斷後關檔；這些證據仍在 [10 章 HTTP 測試](examples/10/test/http.test.ts)與[匯出測試](examples/10/test/export.test.ts)。16 章整合時，須將這些案例接到新的測試組裝，才能宣稱新框架也保留相同行為，不能只靠舊章節測試通過。

容易被新框架預設值改掉的部分，要逐條核對：

- POST 預設狀態是否使 preview／publish／archive 變成 201？
- 全域路徑前綴是否與 Controller 路徑重複成 `/api/api/...`？
- body parser 的上限、charset 與壓縮處理是否改變？
- query 轉型是否把原本不合法的重複參數或字串版本放行？
- 全域錯誤處理是否改成另一種 JSON 結構？
- 服務關閉時是否只關 socket，卻先於登記工作關掉資料庫？

本章僅準備遷移；Nest 套件版本會在開始實作的章節確認並固定。ORM 切換另安排於 **34 章 TypeORM 選修**；Redis 與 BullMQ 則是 **30、31 章**。這些後續能力各有獨立範例與驗收，不混入這次 Express → Nest 的相容性比較。

## 13.12 常見問題、練習與階段驗收

| 現象 | 檢查方向 |
|------|----------|
| test:baseline 通過，check 卻失敗 | 基準只涵蓋 HTTP；查看資料庫、單元或真實程序失敗項目 |
| check 通過，開發 API 啟動失敗 | 是否對開發資料庫執行 deploy？check 只處理自己的測試 schema |
| 手動清掉 public 才能讓測試過 | 測試連線或 fixture 邊界錯了，不能用清開發資料解決 |
| 每次建立文章的 ID／時間都不同 | 比較格式與前後關係，不固定動態值 |
| POST publish 變成 201 | 檢查框架預設狀態碼，而不是先改測試 |
| 只測 response.status，資料卻被改了 | 補上拒絕前後查詢與資料庫一致性檢查 |
| 匯出沒有剛建立的文章 | 本章 export 是獨立檔案，不是資料庫匯出 |
| 查得到草稿，卻看不到公開列表 | 草稿只應從管理端點可見 |
| 第 13 章看不到第 12 章資料 | 各章 Compose 專案與 volume 獨立 |

### 練習一：讓遷移基準抓到一個契約改變

在第 13 章副本中，暫時把 Controller 建立文章的 status(201) 改成 status(200)，只跑 B01，觀察失敗，再還原。不要改測試預期來讓它變綠。

驗收：說明這是外部契約改變，而不是內部函式重新命名；指出哪一個 assertion 抓到差異。

### 練習二：補一個沒有公開文章的列表案例

在 migration-contract.ts 增加測試：以正確版本封存 a_1、a_2，再查公開列表，應得到 data: []、total: 0；管理列表仍能找到原本三篇文章。

驗收：不直接操作 Prisma，以 HTTP 完成前置狀態；確認下一個測試仍由 fixture 恢復乾淨資料。

### 練習三：畫出一個失敗請求

送出含未知欄位的 PATCH，畫出文字流程，指出 Zod 拒絕後哪些層不應被執行、errorHandler 如何加上 request ID，以及如何確認文章沒變。

參考方向：parser → validate 失敗 → 集中錯誤出口 → 400；Controller／Service／Repository 不應處理該次更新。

### 練習四：列出遷移時可保留與必須調整的部分

從 src 選五個檔案，分別記錄：「它依賴什麼？」「改成 Nest 後哪些責任可以沿用？」「用哪項測試確認？」至少包含 Service、Prisma Repository、Controller、application 與 shutdown。

驗收：不是把所有函式換成 class；要能解釋每個變動解決的依賴或生命週期問題。

### Express 階段完成檢查

- [ ] 已從 Docker 跑完安裝、完整 check、deploy、seed 與 status。
- [ ] 能依序完成建立草稿、修改、衝突、發佈、封存與管理查詢。
- [ ] 已觀察容器替換／資料庫重啟後資料仍存在。
- [ ] 能說明原 HTTP 契約與新增遷移基準如何共用 Server。
- [ ] 知道 32 項 HTTP 基準與 92 項完整測試的差別。
- [ ] 測試不操作開發資料，只清理自己的 schema 與暫存檔。
- [ ] 能指出真實併發、回滾與程序關閉的驗收證據。
- [ ] 能區分本章基準與最終專題的認證、留言及稽核需求。
- [ ] 已列出 Nest 遷移要保留的行為與待處理的依賴問題。

下一章預定為 `14-nest-bootstrap-and-request-lifecycle.md`，從 Nest 啟動與請求生命週期開始，讓新的組裝方式接住既有契約。

---

[上一章：分層與手動 DI](12-service-repository-and-manual-di.md) · [返回課程總覽](README.md) · [本章範例](examples/13/README.md) · [遷移基準](examples/13/BASELINE.md)
