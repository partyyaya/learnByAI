import { createArticleServer } from './server.js';

const rawPort = process.env.PORT ?? '3000';
const port = Number(rawPort);
const host = process.env.HOST ?? '127.0.0.1';
if (!/^[0-9]+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535 || !['127.0.0.1', '0.0.0.0'].includes(host)) {
  console.error('設定錯誤：PORT 為 0–65535 整數；HOST 為 127.0.0.1 或 0.0.0.0');
  process.exitCode = 1;
} else {
  const server = createArticleServer();
  server.on('error', () => { console.error('HTTP 服務啟動或執行失敗'); process.exitCode = 1; });
  server.listen(port, host, () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(`LISTENING ${JSON.stringify({ host, port: address.port })}`);
  });
}
