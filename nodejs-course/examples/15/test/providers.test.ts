import 'reflect-metadata';
import { expect, jest, test } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { createServer } from 'node:http';
import { setImmediate as immediate } from 'node:timers/promises';
import supertest from 'supertest';
import type { Article } from '../src/article-model.js';
import type { ArticleRepository, ArticleTransaction } from '../src/article-repository.js';
import type { ArticleService } from '../src/article-service.js';
import { createDatabase } from '../src/database.js';
import { createShutdown } from '../src/shutdown.js';
import { createArticleProviders, articleServiceProvider } from '../src/article.providers.js';
import { ArticleQueryModule } from '../src/article-query.module.js';
import { createArticleApplication } from '../src/application.js';
import { createArticleServer } from '../src/server.js';
import { ARTICLE_REPOSITORY, ARTICLE_SERVICE, CHECK_READY, DATABASE, REQUEST_LIFECYCLE } from '../src/tokens.js';

const row: Article = {
  id: 'a_di', authorId: 'u_demo', title: '來自 Repository 替身', content: '本文', status: 'published', version: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
};
function repositoryDouble() {
  return {
    findVisible: jest.fn<ArticleRepository['findVisible']>().mockResolvedValue(row),
    list: jest.fn<ArticleRepository['list']>().mockResolvedValue({ data: [row], meta: { page: 1, pageSize: 20, total: 1 } }),
    create: jest.fn<ArticleRepository['create']>().mockResolvedValue(row),
    // 這套替身只測查詢依賴，若誤用交易應失敗，不假裝能保證提交或回滾。
    withTransaction: async <T>(_work: (tx: ArticleTransaction) => Promise<T>): Promise<T> => { throw new Error('此替身不實作交易'); },
  } satisfies ArticleRepository;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function disconnectedDatabase() {
  // 建立 client 不開連線；以下測試一律 mock $connect，不能存取任何真實資料庫。
  return createDatabase('postgresql://course:course_local@127.0.0.1:1/course_test');
}

test('useValue 保留物件身分；useFactory 注入 Repository，Service 為容器內 singleton', async () => {
  const repository = repositoryDouble();
  const context = await Test.createTestingModule({ providers: [
    { provide: ARTICLE_REPOSITORY, useValue: repository }, articleServiceProvider,
  ] }).compile();
  try {
    expect(context.get(ARTICLE_REPOSITORY)).toBe(repository);
    const service = context.get<ArticleService>(ARTICLE_SERVICE);
    expect(context.get(ARTICLE_SERVICE)).toBe(service);
    expect(await service.detail('a_di', true)).toBe(row);
    expect(repository.findVisible).toHaveBeenCalledWith('a_di', { kind: 'public' });
  } finally { await context.close(); }
});

test('同名 Symbol 不是同一個 token：依賴缺漏在 compile 階段被拒絕', async () => {
  await expect(Test.createTestingModule({ providers: [
    { provide: Symbol('ARTICLE_REPOSITORY'), useValue: repositoryDouble() }, articleServiceProvider,
  ] }).compile()).rejects.toThrow(/ARTICLE_REPOSITORY/);
});

test('TestingModule 覆寫 DATABASE 與 Repository：保留真正 Service，原連線 factory 不執行', async () => {
  const database = disconnectedDatabase();
  const connect = jest.spyOn(database, '$connect').mockRejectedValue(new Error('不應連線'));
  const repository = repositoryDouble();
  const lifecycle = createShutdown(createServer());
  try {
    const context = await Test.createTestingModule({ imports: [
      ArticleQueryModule.register(createArticleProviders(database), lifecycle),
    ] }).overrideProvider(DATABASE).useValue(database)
      .overrideProvider(ARTICLE_REPOSITORY).useValue(repository).compile();
    try {
      expect(connect).not.toHaveBeenCalled();
      expect(context.get(REQUEST_LIFECYCLE)).toBe(lifecycle);
      const service = context.get<ArticleService>(ARTICLE_SERVICE);
      expect(await service.detail('a_di', true)).toBe(row);
      repository.findVisible.mockResolvedValue(null);
      await expect(service.detail('missing', true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally { await context.close(); }
  } finally { await lifecycle.shutdown(); await database.$disconnect(); }
});

test('只覆寫 Repository 不會移除 DATABASE Provider 的非同步初始化', async () => {
  const database = disconnectedDatabase();
  const failure = new Error('database init still runs');
  const connect = jest.spyOn(database, '$connect').mockRejectedValue(failure);
  try {
    await expect(Test.createTestingModule({ providers: createArticleProviders(database) })
      .overrideProvider(ARTICLE_REPOSITORY).useValue(repositoryDouble()).compile()).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledTimes(1);
  } finally { await database.$disconnect(); }
});

test('async DATABASE 完成前 application 不會交出 Server；正常關閉只 disconnect 一次', async () => {
  const database = disconnectedDatabase(); const entered = deferred(); const release = deferred();
  jest.spyOn(database, '$connect').mockImplementation(async () => { entered.resolve(); await release.promise; });
  const disconnect = jest.spyOn(database, '$disconnect').mockResolvedValue(undefined);
  let delivered = false;
  const pending = createArticleApplication({ database }).then(server => { delivered = true; return server; });
  try {
    await entered.promise; await immediate();
    expect(delivered).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    release.resolve();
    await pending;
    expect(delivered).toBe(true);
  } finally {
    release.resolve();
    const server = await pending;
    await server.lifecycle.shutdown(); await server.lifecycle.shutdown();
  }
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('async Provider 失敗由 application 釋放已接手的 database，不回傳可用 Server', async () => {
  const database = disconnectedDatabase(); const failure = new Error('connect failed');
  jest.spyOn(database, '$connect').mockRejectedValue(failure);
  const disconnect = jest.spyOn(database, '$disconnect').mockResolvedValue(undefined);
  await expect(createArticleApplication({ database })).rejects.toBe(failure);
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('建立協調器失敗也釋放 database；尚未執行非同步 Provider', async () => {
  const database = disconnectedDatabase();
  const connect = jest.spyOn(database, '$connect').mockRejectedValue(new Error('不應呼叫'));
  const disconnect = jest.spyOn(database, '$disconnect').mockResolvedValue(undefined);
  await expect(createArticleApplication({ database, timeoutMs: 0 })).rejects.toThrow('關閉期限必須是正整數');
  expect(connect).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('替換 Repository 後，Nest 與舊 Express 查詢共用同一個 Service factory 結果', async () => {
  const repository = repositoryDouble();
  const factory = jest.fn((repo: ArticleRepository) => articleServiceProvider.useFactory(repo));
  const server = await createArticleServer({ providers: [
    { provide: ARTICLE_REPOSITORY, useValue: repository },
    { ...articleServiceProvider, useFactory: factory },
    { provide: CHECK_READY, useValue: async () => {} },
  ] });
  try {
    const api = supertest(server);
    expect((await api.get('/api/articles/a_di').expect(200)).body.data.title).toBe(row.title);
    expect((await api.get('/api/me/articles/a_di').expect(200)).body.data.title).toBe(row.title);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(repository.findVisible.mock.calls).toEqual([
      ['a_di', { kind: 'public' }], ['a_di', { kind: 'author', authorId: 'u_demo' }],
    ]);
  } finally { await server.lifecycle.shutdown(); }
});
