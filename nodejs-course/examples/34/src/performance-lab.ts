import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createShutdown } from './shutdown.js';
import { createAdmission, createWindowLimiter, positiveInteger } from './performance-policy.js';
import { createMeasurements, cpuDigest } from './performance-measurement.js';

export const performanceKinds = ['baseline', 'cpu', 'yield', 'db', 'external'] as const;
export type PerformanceKind = typeof performanceKinds[number];
export interface PerformanceOptions {
  connectionString: string;
  maxConcurrent?: number;
  poolMax?: number;
  cpuIterations?: number;
  rateLimit?: number;
  rateWindowMs?: number;
  // 僅可信組裝／測試接點，不從 HTTP 接受 callback、SQL、URL 或運算量。
  beforeExternalResponse?: (signal: AbortSignal) => Promise<void>;
  onWorkStarted?: (kind: PerformanceKind) => void;
  onEvent?: (event: string) => void;
}
function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  const text = JSON.stringify(value); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(res.req.method === 'HEAD' ? undefined : text);
}
export async function createPerformanceLab(options: PerformanceOptions) {
  const maximum = positiveInteger(options.maxConcurrent ?? 4, 16, 'maxConcurrent');
  const poolMax = positiveInteger(options.poolMax ?? 2, 8, 'poolMax');
  const iterations = positiveInteger(options.cpuIterations ?? 12000000, 50000000, 'cpuIterations');
  const admission = createAdmission(maximum);
  const limiter = createWindowLimiter({ limit: options.rateLimit ?? 1200, windowMs: options.rateWindowMs ?? 60000, maxSources: 1000 });
  const url = new URL(options.connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('只接受 PostgreSQL');
  url.searchParams.delete('schema');
  const pool = new Pool({ connectionString: url.toString(), max: poolMax, connectionTimeoutMillis: 2000, statement_timeout: 1000, application_name: 'course25-performance-lab' });
  const measurements = createMeasurements();
  let idleErrors = 0; let upstreamActive = 0; let upstreamReceived = 0; let upstreamAborted = 0;
  const upstreamTasks = new Set<Promise<void>>();
  pool.on('error', () => { idleErrors++; }); // 不輸出 driver 訊息或連線字串。
  const upstream = createServer((req, res) => {
    req.on('error', () => res.destroy()); res.on('error', () => res.destroy()); req.resume();
    if (req.method !== 'GET' || req.url !== '/wait') { res.writeHead(404).end(); return; }
    const controller = new AbortController(); const close = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', close); upstreamActive++; upstreamReceived++;
    const task = (async () => {
      try { await (options.beforeExternalResponse?.(controller.signal) ?? delay(50, undefined, { signal: controller.signal })); json(res, 200, { data: { ok: true } }); }
      catch { upstreamAborted++; }
      finally { res.off('close', close); upstreamActive--; }
    })();
    upstreamTasks.add(task); void task.then(() => upstreamTasks.delete(task));
  });
  const stages = Object.fromEntries(['poolWait', 'dbQuery', 'external', 'cpu'].map(key => [key, { count: 0, sumMs: 0, maxMs: 0 }]));
  function stage(name: keyof typeof stages, started: number) {
    const value = Math.max(0, performance.now() - started); const row = stages[name]; row.count++; row.sumMs += value; row.maxMs = Math.max(row.maxMs, value);
  }
  let upstreamOrigin = '';
  let poolClosed = false; let resourcesClosed = false;
  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    req.on('error', () => res.destroy()); res.on('error', () => res.destroy()); req.resume();
    const requestId = randomUUID(); res.setHeader('X-Request-ID', requestId);
    const failure = (status: number, code: string, message: string) => json(res, status, { error: { code, message, details: [] }, requestId });
    if (lifecycle.isDraining) { failure(503, 'SHUTTING_DOWN', '實驗正在關閉'); return; }
    const target = req.url ?? '';
    const work = performanceKinds.find(kind => target === `/lab/work/${kind}`);
    if (!work && !['/health/live', '/lab/stats'].includes(target)) { failure(target.includes('?') ? 400 : 404, target.includes('?') ? 'INVALID_QUERY' : 'NOT_FOUND', '只接受固定實驗路徑，無 query'); return; }
    if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.setHeader('Allow', 'GET, HEAD'); failure(405, 'METHOD_NOT_ALLOWED', '只接受 GET／HEAD'); return; }
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
      res.setHeader('Connection', 'close'); failure(400, 'UNEXPECTED_BODY', '不接受 request body'); return;
    }
    if (target === '/health/live') { json(res, 200, { data: { status: 'ok' } }); return; }
    if (target === '/lab/stats') { json(res, 200, { data: snapshot() }); return; }
    const rate = limiter.consume(req.socket.remoteAddress ?? 'unknown'); // 不相信 X-Forwarded-For。
    if (!rate.allowed) {
      res.setHeader('Retry-After', rate.retryAfter); failure(rate.reason === 'RATE_LIMITED' ? 429 : 503, rate.reason, '實驗請求超過來源限制'); return;
    }
    const release = admission.acquire();
    if (!release) { res.setHeader('Retry-After', '1'); failure(503, 'LAB_BUSY', '實驗進行中工作已滿'); return; }
    const controller = new AbortController();
    const close = () => { if (!res.writableFinished) controller.abort(); }; res.once('close', close);
    const run = async () => {
      try {
        options.onWorkStarted?.(work!);
        let value: number | undefined;
        if (work === 'cpu' || work === 'yield') {
          const started = performance.now();
          try { value = await cpuDigest(iterations, work === 'yield', controller.signal); } finally { stage('cpu', started); }
        } else if (work === 'db') {
          const waiting = performance.now();
          const client = await pool.connect(); stage('poolWait', waiting);
          const started = performance.now();
          try { await client.query('SELECT pg_catalog.pg_sleep($1::double precision)', [0.05]); }
          finally { stage('dbQuery', started); client.release(); }
          // 離線不取消 SQL；capacity 與 pool 都等真正 query 完成才釋放。
        } else if (work === 'external') {
          const started = performance.now();
          try {
            const response = await fetch(upstreamOrigin + '/wait', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]), redirect: 'error' });
            const body = await response.text(); // 自有固定上游只回很小的 JSON，非通用外部 client。
            if (response.status !== 200 || body !== '{"data":{"ok":true}}') throw new Error('invalid controlled response');
          } finally { stage('external', started); }
        }
        json(res, 200, { data: { kind: work, ...(value === undefined ? {} : { digest: value }) } });
      } catch { failure(500, 'LAB_WORK_FAILED', '實驗工作未完成'); }
      finally { res.off('close', close); release(); }
    };
    void lifecycle.track(run());
  });
  const lifecycle = createShutdown(server, { timeoutMs: 5000, onEvent: options.onEvent, closeResources: async () => {
    try { await new Promise<void>(resolve => upstream.close(() => resolve())); await Promise.allSettled([...upstreamTasks]); }
    finally { try { await pool.end(); poolClosed = true; } finally { measurements.stop(); resourcesClosed = true; } }
  } });
  function snapshot() {
    return { admission: admission.snapshot(), rate: limiter.snapshot(), pool: { maximum: poolMax, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, idleErrors, closed: poolClosed },
      upstream: { active: upstreamActive, received: upstreamReceived, aborted: upstreamAborted }, stages: structuredClone(stages),
      measurements: measurements.sample(), pendingWork: lifecycle.pendingWork, resourcesClosed };
  }
  try {
    await pool.query('SELECT 1');
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    return { server, lifecycle, snapshot };
  } catch (error) { await lifecycle.shutdown(); throw error; }
}
async function main() {
  const portText = process.env.PORT ?? '3334'; const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port > 65535 || !['127.0.0.1', '0.0.0.0'].includes(host) || !process.env.DATABASE_URL) throw new Error('設定不合法');
  const integer = (name: string, fallback: number) => { const raw = process.env[name]; if (raw === undefined) return fallback; if (!/^\d+$/.test(raw)) throw new Error('設定不合法'); return Number(raw); };
  const lab = await createPerformanceLab({ connectionString: process.env.DATABASE_URL, maxConcurrent: integer('PERF_MAX_CONCURRENT', 4), poolMax: integer('PERF_POOL_MAX', 2), rateLimit: integer('PERF_RATE_LIMIT', 1200),
    onEvent: state => console.log(JSON.stringify({ event: 'performance_shutdown', state })) });
  try {
    lab.server.listen(port, host); await once(lab.server, 'listening');
    console.log(JSON.stringify({ event: 'performance_listening', port: (lab.server.address() as { port: number }).port }));
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void lab.lifecycle.shutdown().catch(() => { console.error('{"event":"performance_shutdown_failed"}'); process.exit(1); }); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) { await lab.lifecycle.shutdown(); throw error; }
}
if (require.main === module) void main().catch(() => { console.error('{"event":"performance_startup_failed"}'); process.exitCode = 1; });
