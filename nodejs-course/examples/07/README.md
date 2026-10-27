# 07 章可執行範例

教材：[程序生命週期、信號與有界關閉](../../07-process-signals-and-graceful-shutdown.md)。保留 06 章 API，新增 HTTP 排空、handler 清理追蹤、整體關閉期限與真實信號測試。

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/07
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose up -d api
curl -i http://127.0.0.1:3007/health/ready
docker compose stop api
docker compose logs api
docker compose ps -a api
```

正常停止依序記錄 `draining`、`http-drained`、`closed`，退出碼為 0。預設應用關閉期限 3000 ms，Docker 寬限時間 8 秒；API 容器透過 init 直接啟動 Node。

| 指令 | 功能 |
|------|------|
| `npm run check` | 型別檢查、Jest、建置與子程序信號驗證 |
| `npm run test:runtime` | 使用已建置的入口驗證設定錯誤、信號、進行中請求與期限 |
| `npm run seed` | 沿用 06 章教學 NDJSON 產生器；下載前才需要執行 |
| `npm start` | 本機啟動；預設 127.0.0.1:3000 |

修改程式後先重新建置。原有預覽與匯出仍可用；匯出檔與文章列表是獨立教學資料。本機需使用 `.nvmrc` 的 Node 與 npm 11.19.1；信號測試建議用 Linux Docker，避免 Windows 信號模擬差異。
