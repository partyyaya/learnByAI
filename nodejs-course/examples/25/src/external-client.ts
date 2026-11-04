import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

export type ExternalErrorCode = 'UPSTREAM_NOT_FOUND' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_BAD_RESPONSE' | 'UPSTREAM_CANCELLED' | 'UPSTREAM_BUSY' | 'UPSTREAM_WRITE_UNCERTAIN';
const messages: Record<ExternalErrorCode, string> = {
  UPSTREAM_NOT_FOUND: '找不到外部資料', UPSTREAM_TIMEOUT: '外部服務超過期限', UPSTREAM_UNAVAILABLE: '外部服務暫時不可用',
  UPSTREAM_BAD_RESPONSE: '外部服務回應不符合契約', UPSTREAM_CANCELLED: '外部工作已取消', UPSTREAM_BUSY: '外部工作已達上限',
  UPSTREAM_WRITE_UNCERTAIN: '無法確認外部寫入結果',
};
export class ExternalError extends Error {
  constructor(readonly code: ExternalErrorCode) { super(messages[code]); }
}
class AttemptFailure extends Error {
  constructor(readonly code: ExternalErrorCode, readonly retryable: boolean, readonly retryAfterMs?: number) { super(code); }
}
export interface ExternalOptions {
  origin: string;
  totalTimeoutMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxResponseBytes?: number;
  maxConcurrent?: number;
  onAttempt?: (event: { method: 'GET' | 'POST'; attempt: number }) => void;
  onRetry?: (event: { attempt: number; delayMs: number }) => void;
}
export interface Topic { id: string; label: string }
const topicId = /^[a-z][a-z0-9-]{0,39}$/;
const topicSchema = z.object({ id: z.string().regex(topicId), label: z.string().trim().refine(value => [...value].length >= 1 && [...value].length <= 80) });
const deliverySchema = z.object({ accepted: z.literal(true) });

// HTTP-date 接受 IMF-fixdate 與兩種舊格式；不採用 Date.parse 的固定兩位年份分界。
function httpDate(value: string, wallNow: number): number | undefined {
  const imf = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/i.exec(value);
  const old = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/i.exec(value);
  const asc = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Za-z]{3}) ( [1-9]|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/i.exec(value);
  const parts = imf ?? old ?? (asc && [asc[0], asc[1], asc[3], asc[2], asc[7], asc[4], asc[5], asc[6]]);
  if (!parts) return undefined;
  const [, weekday, dayText, monthText, yearText, hourText, minuteText, secondText] = parts;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(monthText.toLowerCase());
  const day = Number(dayText), hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return undefined;
  let year = Number(yearText);
  const future = new Date(wallNow);
  future.setUTCFullYear(future.getUTCFullYear() + 50);
  if (old) year += Math.floor(future.getUTCFullYear() / 100) * 100;
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  if (old && date.getTime() > future.getTime()) { year -= 100; date.setUTCFullYear(year, month, day); }
  // 拒絕 31 Feb 等會被 Date 自動進位的無效日期；60 秒表示閏秒。
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day ||
    ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getUTCDay()] !== weekday.slice(0, 3).toLowerCase()) return undefined;
  return date.getTime() + (second === 60 ? 1000 : 0);
}

// Retry-After 不可被縮短成「比較方便的」延遲。超過剩餘預算時不再重試。
export function retryAfterMs(value: string | null, wallNow = Date.now()): number | undefined {
  if (value === null) return undefined;
  value = value.trim();
  if (/^[0-9]+$/.test(value)) return Number(value) * 1000;
  const parsed = httpDate(value, wallNow);
  return parsed === undefined ? undefined : Math.max(0, parsed - wallNow);
}
export function jitterDelay(attempt: number, base: number, random = Math.random): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('random 必須介於 0（含）與 1（不含）');
  return Math.floor(value * (Math.min(200, base * 2 ** (attempt - 1)) + 1));
}

export function createExternalClient(input: ExternalOptions) {
  const origin = new URL(input.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
    (origin.protocol === 'http:' && !['127.0.0.1', 'localhost', 'upstream'].includes(origin.hostname))) throw new Error('外部 origin 設定不合法');
  const options = { totalTimeoutMs: input.totalTimeoutMs ?? 800, attemptTimeoutMs: input.attemptTimeoutMs ?? 250,
    maxAttempts: input.maxAttempts ?? 3, baseDelayMs: input.baseDelayMs ?? 30,
    maxResponseBytes: input.maxResponseBytes ?? 4096, maxConcurrent: input.maxConcurrent ?? 4 };
  for (const [name, value, max] of [
    ['totalTimeoutMs', options.totalTimeoutMs, 5000], ['attemptTimeoutMs', options.attemptTimeoutMs, 5000],
    ['maxAttempts', options.maxAttempts, 3], ['baseDelayMs', options.baseDelayMs, 200],
    ['maxResponseBytes', options.maxResponseBytes, 65536], ['maxConcurrent', options.maxConcurrent, 16],
  ] as const) if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} 超出範圍`);
  if (options.attemptTimeoutMs > options.totalTimeoutMs) throw new Error('單次期限不能大於整體期限');
  const onAttempt = input.onAttempt; const onRetry = input.onRetry;
  let active = 0;

  async function discard(response: Response) {
    try { await response.body?.cancel(); } catch { /* 取消不用的 body 不覆蓋已知 status／媒體錯誤。 */ }
  }
  async function boundedJson(response: Response, transportCode: ExternalErrorCode): Promise<unknown> {
    const type = response.headers.get('content-type') ?? '';
    const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(type)?.[1]?.toLowerCase();
    if (type.split(';')[0]?.trim().toLowerCase() !== 'application/json' || (charset && !['utf-8', 'utf8'].includes(charset))) {
      await discard(response); throw new AttemptFailure('UPSTREAM_BAD_RESPONSE', false);
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > options.maxResponseBytes)) {
      await discard(response); throw new AttemptFailure('UPSTREAM_BAD_RESPONSE', false);
    }
    if (!response.body) throw new AttemptFailure('UPSTREAM_BAD_RESPONSE', false);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; let complete = false;
    try {
      while (true) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try { result = await reader.read(); }
        catch { throw new AttemptFailure(transportCode, true); }
        if (result.done) { complete = true; break; }
        size += result.value.byteLength;
        if (size > options.maxResponseBytes) throw new AttemptFailure('UPSTREAM_BAD_RESPONSE', false);
        chunks.push(result.value);
      }
    } finally {
      try { if (!complete) await reader.cancel(); } catch { /* 已失敗／取消的 body 不覆蓋主要錯誤。 */ }
      reader.releaseLock();
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { throw new AttemptFailure('UPSTREAM_BAD_RESPONSE', false); }
  }

  async function run<T>(method: 'GET' | 'POST', path: string, parse: (value: unknown) => T, caller?: AbortSignal, body?: object): Promise<T> {
    if (caller?.aborted) throw new ExternalError('UPSTREAM_CANCELLED');
    if (active >= options.maxConcurrent) throw new ExternalError('UPSTREAM_BUSY');
    active++;
    const total = new AbortController();
    const operation = caller ? AbortSignal.any([caller, total.signal]) : total.signal;
    const deadline = performance.now() + options.totalTimeoutMs;
    const totalTimer = setTimeout(() => total.abort(), options.totalTimeoutMs);
    const operationId = randomUUID();
    const cancellation = () => caller?.aborted ? new ExternalError('UPSTREAM_CANCELLED') : new ExternalError('UPSTREAM_TIMEOUT');
    try {
      for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
        if (operation.aborted || performance.now() >= deadline) throw cancellation();
        // 本機 observer 的程式錯誤不屬於可重試的外部網路故障。
        onAttempt?.({ method, attempt });
        const single = new AbortController(); let expired = false;
        const timer = setTimeout(() => { expired = true; single.abort(); }, Math.min(options.attemptTimeoutMs, Math.max(1, deadline - performance.now())));
        let failure: AttemptFailure;
        try {
          // 只傳必要欄位；不轉送使用者 Cookie、Authorization、CSRF 或任意 URL。
          let response: Response;
          try {
            response = await fetch(new URL(path, origin), { method, redirect: 'manual',
              signal: AbortSignal.any([operation, single.signal]),
              headers: { Accept: 'application/json', 'X-Course-Operation': operationId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
              ...(body ? { body: JSON.stringify(body) } : {}),
            });
          } catch { throw new AttemptFailure(method === 'POST' ? 'UPSTREAM_WRITE_UNCERTAIN' : 'UPSTREAM_UNAVAILABLE', true); }
          if (response.status !== (method === 'GET' ? 200 : 202)) {
            const retryable = [429, 502, 503, 504].includes(response.status);
            const wait = retryable ? retryAfterMs(response.headers.get('retry-after')) : undefined;
            await discard(response);
            throw new AttemptFailure(response.status === 404 ? 'UPSTREAM_NOT_FOUND' : retryable ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_BAD_RESPONSE', retryable, wait);
          }
          const value = await boundedJson(response, method === 'POST' ? 'UPSTREAM_WRITE_UNCERTAIN' : 'UPSTREAM_UNAVAILABLE');
          let result: T;
          try { result = parse(value); } catch { throw new AttemptFailure('UPSTREAM_BAD_RESPONSE', false); }
          if (operation.aborted || performance.now() >= deadline) throw cancellation();
          return result;
        } catch (error) {
          if (caller?.aborted || total.signal.aborted || performance.now() >= deadline) {
            if (method === 'POST') throw new ExternalError('UPSTREAM_WRITE_UNCERTAIN');
            throw cancellation();
          }
          if (error instanceof ExternalError) throw error;
          if (!expired && !(error instanceof AttemptFailure)) throw error;
          failure = expired ? new AttemptFailure(method === 'POST' ? 'UPSTREAM_WRITE_UNCERTAIN' : 'UPSTREAM_TIMEOUT', true)
            : error instanceof AttemptFailure ? error
            : new AttemptFailure(method === 'POST' ? 'UPSTREAM_WRITE_UNCERTAIN' : 'UPSTREAM_UNAVAILABLE', true);
        } finally { clearTimeout(timer); }
        if (method !== 'GET' || !failure.retryable || attempt === options.maxAttempts) throw new ExternalError(failure.code);
        const wait = failure.retryAfterMs ?? jitterDelay(attempt, options.baseDelayMs);
        if (!Number.isFinite(wait) || wait >= deadline - performance.now()) throw new ExternalError(failure.code);
        onRetry?.({ attempt, delayMs: wait });
        try { await delay(wait, undefined, { signal: operation }); }
        catch { throw cancellation(); }
      }
      throw new ExternalError('UPSTREAM_UNAVAILABLE');
    } finally { clearTimeout(totalTimer); active--; }
  }
  return {
    async getTopic(id: string, signal?: AbortSignal): Promise<Topic> {
      if (!topicId.test(id)) throw new Error('topic id 不合法');
      return run('GET', `/topics/${encodeURIComponent(id)}`, value => {
        const topic = topicSchema.parse(value);
        if (topic.id !== id) throw new Error('topic id 不符');
        return { id: topic.id, label: topic.label };
      }, signal);
    },
    async sendDelivery(deliveryId: string, signal?: AbortSignal) {
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(deliveryId)) throw new Error('delivery id 不合法');
      return run('POST', '/deliveries', value => deliverySchema.parse(value), signal, { deliveryId });
    },
    get active() { return active; },
  };
}
export type ExternalClient = ReturnType<typeof createExternalClient>;
