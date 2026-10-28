import { beforeAll, afterAll, beforeEach, afterEach, expect, test } from '@jest/globals';
import { once } from 'node:events';
import supertest from 'supertest';
import { createArticleApplication } from '../src/application.js';
import { seedDatabase } from '../src/seed-database.js';
import type { Database } from '../src/database.js';
import { databaseFixture } from './database-fixture.js';
import { articleContract } from './api-contract.js';
import { createPrismaArticleRepository } from '../src/prisma-article-repository.js';
import { createArticleService } from '../src/article-service.js';

let fixture: Awaited<ReturnType<typeof databaseFixture>>;
let db: Database;
let server: ReturnType<typeof createArticleApplication>;
beforeAll(async () => { fixture = await databaseFixture(); }, 45000);
afterAll(async () => { await fixture?.dispose(); });
async function start() {
  db = fixture.connect();
  try { await db.$connect(); } catch (error) { await db.$disconnect(); throw error; }
  server = createArticleApplication({ database: db }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
}
beforeEach(async () => {
  await start();
  // 只清理本次測試擁有的隨機 schema；所有測試循序執行。
  await db.article.deleteMany(); await db.user.deleteMany(); await seedDatabase(db);
});
afterEach(async () => { await server?.lifecycle.shutdown(); });
articleContract(() => server);

test('服務與 client 關閉後重新建立，文章仍存在', async () => {
  const created = await supertest(server).post('/api/articles').send({ title: 'persist', content: 'retained' }).expect(201);
  await server.lifecycle.shutdown();
  await start();
  const result = await supertest(server).get(created.headers.location).expect(200);
  expect(result.body.data).toEqual(created.body.data);
});

test('兩個服務與不同連線池同時更新，相同版本只有一個成功', async () => {
  const otherDb = fixture.connect(); const other = createArticleApplication({ database: otherDb });
  other.listen(0, '127.0.0.1'); await once(other, 'listening');
  try {
    const results = await Promise.all([server, other].map((app, i) => supertest(app).patch('/api/articles/a_1').send({ title: `writer ${i}`, expectedVersion: 1 })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const stored = await supertest(other).get('/api/articles/a_1').expect(200);
    expect(stored.body.data).toEqual(results.find(result => result.status === 200)!.body.data);
  } finally { await other.lifecycle.shutdown(); }
});

test('重跑 migration 不破壞資料，seed 不覆寫讀者修改', async () => {
  await supertest(server).patch('/api/articles/a_1').send({ title: 'keep my changes', expectedVersion: 1 }).expect(200);
  fixture.deploy(); await seedDatabase(db);
  expect((await db.article.findUniqueOrThrow({ where: { id: 'a_1' } })).title).toBe('keep my changes');
}, 45000);

test('外鍵與唯一鍵由真實資料庫拒絕', async () => {
  await expect(db.article.create({ data: { id: 'orphan', authorId: 'missing', title: 'x', content: 'y' } })).rejects.toMatchObject({ code: 'P2003' });
  await expect(db.user.create({ data: { id: 'u_demo', displayName: 'duplicate' } })).rejects.toMatchObject({ code: 'P2002' });
});

test('失敗交易回滾，前面的修改不會留下', async () => {
  await expect(db.$transaction(async tx => {
    await tx.article.update({ where: { id: 'a_1' }, data: { title: 'must rollback' } });
    await tx.article.create({ data: { id: 'bad-fk', authorId: 'missing', title: 'x', content: 'y' } });
  })).rejects.toMatchObject({ code: 'P2003' });
  expect((await db.article.findUniqueOrThrow({ where: { id: 'a_1' } })).title).toBe('認識 Node HTTP');
});

test('像 SQL 的文字作為資料保存，不成為可執行 SQL', async () => {
  const title = "x'); DROP TABLE Article; --";
  const created = await supertest(server).post('/api/articles').send({ title, content: 'literal' }).expect(201);
  expect((await supertest(server).get(created.headers.location).expect(200)).body.data.title).toBe(title);
  expect(await db.article.count()).toBe(4);
});

test('超過資料庫 Int 範圍的舊版本仍是 409，而非 driver 500', async () => {
  const result = await supertest(server).patch('/api/articles/a_1').send({ title: 'x', expectedVersion: Number.MAX_SAFE_INTEGER }).expect(409);
  expect(result.body.error.code).toBe('VERSION_CONFLICT');
});

test('沒有套用 migration 的 schema：live 200、ready 503、未知資料錯誤不洩漏 SQL', async () => {
  const { createDatabase } = await import('../src/database.js');
  const url = new URL(fixture.url); url.searchParams.set('schema', `absent_${fixture.schema}`);
  const broken = createArticleApplication({ database: createDatabase(url.toString()) });
  broken.listen(0, '127.0.0.1'); await once(broken, 'listening');
  try {
    await supertest(broken).get('/health/live').expect(200);
    const readiness = await supertest(broken).get('/health/ready').expect(503);
    expect(readiness.body.error.code).toBe('NOT_READY');
    const result = await supertest(broken).get('/api/articles').expect(500);
    expect(result.body.error).toEqual({ code: 'INTERNAL_ERROR', message: '內部錯誤', details: [] });
  } finally { await broken.lifecycle.shutdown(); }
});

test('Repository 的交易 callback 拋錯，已完成的條件 UPDATE 也回滾', async () => {
  const repository = createPrismaArticleRepository(db);
  const before = await db.article.findUniqueOrThrow({ where: { id: 'a_1' } });
  const failure = new Error('後續步驟失敗');
  await expect(repository.withTransaction(async tx => {
    const updated = await tx.updateIfCurrent(before, { title: 'must rollback', status: before.status });
    expect(updated?.version).toBe(2);
    throw failure;
  })).rejects.toBe(failure);
  expect(await db.article.findUniqueOrThrow({ where: { id: 'a_1' } })).toEqual(before);
});

test('Repository UPDATE 確實同時檢查 version 與 status', async () => {
  const repository = createPrismaArticleRepository(db);
  const before = await db.article.findUniqueOrThrow({ where: { id: 'a_1' } });
  for (const stale of [{ ...before, version: 99 }, { ...before, status: 'draft' as const }]) {
    expect(await repository.withTransaction(tx => tx.updateIfCurrent(stale, { title: 'must not write', status: 'archived' }))).toBeNull();
  }
  expect(await db.article.findUniqueOrThrow({ where: { id: 'a_1' } })).toEqual(before);
});

test('兩個 Repository 交易都已讀到同一版本後，仍只有一個 UPDATE 成功', async () => {
  const otherDb = fixture.connect();
  let arrived = 0; let release!: () => void;
  const bothRead = new Promise<void>(resolve => { release = resolve; });
  try {
    const results = await Promise.allSettled([db, otherDb].map((client, index) =>
      createPrismaArticleRepository(client).withTransaction(async tx => {
        const before = await tx.findById('a_1');
        if (!before) throw new Error('fixture missing');
        arrived += 1; if (arrived === 2) release();
        await bothRead; // 測試專用屏障，確保兩邊先 SELECT，正式交易不應如此等待。
        return tx.updateIfCurrent(before, { title: `writer ${index}`, status: before.status });
      })));
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    const rows = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(2);
    expect(await db.article.findUniqueOrThrow({ where: { id: 'a_1' } })).toEqual(rows[0]);
  } finally { await otherDb.$disconnect(); }
});

test('列表在資料庫先篩選再分頁，管理只計固定作者，公開只計 published', async () => {
  await db.user.create({ data: { id: 'u_other', displayName: '其他作者' } });
  await db.article.create({ data: { id: 'other-public', authorId: 'u_other', title: 'other', content: 'x', status: 'published' } });
  const service = createArticleService(createPrismaArticleRepository(db));
  const managed = await service.list({ page: 1, pageSize: 1 }, false);
  expect(managed.meta.total).toBe(3); expect(managed.data).toHaveLength(1);
  expect(managed.data[0].authorId).toBe('u_demo');
  const visible = await service.list({ page: 1, pageSize: 20 }, true);
  expect(visible.meta.total).toBe(3); expect(visible.data.every(row => row.status === 'published')).toBe(true);
  await expect(service.detail('other-public', false)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
