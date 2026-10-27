# 08 章可執行範例

教材：[Express 路由與 HTTP 契約](../../08-express-routing-and-http-contracts.md)。使用 Express 5.3.0 與記憶體 Map，完成文章建立、查詢、修改、發佈與封存，沿用 07 章關閉流程。

**尚未加入登入與授權，只供本機教學。** 作者固定為 `u_demo`，`/api/me/articles` 也是這個示範作者的管理查詢。文章在重啟後恢復初始資料。

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/08
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose up api
```

另一個終端機：

```bash
curl -i 'http://127.0.0.1:3008/api/articles?page=1&pageSize=20'
curl -i http://127.0.0.1:3008/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"第一篇文章","content":"練習 Express 路由。"}'
```

建立回傳 201 與 Location；依教材使用真正 ID 完成 PATCH、publish、archive。新草稿在公開端點回 404，先使用 Location 查詢。

| 指令 | 功能 |
|------|------|
| `npm run check` | 型別檢查、Jest、建置與真實信號檢查 |
| `npm run seed` | 建立獨立的教學匯出檔，並非匯出當前 Map |
| `npm run test:runtime` | 使用已建置的入口驗證停止流程 |
| `npm start` | 本機啟動，預設 127.0.0.1:3000 |
| `docker compose stop api` | 送出停止信號，等待服務關閉 |

修改程式後重新建置再啟動。本機使用 `.nvmrc` 的 Node 與 npm 11.19.1；信號檢查建議使用 Linux Docker。Docker 主機端口 3008，容器內為 3000。
