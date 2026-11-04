const assert = require('node:assert/strict');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { createDatabase } = require('../dist/database.js');
const { demoAccounts } = require('../dist/seed-database.js');

// 連到正在執行的 Compose API；只在記憶體保留 Cookie／CSRF，不輸出憑證。
const base = process.env.CHECK_API_URL || 'http://api:3000';
const origin = process.env.APP_ORIGIN;
const proofPath = '.data/status-api-proof.json';
async function request(path, expected, session, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${base}${path}`, {
    method, signal: AbortSignal.timeout(10000),
    headers: { ...(session ? { Cookie: session.cookie, Origin: origin, 'X-CSRF-Token': session.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expected, `${method} ${path}: HTTP ${response.status}`);
  const text = await response.text();
  const result = text ? JSON.parse(text) : undefined;
  if (expected >= 400) assert.equal(result.requestId, response.headers.get('x-request-id'));
  return { response, result };
}
async function login(account) {
  const anonymous = await request('/api/auth/csrf', 200);
  const session = { cookie: anonymous.response.headers.get('set-cookie').split(';')[0], csrf: anonymous.result.data.csrfToken };
  const loggedIn = await request('/api/auth/login', 200, session, { email: account.email, password: account.password });
  return { cookie: loggedIn.response.headers.get('set-cookie').split(';')[0], csrf: loggedIn.result.data.csrfToken };
}

(async () => {
  if (!origin || !process.env.DATABASE_URL) throw new Error('需要 APP_ORIGIN 與 DATABASE_URL');
  const db = createDatabase(process.env.DATABASE_URL);
  try {
    await request('/health/ready', 200);
    if (process.argv.includes('--verify')) {
      const proof = JSON.parse(await readFile(proofPath, 'utf8'));
      const admin = await login(demoAccounts[2]);
      const result = await request(`/api/admin/articles/${proof.id}`, 200, admin);
      assert.deepEqual(result.result.data, proof.article);
      const rows = await db.articleStatusAudit.findMany({ where: { articleId: proof.id }, orderBy: { toVersion: 'asc' } });
      assert.deepEqual(JSON.parse(JSON.stringify(rows)), proof.audits);
      await request('/api/auth/logout', 204, admin, {});
      console.log('PASS：API／PostgreSQL 重啟後，文章與兩筆稽核逐欄位相同。');
      return;
    }
    const alice = await login(demoAccounts[0]);
    const created = await request('/api/articles', 201, alice, { title: '第 25 章交易驗收', content: '狀態與稽核一起提交' });
    const id = created.result.data.id;
    assert.equal(created.response.headers.get('location'), `/api/me/articles/${id}`);
    assert.equal(await db.articleStatusAudit.count({ where: { articleId: id } }), 0);
    await request(`/api/articles/${id}`, 404);
    const bob = await login(demoAccounts[1]);
    const forbidden = await request(`/api/articles/${id}/publish`, 403, bob, { expectedVersion: 1 });
    assert.equal(forbidden.result.error.code, 'FORBIDDEN');
    // 同一個 API 的兩個 HTTP 請求；不同 pool 的確定性交錯由 Jest 另測。
    const responses = await Promise.all([0, 1].map(() => fetch(`${base}/api/articles/${id}/publish`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Cookie: alice.cookie, Origin: origin, 'X-CSRF-Token': alice.csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1 }),
    })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    for (const response of responses) {
      const body = await response.json();
      if (response.status === 409) { assert.equal(body.error.code, 'VERSION_CONFLICT'); assert.equal(body.requestId, response.headers.get('x-request-id')); }
    }
    const publicResult = await request(`/api/articles/${id}`, 200);
    assert.deepEqual(Object.keys(publicResult.result.data).sort(), ['id', 'authorId', 'title', 'content', 'status', 'version', 'createdAt', 'updatedAt'].sort());
    const head = await request(`/api/articles/${id}`, 200, undefined, undefined, 'HEAD');
    assert.equal(head.result, undefined);
    assert.equal(head.response.headers.get('content-length'), publicResult.response.headers.get('content-length'));
    const admin = await login(demoAccounts[2]);
    const archived = await request(`/api/articles/${id}/archive`, 200, admin, { expectedVersion: 2 });
    assert.equal(archived.result.data.authorId, 'u_demo'); assert.equal(archived.result.data.version, 3);
    await request(`/api/articles/${id}`, 404);
    const rows = await db.articleStatusAudit.findMany({ where: { articleId: id }, orderBy: { toVersion: 'asc' } });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => [row.actorId, row.action, row.fromStatus, row.toStatus, row.fromVersion, row.toVersion]), [
      ['u_demo', 'publish', 'draft', 'published', 1, 2], ['u_admin', 'archive', 'published', 'archived', 2, 3],
    ]);
    await mkdir('.data', { recursive: true });
    // 保存可公開的文章與稽核驗收結果；不保存 Cookie、CSRF 或密碼。
    await writeFile(proofPath, JSON.stringify({ id, article: archived.result.data, audits: rows }, null, 2) + '\n');
    for (const session of [alice, bob, admin]) await request('/api/auth/logout', 204, session, {});
    await request('/api/auth/me', 401, alice);
    console.log('PASS：三角色、Location、公開範圍、HEAD、並行 200／409、兩筆稽核與登出撤銷。');
    console.log(`已保留驗收文章 ${id}；重啟後可執行 npm run test:status-persistence。`);
  } finally { await db.$disconnect(); }
})().catch(() => { console.error('STATUS_API_CHECK_FAILED：請檢查 API、seed、migration 與驗收資料'); process.exitCode = 1; });
