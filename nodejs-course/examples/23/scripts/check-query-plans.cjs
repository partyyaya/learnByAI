const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const { Pool } = require('pg');
const { databaseFixture } = require('../.test-dist/test/database-fixture.js');

// 只寫 course_test 的自有隨機 schema；不替開發 public 灌大量資料或移除索引。
(async () => {
  const fixture = await databaseFixture();
  const url = new URL(fixture.url); url.searchParams.delete('schema');
  const pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 2000 });
  let connection;
  try {
    connection = await pool.connect();
    await connection.query(`SET search_path TO "${fixture.schema}"`);
    await connection.query(`INSERT INTO "User" (id, "displayName") SELECT 'u_' || n, 'Lab ' || n FROM generate_series(0, 99) n`);
    await connection.query(`INSERT INTO "Article" (id, "authorId", title, content, status, "createdAt", "updatedAt")
      SELECT 'lab_' || lpad(n::text, 6, '0'), 'u_' || (n % 100),
        CASE WHEN n % 701 = 0 THEN 'needle ' ELSE 'article ' END || n,
        repeat('x', 100), CASE WHEN n % 5 = 0 THEN 'published'::"ArticleStatus" ELSE 'draft'::"ArticleStatus" END,
        '2026-01-01Z'::timestamptz + n * interval '1 second', '2026-01-01Z'::timestamptz
      FROM generate_series(1, 30000) n`);
    await connection.query('ANALYZE "Article"');
    async function explain(label, sql, parameters = []) {
      const result = await connection.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, parameters);
      const data = result.rows[0]['QUERY PLAN'][0];
      console.log(`${label}: ${JSON.stringify({ node: data.Plan['Node Type'], actualRows: data.Plan['Actual Rows'], executionMs: data['Execution Time'] })}`);
      return { label, sql, parameters, result: data };
    }
    // 與正式列表相同的條件／排序／offset 形狀；只投影 id，非精確 HTTP 延遲基準。
    const ordered = `SELECT id FROM "Article" WHERE status = 'published' ORDER BY "createdAt" DESC, id DESC LIMIT 20`;
    const results = [];
    results.push(await explain('indexed-first-page', ordered));
    results.push(await explain('indexed-deep-offset', `${ordered} OFFSET 5000`));
    results.push(await explain('exact-count', `SELECT count(*) FROM "Article" WHERE status = 'published'`));
    results.push(await explain('substring-search', `SELECT id FROM "Article" WHERE status = 'published' AND title ILIKE $1 ORDER BY "createdAt" DESC, id DESC LIMIT 20`, ['%needle%']));
    results.push(await explain('own-status', `SELECT id FROM "Article" WHERE "authorId" = $1 AND status = 'draft' ORDER BY "createdAt" DESC, id DESC LIMIT 20`, ['u_7']));
    await connection.query('DROP INDEX "Article_status_createdAt_id_idx"');
    results.push(await explain('without-status-index', ordered));
    // 不依賴機器速度、特定 plan 名稱或固定毫秒數，索引選擇由 PostgreSQL 決定。
    assert.equal(results[0].result.Plan['Actual Rows'], 20);
    assert.equal(results[1].result.Plan['Actual Rows'], 20);
    assert.equal(results[2].result.Plan['Actual Rows'], 1);
    await mkdir('.data', { recursive: true });
    await writeFile('.data/query-plans.json', JSON.stringify({ rows: 30000, articleProjection: 'id only', results }, null, 2) + '\n');
    console.log('PASS：六組 EXPLAIN 已存 .data/query-plans.json；沒有硬編碼效能門檻，隔離 schema 將清理。');
  } finally {
    try { connection?.release(); await pool.end(); }
    finally { await fixture.dispose(); }
  }
})().catch(() => { console.error('QUERY_LAB_FAILED：需先完成 npm test，並設定專用 TEST_DATABASE_URL'); process.exitCode = 1; });
