import { createDatabase, type Database } from './database.js';

export async function seedDatabase(db: Database) {
  await db.$transaction(async tx => {
    await tx.user.upsert({ where: { id: 'u_demo' }, create: { id: 'u_demo', displayName: '教學作者' }, update: {} });
    for (const [id, title, status, date] of [
      ['a_1', '認識 Node HTTP', 'published', '2026-01-03T00:00:00.000Z'],
      ['a_2', '請求與回應', 'published', '2026-01-02T00:00:00.000Z'],
      ['a_draft', '未公開草稿', 'draft', '2026-01-01T00:00:00.000Z'],
    ] as const) {
      await tx.article.upsert({ where: { id }, update: {}, create: { id, authorId: 'u_demo', title, content: '文章內容', status, createdAt: new Date(date), updatedAt: new Date(date) } });
    }
  });
}
if (require.main === module) {
  void (async () => {
    if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL');
    const db = createDatabase(process.env.DATABASE_URL);
    try { await seedDatabase(db); console.log('SEED complete：補上缺少的教學資料，不覆寫已有文章'); }
    finally { await db.$disconnect(); }
  })().catch(() => { console.error('資料庫 seed 失敗，請確認設定與 migration'); process.exitCode = 1; });
}
