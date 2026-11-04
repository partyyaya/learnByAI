# 第 16 章：功能模組與完整文章遷移

本快照把既有文章、preview、匯出與健康端點全部交給 Nest Controller，以 imports／exports 限定 Provider 可見範圍。契約沿用第 13–15 章，不新增登入、留言或永久 DELETE。

[教材](../../16-modules-boundaries-and-dependencies.md) · [HTTP 與資料契約](BASELINE.md)

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

API 主機端口 **3016**，開發 PostgreSQL **15416**；容器內使用 postgres:5432/course。測試使用 test-db:5432/course_test，不公開主機端口。Compose 專案 nodejs-course-16 及 volume 與舊章獨立。

check 先 generate、型別檢查與 Jest，再 build、程序驗證與獨立實驗。修改 src 後重新 build，再重啟 api。seed 只補缺少的文章，不覆寫已修改資料。

```bash
curl -i http://127.0.0.1:3016/health/ready
curl -i http://127.0.0.1:3016/api/articles/a_1
curl -I http://127.0.0.1:3016/api/articles/a_1
curl -i http://127.0.0.1:3016/api/articles/a_draft
curl -i http://127.0.0.1:3016/api/me/articles/a_draft
curl -i -X DELETE http://127.0.0.1:3016/api/articles/a_1
```

乾淨 seed 預期為 200、200、HEAD 200、404、200、405／Allow: GET, HEAD, PATCH。

建立草稿會回 201 與管理 Location：

```bash
curl -i -X POST http://127.0.0.1:3016/api/articles -H 'Content-Type: application/json' --data '{"title":"模組邊界","content":"由 Nest 建立"}'
```

以回傳 id 進行 PATCH、publish、archive 時帶入目前 expectedVersion；成功版本加一，舊版本回 409。公開只看 published，管理仍使用固定作者 u_demo；18 章才加入真正身分與授權。完整操作順序見教材。

## 模組邊界

```text
AppModule
  → ArticlesModule
      → ArticleCoreModule → DatabaseModule
      → RuntimeModule
  → HealthModule
      → 同一份 DatabaseModule
      → 同一份 RuntimeModule
```

- DatabaseModule 匯出 DATABASE／CHECK_READY，內部 async factory 等待連線。
- ArticleCoreModule 擁有 Repository／Service factory，只匯出 ARTICLE_SERVICE。
- ArticlesModule 擁有兩個文章 Controller 與寫入 body middleware。
- HealthModule 使用 readiness 與工作追蹤，不依賴文章 Controller。
- RuntimeModule 匯出 HTTP_OPTIONS 與 REQUEST_LIFECYCLE；組裝時驗證設定，功能內不讀環境變數。
- AppModule 組合功能。沒有 @Global、forwardRef 或舊 Express 業務路由。

依賴由目前模組提供，或從 imports 的模組明確 exports。父模組的 providers 不會自動流入子模組；在不同模組重複註冊 factory 會產生不同實例。共享時傳遞同一個動態模組描述。

createArticleApplication 接手 database 關閉責任。外部 Node Server 擁有監聽；Nest 只 init。關閉先等待 HTTP 與登記工作，再 close Nest 與 database，不新增另一組信號處理。

## HTTP 相容處理

所有應用端點皆為 Nest Controller，Express 仍是底層平台。Zod schema 保留，Controller 使用 parseInput 的標準化結果；17 章再整理 Pipe。16 KiB、UTF-8、strict JSON 與讀取期限仍由原 parser 負責。

- POST 建立維持 201；preview／publish／archive 明列 HttpCode(200)。
- 固定路徑與自己的 All 方法先於 `:id`，保留 405／Allow；不支援的 PATCH preview／export 不先解析 body。
- 只將 `/api/articles/` 正規化為集合根路徑；詳細路徑尾斜線仍回 404。
- ContractExpressAdapter 在 Nest 包裝 SyntaxError／URIError 前保留 INVALID_JSON／INVALID_URL 分類，Filter 維持原 error envelope。
- 一般 JSON 使用 passthrough response 設定 header 並 return 資料；匯出使用一般 Res，由 pipeline 完成回應與關檔。

## 指令與測試

| 指令 | 驗證範圍 |
|------|----------|
| `npm run check` | generate、型別、160 項 Jest、build、程序與兩個框架實驗 |
| `npm run test:baseline` | 32 項原 HTTP 基準；需先 generate 並啟動 test-db |
| `npm test -- --testPathPatterns=modules.test.js` | 8 項模組可見性、重複註冊、設定與無循環流程 |
| `npm test -- --testPathPatterns=http.test.js` | 26 項第 10 章 HTTP／傳輸案例，改接完整 Nest＋PostgreSQL fixture |
| `npm test -- --testPathPatterns=export.test.js` | 5 項串流案例，改接完整 Nest＋PostgreSQL fixture |
| `npm test -- --testPathPatterns=controller.test.js` | 10 項 HTTP 邊界、工作追蹤與設定隔離 |
| `npm run test:runtime` | 先編譯與 build；缺 URL／不可達／缺 migration 不監聽，信號與停止期限 |
| `npm run lab:nest`／`npm run lab:scopes` | build 後執行，獨立 app，不掛入文章 API |
| `npm run generate`／`npm run build` | 產生 Prisma Client／編譯應用 |
| `npm run db:deploy`／`npm run db:status` | 開發 migration 套用／狀態 |
| `npm run db:seed` | build 後補上缺少的開發種子資料 |
| `npm run seed` | 產生獨立 NDJSON 教學檔，不是資料庫備份 |

160 項是前章 117 項，加模組 8 項、承接 HTTP 26 項、匯出 5 項與遷移回歸 4 項。原測試中的組裝與框架 trace 隨遷移調整；api-contract.ts／migration-contract.ts 逐位元保留，沒有改 assertion 迎合 Nest 預設。

傳輸測試驗證非法 UTF-8、已知長度及 chunked 超限、慢速 body 408、上傳離線、下載中斷後停止讀取與關檔。新增 Nest 慢速 body 回歸驗證「開始 shutdown 後才登記、客戶端離線」的工作仍被等待。

每套資料庫 fixture 只接受 TEST_DATABASE_URL 與 course_test，建立隨機 schema、套用 migration，最後只刪自己的 schema；不清理開發 public。Repository 替身不能證明交易與回滾，這些由真實 PostgreSQL 測試確認。

test:runtime 依賴 `.test-dist`／`dist`，不要與會清除重建 `.test-dist` 的 npm test 並行。原 Express 錯誤 laboratory 保留平台教學用途，完整 Nest 端點與傳輸另有測試。

## 程式閱讀順序

| 檔案 | 重點 |
|------|------|
| `src/application.ts` → `src/app.module.ts` | 建立一次資料庫模組、組合功能與資源所有權 |
| `src/database.module.ts` | async DATABASE 與 readiness 的公開面 |
| `src/article-core.module.ts` → `src/article.providers.ts` | Repository 留在模組內，匯出 Service |
| `src/runtime.module.ts` | 驗證、複製與凍結 HTTP 設定，提供協調器 |
| `src/articles.module.ts` → `src/articles.controller.ts` | body middleware、文章 HTTP 操作與方法優先序 |
| `src/health.module.ts` | live、ready 與 405 |
| `src/server.ts` → `src/contract-express.adapter.ts` | transport、尾斜線相容與外部錯誤橋接 |
| `test/modules.test.ts` | 正常與失敗的模組解析案例 |
| `test/http.test.ts`／`test/export.test.ts` | 原始 bytes、串流與正式應用組裝 |

## 固定版本

沿用 Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1。Nest common／core／platform-express／testing 均為 11.2.8，reflect-metadata 0.2.2、RxJS 7.8.2。Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17。

本章沒有新增依賴。CommonJS／NodeNext、裝飾器設定及 Express 5.3.0／Multer 2.5.0 overrides 沿用前章；沒有上傳功能。2026-11-02 複查 npm ci 的 audit 回報 19 個受影響套件節點（3 low、16 moderate，無 high／critical），涉及 Jest／glob／minimatch／deepmerge 開發依賴鏈。advisory 結果會隨時間改變；本次未更改套件或 lockfile，也未執行 audit fix --force。這不是 19 個彼此獨立的漏洞。

```bash
docker compose run --rm tools npm ls @nestjs/common @nestjs/core @nestjs/platform-express @nestjs/testing express multer
```

## 匯出與停止

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3016/api/articles/export -o /tmp/chapter-16-articles.ndjson
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

stop 保留開發 postgres_data volume。不要用 down -v 作一般停止；匯出檔案與 PostgreSQL 資料分開管理。

## 驗證紀錄（2026-10-30）

- Docker build、npm ci 與完整 check 通過：15 套共 160 項 Jest、型別、build、程序信號與生命週期／scope 實驗。
- 原 32 項 HTTP 基準通過；第 10 章 31 項 HTTP／匯出案例已使用本章完整 Nest 與隔離資料庫組裝通過。
- 新增模組邊界、設定隔離、路由優先序及慢速 body 晚登記工作的回歸案例通過。測試 schema 殘留為 0。
- 開發資料庫 deploy、seed、status 成功；主機端口 3016 可讀取文章。實際 API 的公開／管理、HEAD、405、非法 URL 與 malformed JSON 分類均符合契約。
- 獨立 NDJSON 已產生 20000 筆，共 3857788 bytes。實際 GET 與檔案逐位元相同，HEAD 長度一致且不送 body；日誌確認兩者關檔，HEAD bytesRead 為 0。
- 第 14–15 章共 122 個範例檔案雜湊未變。Service、Repository、schema／migration、shutdown 與兩份 HTTP 契約維持原內容；套件與 lockfile 依賴節點未變。
- 資料持久化與重建 client／Service 已有自動測試，本輪未另做手動重啟 PostgreSQL 的持久化演練。
- API、開發 PostgreSQL 與 test-db 均正常停止，退出碼為 0；API 日誌依序為 draining、http-drained、closed。開發 volume 與教學匯出檔保留。
