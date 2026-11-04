import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { createExternalClient } from '../src/external-client.js';
import { createReferenceUpstream } from '../src/reference-upstream.js';
import { waitUntil } from './external-test-utils.js';

let upstream: Awaited<ReturnType<typeof createReferenceUpstream>>;
beforeEach(async () => { upstream = await createReferenceUpstream(); });
afterEach(async () => { await upstream?.close(); });
const client = (options: Partial<Parameters<typeof createExternalClient>[0]> = {}) => createExternalClient({ origin: upstream.origin, ...options });

test('只回 id／label 公開投影，修剪 label，沒有轉送任何認證欄位', async () => {
  const external = client();
  expect(await external.getTopic('ok')).toEqual({ id: 'ok', label: '參考主題' });
  expect(upstream.stats.requests).toBe(1); expect(upstream.stats.credentialForwarded).toBe(false); expect(external.active).toBe(0);
});
test('GET 的兩次 503 可重試至第三次成功，同一邏輯操作使用同一追蹤 ID', async () => {
  const attempts: number[] = []; const external = client({ onAttempt: event => attempts.push(event.attempt) });
  expect(await external.getTopic('retry')).toEqual({ id: 'retry', label: '參考主題' });
  expect(attempts).toEqual([1, 2, 3]); expect(upstream.stats.attempts.retry).toBe(3);
  await external.getTopic('retry'); expect(upstream.stats.attempts.retry).toBe(6); // 新操作不沿用上次重試計數。
});
test('429 Retry-After:0 可有限重試，過長 Retry-After 不提早重送', async () => {
  const external = client(); await external.getTopic('retry-after');
  expect(upstream.stats.attempts['retry-after']).toBe(2);
  await expect(external.getTopic('long-retry-after')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  expect(upstream.stats.attempts['long-retry-after']).toBe(1);
});
test('503 重試耗盡只嘗試三次，錯誤不含遠端原文或 URL', async () => {
  const external = client();
  try { await external.getTopic('unavailable'); throw new Error('應失敗'); }
  catch (error) {
    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', message: '外部服務暫時不可用' });
    expect(String(error)).not.toContain('SECRET'); expect(String(error)).not.toContain(upstream.origin);
  }
  expect(upstream.stats.attempts.unavailable).toBe(3); expect(external.active).toBe(0);
});
test.each(['not-found', 'status-400', 'status-500', 'bad-json', 'bad-utf8', 'wrong-type', 'wrong-shape', 'wrong-id', 'oversize-header', 'oversize-stream'])(
  '%s 不重試，body／型別／大小錯誤不作暫時性故障', async id => {
    await expect(client().getTopic(id)).rejects.toMatchObject({ code: id === 'not-found' ? 'UPSTREAM_NOT_FOUND' : 'UPSTREAM_BAD_RESPONSE' });
    expect(upstream.stats.attempts[id]).toBe(1);
  },
);
test('redirect 不自動跟隨，不能透過 Location 改變目的地', async () => {
  await expect(client().getTopic('redirect')).rejects.toMatchObject({ code: 'UPSTREAM_BAD_RESPONSE' });
  expect(upstream.stats.attempts.redirect).toBe(1); expect(upstream.stats.attempts.ok).toBeUndefined();
});
test.each(['slow-headers', 'slow-body'])('%s 的讀取受單次期限控制，沒有只限制取得 headers', async id => {
  const external = client({ maxAttempts: 1, totalTimeoutMs: 1000, attemptTimeoutMs: 80 });
  await expect(external.getTopic(id)).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  await waitUntil(() => upstream.stats.active === 0);
  expect(upstream.stats.attempts[id]).toBe(1); expect(upstream.stats.aborted).toBe(1); expect(external.active).toBe(0);
});
test('整體期限涵蓋多次嘗試，不為每次重試重新開始整體預算', async () => {
  const external = client({ totalTimeoutMs: 150, attemptTimeoutMs: 100, baseDelayMs: 1 });
  await expect(external.getTopic('slow-body')).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  expect(upstream.stats.attempts['slow-body']).toBeLessThanOrEqual(2);
  await waitUntil(() => upstream.stats.active === 0); expect(external.active).toBe(0);
});
test('不需讀取的 503 body 被取消，不因遠端永不結束的錯誤 body 卡住重試', async () => {
  const external = client();
  await expect(external.getTopic('retry-error-body')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  await waitUntil(() => upstream.stats.active === 0);
  expect(upstream.stats.attempts['retry-error-body']).toBe(3); expect(upstream.stats.aborted).toBe(3);
});
test('傳輸中斷的 GET 可有限重試，不造成無界循環', async () => {
  await expect(client().getTopic('drop')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  expect(upstream.stats.attempts.drop).toBe(3);
});
test('已取消的呼叫完全不發送，非法 ID 也不能成為任意 URL', async () => {
  const external = client();
  await expect(external.getTopic('ok', AbortSignal.abort())).rejects.toMatchObject({ code: 'UPSTREAM_CANCELLED' });
  await expect(external.getTopic('../private')).rejects.toThrow('topic id 不合法');
  expect(upstream.stats.requests).toBe(0); expect(external.active).toBe(0);
});
test('取得 headers 前或讀 body 時，caller abort 都取消真正 fetch', async () => {
  for (const id of ['slow-headers', 'slow-body']) {
    const external = client({ totalTimeoutMs: 2000, attemptTimeoutMs: 1500 }); const caller = new AbortController();
    const pending = external.getTopic(id, caller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_CANCELLED' });
    await waitUntil(() => Boolean(upstream.stats.attempts[id])); caller.abort(); await rejected;
    await waitUntil(() => upstream.stats.active === 0); expect(external.active).toBe(0);
    expect(upstream.stats.attempts[id]).toBe(1);
  }
});
test('退避等待也可取消，釋放容量且不再送下一次請求', async () => {
  const caller = new AbortController();
  const external = client({ onRetry: () => caller.abort() });
  await expect(external.getTopic('unavailable', caller.signal)).rejects.toMatchObject({ code: 'UPSTREAM_CANCELLED' });
  expect(upstream.stats.attempts.unavailable).toBe(1); expect(external.active).toBe(0);
});
test('容量上限不無界排隊，取消工作後可再次使用', async () => {
  const caller = new AbortController(); const external = client({ maxConcurrent: 1, totalTimeoutMs: 2000, attemptTimeoutMs: 1500 });
  const pending = external.getTopic('slow-body', caller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_CANCELLED' });
  try {
    await waitUntil(() => upstream.stats.active === 1);
    await expect(external.getTopic('ok')).rejects.toMatchObject({ code: 'UPSTREAM_BUSY' });
  } finally { caller.abort(); await rejected; }
  expect(await external.getTopic('ok')).toEqual({ id: 'ok', label: '參考主題' });
});
test('POST 回應遺失：外部寫入已發生，只嘗試一次且回報結果不確定', async () => {
  const attempts: number[] = []; const external = client({ onAttempt: event => attempts.push(event.attempt) });
  await expect(external.sendDelivery('lost-example')).rejects.toMatchObject({ code: 'UPSTREAM_WRITE_UNCERTAIN' });
  expect(upstream.stats.deliveries).toBe(1); expect(attempts).toEqual([1]);
  expect(await external.sendDelivery('ack-example')).toEqual({ accepted: true }); expect(upstream.stats.deliveries).toBe(2);
});
test('POST 即使收到 503 也不自動重試', async () => {
  const attempts: number[] = []; const external = client({ onAttempt: event => attempts.push(event.attempt) });
  await expect(external.sendDelivery('reject-example')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  expect(attempts).toEqual([1]); expect(upstream.stats.deliveries).toBe(0);
});
test('本機 callback 程式錯誤不被誤認為網路故障或自動重試', async () => {
  const failure = new TypeError('local observer failure'); let calls = 0;
  const external = client({ onAttempt: () => { calls++; throw failure; } });
  await expect(external.getTopic('ok')).rejects.toBe(failure);
  expect(calls).toBe(1); expect(upstream.stats.requests).toBe(0); expect(external.active).toBe(0);
});
