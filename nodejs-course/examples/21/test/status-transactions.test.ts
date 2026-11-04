import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from '@jest/globals';
import raw from 'supertest';
import api, { loginAs, testActor } from './authenticated-test-client.js';
import { databaseFixture } from './database-fixture.js';
import { createArticleApplication } from '../src/application.js';
import { seedDatabase, demoAccounts } from '../src/seed-database.js';
import { createArticleService } from '../src/article-service.js';
import { createPrismaArticleRepository } from '../src/prisma-article-repository.js';
import type { Database } from '../src/database.js';
import type { ArticleRepository } from '../src/article-repository.js';

let fixture: Awaited<ReturnType<typeof databaseFixture>>;
let db: Database;
let server: Awaited<ReturnType<typeof createArticleApplication>>;
const admin = { id: 'u_admin', role: 'admin' as const };
const bob = { id: 'u_bob', role: 'member' as const };
const service = () => createArticleService(createPrismaArticleRepository(db));
const stored = () => db.article.findUniqueOrThrow({ where: { id: 'a_draft' } });
const audits = () => db.articleStatusAudit.findMany({ orderBy: { toVersion: 'asc' } });
beforeAll(async () => { fixture = await databaseFixture(); }, 45000);
beforeEach(async () => {
  db = fixture.connect();
  await db.articleStatusAudit.deleteMany(); await db.session.deleteMany();
  await db.article.deleteMany(); await db.user.deleteMany(); await seedDatabase(db);
  server = await createArticleApplication({ database: db });
});
afterEach(async () => { await server?.lifecycle.shutdown(); });
afterAll(async () => { await fixture?.dispose(); });

test('publish／archive 各一筆；中間的 PATCH 不寫狀態稽核，版本允許間隔', async () => {
  const app = service();
  await app.create({ title: 'new', content: 'draft' }, testActor);
  expect(await audits()).toEqual([]);
  await app.change('a_draft', { expectedVersion: 1 }, 'publish', testActor);
  await app.change('a_draft', { expectedVersion: 2, title: 'edited' }, 'edit', testActor);
  const result = await app.change('a_draft', { expectedVersion: 3 }, 'archive', admin);
  expect(result).toMatchObject({ status: 'archived', version: 4, title: 'edited' });
  const rows = await audits();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ articleId: 'a_draft', actorId: 'u_demo', action: 'publish', fromStatus: 'draft', toStatus: 'published', fromVersion: 1, toVersion: 2 });
  expect(rows[1]).toMatchObject({ articleId: 'a_draft', actorId: 'u_admin', action: 'archive', fromStatus: 'published', toStatus: 'archived', fromVersion: 3, toVersion: 4 });
  expect(rows[0].createdAt).toBeInstanceOf(Date);
  expect(Object.keys(rows[0]).sort()).toEqual(['id', 'articleId', 'actorId', 'action', 'fromStatus', 'toStatus', 'fromVersion', 'toVersion', 'createdAt'].sort());
});

test('草稿可直接封存，admin 不改寫作者', async () => {
  await service().change('a_draft', { expectedVersion: 1 }, 'archive', admin);
  expect(await stored()).toMatchObject({ authorId: 'u_demo', status: 'archived', version: 2 });
  expect(await audits()).toEqual([expect.objectContaining({ actorId: 'u_admin', fromStatus: 'draft', toStatus: 'archived' })]);
});

test.each([
  ['missing', 1, testActor, 'NOT_FOUND'],
  ['a_draft', 999, bob, 'FORBIDDEN'],
  ['a_draft', 999, testActor, 'VERSION_CONFLICT'],
  ['a_1', 1, testActor, 'INVALID_STATE'],
] as const)('拒絕 %s／%s／%s 後無稽核', async (id, expectedVersion, actor, code) => {
  const before = await db.article.findMany();
  await expect(service().change(id, { expectedVersion }, 'publish', actor)).rejects.toMatchObject({ code });
  expect(await db.article.findMany()).toEqual(before);
  expect(await audits()).toEqual([]);
});

test('版本上限拒絕狀態變更，不寫稽核', async () => {
  await db.article.update({ where: { id: 'a_draft' }, data: { version: 2147483647 } });
  await expect(service().change('a_draft', { expectedVersion: 2147483647 }, 'publish', testActor)).rejects.toMatchObject({ code: 'VERSION_LIMIT' });
  expect(await stored()).toMatchObject({ status: 'draft', version: 2147483647 });
  expect(await audits()).toEqual([]);
});

test('真正 INSERT 外鍵失敗，已執行的文章 UPDATE 與 updatedAt 一起回滾', async () => {
  const before = await stored();
  // 直接呼叫應用層，模擬取得 actor 後該 User 已不存在；HTTP 不接受 body actor。
  await expect(service().change('a_draft', { expectedVersion: 1 }, 'publish', { id: 'gone_admin', role: 'admin' }))
    .rejects.toMatchObject({ code: 'P2003' });
  expect(await stored()).toEqual(before);
  expect(await audits()).toEqual([]);
});

test('稽核 INSERT 成功後 callback 再失敗，兩張表一起回滾', async () => {
  const before = await stored();
  const base = createPrismaArticleRepository(db);
  const failure = new Error('after audit');
  const repository: ArticleRepository = { ...base, withTransaction: work => base.withTransaction(async tx => {
    await work(tx); throw failure;
  }) };
  await expect(createArticleService(repository).change('a_draft', { expectedVersion: 1 }, 'publish', testActor)).rejects.toBe(failure);
  expect(await stored()).toEqual(before);
  expect(await audits()).toEqual([]);
});

test('HTTP 的真實稽核 INSERT 故障回安全 500，重試相同版本可成功', async () => {
  await loginAs(server);
  const before = await stored();
  // 只在本套件的隨機 schema 裝入故障；不把故障開關加入正式 API。
  await db.$executeRawUnsafe(`CREATE FUNCTION "${fixture.schema}".reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private SQL input must not leak'; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER reject_audit BEFORE INSERT ON "${fixture.schema}"."ArticleStatusAudit" FOR EACH ROW EXECUTE FUNCTION "${fixture.schema}".reject_audit()`);
  try {
    const result = await api(server).post('/api/articles/a_draft/publish').send({ expectedVersion: 1 }).expect(500);
    expect(result.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '內部錯誤', details: [] }, requestId: result.headers['x-request-id'] });
    expect(await stored()).toEqual(before);
    expect(await audits()).toEqual([]);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER reject_audit ON "${fixture.schema}"."ArticleStatusAudit"`);
    await db.$executeRawUnsafe(`DROP FUNCTION "${fixture.schema}".reject_audit()`);
  }
  const result = await api(server).post('/api/articles/a_draft/publish').send({ expectedVersion: 1 }).expect(200);
  expect(result.body.data).toMatchObject({ version: 2, status: 'published' });
  expect(result.body.data).not.toHaveProperty('statusAudits');
  expect(await audits()).toHaveLength(1);
});

test('真正登入 admin 的 HTTP 稽核 actor 是 admin，重送舊版本不重複紀錄', async () => {
  await loginAs(server, demoAccounts[2]);
  await api(server).post('/api/articles/a_draft/archive').send({ expectedVersion: 1 }).expect(200);
  const repeated = await api(server).post('/api/articles/a_draft/archive').send({ expectedVersion: 1 }).expect(409);
  expect(repeated.body.error.code).toBe('VERSION_CONFLICT');
  expect(await audits()).toEqual([expect.objectContaining({ actorId: 'u_admin', articleId: 'a_draft' })]);
});

test('未登入、CSRF、越權拒絕後文章與稽核皆不變', async () => {
  const before = await stored();
  await raw(server).post('/api/articles/a_draft/publish').send({ expectedVersion: 1 }).expect(401);
  await loginAs(server, demoAccounts[1]);
  await api(server).post('/api/articles/a_draft/publish').set('X-CSRF-Token', 'x'.repeat(43)).send({ expectedVersion: 1 }).expect(403);
  const denied = await api(server).post('/api/articles/a_draft/publish').send({ expectedVersion: 1 }).expect(403);
  expect(denied.body.error.code).toBe('FORBIDDEN');
  expect(await stored()).toEqual(before); expect(await audits()).toEqual([]);
});

function twoReaders() {
  let arrived = 0; let release!: () => void;
  const both = new Promise<void>(done => { release = done; });
  return (base: ArticleRepository): ArticleRepository => ({ ...base,
    withTransaction: work => base.withTransaction(tx => work({ ...tx, findById: async id => {
      const row = await tx.findById(id);
      if (++arrived === 2) release();
      await both; // 測試屏障：兩個不同 pool 都完成 SELECT 後才准 UPDATE。
      return row;
    } })),
  });
}

test.each([['publish', 'publish'], ['publish', 'archive'], ['edit', 'publish']] as const)(
  '兩個 pool 已讀相同版本後 %s／%s：一個成功、一個版本衝突，僅成功狀態變更有稽核', async (left, right) => {
    const other = fixture.connect(); const synchronize = twoReaders();
    try {
      const results = await Promise.allSettled([db, other].map((client, i) =>
        createArticleService(synchronize(createPrismaArticleRepository(client))).change('a_draft', { expectedVersion: 1, title: `writer ${i}` }, i === 0 ? left : right, testActor)));
      const winners = results.filter(r => r.status === 'fulfilled');
      const losers = results.filter(r => r.status === 'rejected');
      expect(winners).toHaveLength(1); expect(losers).toHaveLength(1);
      expect(losers[0].reason).toMatchObject({ code: 'VERSION_CONFLICT' });
      const winner = winners[0].value;
      expect(await stored()).toEqual(winner); expect(winner.version).toBe(2);
      const rows = await audits();
      expect(rows).toHaveLength(winner.status === 'draft' ? 0 : 1);
      if (rows.length) expect(rows[0]).toMatchObject({ fromStatus: 'draft', toStatus: winner.status, fromVersion: 1, toVersion: 2 });
    } finally { await other.$disconnect(); }
  },
);

test('稽核唯一鍵、外鍵與 CHECK 約束由 PostgreSQL 執行', async () => {
  await service().change('a_draft', { expectedVersion: 1 }, 'publish', testActor);
  const [row] = await audits();
  const { createdAt: _time, ...input } = row;
  await expect(db.articleStatusAudit.create({ data: { ...input, id: 'duplicate' } })).rejects.toMatchObject({ code: 'P2002' });
  await expect(db.articleStatusAudit.create({ data: { ...input, id: 'missing', articleId: 'missing' } })).rejects.toMatchObject({ code: 'P2003' });
  for (const changes of [{ fromVersion: 0 }, { toVersion: 4 }, { action: 'archive' as const }, { fromStatus: 'archived' as const }]) {
    await expect(db.articleStatusAudit.create({ data: { ...input, id: 'invalid', articleId: 'a_2', ...changes } })).rejects.toThrow();
  }
  await expect(db.article.delete({ where: { id: 'a_draft' } })).rejects.toMatchObject({ code: 'P2003' });
  expect(await audits()).toHaveLength(1);
});

test('連線關閉並重建後，狀態與稽核仍存在；重跑 migration／seed 不補造歷史', async () => {
  await service().change('a_draft', { expectedVersion: 1 }, 'publish', testActor);
  const before = await stored(); const history = await audits();
  await server.lifecycle.shutdown(); fixture.deploy();
  db = fixture.connect(); await seedDatabase(db);
  server = await createArticleApplication({ database: db });
  expect(await stored()).toEqual(before); expect(await audits()).toEqual(history);
}, 45000);

test('已連線但缺稽核 migration，live 200、ready 503；讀文章不會冒充 ready', async () => {
  const separate = await databaseFixture(); const client = separate.connect();
  const app = await createArticleApplication({ database: client });
  try {
    await client.$executeRawUnsafe(`DROP TABLE "${separate.schema}"."ArticleStatusAudit"`);
    await raw(app).get('/health/live').expect(200);
    await raw(app).get('/api/articles').expect(200);
    expect((await raw(app).get('/health/ready').expect(503)).body.error.code).toBe('NOT_READY');
  } finally { await app.lifecycle.shutdown(); await separate.dispose(); }
}, 45000);

test('交易範圍外的 tx 不可再用，不會偷偷變成普通連線', async () => {
  let escaped: Parameters<Parameters<ArticleRepository['withTransaction']>[0]>[0] | undefined;
  await createPrismaArticleRepository(db).withTransaction(async tx => { escaped = tx; });
  await expect(escaped!.findById('a_draft')).rejects.toMatchObject({ code: 'P2028' });
  expect(await audits()).toEqual([]);
});
