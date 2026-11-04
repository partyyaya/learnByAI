import { expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import raw from 'supertest';
import { setImmediate as immediate } from 'node:timers/promises';
import { createObservability, routeLabel } from '../src/observability.js';
import { createArticleServer } from '../src/server.js';
import { errorHandler, type ErrorReport } from '../src/errors.js';
import { requestContext } from '../src/request-context.js';
import { testDependencies } from './module-fixture.js';
import { ARTICLE_SERVICE, CHECK_READY } from '../src/tokens.js';

function capture() {
  const lines: string[] = [];
  return { lines, observation: createObservability(line => { lines.push(line); }), records: () => lines.map(line => JSON.parse(line)) };
}
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function app(service = {}, ready = async () => {}, closeResources = async (_signal: AbortSignal) => {}) {
  const logs = capture();
  const server = await createArticleServer({ observability: logs.observation, closeResources, dependencies: testDependencies([
    { provide: ARTICLE_SERVICE, useValue: service }, { provide: CHECK_READY, useValue: ready },
  ]) });
  return { server, ...logs };
}

test.each([
  ['/api/articles/a-secret?q=private', '/api/articles/{id}'],
  ['/api/me/articles/u-secret', '/api/me/articles/{id}'],
  ['/api/articles/a/publish', '/api/articles/{id}/publish'],
  ['/api/openapi.json', '/api/openapi.json'],
  ['/api/openapiXjson', 'unmatched'],
  ['/api/articles/', '/api/articles'],
  ['/health/metrics?secret=value', '/health/metrics'],
  ['/unknown/private\nline', 'unmatched'],
])('路由 %s 投影成有限樣板 %s', (input, label) => expect(routeLabel(input)).toBe(label));

test('即使呼叫端傳額外欄位與換行，logger 只保留白名單與有限錯誤分類', () => {
  const logs = capture(); const requestId = randomUUID();
  logs.observation.error({ requestId, status: 500, code: 'SECRET\nforged', phase: 'before-response',
    password: 'SECRET', body: { tokenHash: 'SECRET' }, stack: 'SECRET' } as ErrorReport);
  logs.observation.exported({ outcome: 'interrupted', bytesRead: 3, fileClosed: true, errorCode: 'SECRET' }, requestId);
  logs.observation.lifecycle('SECRET');
  const records = logs.records();
  expect(records[0]).toEqual({ time: expect.any(String), level: 'warn', event: 'http_error', requestId, errorStatus: 500, code: 'OTHER_ERROR', phase: 'before-response' });
  expect(records[1].code).toBe('STREAM_FAILED'); expect(records[2].state).toBe('unknown');
  expect(logs.lines.join('')).not.toContain('SECRET');
  for (const line of logs.lines) expect(line.split('\n')).toHaveLength(1);
});
test('throw／拒收 sink 不影響 HTTP，計數可觀察且不再記錄例外內容', async () => {
  let calls = 0;
  const observation = createObservability(() => { if (++calls === 1) throw new Error('SECRET'); return false; });
  const server = await createArticleServer({ observability: observation, dependencies: testDependencies([
    { provide: ARTICLE_SERVICE, useValue: {} }, { provide: CHECK_READY, useValue: async () => {} },
  ]) });
  try {
    await raw(server).get('/health/live').expect(200);
    await raw(server).get('/health/live').expect(200);
    expect(observation.metrics(0, false)).toContain('course_log_dropped_total 2');
  } finally { await server.lifecycle.shutdown(); }
});
test('成功與失敗各只有一次 completion，外來 ID 被替換且與錯誤 envelope 串接', async () => {
  const logs = await app({ detail: async () => { throw new Error('SECRET SQL postgresql://password'); } });
  try {
    const ok = await raw(logs.server).get('/health/live').set('X-Request-ID', 'SECRET-external').expect(200);
    const failed = await raw(logs.server).get('/api/articles/a-secret?password=SECRET').set('Cookie', 'SECRET').expect(500);
    await immediate();
    const complete = logs.records().filter(row => row.event === 'request_completed');
    expect(complete).toHaveLength(2); expect(new Set(complete.map(row => row.requestId)).size).toBe(2);
    expect(complete[0]).toMatchObject({ requestId: ok.headers['x-request-id'], httpStatus: 200, outcome: 'finished' });
    expect(complete[1]).toMatchObject({ requestId: failed.headers['x-request-id'], route: '/api/articles/{id}', httpStatus: 500, outcome: 'finished' });
    expect(failed.body.requestId).toBe(failed.headers['x-request-id']);
    expect(logs.records().find(row => row.event === 'http_error')).toMatchObject({ requestId: failed.body.requestId, code: 'INTERNAL_ERROR', errorStatus: 500 });
    expect(logs.lines.join('')).not.toMatch(/SECRET|a-secret|postgresql|password/);
  } finally { await logs.server.lifecycle.shutdown(); }
});
test('400／401／404／405／HEAD 都有 completion；未知 URL 不造成無界 series', async () => {
  const logs = await app();
  try {
    await raw(logs.server).post('/api/articles/preview').send({ password: 'SECRET' }).expect(400);
    await raw(logs.server).get('/api/me/articles').expect(401);
    for (let i = 0; i < 30; i++) await raw(logs.server).get(`/secret-${i}?token=SECRET`).expect(404);
    await raw(logs.server).post('/health/metrics').expect(405).expect('Allow', 'GET, HEAD');
    const head = await raw(logs.server).head('/health/live').expect(200); expect(head.text).toBeUndefined();
    const metrics = logs.observation.metrics(0, false);
    expect(metrics).toContain('route="unmatched",method="GET",status_group="4xx",outcome="finished"} 30');
    expect(metrics).not.toMatch(/SECRET|secret-|requestId|userId/);
    expect(logs.records().filter(row => row.event === 'request_completed')).toHaveLength(34);
  } finally { await logs.server.lifecycle.shutdown(); }
});
test('metrics 公開 text／no-store、HEAD、query、strict routing 與 OpenAPI 一致', async () => {
  const logs = await app();
  try {
    const result = await raw(logs.server).get('/health/metrics').expect(200).expect('Cache-Control', 'no-store').expect('Content-Type', /text\/plain.*version=0.0.4/);
    expect(result.text).toContain('course_http_in_flight 1\n');
    const head = await raw(logs.server).head('/health/metrics').expect(200); expect(head.text).toBeUndefined();
    await raw(logs.server).get('/health/metrics?token=SECRET').expect(400);
    await raw(logs.server).get('/health/metrics/').expect(404);
    const doc = await raw(logs.server).get('/api/openapi.json').expect(200);
    expect(doc.body.info.version).toBe('32.0.0');
    expect(Object.keys(doc.body.paths)).toHaveLength(23);
    expect(Object.values(doc.body.paths).reduce<number>((sum, item) => sum + Object.keys(item as object).length, 0)).toBe(42);
    expect(doc.body.paths['/health/metrics'].get.security).toEqual([]);
    expect(doc.body.paths['/health/metrics'].get.responses['200'].content['text/plain']).toBeDefined();
  } finally { await logs.server.lifecycle.shutdown(); }
});
test('累計 histogram 的 +Inf／count／counter 相同、sum 非負，新的程序狀態獨立', async () => {
  const logs = await app();
  try {
    await raw(logs.server).get('/health/live').expect(200);
    const text = logs.observation.metrics(0, false);
    const labels = 'route="/health/live",method="GET",status_group="2xx",outcome="finished"';
    expect(text).toContain(`course_http_requests_total{${labels}} 1`);
    expect(text).toContain(`course_http_duration_seconds_bucket{${labels},le="+Inf"} 1`);
    expect(text).toContain(`course_http_duration_seconds_count{${labels}} 1`);
    const sum = text.split('\n').find(line => line.startsWith('course_http_duration_seconds_sum'))!;
    expect(Number(sum.split(' ').at(-1))).toBeGreaterThanOrEqual(0);
    expect(createObservability().metrics(0, false)).not.toContain(`{${labels}}`);
  } finally { await logs.server.lifecycle.shutdown(); }
});
test('HTTP 已送 200 後才失敗：errorStatus=500，completion=200 interrupted，不補 JSON', async () => {
  const logs = capture(); const lab = express();
  const server = createServer((req, res) => {
    const id = randomUUID(); res.setHeader('X-Request-ID', id); logs.observation.observe(req, res, id); lab(req, res);
  });
  lab.use(requestContext());
  lab.get('/partial', async (_req, res) => { res.write('partial'); await immediate(); throw new Error('SECRET late'); });
  lab.use(errorHandler(report => logs.observation.error(report)));
  const port = await listen(server);
  try {
    let text = '';
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/partial', agent: false }, res => {
        res.on('data', chunk => { text += chunk; }); res.on('error', () => resolve()); res.on('end', () => reject(new Error('應中斷')));
      }); req.on('error', reject); req.end();
    });
    await immediate();
    expect(text).toBe('partial');
    const error = logs.records().find(row => row.event === 'http_error');
    expect(error).toMatchObject({ errorStatus: 500, httpStatus: 200, phase: 'streaming' });
    const completed = logs.records().filter(row => row.event === 'request_completed');
    expect(completed).toHaveLength(1); expect(completed[0]).toMatchObject({ requestId: error.requestId, httpStatus: 200, outcome: 'interrupted' });
    expect(logs.lines.join('')).not.toContain('SECRET');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('客戶端斷線後 HTTP gauge 歸零，真正工作仍登記；drain 等工作而非提早關資源', async () => {
  const entered = deferred(); const release = deferred(); let resourcesClosed = false;
  const logs = await app({ detail: async () => { entered.resolve(); await release.promise; throw new Error('SECRET'); } }, async () => {}, async () => { resourcesClosed = true; });
  const port = await listen(logs.server);
  const req = request({ host: '127.0.0.1', port, path: '/api/articles/slow-secret', agent: false }); req.on('error', () => {}); req.end();
  try {
    await entered.promise; req.destroy();
    for (let i = 0; i < 100 && !logs.records().some(row => row.event === 'request_completed'); i++) await immediate();
    const completion = logs.records().find(row => row.event === 'request_completed');
    expect(completion).toMatchObject({ outcome: 'interrupted' }); expect(completion).not.toHaveProperty('httpStatus');
    expect(logs.observation.metrics(logs.server.lifecycle.pendingWork, false)).toContain('course_http_in_flight 0');
    expect(logs.server.lifecycle.pendingWork).toBeGreaterThan(0);
    const stopping = logs.server.lifecycle.shutdown(); await immediate();
    expect(resourcesClosed).toBe(false); expect(logs.records().some(row => row.state === 'closed')).toBe(false);
    release.resolve(); await stopping;
    expect(resourcesClosed).toBe(true); expect(logs.server.lifecycle.pendingWork).toBe(0);
    expect(logs.records().filter(row => row.event === 'shutdown').map(row => row.state)).toEqual(['draining', 'http-drained', 'closed']);
  } finally { req.destroy(); release.resolve(); await logs.server.lifecycle.shutdown(); }
});
test.each([false, true])('進行中的 ready（DB 失敗=%s）在 draining 必須回 503 SHUTTING_DOWN，listener 最後關閉', async fail => {
  const entered = deferred(); const release = deferred();
  const logs = await app({}, async () => { entered.resolve(); await release.promise; if (fail) throw new Error('SECRET DB failure'); });
  const port = await listen(logs.server);
  const response = raw(logs.server).get('/health/ready').then(result => result);
  try {
    await entered.promise;
    const stopping = logs.server.lifecycle.shutdown(); release.resolve();
    const result = await response; expect(result.status).toBe(503); expect(result.body.error.code).toBe('SHUTTING_DOWN');
    await stopping; expect(logs.server.listening).toBe(false);
    expect(logs.observation.metrics(0, true)).toContain('course_draining 1');
    await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow();
  } finally { release.resolve(); await logs.server.lifecycle.shutdown(); }
});
