import { once } from 'node:events';
import { createArticleServer } from './server.js';
import { createDatabase } from './database.js';

async function main() {
  const rawPort = process.env.PORT ?? '3000';
  const rawTimeout = process.env.SHUTDOWN_TIMEOUT_MS ?? '3000';
  const port = Number(rawPort); const timeoutMs = Number(rawTimeout);
  const host = process.env.HOST ?? '127.0.0.1';
  if (!/^[0-9]+$/.test(rawPort) || !Number.isInteger(port) || port > 65535 ||
      !/^[0-9]+$/.test(rawTimeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      !['127.0.0.1', '0.0.0.0'].includes(host) || !process.env.DATABASE_URL) throw new Error('設定不合法');
  const database = createDatabase(process.env.DATABASE_URL);
  try {
    await database.$connect();
    await database.article.count(); // pg_isready 成功仍不代表 migration 已套用。
    const server = createArticleServer({ database, timeoutMs,
      onError: report => console.error(`HTTP_ERROR ${JSON.stringify(report)}`),
      onTrace: trace => console.log(`REQUEST_TRACE ${JSON.stringify(trace)}`),
      onEvent: event => console.log(`SHUTDOWN ${event}`),
      onExportFinished: result => console.log(`EXPORT_RESULT ${JSON.stringify(result)}`),
    });
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) return; stopping = true;
      console.log(`SIGNAL ${signal}`);
      void server.lifecycle.shutdown().then(() => { process.exitCode = 0; }, () => {
        console.error('SHUTDOWN_FAILED'); process.exit(1);
      });
    };
    server.listen(port, host); await once(server, 'listening');
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    const address = server.address();
    if (address && typeof address !== 'string') console.log(`LISTENING ${JSON.stringify({ host, port: address.port })}`);
  } catch (error) { await database.$disconnect(); throw error; }
}
void main().catch(() => {
  // 不把 DATABASE_URL 或 driver 內部訊息直接印出。
  console.error('STARTUP_FAILED：請檢查設定、資料庫連線與 migration'); process.exitCode = 1;
});
