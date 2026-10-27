# 06 章可執行範例

教材：[檔案、Buffer、串流與背壓](../../06-files-buffers-streams-backpressure.md)。保留 05 章 HTTP 契約，新增固定 NDJSON 檔案下載；沒有資料庫。

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/06
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run seed
docker compose up api
```

另一個主機終端機、同樣位於此目錄：

```bash
curl -I http://127.0.0.1:3006/api/articles/export
curl -f http://127.0.0.1:3006/api/articles/export --output .data/download.ndjson
```

本機路線移除容器前綴，使用 `.nvmrc` 的 Node 與 npm 11.19.1，服務預設為 3000；Docker 的主機映射為 3006。

| 指令 | 功能 |
|------|------|
| `npm run check` | 型別、34 個測試、建置與入口啟動檢查 |
| `npm run seed` | 逐筆產生 20000 筆 NDJSON 到 `.data/articles.ndjson` |
| `npm run seed -- 200000` | 建立較大的樣本，方便觀察下載中斷 |
| `npm run encoding` | 比較字串長度、bytes 與跨 chunk 解碼 |
| `npm run files` | 在自己的暫存目錄寫入、讀取並清理小檔案 |

修改原始碼後重新建置再啟動；`.data` 不提交 Git。匯出資料集是獨立教學樣本，不是固定文章列表的持久化結果。

伺服器以 `EXPORT_RESULT` 記錄完成／中斷、來源讀取量與檔案關閉結果。完整限速與中斷操作、背壓說明見教材。
