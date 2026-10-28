import { expect, jest, test } from '@jest/globals';
import { once } from 'node:events';
import { request } from 'node:http';
import { setImmediate as immediate } from 'node:timers/promises';
import supertest from 'supertest';
import { ArticleError, type Article } from '../src/article-model.js';
import type { ArticleService } from '../src/article-service.js';
import { createArticleServer } from '../src/server.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const article: Article = { id: 'a_http', authorId: 'u_demo', title: '標題', content: '本文', status: 'draft', version: 1,
    createdAt: new Date('2026-01-01Z'), updatedAt: new Date('2026-01-01Z') };
  const articles = {
    create: jest.fn<ArticleService['create']>().mockResolvedValue(article),
    detail: jest.fn<ArticleService['detail']>().mockResolvedValue(article),
    list: jest.fn<ArticleService['list']>().mockResolvedValue({ data: [article], meta: { page: 1, pageSize: 20, total: 1 } }),
    change: jest.fn<ArticleService['change']>().mockResolvedValue(article),
  };
  const checkReady = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const closeResources = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const server = createArticleServer({ articles, checkReady, closeResources });
  return { article, articles, checkReady, closeResources, server };
}

test('驗證後的 body 才交給 Service，Controller 序列化日期、201 與 Location', async () => {
  const { server, articles } = setup();
  try {
    const result = await supertest(server).post('/api/articles').send({ title: ' 修剪 ', content: ' 本文 ' }).expect(201);
    expect(articles.create).toHaveBeenCalledWith({ title: '修剪', content: '本文' });
    expect(result.headers.location).toBe('/api/me/articles/a_http');
    expect(result.body.data.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.body.data.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  } finally { await server.lifecycle.shutdown(); }
});

test('非白名單欄位與超過 16 KiB 的 body 在 Service 前拒絕，preview 不寫入', async () => {
  const { server, articles } = setup();
  try {
    await supertest(server).post('/api/articles').send({ title: 'x', content: 'y', authorId: 'other' }).expect(400);
    const oversized = await supertest(server).post('/api/articles').send({ title: 'x', content: 'x'.repeat(17 * 1024) }).expect(413);
    expect(oversized.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    await supertest(server).post('/api/articles/preview').send({ title: 'x', content: 'y' }).expect(200);
    expect(articles.create).not.toHaveBeenCalled();
  } finally { await server.lifecycle.shutdown(); }
});

test.each([
  ['NOT_FOUND', 404], ['VERSION_CONFLICT', 409], ['INVALID_STATE', 409], ['VERSION_LIMIT', 409],
] as const)('業務錯誤 %s 在 HTTP 邊界映射為 %s', async (code, status) => {
  const { server, articles } = setup(); articles.detail.mockRejectedValue(new ArticleError(code));
  try {
    const result = await supertest(server).get('/api/articles/a_http').expect(status);
    expect(result.body.error).toEqual({ code, message: new ArticleError(code).message, details: [] });
    expect(result.body.requestId).toBe(result.headers['x-request-id']);
  } finally { await server.lifecycle.shutdown(); }
});

test('注入的依賴失敗：ready 503、未知 Service 錯誤 500 且不洩漏細節', async () => {
  const { server, articles, checkReady } = setup();
  checkReady.mockRejectedValue(new Error('SECRET connection')); articles.list.mockRejectedValue(new Error('SECRET SQL'));
  try {
    await supertest(server).get('/health/live').expect(200);
    expect((await supertest(server).get('/health/ready').expect(503)).body.error.code).toBe('NOT_READY');
    const result = await supertest(server).get('/api/articles').expect(500);
    expect(result.body.error).toEqual({ code: 'INTERNAL_ERROR', message: '內部錯誤', details: [] });
  } finally { await server.lifecycle.shutdown(); }
});

test('用戶端離線後仍等待 Service 工作，再關閉共享資源', async () => {
  const { server, articles, article, closeResources } = setup();
  const entered = deferred<void>(); const release = deferred<Article>();
  articles.detail.mockImplementation(async () => { entered.resolve(); return release.promise; });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  const req = request({ host: '127.0.0.1', port: address.port, path: '/api/articles/a_http', agent: false });
  req.on('error', () => {}); req.end();
  try {
    await entered.promise; req.destroy();
    const stopped = server.lifecycle.shutdown(); await immediate();
    expect(closeResources).not.toHaveBeenCalled();
    release.resolve(article); await stopped;
    expect(closeResources).toHaveBeenCalledTimes(1);
  } finally { req.destroy(); release.resolve(article); await server.lifecycle.shutdown(); }
});
