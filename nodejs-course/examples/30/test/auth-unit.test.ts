import { expect, test } from '@jest/globals';
import { hashPassword, verifyPassword } from '../src/password.js';
import { resolveAuthOptions } from '../src/auth-options.js';
import { loginSchema, registerSchema } from '../src/auth.schemas.js';

test('相同密碼有不同 salt；驗證正確與錯誤密碼，不 trim 密碼', async () => {
  const password = ' a passphrase with spaces ';
  const first = await hashPassword(password); const second = await hashPassword(password);
  expect(first).not.toBe(second); expect(first).toMatch(/^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  expect(await verifyPassword(password, first)).toBe(true);
  expect(await verifyPassword(password.trim(), first)).toBe(false);
  expect(await verifyPassword('incorrect long password', first)).toBe(false);
  expect(await verifyPassword(password, first.replace('131072', '999999999'))).toBe(false);
  expect(await verifyPassword(password, 'corrupt hash')).toBe(false);
});

test('每個程序同時最多兩個 scrypt，超額立即 AUTH_BUSY 且完成後可再使用', async () => {
  const results = await Promise.allSettled([1, 2, 3].map(() => hashPassword('a long new password')));
  expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(2);
  expect(results.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'AUTH_BUSY' } });
  expect(await hashPassword('a long new password')).toMatch(/^scrypt\$/);
});

test('登入 DTO 正規化 email 但保留密碼；限制 code points，拒絕短密碼和未知角色', () => {
  const password = '  longer passphrase  ';
  expect(loginSchema.parse({ email: ' Alice@Example.test ', password })).toEqual({ email: 'alice@example.test', password });
  for (const value of ['short', 'x'.repeat(129), null, 123]) expect(loginSchema.safeParse({ email: 'alice@example.test', password: value }).success).toBe(false);
  expect(loginSchema.safeParse({ email: 'alice@example.test', password: '🙂'.repeat(128) }).success).toBe(true);
  expect(registerSchema.safeParse({ email: 'new@example.test', password, displayName: 'x', role: 'admin' }).success).toBe(false);
});

test.each(['http://example.test', 'https://example.test/', 'https://user:password@example.test', 'file:///tmp/x', 'null'])('拒絕不安全或不是精確 origin 的設定 %s', origin => {
  expect(() => resolveAuthOptions({ origin })).toThrow();
});

test('HTTPS 不能關閉 Secure；期限有上下界，設定不可變', () => {
  expect(() => resolveAuthOptions({ origin: 'https://example.test', secureCookies: false })).toThrow();
  for (const sessionTtlMs of [0, -1, 1.2, Infinity, 86400001]) expect(() => resolveAuthOptions({ sessionTtlMs })).toThrow();
  expect(Object.isFrozen(resolveAuthOptions())).toBe(true);
});
