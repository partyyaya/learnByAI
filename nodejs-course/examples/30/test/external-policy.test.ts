import { expect, test } from '@jest/globals';
import { createExternalClient, jitterDelay, retryAfterMs } from '../src/external-client.js';

test.each([null, 'garbage', '1.5', '-1', '', '2026-11-02T00:00:02Z', 'Mon, 31 Feb 2026 00:00:00 GMT',
  'Mon, 02 Nov 2026 24:00:00 GMT'])('Retry-After %j 不是合法延遲', value => {
  expect(retryAfterMs(value)).toBeUndefined();
});
test('Retry-After 支援秒數與 HTTP-date，過去日期為 0，過大值不溢位成短延遲', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  expect(retryAfterMs('0', now)).toBe(0); expect(retryAfterMs('2', now)).toBe(2000);
  expect(retryAfterMs('Mon, 02 Nov 2026 00:00:02 GMT', now)).toBe(2000);
  expect(retryAfterMs('Sun, 01 Nov 2026 00:00:00 GMT', now)).toBe(0);
  expect(retryAfterMs('9'.repeat(400), now)).toBe(Infinity);
});
test('HTTP-date 的舊格式與兩位年份遵守相對目前時間的 50 年規則', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  expect(retryAfterMs('Monday, 02-Nov-26 00:00:02 GMT', now)).toBe(2000);
  expect(retryAfterMs('Mon Nov  2 00:00:02 2026', now)).toBe(2000);
  const future = new Date('2070-11-02T00:00:02Z');
  expect(retryAfterMs('Sunday, 02-Nov-70 00:00:02 GMT', now)).toBe(future.getTime() - now);
  // 90 代表 1990，不能誤判為超過 50 年以後的 2090。
  expect(retryAfterMs('Friday, 02-Nov-90 00:00:00 GMT', now)).toBe(0);
  // 50 年界線比較完整日期，超過界線的兩位年份回到上一世紀。
  expect(retryAfterMs('Wednesday, 03-Nov-76 00:00:00 GMT', now)).toBe(0);
});
test('退避為有上限的 full jitter，不超過本次 cap', () => {
  expect(jitterDelay(1, 30, () => 0)).toBe(0);
  expect([1, 2, 3, 4, 5].map(attempt => jitterDelay(attempt, 30, () => 0.99999))).toEqual([30, 60, 120, 200, 200]);
  expect(() => jitterDelay(1, 30, () => 1)).toThrow();
});
test.each(['http://example.test', 'https://user:secret@example.test', 'https://example.test/path', 'https://example.test/?q=x',
  'https://example.test/#x', 'file:///tmp/x'])('外部 origin %s 在啟動前拒絕', origin => {
  expect(() => createExternalClient({ origin })).toThrow();
});
test.each([{ maxAttempts: 4 }, { totalTimeoutMs: 0 }, { totalTimeoutMs: 100, attemptTimeoutMs: 101 },
  { maxConcurrent: 0 }, { maxResponseBytes: 65537 }, { baseDelayMs: 0 }, { attemptTimeoutMs: NaN }])('非法設定 %j 在啟動前拒絕', options => {
  expect(() => createExternalClient({ origin: 'http://127.0.0.1:1', ...options })).toThrow();
});
