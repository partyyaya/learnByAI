import type { IncomingMessage, ServerResponse } from 'node:http';
import { openapiDocument } from './openapi.js';
import type { ErrorReport } from './errors.js';
import type { ExportResult } from './export.js';

// sink 收到的已是白名單投影後的一行 JSON；false 表示未接受，不能無界排隊。
export type LogSink = (line: string) => void | boolean;
const methods = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'];
const routes = Object.keys(openapiDocument.paths);
const errorCodes = new Set([
  'INTERNAL_ERROR', 'INVALID_URL', 'INVALID_ENCODING', 'INVALID_JSON', 'INVALID_QUERY', 'VALIDATION_ERROR',
  'PAYLOAD_TOO_LARGE', 'REQUEST_INTERRUPTED', 'REQUEST_TIMEOUT', 'UNSUPPORTED_MEDIA_TYPE',
  'NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED', 'VERSION_CONFLICT', 'INVALID_STATE', 'VERSION_LIMIT',
  'USER_ALREADY_EXISTS', 'AUTH_BUSY', 'RATE_LIMITED', 'INVALID_CREDENTIALS', 'CSRF_REJECTED', 'UNSUPPORTED_ENCODING',
  'METHOD_NOT_ALLOWED', 'EXPORT_NOT_FOUND', 'NOT_READY', 'SHUTTING_DOWN',
]);
const phases = ['before-response', 'streaming', 'ended', 'disconnected'];
const events = ['draining', 'http-drained', 'closed', 'deadline'];
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : undefined;
const count = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const status = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
const buckets = [0.01, 0.1, 0.5, 1, 5, Infinity];
interface Series { route: string; method: string; statusGroup: string; outcome: string; count: number; sum: number; buckets: number[]; }

export function routeLabel(target: string): string {
  // 只記文件內的有限樣板；不保留 query、ID 或未知路徑。
  const path = target.split('?')[0];
  if (path === '/api/articles/') return '/api/articles';
  return routes.find(route => new RegExp(`^${route.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{id\}/g, '[^/]+')}$`).test(path)) ?? 'unmatched';
}
export function createObservability(sink: LogSink = () => {}) {
  const series = new Map<string, Series>();
  let inFlight = 0; let dropped = 0;
  function emit(event: string, fields: Record<string, unknown>, level = 'info') {
    try {
      if (sink(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })) === false) dropped++;
    } catch { dropped++; } // 日誌失敗不能使文章交易失敗，也不印出 sink 的例外。
  }
  return {
    observe(req: IncomingMessage, res: ServerResponse, requestId: string) {
      const start = performance.now(); const route = routeLabel(req.url ?? '');
      const method = methods.includes(req.method ?? '') ? req.method! : 'OTHER';
      inFlight++;
      const finish = () => report('finished'); const close = () => report('interrupted');
      const report = (outcome: 'finished' | 'interrupted') => {
        res.off('finish', finish); res.off('close', close); inFlight--;
        const seconds = Math.max(0, performance.now() - start) / 1000;
        const httpStatus = res.headersSent ? status(res.statusCode) : undefined;
        const statusGroup = httpStatus ? `${Math.floor(httpStatus / 100)}xx` : 'none';
        const key = JSON.stringify([route, method, statusGroup, outcome]);
        const row = series.get(key) ?? { route, method, statusGroup, outcome, count: 0, sum: 0, buckets: buckets.map(() => 0) };
        row.count++; row.sum += seconds;
        buckets.forEach((bound, i) => { if (seconds <= bound) row.buckets[i]++; });
        series.set(key, row);
        emit('request_completed', { requestId: uuid(requestId), route, method, outcome, httpStatus, durationMs: seconds * 1000 });
      };
      res.once('finish', finish); res.once('close', close);
    },
    error(report: ErrorReport) {
      emit('http_error', { requestId: uuid(report.requestId), errorStatus: status(report.status), httpStatus: status(report.httpStatus),
        code: errorCodes.has(report.code) ? report.code : 'OTHER_ERROR',
        phase: phases.includes(report.phase) ? report.phase : 'before-response' }, 'warn');
    },
    exported(result: ExportResult, requestId?: string) {
      emit('export_finished', { requestId: uuid(requestId), outcome: result.outcome === 'complete' ? 'complete' : 'interrupted',
        bytesRead: count(result.bytesRead), fileClosed: result.fileClosed === true,
        ...(result.errorCode ? { code: ['ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE'].includes(result.errorCode) ? result.errorCode : 'STREAM_FAILED' } : {}) });
    },
    lifecycle(event: string) { emit('shutdown', { state: events.includes(event) ? event : 'unknown' }); },
    listening(port: number) { emit('listening', { port: count(port) }); },
    signal(signal: NodeJS.Signals) { emit('signal', { signal: signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM' }); },
    failed(event: 'startup_failed' | 'shutdown_failed') { emit(event, {}, 'error'); },
    metrics(pendingWork: number, draining: boolean) {
      const lines = [
        '# HELP course_http_requests_total Completed or interrupted HTTP responses.', '# TYPE course_http_requests_total counter',
      ];
      const labels = (row: Series) => `route="${row.route}",method="${row.method}",status_group="${row.statusGroup}",outcome="${row.outcome}"`;
      for (const row of series.values()) lines.push(`course_http_requests_total{${labels(row)}} ${row.count}`);
      lines.push('# HELP course_http_duration_seconds Time until response finish or close.', '# TYPE course_http_duration_seconds histogram');
      for (const row of series.values()) {
        buckets.forEach((bound, i) => lines.push(`course_http_duration_seconds_bucket{${labels(row)},le="${bound === Infinity ? '+Inf' : bound}"} ${row.buckets[i]}`));
        lines.push(`course_http_duration_seconds_sum{${labels(row)}} ${row.sum}`, `course_http_duration_seconds_count{${labels(row)}} ${row.count}`);
      }
      for (const [name, help, value] of [
        ['http_in_flight', 'Open HTTP responses, including this scrape.', inFlight],
        ['work_pending', 'Registered lifecycle tickets; may overlap.', count(pendingWork)],
        ['draining', 'One after shutdown starts.', draining ? 1 : 0],
        ['log_dropped_total', 'Records rejected by or throwing from the sink.', dropped],
      ] as const) lines.push(`# HELP course_${name} ${help}`, `# TYPE course_${name} ${name.endsWith('_total') ? 'counter' : 'gauge'}`, `course_${name} ${value}`);
      return lines.join('\n') + '\n';
    },
  };
}
export type Observability = ReturnType<typeof createObservability>;
