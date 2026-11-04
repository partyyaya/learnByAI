const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const ca = readFileSync('/run/secrets/local_ca');
const origin = 'https://localhost:34426';
const evidence = '/evidence';
function call(path, { method = 'GET', body, cookie, csrf, headers = {}, trusted = true } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request({ hostname: 'proxy', port: 8443, servername: 'localhost', path, method,
      ...(trusted ? { ca } : {}), rejectUnauthorized: true, agent: false,
      headers: { Host: 'localhost:34426', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { Origin: origin, 'X-CSRF-Token': csrf } : {}),
        ...(text === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }), ...headers },
    }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 200000) { reject(new Error('response limit')); req.destroy(); } else chunks.push(chunk); });
      res.on('error', reject); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, body: text && res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : undefined });
      });
    });
    const timer = setTimeout(() => { reject(new Error('request deadline')); req.destroy(); }, 10000);
    req.once('close', () => clearTimeout(timer)); req.on('error', reject); req.end(text);
  });
}
function cookieOf(response) {
  const value = response.headers['set-cookie'][0];
  assert.match(value, /^__Host-course_session=/); assert.match(value, /; Secure/i); assert.match(value, /; HttpOnly/i);
  assert.match(value, /; Path=\//i); assert.match(value, /; SameSite=Lax/i); assert.doesNotMatch(value, /; Domain=/i);
  return value.split(';')[0];
}
function envelope(result, status) {
  assert.equal(result.status, status);
  assert.match(result.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  if (status >= 400) assert.equal(result.body.requestId, result.headers['x-request-id']);
  assert.doesNotMatch(result.text, /postgresql:\/\/|passwordHash|tokenHash|SELECT |"stack"\s*:/);
}
(async () => {
  mkdirSync(evidence, { recursive: true });
  for (let n = 0; ; n++) {
    try { envelope(await call('/health/ready'), 200); break; }
    catch (error) { if (n >= 60) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (process.argv.includes('--verify')) {
    const proof = JSON.parse(readFileSync(evidence + '/production-proof.json', 'utf8'));
    const session = JSON.parse(readFileSync(evidence + '/deployment-session.json', 'utf8'));
    const article = await call('/api/articles/' + proof.article.id); envelope(article, 200); assert.deepEqual(article.body.data, proof.article);
    const me = await call('/api/auth/me', { cookie: session.cookie }); envelope(me, 200); assert.equal(me.body.data.id, session.userId);
    console.log('PASS production persistence: HTTPS article and server-side Session survived replacement/restart'); return;
  }
  await assert.rejects(call('/health/live', { trusted: false }));
  envelope(await call('/health/live'), 200);
  const redirect = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: 'proxy', port: 8080, path: '/api/articles?sort=oldest', agent: false }, res => { res.resume(); res.on('end', () => resolve(res)); }); req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('redirect deadline')));
  });
  assert.equal(redirect.statusCode, 308); assert.equal(redirect.headers.location, origin + '/api/articles?sort=oldest');
  const doc = await call('/api/openapi.json'); envelope(doc, 200); assert.equal(doc.body.info.version, '24.0.0'); assert.equal(Object.keys(doc.body.paths).length, 18);
  envelope(await call('/missing?token=never-log-deployment-input'), 404);
  envelope(await call('/api/articles/'), 200);
  envelope(await call('/api/articles/a_draft/'), 404);
  const head = await call('/api/articles', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.text, '');
  const big = await call('/api/articles/preview', { method: 'POST', body: { title: 'x', content: 'x'.repeat(17000) } }); envelope(big, 413);
  const csrf = await call('/api/auth/csrf', { headers: { 'X-Forwarded-Proto': 'http', 'X-Forwarded-For': '203.0.113.1', 'X-Request-ID': 'external-untrusted' } }); envelope(csrf, 200);
  assert.notEqual(csrf.headers['x-request-id'], 'external-untrusted');
  const anonymous = cookieOf(csrf); const password = randomUUID() + 'Course26!'; const email = `deploy-${randomUUID()}@example.test`;
  envelope(await call('/api/auth/register', { method: 'POST', cookie: anonymous, csrf: csrf.body.data.csrfToken, body: { email, password, displayName: 'Deployment rehearsal' } }), 201);
  const login = await call('/api/auth/login', { method: 'POST', cookie: anonymous, csrf: csrf.body.data.csrfToken, body: { email, password } }); envelope(login, 200);
  const cookie = cookieOf(login); assert.notEqual(cookie, anonymous);
  const session = { cookie, csrf: login.body.data.csrfToken, userId: login.body.data.user.id };
  envelope(await call('/api/auth/me', { cookie }), 200);
  envelope(await call('/api/articles', { method: 'POST', cookie, csrf: session.csrf, headers: { Origin: 'https://wrong.example' }, body: { title: 'denied', content: 'denied' } }), 403);
  envelope(await call('/api/articles', { method: 'POST', cookie, csrf: csrf.body.data.csrfToken, body: { title: 'denied', content: 'denied' } }), 403);
  const created = await call('/api/articles', { method: 'POST', cookie, csrf: session.csrf, body: { title: '第 26 章部署驗收', content: 'TLS、Session 與資料跨容器保留' } }); envelope(created, 201);
  assert.equal(created.headers.location, '/api/me/articles/' + created.body.data.id);
  envelope(await call('/api/articles/' + created.body.data.id), 404);
  const published = await call('/api/articles/' + created.body.data.id + '/publish', { method: 'POST', cookie, csrf: session.csrf, body: { expectedVersion: 1 } }); envelope(published, 200);
  assert.equal(published.body.data.version, 2); envelope(await call('/api/articles/' + created.body.data.id), 200);
  const metrics = await call('/health/metrics'); assert.equal(metrics.status, 200); assert.match(metrics.text, /course_http_requests_total/);
  const proof = { origin, tlsVerified: true, redirect: 308, cookie: 'Secure; HttpOnly; SameSite=Lax; Path=/; no Domain', csrfDenied: [403, 403], article: published.body.data };
  writeFileSync(evidence + '/production-proof.json', JSON.stringify(proof, null, 2) + '\n');
  // Explicit private cookie jar, excluded from CI artifact uploads and never printed.
  writeFileSync(evidence + '/deployment-session.json', JSON.stringify(session), { mode: 0o600 });
  console.log('PASS production HTTPS: CA validation, redirect, Secure Cookie, CSRF, 16 KiB, paths, publication and safe metrics');
})().catch(() => { console.error('PRODUCTION_CHECK_FAILED'); process.exitCode = 1; });
