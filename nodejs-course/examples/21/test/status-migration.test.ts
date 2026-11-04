import { expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

test('從第 19 章 schema 升級保留既有資料，稽核表初始為空，SQL CHECK 確實拒絕非法紀錄', async () => {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error('必須設定 TEST_DATABASE_URL');
  const url = new URL(raw);
  if (url.pathname !== '/course_test') throw new Error('只接受 course_test');
  url.searchParams.delete('schema');
  const schema = `upgrade_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 2000 });
  const client = await pool.connect(); let owned = false;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`); owned = true;
    await client.query(`SET search_path TO "${schema}"`);
    for (const name of ['202610280001_init', '202610300001_sessions']) {
      await client.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
    }
    await client.query(`INSERT INTO "User" (id, "displayName", email, "passwordHash", role) VALUES ('legacy', '舊使用者', NULL, NULL, 'admin')`);
    await client.query(`INSERT INTO "Article" (id, "authorId", title, content, status, version, "createdAt", "updatedAt") VALUES ('old', 'legacy', '保留', '舊正文', 'published', 7, '2026-01-01Z', '2026-01-02Z')`);
    await client.query(`INSERT INTO "Session" ("tokenHash", "csrfToken", "userId", "expiresAt") VALUES ($1, $2, 'legacy', '2099-01-01Z')`, ['t'.repeat(64), 'c'.repeat(43)]);
    const before = await client.query('SELECT * FROM "Article"');
    await client.query(await readFile('prisma/migrations/202611020001_article_status_audit/migration.sql', 'utf8'));
    expect((await client.query('SELECT * FROM "Article"')).rows).toEqual(before.rows);
    expect((await client.query('SELECT * FROM "ArticleStatusAudit"')).rows).toEqual([]);
    expect((await client.query('SELECT role, email, "passwordHash" FROM "User"')).rows).toEqual([{ role: 'admin', email: null, passwordHash: null }]);
    expect((await client.query('SELECT COUNT(*)::int AS n FROM "Session"')).rows[0].n).toBe(1);
    // 每次失敗查詢使用 autocommit，不讓一個錯誤遮蔽後面的 CHECK 驗證。
    for (const [fromVersion, toVersion, action, fromStatus, toStatus, constraint] of [
      [0, 1, 'archive', 'published', 'archived', 'ArticleStatusAudit_version_check'],
      [7, 9, 'archive', 'published', 'archived', 'ArticleStatusAudit_version_check'],
      [2147483647, 2147483647, 'archive', 'published', 'archived', 'ArticleStatusAudit_version_check'],
      [7, 8, 'publish', 'published', 'published', 'ArticleStatusAudit_transition_check'],
      [7, 8, 'archive', 'archived', 'archived', 'ArticleStatusAudit_transition_check'],
    ]) {
      await expect(client.query(`INSERT INTO "ArticleStatusAudit" (id, "articleId", "actorId", action, "fromStatus", "toStatus", "fromVersion", "toVersion") VALUES ('bad', 'old', 'legacy', $1, $2, $3, $4, $5)`, [action, fromStatus, toStatus, fromVersion, toVersion]))
        .rejects.toMatchObject({ code: '23514', constraint });
    }
    expect((await client.query('SELECT COUNT(*)::int AS n FROM "ArticleStatusAudit"')).rows[0].n).toBe(0);
  } finally {
    try { if (owned) await client.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { client.release(); await pool.end(); }
  }
}, 45000);
