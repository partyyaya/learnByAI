# 04 章可執行範例

教材：[非同步錯誤、取消與資源生命週期](../../04-async-errors-and-resource-lifecycle.md)。這是程序內的事件等待與期限練習，不需要 `.env`、HTTP 或資料庫。

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/04
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm start
```

本機使用 `.nvmrc` 的 Node 與 npm 11.19.1，移除容器前綴即可。修改 TypeScript 後先 `npm run build`。

`npm start` 示範成功、來源錯誤、逾時與取消，四條路徑結束後的自有 listener 數量皆為 0，程序會自行結束。

`npm run check` 包含型別檢查、18 個 Jest 測試、建置與 7 項程序檢查。預期會中止的未處理錯誤在獨立子程序驗證，不會中斷整組檢查。

可單獨觀察錯誤：

```bash
docker compose run --rm tools node --unhandled-rejections=strict experiments/errors.cjs awaited
docker compose run --rm tools node --unhandled-rejections=strict experiments/errors.cjs detached
```

第一條預期正常捕捉；第二條預期非零結束。其他模式為 `returned`、`callback`、`emitter`、`async-listener`，完整解說見教材。

期限 helper 會通知取消，但不能停止忽略 signal 的底層工作，也不能搶占同步 CPU 計算。測試包含「呼叫端已逾時，底層 timer 仍會完成」的案例，確認這項限制。
