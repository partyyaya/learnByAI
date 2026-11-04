import { expect, jest, test } from '@jest/globals';
import supertest, { testActor } from './authenticated-test-client.js';
import { createArticleServer } from '../src/server.js';
import type { ArticleService } from '../src/article-service.js';
import type { Article } from '../src/article-model.js';
import type { RequestTrace } from '../src/request-context.js';
import { ARTICLE_SERVICE, CHECK_READY } from '../src/tokens.js';
import { testDependencies } from './module-fixture.js';

async function setup() {
  const row: Article = { id: 'a_pipe', authorId: 'u_demo', title: '標題', content: '本文', status: 'published', version: 1,
    createdAt: new Date('2026-01-01Z'), updatedAt: new Date('2026-01-01Z') };
  const articles = {
    adminDetail: jest.fn<ArticleService['adminDetail']>(),
    create: jest.fn<ArticleService['create']>().mockResolvedValue(row),
    detail: jest.fn<ArticleService['detail']>().mockResolvedValue(row),
    list: jest.fn<ArticleService['list']>().mockResolvedValue({ data: [row], meta: { page: 1, pageSize: 20, total: 1 } }),
    change: jest.fn<ArticleService['change']>().mockResolvedValue(row),
  };
  const traces: RequestTrace[] = [];
  const server = await createArticleServer({ dependencies: testDependencies([
    { provide: ARTICLE_SERVICE, useValue: articles }, { provide: CHECK_READY, useValue: async () => {} },
  ]), onTrace: trace => traces.push(trace) });
  return { server, api: supertest(server), articles, traces };
}

test.each(['/api/articles', '/api/articles/preview'])('Pipe 在 %s handler 之前拒絕，不執行 Controller 或 Service', async path => {
  const { server, api, articles, traces } = await setup();
  try {
    const result = await api.post(path).send({ title: 123, content: 'x', SECRET_FIELD: 'SECRET_VALUE' }).expect(400);
    expect(result.body.error.code).toBe('VALIDATION_ERROR');
    expect(result.body.error.details).toContainEqual({ field: 'body.title', code: 'INVALID_VALUE', message: '欄位格式或內容不符合規則' });
    expect(result.body.error.details).toContainEqual({ field: 'body', code: 'UNKNOWN_FIELDS', message: '包含不允許的欄位' });
    expect(JSON.stringify(result.body)).not.toContain('SECRET');
    expect(result.body.requestId).toBe(result.headers['x-request-id']);
    expect(traces[0].steps).toContain('json:parsed');
    expect(traces[0].steps).toContain('nest:filter');
    expect(traces[0].steps).not.toContain('nest:controller');
    expect(articles.create).not.toHaveBeenCalled();
  } finally { await server.lifecycle.shutdown(); }
});

test('公開與管理列表把 Query Pipe 的數字與預設值傳給 Service', async () => {
  const { server, api, articles } = await setup();
  try {
    await api.get('/api/articles?page=2&pageSize=3').expect(200);
    await api.get('/api/me/articles').expect(200);
    expect(articles.list.mock.calls).toEqual([
      [{ page: 2, pageSize: 3 }, true], [{ page: 1, pageSize: 20 }, false, testActor],
    ]);
  } finally { await server.lifecycle.shutdown(); }
});

test('重複、空白、科學記號與未知 query 在進 Controller 前拒絕', async () => {
  const { server, api, articles, traces } = await setup();
  try {
    for (const query of ['page=1&page=2', 'page=', 'page=1e2', 'page=%202%20', 'pageSize=101', 'page[x]=1']) {
      const result = await api.get(`/api/articles?${query}`).expect(400);
      expect(result.body.error.code).toBe('VALIDATION_ERROR');
      expect(result.body.error.details.every((detail: { field: string }) => detail.field.startsWith('query'))).toBe(true);
    }
    expect(articles.list).not.toHaveBeenCalled();
    expect(traces.every(trace => !trace.steps.includes('nest:controller'))).toBe(true);
  } finally { await server.lifecycle.shutdown(); }
});

test('Param Pipe 使用完整 params；ID 沿用解碼後的不透明字串', async () => {
  const { server, api, articles } = await setup();
  try {
    await api.get('/api/articles/a%20demo').expect(200);
    await api.get('/api/me/articles/a%20demo').expect(200);
    expect(articles.detail.mock.calls).toEqual([['a demo', true], ['a demo', false, testActor]]);
  } finally { await server.lifecycle.shutdown(); }
});

test('PATCH 的 DTO 只包含提供的欄位，沒有用預設 title 覆蓋舊資料', async () => {
  const { server, api, articles, traces } = await setup();
  try {
    await api.patch('/api/articles/a_pipe').send({ content: ' 新內容 ', expectedVersion: 1 }).expect(200);
    expect(articles.change).toHaveBeenCalledWith('a_pipe', { content: '新內容', expectedVersion: 1 }, 'edit', testActor);
    expect(Object.hasOwn(articles.change.mock.calls[0][1], 'title')).toBe(false);
    for (const body of [{ expectedVersion: 1 }, { title: null, expectedVersion: 1 }, { title: '', expectedVersion: 1 }]) {
      await api.patch('/api/articles/a_pipe').send(body).expect(400);
    }
    expect(articles.change).toHaveBeenCalledTimes(1);
    expect(traces.slice(1).every(trace => !trace.steps.includes('nest:controller'))).toBe(true);
  } finally { await server.lifecycle.shutdown(); }
});

test.each(['edit', 'publish', 'archive'] as const)('%s 不把字串版本轉成數字，不呼叫 Service', async action => {
  const { server, api, articles, traces } = await setup();
  try {
    const pending = action === 'edit' ? api.patch('/api/articles/a_pipe') : api.post(`/api/articles/a_pipe/${action}`);
    const result = await pending.send({ ...(action === 'edit' ? { title: 'x' } : {}), expectedVersion: '1' }).expect(400);
    expect(result.body.error.details).toContainEqual({ field: 'body.expectedVersion', code: 'INVALID_VALUE', message: '欄位格式或內容不符合規則' });
    expect(articles.change).not.toHaveBeenCalled();
    expect(traces[0].steps).not.toContain('nest:controller');
  } finally { await server.lifecycle.shutdown(); }
});

test('只驗證原契約要求的來源；export 拒絕 query，單篇查詢仍忽略 query，實驗未掛入 API', async () => {
  const { server, api, articles, traces } = await setup();
  try {
    await api.get('/api/articles/a_pipe?unrelated=x').expect(200);
    expect(articles.detail).toHaveBeenCalledTimes(1);
    const result = await api.get('/api/articles/export?file=SECRET').expect(400);
    expect(result.body.error.details[0].field).toBe('query');
    expect(traces[1].steps).not.toContain('nest:controller');
    await api.post('/validation/unchecked').send({ title: 123 }).expect(404);
  } finally { await server.lifecycle.shutdown(); }
});
