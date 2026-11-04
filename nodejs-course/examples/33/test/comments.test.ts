import { expect, test } from '@jest/globals';
import raw from 'supertest';
import { httpFixture, loginSession } from './http-fixture.js';
import { demoAccounts } from '../src/seed-database.js';
import { createCommentStore } from '../src/comment-store.js';
import { createDatabase } from '../src/database.js';
import { databaseFixture } from './database-fixture.js';
import { seedDatabase } from '../src/seed-database.js';
import { assertApiResponse } from './openapi-contract.js';
import { openapiDocument } from '../src/openapi.js';
import { setTimeout as delay } from 'node:timers/promises';

test('公開列表只在 published 可讀，草稿／封存對 owner／admin 也 404；HEAD／分頁／未知欄位', async () => {
  const f = await httpFixture();
  try {
    const alice = await loginSession(f.server); const admin = await loginSession(f.server, demoAccounts[2]);
    for (const agent of [raw(f.server), alice.agent, admin.agent]) await agent.get('/api/articles/a_draft/comments').expect(404);
    await raw(f.server).get('/api/articles/missing/comments').expect(404);
    const result = await raw(f.server).get('/api/articles/a_1/comments').expect(200); expect(result.body).toMatchObject({ data: [], meta: { total: 0 } });
    assertApiResponse(openapiDocument.paths['/api/articles/{id}/comments'].get, 200, result.body);
    await raw(f.server).head('/api/articles/a_1/comments').expect(200);
    await raw(f.server).get('/api/articles/a_1/comments?authorId=u_demo').expect(400); await raw(f.server).get('/api/articles/a_1/comments?page=0').expect(400);
    await raw(f.server).get('/api/articles/a_1/comments/').expect(404);
  } finally { await f.dispose(); }
}, 45000);
test('Session 決定留言作者、trim、未知欄位拒絕，文章版本／稽核不被留言改動', async () => {
  const f = await httpFixture();
  try {
    const bob = await loginSession(f.server, demoAccounts[1]);
    const before = await f.database.article.findUniqueOrThrow({ where: { id: 'a_1' } });
    const result = await bob.agent.post('/api/articles/a_1/comments').set(bob.writeHeaders).send({ content: '  留言🙂  ' }).expect(201);
    expect(result.body.data).toMatchObject({ authorId: 'u_bob', articleId: 'a_1', content: '留言🙂' }); assertApiResponse(openapiDocument.paths['/api/articles/{id}/comments'].post, 201, result.body);
    expect(await f.database.article.findUniqueOrThrow({ where: { id: 'a_1' } })).toEqual(before); expect(await f.database.articleStatusAudit.count()).toBe(0);
    await bob.agent.post('/api/articles/a_1/comments').set(bob.writeHeaders).send({ content: 'x', authorId: 'u_demo' }).expect(400);
    await raw(f.server).post('/api/articles/a_1/comments').send({ content: 'x' }).expect(401);
    await bob.agent.post('/api/articles/a_1/comments').set(bob.writeHeaders).set('X-CSRF-Token', 'x'.repeat(43)).send({ content: 'x' }).expect(403);
  } finally { await f.dispose(); }
}, 45000);
test.each(['', '   ', '\0', 'x'.repeat(1001), null, 1])('拒絕非法留言內容（不新增資料）%p', async content => {
  const f = await httpFixture();
  try { const alice = await loginSession(f.server); await alice.agent.post('/api/articles/a_1/comments').set(alice.writeHeaders).send({ content }).expect(400); expect(await f.database.comment.count()).toBe(0); }
  finally { await f.dispose(); }
}, 45000);
test('1000 code points Unicode 邊界與 stable 順序／total，先篩文章再分頁', async () => {
  const f = await httpFixture();
  try {
    const alice = await loginSession(f.server);
    await alice.agent.post('/api/articles/a_1/comments').set(alice.writeHeaders).send({ content: '🙂'.repeat(1000) }).expect(201);
    await alice.agent.post('/api/articles/a_1/comments').set(alice.writeHeaders).send({ content: 'second' }).expect(201);
    const result = await raw(f.server).get('/api/articles/a_1/comments?pageSize=1&page=2').expect(200);
    expect(result.body.data).toHaveLength(1); expect(result.body.data[0].content).toBe('second'); expect(result.body.meta.total).toBe(2);
    expect((await raw(f.server).get('/api/articles/a_2/comments').expect(200)).body.meta.total).toBe(0);
  } finally { await f.dispose(); }
}, 45000);
test('留言作者／admin 可刪；文章作者不能刪別人的；封存後仍可刪、重複 404、body 拒絕', async () => {
  const f = await httpFixture();
  try {
    const alice = await loginSession(f.server); const bob = await loginSession(f.server, demoAccounts[1]); const admin = await loginSession(f.server, demoAccounts[2]);
    const own = await bob.agent.post('/api/articles/a_1/comments').set(bob.writeHeaders).send({ content: 'Bob comment' }).expect(201); const path = '/api/comments/' + own.body.data.id;
    await alice.agent.delete(path).set(alice.writeHeaders).expect(403);
    await bob.agent.delete(path).set(bob.writeHeaders).send({ content: 'no body' }).expect(400);
    await alice.agent.post('/api/articles/a_1/archive').set(alice.writeHeaders).send({ expectedVersion: 1 }).expect(200);
    await raw(f.server).get('/api/articles/a_1/comments').expect(404);
    await bob.agent.post('/api/articles/a_1/comments').set(bob.writeHeaders).send({ content: 'late' }).expect(404);
    const removed = await admin.agent.delete(path).set(admin.writeHeaders).expect(204); expect(removed.text).toBe('');
    await bob.agent.delete(path).set(bob.writeHeaders).expect(404);
  } finally { await f.dispose(); }
}, 45000);
test('owner 的 DELETE 成功；兩個 DELETE 只有一個 204，另一個 404', async () => {
  const f = await httpFixture();
  try {
    const alice = await loginSession(f.server); const result = await alice.agent.post('/api/articles/a_1/comments').set(alice.writeHeaders).send({ content: 'race delete' }).expect(201);
    const path = '/api/comments/' + result.body.data.id;
    const results = await Promise.all([1, 2].map(() => alice.agent.delete(path).set(alice.writeHeaders)));
    expect(results.map(row => row.status).sort()).toEqual([204, 404]); expect(await f.database.comment.count()).toBe(0);
  } finally { await f.dispose(); }
}, 45000);
test('只有 admin 讀狀態稽核，實際 actor 與版本正確，沒有 create／edit 假歷史', async () => {
  const f = await httpFixture();
  try {
    const alice = await loginSession(f.server); const admin = await loginSession(f.server, demoAccounts[2]);
    const path = '/api/admin/articles/a_draft/status-audits';
    await raw(f.server).get(path).expect(401); await alice.agent.get(path).expect(403);
    await admin.agent.post('/api/articles/a_draft/publish').set(admin.writeHeaders).send({ expectedVersion: 1 }).expect(200);
    const result = await admin.agent.get(path).expect(200);
    expect(result.body.data[0]).toMatchObject({ actorId: 'u_admin', fromVersion: 1, toVersion: 2, action: 'publish' });
    assertApiResponse(openapiDocument.paths['/api/admin/articles/{id}/status-audits'].get, 200, result.body);
    expect(JSON.stringify(result.body)).not.toMatch(/passwordHash|tokenHash|csrfToken/);
    await admin.agent.get(path + '?q=no').expect(400);
  } finally { await f.dispose(); }
}, 45000);
test('真 DB CHECK／FK 拒絕非法 INSERT，失敗不改文章／不留下留言', async () => {
  const f = await httpFixture();
  try {
    await expect(f.database.comment.create({ data: { id: 'bad', articleId: 'a_1', authorId: 'u_demo', content: '' } })).rejects.toThrow();
    await expect(f.database.comment.create({ data: { id: 'bad', articleId: 'missing', authorId: 'u_demo', content: 'x' } })).rejects.toThrow();
    expect(await f.database.comment.count()).toBe(0);
    const store = createCommentStore(f.database); await expect(store.create('a_1', 'x', { id: 'missing-user', role: 'member' })).rejects.toThrow();
    expect(await f.database.comment.count()).toBe(0); expect((await f.database.article.findUniqueOrThrow({ where: { id: 'a_1' } })).version).toBe(1);
  } finally { await f.dispose(); }
}, 45000);
test('archive 先持 row lock，comment 等待後看見 archived 並拒絕；真雙 pool 不寫晚到留言', async () => {
  const f = await httpFixture(); const otherUrl = new URL(f.url); otherUrl.searchParams.set('application_name', 'course28_comment_race'); const other = createDatabase(otherUrl.toString());
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let locked!: () => void; const entered = new Promise<void>(resolve => { locked = resolve; });
  let archive: Promise<unknown> | undefined;
  try {
    archive = f.database.$transaction(async tx => { await tx.article.update({ where: { id: 'a_1' }, data: { status: 'archived', version: { increment: 1 } } }); locked(); await gate; });
    await entered; let finished = false;
    const attempt = createCommentStore(other).create('a_1', 'too late', { id: 'u_bob', role: 'member' }).then(() => 'created', error => { finished = true; return error.code; });
    const deadline = performance.now() + 3000;
    for (;;) {
      const waiting = await f.database.$queryRawUnsafe<{ count: bigint }[]>("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'course28_comment_race' AND wait_event_type = 'Lock'");
      if (Number(waiting[0].count) > 0) break;
      if (performance.now() > deadline) throw new Error('未觀察到真 row lock 等待');
      await delay(5);
    }
    expect(finished).toBe(false); release(); await archive;
    expect(await attempt).toBe('NOT_FOUND'); expect(await f.database.comment.count()).toBe(0);
  } finally { release(); await archive; await other.$disconnect(); await f.dispose(); }
}, 45000);

test('Comment 表故障使 ready 503、live 仍 200，不公開表名／SQL', async () => {
  const f = await httpFixture();
  try {
    await f.database.$executeRawUnsafe(`DROP TABLE "${f.schema}"."Comment"`);
    await raw(f.server).get('/health/live').expect(200);
    const result = await raw(f.server).get('/health/ready').expect(503);
    expect(result.body.error.code).toBe('NOT_READY'); expect(result.text).not.toMatch(/SELECT|Comment|postgresql/);
  } finally { await f.dispose(); }
}, 45000);
