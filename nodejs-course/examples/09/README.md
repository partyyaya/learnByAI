# 09 章可執行範例

教材：[Middleware 順序、next 與輸入驗證](../../09-middleware-order-and-input-validation.md)。沿用 08 章文章 API，以 Zod 4.6.7 整理輸入規格，新增請求步驟紀錄與 middleware 實驗。

仍使用固定作者 `u_demo` 與記憶體 Map，尚未加入登入授權，只供本機教學；重啟後恢復種子資料。

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/09
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run lab
docker compose up api
```

另一個終端機：

```bash
curl -i http://127.0.0.1:3009/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":"  驗證 middleware  ","content":"先解析，再驗證。"}'
curl -i http://127.0.0.1:3009/api/articles \
  -H 'Content-Type: application/json' \
  --data '{"title":123,"content":"不應寫入"}'
```

第一個回 201，第二個回 400 並提供 `body.title` 的錯誤線索。對照回應 `X-Request-ID` 與服務終端機的 `REQUEST_TRACE`，觀察第二次請求沒有進入 handler。

| 指令 | 功能 |
|------|------|
| `npm run check` | 型別檢查、78 項 Jest 測試、建置與真實信號檢查 |
| `npm run lab` | 使用已建置的小型服務，觀察 next、直接回應與錯誤分流 |
| `npm run seed` | 建立獨立教學匯出檔，不代表目前 Map 的內容 |
| `npm start` | 本機啟動，預設 127.0.0.1:3000 |
| `docker compose stop api` | 沿用 07 章的有界關閉流程 |

修改原始碼後先重新建置。本機使用 `.nvmrc` 的 Node 與 npm 11.19.1；信號測試建議使用 Linux Docker。Docker 主機連接埠為 3009，容器內為 3000。
