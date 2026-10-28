import { beforeAll, afterAll, beforeEach, afterEach, expect, test } from '@jest/globals';
import { once } from 'node:events';
import supertest from 'supertest';
import { createArticleServer } from '../src/server.js';
import { seedDatabase } from '../src/seed-database.js';
import type { Database } from '../src/database.js';
import { databaseFixture } from './database-fixture.js';
import { articleContract } from './api-contract.js';

let fixture: Awaited<ReturnType<typeof databaseFixture>>;
let db: Database;
let server: ReturnType<typeof createArticleServer>;
beforeAll(async () => { fixture = await databaseFixture(); }, 45000);
afterAll(async () => { await fixture?.dispose(); });
async function start() {
  db = fixture.connect();
  try { await db.$connect(); } catch (error) { await db.$disconnect(); throw error; }
  server = createArticleServer({ database: db }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
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
  const otherDb = fixture.connect(); const other = createArticleServer({ database: otherDb });
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
  const broken = createArticleServer({ database: createDatabase(url.toString()) });
  broken.listen(0, '127.0.0.1'); await once(broken, 'listening');
  try {
    await supertest(broken).get('/health/live').expect(200);
    const readiness = await supertest(broken).get('/health/ready').expect(503);
    expect(readiness.body.error.code).toBe('NOT_READY');
    const result = await supertest(broken).get('/api/articles').expect(500);
    expect(result.body.error).toEqual({ code: 'INTERNAL_ERROR', message: '內部錯誤', details: [] });
  } finally { await broken.lifecycle.shutdown(); }
});
