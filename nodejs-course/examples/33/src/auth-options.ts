export interface AuthOptions {
  readonly origin: string;
  readonly secureCookies: boolean;
  readonly sessionTtlMs: number;
  readonly anonymousTtlMs: number;
  readonly now: () => Date;
}
export function resolveAuthOptions(input: Partial<AuthOptions> = {}): Readonly<AuthOptions> {
  const origin = input.origin ?? 'http://127.0.0.1:3033';
  const url = new URL(origin);
  const secureCookies = input.secureCookies ?? url.protocol === 'https:';
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ||
      (url.protocol === 'https:' && !secureCookies)) throw new Error('認證 origin／Cookie 設定不合法');
  const options = { origin, secureCookies, sessionTtlMs: input.sessionTtlMs ?? 30 * 60 * 1000,
    anonymousTtlMs: input.anonymousTtlMs ?? 10 * 60 * 1000, now: input.now ?? (() => new Date()) };
  for (const ttl of [options.sessionTtlMs, options.anonymousTtlMs]) {
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 24 * 60 * 60 * 1000) throw new Error('Session 期限不合法');
  }
  return Object.freeze(options);
}
