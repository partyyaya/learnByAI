import { expect, test } from '@jest/globals';
import { databaseFixture } from './database-fixture.js';
import { seedDatabase } from '../src/seed-database.js';
test('從三份既有 migration 升級，保留文章、使用者、Session 與歷史，新增第四份 Comment', async () => {
  const storage = await databaseFixture(); const db = storage.connect();
  try {
    await seedDatabase(db);
    await db.session.create({ data: { tokenHash: 'a'.repeat(64), csrfToken: 'b'.repeat(43), userId: 'u_demo', expiresAt: new Date('2099-01-01Z') } });
    const before = { users: await db.user.findMany({ orderBy: { id: 'asc' } }), articles: await db.article.findMany({ orderBy: { id: 'asc' } }), sessions: await db.session.findMany() };
    // 只在自有測試 schema 準備前章狀態，並非部署回退指令。
    await db.$executeRawUnsafe(`DROP TABLE "${storage.schema}"."Comment"`);
    await db.$executeRawUnsafe(`DELETE FROM "${storage.schema}"."_prisma_migrations" WHERE migration_name = '202611030001_comments'`);
    await storage.deploy();
    expect(await db.comment.count()).toBe(0);
    expect(await db.user.findMany({ orderBy: { id: 'asc' } })).toEqual(before.users);
    expect(await db.article.findMany({ orderBy: { id: 'asc' } })).toEqual(before.articles);
    expect(await db.session.findMany()).toEqual(before.sessions);
    const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(`SELECT count(*) FROM "${storage.schema}"."_prisma_migrations" WHERE finished_at IS NOT NULL`);
    expect(Number(rows[0].count)).toBe(4);
  } finally { await db.$disconnect(); await storage.dispose(); }
}, 45000);
