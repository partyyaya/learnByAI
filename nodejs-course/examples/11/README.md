# 11 章可執行範例

教材：[PostgreSQL、Prisma 與 migration](../../11-postgres-prisma-and-migrations.md)。使用 Prisma 7.10.1、PostgreSQL 17、固定作者 u_demo；尚無登入授權，僅供本機教學。

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/11
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
curl -i http://127.0.0.1:3011/health/ready
curl -i http://127.0.0.1:3011/api/articles
```

| 指令 | 用途 |
|------|------|
| `npm run generate` | 產生 Prisma Client，不建資料表 |
| `npm run check` | generate、型別、27 項測試、build、隔離資料庫上的程序驗證 |
| `npm run db:deploy` | 套用已提交 migration |
| `npm run db:status` | 查看 migration 狀態 |
| `npm run db:seed` | 補上缺少的示範作者與文章，不覆寫已有資料 |
| `npm run seed` | 產生獨立 NDJSON 檔案，並非資料庫匯出 |

API 主機端口 **3011**；開發資料庫為 **127.0.0.1:15411**。容器內 API 使用 postgres:5432；測試使用獨立 test-db:5432/course_test，沒有公開主機端口。

check 只操作測試資料庫中本次建立的隨機 schema，不會清掉 public 的開發文章。Jest 因 Prisma 動態 import 使用 VM modules 旗標，已寫入 scripts。

正常收工：

```bash
docker compose stop api postgres test-db
```

開發資料保留在 postgres_data volume；不要用 `down -v` 代替正常停止。修改 model 後重新 generate，修改程式後重新 build；結構變更另需 migration。完整本機 Node 路線、重啟驗證與故障排查見教材。

npm audit 的低嚴重度提示來自 Jest 的 deepmerge 開發依賴鏈；未強制降級測試工具。API 執行期依賴與測試工具應分開評估。
