const assert = require('node:assert/strict');
const { createResponseLab } = require('../dist/response-lab.js');
(async () => {
  const { app, traces } = await createResponseLab();
  try {
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    for (const [path, status, body] of [
      ['/responses/ok', 200, { data: { value: 7 } }],
      ['/responses/route-error', 422, { error: { code: 'LAB_REJECTED', handledBy: 'route' } }],
      ['/responses/controller-error', 422, { error: { code: 'LAB_REJECTED', handledBy: 'controller' } }],
      ['/outside/error', 422, { error: { code: 'LAB_REJECTED', handledBy: 'global' } }],
      ['/responses/denied', 422, { error: { code: 'LAB_REJECTED', handledBy: 'route' } }],
      ['/responses/recovered', 200, { data: { recovered: true } }],
    ]) {
      const response = await fetch(base + path); assert.equal(response.status, status);
      assert.deepEqual(await response.json(), body);
      console.log(`${path}: ${traces.at(-1).events.join(' → ')}`);
    }
    const raw = await fetch(base + '/responses/raw'); assert.equal(await raw.text(), 'plain');
    const empty = await fetch(base + '/responses/empty'); assert.equal(empty.status, 204); assert.equal(await empty.text(), '');
    console.log('PASS：三層 Interceptor、Filter 作用範圍、Guard 提前拒絕、catchError 恢復與 raw／204。');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
