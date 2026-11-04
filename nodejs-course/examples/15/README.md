# 15 章可執行範例

教材：[Provider、DI token、非同步初始化與 scope](../../15-providers-di-tokens-and-scopes.md)。[BASELINE.md](BASELINE.md) 記錄保持不變的 HTTP／資料契約與本章組裝範圍。

本章從第 14 章獨立複製，改用 Symbol token、useValue、非同步 DATABASE Provider、Repository／Service factory 與 Controller 建構子注入。Nest 與暫留 Express 路由共用容器建立的同一個 Service，業務函式仍不依賴 Nest。

路由分界保持前章內容：**公開單篇 GET／HEAD `/api/articles/:id`** 是 Nest，其餘文章操作、health、preview 與匯出仍是 Express。作者固定 u_demo，沒有新增登入授權。本章的 scope lab 是獨立實驗，不掛入文章 API。

## 完整執行

從倉庫根目錄：

```bash
cd nodejs-course/examples/15
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose up api
```

另一個終端機，在乾淨 seed 下：

```bash
curl -i http://127.0.0.1:3015/health/ready
curl -i http://127.0.0.1:3015/api/articles/a_1
curl -I http://127.0.0.1:3015/api/articles/a_1
curl -i http://127.0.0.1:3015/api/articles/a_draft
curl -i http://127.0.0.1:3015/api/me/articles/a_draft
curl -i -X DELETE http://127.0.0.1:3015/api/articles/a_1
```

依序為 200、200、HEAD 200、公開草稿 404、管理草稿 200、405／Allow: GET, HEAD, PATCH。seed 不覆寫已有文章，若資料已修改，請依現有狀態判讀。

API 主機端口 **3015**，開發 PostgreSQL 主機端口 **15415**；容器內為 postgres:5432/course。測試使用 test-db:5432/course_test，不公開主機端口。Compose 專案 nodejs-course-15 與 volume 皆屬本章。

## Provider 依賴與資源責任

```text
DATABASE_INPUT（useValue：已建立的 client）
  → DATABASE（async factory：await $connect）
      → ARTICLE_REPOSITORY（factory）
          → ARTICLE_SERVICE（factory）
              → Nest Controller（@Inject）
              → 舊 Express Controller（組裝時 get 同一物件）
      → CHECK_READY（查詢資料表的函式）
REQUEST_LIFECYCLE（useValue）→ Nest Controller
```

createArticleApplication 接手 database 所有權，建立失敗時 disconnect；正常關閉先等外部 HTTP Server 與登記工作，再 close Nest 與 database。main 在 Provider 初始化後、listen 前另查 Article 表，確認 migration 已套用。

TestingModule compile 會建立 Provider。只覆寫 Repository 不會自動跳過 DATABASE 的初始化；測試需覆寫 DATABASE，或使用不含資料庫 Provider 的最小組裝。純 Service 測試仍可直接呼叫 createArticleService，不必全部改用容器。

## Scope 實驗

先完成 npm ci 與 build，再執行：

```bash
docker compose run --rm tools npm run lab:scopes
```

指令會建立獨立 Nest app、監聽臨時端口，並行送出兩個 HTTP 請求，驗證後關閉：

- DEFAULT 跨請求共享；useExisting 是別名，另一個 useClass 註冊建立不同實例。
- REQUEST 在同請求共享、不同請求隔離，影響依賴它的 Consumer 與 Controller。
- TRANSIENT 按消費者分開；DEFAULT 消費者持有的實例跨請求不變，request 消費者則各有自己的實例。

UUID 只用來比較物件身分；X-Lab-Label 只是實驗標記，不是認證資訊。實驗不為每個請求建立資料庫連線池，也不是效能壓測。

## 固定依賴

沿用 Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1、Nest common／core／platform-express 11.2.8、reflect-metadata 0.2.2、RxJS 7.8.2、Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17。

只新增開發依賴 **@nestjs/testing 11.2.8**。CommonJS／NodeNext、裝飾器設定，以及 adapter 的 Express 5.3.0／Multer 2.5.0 overrides 維持前章內容。本章沒有檔案上傳功能。

```bash
docker compose run --rm tools npm ls @nestjs/common @nestjs/core @nestjs/platform-express @nestjs/testing express multer
```

2026-11-02 複查 npm ci 的 audit 回報 19 個受影響套件節點（3 low、16 moderate，無 high／critical），涉及 Jest／glob／minimatch／deepmerge 開發依賴鏈。advisory 結果會隨時間改變；本次未更改套件或 lockfile，也未執行 audit fix --force。這不是 19 個彼此獨立的漏洞。

## 指令與測試範圍

| 指令 | 用途 |
|------|------|
| `npm run check` | generate、型別、117 項 Jest、build、程序驗證、生命週期與 scope 實驗 |
| `npm run test:baseline` | 原有 32 項 HTTP 基準；先 generate，需 test-db |
| `npm test -- --testPathPatterns=providers.test.js` | 8 項 token／factory／替換／非同步等待與清理 |
| `npm test -- --testPathPatterns=scopes.test.js` | 5 項 scope、並行隔離、context 與多應用實例比較 |
| `npm run lab:scopes` | build 後以真實 HTTP 比較三種 scope |
| `npm run lab:nest` | 沿用前章四條請求生命週期實驗 |
| `npm run generate`／`npm run build` | 產生 Prisma Client／編譯應用 |
| `npm run db:deploy`／`npm run db:status` | 套用／確認開發資料庫 migration |
| `npm run db:seed` | build 後補上缺少的種子資料，不覆寫文章 |
| `npm run seed` | 產生獨立 NDJSON 教學檔，不是資料庫備份 |

117 項 Jest 是前章 104 項加本章 13 項，包含重跑既有契約的案例。兩份 HTTP 契約測試與第 13–14 章逐位元相同，沒有改 assertion 配合框架。

test:runtime 另驗證真實入口：缺 URL、資料庫不可達、缺 migration 均拒絕監聽；SIGINT／SIGTERM、重複信號、進行中請求與停止期限仍通過。它依賴 `.test-dist` 與 `dist`，不要與會刪除重建 `.test-dist` 的 npm test 同時執行；完整 check 已安排循序執行。

每套資料庫 fixture 只接受 TEST_DATABASE_URL 與 course_test，建立隨機 schema、套用 migration，最後只刪自己的 schema。測試不清理開發 public；Repository 替身不提供交易保證，併發與回滾仍由真實資料庫測試驗證。

第 16 章仍須把第 10 章的非法 UTF-8、慢速 body、下載中斷等底層傳輸案例接到完整 Nest fixture。這一章仍是部分路由遷移，Provider 或 HTTP 基準通過不能代替完整驗收。

## 程式閱讀順序

| 檔案 | 重點 |
|------|------|
| `src/tokens.ts` | 匯出唯一的執行期 Symbol token |
| `src/article.providers.ts` | 值 Provider、非同步連線與業務 factory 的依賴圖 |
| `src/article-query.module.ts` | 靜態 Controller、建構子 @Inject、根模組註冊 |
| `src/application.ts` → `src/server.ts` → `src/main.ts` | 所有權、建立容器、舊路由橋接、init、資料表檢查與 listen |
| `test/providers.test.ts` | 最小 TestingModule、正式 Provider 覆寫、等待／失敗清理與 HTTP 證據 |
| `src/scope-lab.ts` → `test/scopes.test.ts` | 三種 scope、別名、並行隔離與 resolve context |
| `test/migration-baseline.test.ts` | 真實 PostgreSQL 上的原有 HTTP 基準 |

## 匯出與停止

API 啟動且已 build 後：

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3015/api/articles/export -o /tmp/chapter-15-articles.ndjson
docker compose stop api postgres test-db
```

停止保留開發 postgres_data volume，不以 down -v 作一般停止。修改 src 後重新 build；修改依賴時同步固定版本與 lockfile，勿直接升級 latest。

## 驗證紀錄（2026-10-29–30）

- 完整 `npm run check` 通過：型別檢查、12 套共 117 項 Jest（含原有 32 項 HTTP 基準）、build、程序驗證、生命週期與 scope 實驗。
- 調整測試清理流程並補上資料庫不可達情境後，循序重跑 8 項 Provider 測試與 `test:runtime`，均通過。
- 開發資料庫 migration、seed 與 migration status 均成功；主機端口 3015 的公開文章查詢回傳 200。
- 實際 API 的 readiness、公開文章 GET／HEAD、公開草稿 404、管理草稿 200、DELETE 405 與 Allow header 均符合契約；`/scope` 回傳 404，實驗未掛入文章 API。
- 請求日誌確認公開文章由 Nest Controller／Filter 處理，管理查詢仍走 Express；測試資料庫殘留的 `test_*` schema 為 0。
- 第 14 章範例的 58 個檔案雜湊均未變動。資料持久化已有自動測試；本輪未另做手動重啟 PostgreSQL 的持久化演練。
- API、開發 PostgreSQL 與測試資料庫皆已停止，退出碼為 0；API 日誌依序記錄 draining、http-drained、closed。資料 volume 保留。
