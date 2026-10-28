import { createArticleServer } from './server.js';

const rawPort = process.env.PORT ?? '3000';
const port = Number(rawPort);
const rawTimeout = process.env.SHUTDOWN_TIMEOUT_MS ?? '3000';
const timeoutMs = Number(rawTimeout);
const host = process.env.HOST ?? '127.0.0.1';
if (!/^[0-9]+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535 || !/^[0-9]+$/.test(rawTimeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !['127.0.0.1', '0.0.0.0'].includes(host)) {
  console.error('設定錯誤：PORT 為 0–65535 整數；SHUTDOWN_TIMEOUT_MS 為 1–60000；HOST 為 127.0.0.1 或 0.0.0.0');
  process.exitCode = 1;
} else {
  const server = createArticleServer({ onTrace: trace => console.log(`REQUEST_TRACE ${JSON.stringify(trace)}`), timeoutMs, onEvent: event => console.log(`SHUTDOWN ${event}`), onExportFinished: result => console.log(`EXPORT_RESULT ${JSON.stringify(result)}`) });
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`SIGNAL ${signal}`);
    void server.lifecycle.shutdown().then(() => {
      // 成功時讓已完成的輸出自然排空。
      process.exitCode = 0;
    }, (error: unknown) => {
      console.error(`SHUTDOWN_FAILED ${error instanceof Error ? error.message : 'unknown'}`);
      // 最終失敗路徑才強制結束；不保證非合作式工作與日誌都完成。
      process.exit(1);
    });
  };
  server.on('error', () => { console.error('HTTP 服務啟動或執行失敗'); process.exitCode = 1; });
  server.listen(port, host, () => {
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    const address = server.address();
    if (address && typeof address !== 'string') console.log(`LISTENING ${JSON.stringify({ host, port: address.port })}`);
  });
}
