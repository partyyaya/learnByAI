// migration／示範 seed 為獨立工作，API 啟動不自動執行它們。
const { spawnSync } = require('node:child_process');
const { databaseUrlFrom } = require('../dist/runtime-config.js');
(async () => {
  const task = process.argv[2];
  if (!['migrate', 'status', 'seed-demo'].includes(task)) throw new Error('unknown release task');
  const url = databaseUrlFrom(process.env);
  if (task === 'seed-demo') {
    if (process.env.DEMO_AUTH_SEED !== '1') throw new Error('demo seed requires opt-in');
    const { createDatabase } = require('../dist/database.js');
    const { seedDatabase } = require('../dist/seed-database.js');
    const db = createDatabase(url); try { await seedDatabase(db); } finally { await db.$disconnect(); }
  } else {
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', task === 'migrate' ? 'deploy' : 'status'], {
      env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60000, encoding: 'utf8',
    });
    // 不直接印出 Prisma 的 datasource URL 或錯誤 SQL；失敗為非零，不繼續啟動。
    if (result.error || result.status !== 0) throw new Error('migration task failed');
  }
  console.log(JSON.stringify({ event: 'release_task_completed', task }));
})().catch(() => { console.error('{"event":"release_task_failed"}'); process.exitCode = 1; });
