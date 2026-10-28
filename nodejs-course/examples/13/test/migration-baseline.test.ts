import { afterAll, afterEach, beforeAll, beforeEach, describe } from '@jest/globals';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArticleApplication } from '../src/application.js';
import { seedDatabase } from '../src/seed-database.js';
import { databaseFixture } from './database-fixture.js';
import { articleContract } from './api-contract.js';
import { migrationContract } from './migration-contract.js';

// 後續搬到 Nest 時更換這份組裝程式，保留兩份 HTTP 契約測試函式。
describe('Express 遷移基準', () => {
  let fixture: Awaited<ReturnType<typeof databaseFixture>> | undefined;
  let directory: string | undefined;
  let server: ReturnType<typeof createArticleApplication> | undefined;
  const exportText = '{"id":"file_only","title":"獨立教學檔🙂"}\n';
  beforeAll(async () => {
    fixture = await databaseFixture();
    directory = await mkdtemp(join(tmpdir(), 'migration-baseline-'));
    await writeFile(join(directory, 'articles.ndjson'), exportText);
  }, 45000);
  beforeEach(async () => {
    if (!fixture || !directory) throw new Error('fixture 尚未建立');
    const db = fixture.connect();
    try {
      // 只清理本套件建立的 schema；不得指向開發資料庫。
      await db.article.deleteMany(); await db.user.deleteMany(); await seedDatabase(db);
      server = createArticleApplication({ database: db, exportFile: join(directory, 'articles.ndjson') });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
    } catch (error) {
      if (server) { await server.lifecycle.shutdown(); server = undefined; }
      else await db.$disconnect();
      throw error;
    }
  });
  afterEach(async () => { try { await server?.lifecycle.shutdown(); } finally { server = undefined; } });
  afterAll(async () => {
    try { await fixture?.dispose(); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  });
  const getServer = () => {
    if (!server) throw new Error('server 尚未啟動');
    return server;
  };
  articleContract(getServer); // 10–12 章原有契約，原封不動保留。
  migrationContract(getServer, exportText);
});
