import { expect, jest, test } from '@jest/globals';
import { access } from 'node:fs/promises';
import { Pool } from 'pg';
import raw from 'supertest';
import { databaseFixture } from './database-fixture.js';
import { httpFixture } from './http-fixture.js';
import { ARTICLE_SERVICE, DATABASE } from '../src/tokens.js';

async function schemaExists(schema: string) {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error('需要 TEST_DATABASE_URL');
  const url = new URL(raw); if (url.pathname !== '/course_test') throw new Error('只接受 course_test');
  url.searchParams.delete('schema');
  const pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 2000 });
  try { return (await pool.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema])).rowCount === 1; }
  finally { await pool.end(); }
}

test.each(['https://example.test/course_test', 'postgresql://course:local@test-db:5432/course', 'postgresql://course:local@test-db:5432/course_test_other'])(
  '非法測試連線 %s 在建立 schema 前拒絕', async value => {
    const previous = process.env.TEST_DATABASE_URL;
    try { process.env.TEST_DATABASE_URL = value; await expect(databaseFixture()).rejects.toThrow('只接受'); }
    finally { if (previous === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = previous; }
  },
);
test('schema dispose 可重複／同時呼叫，完成後只刪自己的 schema', async () => {
  const fixture = await databaseFixture();
  try { expect(await schemaExists(fixture.schema)).toBe(true); }
  finally { await Promise.all([fixture.dispose(), fixture.dispose()]); }
  expect(await schemaExists(fixture.schema)).toBe(false);
});
test('configure 在 compile 前拋錯，httpFixture 仍清除已建立的 schema', async () => {
  const failure = new Error('builder rejected'); let schema = '';
  await expect(httpFixture({ onSchema: value => { schema = value; }, configure: () => { throw failure; } })).rejects.toBe(failure);
  expect(schema).toMatch(/^test_/); expect(await schemaExists(schema)).toBe(false);
});
test('DATABASE 已初始化後 Provider 失敗，仍關閉 client 並刪自有 schema', async () => {
  const failure = new Error('provider rejected after connect'); let schema = '';
  await expect(httpFixture({ onSchema: value => { schema = value; }, configure: builder => {
    builder.overrideProvider(ARTICLE_SERVICE).useFactory({ inject: [DATABASE], factory: () => { throw failure; } });
  } })).rejects.toBe(failure);
  expect(await schemaExists(schema)).toBe(false);
});
test('先 disconnect 才 DROP schema，完整 fixture dispose 可重複且清理臨時檔案', async () => {
  const fixture = await httpFixture();
  const original = fixture.database.$disconnect.bind(fixture.database);
  const disconnect = jest.spyOn(fixture.database, '$disconnect').mockImplementation(async () => {
    try { expect(await schemaExists(fixture.schema)).toBe(true); } finally { await original(); }
  });
  await Promise.all([fixture.dispose(), fixture.dispose()]);
  expect(disconnect).toHaveBeenCalledTimes(1); expect(fixture.server.address()).toBeNull();
  expect(await schemaExists(fixture.schema)).toBe(false);
  await expect(access(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
test('兩個 fixture 同時建立，關掉第一個不破壞第二個 schema、port 或匯出檔', async () => {
  const created = await Promise.allSettled([httpFixture(), httpFixture()]);
  const fixtures = created.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  try {
    expect(fixtures).toHaveLength(2);
    const [first, second] = fixtures;
    expect(first.schema).not.toBe(second.schema); expect(first.port).not.toBe(second.port); expect(first.directory).not.toBe(second.directory);
    await first.dispose();
    await raw(second.server).get('/health/ready').expect(200);
    expect((await raw(second.server).get('/api/articles/export').expect(200)).text).toBe(second.exportText);
    expect(await schemaExists(second.schema)).toBe(true);
  } finally { await Promise.all(fixtures.map(fixture => fixture.dispose())); }
}, 45000);
