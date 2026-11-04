import { beforeAll, beforeEach, afterAll, expect, test } from '@jest/globals';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { httpFixture, loginSession } from './http-fixture.js';
import { demoAccounts } from '../src/seed-database.js';

// 同一組案例放在兩個 test file，才會由不同 Jest worker 執行。
export function parallelHttpCases(label: 'alpha' | 'beta') {
  let fixture: Awaited<ReturnType<typeof httpFixture>>;
  const runDirectory = process.env.COURSE_PARALLEL_RUN_DIR;
  let proof: Record<string, unknown> | undefined;
  async function record(suffix: string, value: object) {
    if (!runDirectory) return;
    const file = join(runDirectory, `${label}.${suffix}.json`);
    await writeFile(`${file}.partial`, JSON.stringify(value)); await rename(`${file}.partial`, file);
  }
  beforeAll(async () => {
    fixture = await httpFixture();
    if (!runDirectory) return; // 一般 npm test 仍可依序執行這兩份案例。
    proof = { label, pid: process.pid, workerId: process.env.JEST_WORKER_ID, schema: fixture.schema, port: fixture.port };
    await record('ready', proof);
    const deadline = Date.now() + 15000;
    while (true) {
      const arrived = await Promise.all(['alpha', 'beta'].map(async name => {
        try { return JSON.parse(await readFile(join(runDirectory, `${name}.ready.json`), 'utf8')) as { pid: number }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      }));
      if (arrived.every(Boolean)) {
        expect(new Set(arrived.map(item => item!.pid)).size).toBe(2);
        return; // 兩個真實應用／schema 同時存在後才執行寫入。
      }
      if (Date.now() >= deadline) throw new Error('另一個 worker 未到達測試屏障');
      await delay(20); // 有期限的跨程序協調，不靠固定 sleep 猜測工作完成。
    }
  }, 45000);
  beforeEach(async () => { await fixture.reset(); });
  afterAll(async () => {
    if (fixture) await fixture.dispose();
    if (proof) await record('closed', { ...proof, closed: fixture.server.address() === null });
  });
  test(`${label}：相同 a_draft ID 可各自編輯／發佈，不互相衝突或混入另一份稽核`, async () => {
    const alice = await loginSession(fixture.server);
    await alice.agent.patch('/api/articles/a_draft').set(alice.writeHeaders).send({ title: `worker ${label}`, expectedVersion: 1 }).expect(200);
    const result = await alice.agent.post('/api/articles/a_draft/publish').set(alice.writeHeaders).send({ expectedVersion: 2 }).expect(200);
    expect(result.body.data).toMatchObject({ title: `worker ${label}`, version: 3, status: 'published' });
    const rows = await fixture.database.articleStatusAudit.findMany();
    expect(rows).toEqual([expect.objectContaining({ articleId: 'a_draft', actorId: 'u_demo', fromVersion: 2, toVersion: 3 })]);
  });
  test(`${label}：真正登入 Bob 後仍被禁止更新 Alice，拒絕不寫入`, async () => {
    const bob = await loginSession(fixture.server, demoAccounts[1]);
    const before = await fixture.database.article.findUniqueOrThrow({ where: { id: 'a_draft' } });
    const result = await bob.agent.post('/api/articles/a_draft/archive').set(bob.writeHeaders).send({ expectedVersion: 1 }).expect(403);
    expect(result.body.error.code).toBe('FORBIDDEN');
    expect(await fixture.database.article.findUniqueOrThrow({ where: { id: 'a_draft' } })).toEqual(before);
    expect(await fixture.database.articleStatusAudit.count()).toBe(0);
  });
  test(`${label}：自有 schema 的真 INSERT 故障回滾，不需要修改另一個 worker`, async () => {
    const alice = await loginSession(fixture.server);
    const before = await fixture.database.article.findUniqueOrThrow({ where: { id: 'a_draft' } });
    await fixture.database.$executeRawUnsafe(`CREATE FUNCTION "${fixture.schema}".fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'parallel insert failure'; END $$`);
    await fixture.database.$executeRawUnsafe(`CREATE TRIGGER fail_audit AFTER INSERT ON "${fixture.schema}"."ArticleStatusAudit" FOR EACH ROW EXECUTE FUNCTION "${fixture.schema}".fail_audit()`);
    try {
      const failed = await alice.agent.post('/api/articles/a_draft/publish').set(alice.writeHeaders).send({ expectedVersion: 1 }).expect(500);
      expect(failed.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '內部錯誤', details: [] }, requestId: failed.headers['x-request-id'] });
      expect(await fixture.database.article.findUniqueOrThrow({ where: { id: 'a_draft' } })).toEqual(before);
      expect(await fixture.database.articleStatusAudit.count()).toBe(0);
    } finally {
      await fixture.database.$executeRawUnsafe(`DROP TRIGGER fail_audit ON "${fixture.schema}"."ArticleStatusAudit"`);
      await fixture.database.$executeRawUnsafe(`DROP FUNCTION "${fixture.schema}".fail_audit()`);
    }
  });
}
