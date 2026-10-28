# 12 章可執行範例

教材：[Controller、Service、Repository 與手動依賴注入](../../12-service-repository-and-manual-di.md)。本章由 11 章複製後獨立演進，保留 HTTP 契約與 Prisma 7.10.1／PostgreSQL 17。固定作者 u_demo，尚無登入授權，僅供本機教學。

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/12
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose up api
```

另一個終端機：

```bash
curl -i http://127.0.0.1:3012/health/ready
curl -i http://127.0.0.1:3012/api/articles
curl -i http://127.0.0.1:3012/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"手動 DI","content":"保持 HTTP 契約。"}'
```

建立回 201、version 1，Location 指向管理查詢。新草稿從公開端點查詢仍回 404。完整 PATCH、舊版本衝突、發佈與封存操作見教材。

| 檔案 | 責任 |
|------|------|
| `src/article-model.ts` | 不依賴框架的文章型別、輸入與業務錯誤 |
| `src/article-repository.ts` | 資料操作介面、條件更新與交易約定 |
| `src/article-service.ts` | 可見範圍、版本與狀態規則 |
| `src/prisma-article-repository.ts` | 真正的 Prisma 查詢、條件 UPDATE、交易與列表快照 |
| `src/article-controller.ts` | 讀 res.locals、呈現日期、狀態碼與 Location |
| `src/server.ts` | Router、驗證、錯誤出口與工作追蹤 |
| `src/application.ts` | 手動組裝依賴，接上 readiness 與資料庫清理 |
| `src/main.ts` | 環境設定、啟動檢查與程序信號 |

每個應用共用一組 Repository／Service 與 database pool；應用停止時關閉傳入的 database，不能讓兩個各自停止的應用共用同一 client。Service 的交易 callback 只使用傳入的 tx，不使用外層 db。

| 指令 | 用途 |
|------|------|
| `npm run generate` | 產生 Prisma Client，不建資料表 |
| `npm run check` | generate、型別、58 項測試、build、隔離資料庫上的程序驗證 |
| `npm test -- --testPathPatterns=article-service.test.js` | 只跑 19 項 Service 測試，不連資料庫；先 generate |
| `npm test -- --testPathPatterns=controller.test.js` | 只跑 8 項 HTTP 邊界與注入測試；先 generate |
| `npm test -- --testPathPatterns=database.test.js` | 15 項真實資料庫／HTTP 測試；需 test-db 與 generate |
| `npm run db:deploy`／`npm run db:status` | 套用／檢查已提交 migration |
| `npm run db:seed` | 補上缺少的示範作者與文章，不覆寫已有資料 |
| `npm run seed` | 產生獨立 NDJSON 教學檔，並非資料庫匯出 |

API 主機端口 **3012**；開發資料庫主機端口 **15412**。容器內使用 postgres:5432；測試使用 test-db:5432/course_test，不公開主機端口。第 12 章有獨立 Compose 專案與 volume，不會自動帶入第 11 章的開發文章。

單元測試的 Repository 替身只控制回傳與錯誤，不保證 SQL、鎖或回滾。database.test.ts 使用隨機 schema 與真實 PostgreSQL，確認兩個交易先讀到同一版本後仍只有一個成功、status 也在 UPDATE 條件內，以及 callback 失敗後整段回滾。test/api-contract.ts 與第 10、11 章完全相同。

完整 check 只清理 TEST_DATABASE_URL 中自己建立的 schema。Jest 因 Prisma 動態 import 使用 VM modules 旗標，已寫入 scripts。test:runtime 依賴 test 產生的 `.test-dist` 與 build 產生的 `dist`，通常直接執行 check。

不啟動資料庫，只跑 Service 測試：

```bash
docker compose run --rm tools npm run generate
docker compose run --rm tools npm test -- --testPathPatterns=article-service.test.js
```

匯出練習（先 build 並啟動 API）：

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3012/api/articles/export -o /tmp/chapter-12-articles.ndjson
```

正常收工：

```bash
docker compose stop api postgres test-db
```

開發資料保留在 postgres_data volume；不要用 down -v 代替正常停止。修改程式後重新 build，修改 Prisma model 後另需 generate／migration；本章未修改資料庫結構。

npm audit 仍有 Jest → deepmerge 開發依賴鏈的低嚴重度提示；未使用會降級 Jest 的強制修復。沿用固定版本與 lockfile，未依 npm 的新版提示升級工具。
