import { expect, test } from '@jest/globals';
import { databaseFixture } from './database-fixture.js';
import { seedDatabase } from '../src/seed-database.js';

test('缺 TEST_DATABASE_URL 或使用開發資料庫名稱時，在建立 schema 前拒絕', async () => {
  const original = process.env.TEST_DATABASE_URL;
  try {
    delete process.env.TEST_DATABASE_URL;
    await expect(databaseFixture()).rejects.toThrow('不能回退到開發 DATABASE_URL');
    process.env.TEST_DATABASE_URL = 'postgresql://course:course_local@test-db:5432/course';
    await expect(databaseFixture()).rejects.toThrow('course_test');
  } finally {
    if (original === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = original;
  }
});

test('兩套 fixture 使用相同文章 ID 仍互不影響，刪除第一個 schema 不影響第二個', async () => {
  const first = await databaseFixture();
  let second: Awaited<ReturnType<typeof databaseFixture>> | undefined;
  const firstDb = first.connect();
  let firstDisposed = false;
  try {
    second = await databaseFixture(); const secondDb = second.connect();
    try {
      expect(second.schema).not.toBe(first.schema);
      await Promise.all([seedDatabase(firstDb), seedDatabase(secondDb)]);
      await firstDb.article.update({ where: { id: 'a_1' }, data: { title: 'only first schema' } });
      expect((await secondDb.article.findUniqueOrThrow({ where: { id: 'a_1' } })).title).toBe('認識 Node HTTP');
      await firstDb.$disconnect(); await first.dispose(); firstDisposed = true;
      expect(await secondDb.article.count()).toBe(3);
      await secondDb.article.update({ where: { id: 'a_1' }, data: { title: 'second remains writable' } });
      expect((await secondDb.article.findUniqueOrThrow({ where: { id: 'a_1' } })).title).toBe('second remains writable');
    } finally { await secondDb.$disconnect(); }
  } finally {
    try { await firstDb.$disconnect(); if (!firstDisposed) await first.dispose(); }
    finally { await second?.dispose(); }
  }
}, 90000);
