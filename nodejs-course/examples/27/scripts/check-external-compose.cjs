const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdir, writeFile } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { createExternalClient } = require('../dist/external-client.js');
const base = process.env.EXTERNAL_LAB_URL || 'http://external-lab:3127';
const upstream = process.env.REFERENCE_ORIGIN || 'http://upstream:4000';
async function stats() { const response = await fetch(`${upstream}/__lab/stats`, { signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); return response.json(); }
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) { if (Date.now() >= deadline) throw new Error('等待實驗條件超過期限'); await delay(20); }
}
(async () => {
  // Compose depends_on 只保證啟動順序；這裡等待真正可回應，不宣稱它提供 readiness。
  await until(async () => {
    try {
      const response = await fetch(`${base}/lab/topics/ok`, { signal: AbortSignal.timeout(1000) });
      await response.text(); return response.status === 200;
    } catch { return false; }
  });
  const outcomes = [];
  for (const [id, status, code, count] of [
    ['retry', 200, undefined, 3], ['long-retry-after', 503, 'UPSTREAM_UNAVAILABLE', 1],
    ['not-found', 404, 'UPSTREAM_NOT_FOUND', 1], ['wrong-shape', 502, 'UPSTREAM_BAD_RESPONSE', 1],
  ]) {
    const before = await stats();
    const response = await fetch(`${base}/lab/topics/${id}`, { signal: AbortSignal.timeout(5000),
      headers: { Cookie: 'course_session=SECRET', Authorization: 'Bearer SECRET', 'X-CSRF-Token': 'SECRET' } });
    assert.equal(response.status, status); const body = await response.json();
    if (code) { assert.equal(body.error.code, code); assert.equal(body.requestId, response.headers.get('x-request-id')); }
    else assert.deepEqual(body, { data: { id, label: '參考主題' } });
    const after = await stats(); assert.equal((after.attempts[id] || 0) - (before.attempts[id] || 0), count);
    assert.equal(after.credentialForwarded, false); outcomes.push({ id, status, attempts: count });
  }
  const head = await fetch(`${base}/lab/topics/ok`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const beforeCancel = await stats(); const cancel = new AbortController();
  const pending = fetch(`${base}/lab/topics/slow-body`, { signal: cancel.signal }).then(() => false, () => true);
  await until(async () => (await stats()).attempts['slow-body'] > (beforeCancel.attempts['slow-body'] || 0));
  cancel.abort(); assert.equal(await pending, true);
  await until(async () => (await stats()).active === 0);
  const afterCancel = await stats(); assert.equal(afterCancel.attempts['slow-body'] - (beforeCancel.attempts['slow-body'] || 0), 1);
  const attempts = []; const client = createExternalClient({ origin: upstream, onAttempt: event => attempts.push(event.attempt) });
  const beforeWrite = await stats();
  const failed = await client.sendDelivery(`lost-${randomUUID()}`).catch(error => error);
  assert.equal(failed.code, 'UPSTREAM_WRITE_UNCERTAIN'); assert.deepEqual(attempts, [1]);
  await until(async () => (await stats()).active === 0);
  const after = await stats(); assert.equal(after.deliveries - beforeWrite.deliveries, 1);
  await mkdir('.data', { recursive: true });
  await writeFile('.data/external-compose-proof.json', JSON.stringify({ outcomes, downstreamCancellation: true,
    deliveryAttempts: attempts, deliveryDelta: 1, credentialForwarded: after.credentialForwarded, active: after.active }, null, 2) + '\n');
  console.log('PASS：Compose 外部服務的重試次數、安全錯誤、HEAD、斷線取消、認證欄位不轉送、POST 不重送。');
})().catch(() => { console.error('EXTERNAL_COMPOSE_CHECK_FAILED：請啟動 upstream／external-lab 並檢查設定'); process.exitCode = 1; });
