import { expect, test } from '@jest/globals';
import { setImmediate as immediate } from 'node:timers/promises';
import { createAdmission, createWindowLimiter, percentile } from '../src/performance-policy.js';
import { cpuDigest, createMeasurements } from '../src/performance-measurement.js';

test.each([0, -1, 1.5, NaN, Infinity, 17])('拒絕非法 admission 上限 %s', value => {
  expect(() => createAdmission(value)).toThrow();
});
test('admission 不排隊，釋放可重複，拒絕後容量能恢復', () => {
  const gate = createAdmission(2); const first = gate.acquire()!; const second = gate.acquire()!;
  expect(gate.acquire()).toBeUndefined(); expect(gate.snapshot()).toEqual({ maximum: 2, active: 2, peak: 2, rejected: 1 });
  first(); first(); expect(gate.snapshot().active).toBe(1);
  const third = gate.acquire()!; second(); third(); expect(gate.snapshot().active).toBe(0);
});
test('限流視窗從各來源第一次請求開始，精確到期恢復且來源隔離', () => {
  let now = 0; const limiter = createWindowLimiter({ limit: 2, windowMs: 1000, maxSources: 2, now: () => now });
  expect(limiter.consume('a').allowed).toBe(true); expect(limiter.consume('a').allowed).toBe(true);
  expect(limiter.consume('a')).toEqual({ allowed: false, reason: 'RATE_LIMITED', retryAfter: 1 });
  now = 500; expect(limiter.consume('b').allowed).toBe(true);
  now = 1000; expect(limiter.consume('a').allowed).toBe(true); expect(limiter.snapshot().sources).toBe(2);
});
test('來源滿表拒絕新來源，不淘汰有效記錄；過期後才容許新來源', () => {
  let now = 0; const limiter = createWindowLimiter({ limit: 1, windowMs: 2001, maxSources: 1, now: () => now });
  limiter.consume('a'); expect(limiter.consume('b')).toEqual({ allowed: false, reason: 'SOURCE_CAPACITY', retryAfter: 3 });
  expect(limiter.consume('a')).toMatchObject({ allowed: false, reason: 'RATE_LIMITED' });
  now = 2001; expect(limiter.consume('b').allowed).toBe(true); expect(limiter.snapshot().sources).toBe(1);
});
test.each([
  { limit: 0, windowMs: 1000, maxSources: 1 }, { limit: 10001, windowMs: 1000, maxSources: 1 },
  { limit: 1, windowMs: 0, maxSources: 1 }, { limit: 1, windowMs: 60001, maxSources: 1 },
  { limit: 1, windowMs: 1000, maxSources: 0 }, { limit: 1, windowMs: 1000, maxSources: 1001 },
])('限流設定不合法時拒絕建立 %j', options => expect(() => createWindowLimiter(options)).toThrow());
test.each([[0, 1], [0.5, 2], [0.95, 4], [0.99, 4], [1, 4]])('nearest rank q=%s 為 %s，原陣列不改變', (q, expected) => {
  const values = [4, 1, 3, 2]; expect(percentile(values, q)).toBe(expected); expect(values).toEqual([4, 1, 3, 2]);
});
test('空樣本為 null，非法 quantile 拒絕', () => {
  expect(percentile([], 0.95)).toBeNull(); expect(() => percentile([1], 1.1)).toThrow(); expect(() => percentile([1], NaN)).toThrow();
});
test('CPU 同迭代數的 sync／yield 結果相同；sync 期間排程無法執行，yield 可以交錯', async () => {
  let ran = false; const queued = immediate().then(() => { ran = true; });
  const blocking = cpuDigest(750000, false); expect(ran).toBe(false);
  const value = await blocking; await queued;
  ran = false; const other = immediate().then(() => { ran = true; });
  const yielded = await cpuDigest(750000, true); expect(ran).toBe(true); expect(yielded).toBe(value); await other;
});
test('CPU 已取消完全不工作；分段工作可在讓出時取消', async () => {
  await expect(cpuDigest(750000, false, AbortSignal.abort())).rejects.toThrow();
  const controller = new AbortController(); const queued = immediate().then(() => controller.abort());
  await expect(cpuDigest(5000000, true, controller.signal)).rejects.toThrow(); await queued;
});
test('monitor 無樣本時不捏造 p99，disable 可重複且記憶體／CPU 為安全數值', async () => {
  const monitor = createMeasurements();
  try {
    const report = monitor.sample(); expect(report.memory.rssBytes).toBeGreaterThan(0); expect(report.cpuMs).toBeGreaterThanOrEqual(0);
    expect(report.eventLoopUtilization).toBeGreaterThanOrEqual(0); expect(report.eventLoopUtilization).toBeLessThanOrEqual(1);
    if (report.eventLoopDelay) expect(report.eventLoopDelay.samples).toBeGreaterThan(0);
  } finally { monitor.stop(); monitor.stop(); }
  expect(monitor.sample().stopped).toBe(true);
});
