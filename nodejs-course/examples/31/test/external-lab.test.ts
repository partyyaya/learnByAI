import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { request } from 'node:http';
import { once } from 'node:events';
import raw from 'supertest';
import { createExternalLab } from '../src/external-lab.js';
import { createReferenceUpstream } from '../src/reference-upstream.js';
import { waitUntil } from './external-test-utils.js';

let upstream: Awaited<ReturnType<typeof createReferenceUpstream>>;
let lab: Awaited<ReturnType<typeof createExternalLab>>;
beforeEach(async () => {
  upstream = await createReferenceUpstream();
  lab = await createExternalLab({ origin: upstream.origin, totalTimeoutMs: 600, attemptTimeoutMs: 150 });
  lab.server.listen(0, '127.0.0.1'); await once(lab.server, 'listening');
});
afterEach(async () => { try { await lab?.lifecycle.shutdown(); } finally { await upstream?.close(); } });

test('Nest Provider 單例 client 接到 Controller，公開投影不轉送 Cookie／CSRF', async () => {
  const result = await raw(lab.server).get('/lab/topics/retry').set('Cookie', 'course_session=SECRET')
    .set('Authorization', 'Bearer SECRET').set('X-CSRF-Token', 'SECRET').expect(200);
  expect(result.body).toEqual({ data: { id: 'retry', label: '參考主題' } });
  expect(result.text).not.toContain('SECRET'); expect(upstream.stats.credentialForwarded).toBe(false);
  expect(upstream.stats.attempts.retry).toBe(3); expect(lab.client.active).toBe(0);
});
test.each([
  ['not-found', 404, 'UPSTREAM_NOT_FOUND'], ['unavailable', 503, 'UPSTREAM_UNAVAILABLE'],
  ['wrong-shape', 502, 'UPSTREAM_BAD_RESPONSE'], ['slow-body', 504, 'UPSTREAM_TIMEOUT'],
] as const)('%s 映射為 %s／%s，requestId 相同且不洩漏 URL 或 body', async (id, status, code) => {
  const result = await raw(lab.server).get(`/lab/topics/${id}`).expect(status);
  expect(result.body.error.code).toBe(code); expect(result.body.error.details).toEqual([]);
  expect(result.body.requestId).toBe(result.headers['x-request-id']);
  expect(result.text).not.toContain(upstream.origin); expect(result.text).not.toContain('SECRET');
});
test('HEAD 無 body，錯誤方法 405／Allow，非法 query 與 ID 不呼叫外部服務', async () => {
  const get = await raw(lab.server).get('/lab/topics/ok').expect(200);
  const head = await raw(lab.server).head('/lab/topics/ok').expect(200);
  expect(head.text).toBeUndefined(); expect(head.headers['content-length']).toBe(get.headers['content-length']);
  const before = upstream.stats.requests;
  await raw(lab.server).post('/lab/topics/ok').expect(405).expect('Allow', 'GET, HEAD');
  await raw(lab.server).get('/lab/topics/ok?url=https://evil.test').expect(400);
  await raw(lab.server).get('/lab/topics/BAD').expect(400);
  await raw(lab.server).get('/lab/topics/ok/').expect(404);
  expect(upstream.stats.requests).toBe(before);
});
test('實驗沒有掛文章、認證或資料庫 API', async () => {
  await raw(lab.server).get('/api/articles').expect(404);
  await raw(lab.server).get('/api/auth/me').expect(404);
  await raw(lab.server).get('/api/openapi.json').expect(404);
  expect(upstream.stats.requests).toBe(0);
});
test('用戶斷線會取消真正外部 fetch，shutdown 等已登記工作結束', async () => {
  const address = lab.server.address(); if (!address || typeof address === 'string') throw new Error('port missing');
  const outgoing = request({ host: '127.0.0.1', port: address.port, path: '/lab/topics/slow-body', agent: false });
  outgoing.on('error', () => {}); outgoing.end();
  await waitUntil(() => upstream.stats.attempts['slow-body'] === 1);
  outgoing.destroy();
  await lab.lifecycle.shutdown();
  await waitUntil(() => upstream.stats.active === 0);
  expect(lab.client.active).toBe(0); expect(upstream.stats.aborted).toBe(1);
  expect(upstream.stats.attempts['slow-body']).toBe(1);
});
test('正常 drain 不先取消已接受工作，外部期限完成後才 closeResources', async () => {
  const events: string[] = [];
  await lab.lifecycle.shutdown();
  lab = await createExternalLab({ origin: upstream.origin, maxAttempts: 1, totalTimeoutMs: 1000, attemptTimeoutMs: 100 },
    { onEvent: value => events.push(value), closeResources: async () => { expect(lab.client.active).toBe(0); events.push('resources'); } });
  lab.server.listen(0, '127.0.0.1'); await once(lab.server, 'listening');
  const pending = raw(lab.server).get('/lab/topics/slow-body').then(response => response);
  await waitUntil(() => upstream.stats.attempts['slow-body'] === 1);
  const shutdown = lab.lifecycle.shutdown();
  expect((await pending).status).toBe(504);
  await shutdown;
  expect(events).toEqual(['draining', 'http-drained', 'resources', 'closed']);
});
