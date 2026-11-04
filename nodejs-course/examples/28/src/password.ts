import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AuthError } from './auth-model.js';

// 固定成本：N=2^17、r=8、p=1，約 128 MiB；async scrypt 使用 worker pool。
const N = 131072; const r = 8; const p = 1; const keyLength = 64;
let active = 0;
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // 每個程序最多兩個 KDF，避免以無界排隊耗盡記憶體；不是分散式登入限流。
  if (active >= 2) throw new AuthError('AUTH_BUSY');
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, keyLength,
      { N, r, p, maxmem: 160 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
  } finally { active--; }
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16); const key = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`;
}
// 未知帳號也執行相同 KDF；固定假摘要不對應任何可登入帳號。
export const dummyPasswordHash = `scrypt$${N}$${r}$${p}$${'ab'.repeat(16)}$${'cd'.repeat(64)}`;
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  if (!match) return false;
  const actual = await derive(password, Buffer.from(match[1], 'hex'));
  return timingSafeEqual(actual, Buffer.from(match[2], 'hex'));
}
