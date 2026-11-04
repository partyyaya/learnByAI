import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from '@jest/globals';
import raw from 'supertest';
import { createArticleApplication } from '../src/application.js';
import { demoAccounts, seedDatabase } from '../src/seed-database.js';
import { databaseFixture } from './database-fixture.js';
import { tokenHash } from '../src/auth-service.js';
import { createPrismaAuthRepository } from '../src/prisma-auth-repository.js';
import type { Database } from '../src/database.js';

const origin = 'http://127.0.0.1:3018';
let fixture: Awaited<ReturnType<typeof databaseFixture>>;
let db: Database;
let server: Awaited<ReturnType<typeof createArticleApplication>>;
let now: Date;
type Credentials = { cookie: string; csrf: string };
function cookieOf(response: raw.Response) { return response.headers['set-cookie'][0].split(';')[0] as string; }
function authorized(request: raw.Test, credentials: Credentials) {
  return request.set('Cookie', credentials.cookie).set('Origin', origin).set('X-CSRF-Token', credentials.csrf);
}
async function anonymous(): Promise<Credentials> {
  const result = await raw(server).get('/api/auth/csrf').expect(200);
  return { cookie: cookieOf(result), csrf: result.body.data.csrfToken };
}
async function login(index = 0, previous?: Credentials): Promise<Credentials> {
  const before = previous ?? await anonymous(); const account = demoAccounts[index];
  const response = await authorized(raw(server).post('/api/auth/login'), before)
    .send({ email: account.email, password: account.password }).expect(200);
  return { cookie: cookieOf(response), csrf: response.body.data.csrfToken };
}
function digest(credentials: Credentials) { return tokenHash(credentials.cookie.split('=')[1]); }
function me(credentials: Credentials) { return raw(server).get('/api/auth/me').set('Cookie', credentials.cookie); }
beforeAll(async () => { fixture = await databaseFixture(); }, 45000);
beforeEach(async () => {
  db = fixture.connect();
  await db.session.deleteMany(); await db.article.deleteMany(); await db.user.deleteMany(); await seedDatabase(db);
  now = new Date();
  server = await createArticleApplication({ database: db, auth: { origin, now: () => now } });
});
afterEach(async () => { await server?.lifecycle.shutdown(); });
afterAll(async () => { await fixture?.dispose(); });

test('CSRF bootstrap 建立匿名 Session；登入原子輪替 cookie 和 token，資料庫只有憑證摘要', async () => {
  const before = await anonymous();
  await me(before).expect(401);
  const existing = await raw(server).get('/api/auth/csrf').set('Cookie', before.cookie).expect(200);
  expect(existing.body.data.csrfToken).toBe(before.csrf); expect(existing.headers['set-cookie']).toBeUndefined();
  const after = await login(0, before);
  expect(after.cookie).not.toBe(before.cookie); expect(after.csrf).not.toBe(before.csrf);
  expect((await db.session.findUniqueOrThrow({ where: { tokenHash: digest(before) } })).revokedAt).not.toBeNull();
  const row = await db.session.findUniqueOrThrow({ where: { tokenHash: digest(after) } });
  expect(row.userId).toBe('u_demo'); expect(JSON.stringify(row)).not.toContain(after.cookie.split('=')[1]);
  const response = await me(after).expect(200).expect('Cache-Control', 'no-store');
  expect(response.body.data).toEqual({ id: 'u_demo', email: 'alice@example.test', displayName: 'Alice', role: 'member' });
  expect(JSON.stringify(response.body)).not.toMatch(/password|tokenHash|csrfToken/);
  await me(before).expect(401);
});

test('本機 cookie 為 HttpOnly、SameSite=Lax、Path=/ 且有期限；HTTPS 使用 __Host 前綴及 Secure', async () => {
  const local = await raw(server).get('/api/auth/csrf').expect(200);
  expect(local.headers['set-cookie'][0]).toMatch(/^course_session=.*; Max-Age=\d+; Path=\/; Expires=.*; HttpOnly; SameSite=Lax$/);
  await server.lifecycle.shutdown();
  db = fixture.connect(); server = await createArticleApplication({ database: db, auth: { origin: 'https://course.example.test' } });
  const secure = await raw(server).get('/api/auth/csrf').expect(200);
  expect(secure.headers['set-cookie'][0]).toMatch(/^__Host-course_session=/);
  expect(secure.headers['set-cookie'][0]).toContain('; Secure;');
  expect(secure.headers['set-cookie'][0]).not.toContain('Domain=');
});

test('註冊正規化 email、固定 member 且不自動登入；不回傳 passwordHash', async () => {
  const session = await anonymous(); const input = { email: ' New@Example.test ', password: 'a long new password', displayName: ' 新讀者 ' };
  const result = await authorized(raw(server).post('/api/auth/register'), session).send(input).expect(201);
  expect(result.body.data).toMatchObject({ email: 'new@example.test', displayName: '新讀者', role: 'member' });
  expect(result.body.data).not.toHaveProperty('passwordHash');
  await me(session).expect(401);
  const row = await db.user.findUniqueOrThrow({ where: { email: 'new@example.test' } });
  expect(row.passwordHash).toMatch(/^scrypt\$/); expect(row.passwordHash).not.toContain(input.password);
  const signedIn = await authorized(raw(server).post('/api/auth/login'), session)
    .send({ email: 'NEW@example.test', password: input.password }).expect(200);
  expect(signedIn.body.data.user.id).toBe(row.id);
});

test('並行註冊同 email 只有一筆，唯一鍵衝突映射 409', async () => {
  const session = await anonymous(); const body = { email: 'same@example.test', password: 'a long new password', displayName: 'new' };
  const results = await Promise.all([0, 1].map(() => authorized(raw(server).post('/api/auth/register'), session).send(body)));
  expect(results.map(value => value.status).sort()).toEqual([201, 409]);
  expect(results.find(value => value.status === 409)!.body.error.code).toBe('USER_ALREADY_EXISTS');
  expect(await db.user.count({ where: { email: body.email } })).toBe(1);
});

test.each(['role', 'id', 'passwordHash'])('註冊拒絕額外 %s 欄位，不增加帳號', async key => {
  const session = await anonymous();
  const response = await authorized(raw(server).post('/api/auth/register'), session)
    .send({ email: 'bad@example.test', password: 'a long new password', displayName: 'new', [key]: 'SECRET_VALUE' }).expect(400);
  expect(JSON.stringify(response.body)).not.toContain('SECRET'); expect(await db.user.count()).toBe(3);
});

test('未知帳號和錯誤密碼回相同 401；錯誤不輪替 Session', async () => {
  const session = await anonymous(); const failures = [];
  for (const email of ['alice@example.test', 'unknown@example.test']) {
    failures.push((await authorized(raw(server).post('/api/auth/login'), session)
      .send({ email, password: 'a definitely wrong password' }).expect(401)).body.error);
  }
  expect(failures[0]).toEqual(failures[1]); expect(failures[0].code).toBe('INVALID_CREDENTIALS');
  expect(await db.session.count()).toBe(1);
  expect((await db.session.findUniqueOrThrow({ where: { tokenHash: digest(session) } })).revokedAt).toBeNull();
});

test('登入本身也需要匿名 Session、正確 Origin 與 CSRF', async () => {
  const account = demoAccounts[0]; const body = { email: account.email, password: account.password };
  await raw(server).post('/api/auth/login').set('Origin', origin).send(body).expect(403);
  const session = await anonymous();
  await raw(server).post('/api/auth/login').set('Cookie', session.cookie).set('Origin', origin).send(body).expect(403);
  await authorized(raw(server).post('/api/auth/login'), session).set('Origin', 'https://evil.example').send(body).expect(403);
  expect(await db.session.count({ where: { userId: { not: null } } })).toBe(0);
});

test.each(['/api/auth/me', '/api/me/articles', '/api/me/articles/a_draft', '/api/admin/articles/a_draft'])('匿名讀取 %s 回 401', async path => {
  await raw(server).get(path).expect(401).expect('Cache-Control', 'no-store');
});

test('匿名寫入回 401；parser 在 Guard 前，非法媒體類型仍先回 415', async () => {
  await raw(server).post('/api/articles').send({ title: 'x', content: 'y' }).expect(401);
  await raw(server).patch('/api/articles/a_1').send({ title: 'x', expectedVersion: 1 }).expect(401);
  await raw(server).post('/api/articles/a_1/publish').send({ expectedVersion: 1 }).expect(401);
  await raw(server).post('/api/articles/a_1/archive').send({ expectedVersion: 1 }).expect(401);
  await raw(server).post('/api/articles').type('text').send('x').expect(415);
  expect(await db.article.count()).toBe(3);
});

test('所有角色公開只看 published；me 只看自己，admin 的跨作者入口另行限制', async () => {
  const alice = await login(); const bob = await login(1); const admin = await login(2);
  for (const session of [alice, bob, admin]) {
    const list = await raw(server).get('/api/articles').set('Cookie', session.cookie).expect(200);
    expect(list.body.data.every((row: { status: string }) => row.status === 'published')).toBe(true);
    await raw(server).get('/api/articles/a_draft').set('Cookie', session.cookie).expect(404);
  }
  await raw(server).get('/api/me/articles/a_draft').set('Cookie', alice.cookie).expect(200);
  for (const session of [bob, admin]) {
    await raw(server).get('/api/me/articles/a_draft').set('Cookie', session.cookie).expect(404);
    expect((await raw(server).get('/api/me/articles').set('Cookie', session.cookie).expect(200)).body.meta.total).toBe(0);
  }
  await raw(server).get('/api/admin/articles/a_draft').set('Cookie', admin.cookie).expect(200);
  await raw(server).get('/api/admin/articles/missing').set('Cookie', admin.cookie).expect(404);
  await raw(server).get('/api/admin/articles/a_draft').set('Cookie', alice.cookie).expect(403);
});

test('建立作者來自 Session；body 不能指定 authorId', async () => {
  const bob = await login(1);
  const response = await authorized(raw(server).post('/api/articles'), bob).send({ title: 'Bob', content: '正文' }).expect(201);
  expect(response.body.data.authorId).toBe('u_bob');
  await authorized(raw(server).post('/api/articles'), bob).send({ title: 'x', content: 'y', authorId: 'u_demo' }).expect(400);
  expect(await db.article.count()).toBe(4);
});

test.each(['edit', 'publish', 'archive'])('其他作者的 %s 先回 403，不洩漏版本／狀態，文章不變；不存在仍為 404', async action => {
  const bob = await login(1); const before = await db.article.findUniqueOrThrow({ where: { id: 'a_1' } });
  const write = (id: string) => action === 'edit' ? raw(server).patch(`/api/articles/${id}`) : raw(server).post(`/api/articles/${id}/${action}`);
  const input = { expectedVersion: 999, ...(action === 'edit' ? { title: 'intrusion' } : {}) };
  const result = await authorized(write('a_1'), bob).send(input).expect(403);
  expect(result.body.error.code).toBe('FORBIDDEN');
  await authorized(write('missing'), bob).send(input).expect(404);
  expect(await db.article.findUniqueOrThrow({ where: { id: 'a_1' } })).toEqual(before);
});

test('admin 可修改別人文章，但版本、狀態與作者仍受保護', async () => {
  const admin = await login(2);
  await authorized(raw(server).patch('/api/articles/a_draft'), admin).send({ title: '審核', expectedVersion: 1 }).expect(200);
  await authorized(raw(server).post('/api/articles/a_draft/publish'), admin).send({ expectedVersion: 2 }).expect(200);
  await authorized(raw(server).post('/api/articles/a_draft/archive'), admin).send({ expectedVersion: 3 }).expect(200);
  const stale = await authorized(raw(server).patch('/api/articles/a_draft'), admin).send({ title: 'x', expectedVersion: 3 }).expect(409);
  expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  const archived = await authorized(raw(server).patch('/api/articles/a_draft'), admin).send({ title: 'x', expectedVersion: 4 }).expect(409);
  expect(archived.body.error.code).toBe('INVALID_STATE');
  expect(await db.article.findUniqueOrThrow({ where: { id: 'a_draft' } })).toMatchObject({ authorId: 'u_demo', version: 4, title: '審核' });
});

test.each(['missing', 'null', 'https://evil.example', 'http://127.0.0.1:3018.evil.example'])('Origin %s 拒絕寫入', async value => {
  const session = await login(); const req = authorized(raw(server).post('/api/articles'), session);
  if (value === 'missing') req.unset('Origin'); else req.set('Origin', value);
  await req.send({ title: 'x', content: 'y' }).expect(403);
  expect(await db.article.count()).toBe(3);
});

test('缺少、錯誤、跨 Session、輪替前 CSRF 都拒絕；不能用 body token 替代 header', async () => {
  const before = await anonymous(); const session = await login(0, before); const other = await anonymous();
  for (const csrf of ['', 'wrong', other.csrf, before.csrf]) {
    await authorized(raw(server).post('/api/articles'), { ...session, csrf }).send({ title: 'x', content: 'y' }).expect(403);
  }
  await raw(server).post('/api/articles').set('Cookie', session.cookie).set('Origin', origin)
    .send({ title: 'x', content: 'y', csrfToken: session.csrf }).expect(403);
  expect(await db.article.count()).toBe(3);
});

test('登出撤銷資料庫 Session 並清 Cookie；重複／缺少 Session 仍 204，有效 Session 必須驗證 CSRF', async () => {
  const session = await login();
  await raw(server).post('/api/auth/logout').set('Cookie', session.cookie).set('Origin', origin).send({}).expect(403);
  await me(session).expect(200);
  const result = await authorized(raw(server).post('/api/auth/logout'), session).send({}).expect(204);
  expect(result.text).toBe(''); expect(result.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
  expect((await db.session.findUniqueOrThrow({ where: { tokenHash: digest(session) } })).revokedAt).not.toBeNull();
  await me(session).expect(401);
  await raw(server).post('/api/auth/logout').set('Cookie', session.cookie).set('Origin', origin).send({}).expect(204);
  await raw(server).post('/api/auth/logout').set('Origin', origin).send({}).expect(204);
  await raw(server).post('/api/auth/logout').send({}).expect(403);
});

test('固定期限、不滑動續期；過期後 401，過期登出仍 204，csrf 重新發匿名 Session', async () => {
  const session = await login(); const row = await db.session.findUniqueOrThrow({ where: { tokenHash: digest(session) } });
  now = new Date(row.expiresAt.getTime() - 1); await me(session).expect(200);
  expect((await db.session.findUniqueOrThrow({ where: { tokenHash: digest(session) } })).expiresAt).toEqual(row.expiresAt);
  now = row.expiresAt; await me(session).expect(401);
  await raw(server).post('/api/auth/logout').set('Cookie', session.cookie).set('Origin', origin).send({}).expect(204);
  const replacement = await raw(server).get('/api/auth/csrf').set('Cookie', session.cookie).expect(200);
  expect(cookieOf(replacement)).not.toBe(session.cookie);
});

test('URL／Authorization 不認作 Session；重複和非法 cookie 拒絕', async () => {
  const session = await login(); const token = session.cookie.split('=')[1];
  await raw(server).get(`/api/auth/me?session=${token}`).set('Authorization', `Bearer ${token}`).expect(401);
  await raw(server).get('/api/auth/me').set('Cookie', `${session.cookie}; ${session.cookie}`).expect(401);
  await raw(server).get('/api/auth/me').set('Cookie', 'course_session=%73'.repeat(43)).expect(401);
  await me(session).expect(200);
});

test('每次查詢重新讀取角色；admin 降權立即影響下一個請求，刪除帳號使 Session 無效', async () => {
  const admin = await login(2);
  await db.user.update({ where: { id: 'u_admin' }, data: { role: 'member' } });
  await raw(server).get('/api/admin/articles/a_draft').set('Cookie', admin.cookie).expect(403);
  expect((await me(admin).expect(200)).body.data.role).toBe('member');
  await db.user.delete({ where: { id: 'u_admin' } }); await me(admin).expect(401);
  expect(await db.session.count({ where: { userId: 'u_admin' } })).toBe(0);
});

test('重建 app 和連線池後既有 Session 仍可用，重新登入會撤銷它', async () => {
  const session = await login(); await server.lifecycle.shutdown();
  db = fixture.connect(); server = await createArticleApplication({ database: db, auth: { origin, now: () => now } });
  await me(session).expect(200);
  const next = await login(0, session); await me(session).expect(401); await me(next).expect(200);
});

test('同一舊 Session 並行登入只建立一個有效新 Session', async () => {
  const before = await anonymous(); const account = demoAccounts[0];
  const results = await Promise.all([0, 1].map(() => authorized(raw(server).post('/api/auth/login'), before)
    .send({ email: account.email, password: account.password })));
  expect(results.map(result => result.status).sort()).toEqual([200, 401]);
  expect(await db.session.count({ where: { userId: 'u_demo', revokedAt: null } })).toBe(1);
});

test('輪替的新 Session 寫入失敗時，舊 Session 撤銷會一起回滾', async () => {
  const before = await anonymous();
  await expect(createPrismaAuthRepository(db).rotateSession(digest(before), {
    tokenHash: 'a'.repeat(64), csrfToken: 'b'.repeat(43), userId: 'missing', expiresAt: new Date(now.getTime() + 60000),
  }, now)).rejects.toMatchObject({ code: 'P2003' });
  expect((await db.session.findUniqueOrThrow({ where: { tokenHash: digest(before) } })).revokedAt).toBeNull();
  expect(await db.session.count()).toBe(1);
});

test('每 IP 每分鐘共 20 次認證嘗試；不信任 X-Forwarded-For，時間窗到期可恢復', async () => {
  for (let i = 0; i < 20; i++) await raw(server).get('/api/auth/csrf').expect(200);
  const blocked = await raw(server).get('/api/auth/csrf').set('X-Forwarded-For', '203.0.113.42').expect(429);
  expect(blocked.body.error.code).toBe('RATE_LIMITED'); expect(await db.session.count()).toBe(20);
  now = new Date(now.getTime() + 60000); await raw(server).get('/api/auth/csrf').expect(200);
});

test('舊帳號可保留文章，但缺少登入憑證時不能登入；seed 不覆寫已改的密碼和角色', async () => {
  await db.user.update({ where: { id: 'u_demo' }, data: { email: null, passwordHash: null } });
  await db.user.update({ where: { id: 'u_admin' }, data: { role: 'member' } });
  await seedDatabase(db);
  expect(await db.user.findUniqueOrThrow({ where: { id: 'u_demo' } })).toMatchObject({ email: null, passwordHash: null });
  expect((await db.user.findUniqueOrThrow({ where: { id: 'u_admin' } })).role).toBe('member');
  const before = await anonymous();
  await authorized(raw(server).post('/api/auth/login'), before).send({ email: 'alice@example.test', password: demoAccounts[0].password }).expect(401);
  expect(await db.article.count({ where: { authorId: 'u_demo' } })).toBe(3);
});

test('認證端點錯誤方法回 405，preview 仍公開且不寫入', async () => {
  await raw(server).get('/api/auth/login').expect(405).expect('Allow', 'POST');
  await raw(server).post('/api/auth/me').expect(405).expect('Allow', 'GET, HEAD');
  await raw(server).post('/api/articles/preview').send({ title: 'x', content: 'y' }).expect(200);
  expect(await db.article.count()).toBe(3);
});

test('認證詳細路徑尾斜線回 404，不先要求 body；大小寫不能繞過 Guard', async () => {
  await raw(server).post('/api/auth/login/').expect(404);
  await raw(server).get('/api/auth/me/').expect(404);
  await raw(server).get('/api/Auth/me').expect(404);
});

test('只有舊文章表可用仍不 ready：缺 Session 表必須回 503', async () => {
  // 使用另一個自有 fixture，避免破壞其他案例的 migration 狀態。
  const legacy = await databaseFixture(); const legacyDb = legacy.connect();
  const app = await createArticleApplication({ database: legacyDb });
  try {
    // Prisma ORM 的 schema 選項不等於 raw SQL 的 search_path；明確限定自有 schema。
    await legacyDb.$executeRawUnsafe(`DROP TABLE "${legacy.schema}"."Session"`);
    await raw(app).get('/health/live').expect(200);
    expect((await raw(app).get('/health/ready').expect(503)).body.error.code).toBe('NOT_READY');
    await raw(app).get('/api/articles').expect(200);
  } finally { await app.lifecycle.shutdown(); await legacy.dispose(); }
}, 45000);
