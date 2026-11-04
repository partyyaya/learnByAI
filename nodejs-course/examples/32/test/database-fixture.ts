import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createDatabase } from '../src/database.js';
const runFile = promisify(execFile);

export async function databaseFixture() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error('測試必須設定 TEST_DATABASE_URL，不能回退到開發 DATABASE_URL');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== '/course_test') throw new Error('只接受本課的 course_test 測試資料庫');
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  url.searchParams.delete('schema');
  const admin = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
  let owned = false;
  let disposal: Promise<void> | undefined;
  function dispose() {
    return disposal ??= (async () => {
      try {
        // 名稱只來自程式產生的 UUID，不接受 URL 或用戶指定名稱。
        if (owned) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); owned = false; }
      } finally { await admin.end(); }
    })();
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); owned = true;
    url.searchParams.set('schema', schema);
    const connectionString = url.toString();
    async function deploy() {
      await runFile(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: connectionString }, timeout: 30000,
      });
    }
    await deploy();
    return { schema, url: connectionString, deploy, connect: () => createDatabase(connectionString), dispose };
  } catch (error) { await dispose(); throw error; }
}
