const assert = require('node:assert/strict');
const { createValidationLab } = require('../dist/validation-lab.js');

async function main() {
  const app = await createValidationLab();
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    async function post(path, body, status = 200) {
      const response = await fetch(`${base}/validation/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, status);
      return response.json();
    }
    const invalid = { title: 123, content: 'x' };
    assert.deepEqual(await post('unchecked', invalid), { data: invalid, classInstance: false });
    const rejected = await post('checked', invalid, 400);
    assert.equal(rejected.error.code, 'VALIDATION_ERROR');
    console.log('PASS：DTO class 型別不會自動驗證；綁定 Pipe 才拒絕非法輸入。');

    assert.deepEqual(await post('checked', { title: ' 標題 ', content: ' 本文 ' }), {
      data: { title: '標題', content: '本文' }, rawTitle: ' 標題 ',
    });
    const response = await fetch(`${base}/validation/query?page=2&pageSize=3`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { page: 2, pageSize: 3 }, raw: { page: '2', pageSize: '3' } });
    console.log('PASS：Pipe 回傳修剪／轉型後的參數，原始 req.body／req.query 不被覆寫。');

    assert.deepEqual(await post('nullable', {}), { data: {}, hasNickname: false });
    assert.deepEqual(await post('nullable', { nickname: null }), { data: { nickname: null }, hasNickname: true });
    assert.deepEqual(await post('nullable', { nickname: ' 小明 ' }), { data: { nickname: '小明' }, hasNickname: true });
    await post('nullable', { nickname: '' }, 400);
    console.log('PASS：示範欄位的省略、null、字串與空字串有不同語意；文章欄位仍拒絕 null。');
  } finally { await app.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
