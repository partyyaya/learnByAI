const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { request } = require('node:http');
const { once } = require('node:events');
const path = require('node:path');
const cwd = path.resolve(__dirname, '..');

async function scenario(signal, upload, deadline = 3000) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', SHUTDOWN_TIMEOUT_MS: String(deadline) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000);
  let req;
  function line(pattern) {
    const match = output.match(pattern);
    if (match) return Promise.resolve(match);
    return new Promise((resolve, reject) => {
      const data = () => { const found = output.match(pattern); if (found) { cleanup(); resolve(found); } };
      const exit = () => { cleanup(); reject(new Error(`early exit: ${output} ${errors}`)); };
      const cleanup = () => { child.stdout.off('data', data); child.off('exit', exit); };
      child.stdout.on('data', data); child.once('exit', exit);
    });
  }
  try {
    const match = await line(/LISTENING (.+)\n/);
    const port = JSON.parse(match[1]).port;
    let response;
    if (upload) {
      req = request({ host: '127.0.0.1', port, path: '/api/articles/preview', method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', Expect: '100-continue' } });
      response = new Promise(resolve => {
        req.on('error', error => resolve({ error }));
        req.on('response', res => {
          let body = ''; res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
          res.on('error', error => resolve({ error }));
        });
      });
      const continued = once(req, 'continue');
      req.flushHeaders(); await continued;
      req.write('{"title":"停止前已接收",');
    }
    child.kill(signal);
    await line(/SHUTDOWN draining\n/);
    if (upload === 'finish') {
      child.kill(signal); // 重複通知不應再執行一次關閉流程。
      req.end('"content":"仍應完成"}');
      const result = await response;
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.body).data.preview, true);
    }
    const result = await exited;
    assert.equal(result.signal, null, `unexpected signal: ${output} ${errors}`);
    assert.equal(result.code, upload === 'hang' ? 1 : 0, errors);
    assert.equal((output.match(/SHUTDOWN draining/g) || []).length, 1);
    if (upload === 'hang') {
      assert.match(output, /SHUTDOWN deadline/);
      assert.ok((await response).error, '未完成的請求應中斷');
    } else {
      assert.match(output, /SHUTDOWN http-drained\nSHUTDOWN closed/);
    }
  } finally {
    req?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; clearTimeout(watchdog);
  }
}

(async () => {
  for (const env of [{ PORT: 'bad' }, { SHUTDOWN_TIMEOUT_MS: '0' }]) {
    const result = spawnSync(process.execPath, ['dist/main.js'], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, 1);
  }
  await scenario('SIGINT'); await scenario('SIGTERM');
  await scenario('SIGTERM', 'finish'); await scenario('SIGTERM', 'hang', 100);
  console.log('PASS：設定驗證、SIGINT／SIGTERM、完成進行中請求、重複信號與逾期強制結束。');
})().catch(error => { console.error(error); process.exitCode = 1; });
