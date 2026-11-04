const assert = require('node:assert/strict');
const { mkdtemp, cp, symlink, mkdir, writeFile, access, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { databaseFixture } = require('../.test-dist/test/database-fixture.js');
const execute = promisify(execFile);
(async () => {
  const fixture = await databaseFixture(); let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'course26-release-'));
    await cp('prisma', join(directory, 'prisma'), { recursive: true });
    await cp('prisma.config.ts', join(directory, 'prisma.config.ts'));
    await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
    const broken = join(directory, 'prisma/migrations/209901010001_test_failure'); await mkdir(broken);
    await writeFile(join(broken, 'migration.sql'), 'THIS_IS_INTENTIONALLY_INVALID_SQL;\n');
    const marker = join(directory, 'api-started');
    const env = { ...process.env, DATABASE_URL: fixture.url, COURSE_RELEASE_NODE: process.execPath,
      COURSE_RELEASE_TASK: resolve('scripts/release-task.cjs'), COURSE_RELEASE_MARKER: marker };
    delete env.DATABASE_URL_FILE;
    const command = '"$COURSE_RELEASE_NODE" "$COURSE_RELEASE_TASK" migrate && "$COURSE_RELEASE_NODE" -e \'require("node:fs").writeFileSync(process.env.COURSE_RELEASE_MARKER,"started")\'';
    let result;
    try { await execute('/bin/sh', ['-c', command], { cwd: directory, env, timeout: 30000 }); throw new Error('expected failure'); }
    catch (error) { result = error; }
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), '{"event":"release_task_failed"}');
    await assert.rejects(access(marker));
    const db = fixture.connect();
    try {
      assert.equal(await db.article.count(), 0);
      const rows = await db.$queryRawUnsafe(`SELECT migration_name, finished_at FROM "${fixture.schema}"."_prisma_migrations" WHERE migration_name = '209901010001_test_failure'`);
      assert.equal(rows.length, 1); assert.equal(rows[0].finished_at, null);
    } finally { await db.$disconnect(); }
    console.log('PASS release gate: real Prisma migration failure prevents the next command; original tables preserved; owned schema cleaned');
  } finally { try { await fixture.dispose(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); } }
})().catch(() => { console.error('RELEASE_GATE_CHECK_FAILED'); process.exitCode = 1; });
