import { Agent, request } from 'node:http';
import { performanceKinds, type PerformanceKind } from './performance-lab.js';
import { percentile, positiveInteger } from './performance-policy.js';

export interface LoadOptions { origin: string; kind: PerformanceKind; requests: number; concurrency: number; timeoutMs?: number; signal?: AbortSignal; }
export async function runLoad(options: LoadOptions) {
  const total = positiveInteger(options.requests, 200, 'requests');
  const concurrency = positiveInteger(options.concurrency, 16, 'concurrency');
  const timeoutMs = positiveInteger(options.timeoutMs ?? 2000, 10000, 'timeoutMs');
  const origin = new URL(options.origin);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', 'performance-lab'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('只接受本機或 Compose performance-lab origin');
  if (!performanceKinds.includes(options.kind)) throw new Error('kind 不合法');
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency, maxFreeSockets: concurrency });
  const times: number[] = []; const successful: number[] = [];
  const statuses: Record<string, number> = {};
  let started = 0; let timeouts = 0; let transportErrors = 0; let invalidResponses = 0;
  let active = 0; let peak = 0;
  const begun = performance.now(); const cpu = process.cpuUsage();
  const statusLabel = (value: number) => [200, 400, 404, 405, 429, 500, 503].includes(value) ? String(value) : 'other';
  async function attempt() {
    const start = performance.now(); active++; peak = Math.max(peak, active);
    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        let timedOut = false;
        const req = request(new URL(`/lab/work/${options.kind}`, origin), { agent, signal: options.signal }, res => {
          const chunks: Buffer[] = []; let bytes = 0;
          res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) { const error = new Error('response too large'); reject(error); req.destroy(error); } else chunks.push(chunk); });
          res.on('error', reject); res.on('aborted', () => reject(new Error('response interrupted')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        // 整個 attempt 的 deadline，不是只對 socket 閒置時間設限。
        const timer = setTimeout(() => { timedOut = true; req.destroy(new Error('deadline')); }, timeoutMs);
        req.on('error', error => { if (timedOut) timeouts++; reject(error); });
        req.once('close', () => clearTimeout(timer)); req.end();
      });
      const label = statusLabel(response.status); statuses[label] = (statuses[label] ?? 0) + 1;
      if (response.status === 200) {
        try { const value = JSON.parse(response.body); if (value?.data?.kind !== options.kind) throw new Error('wrong kind'); successful.push(performance.now() - start); }
        catch { invalidResponses++; }
      }
    } catch { transportErrors++; }
    finally { active--; times.push(performance.now() - start); }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (started < total && !options.signal?.aborted) { started++; await attempt(); }
    }));
  } finally { agent.destroy(); }
  const elapsedMs = performance.now() - begun; const cpuUsed = process.cpuUsage(cpu);
  const distribution = (values: number[]) => ({ count: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), maxMs: values.length ? Math.max(...values) : null });
  return { kind: options.kind, planned: total, started, unscheduled: total - started, concurrency, peak,
    elapsedMs, statuses, transportErrors, timeouts, invalidResponses, successes: successful.length,
    failureRate: started ? (started - successful.length) / started : null,
    attemptsPerSecond: elapsedMs > 0 ? started / (elapsedMs / 1000) : 0,
    successesPerSecond: elapsedMs > 0 ? successful.length / (elapsedMs / 1000) : 0,
    allAttempts: distribution(times), successful: distribution(successful), generatorCpuMs: (cpuUsed.user + cpuUsed.system) / 1000 };
}
