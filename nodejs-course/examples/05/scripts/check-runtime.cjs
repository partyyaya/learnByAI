const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { request } = require('node:http');
const path = require('node:path');
const cwd = path.resolve(__dirname, '..');
const invalid = spawnSync(process.execPath, ['dist/main.js'], { cwd, env: { ...process.env, PORT: 'bad' }, encoding: 'utf8', timeout: 5000 });
assert.ifError(invalid.error);
assert.equal(invalid.status, 1);
const child = spawn(process.execPath, ['dist/main.js'], { cwd, env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(resolve => child.once('exit', resolve));
const timeout = setTimeout(() => { console.error('runtime check timed out'); process.exitCode = 1; child.kill('SIGKILL'); }, 10000);
(async () => {
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`server exited early: ${code}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/LISTENING (.+)\n/);
      if (match) resolve(JSON.parse(match[1]).port);
    });
  });
  await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/health/live', agent: false }, res => {
      res.resume();
      res.on('end', () => { try { assert.equal(res.statusCode, 200); resolve(); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.end();
  });
  console.log('PASS：非法設定拒絕啟動；真實入口啟動後可回應 HTTP。');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  child.kill('SIGTERM');
  await exited;
  clearTimeout(timeout);
});
