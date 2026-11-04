const assert = require('node:assert/strict');
const { createLifecycleLab } = require('../dist/lifecycle-lab.js');

(async () => {
  for (const [value, deny, status, expected] of [
    ['7', false, 200, 'middleware → guard → interceptor:before → pipe → controller → interceptor:after → response:finish'],
    ['bad', false, 400, 'middleware → guard → interceptor:before → pipe → interceptor:error → filter → response:finish'],
    ['7', true, 403, 'middleware → guard → filter → response:finish'],
    ['13', false, 500, 'middleware → guard → interceptor:before → pipe → controller → interceptor:error → filter → response:finish'],
  ]) {
    const { app, events } = await createLifecycleLab(deny);
    try {
      await app.listen(0, '127.0.0.1');
      const response = await fetch(`${await app.getUrl()}/lab/${value}`);
      assert.equal(response.status, status);
      const body = await response.json();
      if (status === 200) assert.deepEqual(body, { data: { value: 7, type: 'number' } });
      assert.equal(events.join(' → '), expected);
      console.log(`${status}: ${expected}`);
    } finally { await app.close(); }
  }
  console.log('PASS：四條 Nest 請求生命週期，使用真實 HTTP 與各自獨立的 app。');
})().catch(error => { console.error(error); process.exitCode = 1; });
