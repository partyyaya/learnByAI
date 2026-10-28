import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { once } from 'node:events';
import { request } from 'node:http';
import { createArticleServer } from '../src/server.js';

const server = createArticleServer({ bodyTimeoutMs: 100 });
let port: number;
beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  port = address.port;
});
afterAll(async () => {
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
});

function call(path: string, method = 'GET', body?: string | Buffer, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body); // 未指定 Content-Length，會測到 chunked 傳送。
    req.end();
  });
}
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };

describe('遷移後保留的 HTTP 契約', () => {
  test('無法解析的 URL 回傳 400 而非內部錯誤', async () => {
    const result = await call('http://[');
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text).error.code).toBe('INVALID_URL');
  });
  test('健康檢查、UTF-8 JSON 與 request ID', async () => {
    const result = await call('/health/live?probe=1');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({ data: { status: 'ok' } });
    expect(result.headers['content-type']).toMatch(/application\/json/);
    expect(result.headers['x-request-id']).toBeTruthy();
  });
  test('列表分頁只計公開資料', async () => {
    const result = await call('/api/articles?page=2&pageSize=1');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toMatchObject({ data: [{ id: 'a_2' }], meta: { page: 2, pageSize: 1, total: 2 } });
  });
  test.each(['/api/articles?page=0', '/api/articles?page=1&page=2', '/api/articles?pageSize=101', '/api/articles?authorId=x'])('拒絕非法 query：%s', async path => {
    expect((await call(path)).status).toBe(400);
  });
  test.each(['/unknown', '/api/articles/missing', '/api/articles/a_draft'])('未知或不可見資源：%s', async path => {
    const result = await call(path);
    expect(result.status).toBe(404);
    expect(JSON.parse(result.text).requestId).toBe(result.headers['x-request-id']);
  });
  test('已知路由錯誤方法提供 Allow', async () => {
    const result = await call('/api/articles', 'DELETE');
    expect(result.status).toBe(405);
    expect(result.headers.allow).toBe('GET, HEAD, POST');
  });
  test('HEAD 回傳 GET 的長度，但不傳 body', async () => {
    const get = await call('/api/articles/a_1');
    const head = await call('/api/articles/a_1', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(get.text));
  });
  test('預覽只回傳標準化草稿，不新增公開資料', async () => {
    const result = await call('/api/articles/preview', 'POST', JSON.stringify({ title: ' 中文🙂 ', content: ' 內容 ' }), jsonHeaders);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({ data: { title: '中文🙂', content: '內容', status: 'draft', preview: true } });
    expect(Number(result.headers['content-length'])).toBe(Buffer.byteLength(result.text));
    expect(JSON.parse((await call('/api/articles')).text).meta.total).toBe(2);
  });
  test.each(['', '{', 'null', '[]', '{"title":1,"content":"ok"}', '{"title":" ","content":"ok"}', '{"title":"a","content":"b","authorId":"u_other"}'])('拒絕無效 JSON／輸入：%s', async body => {
    expect((await call('/api/articles/preview', 'POST', body, jsonHeaders)).status).toBe(400);
  });
  test('拒絕錯誤媒體類型及壓縮 body', async () => {
    expect((await call('/api/articles/preview', 'POST', '{}', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await call('/api/articles/preview', 'POST', '{}', { ...jsonHeaders, 'Content-Encoding': 'gzip' })).status).toBe(415);
  });
  test('拒絕非法 UTF-8', async () => {
    const result = await call('/api/articles/preview', 'POST', Buffer.from([0xff]), jsonHeaders);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text).error.code).toBe('INVALID_ENCODING');
  });
  test.each([false, true])('body 超過 16 KiB，帶 Content-Length=%s', async knownLength => {
    const body = 'x'.repeat(17 * 1024);
    const headers = knownLength ? { ...jsonHeaders, 'Content-Length': String(Buffer.byteLength(body)) } : jsonHeaders;
    const result = await call('/api/articles/preview', 'POST', body, headers);
    expect(result.status).toBe(413);
    expect(result.headers.connection).toBe('close');
  });
  test('body 不結束時回傳 408', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/articles/preview', method: 'POST', headers: jsonHeaders, agent: false }, res => {
        res.resume();
        res.on('end', () => { resolve(res.statusCode!); req.destroy(); });
      });
      req.on('error', reject);
      req.write('{'); // 故意不 end。
    });
    expect(status).toBe(408);
  });
  test('用戶端上傳途中中斷後，服務仍能接受下一個請求', async () => {
    const received = once(server, 'request');
    const req = request({ host: '127.0.0.1', port, path: '/api/articles/preview', method: 'POST', headers: jsonHeaders, agent: false });
    req.on('error', () => {});
    req.write('{');
    await received;
    const closed = new Promise<void>(resolve => req.once('close', resolve));
    req.destroy();
    await closed;
    expect((await call('/health/live')).status).toBe(200);
  });
});
