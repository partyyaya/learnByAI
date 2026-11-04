import { expect, test } from '@jest/globals';
import raw from 'supertest';
import { open } from 'node:fs/promises';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createObservability } from '../src/observability.js';
import { httpFixture, loginSession } from './http-fixture.js';
import { demoAccounts } from '../src/seed-database.js';
import { ARTICLE_REPOSITORY, DATABASE } from '../src/tokens.js';
import type { Database } from '../src/database.js';
import type { ArticleRepository } from '../src/article-repository.js';
import { createPrismaArticleRepository } from '../src/prisma-article-repository.js';

function capture() { const lines: string[] = []; return { lines, observation: createObservability(line => { lines.push(line); }) }; }
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('等待觀測事件逾期'); await delay(5); }
}
test('真 PostgreSQL 表不可讀：live 200、ready 503，恢復後 ready 200；不洩漏 driver 錯誤', async () => {
  const logs = capture(); const fixture = await httpFixture({ observability: logs.observation });
  try {
    await raw(fixture.server).get('/health/ready').expect(200);
    await fixture.database.$executeRawUnsafe(`ALTER TABLE "${fixture.schema}"."ArticleStatusAudit" RENAME TO "UnavailableAudit"`);
    await raw(fixture.server).get('/health/live').expect(200);
    const failed = await raw(fixture.server).get('/health/ready').expect(503);
    expect(failed.body.error.code).toBe('NOT_READY'); expect(failed.body.requestId).toBe(failed.headers['x-request-id']);
    await raw(fixture.server).get('/health/metrics').expect(200);
    await fixture.database.$executeRawUnsafe(`ALTER TABLE "${fixture.schema}"."UnavailableAudit" RENAME TO "ArticleStatusAudit"`);
    await raw(fixture.server).get('/health/ready').expect(200);
    expect(logs.lines.join('')).not.toMatch(/UnavailableAudit|SELECT|passwordHash|postgresql|course_local/);
    expect(logs.lines.map(line => JSON.parse(line)).find(row => row.event === 'http_error')).toMatchObject({ requestId: failed.body.requestId, code: 'NOT_READY', errorStatus: 503 });
  } finally { await fixture.dispose(); await fixture.dispose(); }
}, 45000);
test('真登入、Session、CSRF、錯誤 body、URL 與交易失敗的原始秘密都不進日誌或 metrics', async () => {
  const logs = capture();
  const fixture = await httpFixture({ observability: logs.observation, configure: builder => builder.overrideProvider(ARTICLE_REPOSITORY).useFactory({
    inject: [DATABASE], factory: (db: Database): ArticleRepository => {
      const base = createPrismaArticleRepository(db);
      return { ...base, withTransaction: work => base.withTransaction(tx => work({ ...tx, appendStatusAudit: async input => {
        await tx.appendStatusAudit(input); throw new Error('SECRET SQL postgresql://user:credential@host');
      } })) };
    },
  }) });
  try {
    const alice = await loginSession(fixture.server);
    const csrfSecret = alice.writeHeaders['X-CSRF-Token'];
    const anonymous = await raw(fixture.server).get('/api/auth/csrf').expect(200);
    const cookieSecret = anonymous.headers['set-cookie'][0].split(';')[0].split('=')[1];
    const sessionSecrets = (await fixture.database.session.findMany({ select: { tokenHash: true } })).map(row => row.tokenHash);
    const me = await alice.agent.get('/api/auth/me').expect(200);
    await raw(fixture.server).post('/api/articles/preview?token=SECRET').set('Authorization', 'Bearer SECRET').set('Cookie', 'course_session=SECRET')
      .send({ password: 'SECRET', title: 'SECRET title', content: 'SECRET body' }).expect(400);
    const failed = await alice.agent.post('/api/articles/a_draft/publish').set(alice.writeHeaders).send({ expectedVersion: 1 }).expect(500);
    expect(await fixture.database.articleStatusAudit.count()).toBe(0);
    expect((await fixture.database.article.findUniqueOrThrow({ where: { id: 'a_draft' } })).version).toBe(1);
    const logText = logs.lines.join('\n'); const metrics = logs.observation.metrics(0, false);
    for (const value of ['SECRET', csrfSecret, cookieSecret, ...sessionSecrets, me.body.data.email, me.body.data.id, 'tokenHash', 'passwordHash', 'postgresql://', ...demoAccounts.map(account => account.password)]) {
      expect(logText).not.toContain(value); expect(metrics).not.toContain(value);
    }
    const error = logs.lines.map(line => JSON.parse(line)).find(row => row.event === 'http_error' && row.requestId === failed.body.requestId);
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', errorStatus: 500 });
  } finally { await fixture.dispose(); }
}, 45000);
test('正式 NDJSON HEAD／完整下載／中斷由同一 request ID 串接，傳輸結束仍等檔案 finally', async () => {
  const logs = capture(); const fixture = await httpFixture({ observability: logs.observation });
  try {
    const head = await raw(fixture.server).head('/api/articles/export').expect(200);
    await until(() => logs.lines.some(line => JSON.parse(line).event === 'export_finished'));
    const headLog = logs.lines.map(line => JSON.parse(line)).find(row => row.event === 'export_finished' && row.requestId === head.headers['x-request-id']);
    expect(headLog).toMatchObject({ outcome: 'complete', bytesRead: 0, fileClosed: true });
    const result = await raw(fixture.server).get('/api/articles/export').expect(200);
    expect(result.text).toBe(fixture.exportText);
    await until(() => logs.lines.some(line => { const row = JSON.parse(line); return row.event === 'export_finished' && row.requestId === result.headers['x-request-id']; }));
    const handle = await open(fixture.exportFile, 'w');
    try { await handle.truncate(64 * 1024 * 1024); } finally { await handle.close(); }
    const interruptedId = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: fixture.port, path: '/api/articles/export', agent: false }, res => {
        res.on('error', () => {}); res.once('data', () => { res.destroy(); req.destroy(); resolve(String(res.headers['x-request-id'])); });
      }); req.on('error', reject); req.end();
    });
    await until(() => logs.lines.some(line => { const row = JSON.parse(line); return row.event === 'export_finished' && row.requestId === interruptedId; }));
    const rows = logs.lines.map(line => JSON.parse(line)).filter(row => row.requestId === interruptedId);
    expect(rows.find(row => row.event === 'request_completed')).toMatchObject({ httpStatus: 200, outcome: 'interrupted' });
    expect(rows.find(row => row.event === 'export_finished')).toMatchObject({ outcome: 'interrupted', fileClosed: true });
    const file = rows.find(row => row.event === 'export_finished'); expect(file.bytesRead).toBeLessThan(64 * 1024 * 1024);
    await fixture.dispose(); expect(fixture.server.lifecycle.pendingWork).toBe(0);
  } finally { await fixture.dispose(); }
}, 45000);
