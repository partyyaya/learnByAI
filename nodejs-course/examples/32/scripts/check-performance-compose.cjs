const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const { runLoad } = require('../dist/load-generator.js');
(async () => {
  const origin = 'http://performance-lab:3332';
  for (let attempt = 0; ; attempt++) {
    try { const response = await fetch(origin + '/health/live', { signal: AbortSignal.timeout(1000) }); assert.equal(response.status, 200); break; }
    catch (error) { if (attempt >= 50) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  const results = [];
  for (const kind of ['baseline', 'cpu', 'yield', 'db', 'external']) {
    const result = await runLoad({ origin, kind, requests: 12, concurrency: 4 });
    assert.equal(result.successes, 12); assert.equal(result.transportErrors, 0); results.push(result);
  }
  const overloaded = await runLoad({ origin, kind: 'external', requests: 24, concurrency: 8 });
  assert.ok(overloaded.statuses['503'] > 0); assert.ok(overloaded.successes > 0); results.push(overloaded);
  const stats = await (await fetch(origin + '/lab/stats')).json();
  assert.equal(stats.data.admission.active, 0); assert.equal(stats.data.pool.waiting, 0);
  assert.ok(stats.data.admission.peak <= 4); assert.ok(stats.data.pool.total <= 2);
  assert.ok(stats.data.upstream.received > 0);
  const text = JSON.stringify({ results, server: stats.data });
  assert.doesNotMatch(text, /postgresql:\/\/|course_local|passwordHash|tokenHash/);
  await mkdir('.data', { recursive: true }); await writeFile('.data/performance-compose-proof.json', text + '\n');
  console.log('PASS performance Compose: five workloads, admission rejection, bounded pool, no speed threshold.');
})().catch(() => { console.error('PERFORMANCE_COMPOSE_FAILED'); process.exitCode = 1; });
