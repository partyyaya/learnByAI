import { expect, test } from '@jest/globals';
import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import { setImmediate as immediate } from 'node:timers/promises';
import { createShutdown, ShutdownTimeoutError } from '../src/shutdown.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return address.port;
}

test('等待已接受的回應及回應後清理，最後才關閉共用資源；重複 shutdown 共用 Promise', async () => {
  const entered = deferred(); const respond = deferred(); const cleaned = deferred();
  const events: string[] = [];
  const server = createServer((_req, res) => {
    void lifecycle.track((async () => {
      entered.resolve(); await respond.promise; res.end('done');
      await cleaned.promise; events.push('request-cleaned');
    })());
  });
  const lifecycle = createShutdown(server, { closeResources: async () => { events.push('resources-closed'); } });
  const port = await listen(server);
  const response = new Promise<string>((resolve, reject) => {
    const req = request({ port, host: '127.0.0.1', agent: false }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body)); res.on('error', reject);
    }); req.on('error', reject); req.end();
  });
  try {
    await entered.promise;
    const stopped = lifecycle.shutdown();
    expect(lifecycle.shutdown()).toBe(stopped);
    expect(lifecycle.isDraining).toBe(true);
    respond.resolve(); expect(await response).toBe('done');
    expect(events).toEqual([]);
    cleaned.resolve(); await stopped;
    expect(events).toEqual(['request-cleaned', 'resources-closed']);
    expect(server.listening).toBe(false);
  } finally { respond.resolve(); cleaned.resolve(); server.closeAllConnections(); await lifecycle.shutdown(); }
});

test('期限也包含共用資源清理，超時會送出取消信號', async () => {
  const server = createServer(); const gate = deferred();
  let signal: AbortSignal | undefined;
  const lifecycle = createShutdown(server, {
    timeoutMs: 30,
    closeResources: async value => { signal = value; await gate.promise; },
  });
  await listen(server);
  try {
    await expect(lifecycle.shutdown()).rejects.toBeInstanceOf(ShutdownTimeoutError);
    expect(signal?.aborted).toBe(true);
  } finally { gate.resolve(); }
});

test('共用資源關閉失敗會回報失敗，不偽裝成正常停止', async () => {
  const server = createServer();
  const lifecycle = createShutdown(server, { closeResources: async () => { throw new Error('close failed'); } });
  await listen(server);
  await expect(lifecycle.shutdown()).rejects.toThrow('close failed');
});

test('已失敗且由呼叫端處理的工作不會阻止關閉', async () => {
  const server = createServer(); const lifecycle = createShutdown(server);
  await listen(server);
  await expect(lifecycle.track(Promise.reject(new Error('request failed')))).rejects.toThrow('request failed');
  await lifecycle.shutdown();
});

test('停止前已接受的請求，在 draining 後才登記工作且離線，仍須等工作完成', async () => {
  const accepted = deferred(); const started = deferred(); const finished = deferred();
  let resourcesClosed = false;
  const server = createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      // 模擬慢速 body 讀完後才進入 Service；此時停止流程已開始。
      void lifecycle.track(finished.promise);
      started.resolve(); res.destroy();
    });
    accepted.resolve();
  });
  const lifecycle = createShutdown(server, { closeResources: async () => { resourcesClosed = true; } });
  const port = await listen(server);
  const req = request({ port, host: '127.0.0.1', method: 'POST', agent: false, headers: { 'Content-Length': '1' } });
  req.on('error', () => {}); req.flushHeaders();
  try {
    await accepted.promise;
    const httpClosed = once(server, 'close');
    const stopped = lifecycle.shutdown();
    req.end('x'); await started.promise; await httpClosed; await immediate();
    expect(resourcesClosed).toBe(false);
    finished.resolve(); await stopped;
    expect(resourcesClosed).toBe(true);
  } finally { req.destroy(); finished.resolve(); server.closeAllConnections(); await lifecycle.shutdown(); }
});
