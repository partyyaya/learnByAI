const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Pool } = require('pg');

(async () => {
  const raw = process.env.TEST_DATABASE_URL;
  assert.ok(raw, '必須設定 TEST_DATABASE_URL');
  const url = new URL(raw);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname === '/course_test', '只接受 course_test');
  url.searchParams.delete('schema');
  const directory = await mkdtemp(join(tmpdir(), 'course22-parallel-'));
  try {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', resolve('node_modules/jest/bin/jest.js'),
      '--config', 'jest.parallel.config.cjs', '--maxWorkers=2', '--no-cache'], {
      env: { ...process.env, DATABASE_URL: '', COURSE_PARALLEL_RUN_DIR: directory }, stdio: 'inherit', timeout: 90000,
    });
    assert.ifError(result.error); assert.equal(result.status, 0, '並行 Jest 必須正常結束');
    const proof = await Promise.all(['alpha', 'beta'].map(async name => JSON.parse(await readFile(join(directory, `${name}.closed.json`), 'utf8'))));
    for (const key of ['pid', 'workerId', 'schema', 'port']) assert.equal(new Set(proof.map(row => row[key])).size, 2, `${key} 必須互相獨立`);
    assert.ok(proof.every(row => row.closed === true));
    const pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 2000 });
    try {
      const remaining = await pool.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[])', [proof.map(row => row.schema)]);
      assert.equal(remaining.rowCount, 0, '兩份自有 schema 必須已清理');
    } finally { await pool.end(); }
    await mkdir('.data', { recursive: true });
    await writeFile('.data/parallel-proof.json', JSON.stringify({ workers: proof, remainingSchemas: 0 }, null, 2) + '\n');
    console.log('PASS：兩個 worker／PID，同時存在的獨立 schema／port，6 項 HTTP 案例通過且清理完成。');
  } finally { await rm(directory, { recursive: true, force: true }); }
})().catch(() => { console.error('PARALLEL_CHECK_FAILED：請檢查測試輸出、專用 test-db 與清理紀錄'); process.exitCode = 1; });
