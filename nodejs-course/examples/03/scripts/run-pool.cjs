const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, ['experiments/pool.cjs'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
  stdio: 'inherit',
  timeout: 15000,
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
