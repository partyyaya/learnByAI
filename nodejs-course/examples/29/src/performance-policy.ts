export function positiveInteger(value: number, maximum: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} 超過允許範圍`);
  return value;
}
export function createAdmission(maximum: number) {
  positiveInteger(maximum, 16, 'maxConcurrent');
  let active = 0; let peak = 0; let rejected = 0;
  return {
    acquire() {
      if (active >= maximum) { rejected++; return undefined; }
      active++; peak = Math.max(peak, active); let released = false;
      return () => { if (!released) { released = true; active--; } };
    },
    snapshot: () => ({ maximum, active, peak, rejected }),
  };
}
// 固定視窗從該來源第一次請求開始；滿表時不淘汰尚有效的來源來繞過限流。
export function createWindowLimiter(options: { limit: number; windowMs: number; maxSources: number; now?: () => number }) {
  positiveInteger(options.limit, 10000, 'limit'); positiveInteger(options.windowMs, 60000, 'windowMs');
  positiveInteger(options.maxSources, 1000, 'maxSources');
  const now = options.now ?? (() => performance.now());
  const sources = new Map<string, { expires: number; used: number }>();
  let rejected = 0;
  return {
    consume(source: string): { allowed: true } | { allowed: false; reason: 'RATE_LIMITED' | 'SOURCE_CAPACITY'; retryAfter: number } {
      const time = now();
      for (const [key, row] of sources) if (row.expires <= time) sources.delete(key);
      let row = sources.get(source);
      if (!row) {
        if (sources.size >= options.maxSources) {
          rejected++; return { allowed: false, reason: 'SOURCE_CAPACITY', retryAfter: Math.max(1, Math.ceil(Math.min(...[...sources.values()].map(item => item.expires - time)) / 1000)) };
        }
        row = { expires: time + options.windowMs, used: 0 }; sources.set(source, row);
      }
      if (row.used >= options.limit) { rejected++; return { allowed: false, reason: 'RATE_LIMITED', retryAfter: Math.max(1, Math.ceil((row.expires - time) / 1000)) }; }
      row.used++; return { allowed: true };
    },
    snapshot: () => ({ sources: sources.size, rejected, limit: options.limit, windowMs: options.windowMs }),
  };
}
export function percentile(values: readonly number[], quantile: number): number | null {
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) throw new Error('quantile 不合法');
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}
