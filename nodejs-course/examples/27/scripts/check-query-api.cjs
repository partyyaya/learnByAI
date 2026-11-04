const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { openapiDocument } = require('../dist/openapi.js');
const { createDatabase } = require('../dist/database.js');
const { demoAccounts } = require('../dist/seed-database.js');
const { assertApiResponse } = require('../.test-dist/test/openapi-contract.js');
const base = process.env.CHECK_API_URL || 'http://api:3000';
const origin = process.env.APP_ORIGIN;
async function request(path, status, session, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(10000),
    headers: { ...(session ? { Cookie: session.cookie, Origin: origin, 'X-CSRF-Token': session.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, status, `${method} ${path}: ${response.status}`);
  const text = await response.text(); const result = text ? JSON.parse(text) : undefined;
  if (status >= 400) assert.equal(result.requestId, response.headers.get('x-request-id'));
  return { response, result };
}
async function login(account) {
  const anonymous = await request('/api/auth/csrf', 200);
  const credentials = { cookie: anonymous.response.headers.get('set-cookie').split(';')[0], csrf: anonymous.result.data.csrfToken };
  const result = await request('/api/auth/login', 200, credentials, { email: account.email, password: account.password });
  assertApiResponse(openapiDocument.paths['/api/auth/login'].post, 200, result.result);
  return { cookie: result.response.headers.get('set-cookie').split(';')[0], csrf: result.result.data.csrfToken };
}
(async () => {
  if (!origin || !process.env.DATABASE_URL) throw new Error('需要 APP_ORIGIN 與 DATABASE_URL');
  const db = createDatabase(process.env.DATABASE_URL); const sessions = [];
  try {
    await request('/health/ready', 200);
    const doc = await request('/api/openapi.json', 200);
    assert.deepEqual(doc.result, openapiDocument);
    assert.deepEqual(doc.result, JSON.parse(await readFile('.data/openapi.json', 'utf8')));
    const head = await request('/api/openapi.json', 200, undefined, undefined, 'HEAD');
    assert.equal(head.result, undefined); assert.equal(head.response.headers.get('content-length'), doc.response.headers.get('content-length'));
    if (process.argv.includes('--verify')) {
      const proof = JSON.parse(await readFile('.data/query-api-proof.json', 'utf8'));
      const admin = await login(demoAccounts[2]); sessions.push(admin);
      for (const article of proof.articles) {
        const result = await request(`/api/admin/articles/${article.id}`, 200, admin);
        assert.deepEqual(result.result.data, article);
      }
      const rows = await db.articleStatusAudit.findMany({ where: { articleId: { in: proof.articles.map(row => row.id) } }, orderBy: { id: 'asc' } });
      assert.deepEqual(JSON.parse(JSON.stringify(rows)), proof.audits);
      const visible = await request(`/api/articles?q=${encodeURIComponent(proof.prefix)}`, 200);
      assert.equal(visible.result.meta.total, 2);
      console.log('PASS：API／PostgreSQL 重啟後文件、六篇驗收文章、稽核與公開篩選保持一致。');
      return;
    }
    const alice = await login(demoAccounts[0]); sessions.push(alice);
    const bob = await login(demoAccounts[1]); sessions.push(bob);
    const admin = await login(demoAccounts[2]); sessions.push(admin);
    const prefix = `Ch27 ${randomUUID()}`; const articles = [];
    async function create(session, suffix, action) {
      const result = await request('/api/articles', 201, session, { title: `${prefix} ${suffix}`, content: '契約驗收' });
      let article = result.result.data;
      if (action) article = (await request(`/api/articles/${article.id}/${action}`, 200, session, { expectedVersion: 1 })).result.data;
      articles.push(article); return article;
    }
    const published = await create(alice, 'Alpha', 'publish');
    const draft = await create(alice, 'Beta');
    await create(alice, 'Archived', 'archive');
    const outsider = await create(bob, 'Outsider', 'publish');
    await create(bob, 'Private');
    const adminDraft = await create(admin, 'Admin');
    const q = encodeURIComponent(prefix);
    const first = await request(`/api/articles?q=${q}&pageSize=1`, 200);
    const second = await request(`/api/articles?q=${q}&pageSize=1&page=2`, 200);
    assert.equal(first.result.data[0].id, outsider.id); assert.equal(second.result.data[0].id, published.id);
    assert.equal(first.result.meta.total, 2); assert.equal(second.result.meta.total, 2);
    assertApiResponse(openapiDocument.paths['/api/articles'].get, 200, first.result);
    const oldest = await request(`/api/articles?q=${q}&sort=oldest`, 200);
    assert.equal(oldest.result.data[0].id, published.id);
    const own = await request(`/api/me/articles?q=${q}&status=draft`, 200, alice);
    assert.equal(own.result.meta.total, 1); assert.equal(own.result.data[0].id, draft.id);
    const adminOwn = await request(`/api/me/articles?q=${q}&status=draft`, 200, admin);
    assert.equal(adminOwn.result.meta.total, 1); assert.equal(adminOwn.result.data[0].id, adminDraft.id);
    const bad = await request('/api/articles?status=draft', 400);
    assertApiResponse(openapiDocument.paths['/api/articles'].get, 400, bad.result);
    await request('/api/me/articles?authorId=u_demo', 400, admin);
    const rows = await db.articleStatusAudit.findMany({ where: { articleId: { in: articles.map(row => row.id) } }, orderBy: { id: 'asc' } });
    assert.equal(rows.length, 3);
    await mkdir('.data', { recursive: true });
    await writeFile('.data/query-api-proof.json', JSON.stringify({ prefix, articles, audits: rows }, null, 2) + '\n');
    console.log('PASS：公開／本人篩選、admin 邊界、搜尋／排序／分頁、OpenAPI HTTP／匯出一致、三筆狀態稽核。');
  } finally {
    try { for (const session of sessions) await request('/api/auth/logout', 204, session, {}); }
    finally { await db.$disconnect(); }
  }
})().catch(() => { console.error('QUERY_API_CHECK_FAILED：請檢查 API、seed、build／test 與 OpenAPI 匯出'); process.exitCode = 1; });
