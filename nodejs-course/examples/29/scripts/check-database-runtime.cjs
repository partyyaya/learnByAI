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
    const missingOrigin = spawnSync(process.execPath, ['dist/main.js'], { env: { ...process.env, DATABASE_URL: fixture.url, APP_ORIGIN: '' }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(missingOrigin.error); assert.equal(missingOrigin.status, 1); assert.doesNotMatch(missingOrigin.stdout, /"event":"listening"/);
    const unavailableUrl = new URL(fixture.url); unavailableUrl.hostname = '127.0.0.1'; unavailableUrl.port = '1';
    const unavailable = spawnSync(process.execPath, ['dist/main.js'], { env: { ...process.env, DATABASE_URL: unavailableUrl.toString() }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(unavailable.error); assert.equal(unavailable.status, 1);
    assert.doesNotMatch(unavailable.stdout, /"event":"listening"/);
    assert.match(unavailable.stdout, /"event":"startup_failed"/);
    const absent = new URL(fixture.url); absent.searchParams.set('schema', `absent_${fixture.schema}`);
    const unmigrated = spawnSync(process.execPath, ['dist/main.js'], { env: { ...process.env, DATABASE_URL: absent.toString() }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(unmigrated.error); assert.equal(unmigrated.status, 1);
    assert.doesNotMatch(unmigrated.stdout, /"event":"listening"/);
    const result = spawnSync(process.execPath, ['scripts/check-signals.cjs'], { env: { ...process.env, DATABASE_URL: fixture.url }, stdio: 'inherit', timeout: 45000 });
    assert.ifError(result.error); assert.equal(result.status, 0);
    const auditCheck = fixture.connect();
    try { await auditCheck.$executeRawUnsafe(`DROP TABLE "${fixture.schema}"."ArticleStatusAudit"`); }
    finally { await auditCheck.$disconnect(); }
    const missingAudit = spawnSync(process.execPath, ['dist/main.js'], { env: { ...process.env, DATABASE_URL: fixture.url }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(missingAudit.error); assert.equal(missingAudit.status, 1);
    assert.doesNotMatch(missingAudit.stdout, /"event":"listening"/); assert.match(missingAudit.stdout, /"event":"startup_failed"/);
    // 恢復空的稽核表，再獨立驗證缺 Session 的既有案例。
    const { readFileSync } = require('node:fs');
    const { Pool } = require('pg');
    const rawUrl = new URL(fixture.url); rawUrl.searchParams.delete('schema');
    const pool = new Pool({ connectionString: rawUrl.toString(), max: 1 });
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(`SET LOCAL search_path TO "${fixture.schema}"`);
      await connection.query('DROP TYPE "ArticleStatusAction"');
      await connection.query(readFileSync('prisma/migrations/202611020001_article_status_audit/migration.sql', 'utf8'));
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); await pool.end(); }
    const legacy = fixture.connect();
    try { await legacy.$executeRawUnsafe(`DROP TABLE "${fixture.schema}"."Session"`); }
    finally { await legacy.$disconnect(); }
    const missingSession = spawnSync(process.execPath, ['dist/main.js'], { env: { ...process.env, DATABASE_URL: fixture.url }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(missingSession.error); assert.equal(missingSession.status, 1);
    assert.doesNotMatch(missingSession.stdout, /"event":"listening"/); assert.match(missingSession.stdout, /"event":"startup_failed"/);
    console.log('PASS：缺少 URL／Origin、資料庫不可達、缺 migration／稽核表／Session 表拒絕監聽；程序信號驗證成功。');
  } finally { await fixture.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
