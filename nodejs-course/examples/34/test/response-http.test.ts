import { expect, jest, test } from '@jest/globals';
import raw from 'supertest';
import authenticated from './authenticated-test-client.js';
import { authDouble, testDependencies } from './module-fixture.js';
import { createArticleServer } from '../src/server.js';
import type { ArticleService } from '../src/article-service.js';
import type { Article } from '../src/article-model.js';
import type { ErrorReport } from '../src/errors.js';
import { ARTICLE_SERVICE, AUTH_SERVICE, CHECK_READY } from '../src/tokens.js';

async function setup() {
  const article = Object.assign({ id: 'a_projection', authorId: 'u_demo', title: '投影', content: '本文', status: 'draft', version: 1,
    createdAt: new Date('2026-01-01Z'), updatedAt: new Date('2026-01-01Z') } satisfies Article,
  { internalNote: 'SECRET article', author: { passwordHash: 'SECRET nested' }, toJSON: () => ({ leaked: 'SECRET toJSON' }) });
  const page = { data: [article], meta: { page: 1, pageSize: 20, total: 1, internalPlan: 'SECRET meta' }, internalCount: 'SECRET page' };
  const articles = {
    create: jest.fn<ArticleService['create']>().mockResolvedValue(article),
    detail: jest.fn<ArticleService['detail']>().mockResolvedValue(article),
    adminDetail: jest.fn<ArticleService['adminDetail']>().mockResolvedValue(article),
    list: jest.fn<ArticleService['list']>().mockResolvedValue(page),
    change: jest.fn<ArticleService['change']>().mockResolvedValue(article),
  };
  const auth = authDouble(); const resolve = auth.resolve;
  const session = await resolve('s'.repeat(43)); if (!session?.user) throw new Error('fixture missing');
  const user = Object.assign(session.user, { passwordHash: 'SECRET password', sessions: [{ tokenHash: 'SECRET session' }] });
  auth.resolve = async token => { const found = await resolve(token); return found ? { ...found, user } : null; };
  auth.register = async () => user;
  auth.login = async () => ({ token: 'n'.repeat(43), session: { ...session, userId: user.id, user, csrfToken: 'c'.repeat(43) } });
  auth.logout = async () => {};
  const reports: ErrorReport[] = [];
  const server = await createArticleServer({ dependencies: testDependencies([
    { provide: ARTICLE_SERVICE, useValue: articles }, { provide: CHECK_READY, useValue: async () => {} },
    { provide: AUTH_SERVICE, useValue: auth },
  ]), onError: report => reports.push(report) });
  return { server, api: authenticated(server), article, articles, user, reports };
}
const articleKeys = ['id', 'authorId', 'title', 'content', 'status', 'version', 'createdAt', 'updatedAt'].sort();

test.each(['/api/articles/a_projection', '/api/me/articles/a_projection'])('%s 明列文章欄位，不序列化內部欄位、巢狀關聯或自訂 toJSON', async path => {
  const { server, api, article } = await setup();
  try {
    const result = await api.get(path).expect(200);
    expect(Object.keys(result.body)).toEqual(['data']); expect(Object.keys(result.body.data).sort()).toEqual(articleKeys);
    expect(result.body.data.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(JSON.stringify(result.body)).not.toContain('SECRET');
    expect(article.internalNote).toBe('SECRET article'); expect(article.createdAt).toBeInstanceOf(Date);
  } finally { await server.lifecycle.shutdown(); }
});

test.each(['/api/articles', '/api/me/articles'])('%s 列表只包一次 data，meta 也採白名單', async path => {
  const { server, api } = await setup();
  try {
    const result = await api.get(path).expect(200);
    expect(Object.keys(result.body).sort()).toEqual(['data', 'meta']);
    expect(result.body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(Object.keys(result.body.data[0]).sort()).toEqual(articleKeys);
    expect(JSON.stringify(result.body)).not.toContain('SECRET');
  } finally { await server.lifecycle.shutdown(); }
});

test.each(['create', 'edit', 'publish', 'archive'])('%s 綁定相同投影，保留成功碼和 Location', async action => {
  const { server, api } = await setup();
  try {
    const pending = action === 'create' ? api.post('/api/articles') : action === 'edit' ? api.patch('/api/articles/a_projection') : api.post(`/api/articles/a_projection/${action}`);
    const result = await pending.send(action === 'create' ? { title: 'x', content: 'y' } : { expectedVersion: 1, ...(action === 'edit' ? { title: 'x' } : {}) }).expect(action === 'create' ? 201 : 200);
    expect(Object.keys(result.body.data).sort()).toEqual(articleKeys);
    expect(JSON.stringify(result.body)).not.toContain('SECRET');
    if (action === 'create') expect(result.headers.location).toBe('/api/me/articles/a_projection');
  } finally { await server.lifecycle.shutdown(); }
});

test('admin 查詢也投影文章，不因不同 Controller 漏掉邊界', async () => {
  const { server, api, user } = await setup(); user.role = 'admin';
  try {
    const result = await api.get('/api/admin/articles/a_projection').expect(200);
    expect(Object.keys(result.body.data).sort()).toEqual(articleKeys); expect(JSON.stringify(result.body)).not.toContain('SECRET');
  } finally { await server.lifecycle.shutdown(); }
});

test.each(['me', 'register', 'login'])('%s 即使 Service 意外多回憑證／關聯欄位，HTTP 仍只有公開使用者資料', async action => {
  const { server, api, user } = await setup();
  try {
    const pending = action === 'me' ? api.get('/api/auth/me') : api.post(`/api/auth/${action}`).send({
      email: 'new@example.test', password: 'a long new password', ...(action === 'register' ? { displayName: 'new' } : {}),
    });
    const result = await pending.expect(action === 'register' ? 201 : 200);
    const projected = action === 'login' ? result.body.data.user : result.body.data;
    expect(Object.keys(projected).sort()).toEqual(['displayName', 'email', 'id', 'role']);
    expect(JSON.stringify(result.body)).not.toContain('SECRET');
    expect(user.passwordHash).toBe('SECRET password');
    if (action === 'login') {
      expect(Object.keys(result.body.data).sort()).toEqual(['csrfToken', 'user']);
      expect(result.headers['set-cookie'][0]).toContain('HttpOnly');
    }
  } finally { await server.lifecycle.shutdown(); }
});

test('204、preview 與健康回應不被全域 Interceptor 多包一層', async () => {
  const { server, api } = await setup();
  try {
    const logout = await api.post('/api/auth/logout').send({}).expect(204); expect(logout.text).toBe('');
    expect((await api.get('/health/live').expect(200)).body).toEqual({ data: { status: 'ok' } });
    expect((await api.post('/api/articles/preview').send({ title: ' x ', content: ' y ' }).expect(200)).body)
      .toEqual({ data: { title: 'x', content: 'y', status: 'draft', preview: true } });
    await api.get('/responses/ok').expect(404); // lab 未掛入正式 API。
  } finally { await server.lifecycle.shutdown(); }
});

test('Guard 在投影之前拒絕；錯誤不包成成功 data，reporter 由 DI 注入', async () => {
  const { server, articles, reports } = await setup();
  try {
    const result = await raw(server).get('/api/me/articles').expect(401);
    expect(result.body).not.toHaveProperty('data'); expect(result.body.error.code).toBe('UNAUTHENTICATED');
    expect(articles.list).not.toHaveBeenCalled();
    expect(reports).toEqual([{ requestId: result.headers['x-request-id'], status: 401, code: 'UNAUTHENTICATED', phase: 'before-response' }]);
  } finally { await server.lifecycle.shutdown(); }
});

test('presenter 失敗走 Filter，保留 500／requestId，不把內部資料送出', async () => {
  const { server, api, article, reports } = await setup(); article.createdAt = new Date(NaN);
  try {
    const result = await api.get('/api/articles/a_projection').expect(500);
    expect(result.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '內部錯誤', details: [] }, requestId: result.headers['x-request-id'] });
    expect(reports[0].code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(reports)).not.toContain('SECRET');
  } finally { await server.lifecycle.shutdown(); }
});

test('未知錯誤即使帶 status／message／response，也不當作可信任 HTTP 錯誤', async () => {
  const { server, api, articles } = await setup();
  articles.detail.mockRejectedValue({ status: 418, message: 'SECRET password', response: { connection: 'SECRET database' } });
  try {
    const result = await api.get('/api/articles/a_projection').expect(500);
    expect(result.body.error).toEqual({ code: 'INTERNAL_ERROR', message: '內部錯誤', details: [] });
  } finally { await server.lifecycle.shutdown(); }
});
