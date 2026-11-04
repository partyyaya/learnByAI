import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './database.js';
import { databaseSchema } from './database.js';
import type { Article, ArticlePage } from './article-model.js';
import type { ArticleRepository } from './article-repository.js';
import { createPrismaArticleRepository } from './prisma-article-repository.js';
import type { PublicCache } from './public-cache.js';
const encodedArticle = z.object({ id: z.string(), authorId: z.string(), title: z.string(), content: z.string(), status: z.literal('published'), version: z.number().int().positive().max(2147483647), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decode = (value: unknown): Article => { const row = encodedArticle.parse(value); return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) }; };
export function createCachedArticleRepository(db: Database, cache: PublicCache): ArticleRepository {
  const base = createPrismaArticleRepository(db); const schema = databaseSchema(db);
  const singleKey = (id: string, version: number) => hash({ schema, kind: 'article', id, version });
  return {
    ...base,
    async findVisible(id, scope) {
      if (scope.kind !== 'public') { cache.bypass(); return base.findVisible(id, scope); }
      // PostgreSQL gates visibility and version on EVERY hit; Redis cannot resurrect an archived article.
      const current = await db.article.findFirst({ where: { id, status: 'published' }, select: { id: true, version: true } });
      if (!current) return null;
      return cache.remember(singleKey(id, current.version), () => base.findVisible(id, scope), value => {
        const row = decode(value); if (row.id !== id || row.version !== current.version) throw new Error('cache version mismatch'); return row;
      });
    },
    async list(query, scope) {
      if (scope.kind !== 'public') { cache.bypass(); return base.list(query, scope); }
      const { page, pageSize, q, sort } = query;
      const where = { status: 'published' as const, ...(q !== undefined ? { title: { contains: q.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' as const } } : {}) };
      const direction = sort === 'oldest' ? 'asc' as const : 'desc' as const;
      const [rows, total] = await db.$transaction([
        db.article.findMany({ where, select: { id: true, version: true }, orderBy: [{ createdAt: direction }, { id: direction }], skip: (page-1)*pageSize, take: pageSize }),
        db.article.count({ where }),
      ], { isolationLevel: 'RepeatableRead' });
      const fingerprint = hash({ schema, kind: 'page', query, rows, total });
      return cache.remember(fingerprint, () => base.list(query, scope), value => {
        const result = z.object({ data: z.array(encodedArticle), meta: z.object({ page: z.number(), pageSize: z.number(), total: z.number() }) }).parse(value);
        if (JSON.stringify(result.data.map(({ id, version }) => ({ id, version }))) !== JSON.stringify(rows) || result.meta.total !== total || result.meta.page !== page || result.meta.pageSize !== pageSize) throw new Error('cache page mismatch');
        return { data: result.data.map(decode), meta: result.meta } satisfies ArticlePage;
      });
    },
    async withTransaction(work) {
      const old = new Set<string>();
      const result = await base.withTransaction(tx => work({ ...tx, findById: async id => { const row = await tx.findById(id); if (row) old.add(singleKey(row.id, row.version)); return row; } }));
      // Commit comes first. Cache deletion failures do not turn a committed write into an HTTP failure.
      await Promise.all([...old].map(key => cache.invalidate(key))); return result;
    },
  };
}
