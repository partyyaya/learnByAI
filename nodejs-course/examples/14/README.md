# 14 章可執行範例

教材：[Nest 啟動、裝飾器與請求生命週期](../../14-nest-bootstrap-and-request-lifecycle.md)。[BASELINE.md](BASELINE.md) 記錄本章過渡範圍與保持不變的 HTTP／資料契約。

本章從第 13 章獨立複製，將 **公開單篇 GET／HEAD `/api/articles/:id`** 接到 Nest Controller；公開列表、管理查詢、寫入、health、preview 與匯出仍由 Express 處理。Service、Repository、Prisma schema／migration 與 shutdown 協調器保留原內容。作者固定 u_demo，尚無認證授權，只供本機教學。

## 完整執行

從倉庫根目錄：

```bash
cd nodejs-course/examples/14
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose up api
```

另一個終端機，在乾淨 seed 資料下：

```bash
curl -i http://127.0.0.1:3014/health/ready
curl -i http://127.0.0.1:3014/api/articles/a_1
curl -I http://127.0.0.1:3014/api/articles/a_1
curl -i http://127.0.0.1:3014/api/articles/a_draft
curl -i http://127.0.0.1:3014/api/me/articles/a_draft
```

依序為 200、200、HEAD 200、公開草稿 404、管理草稿 200。若開發資料已被修改，依現有狀態判讀；seed 不覆寫已有文章。

公開單篇的 REQUEST_TRACE 包含 `handoff:nest → nest:controller → nest:return`；公開草稿則有 `nest:filter → error:NOT_FOUND`。管理查詢仍走原 Express Controller。

API 主機端口 **3014**，開發資料庫主機端口 **15414**；容器內使用 postgres:5432/course。測試使用 test-db:5432/course_test，不公開主機端口。Compose 專案與 volume 均屬第 14 章。

## 固定依賴與建置

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1、Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17 沿用第 13 章。

新增 Nest common／core／platform-express **11.2.8**、reflect-metadata **0.2.2**、RxJS **7.8.2**。採 CommonJS／NodeNext，新增 experimentalDecorators／emitDecoratorMetadata。沿用 tsc 與 Jest，不需要全域 CLI。

package.json 明列 adapter 的傳遞依賴 overrides：Express 使用根依賴 5.3.0，Multer 2.5.0。這些設定與 lockfile 一起驗證，不改舊章節依賴。本章沒有檔案上傳端點。可查看實際解析：

```bash
docker compose run --rm tools npm ls @nestjs/common @nestjs/core @nestjs/platform-express express multer reflect-metadata rxjs
```

2026-11-02 複查 npm ci 的 audit 回報 19 個受影響套件節點（3 low、16 moderate，無 high／critical），涉及 Jest／glob／minimatch／deepmerge 開發依賴鏈。advisory 結果會隨時間改變；本次未更改套件或 lockfile，也未執行 audit fix --force。這不是 19 個彼此獨立的漏洞。

## 指令與測試範圍

| 指令 | 用途 |
|------|------|
| `npm run check` | generate、型別、104 項 Jest、build、程序驗證、四條 Nest 生命週期實驗 |
| `npm run test:baseline` | 重新編譯後執行原有 32 項 HTTP 基準；先 generate，需 test-db |
| `npm test -- --testPathPatterns=nest-query.test.js` | 7 項 Nest 查詢、錯誤及隔離案例 |
| `npm test -- --testPathPatterns=nest-lifecycle.test.js` | 5 項生命週期與 metadata 案例 |
| `npm run lab:nest` | build 後啟動獨立實驗，逐一驗證 200／400／403／500 並關閉 |
| `npm run generate`／`npm run build` | 產生 Prisma Client／編譯應用 |
| `npm run db:deploy`／`npm run db:status` | 套用／檢查開發資料庫 migration |
| `npm run db:seed` | build 後補缺少的種子資料 |
| `npm run seed` | 產生獨立 NDJSON 教學檔，不是資料庫備份 |

104 項 Jest 由前章 92 項加本章 12 項組成，包含重跑既有契約的案例。`api-contract.ts` 與 `migration-contract.ts` 分別和第 13 章逐位元相同；修改的是非同步組裝，沒有為新框架修改預期值。

`test:runtime` 另驗證真實入口、缺設定／migration、SIGINT／SIGTERM、進行中請求與停止期限；它需要 `.test-dist` 與 `dist`，通常直接執行完整 check。Jest 所需 VM modules 旗標已包含於 scripts，一般 API 啟動不需要。

每套資料庫 fixture 只接受 TEST_DATABASE_URL 與 course_test，建立自己的隨機 schema、套用 migration、最後只刪自己的 schema。check 不清理開發 public。測試匯出檔建立於臨時目錄，不依賴手動 seed。

第 16 章仍須把第 10 章的非法 UTF-8、慢速 body、下載中斷等底層傳輸案例接到完整 Nest fixture 重跑。本章是部分遷移，不能以本章 32 項基準通過宣稱全面驗收。

### 2026-10-29 驗證紀錄

- Docker 工具映像建置、lockfile 的 npm ci、完整 npm run check 全部通過；104 項 Jest、程序信號與四條生命週期實驗均成功。
- 開發資料庫 deploy／seed／status 成功，主機 3014 可讀取文章；另外確認公開草稿 404、管理草稿 200、HEAD、405／Allow、未知路由與 Nest trace。
- 測試結束後 test-db 的 test_* schema 數量為 0。
- 兩份 HTTP 契約、Service／Repository、schema／migration 與 shutdown 對照第 13 章保持相同；舊 lockfile 的共同套件節點版本也未變動。
- 本輪沒有重做開發 PostgreSQL 重啟的手動持久化演練；完整 check 包含服務／client 重建後仍可讀回資料的自動測試。

## 程式閱讀順序

| 檔案 | 重點 |
|------|------|
| `src/main.ts` → `src/application.ts` | 設定、連線、非同步組裝、監聽與失敗清理 |
| `src/server.ts` | 舊路由交接、Nest create／init、外部 HTTP Server 所有權 |
| `src/article-query.module.ts` | Controller／Module 裝飾器，以 closure 暫接手動依賴 |
| `src/contract-exception.filter.ts` | 接回原 HTTP 錯誤 envelope |
| `src/lifecycle-lab.ts` | 獨立觀察 Middleware → Guard → Interceptor → Pipe → Controller 與錯誤分支 |
| `test/nest-query.test.ts` | 證明查詢真的走 Nest、GET／HEAD 行為、Filter 與應用隔離 |
| `test/migration-baseline.test.ts` | 真實 PostgreSQL 的完整舊 HTTP 基準 |

文章應用只對 Nest 呼叫 init，實際 listen 仍由外部 Node Server 負責。原協調器先等 HTTP 關閉，再等登記工作，才 close Nest 與 Prisma。不要再呼叫 nest.listen 或同時加第二套信號關閉流程。

lab 使用各自獨立的 Nest app、臨時端口與單一請求，不掛進文章 API。它的簡化 Guard 不是登入或授權功能。

## 匯出與停止

API 啟動且已 build 後：

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3014/api/articles/export -o /tmp/chapter-14-articles.ndjson
docker compose stop api postgres test-db
```

停止保留開發 postgres_data volume，不以 down -v 作一般停止。修改 src 後重新 build；修改依賴時先確認相容性與 lockfile，勿直接升級 latest。
