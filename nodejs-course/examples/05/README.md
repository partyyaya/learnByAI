# 05 章可執行範例

教材：[原生 HTTP：請求、回應與輸入邊界](../../05-native-http-request-response.md)。固定文章查詢與不持久化的草稿預覽，沒有登入或資料庫。

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/05
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose up api
```

另一個主機終端機：

```bash
curl -i http://127.0.0.1:3005/health/live
curl -i 'http://127.0.0.1:3005/api/articles?page=1&pageSize=1'
curl -i http://127.0.0.1:3005/api/articles/preview \
  -H 'Content-Type: application/json' \
  --data '{"title":"第一篇文章","content":"HTTP 練習"}'
```

本機 Node 路線使用 `.nvmrc` 與 npm 11.19.1，執行 `npm ci`、`npm run check`、`npm start`，預設連接埠為 3000。Docker 主機映射為 3005。

`check` 包含 26 個 HTTP 測試、型別與建置，以及入口啟動檢查。修改原始碼後先重新建置並重啟服務。`Ctrl+C` 停止前景服務。

body 上限 16 KiB，預覽只接受 UTF-8 JSON；缺少 end 的 body 會在 reader 期限到達時拒絕。預覽成功不會新增公開文章，詳見教材的契約範圍。
