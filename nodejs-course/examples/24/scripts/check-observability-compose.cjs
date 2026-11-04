const assert = require('node:assert/strict');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const base = 'http://api:3000';
const unavailable = process.argv.includes('--unavailable');
async function call(path, expected, method = 'GET') {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  assert.equal(response.status, expected, `${path}: ${response.status}`);
  const requestId = response.headers.get('x-request-id');
  assert.match(requestId, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(text, /postgresql:\/\/|passwordHash|tokenHash|course_local|SELECT |"stack"\s*:/);
  if (expected >= 400) assert.equal(JSON.parse(text).requestId, requestId);
  return { response, text, requestId };
}
(async () => {
  for (let attempt = 0; ; attempt++) {
    try { await call('/health/live', 200); break; }
    catch (error) { if (attempt >= 50) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  const ready = await call('/health/ready', unavailable ? 503 : 200);
  if (unavailable) assert.equal(JSON.parse(ready.text).error.code, 'NOT_READY');
  const articles = await call('/api/articles', unavailable ? 500 : 200);
  if (unavailable) assert.equal(JSON.parse(articles.text).error.code, 'INTERNAL_ERROR');
  const metrics = await call('/health/metrics', 200);
  assert.equal(metrics.response.headers.get('cache-control'), 'no-store');
  assert.match(metrics.response.headers.get('content-type'), /text\/plain.*version=0.0.4/);
  assert.match(metrics.text, /course_http_in_flight 1\n/);
  assert.match(metrics.text, /course_draining 0\n/);
  assert.doesNotMatch(metrics.text, /requestId|userId|authorId|email|127.0.0.1/);
  assert.equal((await call('/health/metrics', 200, 'HEAD')).text, '');
  await call('/health/metrics?token=never-log-this', 400);
  const doc = await call('/api/openapi.json', 200);
  const document = JSON.parse(doc.text);
  assert.equal(document.info.version, '24.0.0');
  assert.equal(Object.keys(document.paths).length, 18);
  assert.deepEqual(document.paths['/health/metrics'].get.security, []);
  const file = '.data/observability-compose-proof.json';
  let proof = {};
  try { proof = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  proof[unavailable ? 'databaseUnavailable' : 'healthy'] = {
    checkedAt: new Date().toISOString(), live: 200, ready: unavailable ? 503 : 200, articles: unavailable ? 500 : 200,
    metrics: 200, requestIds: [ready.requestId, articles.requestId, metrics.requestId],
  };
  await mkdir('.data', { recursive: true }); await writeFile(file, JSON.stringify(proof, null, 2) + '\n');
  console.log(`PASS observability Compose: ${unavailable ? 'DB unavailable; live/metrics remain 200' : 'healthy, HEAD, bounded metrics, OpenAPI'}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
