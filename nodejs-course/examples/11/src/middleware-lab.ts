import express, { type ErrorRequestHandler } from 'express';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { setImmediate as immediate } from 'node:timers/promises';

export async function runLab(mode: 'async' | 'stop' | 'error'): Promise<string[]> {
  const events: string[] = [];
  const app = express();
  app.use((_req, res, next) => {
    events.push('before next');
    res.once('finish', () => events.push('response finish'));
    next();
    events.push('after next'); // 這裡不代表回應完成。
  });
  app.get('/', (_req, res, next) => {
    if (mode === 'stop') { events.push('short circuit'); res.status(403).end(); return; }
    if (mode === 'error') { events.push('next(error)'); next(new Error('lab')); return; }
    next();
  }, async (_req, res) => {
    events.push('handler start');
    await immediate();
    events.push('handler end'); res.end('ok');
  });
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => {
    events.push('error handler'); res.status(400).end();
  };
  app.use(errors);
  const server = createServer(app);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    await new Promise<void>((resolve, reject) => {
      const req = get({ host: '127.0.0.1', port: address.port, agent: false }, res => {
        res.resume(); res.on('end', resolve); res.on('error', reject);
      }); req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('lab timed out')));
    });
    return events;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    });
  }
}

if (require.main === module) {
  void (async () => {
    for (const mode of ['async', 'stop', 'error'] as const) console.log(JSON.stringify({ mode, events: await runLab(mode) }));
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
