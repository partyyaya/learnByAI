const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdir, writeFile } = require('node:fs/promises');
const { createReferenceUpstream } = require('../dist/reference-upstream.js');
const { createExternalLab } = require('../dist/external-lab.js');

(async () => {
  const upstream = await createReferenceUpstream(); let lab;
  const events = [];
  try {
    lab = await createExternalLab({ origin: upstream.origin }, { onEvent: event => events.push(event) });
    lab.server.listen(0, '127.0.0.1'); await once(lab.server, 'listening');
    const base = `http://127.0.0.1:${lab.server.address().port}`;
    for (const [id, status, code] of [
      ['ok', 200], ['retry', 200], ['retry-after', 200], ['not-found', 404, 'UPSTREAM_NOT_FOUND'],
      ['unavailable', 503, 'UPSTREAM_UNAVAILABLE'], ['bad-json', 502, 'UPSTREAM_BAD_RESPONSE'], ['slow-body', 504, 'UPSTREAM_TIMEOUT'],
    ]) {
      const response = await fetch(`${base}/lab/topics/${id}`); assert.equal(response.status, status);
      const body = await response.json();
      if (code) { assert.equal(body.error.code, code); assert.equal(body.requestId, response.headers.get('x-request-id')); }
      else assert.deepEqual(body, { data: { id, label: '參考主題' } });
      assert.ok(!JSON.stringify(body).includes('SECRET'));
      console.log(`${id}: ${status}${code ? ` ${code}` : ''}`);
    }
    assert.equal(upstream.stats.attempts.retry, 3); assert.equal(upstream.stats.attempts['retry-after'], 2);
    assert.equal(upstream.stats.attempts.unavailable, 3);
    const attempts = [];
    const { createExternalClient } = require('../dist/external-client.js');
    const delivery = createExternalClient({ origin: upstream.origin, onAttempt: event => attempts.push(event.attempt) });
    const failure = await delivery.sendDelivery('lost-runtime-example').catch(error => error);
    assert.equal(failure.code, 'UPSTREAM_WRITE_UNCERTAIN'); assert.deepEqual(attempts, [1]); assert.equal(upstream.stats.deliveries, 1);
    await lab.lifecycle.shutdown(); await upstream.close();
    assert.equal(lab.client.active, 0); assert.equal(upstream.stats.active, 0);
    assert.deepEqual(events, ['draining', 'http-drained', 'closed']);
    await mkdir('.data', { recursive: true });
    await writeFile('.data/external-proof.json', JSON.stringify({ stats: upstream.stats, deliveryAttempts: attempts, events, closed: true }, null, 2) + '\n');
    console.log('PASS：真實外部 HTTP、有限重試、部分 body 期限、POST 結果不確定與正常清理；不使用資料庫。');
  } finally { try { await lab?.lifecycle.shutdown(); } finally { await upstream.close(); } }
})().catch(() => { console.error('EXTERNAL_CHECK_FAILED：請先 build 並檢查實驗輸出'); process.exitCode = 1; });
