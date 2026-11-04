import { expect, jest, test } from '@jest/globals';
import supertest from 'supertest';
import type { Article } from '../src/article-model.js';
import { ArticleError } from '../src/article-model.js';
import type { ArticleService } from '../src/article-service.js';
import type { RequestTrace } from '../src/request-context.js';
import { createArticleServer } from '../src/server.js';
import { ARTICLE_SERVICE, CHECK_READY } from '../src/tokens.js';

async function setup(title = 'Nest 查詢') {
  const article: Article = { id: 'a_nest', authorId: 'u_demo', title, content: '本文', status: 'published', version: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z') };
  const articles = {
    create: jest.fn<ArticleService['create']>().mockResolvedValue(article),
    detail: jest.fn<ArticleService['detail']>().mockResolvedValue(article),
    list: jest.fn<ArticleService['list']>().mockResolvedValue({ data: [article], meta: { page: 1, pageSize: 20, total: 1 } }),
    change: jest.fn<ArticleService['change']>().mockResolvedValue(article),
  };
  const traces: RequestTrace[] = [];
  const closed = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const server = await createArticleServer({ providers: [{ provide: ARTICLE_SERVICE, useValue: articles }, { provide: CHECK_READY, useValue: async () => {} }], closeResources: closed,
    onTrace: trace => traces.push(trace) });
  return { server, articles, traces, closed };
}

test.each(['get', 'head'] as const)('%s 公開單篇確實經過 Nest，沿用欄位、日期及 request ID', async method => {
  const { server, articles, traces } = await setup();
  try {
    const result = await supertest(server)[method]('/api/articles/a_nest').expect(200);
    expect(articles.detail).toHaveBeenCalledWith('a_nest', true);
    expect(result.headers['x-request-id']).toBe(traces[0].requestId);
    expect(result.headers['x-powered-by']).toBeUndefined();
    expect(result.headers.etag).toBeUndefined();
    if (method === 'get') expect(result.body.data).toMatchObject({ title: 'Nest 查詢', createdAt: '2026-01-01T00:00:00.000Z' });
    else { expect(result.text).toBeUndefined(); expect(Number(result.headers['content-length'])).toBeGreaterThan(0); }
    expect(traces[0].steps).toEqual(['request', 'accept', 'router:articles', 'validate:params', 'handoff:nest', 'nest:controller', 'nest:return', 'response:finish']);
  } finally { await server.lifecycle.shutdown(); }
});

test('無效路徑編碼在 Nest Controller 前拒絕；不呼叫 Service', async () => {
  const { server, articles, traces } = await setup();
  try {
    const response = await supertest(server).get('/api/articles/%E0%A4%A').expect(400);
    expect(response.body.error.code).toBe('INVALID_URL');
    expect(articles.detail).not.toHaveBeenCalled();
    expect(traces[0].steps).not.toContain('nest:controller');
    expect(traces[0].steps).not.toContain('nest:filter');
  } finally { await server.lifecycle.shutdown(); }
});

test.each([
  [new ArticleError('NOT_FOUND'), 404, 'NOT_FOUND'],
  [new Error('SECRET SQL connection'), 500, 'INTERNAL_ERROR'],
] as const)('Nest Filter 保留錯誤 %s 的 HTTP %s／%s', async (error, status, code) => {
  const { server, articles, traces } = await setup();
  articles.detail.mockRejectedValue(error);
  try {
    const response = await supertest(server).get('/api/articles/a_nest').expect(status);
    expect(response.body.error.code).toBe(code);
    expect(response.body.error.details).toEqual([]);
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
    expect(JSON.stringify(response.body)).not.toContain('SECRET');
    expect(traces[0].steps).toContain('nest:controller');
    expect(traces[0].steps).toContain('nest:filter');
    expect(traces[0].steps).not.toContain('nest:return');
  } finally { await server.lifecycle.shutdown(); }
});

test('寫入與管理查詢仍屬 Express，405 不誤進 Nest；未知路由經 Nest Filter', async () => {
  const { server, articles, traces } = await setup();
  try {
    await supertest(server).patch('/api/articles/a_nest').send({ title: 'x', expectedVersion: 1 }).expect(200);
    await supertest(server).get('/api/me/articles/a_nest').expect(200);
    expect(articles.detail).toHaveBeenCalledWith('a_nest', false);
    await supertest(server).delete('/api/articles/a_nest').expect(405).expect('Allow', 'GET, HEAD, PATCH');
    expect(traces.every(trace => !trace.steps.includes('nest:controller'))).toBe(true);
    const missing = await supertest(server).get('/unknown').expect(404);
    expect(missing.body.error).toEqual({ code: 'NOT_FOUND', message: '找不到路由', details: [] });
    expect(traces.at(-1)?.steps).toContain('nest:filter');
  } finally { await server.lifecycle.shutdown(); }
});

test('兩個 Nest app 保持自己的 useValue Provider，關閉其中一個不影響另一個', async () => {
  const first = await setup('first');
  try {
    const second = await setup('second');
    try {
      for (const instance of [first, second]) {
        const response = await supertest(instance.server).get('/api/articles/a_nest').expect(200);
        expect(response.body.data.title).toBe(instance === first ? 'first' : 'second');
      }
      await first.server.lifecycle.shutdown();
      expect(first.closed).toHaveBeenCalledTimes(1);
      expect(second.closed).not.toHaveBeenCalled();
      const response = await supertest(second.server).get('/api/articles/a_nest').expect(200);
      expect(response.body.data.title).toBe('second');
    } finally { await second.server.lifecycle.shutdown(); }
  } finally { await first.server.lifecycle.shutdown(); }
});
