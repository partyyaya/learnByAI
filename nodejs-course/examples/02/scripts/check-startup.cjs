const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = mkdtempSync(path.join(tmpdir(), 'chapter02-env-'));
const envFile = path.join(temp, 'demo.env');
writeFileSync(envFile, 'APP_NAME=from-file\nPORT=3000\nENABLE_AUDIT_LOG=false\n');
let cases = 0;

function run(extraEnv = {}, extraArgs = []) {
  const env = { ...process.env };
  for (const key of ['APP_NAME', 'PORT', 'NODE_ENV', 'ENABLE_AUDIT_LOG', 'NODE_OPTIONS']) delete env[key];
  const result = spawnSync(process.execPath, [...extraArgs, 'dist/main.js'], {
    cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function check(name, verify) {
  verify();
  cases += 1;
  console.log(`PASS：${name}`);
}

try {
  check('有效環境可執行文章規則', () => {
    const result = run({ APP_NAME: 'from-env', PORT: '3000' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /文章 \[published\] a_1001/);
  });
  check('缺少必要設定時非零結束，業務尚未執行', () => {
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /APP_NAME.*PORT/);
    assert.equal(result.stdout, '');
  });
  check('非法設定不洩漏原值，也不執行業務', () => {
    const marker = 'private-value-placeholder';
    const result = run({ APP_NAME: 'example', PORT: marker });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PORT/);
    assert.ok(!result.stderr.includes(marker));
    assert.equal(result.stdout, '');
  });
  check('--env-file 明確載入檔案，false 轉成布林值', () => {
    const result = run({}, [`--env-file=${envFile}`]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /from-file/);
    assert.match(result.stdout, /稽核開關：false/);
  });
  check('既有環境變數優先於 --env-file', () => {
    const result = run({ PORT: '4100' }, [`--env-file=${envFile}`]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /預定連接埠 4100/);
  });
  check('空環境值也不會被檔案的值補上', () => {
    const result = run({ PORT: '' }, [`--env-file=${envFile}`]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PORT/);
  });
  check('指定不存在的 env 檔案會停止執行', () => {
    const result = run({}, [`--env-file=${path.join(temp, 'missing.env')}`]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  });
  console.log(`啟動驗證：${cases} 項通過`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
