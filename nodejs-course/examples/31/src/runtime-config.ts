import { readFileSync } from 'node:fs';

export function databaseUrlFrom(env: NodeJS.ProcessEnv, read: (filename: string) => Buffer = filename => readFileSync(filename)) {
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL_FILE !== undefined) throw new Error('資料庫設定不可重複');
  let value = env.DATABASE_URL;
  if (env.DATABASE_URL_FILE !== undefined) {
    if (!env.DATABASE_URL_FILE.startsWith('/')) throw new Error('secret 路徑須為絕對路徑');
    const bytes = read(env.DATABASE_URL_FILE);
    if (bytes.length > 8192) throw new Error('secret 大小不合法');
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/, '');
  }
  if (!value || /\s/.test(value)) throw new Error('資料庫設定不合法');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.hash) throw new Error('資料庫設定不合法');
  return value;
}
export function runtimeConfig(env: NodeJS.ProcessEnv) {
  const rawPort = env.PORT ?? '3000'; const rawTimeout = env.SHUTDOWN_TIMEOUT_MS ?? '3000';
  const port = Number(rawPort); const timeoutMs = Number(rawTimeout); const host = env.HOST ?? '127.0.0.1';
  const origin = env.APP_ORIGIN;
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port > 65535 ||
      !/^\d+$/.test(rawTimeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      !['127.0.0.1', '0.0.0.0'].includes(host) || !origin) throw new Error('設定不合法');
  if (env.NODE_ENV === 'production' && new URL(origin).protocol !== 'https:') throw new Error('正式環境需要 HTTPS origin');
  return { port, timeoutMs, host, origin, databaseUrl: databaseUrlFrom(env) };
}
