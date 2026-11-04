import type { Database } from './database.js';
import type { ArticleScope } from './article-model.js';
import type { ArticleRepository } from './article-repository.js';

export function createPrismaArticleRepository(db: Database): ArticleRepository {
  const whereFor = (scope: ArticleScope) => scope.kind === 'public'
    ? { status: 'published' as const } : { authorId: scope.authorId };
  return {
    async list({ page, pageSize }, scope) {
      const where = whereFor(scope);
      const [data, total] = await db.$transaction([
        db.article.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
        db.article.count({ where }),
      ], { isolationLevel: 'RepeatableRead' });
      return { data, meta: { page, pageSize, total } };
    },
    findVisible: (id, scope) => db.article.findFirst({ where: { id, ...whereFor(scope) } }),
    create: input => db.article.create({ data: {
      id: input.id, authorId: input.authorId, title: input.title, content: input.content,
    } }),
    withTransaction: work => db.$transaction(async tx => work({
      findById: id => tx.article.findUnique({ where: { id } }),
      async updateIfCurrent(current, changes) {
        const result = await tx.article.updateMany({
          where: { id: current.id, version: current.version, status: current.status },
          data: {
            ...(changes.title !== undefined ? { title: changes.title } : {}),
            ...(changes.content !== undefined ? { content: changes.content } : {}),
            status: changes.status, version: { increment: 1 },
          },
        });
        if (result.count !== 1) return null;
        return tx.article.findUniqueOrThrow({ where: { id: current.id } });
      },
    })),
  };
}
