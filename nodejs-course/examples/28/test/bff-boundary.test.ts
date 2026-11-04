import { expect, test } from '@jest/globals';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createBffBoundary } from '../src/bff-boundary.js';
test('兩個並行呼叫只傳本人 Session Cookie，不傳 Authorization／角色，回應白名單 no-store', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.cookie ?? ''); expect(req.headers.authorization).toBeUndefined();
    expect(req.url).toBe('/api/me/articles?pageSize=5');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'a', title: req.headers.cookie?.includes('a'.repeat(43)) ? 'A' : 'B', status: 'draft', version: 1, passwordHash: 'SECRET' }], meta: { page: 1, pageSize: 5, total: 1 }, internal: 'SECRET' }));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const bff = createBffBoundary(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 'https://app.example.test');
    const results = await Promise.all(['a', 'b'].map(value => bff.listOwn(new Request('https://app.example.test/summary', { headers: { Cookie: `other=SECRET; __Host-course_session=${value.repeat(43)}`, Authorization: 'Bearer SECRET' } }))));
    expect(results.map(result => result.status)).toEqual([200, 200]); expect(results[0].headers.get('cache-control')).toBe('no-store');
    const text = await Promise.all(results.map(result => result.text())); expect(text[0]).toContain('"title":"A"'); expect(text[1]).toContain('"title":"B"'); expect(text.join('')).not.toContain('SECRET');
    expect(seen).toHaveLength(2); expect(seen.every(value => !value.includes('other='))).toBe(true);
    expect((await bff.listOwn(new Request('https://app.example.test/summary'))).status).toBe(401);
    const method = await bff.listOwn(new Request('https://app.example.test/summary', { method: 'POST' }));
    expect(method.status).toBe(405); expect(method.headers.get('allow')).toBe('GET');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('BFF 上游錯誤／redirect 不轉送 body、Cookie 或憑證', async () => {
  const server = createServer((_req, res) => { res.writeHead(302, { Location: 'http://example.invalid', 'Set-Cookie': 'SECRET' }); res.end('SECRET'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const bff = createBffBoundary(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 'http://127.0.0.1:3028');
    const result = await bff.listOwn(new Request('http://127.0.0.1:3028/summary', { headers: { Cookie: 'course_session=' + 'a'.repeat(43) } }));
    expect(result.status).toBe(502); expect(result.headers.get('set-cookie')).toBeNull(); expect(await result.text()).not.toContain('SECRET');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test.each(['application/jsonp', 'text/html'])('BFF 拒絕非 JSON media type %s，即使 body 是合法 JSON', async mediaType => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': mediaType }); res.end(JSON.stringify({ data: [], meta: { page: 1, pageSize: 5, total: 0 } })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const bff = createBffBoundary(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 'https://app.example.test');
    const response = await bff.listOwn(new Request('https://app.example.test/summary', { headers: { Cookie: '__Host-course_session='+'a'.repeat(43) } }));
    expect(response.status).toBe(502);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test.each(['large', 'slow', 'cancel'] as const)('BFF 對真 HTTP %s 回應有界並取消 reader', async mode => {
  let sent!: () => void; const started = new Promise<void>(resolve => { sent = resolve; });
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.write('{"data":'); sent(); if (mode === 'large') res.end('x'.repeat(128*1024)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const controller = new AbortController();
    const bff = createBffBoundary(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 'https://app.example.test');
    const pending = bff.listOwn(new Request('https://app.example.test/summary', { signal: controller.signal, headers: { Cookie: '__Host-course_session='+'a'.repeat(43) } }));
    await started; if (mode === 'cancel') controller.abort();
    const response = await pending; expect(response.status).toBe(mode === 'slow' ? 504 : mode === 'cancel' ? 503 : 502);
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.text()).not.toContain('xxxxxxxx');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
