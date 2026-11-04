import { request } from 'node:http';
export function checkReadiness(port: number, timeoutMs = 3000): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise(resolve => {
    const req = request({ hostname: '127.0.0.1', port, path: '/health/ready', agent: false }, res => {
      let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2048) { resolve(false); req.destroy(); } });
      res.on('error', () => resolve(false));
      res.on('end', () => resolve(res.statusCode === 200));
    });
    const timer = setTimeout(() => { resolve(false); req.destroy(); }, timeoutMs);
    req.once('close', () => clearTimeout(timer)); req.on('error', () => resolve(false)); req.end();
  });
}
if (require.main === module) void checkReadiness(Number(process.env.PORT ?? 3000)).then(ready => { process.exitCode = ready ? 0 : 1; });
