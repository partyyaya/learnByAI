import { randomUUID } from 'node:crypto';
import { ArticleError, type ArticleAction, type ArticleScope, type DraftInput, type ArticleListQuery, type PatchInput, type VersionInput } from './article-model.js';
import type { ArticleRepository } from './article-repository.js';
import type { Actor } from './auth-model.js';

export function createArticleService(repository: ArticleRepository) {
  function requireActor(actor: Actor | undefined): Actor {
    if (!actor) throw new ArticleError('UNAUTHENTICATED');
    return actor;
  }
  const scope = (publicOnly: boolean, actor?: Actor): ArticleScope => publicOnly
    ? { kind: 'public' } : { kind: 'author', authorId: requireActor(actor).id };
  async function list(pagination: ArticleListQuery, publicOnly: boolean, actor?: Actor) {
    return repository.list(pagination, scope(publicOnly, actor));
  }
  async function detail(id: string, publicOnly: boolean, actor?: Actor) {
    const article = await repository.findVisible(id, scope(publicOnly, actor));
    if (!article) throw new ArticleError('NOT_FOUND');
    return article;
  }
  async function create(input: DraftInput, actor: Actor) {
    return repository.create({ id: `a_${randomUUID()}`, authorId: requireActor(actor).id, title: input.title, content: input.content });
  }
  async function change(id: string, input: PatchInput | VersionInput, action: ArticleAction, actor: Actor) {
    const currentActor = requireActor(actor);
    return repository.withTransaction(async tx => {
      const article = await tx.findById(id);
      if (!article) throw new ArticleError('NOT_FOUND');
      // 在同一交易內先授權，再檢查版本／狀態，不能讓 Guard 的早期讀取代替此處。
      if (article.authorId !== currentActor.id && currentActor.role !== 'admin') throw new ArticleError('FORBIDDEN');
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
      if (action !== 'edit') {
        // 必須 await 同一個 tx；任一寫入失敗都讓 callback 拋錯並回滾。
        await tx.appendStatusAudit({
          id: `asa_${randomUUID()}`, articleId: article.id, actorId: currentActor.id,
          action, fromStatus: article.status, toStatus: updated.status,
          fromVersion: article.version, toVersion: updated.version,
        });
      }
      return updated;
    });
  }
  async function adminDetail(id: string, actor: Actor) {
    if (requireActor(actor).role !== 'admin') throw new ArticleError('FORBIDDEN');
    const article = await repository.findVisible(id, { kind: 'all' });
    if (!article) throw new ArticleError('NOT_FOUND');
    return article;
  }
  return { list, detail, create, change, adminDetail };
}
export type ArticleService = ReturnType<typeof createArticleService>;
