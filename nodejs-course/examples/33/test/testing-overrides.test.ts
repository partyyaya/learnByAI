import 'reflect-metadata';
import { expect, jest, test } from '@jest/globals';
import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import raw from 'supertest';
import { createDatabase } from '../src/database.js';
import { createTestingApplication } from './testing-application.js';
import { authDouble } from './module-fixture.js';
import { testActor, testHeaders } from './authenticated-test-client.js';
import { ARTICLE_REPOSITORY, ARTICLE_SERVICE, DATABASE, AUTH_SERVICE, CHECK_READY } from '../src/tokens.js';
import type { Article } from '../src/article-model.js';
import type { ArticleRepository } from '../src/article-repository.js';
import { ArticlesController } from '../src/articles.controller.js';
import type { ErrorReport } from '../src/errors.js';

const row: Article = { id: 'a_testing', authorId: 'u_demo', title: '測試替身', content: '本文', status: 'published', version: 1,
  createdAt: new Date('2026-01-01Z'), updatedAt: new Date('2026-01-01Z') };
function repositoryDouble() {
  return {
    list: jest.fn<ArticleRepository['list']>().mockResolvedValue({ data: [row], meta: { page: 1, pageSize: 20, total: 1 } }),
    findVisible: jest.fn<ArticleRepository['findVisible']>().mockResolvedValue(row),
    create: jest.fn<ArticleRepository['create']>().mockImplementation(async input => ({ ...row, ...input, status: 'draft' })),
    withTransaction: async () => { throw new Error('替身不實作資料庫交易'); },
  } satisfies ArticleRepository;
}
async function setup(options: { maxBodyBytes?: number; onError?: (report: ErrorReport) => void } = {}) {
  const database = createDatabase('postgresql://course:course_local@127.0.0.1:1/course_test');
  const connect = jest.spyOn(database, '$connect').mockRejectedValue(new Error('替身測試不得連 DB'));
  const disconnect = jest.spyOn(database, '$disconnect');
  const repository = repositoryDouble();
  const app = await createTestingApplication({ database, ...options }, builder => {
    builder.overrideProvider(DATABASE).useValue(database)
      .overrideProvider(ARTICLE_REPOSITORY).useValue(repository)
      .overrideProvider(AUTH_SERVICE).useValue(authDouble())
      .overrideProvider(CHECK_READY).useValue(async () => {});
  });
  return { ...app, database, repository, connect, disconnect };
}

test('覆寫正式模組的 DATABASE／Repository，真 Service 與 HTTP 查詢仍經完整組裝', async () => {
  const app = await setup();
  try {
    expect(app.context.get(DATABASE)).toBe(app.database);
    expect(app.context.get(ARTICLE_REPOSITORY)).toBe(app.repository);
    expect(app.context.get(ARTICLE_SERVICE)).toBe(app.context.get(ARTICLE_SERVICE));
    const result = await raw(app.server).get('/api/articles/a_testing').expect(200);
    expect(result.body.data.title).toBe(row.title);
    expect(app.repository.findVisible).toHaveBeenCalledWith(row.id, { kind: 'public' });
    expect(app.connect).not.toHaveBeenCalled();
    await raw(app.server).get('/health/ready').expect(200); // 明確覆寫的 readiness，不能作 DB 證據。
  } finally { await app.server.lifecycle.shutdown(); await app.server.lifecycle.shutdown(); }
  expect(app.disconnect).toHaveBeenCalledTimes(1);
});
test('替身認證仍經真正 Guard／Pipe：未登入、CSRF、未知欄位均不呼叫 create', async () => {
  const app = await setup();
  try {
    await raw(app.server).post('/api/articles').send({ title: 'x', content: 'y' }).expect(401);
    await raw(app.server).post('/api/articles').set(testHeaders).set('X-CSRF-Token', 'x'.repeat(43)).send({ title: 'x', content: 'y' }).expect(403);
    await raw(app.server).post('/api/articles').set(testHeaders).send({ title: 'x', content: 'y', authorId: 'u_other' }).expect(400);
    expect(app.repository.create).not.toHaveBeenCalled();
    const result = await raw(app.server).post('/api/articles').set(testHeaders).send({ title: ' 修剪 ', content: ' 本文 ' }).expect(201);
    expect(app.repository.create).toHaveBeenCalledWith({ id: expect.stringMatching(/^a_/), authorId: 'u_demo', title: '修剪', content: '本文' });
    expect(result.headers.location).toBe(`/api/me/articles/${result.body.data.id}`);
  } finally { await app.server.lifecycle.shutdown(); }
});
test('query 的 Pipe 與資料範圍透過真 Service 傳入 Repository', async () => {
  const app = await setup();
  try {
    await raw(app.server).get('/api/articles?q=%20Node%20&sort=oldest&page=02&pageSize=1').expect(200);
    expect(app.repository.list).toHaveBeenCalledWith({ page: 2, pageSize: 1, q: 'Node', sort: 'oldest' }, { kind: 'public' });
    await raw(app.server).get('/api/me/articles?status=draft').set(testHeaders).expect(200);
    expect(app.repository.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, status: 'draft' }, { kind: 'author', authorId: 'u_demo' });
  } finally { await app.server.lifecycle.shutdown(); }
});
test('TestingModule 沿用 bodyParser:false、既有 parser 與 adapter，而非測試專用寬鬆 HTTP app', async () => {
  const app = await setup({ maxBodyBytes: 256 });
  try {
    await raw(app.server).post('/api/articles/preview').send({ title: 'x', content: 'x'.repeat(300) }).expect(413);
    await raw(app.server).post('/api/articles/preview').type('text/plain').send('x').expect(415);
    const invalid = await raw(app.server).post('/api/articles/preview').type('application/json').send('{broken').expect(400);
    expect(invalid.body.error.code).toBe('INVALID_JSON');
    await raw(app.server).post('/api/articles/preview').send({ title: 'x', content: 'y' }).expect(200);
  } finally { await app.server.lifecycle.shutdown(); }
});
test('真 presenter 過濾替身多出的欄位，未知錯誤仍走 DI reporter 與安全 Filter', async () => {
  const reports: ErrorReport[] = []; const app = await setup({ onError: report => reports.push(report) });
  try {
    const internal = { ...row, passwordHash: 'SECRET', author: { tokenHash: 'SECRET' } };
    app.repository.findVisible.mockResolvedValue(internal);
    const ok = await raw(app.server).get('/api/articles/a_testing').expect(200);
    expect(ok.text).not.toContain('SECRET'); expect(ok.body.data).not.toHaveProperty('author');
    app.repository.findVisible.mockRejectedValue(new Error('SECRET SQL'));
    const failure = await raw(app.server).get('/api/articles/a_testing').expect(500);
    expect(failure.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '內部錯誤', details: [] }, requestId: failure.headers['x-request-id'] });
    expect(reports).toEqual([expect.objectContaining({ status: 500, code: 'INTERNAL_ERROR', phase: 'before-response' })]);
  } finally { await app.server.lifecycle.shutdown(); }
});
test('直接呼叫 Controller 不執行 decorator 的 Pipe／Guard／presenter，不能當作 HTTP 驗收', async () => {
  const app = await setup();
  try {
    const controller = app.context.get(ArticlesController);
    const res = { locals: { steps: [] }, status: jest.fn(), location: jest.fn() } as unknown as Response;
    const result = await controller.create({ title: '   ', content: ' ' }, testActor, res);
    expect(result.title).toBe('   '); expect(result).not.toHaveProperty('data');
    expect(app.repository.create).toHaveBeenCalledTimes(1);
    await raw(app.server).post('/api/articles').set(testHeaders).send({ title: '   ', content: ' ' }).expect(400);
    expect(app.repository.create).toHaveBeenCalledTimes(1);
  } finally { await app.server.lifecycle.shutdown(); }
});
test('只覆寫 Repository 未移除 async DATABASE：TestingModule 初始化失敗仍釋放 client', async () => {
  const database = createDatabase('postgresql://course:course_local@127.0.0.1:1/course_test');
  const failure = new Error('expected init failure');
  const connect = jest.spyOn(database, '$connect').mockRejectedValue(failure);
  const disconnect = jest.spyOn(database, '$disconnect');
  await expect(createTestingApplication({ database }, builder => builder.overrideProvider(ARTICLE_REPOSITORY).useValue(repositoryDouble())))
    .rejects.toBe(failure);
  expect(connect).toHaveBeenCalledTimes(1); expect(disconnect).toHaveBeenCalledTimes(1);
});
test('compile 建立依賴；init 才執行初始化 hook，close 釋放容器資源', async () => {
  const events: string[] = [];
  @Injectable() class Probe implements OnModuleInit, OnModuleDestroy {
    constructor() { events.push('construct'); }
    onModuleInit() { events.push('init'); }
    onModuleDestroy() { events.push('destroy'); }
  }
  const context = await Test.createTestingModule({ providers: [Probe] }).compile();
  expect(events).toEqual(['construct']);
  try { await context.init(); expect(events).toEqual(['construct', 'init']); }
  finally { await context.close(); }
  expect(events).toEqual(['construct', 'init', 'destroy']);
});
