const assert = require('node:assert/strict');
const { createScopeLab } = require('../dist/scope-lab.js');

(async () => {
  const app = await createScopeLab();
  try {
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/scope`;
    async function read(label) {
      const response = await fetch(url, { headers: { 'X-Lab-Label': label } });
      assert.equal(response.status, 200); return response.json();
    }
    const [first, second] = await Promise.all([read('first'), read('second')]);
    for (const row of [first, second]) {
      assert.equal(row.singleton, row.alias);
      assert.notEqual(row.singleton, row.secondSingleton);
      assert.equal(row.request, row.requestViaConsumer);
      assert.notEqual(row.transientA, row.transientB);
    }
    assert.equal(first.label, 'first'); assert.equal(second.label, 'second');
    for (const key of ['singleton', 'secondSingleton', 'transientA', 'transientB']) assert.equal(first[key], second[key]);
    for (const key of ['request', 'requestConsumer', 'controller', 'transientController']) assert.notEqual(first[key], second[key]);
    console.log('PASS：DEFAULT 跨請求共享；useExisting 是同一實例，另一個 useClass 註冊有自己的實例。');
    console.log('PASS：REQUEST 在同請求共享、不同請求隔離，依賴它的 Consumer／Controller 隨之重建。');
    console.log('PASS：TRANSIENT 依消費者分開；singleton 消費者保留原實例，request 消費者每請求取得自己的實例。');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
