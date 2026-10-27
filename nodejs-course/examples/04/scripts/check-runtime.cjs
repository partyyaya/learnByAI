const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
let cases = 0;
function run(args) {
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', ...args], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  cases++;
  return result;
}
for (const [mode, message] of [['awaited', 'local caught'], ['returned', 'caller caught']]) {
  const result = run(['experiments/errors.cjs', mode]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), message);
}
for (const [mode, pattern] of [['detached', /operation failed/], ['callback', /callback failed/], ['emitter', /source failed/], ['async-listener', /listener failed/]]) {
  const result = run(['experiments/errors.cjs', mode]);
  assert.notEqual(result.status, 0, mode);
  assert.match(result.stderr, pattern);
  assert.ok(!result.stdout.includes('local caught'));
}
const demo = run(['dist/main.js']);
assert.equal(demo.status, 0, demo.stderr);
assert.deepEqual(JSON.parse(demo.stdout), [
  { scenario: 'success', outcome: 'article-ready', listeners: 0 },
  { scenario: 'source-error', outcome: 'source unavailable', listeners: 0 },
  { scenario: 'timeout', outcome: 'timeout', listeners: 0 },
  { scenario: 'cancel', outcome: 'user cancelled', listeners: 0 },
]);
console.log(`PASS：${cases} 項程序檢查，預期失敗均在獨立子程序中驗證；正常示範自行結束。`);
