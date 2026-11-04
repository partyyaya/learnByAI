import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

// 可控制的本機外部服務；不匯入文章 AppModule，不連資料庫，不對外寄送任何資料。
export async function createReferenceUpstream(options: { host?: string; port?: number } = {}) {
  const operations = new Map<string, number>();
  const stats = { requests: 0, active: 0, aborted: 0, deliveries: 0, credentialForwarded: false, attempts: {} as Record<string, number> };
  const known = new Set(['ok', 'retry', 'retry-after', 'long-retry-after', 'unavailable', 'not-found', 'redirect', 'slow-headers',
    'slow-body', 'oversize-header', 'oversize-stream', 'bad-json', 'bad-utf8', 'wrong-type', 'wrong-shape', 'wrong-id', 'drop', 'status-400', 'status-500', 'retry-error-body']);
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://upstream.local').pathname;
      if (path === '/__lab/stats' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(stats)); return;
      }
      stats.requests++; stats.active++;
      stats.credentialForwarded ||= Boolean(req.headers.cookie || req.headers.authorization || req.headers['x-csrf-token']);
      let recorded = false;
      const finish = () => { if (recorded) return; recorded = true; stats.active--; if (!res.writableFinished) stats.aborted++; };
      res.once('finish', finish); res.once('close', finish); req.on('error', () => res.destroy());
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body));
      };
      if (path === '/deliveries' && req.method === 'POST') {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 2048) { json(413, {}); return; }
          chunks.push(chunk);
        }
        let body: { deliveryId?: unknown };
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(400, {}); return; }
        if (typeof body?.deliveryId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(body.deliveryId)) { json(400, {}); return; }
        if (body.deliveryId.startsWith('reject-')) { json(503, {}); return; }
        stats.deliveries++; // 刻意先產生副作用，再模擬回應遺失。
        if (body.deliveryId.startsWith('lost-')) { req.socket.destroy(); return; }
        json(202, { accepted: true }); return;
      }
      const match = /^\/topics\/([a-z][a-z0-9-]{0,39})$/.exec(path);
      if (!match || req.method !== 'GET') { json(404, {}); return; }
      const id = match[1]!;
      const key = known.has(id) ? id : 'other'; stats.attempts[key] = (stats.attempts[key] ?? 0) + 1;
      const header = req.headers['x-course-operation'];
      const operation = typeof header === 'string' && /^[a-f0-9-]{36}$/.test(header) ? header : randomUUID();
      const operationKey = `${id}:${operation}`;
      if (!operations.has(operationKey) && operations.size >= 1000) operations.delete(operations.keys().next().value!);
      const attempt = (operations.get(operationKey) ?? 0) + 1; operations.set(operationKey, attempt);
      if (id === 'slow-headers') return;
      if (id === 'drop') { req.socket.destroy(); return; }
      if (id === 'not-found') { json(404, { secret: 'SECRET upstream detail' }); return; }
      if (id === 'redirect') { res.writeHead(302, { Location: '/topics/ok' }); res.end(); return; }
      if (id === 'retry' && attempt <= 2) { json(503, { secret: 'SECRET retry' }); return; }
      if (id === 'retry-after' && attempt === 1) { json(429, {}, { 'Retry-After': '0' }); return; }
      if (id === 'long-retry-after') { json(429, {}, { 'Retry-After': '3600' }); return; }
      if (id === 'unavailable') { json(503, { secret: 'SECRET outage' }); return; }
      if (id === 'status-400' || id === 'status-500') { json(id === 'status-400' ? 400 : 500, {}); return; }
      if (id === 'retry-error-body') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.flushHeaders(); return; }
      if (id === 'slow-body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"id":'); return; }
      if (id === 'oversize-header') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '5000' }); res.end('x'.repeat(5000)); return; }
      if (id === 'oversize-stream') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('x'.repeat(5000)); res.end(); return; }
      if (id === 'bad-json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{SECRET'); return; }
      if (id === 'bad-utf8') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(Buffer.from([0xc3, 0x28])); return; }
      if (id === 'wrong-type') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('SECRET'); return; }
      if (id === 'wrong-shape') { json(200, { id, label: 42 }); return; }
      if (id === 'wrong-id') { json(200, { id: 'other', label: '錯誤 ID' }); return; }
      json(200, { id, label: ' 參考主題 ', internal: 'SECRET upstream field' });
    })().catch(() => { if (res.headersSent) res.destroy(); else { res.writeHead(500); res.end(); } });
  });
  server.listen(options.port ?? 0, options.host ?? '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('upstream 未取得 port');
  let closing: Promise<void> | undefined;
  function close() {
    return closing ??= new Promise<void>((resolve, reject) => {
      server.closeAllConnections(); // 本機故障伺服器可能刻意永遠不回應，清理時明確斷線。
      server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    });
  }
  return { server, origin: `http://127.0.0.1:${address.port}`, stats, close };
}
if (require.main === module) {
  void (async () => {
    const port = Number(process.env.PORT ?? '4000'); const host = process.env.HOST ?? '127.0.0.1';
    if (!Number.isInteger(port) || port < 0 || port > 65535 || !['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('設定不合法');
    const upstream = await createReferenceUpstream({ port, host });
    console.log('REFERENCE_UPSTREAM_READY');
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void upstream.close(); });
  })().catch(() => { console.error('REFERENCE_UPSTREAM_FAILED'); process.exitCode = 1; });
}
