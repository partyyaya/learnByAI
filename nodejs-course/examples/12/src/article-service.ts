import { randomUUID } from 'node:crypto';
import { ArticleError, type ArticleAction, type ArticleScope, type DraftInput, type Pagination, type PatchInput, type VersionInput } from './article-model.js';
import type { ArticleRepository } from './article-repository.js';

export const demoAuthorId = 'u_demo';
export function createArticleService(repository: ArticleRepository) {
  const scope = (publicOnly: boolean): ArticleScope => publicOnly
    ? { kind: 'public' } : { kind: 'author', authorId: demoAuthorId };
  async function list(pagination: Pagination, publicOnly: boolean) {
    return repository.list(pagination, scope(publicOnly));
  }
  async function detail(id: string, publicOnly: boolean) {
    const article = await repository.findVisible(id, scope(publicOnly));
    if (!article) throw new ArticleError('NOT_FOUND');
    return article;
  }
  async function create(input: DraftInput) {
    return repository.create({ id: `a_${randomUUID()}`, authorId: demoAuthorId, title: input.title, content: input.content });
  }
  async function change(id: string, input: PatchInput | VersionInput, action: ArticleAction) {
    return repository.withTransaction(async tx => {
      const article = await tx.findById(id);
      if (!article) throw new ArticleError('NOT_FOUND');
      if (article.version !== input.expectedVersion) throw new ArticleError('VERSION_CONFLICT');
      if (article.status === 'archived' || (action === 'publish' && article.status !== 'draft')) throw new ArticleError('INVALID_STATE');
      if (article.version === 2147483647) throw new ArticleError('VERSION_LIMIT');
      const updated = await tx.updateIfCurrent(article, {
        ...(action === 'edit' && 'title' in input ? { title: input.title } : {}),
        ...(action === 'edit' && 'content' in input ? { content: input.content } : {}),
        status: action === 'edit' ? article.status : action === 'publish' ? 'published' : 'archived',
      });
      // SELECT 通過後仍可能被另一請求搶先更新。
      if (!updated) throw new ArticleError('VERSION_CONFLICT');
      return updated;
    });
  }
  return { list, detail, create, change };
}
export type ArticleService = ReturnType<typeof createArticleService>;
