# 03 章可執行範例

教材：[事件迴圈、microtask、I/O 與併發](../../03-event-loop-and-concurrency.md)。這是獨立的執行模型實驗，不需要 `.env`，沒有 HTTP 服務或資料庫。

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/03
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm start
docker compose run --rm tools npm run order
docker compose run --rm tools npm run pool
```

本機使用 `.nvmrc` 的 Node 與 npm 11.19.1，移除容器前綴即可。修改 TypeScript 後先 `npm run build`，再執行既有建置。

| 指令 | 內容 |
|------|------|
| `npm start` | 等待與 CPU 阻塞比較，及最多兩項同時進行的示範 |
| `npm run order` | 比較 CommonJS／ESM 頂層執行順序 |
| `npm run pool` | 新子程序以 `UV_THREADPOOL_SIZE=1` 觀察 pool 工作競爭 |
| `npm run check` | 型別、8 個 Jest 測試、建置與 6 項真實程序實驗 |

耗時受硬體與負載影響，測試檢查有明確前提的事件順序與併發上限，不以固定毫秒門檻驗收。CPU 實驗刻意忙碌約 120 ms 後結束，microtask 實驗也採有限次數。
