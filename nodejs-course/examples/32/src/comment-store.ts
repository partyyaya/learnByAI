import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import { databaseSchema } from './database.js';
import { Prisma } from './generated/prisma/client.js';
import type { Actor } from './auth-model.js';
import { HttpError } from './http.js';
import type { Pagination } from './schemas.js';
export function createCommentStore(db: Database) {
  // 唯一動態 identifier 來自 createDatabase 已驗證的 schema，不接受 HTTP 輸入。
  const articleTable = Prisma.raw(`"${databaseSchema(db)}"."Article"`);
  const missing = () => new HttpError(404, 'NOT_FOUND', '找不到資料');
  const fields = { id: true, articleId: true, authorId: true, content: true, createdAt: true } as const;
  return {
    list(articleId: string, query: Pagination) {
      return db.$transaction(async tx => {
        const article = await tx.article.findUnique({ where: { id: articleId }, select: { status: true } });
        if (!article || article.status !== 'published') throw missing();
        const where = { articleId };
        const data = await tx.comment.findMany({ where, select: fields, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize });
        const total = await tx.comment.count({ where }); return { data, meta: { ...query, total } };
      }, { isolationLevel: 'RepeatableRead' });
    },
    create(articleId: string, content: string, actor: Actor) {
      return db.$transaction(async tx => {
        // 與既有 archive 的 UPDATE 競爭同一 row lock：在鎖內確認狀態再 INSERT。
        const rows = await tx.$queryRaw<{ id: string; status: string }[]>(Prisma.sql`SELECT "id", "status" FROM ${articleTable} WHERE "id" = ${articleId} FOR UPDATE`);
        if (!rows[0] || rows[0].status !== 'published') throw missing();
        const data = await tx.comment.create({ data: { id: `c_${randomUUID()}`, articleId, authorId: actor.id, content }, select: fields });
        return { data };
      }, { isolationLevel: 'ReadCommitted' });
    },
    async remove(id: string, actor: Actor) {
      const comment = await db.comment.findUnique({ where: { id }, select: { authorId: true } });
      if (!comment) throw missing();
      if (actor.id !== comment.authorId && actor.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', '沒有刪除留言的權限');
      const result = await db.comment.deleteMany({ where: { id, authorId: comment.authorId } });
      if (result.count !== 1) throw missing();
    },
    audits(articleId: string, query: Pagination) {
      return db.$transaction(async tx => {
        if (!await tx.article.findUnique({ where: { id: articleId }, select: { id: true } })) throw missing();
        const where = { articleId };
        const data = await tx.articleStatusAudit.findMany({ where, select: { id: true, articleId: true, actorId: true, action: true, fromStatus: true, toStatus: true, fromVersion: true, toVersion: true, createdAt: true }, orderBy: [{ toVersion: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize });
        return { data, meta: { ...query, total: await tx.articleStatusAudit.count({ where }) } };
      }, { isolationLevel: 'RepeatableRead' });
    },
  };
}
export type CommentStore = ReturnType<typeof createCommentStore>;
