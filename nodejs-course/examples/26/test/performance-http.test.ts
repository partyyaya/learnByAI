import { expect, test } from '@jest/globals';
import { once } from 'node:events';
import { request, createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createPerformanceLab, type PerformanceOptions } from '../src/performance-lab.js';
import { runLoad } from '../src/load-generator.js';

function testUrl() {
  const raw = process.env.TEST_DATABASE_URL; if (!raw || new URL(raw).pathname !== '/course_test') throw new Error('只接受 course_test'); return raw;
}
async function fixture(options: Partial<PerformanceOptions> = {}) {
  const lab = await createPerformanceLab({ connectionString: testUrl(), cpuIterations: 500000, ...options });
  lab.server.listen(0, '127.0.0.1'); await once(lab.server, 'listening');
  return { ...lab, origin: `http://127.0.0.1:${(lab.server.address() as { port: number }).port}` };
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('等待工作狀態逾期'); await delay(1); }
}
test.each(['baseline', 'cpu', 'yield', 'db', 'external'] as const)('真 HTTP %s，結果正確、工作完成後容量歸零', async kind => {
  const lab = await fixture();
  try {
    const response = await fetch(`${lab.origin}/lab/work/${kind}`); expect(response.status).toBe(200);
    const body = await response.json() as { data: { kind: string } }; expect(body.data.kind).toBe(kind); expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    await until(() => lab.snapshot().admission.active === 0);
    expect(JSON.stringify(lab.snapshot())).not.toMatch(/postgresql:\/\/|course_local|passwordHash|tokenHash/);
  } finally { await lab.lifecycle.shutdown(); }
  expect(lab.snapshot()).toMatchObject({ resourcesClosed: true, pool: { closed: true }, measurements: { stopped: true } });
});
test('固定路徑、query、方法與 HEAD 契約；不接受 URL／SQL／運算量', async () => {
  const lab = await fixture();
  try {
    for (const [path, status] of [['/lab/work/db?sql=secret', 400], ['/lab/work/db/', 404], ['/lab/work/unknown', 404], ['/lab/stats?reset=1', 400]] as const) {
      const result = await fetch(lab.origin + path); expect(result.status).toBe(status); expect(await result.text()).not.toContain('secret');
    }
    const denied = await fetch(lab.origin + '/lab/work/db', { method: 'POST' }); expect(denied.status).toBe(405); expect(denied.headers.get('allow')).toBe('GET, HEAD');
    const head = await fetch(lab.origin + '/lab/work/baseline', { method: 'HEAD' }); expect(head.status).toBe(200); expect(await head.text()).toBe('');
    const stats = await (await fetch(lab.origin + '/lab/stats')).json() as { data: { pool: { maximum: number } } }; expect(stats.data.pool.maximum).toBe(2);
  } finally { await lab.lifecycle.shutdown(); }
});
test('超額併發立即 503，不進 SQL；真正 pool 等待有界且 client release 後可再查', async () => {
  const lab = await fixture({ poolMax: 1, maxConcurrent: 2 });
  try {
    const first = fetch(lab.origin + '/lab/work/db'); const second = fetch(lab.origin + '/lab/work/db');
    await until(() => lab.snapshot().pool.waiting === 1);
    expect(lab.snapshot().admission.active).toBe(2);
    const busy = await fetch(lab.origin + '/lab/work/db'); expect(busy.status).toBe(503); expect((await busy.json() as { error: { code: string } }).error.code).toBe('LAB_BUSY');
    expect((await first).status).toBe(200); expect((await second).status).toBe(200);
    const report = lab.snapshot(); expect(report.stages.dbQuery.count).toBe(2); expect(report.stages.poolWait.count).toBe(2);
    expect(report.pool.waiting).toBe(0); expect(report.admission.peak).toBe(2);
    expect((await fetch(lab.origin + '/lab/work/db')).status).toBe(200);
  } finally { await lab.lifecycle.shutdown(); }
});
test('來源限流 429 與 Retry-After，X-Forwarded-For 無法建立新來源繞過', async () => {
  const lab = await fixture({ rateLimit: 1 });
  try {
    expect((await fetch(lab.origin + '/lab/work/baseline')).status).toBe(200);
    const denied = await fetch(lab.origin + '/lab/work/baseline', { headers: { 'X-Forwarded-For': '203.0.113.1' } });
    expect(denied.status).toBe(429); expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(lab.snapshot().rate.sources).toBe(1); expect(lab.snapshot().admission.rejected).toBe(0);
    expect((await fetch(lab.origin + '/health/live')).status).toBe(200); expect((await fetch(lab.origin + '/lab/stats')).status).toBe(200);
  } finally { await lab.lifecycle.shutdown(); }
});
test('客戶端中止 SQL 不提早釋放 capacity／pool，drain 等真 query 完成', async () => {
  const events: string[] = []; const lab = await fixture({ maxConcurrent: 1, poolMax: 1, onEvent: event => { events.push(event); } });
  const req = request(lab.origin + '/lab/work/db'); req.on('error', () => {}); req.end();
  try {
    await until(() => lab.snapshot().admission.active === 1 && lab.snapshot().pool.idle === 0);
    req.destroy();
    const stopped = lab.lifecycle.shutdown();
    expect(lab.snapshot().resourcesClosed).toBe(false);
    expect(lab.snapshot().admission.active).toBe(1);
    await stopped;
    expect(lab.snapshot()).toMatchObject({ resourcesClosed: true, admission: { active: 0 }, pool: { closed: true } });
    expect(events).toEqual(['draining', 'http-drained', 'closed']);
  } finally { req.destroy(); await lab.lifecycle.shutdown(); }
});
test('客戶端離線會取消真正外部等待，上游 timer 與容量清理', async () => {
  const lab = await fixture({ maxConcurrent: 1 });
  const req = request(lab.origin + '/lab/work/external'); req.on('error', () => {}); req.end();
  try {
    await until(() => lab.snapshot().upstream.active === 1);
    req.destroy();
    await until(() => lab.snapshot().admission.active === 0 && lab.snapshot().upstream.active === 0);
    expect(lab.snapshot().upstream.aborted).toBe(1);
    expect((await fetch(lab.origin + '/lab/work/external')).status).toBe(200);
  } finally { req.destroy(); await lab.lifecycle.shutdown(); }
});
test('可信 callback 失敗回安全 500，capacity 不漏；重複 shutdown 同一 Promise', async () => {
  const lab = await fixture({ onWorkStarted: () => { throw new Error('SECRET SQL credentials'); } });
  try {
    const response = await fetch(lab.origin + '/lab/work/db'); expect(response.status).toBe(500); expect(await response.text()).not.toContain('SECRET');
    expect(lab.snapshot().admission.active).toBe(0); expect(lab.snapshot().pool.waiting).toBe(0);
    const first = lab.lifecycle.shutdown(); expect(lab.lifecycle.shutdown()).toBe(first); await first;
  } finally { await lab.lifecycle.shutdown(); }
});
test('真負載產生器保留 503／429，不把拒絕當吞吐成功；closed-loop peak 有界', async () => {
  const lab = await fixture({ maxConcurrent: 1 });
  try {
    const result = await runLoad({ origin: lab.origin, kind: 'external', requests: 12, concurrency: 4 });
    expect(result.started).toBe(12); expect(result.peak).toBeLessThanOrEqual(4);
    expect(result.statuses['503']).toBeGreaterThan(0); expect(result.successes).toBeGreaterThan(0);
    expect(result.successful.count).toBe(result.successes); expect(result.allAttempts.count).toBe(12);
    expect(result.failureRate).toBeGreaterThan(0); expect(result.successesPerSecond).toBeLessThan(result.attemptsPerSecond);
  } finally { await lab.lifecycle.shutdown(); }
});
test('負載 deadline 包含慢 body，失敗與 timeout 都列入；generator 不無界等待', async () => {
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{');
    const timer = setTimeout(() => res.end('}'), 5000); timers.add(timer); res.once('close', () => { clearTimeout(timer); timers.delete(timer); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const result = await runLoad({ origin, kind: 'baseline', requests: 2, concurrency: 1, timeoutMs: 30 });
    expect(result.transportErrors).toBe(2); expect(result.timeouts).toBe(2); expect(result.successes).toBe(0); expect(result.successful.p99Ms).toBeNull();
  } finally { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('錯誤 200 body 計為 invalid response，預先取消不啟動請求', async () => {
  const server = createServer((_req, res) => res.end('{"data":{"kind":"wrong"}}'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const result = await runLoad({ origin, kind: 'baseline', requests: 2, concurrency: 1 });
    expect(result.statuses['200']).toBe(2); expect(result.invalidResponses).toBe(2); expect(result.successes).toBe(0);
    const cancelled = await runLoad({ origin, kind: 'baseline', requests: 2, concurrency: 1, signal: AbortSignal.abort() });
    expect(cancelled.started).toBe(0); expect(cancelled.unscheduled).toBe(2); expect(cancelled.failureRate).toBeNull();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test.each([
  { origin: 'https://example.com' }, { origin: 'http://127.0.0.1/path' }, { origin: 'http://u:p@127.0.0.1' },
  { requests: 201 }, { concurrency: 17 }, { timeoutMs: 0 },
])('負載非法設定拒絕 %j', async extra => {
  await expect(runLoad({ origin: 'http://127.0.0.1:1', kind: 'baseline', requests: 1, concurrency: 1, ...extra })).rejects.toThrow();
});

test('過大 body 與傳輸中斷都計入失敗，下一輪 Agent 仍可正常完成', async () => {
  let received = 0;
  const server = createServer((_req, res) => {
    received++;
    if (received === 1) res.end('x'.repeat(5000));
    else if (received === 2) res.destroy();
    else res.end('{"data":{"kind":"baseline"}}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const failed = await runLoad({ origin, kind: 'baseline', requests: 2, concurrency: 1 });
    expect(failed.transportErrors).toBe(2); expect(failed.successes).toBe(0); expect(failed.timeouts).toBe(0);
    expect(failed.allAttempts.count).toBe(2);
    const recovered = await runLoad({ origin, kind: 'baseline', requests: 1, concurrency: 1 });
    expect(recovered.successes).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
