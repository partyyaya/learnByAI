import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mkdtemp, writeFile, open, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { request, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArticleServer } from '../src/server.js';
import type { ExportResult } from '../src/export.js';

let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'export-test-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
async function stop(server: Server) {
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}
async function start(filename: string) {
  let report!: (value: ExportResult) => void;
  const finished = new Promise<ExportResult>(resolve => { report = resolve; });
  const server = createArticleServer({ exportFile: filename, onExportFinished: report });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return { server, port: address.port, finished };
}
function call(port: number, method = 'GET', path = '/api/articles/export') {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

describe('HTTP 串流匯出', () => {
  test('完整傳送 Unicode NDJSON，結束後關閉檔案', async () => {
    const text = '{"title":"中文🙂"}\n{"title":"第二篇"}\n';
    const filename = join(directory, 'normal.ndjson');
    await writeFile(filename, text);
    const app = await start(filename);
    try {
      const result = await call(app.port);
      expect(result.status).toBe(200);
      expect(result.headers['content-type']).toMatch(/application\/x-ndjson/);
      expect(result.headers['content-disposition']).toContain('attachment');
      expect(result.body.equals(Buffer.from(text))).toBe(true);
      expect(Number(result.headers['content-length'])).toBe(Buffer.byteLength(text));
      expect(await app.finished).toEqual({ outcome: 'complete', bytesRead: Buffer.byteLength(text), fileClosed: true });
    } finally { await stop(app.server); }
  });

  test('HEAD 只回傳中繼資料，不讀整份檔案', async () => {
    const filename = join(directory, 'head.ndjson');
    await writeFile(filename, 'one\n');
    const app = await start(filename);
    try {
      const result = await call(app.port, 'HEAD');
      expect(result.status).toBe(200);
      expect(result.body.length).toBe(0);
      expect(result.headers['content-length']).toBe('4');
      expect(await app.finished).toEqual({ outcome: 'complete', bytesRead: 0, fileClosed: true });
    } finally { await stop(app.server); }
  });

  test('檔案不存在時在串流開始前回傳 JSON 404', async () => {
    const app = await start(join(directory, 'missing.ndjson'));
    try {
      const result = await call(app.port);
      expect(result.status).toBe(404);
      expect(JSON.parse(result.body.toString()).error.code).toBe('EXPORT_NOT_FOUND');
    } finally { await stop(app.server); }
  });

  test('不接受用 URL 指定其他磁碟檔案', async () => {
    const app = await start(join(directory, 'unused.ndjson'));
    try { expect((await call(app.port, 'GET', '/api/articles/export?file=../../package.json')).status).toBe(400); }
    finally { await stop(app.server); }
  });

  test('下載中斷後停止讀取並關閉檔案，服務仍可回應', async () => {
    const filename = join(directory, 'large.ndjson');
    const handle = await open(filename, 'w');
    const size = 64 * 1024 * 1024;
    try { await handle.truncate(size); } finally { await handle.close(); }
    const app = await start(filename);
    try {
      await new Promise<void>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: app.port, path: '/api/articles/export', agent: false }, res => {
          res.on('error', () => {});
          res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
        });
        req.on('error', reject); req.end();
      });
      const report = await app.finished;
      expect(report.outcome).toBe('interrupted');
      expect(report.fileClosed).toBe(true);
      expect(report.bytesRead).toBeLessThan(size);
      expect((await call(app.port, 'GET', '/health/live')).status).toBe(200);
    } finally { await stop(app.server); }
  });
});
