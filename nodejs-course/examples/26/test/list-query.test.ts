import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from '@jest/globals';
import raw from 'supertest';
import api, { loginAs, testActor, origin } from './authenticated-test-client.js';
import { databaseFixture } from './database-fixture.js';
import { createArticleApplication } from '../src/application.js';
import { seedDatabase, demoAccounts } from '../src/seed-database.js';
import { createPrismaArticleRepository } from '../src/prisma-article-repository.js';
import { createArticleService } from '../src/article-service.js';
import type { Database } from '../src/database.js';
import { openapiDocument } from '../src/openapi.js';
import { assertApiResponse } from './openapi-contract.js';

let fixture: Awaited<ReturnType<typeof databaseFixture>>;
let db: Database;
let server: Awaited<ReturnType<typeof createArticleApplication>>;
beforeAll(async () => { fixture = await databaseFixture(); }, 45000);
beforeEach(async () => {
  db = fixture.connect();
  await db.articleStatusAudit.deleteMany(); await db.session.deleteMany(); await db.article.deleteMany(); await db.user.deleteMany();
  await seedDatabase(db);
  for (const [id, authorId, status, title] of [
    ['q_01', 'u_demo', 'published', 'Search Alpha'], ['q_02', 'u_demo', 'published', 'search beta'],
    ['q_03', 'u_bob', 'published', 'Search outsider'], ['q_04', 'u_demo', 'draft', 'Search draft'],
    ['q_05', 'u_bob', 'draft', 'Search private'], ['q_06', 'u_demo', 'archived', 'Search archive'],
    ['q_07', 'u_admin', 'published', 'Search admin'], ['q_08', 'u_admin', 'draft', 'Search admin draft'],
    ['q_09', 'u_demo', 'published', 'no title match'], ['q_10', 'u_demo', 'published', '100% literal_\\path'],
    ['q_11', 'u_demo', 'published', '100X literalApath'],
  ] as const) await db.article.create({ data: { id, authorId, status, title, content: 'Search appears in content', createdAt: new Date('2026-02-01Z') } });
  server = await createArticleApplication({ database: db });
});
afterEach(async () => { await server?.lifecycle.shutdown(); });
afterAll(async () => { await fixture?.dispose(); });
const ids = (body: { data: { id: string }[] }) => body.data.map(row => row.id);

test('搜尋 title 不分大小寫，先套 published 再分頁與 count，不搜尋 content', async () => {
  const first = await raw(server).get('/api/articles?q=%20sEaRcH%20&pageSize=2').expect(200);
  const second = await raw(server).get('/api/articles?q=search&pageSize=2&page=2').expect(200);
  expect(ids(first.body)).toEqual(['q_07', 'q_03']); expect(ids(second.body)).toEqual(['q_02', 'q_01']);
  expect(first.body.meta).toEqual({ page: 1, pageSize: 2, total: 4 });
  expect(second.body.meta).toEqual({ page: 2, pageSize: 2, total: 4 });
  assertApiResponse(openapiDocument.paths['/api/articles'].get, 200, first.body);
  expect(await db.articleStatusAudit.count()).toBe(0);
});
test('oldest 使用 createdAt ASC＋id ASC，固定資料的各頁沒有平手重複', async () => {
  const first = await raw(server).get('/api/articles?q=search&sort=oldest&pageSize=2').expect(200);
  const second = await raw(server).get('/api/articles?q=search&sort=oldest&pageSize=2&page=2').expect(200);
  expect([...ids(first.body), ...ids(second.body)]).toEqual(['q_01', 'q_02', 'q_03', 'q_07']);
});
test('無搜尋保留原分頁預設、newest 排序與同層 metadata，越界頁為空但 total 保留', async () => {
  const result = await raw(server).get('/api/articles').expect(200);
  expect(result.body.meta).toEqual({ page: 1, pageSize: 20, total: 9 });
  expect(ids(result.body).slice(0, 3)).toEqual(['q_11', 'q_10', 'q_09']);
  const empty = await raw(server).get('/api/articles?q=search&page=1000000&pageSize=100').expect(200);
  expect(empty.body).toEqual({ data: [], meta: { page: 1000000, pageSize: 100, total: 4 } });
});
test.each(['%', '_', '\\'])('搜尋 %j 是字面值，不是 LIKE wildcard', async q => {
  const result = await raw(server).get('/api/articles').query({ q }).expect(200);
  expect(ids(result.body)).toEqual(['q_10']); expect(result.body.meta.total).toBe(1);
});
test('搜尋 SQL 樣式文字不改變查詢結構', async () => {
  const result = await raw(server).get('/api/articles').query({ q: "%' OR 1=1; --" }).expect(200);
  expect(result.body.data).toEqual([]); expect(result.body.meta.total).toBe(0);
  expect(await db.article.count()).toBe(14);
});
test('本人列表同時套 author、status、搜尋；total 不含他人草稿', async () => {
  await loginAs(server);
  const result = await api(server).get('/api/me/articles?q=search&status=draft').expect(200);
  expect(ids(result.body)).toEqual(['q_04']); expect(result.body.meta.total).toBe(1);
  expect(result.headers['cache-control']).toBe('no-store');
  assertApiResponse(openapiDocument.paths['/api/me/articles'].get, 200, result.body);
  const all = await api(server).get('/api/me/articles?q=search&sort=oldest').expect(200);
  expect(ids(all.body)).toEqual(['q_01', 'q_02', 'q_04', 'q_06']);
});
test('admin 的 me 篩選仍只看 admin；公開列表仍只有 published', async () => {
  await loginAs(server, demoAccounts[2]);
  const managed = await api(server).get('/api/me/articles?q=search&status=draft').expect(200);
  expect(ids(managed.body)).toEqual(['q_08']); expect(managed.body.meta.total).toBe(1);
  const publicList = await api(server).get('/api/articles?q=search').expect(200);
  expect(publicList.body.meta.total).toBe(4);
  expect(publicList.body.data.every((row: { status: string }) => row.status === 'published')).toBe(true);
});
test('即使直接傳應用 query，public status 與固定可見範圍相交，不能覆寫 published', async () => {
  const service = createArticleService(createPrismaArticleRepository(db));
  const result = await service.list({ page: 1, pageSize: 20, status: 'draft' }, true);
  expect(result).toEqual({ data: [], meta: { page: 1, pageSize: 20, total: 0 } });
  const managed = await service.list({ page: 1, pageSize: 20, status: 'draft' }, false, testActor);
  expect(managed.data.every(row => row.authorId === 'u_demo' && row.status === 'draft')).toBe(true);
});
test.each(['q=', 'q=%20%20', 'q=%00', 'q=a&q=b', 'sort=newest&sort=oldest', 'sort=title',
  'status=draft', 'status=published', 'authorId=u_bob', 'q[title]=search'])('公開非法 query %s 安全拒絕', async query => {
  const result = await raw(server).get(`/api/articles?${query}`).expect(400);
  expect(result.body.error.code).toBe('VALIDATION_ERROR');
  expect(result.body.requestId).toBe(result.headers['x-request-id']);
  assertApiResponse(openapiDocument.paths['/api/articles'].get, 400, result.body);
});
test('搜尋長度按 code points 計數，80 個 emoji 接受，81 個拒絕', async () => {
  await raw(server).get('/api/articles').query({ q: '🙂'.repeat(80) }).expect(200);
  await raw(server).get('/api/articles').query({ q: '🙂'.repeat(81) }).expect(400);
});
test('私人列表先要求登入；合法 Session 才驗證 status／未知 query', async () => {
  await raw(server).get('/api/me/articles?status=bad').expect(401);
  await loginAs(server);
  for (const query of ['status=bad', 'status=draft&status=published', 'authorId=u_bob']) {
    await api(server).get(`/api/me/articles?${query}`).expect(400);
  }
});
test('列表 HEAD 套相同篩選且無 body，Content-Length 等於 GET', async () => {
  const get = await raw(server).get('/api/articles?q=search&pageSize=2').expect(200);
  const head = await raw(server).head('/api/articles?q=search&pageSize=2').expect(200);
  expect(head.text).toBeUndefined(); expect(head.headers['content-length']).toBe(get.headers['content-length']);
});
test('跨請求的 offset 分頁會被新增資料推移，固定排序不等於固定快照', async () => {
  const first = await raw(server).get('/api/articles?q=search&pageSize=2').expect(200);
  await db.article.create({ data: { id: 'q_new', authorId: 'u_demo', title: 'Search new', content: 'x', status: 'published', createdAt: new Date('2026-03-01Z') } });
  const second = await raw(server).get('/api/articles?q=search&pageSize=2&page=2').expect(200);
  expect(ids(first.body)).toEqual(['q_07', 'q_03']); expect(ids(second.body)).toEqual(['q_03', 'q_02']);
  expect(second.body.meta.total).toBe(5);
});
test('真實建立／登入／狀態變更與錯誤回應符合公開文件的 schema 子集', async () => {
  for (const action of ['register', 'login']) {
    const denied = await raw(server).post(`/api/auth/${action}`).set('Origin', origin).send({}).expect(403);
    expect(denied.body.error.code).toBe('CSRF_REJECTED');
    assertApiResponse(openapiDocument.paths[`/api/auth/${action}`].post, 403, denied.body);
  }
  const csrf = await raw(server).get('/api/auth/csrf').expect(200);
  assertApiResponse(openapiDocument.paths['/api/auth/csrf'].get, 200, csrf.body);
  const anonymousHeaders = { Cookie: csrf.headers['set-cookie'][0].split(';')[0], Origin: origin, 'X-CSRF-Token': csrf.body.data.csrfToken };
  const registered = await raw(server).post('/api/auth/register').set(anonymousHeaders)
    .send({ email: 'contract@example.test', password: 'Contract-course-21!', displayName: '文件帳號' }).expect(201);
  assertApiResponse(openapiDocument.paths['/api/auth/register'].post, 201, registered.body);
  const duplicate = await raw(server).post('/api/auth/register').set(anonymousHeaders)
    .send({ email: 'contract@example.test', password: 'Contract-course-21!', displayName: '文件帳號' }).expect(409);
  expect(duplicate.body.error.code).toBe('USER_ALREADY_EXISTS');
  assertApiResponse(openapiDocument.paths['/api/auth/register'].post, 409, duplicate.body);
  const invalid = await raw(server).post('/api/auth/login').set(anonymousHeaders)
    .send({ email: demoAccounts[0].email, password: 'A definitely wrong password!' }).expect(401);
  expect(invalid.body.error.code).toBe('INVALID_CREDENTIALS');
  assertApiResponse(openapiDocument.paths['/api/auth/login'].post, 401, invalid.body);
  const loggedIn = await raw(server).post('/api/auth/login').set(anonymousHeaders)
    .send({ email: demoAccounts[0].email, password: demoAccounts[0].password }).expect(200);
  assertApiResponse(openapiDocument.paths['/api/auth/login'].post, 200, loggedIn.body);
  expect(loggedIn.headers['set-cookie'][0]).toContain('HttpOnly');
  await loginAs(server);
  const me = await api(server).get('/api/auth/me').expect(200);
  assertApiResponse(openapiDocument.paths['/api/auth/me'].get, 200, me.body);
  const created = await api(server).post('/api/articles').send({ title: '文件對照', content: '真實資料' }).expect(201);
  assertApiResponse(openapiDocument.paths['/api/articles'].post, 201, created.body);
  expect(created.headers.location).toBe(`/api/me/articles/${created.body.data.id}`);
  const published = await api(server).post(`/api/articles/${created.body.data.id}/publish`).send({ expectedVersion: 1 }).expect(200);
  assertApiResponse(openapiDocument.paths['/api/articles/{id}/publish'].post, 200, published.body);
  const stale = await api(server).post(`/api/articles/${created.body.data.id}/publish`).send({ expectedVersion: 1 }).expect(409);
  assertApiResponse(openapiDocument.paths['/api/articles/{id}/publish'].post, 409, stale.body);
  expect(await db.articleStatusAudit.count({ where: { articleId: created.body.data.id } })).toBe(1);
});
