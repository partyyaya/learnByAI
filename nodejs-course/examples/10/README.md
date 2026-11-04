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

2026-11-02 複查 npm ci 的 audit 回報 19 個受影響套件節點（3 low、16 moderate，無 high／critical），涉及 Jest／glob／minimatch／deepmerge 開發依賴鏈。套件及 lockfile 未改，未執行 audit fix --force；這不是 19 個彼此獨立的漏洞，也不是完整安全稽核。
