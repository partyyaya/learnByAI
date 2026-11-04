const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
(async () => {
  const { createApiClient, ApiFailure } = await import(pathToFileURL(resolve('web/api-client.js')).href);
  const csrf = 'a'.repeat(43); const calls = [];
  const client = createApiClient(async (path, options) => { calls.push({ path, options }); return new Response('{"data":{"ok":true}}', { status: 200 }); });
  client.setCsrf(csrf); await client.request('/api/articles', { method: 'POST', body: { title: 'x' } });
  assert.equal(calls[0].options.credentials, 'same-origin'); assert.equal(calls[0].options.headers['X-CSRF-Token'], csrf); assert.ok(!('Origin' in calls[0].options.headers));
  await assert.rejects(client.request('//evil.example/api')); await assert.rejects(client.request('/api/\\evil')); assert.throws(() => client.setCsrf('bad'));
  const empty = createApiClient(async () => new Response(null, { status: 204 })); assert.equal(await empty.request('/api/auth/logout', { method: 'POST' }), undefined);
  const failure = createApiClient(async () => new Response('{"error":{"code":"VERSION_CONFLICT","message":"SECRET"}}', { status: 409, headers: { 'X-Request-ID': 'untrusted' } }));
  await assert.rejects(failure.request('/api/articles/x'), error => error instanceof ApiFailure && error.code === 'VERSION_CONFLICT' && !error.message.includes('SECRET') && error.requestId === '');
  const broken = createApiClient(async () => new Response('<html>SECRET</html>', { status: 502 })); await assert.rejects(broken.request('/api/articles'), error => error.code === 'BAD_RESPONSE' && !error.message.includes('SECRET'));
  const slow = createApiClient((_path, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('SECRET')), { once: true })), 20);
  await assert.rejects(slow.request('/api/articles'), error => error.code === 'TIMEOUT');
  const controller = new AbortController(); const cancelled = slow.request('/api/articles', { signal: controller.signal }); controller.abort(); await assert.rejects(cancelled, error => error.code === 'CANCELLED');
  // A real HTTP server sends headers and partial JSON, then stalls the body.
  const { createServer } = require('node:http'); const { once } = require('node:events');
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"data":'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const target = `http://127.0.0.1:${server.address().port}`; let headersReceived = false;
    const stalled = createApiClient(async (_path, options) => { const response = await fetch(target, options); headersReceived = true; return response; }, 1000);
    await assert.rejects(stalled.request('/api/articles'), error => error.code === 'TIMEOUT'); assert.equal(headersReceived, true);
    let received; const ready = new Promise(resolve => { received = resolve; });
    const bodyClient = createApiClient(async (_path, options) => { const response = await fetch(target, options); received(); return response; });
    const caller = new AbortController(); const bodyRead = bodyClient.request('/api/articles', { signal: caller.signal });
    await ready; caller.abort(); await assert.rejects(bodyRead, error => error.code === 'CANCELLED');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(calls.length, 1); console.log('PASS web client: same-origin, memory CSRF, safe errors, 204, headers/body deadline, cancellation and no retry');
})().catch(() => { console.error('WEB_CLIENT_CHECK_FAILED'); process.exitCode = 1; });
