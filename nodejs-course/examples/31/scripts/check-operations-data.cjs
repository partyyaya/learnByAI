const assert = require('node:assert/strict');
const fs = require('node:fs');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createDatabase } = require('../dist/database.js');
const { databaseUrlFrom } = require('../dist/runtime-config.js');
const { validateDrillPlan, restoreUrl } = require('../dist/operations-policy.js');
const { createArticleApplication } = require('../dist/application.js');
(async () => {
  const mode = process.argv[2] ?? 'restore'; assert.ok(['snapshot', 'restore'].includes(mode));
  const plan = validateDrillPlan(JSON.parse(fs.readFileSync('/evidence/plan.json')));
  const sourceUrl = databaseUrlFrom(process.env);
  const targetUrl = restoreUrl(sourceUrl, plan); // Always validate source identity, even for snapshot.
  const database = createDatabase(mode === 'restore' ? targetUrl : sourceUrl); let application;
  try {
    const counts = { outbox: await database.outboxEvent.count(), notifications: await database.notification.count(), users: await database.user.count(), articles: await database.article.count(), comments: await database.comment.count(), sessions: await database.session.count(), audits: await database.articleStatusAudit.count() };
    const history = await database.$queryRawUnsafe('SELECT id, migration_name, checksum, finished_at, rolled_back_at, applied_steps_count FROM "public"."_prisma_migrations" ORDER BY migration_name, id');
    const migrations = JSON.parse(JSON.stringify(history));
    counts.migrations = migrations.filter(row => row.finished_at !== null && row.rolled_back_at === null).length;
    const proof = JSON.parse(fs.readFileSync('/evidence/production.json'));
    const session = JSON.parse(fs.readFileSync('/evidence/session.json'));
    const article = await database.article.findUniqueOrThrow({ where: { id: proof.article.id } });
    const comment = await database.comment.findUniqueOrThrow({ where: { id: proof.comment.id } });
    assert.deepEqual(JSON.parse(JSON.stringify(article)), proof.article); assert.deepEqual(JSON.parse(JSON.stringify(comment)), proof.comment);
    const token = session.cookie.split('=')[1];
    const stored = await database.session.findUniqueOrThrow({ where: { tokenHash: createHash('sha256').update(token).digest('hex') } });
    assert.equal(stored.revokedAt, null); assert.ok(stored.expiresAt.getTime() > Date.now()); assert.equal(stored.userId, session.userId);
    if (mode === 'snapshot') {
      fs.writeFileSync('/evidence/source.json', JSON.stringify({ counts, migrations, articleId: article.id, commentId: comment.id })+'\n');
    } else {
      const expected = JSON.parse(fs.readFileSync('/evidence/source.json')); assert.deepEqual(counts, expected.counts); assert.deepEqual(migrations, expected.migrations);
      application = await createArticleApplication({ database, auth: { origin: 'https://localhost:34431' } });
      application.listen(0, '127.0.0.1'); await once(application, 'listening');
      const origin = `http://127.0.0.1:${application.address().port}`;
      for (const [path, cookie] of [['/health/ready'], ['/api/articles/' + article.id], ['/api/articles/' + article.id + '/comments'], ['/api/auth/me', session.cookie], ['/api/me/notifications', session.cookie]]) {
        const result = await fetch(origin + path, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(5000) }); assert.equal(result.status, 200);
        const body = await result.json(); if (path === '/api/auth/me') assert.equal(body.data.id, session.userId);
      }
      fs.writeFileSync('/evidence/result.json', JSON.stringify({ database: plan.restoreDatabase, counts, articleId: article.id, commentId: comment.id, migrationHistoryMatched: true, articleRestored: true, commentRestored: true, sessionResolved: true, applicationReady: true })+'\n');
    }
    console.log(`PASS ${mode}: validated counts, article/comment contents, migration history and fixed-lifetime Session`);
  } finally { if (application) await application.lifecycle.shutdown(); else await database.$disconnect(); }
})().catch(() => { console.error('RESTORE_DATA_CHECK_FAILED'); process.exitCode = 1; });
