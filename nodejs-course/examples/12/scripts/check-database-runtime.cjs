const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { databaseFixture } = require('../.test-dist/test/database-fixture.js');
const { seedDatabase } = require('../.test-dist/src/seed-database.js');
(async () => {
  const fixture = await databaseFixture();
  try {
    const db = fixture.connect();
    try { await seedDatabase(db); } finally { await db.$disconnect(); }
    const missing = spawnSync(process.execPath, ['dist/main.js'], { env: { ...process.env, DATABASE_URL: '' }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(missing.error); assert.equal(missing.status, 1);
    const absent = new URL(fixture.url); absent.searchParams.set('schema', `absent_${fixture.schema}`);
    const unmigrated = spawnSync(process.execPath, ['dist/main.js'], { env: { ...process.env, DATABASE_URL: absent.toString() }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(unmigrated.error); assert.equal(unmigrated.status, 1);
    const result = spawnSync(process.execPath, ['scripts/check-signals.cjs'], { env: { ...process.env, DATABASE_URL: fixture.url }, stdio: 'inherit', timeout: 45000 });
    assert.ifError(result.error); assert.equal(result.status, 0);
    console.log('PASS：缺少 URL／尚未 migration 拒絕啟動；隔離資料庫上的程序信號驗證成功。');
  } finally { await fixture.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
