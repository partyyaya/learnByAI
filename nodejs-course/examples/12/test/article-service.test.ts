import { expect, jest, test } from '@jest/globals';
import { ArticleError, type Article } from '../src/article-model.js';
import type { ArticleRepository, ArticleTransaction } from '../src/article-repository.js';
import { createArticleService } from '../src/article-service.js';

const article = (overrides: Partial<Article> = {}): Article => ({
  id: 'a_test', authorId: 'u_demo', title: '標題', content: '內容', status: 'draft', version: 1,
  createdAt: new Date('2026-01-01Z'), updatedAt: new Date('2026-01-01Z'), ...overrides,
});
function setup(current: Article | null = article()) {
  const tx = {
    findById: jest.fn<ArticleTransaction['findById']>().mockResolvedValue(current),
    updateIfCurrent: jest.fn<ArticleTransaction['updateIfCurrent']>().mockImplementation(async (before, changes) =>
      ({ ...before, ...changes, version: before.version + 1 })),
  };
  const repository = {
    list: jest.fn<ArticleRepository['list']>().mockResolvedValue({ data: [], meta: { page: 1, pageSize: 20, total: 0 } }),
    findVisible: jest.fn<ArticleRepository['findVisible']>().mockResolvedValue(current),
    create: jest.fn<ArticleRepository['create']>().mockImplementation(async input => article(input)),
    // 僅執行 callback 的 stub；沒有模擬 SQL、鎖或回滾能力。
    withTransaction: async <T>(work: (transaction: ArticleTransaction) => Promise<T>): Promise<T> => work(tx),
  } satisfies ArticleRepository;
  return { tx, repository, service: createArticleService(repository) };
}

test('建立固定作者的草稿，不接受呼叫端夾帶的 authorId 或 status', async () => {
  const { service, repository } = setup();
  const input = { title: '草稿', content: '本文', authorId: 'other', status: 'published' };
  const result = await service.create(input);
  expect(repository.create).toHaveBeenCalledWith({ id: expect.stringMatching(/^a_/), authorId: 'u_demo', title: '草稿', content: '本文' });
  expect(result).toMatchObject({ status: 'draft', version: 1 });
});

test('公開與管理查詢使用不同範圍，空分頁維持原 metadata', async () => {
  const { service, repository } = setup();
  const pagination = { page: 1, pageSize: 20 };
  expect(await service.list(pagination, true)).toEqual({ data: [], meta: { ...pagination, total: 0 } });
  await service.list(pagination, false);
  await service.detail('a_test', true); await service.detail('a_test', false);
  expect(repository.list.mock.calls).toEqual([[pagination, { kind: 'public' }], [pagination, { kind: 'author', authorId: 'u_demo' }]]);
  expect(repository.findVisible.mock.calls).toEqual([['a_test', { kind: 'public' }], ['a_test', { kind: 'author', authorId: 'u_demo' }]]);
});

test('Repository 查無可見文章，Service 拋出沒有 HTTP status 的業務錯誤', async () => {
  const { service } = setup(null);
  await expect(service.detail('missing', true)).rejects.toEqual(new ArticleError('NOT_FOUND'));
  await expect(service.detail('missing', false)).rejects.not.toHaveProperty('status');
});

test.each([
  ['不存在', null, 1, 'edit', 'NOT_FOUND'],
  ['舊版本', article(), 2, 'edit', 'VERSION_CONFLICT'],
  ['超大舊版本', article(), Number.MAX_SAFE_INTEGER, 'edit', 'VERSION_CONFLICT'],
  ['封存後編輯', article({ status: 'archived' }), 1, 'edit', 'INVALID_STATE'],
  ['封存後發佈', article({ status: 'archived' }), 1, 'publish', 'INVALID_STATE'],
  ['重複封存', article({ status: 'archived' }), 1, 'archive', 'INVALID_STATE'],
  ['重複發佈', article({ status: 'published' }), 1, 'publish', 'INVALID_STATE'],
  ['版本上限', article({ version: 2147483647 }), 2147483647, 'edit', 'VERSION_LIMIT'],
  ['舊版本優先於狀態', article({ status: 'archived' }), 9, 'edit', 'VERSION_CONFLICT'],
] as const)('%s：拒絕時不呼叫寫入', async (_name, current, version, action, code) => {
  const { service, tx } = setup(current);
  await expect(service.change('a_test', { title: '修改', expectedVersion: version }, action)).rejects.toMatchObject({ code });
  expect(tx.updateIfCurrent).not.toHaveBeenCalled();
});

test.each([
  ['draft', 'edit', 'draft'], ['published', 'edit', 'published'],
  ['draft', 'publish', 'published'], ['draft', 'archive', 'archived'], ['published', 'archive', 'archived'],
] as const)('%s → %s：成功時保留未提供的欄位並遞增版本', async (status, action, nextStatus) => {
  const current = article({ status }); const { service, tx } = setup(current);
  const result = await service.change(current.id, { expectedVersion: 1, title: '修改' }, action);
  expect(result).toMatchObject({ status: nextStatus, version: 2, title: action === 'edit' ? '修改' : '標題', content: '內容' });
  expect(tx.updateIfCurrent).toHaveBeenCalledWith(current, { ...(action === 'edit' ? { title: '修改' } : {}), status: nextStatus });
});

test('SELECT 通過但條件 UPDATE 未匹配，仍回版本衝突', async () => {
  const { service, tx } = setup(); tx.updateIfCurrent.mockResolvedValue(null);
  await expect(service.change('a_test', { expectedVersion: 1 }, 'publish')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
});

test('未知資料存取失敗往外傳，不偽裝成找不到文章', async () => {
  const { service, repository } = setup(); const failure = new Error('database unavailable');
  repository.findVisible.mockRejectedValue(failure);
  await expect(service.detail('a_test', true)).rejects.toBe(failure);
});
