const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { runLoad } = require('../dist/load-generator.js');

async function scenario(kind, concurrency, extraEnv = {}, profile = false) {
  const args = profile ? ['--cpu-prof', '--cpu-prof-dir=.data', '--cpu-prof-name=performance-cpu.cpuprofile'] : [];
  const child = spawn(process.execPath, [...args, 'dist/performance-lab.js'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: process.env.TEST_DATABASE_URL, PERF_MAX_CONCURRENT: '4', PERF_POOL_MAX: '2', PERF_RATE_LIMIT: '1200', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 15000);
  async function ready() {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const line = output.split('\n').find(line => line.includes('"event":"performance_listening"'));
      if (line) return JSON.parse(line).port;
      if (child.exitCode !== null) throw new Error('performance child exited before listening');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('performance child startup deadline');
  }
  try {
    const origin = `http://127.0.0.1:${await ready()}`;
    if (!extraEnv.PERF_RATE_LIMIT) {
      const warmup = await runLoad({ origin, kind, requests: 2, concurrency: 1 }); assert.equal(warmup.successes, 2);
    }
    const before = await (await fetch(origin + '/lab/stats')).json();
    assert.equal(before.data.admission.active, 0);
    const load = await runLoad({ origin, kind, requests: profile ? 16 : 20, concurrency });
    const response = await fetch(origin + '/lab/stats'); const after = (await response.json()).data;
    assert.equal(load.started, load.planned); assert.equal(load.transportErrors, 0); assert.equal(load.invalidResponses, 0);
    assert.equal(load.started, Object.values(load.statuses).reduce((sum, value) => sum + value, 0));
    assert.ok(load.peak <= concurrency); assert.ok(after.admission.peak <= after.admission.maximum);
    assert.equal(after.admission.active, 0); assert.equal(after.pool.waiting, 0);
    if (extraEnv.PERF_RATE_LIMIT) { assert.equal(load.statuses['200'], 3); assert.equal(load.statuses['429'], 17); }
    else if (concurrency <= after.admission.maximum) assert.equal(load.successes, load.started);
    else { assert.ok(load.successes > 0); assert.ok(load.statuses['503'] > 0); }
    child.kill('SIGTERM'); const result = await exited;
    assert.equal(result.signal, null); assert.equal(result.code, 0);
    const states = output.split('\n').filter(line => line.includes('performance_shutdown')).map(line => JSON.parse(line).state);
    assert.deepEqual(states, ['draining', 'http-drained', 'closed']);
    assert.doesNotMatch(output + errors, /postgresql:\/\/|course_local|passwordHash|tokenHash/);
    const elapsedMs = after.measurements.elapsedMs - before.data.measurements.elapsedMs;
    const cpuMs = after.measurements.cpuMs - before.data.measurements.cpuMs;
    const activeMs = after.measurements.eventLoop.activeMs - before.data.measurements.eventLoop.activeMs;
    const idleMs = after.measurements.eventLoop.idleMs - before.data.measurements.eventLoop.idleMs;
    return { load, measurementWindow: { elapsedMs, cpuMs, cpuPerWall: cpuMs / elapsedMs, eventLoopUtilization: activeMs / (activeMs + idleMs) },
      server: after, shutdown: states };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; clearTimeout(watchdog);
  }
}
(async () => {
  if (!process.env.TEST_DATABASE_URL || new URL(process.env.TEST_DATABASE_URL).pathname !== '/course_test') throw new Error('只使用 course_test 的 TEST_DATABASE_URL，不回退開發 DB');
  await mkdir('.data', { recursive: true });
  const profile = process.argv.includes('--profile');
  const results = [];
  if (profile) {
    await rm('.data/performance-cpu.cpuprofile', { force: true });
    results.push(await scenario('cpu', 2, {}, true));
    const document = JSON.parse(await readFile('.data/performance-cpu.cpuprofile', 'utf8'));
    assert.ok(document.nodes.length > 0); assert.ok(document.samples.length > 0);
    assert.ok(document.nodes.some(node => node.callFrame.functionName === 'cpuDigest'));
  } else {
    for (const env of [{ DATABASE_URL: '' }, { PERF_MAX_CONCURRENT: '0' }, { PORT: 'bad' }]) {
      const child = spawnSync(process.execPath, ['dist/performance-lab.js'], { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, ...env }, encoding: 'utf8', timeout: 5000 });
      assert.ifError(child.error); assert.equal(child.status, 1); assert.doesNotMatch(child.stdout, /performance_listening/);
      assert.equal(child.stderr.trim(), '{"event":"performance_startup_failed"}');
    }
    for (const kind of ['baseline', 'cpu', 'yield', 'db', 'external']) results.push(await scenario(kind, 4));
    results.push(await scenario('db', 4, { PERF_POOL_MAX: '1' }));
    results.push(await scenario('external', 8));
    results.push(await scenario('baseline', 1, { PERF_RATE_LIMIT: '3' }));
    await writeFile('.data/performance-proof.json', JSON.stringify({ generatedAt: new Date().toISOString(), model: 'closed-loop, fixed request count, separate generator process', results }, null, 2) + '\n');
  }
  for (const item of results) console.log(JSON.stringify({ kind: item.load.kind, concurrency: item.load.concurrency, poolMax: item.server.pool.maximum,
    successes: item.load.successes, statuses: item.load.statuses, p95Ms: item.load.allAttempts.p95Ms,
    cpuMs: item.measurementWindow.cpuMs, loopP99Ms: item.server.measurements.eventLoopDelay?.p99Ms ?? null }));
  console.log(`PASS performance ${profile ? 'CPU profile' : 'bounded load, pool comparison, admission, rate limit and cleanup'}; no speed threshold.`);
})().catch(() => { console.error('PERFORMANCE_CHECK_FAILED'); process.exitCode = 1; });
