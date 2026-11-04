import { createDatabase, type Database } from './database.js';
import { hashPassword } from './password.js';

export const demoAccounts = [
  { id: 'u_demo', email: 'alice@example.test', displayName: 'Alice', role: 'member' as const, password: 'Alice-course-18!' },
  { id: 'u_bob', email: 'bob@example.test', displayName: 'Bob', role: 'member' as const, password: 'Bob-course-18!!' },
  { id: 'u_admin', email: 'admin@example.test', displayName: '管理員', role: 'admin' as const, password: 'Admin-course-18!' },
];
// 每個程序只建立一次示範 hash；每位使用者仍有自己的 salt。不要改寫已存在的憑證。
let hashes: Promise<string[]> | undefined;
async function demoHashes() {
  hashes ??= (async () => { const values: string[] = []; for (const user of demoAccounts) values.push(await hashPassword(user.password)); return values; })();
  return hashes;
}

export async function seedDatabase(db: Database) {
  const passwords = await demoHashes();
  await db.$transaction(async tx => {
    for (const [index, { password: _password, ...user }] of demoAccounts.entries()) {
      await tx.user.upsert({ where: { id: user.id }, create: { ...user, passwordHash: passwords[index] }, update: {} });
    }
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
    if (process.env.DEMO_AUTH_SEED !== '1') throw new Error('示範認證 seed 必須明確設定 DEMO_AUTH_SEED=1');
    if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL');
    const db = createDatabase(process.env.DATABASE_URL);
    try { await seedDatabase(db); console.log('SEED complete：補上缺少的教學資料，不覆寫已有文章'); }
    finally { await db.$disconnect(); }
  })().catch(() => { console.error('資料庫 seed 失敗，請確認設定與 migration'); process.exitCode = 1; });
}
