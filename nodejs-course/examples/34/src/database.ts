import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

const schemas = new WeakMap<object, string>();
export function databaseSchema(database: object) { const schema = schemas.get(database); if (!schema) throw new Error('缺少可信 schema 設定'); return schema; }
export function createDatabase(connectionString: string) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL 必須是 PostgreSQL URL');
  const schema = url.searchParams.get('schema') ?? 'public';
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('schema 名稱不合法');
  url.searchParams.delete('schema');
  const adapter = new PrismaPg({ connectionString: url.toString(), max: 5, connectionTimeoutMillis: 2000, statement_timeout: 5000 }, { schema });
  const client = new PrismaClient({ adapter }); schemas.set(client, schema); return client;
}
export type Database = ReturnType<typeof createDatabase>;
