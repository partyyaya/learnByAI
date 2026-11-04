# 第 17 章：DTO、Pipe 與執行期驗證

以原有 Zod schema 推導 DTO，將 Controller 內的 parseInput 移到 Body／Query／Param Pipe；保留第 16 章模組、HTTP 契約、資料庫與傳輸限制。沒有新增依賴或認證功能。

[教材](../../17-dto-pipes-and-runtime-validation.md) · [HTTP 與資料契約](BASELINE.md)

## 從乾淨環境開始

在本目錄執行：

```bash
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose up -d api
```

API 主機端口 **3017**，開發 PostgreSQL **15417**；容器內 postgres:5432/course。測試使用 test-db:5432/course_test，不公開主機端口。Compose 專案 nodejs-course-17 與 volume 皆屬本章。

check 先 generate、型別檢查與 Jest，再 build、程序驗證與三個實驗。修改 src 後重新 build，再重啟 api。seed 只補缺少的資料，不覆寫已修改文章。

```bash
curl -i http://127.0.0.1:3017/health/ready
curl -i 'http://127.0.0.1:3017/api/articles?page=2&pageSize=1'
curl -i 'http://127.0.0.1:3017/api/articles?page=1e2'
curl -i 'http://127.0.0.1:3017/api/articles?page=1&page=2'
curl -i http://127.0.0.1:3017/api/articles/a_draft
curl -i http://127.0.0.1:3017/api/me/articles/a_draft
```

乾淨 seed 預期為 200、200、400、400、404、200。公開只提供 published，管理仍以 u_demo 為固定作者，18 章才加入登入授權。

```bash
curl -i -X POST http://127.0.0.1:3017/api/articles -H 'Content-Type: application/json' --data '{"title":" Pipe 草稿 ","content":" 本文 "}'
curl -i -X POST http://127.0.0.1:3017/api/articles -H 'Content-Type: application/json' --data '{"title":"x","content":"y","authorId":"u_other"}'
```

前者回 201、修剪後資料與 Location；後者回 400 VALIDATION_ERROR，details 含 UNKNOWN_FIELDS，不新增文章。PATCH 需目前 expectedVersion 與至少一個 title／content；省略的欄位保留，null／空字串／字串版本拒絕。完整操作順序見教材。

## 本章實作

```text
parser：媒體類型、UTF-8、16 KiB、JSON 語法、body 期限
  → ZodValidationPipe：完整 body／query／params、schema 驗證與轉型
  → DTO：Controller 的實際參數
  → Controller：工作追蹤、Service 呼叫與 HTTP 回應
  → Service／Repository：可見性、狀態、版本條件與交易
```

- article.dto.ts 從 schema 的 output 推導六種輸入 DTO，另提供 query 的 input 型別；DTO 不依賴反射才能驗證，也不是 ORM model。
- ZodValidationPipe 無 I/O、無請求狀態，只接受完整 Body／Query／Param；以 metadata.type 決定 body／query／params 錯誤前綴。
- Pipe 回傳 parseInput 的結果，不覆寫 req.body／req.query。Controller 使用 DTO，不再自行呼叫 parseInput。
- query 先要求單一十進位字串，再轉數字並檢查範圍；預設 page 1、pageSize 20。body 的 expectedVersion 必須原本就是正安全整數。
- strictObject 拒絕未知欄位；PATCH 不自動為缺少欄位補值，仍拒絕 null。
- 原 Controller 的狀態碼、Location、HEAD、405／Allow、匯出與 shutdown 協調器維持原行為。

不是所有端點都拒絕 query：單篇查詢仍忽略未知 query，列表與 export 才套用原本要求的 schema。ID 仍為不透明字串，沒有改成數字或 UUID 限制。

## 獨立驗證實驗

先 build，再執行：

```bash
docker compose run --rm tools npm run lab:validation
```

實驗啟動隨機端口、送真實 HTTP，最後關閉 app：

1. class DTO 即使有 metadata，未綁 Pipe 仍接受非法輸入；綁 Pipe 後回 400。
2. DTO 字串經 trim、query 轉數字，原始 request 仍保留原值。
3. 獨立 nickname 欄位區分省略、null、有效字串及空字串。

實驗不連資料庫、不掛入文章 API；文章欄位仍拒絕 null，正式 API 的 `/validation/unchecked` 回 404。本章不安裝 class-validator／class-transformer；教材說明與 ValidationPipe 的差異，主線使用既有 Zod。

## 指令與測試

| 指令 | 用途 |
|------|------|
| `npm run check` | generate、型別、204 項 Jest、build、程序與三個框架實驗 |
| `npm run test:baseline` | 原 32 項 HTTP 基準；需先 generate 並啟動 test-db |
| `npm test -- --testPathPatterns=pipes.test.js` | 30 項 Pipe 輸出、格式、版本、PATCH 與錯誤映射 |
| `npm test -- --testPathPatterns=validation-http.test.js` | 10 項正式 HTTP 的 Pipe 綁定與 handler 前拒絕 |
| `npm test -- --testPathPatterns=validation-lab.test.js` | 4 項型別／raw 值／nullable 對照 |
| `npm run lab:validation` | build 後，以真實監聽端口執行驗證實驗 |
| `npm run lab:nest`／`npm run lab:scopes` | 沿用前章的生命週期與 scope 實驗 |
| `npm run test:runtime` | 先編譯／build；真實程序的初始化失敗、信號與停止期限 |
| `npm run generate`／`npm run build` | 產生 Prisma Client／編譯應用 |
| `npm run db:deploy`／`npm run db:status` | 套用／確認開發 migration |
| `npm run db:seed` | build 後補上開發種子資料 |
| `npm run seed` | 建立獨立 NDJSON 教學檔，不是資料庫備份 |

204 項是前章 160 項加本章 44 項。原兩份 HTTP 契約逐位元保留，既有 31 項 HTTP／匯出傳輸案例仍接到完整 Nest＋PostgreSQL fixture；非法 UTF-8、慢速 body、下載中斷及晚登記工作關閉競態繼續驗證。

每套資料庫 fixture 僅接受 TEST_DATABASE_URL 與 course_test，以隨機 schema 隔離，最後只刪自己的 schema；不清理開發 public。交易、回滾與多 pool 併發仍由真實資料庫測試驗證，不能以 Pipe／Repository 替身測試代替。

test:runtime 依賴 `.test-dist`／`dist`，不要與會清除 `.test-dist` 的 npm test 並行。原 Express 錯誤 laboratory 保留平台教學用途，不代替正式 Nest 端點測試。

## 程式閱讀順序

| 檔案 | 重點 |
|------|------|
| `src/schemas.ts` → `src/article.dto.ts` | 原輸入規則與 schema 推導的 DTO／query input |
| `src/zod-validation.pipe.ts` → `src/validation.ts` | ArgumentMetadata、回傳驗證結果與安全錯誤格式 |
| `src/articles.controller.ts` | Body／Query／Param 各自綁定 schema，方法直接使用 DTO |
| `src/articles.module.ts` → `src/json-body.ts` | Pipe 之前的 body 傳輸限制 |
| `src/validation-lab.ts` → `scripts/check-validation.cjs` | 型別反例、raw 值與 nullable 的獨立 HTTP 實驗 |
| `test/pipes.test.ts` → `test/validation-http.test.ts` | 單元規則與正式路由的綁定證據 |
| `src/application.ts` → `src/app.module.ts` | 沿用功能模組、設定與資料庫所有權 |
| `test/migration-baseline.test.ts` | 真實資料庫上執行原 HTTP 契約 |

## 固定版本

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1。Nest common／core／platform-express／testing 11.2.8，reflect-metadata 0.2.2、RxJS 7.8.2。Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17。

沒有新增套件；CommonJS／NodeNext、裝飾器設定與 Express 5.3.0／Multer 2.5.0 overrides 維持前章內容。2026-11-02 複查 npm ci 的 audit 回報 19 個受影響套件節點（3 low、16 moderate，無 high／critical），涉及 Jest／glob／minimatch／deepmerge 開發依賴鏈。advisory 結果會隨時間改變；本次未更改套件或 lockfile，也未執行 audit fix --force。這不是 19 個彼此獨立的漏洞。

## 匯出與停止

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3017/api/articles/export -o /tmp/chapter-17-articles.ndjson
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

匯出檔不會隨資料庫文章變動而更新。stop 保留開發 volume，不以 down -v 作一般停止。

## 驗證紀錄（2026-10-30）

- 完整 check 通過：18 套共 204 項 Jest、型別檢查、build、程序信號與生命週期／scope／validation 三個實驗。環境中斷後已重新執行完整檢查，結果一致。
- 原 32 項 HTTP 基準與 31 項 HTTP／匯出傳輸案例繼續通過；本章新增 44 項 Pipe、正式路由與獨立實驗測試。測試資料庫殘留 schema 為 0。
- 開發資料庫 migration、seed、status 成功；主機端口 3017 可連線，回傳分頁數字與正確資料。
- 實際 API 驗證 query 轉型、非法 query 拒絕、preview 修剪、未知欄位與非法 PATCH 拒絕；拒絕後文章與文章總數未變，錯誤 body 的 requestId 與 header 一致。
- 日誌確認欄位驗證失敗有 json:parsed／nest:filter，沒有 nest:controller。公開草稿 404、管理草稿 200、HEAD 與未掛載的 validation lab 404 均符合契約。
- 獨立 NDJSON 為 20000 筆、3857788 bytes；GET 與檔案逐位元一致，HEAD 長度相同且沒有 body，兩者皆關檔，HEAD bytesRead 為 0。
- HTTP 契約、schema、Service、Repository、傳輸 helper 與原有傳輸測試均與第 16 章相同；依賴版本及 lockfile 套件節點未變。本次收尾核對第 14–16 章 197 個範例檔案雜湊未變。
- 持久化、重建 client／Service、交易與回滾已有自動測試；本輪未另做 PostgreSQL 重啟前後的手動資料比對。
- API、開發 PostgreSQL 與 test-db 均已正常停止，退出碼為 0；API 日誌依序為 draining、http-drained、closed。開發 volume 與教學匯出檔保留。
