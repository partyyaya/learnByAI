import { expect, test } from '@jest/globals';
import raw from 'supertest';
import { once } from 'node:events';
import { httpFixture, loginSession } from './http-fixture.js';
import { demoAccounts } from '../src/seed-database.js';
import { ARTICLE_REPOSITORY, DATABASE } from '../src/tokens.js';
import { createPrismaArticleRepository } from '../src/prisma-article-repository.js';
import type { Database } from '../src/database.js';
import type { ArticleRepository } from '../src/article-repository.js';
import { createDatabase } from '../src/database.js';
import { createTestingApplication } from './testing-application.js';

test('TestingModule 的真 DB／Service／Repository／Guard 全部接上，live／ready 正常', async () => {
  const fixture = await httpFixture();
  try {
    expect(fixture.context.get(DATABASE)).toBe(fixture.database);
    await raw(fixture.server).get('/health/live').expect(200);
    await raw(fixture.server).get('/health/ready').expect(200);
    await raw(fixture.server).get('/api/me/articles').expect(401);
    const alice = await loginSession(fixture.server);
    const me = await alice.agent.get('/api/auth/me').expect(200);
    expect(me.body.data.id).toBe('u_demo'); expect(me.body.data).not.toHaveProperty('passwordHash');
  } finally { await fixture.dispose(); }
});
test('Alice／Bob 使用不同 agent 的 Cookie jar，CSRF 不能跨 Session 借用', async () => {
  const fixture = await httpFixture();
  try {
    const alice = await loginSession(fixture.server);
    const bob = await loginSession(fixture.server, demoAccounts[1]);
    expect((await alice.agent.get('/api/auth/me').expect(200)).body.data.id).toBe('u_demo');
    expect((await bob.agent.get('/api/auth/me').expect(200)).body.data.id).toBe('u_bob');
    await bob.agent.post('/api/articles').set(alice.writeHeaders).send({ title: '錯的 CSRF', content: 'x' }).expect(403);
    const own = await bob.agent.post('/api/articles').set(bob.writeHeaders).send({ title: 'Bob 的草稿', content: 'x' }).expect(201);
    expect(own.body.data.authorId).toBe('u_bob');
    await alice.agent.get(own.headers.location).expect(404);
    await bob.agent.get('/api/me/articles/a_draft').expect(404);
  } finally { await fixture.dispose(); }
});
test('真 owner／admin 授權拒絕後文章與稽核不變，admin 的 me 仍不是跨作者列表', async () => {
  const fixture = await httpFixture();
  try {
    const before = await fixture.database.article.findUniqueOrThrow({ where: { id: 'a_draft' } });
    const bob = await loginSession(fixture.server, demoAccounts[1]);
    const denied = await bob.agent.post('/api/articles/a_draft/archive').set(bob.writeHeaders).send({ expectedVersion: 999 }).expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    const admin = await loginSession(fixture.server, demoAccounts[2]);
    const own = await admin.agent.get('/api/me/articles').expect(200); expect(own.body.meta.total).toBe(0);
    await admin.agent.get('/api/admin/articles/a_draft').expect(200);
    await admin.agent.patch('/api/articles/a_draft').set(admin.writeHeaders).send({ title: 'x', expectedVersion: 999 }).expect(409);
    expect(await fixture.database.article.findUniqueOrThrow({ where: { id: 'a_draft' } })).toEqual(before);
    expect(await fixture.database.articleStatusAudit.count()).toBe(0);
  } finally { await fixture.dispose(); }
});
test('只替換 Repository 的一個失敗步驟：真 INSERT 後拋錯，HTTP 與兩張表證明回滾', async () => {
  let failOnce = true; let inserted = 0;
  const fixture = await httpFixture({ configure: builder => builder.overrideProvider(ARTICLE_REPOSITORY).useFactory({
    inject: [DATABASE], factory: (database: Database): ArticleRepository => {
      const base = createPrismaArticleRepository(database);
      return { ...base, withTransaction: work => base.withTransaction(tx => work({ ...tx,
        appendStatusAudit: async input => {
          await tx.appendStatusAudit(input); inserted++;
          if (failOnce) { failOnce = false; throw new Error('SECRET failure after INSERT'); }
        },
      })) };
    },
  }) });
  try {
    const alice = await loginSession(fixture.server);
    const before = await fixture.database.article.findUniqueOrThrow({ where: { id: 'a_draft' } });
    const failed = await alice.agent.post('/api/articles/a_draft/publish').set(alice.writeHeaders).send({ expectedVersion: 1 }).expect(500);
    expect(inserted).toBe(1);
    expect(failed.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '內部錯誤', details: [] }, requestId: failed.headers['x-request-id'] });
    expect(await fixture.database.article.findUniqueOrThrow({ where: { id: 'a_draft' } })).toEqual(before);
    expect(await fixture.database.articleStatusAudit.count()).toBe(0);
    const success = await alice.agent.post('/api/articles/a_draft/publish').set(alice.writeHeaders).send({ expectedVersion: 1 }).expect(200);
    expect(success.body.data.version).toBe(2); expect(await fixture.database.articleStatusAudit.count()).toBe(1);
  } finally { await fixture.dispose(); }
});
test('兩個 TestingModule／pool 共用同一 schema，相同版本並行發佈只有一個成功', async () => {
  const fixture = await httpFixture();
  let other: Awaited<ReturnType<typeof createTestingApplication>> | undefined;
  try {
    other = await createTestingApplication({ database: createDatabase(fixture.url) });
    other.server.listen(0, '127.0.0.1'); await once(other.server, 'listening');
    const alice = await loginSession(fixture.server); const second = await loginSession(other.server);
    const responses = await Promise.all([alice, second].map(session =>
      session.agent.post('/api/articles/a_draft/publish').set(session.writeHeaders).send({ expectedVersion: 1 })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(responses.find(response => response.status === 409)!.body.error.code).toBe('VERSION_CONFLICT');
    expect(await fixture.database.articleStatusAudit.count()).toBe(1);
    expect(await fixture.database.article.findUniqueOrThrow({ where: { id: 'a_draft' } })).toMatchObject({ version: 2, status: 'published' });
  } finally { try { await other?.server.lifecycle.shutdown(); } finally { await fixture.dispose(); } }
});
test('reset 只重設自有 schema 並撤銷先前 Session，新的登入仍能使用', async () => {
  const fixture = await httpFixture();
  try {
    const alice = await loginSession(fixture.server);
    await alice.agent.post('/api/articles/a_draft/publish').set(alice.writeHeaders).send({ expectedVersion: 1 }).expect(200);
    await fixture.reset();
    await alice.agent.get('/api/auth/me').expect(401);
    const again = await loginSession(fixture.server);
    const article = await again.agent.get('/api/me/articles/a_draft').expect(200);
    expect(article.body.data).toMatchObject({ version: 1, status: 'draft' });
    expect(await fixture.database.articleStatusAudit.count()).toBe(0);
  } finally { await fixture.dispose(); }
});
test('fixture 的匯出檔獨立於 DB；HEAD、strict routing 與 OpenAPI 仍走正式傳輸', async () => {
  const fixture = await httpFixture();
  try {
    const file = await raw(fixture.server).get('/api/articles/export').expect(200);
    expect(file.text).toBe(fixture.exportText);
    const head = await raw(fixture.server).head('/api/articles/export').expect(200);
    expect(head.text).toBeUndefined(); expect(head.headers['content-length']).toBe(file.headers['content-length']);
    await raw(fixture.server).get('/api/articles/export/').expect(404);
    const docs = await raw(fixture.server).get('/api/openapi.json').expect(200);
    expect(docs.body.openapi).toBe('3.1.1'); expect(docs.body).not.toHaveProperty('data');
    await raw(fixture.server).get('/api/articles/a_draft').expect(404);
  } finally { await fixture.dispose(); }
});
