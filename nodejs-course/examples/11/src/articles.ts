import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';
import type { DraftInput, PatchInput, VersionInput, Pagination } from './schemas.js';
import type { Database } from './database.js';
import type { Article } from './generated/prisma/client.js';
export const demoAuthorId = 'u_demo';
const present = (article: Article) => ({ ...article, createdAt: article.createdAt.toISOString(), updatedAt: article.updatedAt.toISOString() });

export function createArticles(db: Database) {
  async function list({ page, pageSize }: Pagination, publicOnly: boolean) {
    const where = publicOnly ? { status: 'published' as const } : { authorId: demoAuthorId };
    const [rows, total] = await db.$transaction([
      db.article.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
      db.article.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    return { data: rows.map(present), meta: { page, pageSize, total } };
  }
  async function detail(id: string, publicOnly: boolean) {
    const article = await db.article.findFirst({ where: { id, ...(publicOnly ? { status: 'published' } : { authorId: demoAuthorId }) } });
    if (!article) throw new HttpError(404, 'NOT_FOUND', '找不到文章');
    return present(article);
  }
  async function create(input: DraftInput) {
    return present(await db.article.create({ data: { id: `a_${randomUUID()}`, authorId: demoAuthorId, title: input.title, content: input.content } }));
  }
  async function change(id: string, input: PatchInput | VersionInput, action: 'edit' | 'publish' | 'archive') {
    return db.$transaction(async tx => {
      const article = await tx.article.findUnique({ where: { id } });
      if (!article) throw new HttpError(404, 'NOT_FOUND', '找不到文章');
      if (article.version !== input.expectedVersion) throw new HttpError(409, 'VERSION_CONFLICT', '文章已更新，請重新讀取');
      if (article.status === 'archived' || (action === 'publish' && article.status !== 'draft')) throw new HttpError(409, 'INVALID_STATE', '目前狀態不允許此操作');
      if (article.version === 2147483647) throw new HttpError(409, 'VERSION_LIMIT', '版本已達欄位上限');
      // SELECT 只用於判斷錯誤；真正防止覆蓋的是 UPDATE 的版本與狀態條件。
      const result = await tx.article.updateMany({
        where: { id, version: input.expectedVersion, status: article.status },
        data: {
          ...(action === 'edit' && 'title' in input ? { title: input.title } : {}),
          ...(action === 'edit' && 'content' in input ? { content: input.content } : {}),
          status: action === 'edit' ? article.status : action === 'publish' ? 'published' : 'archived',
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) throw new HttpError(409, 'VERSION_CONFLICT', '文章已更新，請重新讀取');
      return present(await tx.article.findUniqueOrThrow({ where: { id } }));
    });
  }
  return { list, detail, create, change };
}
