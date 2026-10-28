# 10 章可執行範例

教材：[錯誤處理與 HTTP 契約測試](../../10-error-handling-and-api-tests.md)。集中錯誤出口，加入 Supertest 與隔離的故障 app；文章 API 仍採固定作者與記憶體 Map，只供本機教學。

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/10
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose up api
```

另一個終端機：

```bash
curl -i http://127.0.0.1:3010/api/articles/missing
```

對照回應 request ID、REQUEST_TRACE 與 HTTP_ERROR。錯誤實驗路由只存在於測試，不會出現在文章 API。

| 指令 | 功能 |
|------|------|
| `npm run check` | 型別、89 項 Jest 測試、建置、程序信號驗證 |
| `npm test -- --testPathPatterns=error-contract` | 只跑錯誤情境測試 |
| `npm run seed` | 沿用獨立 NDJSON 教學匯出檔 |
| `npm start` | 本機預設 127.0.0.1:3000 |
| `docker compose stop api` | 正常停止流程 |

修改原始碼後重新建置；Docker 主機端口 3010。本機使用固定 Node／npm；信號測試建議透過 Linux Docker。

本次安裝的 npm audit 回報 Jest → deepmerge 開發依賴鏈的低嚴重度問題；未使用會降級 Jest 的 `audit fix --force`。它不屬於 API 的執行期依賴，後續升級測試工具時應重新查核。
