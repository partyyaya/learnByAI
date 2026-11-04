import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export function createDatabase(connectionString: string) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL 必須是 PostgreSQL URL');
  const schema = url.searchParams.get('schema') ?? 'public';
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('schema 名稱不合法');
  url.searchParams.delete('schema');
  const adapter = new PrismaPg({ connectionString: url.toString(), max: 5, connectionTimeoutMillis: 2000, statement_timeout: 5000 }, { schema });
  return new PrismaClient({ adapter });
}
export type Database = ReturnType<typeof createDatabase>;
