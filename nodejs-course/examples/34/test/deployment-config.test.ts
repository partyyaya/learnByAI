import { expect, test } from '@jest/globals';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { databaseUrlFrom, runtimeConfig } from '../src/runtime-config.js';
import { checkReadiness } from '../src/readiness-probe.js';
const url = 'postgresql://user:secret@postgres:5432/course?schema=public';
test('環境或檔案擇一，secret 接受單一 LF／CRLF，不改 URL 編碼', () => {
  expect(databaseUrlFrom({ DATABASE_URL: url })).toBe(url);
  for (const end of ['\n', '\r\n', '']) expect(databaseUrlFrom({ DATABASE_URL_FILE: '/run/secrets/db' }, () => Buffer.from(url + end))).toBe(url);
});
test.each([
  {}, { DATABASE_URL: '' }, { DATABASE_URL: url, DATABASE_URL_FILE: '/run/secrets/db' },
  { DATABASE_URL: '', DATABASE_URL_FILE: '/run/secrets/db' }, { DATABASE_URL_FILE: 'relative' },
  { DATABASE_URL: 'http://localhost/db' }, { DATABASE_URL: 'postgresql://localhost/' },
  { DATABASE_URL: url + '#fragment' }, { DATABASE_URL: ' ' + url },
])('缺漏或模糊設定拒絕，不猜測 fallback %j', env => expect(() => databaseUrlFrom(env)).toThrow());
test.each([Buffer.alloc(8193), Buffer.from([0xff]), Buffer.from(url + '\n\n')])('非法檔案大小／UTF-8／換行拒絕', bytes => {
  expect(() => databaseUrlFrom({ DATABASE_URL_FILE: '/secret' }, () => bytes)).toThrow();
});
test('secret 讀取失敗不 fallback 到另一個來源', () => {
  expect(() => databaseUrlFrom({ DATABASE_URL_FILE: '/missing' }, () => { throw new Error('not available'); })).toThrow();
});
test('正式設定只接受 HTTPS；開發原本 HTTP origin 與隨機 port 保留', () => {
  expect(() => runtimeConfig({ DATABASE_URL: url, APP_ORIGIN: 'http://127.0.0.1:3034', NODE_ENV: 'production' })).toThrow();
  expect(runtimeConfig({ DATABASE_URL: url, APP_ORIGIN: 'https://localhost:34434', NODE_ENV: 'production' }).origin).toBe('https://localhost:34434');
  expect(runtimeConfig({ DATABASE_URL: url, APP_ORIGIN: 'http://127.0.0.1:3034', PORT: '0' }).port).toBe(0);
});
test.each([{ PORT: '-1' }, { PORT: '65536' }, { SHUTDOWN_TIMEOUT_MS: '0' }, { HOST: 'evil.example' }, { APP_ORIGIN: '' }])('非法執行設定拒絕 %j', extra => {
  expect(() => runtimeConfig({ DATABASE_URL: url, APP_ORIGIN: 'https://localhost:34434', ...extra })).toThrow();
});
test('readiness probe 只認 200，慢 body／過大 body 失敗且釋放 socket', async () => {
  let mode: 'ok' | 'not-ready' | 'large' | 'slow' = 'ok';
  const server = createServer((_req, res) => {
    if (mode === 'slow') { res.writeHead(200); res.write('{'); return; }
    res.writeHead(mode === 'not-ready' ? 503 : 200); res.end(mode === 'large' ? 'x'.repeat(4096) : '{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as { port: number }).port;
  try {
    expect(await checkReadiness(port)).toBe(true);
    mode = 'not-ready'; expect(await checkReadiness(port)).toBe(false);
    mode = 'large'; expect(await checkReadiness(port)).toBe(false);
    mode = 'slow'; expect(await checkReadiness(port, 30)).toBe(false);
    expect(await checkReadiness(0)).toBe(false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
