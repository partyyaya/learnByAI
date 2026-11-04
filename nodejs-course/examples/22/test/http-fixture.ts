import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import raw from 'supertest';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { databaseFixture } from './database-fixture.js';
import { createTestingApplication } from './testing-application.js';
import { seedDatabase, demoAccounts } from '../src/seed-database.js';
import type { Database } from '../src/database.js';
import type { Server } from 'node:http';
import { origin } from './authenticated-test-client.js';

export async function loginSession(server: Server, account = demoAccounts[0]) {
  const agent = raw.agent(server);
  const csrf = await agent.get('/api/auth/csrf').expect(200);
  const result = await agent.post('/api/auth/login').set('Origin', origin)
    .set('X-CSRF-Token', csrf.body.data.csrfToken)
    .send({ email: account.email, password: account.password }).expect(200);
  // 每個 agent 有獨立 Cookie jar；寫入仍需明確帶 Origin＋登入後的 CSRF。
  return { agent, writeHeaders: Object.freeze({ Origin: origin, 'X-CSRF-Token': result.body.data.csrfToken }) };
}

export async function httpFixture(options: {
  configure?: (builder: TestingModuleBuilder, database: Database) => void;
  onSchema?: (schema: string) => void;
  maxBodyBytes?: number;
} = {}) {
  const storage = await databaseFixture();
  let directory: string | undefined;
  let database: Database | undefined;
  let application: Awaited<ReturnType<typeof createTestingApplication>> | undefined;
  let handedOff = false;
  let disposal: Promise<void> | undefined;
  const exportText = '{"id":"fixture_only","title":"隔離檔案🙂"}\n';
  function dispose() {
    return disposal ??= (async () => {
      const failures: unknown[] = [];
      // 必須先關應用／pool，再 DROP 自有 schema，最後刪自己的暫存目錄。
      for (const close of [
        async () => { if (application) await application.server.lifecycle.shutdown(); else if (database && !handedOff) await database.$disconnect(); },
        () => storage.dispose(),
        async () => { if (directory) await rm(directory, { recursive: true, force: true }); },
      ]) { try { await close(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'fixture 清理失敗');
    })();
  }
  try {
    options.onSchema?.(storage.schema);
    directory = await mkdtemp(join(tmpdir(), 'course22-http-'));
    const exportFile = join(directory, 'articles.ndjson');
    await writeFile(exportFile, exportText);
    database = storage.connect();
    await seedDatabase(database);
    handedOff = true; // application 從呼叫起承擔成功及初始化失敗的 disconnect。
    application = await createTestingApplication({ database, exportFile, maxBodyBytes: options.maxBodyBytes },
      builder => options.configure?.(builder, database!));
    application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening');
    const address = application.server.address();
    if (!address || typeof address === 'string') throw new Error('fixture 沒有 TCP 位址');
    const db = database;
    async function reset() {
      // 只能在這個 fixture 沒有進行中請求時使用；不能與同一 schema 的 test.concurrent 共用。
      await db.session.deleteMany(); await db.articleStatusAudit.deleteMany(); await db.article.deleteMany(); await db.user.deleteMany();
      await seedDatabase(db);
    }
    return { ...application, database: db, schema: storage.schema, url: storage.url,
      directory, exportFile, exportText, port: address.port, reset, dispose };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'fixture 建立與清理失敗'); }
    throw error;
  }
}
