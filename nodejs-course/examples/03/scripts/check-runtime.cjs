const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
let cases = 0;
function run(file, env = {}) {
  const result = spawnSync(process.execPath, [file], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  cases++;
  return JSON.parse(result.stdout);
}
const prefix = ['sync:start', 'async:before-await', 'sync:end'];
assert.deepEqual(run('experiments/order.cjs'), [...prefix, 'nextTick', 'promise', 'queueMicrotask', 'async:after-await']);
assert.deepEqual(run('experiments/order.mjs'), [...prefix, 'promise', 'queueMicrotask', 'async:after-await', 'nextTick']);
assert.deepEqual(run('experiments/io-order.cjs'), ['io:callback', 'immediate', 'timeout']);
assert.deepEqual(run('experiments/microtasks.cjs'), ['microtasks:done', 'timer']);
const latency = run('dist/main.js');
assert.deepEqual(latency.waiting.events, ['slow:start', 'probe', 'slow:end']);
assert.deepEqual(latency.cpu.events, ['slow:start', 'slow:end', 'probe']);
assert.equal(latency.concurrency.peak, 2);
const pool = run('experiments/pool.cjs', { UV_THREADPOOL_SIZE: '1' });
assert.equal(pool.poolSize, '1');
assert.deepEqual(pool.observations.map(item => item.name).sort(), ['crypto:long', 'crypto:short', 'file:read', 'timer:probe']);
console.log(`PASS：${cases} 項真實 Node 程序實驗；耗時僅觀察，不用毫秒門檻判定通過。`);
