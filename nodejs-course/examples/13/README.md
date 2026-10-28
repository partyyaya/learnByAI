# 13 章可執行範例

教材：[Express 專題驗收與 NestJS 遷移基準](../../13-express-capstone-and-migration-baseline.md)。[BASELINE.md](BASELINE.md) 記錄後續遷移需要保留的路由、輸入、回應、狀態與生命週期。

從第 12 章獨立複製，src、Prisma schema 與 migration 相同；本章新增驗收測試與文件，不新增業務端點。固定作者 u_demo，尚無認證授權，僅供本機教學。各套件版本沿用第 12 章，不安裝 NestJS。

## 完整執行

從倉庫根目錄：

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

另一個終端機：

```bash
curl -i http://127.0.0.1:3013/health/ready
curl -i http://127.0.0.1:3013/api/articles
curl -i http://127.0.0.1:3013/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"Express 驗收","content":"留下可以遷移的基準。"}'
```

建立回 201、version 1、Location 指向管理查詢；草稿由公開端點查詢回 404。完整 PATCH／衝突／發佈／封存／重啟流程見教材。

API 主機端口 **3013**，開發資料庫主機端口 **15413**。容器內連 postgres:5432/course；測試連 test-db:5432/course_test，沒有公開主機端口。本章有獨立 Compose 專案與 volume。

## 指令與新增檔案

| 指令 | 用途 |
|------|------|
| `npm run check` | generate、型別、92 項 Jest 測試、build、真實程序驗證 |
| `npm run test:baseline` | 重新編譯後執行 32 項遷移 HTTP 案例；先 generate，需 test-db |
| `npm run test:baseline -- --testNamePattern=B03` | 只排查 B03；不代表完整驗收 |
| `npm test -- --testPathPatterns=database-isolation.test.js` | 只測 URL 防護與 schema 隔離；先 generate，需 test-db |
| `npm run generate`／`npm run build` | 產生 Prisma Client／編譯應用 |
| `npm run db:deploy`／`npm run db:status` | 套用／查看開發資料庫 migration |
| `npm run db:seed` | 補上缺少的資料庫種子，不覆寫已有文章 |
| `npm run seed` | 產生獨立 NDJSON 教學檔，並非資料庫匯出 |

| 檔案 | 用途 |
|------|------|
| `BASELINE.md` | 實作範圍、路由與資料契約、測試前提、遷移對照 |
| `test/api-contract.ts` | 與 10–12 章相同的 3 項核心 HTTP 契約 |
| `test/migration-contract.ts` | B01–B15 群組，參數展開為 29 項；不依賴 Express 或 Prisma |
| `test/migration-baseline.test.ts` | 隔離 schema、seed、臨時匯出檔與服務組裝，執行上述兩組契約 |
| `test/database-isolation.test.ts` | 2 項隔離驗證，包含清理 A schema 後 B 仍可讀寫 |

完整測試由第 12 章的 58 項、遷移基準 32 項、隔離 2 項組成；原有 3 項契約在資料庫與遷移基準兩處執行，因此總數包含重複驗證。test:runtime 另使用隔離 schema 啟動真實程序，驗證缺設定／migration、SIGINT／SIGTERM、進行中請求與停止期限。

check 不清理開發 public；每套資料庫 fixture 建立隨機 schema，結束時只刪自己的 schema。測試用的匯出檔建立於臨時目錄，不依賴手動 seed。Jest 的 VM modules 旗標已寫入 scripts；一般 API 啟動不需要。

## 匯出與停止

先 build 並啟動 API，再產生檔案：

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3013/api/articles/export -o /tmp/chapter-13-articles.ndjson
```

正常收工：

```bash
docker compose stop api postgres test-db
```

開發資料保留在 postgres_data volume，不以 down -v 作一般停止。修改 src 後重新 build，修改測試後重新跑 test；test:runtime 依賴 `.test-dist` 與 `dist`，通常直接跑 check。

npm ci 回報 5 項低嚴重度 audit 提示，沿用 Jest → deepmerge 開發依賴鏈；未使用會降級 Jest 的強制修復。套件與 lockfile 版本維持不變。
