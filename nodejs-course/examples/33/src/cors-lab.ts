import { createServer } from 'node:http';
// 獨立教學 lab；不提供 Session 或文章資料，不掛正式 API。
export function createCorsLab(allowedOrigin: string) {
  const stats = { preflights: 0, accepted: 0, denied: 0 };
  const server = createServer((req, res) => {
    req.resume(); req.on('error', () => res.destroy()); res.on('error', () => res.destroy());
    res.setHeader('Vary', 'Origin'); res.setHeader('Cache-Control', 'no-store');
    if (req.url !== '/lab/state') { res.writeHead(404).end(); return; }
    if (req.headers.origin !== allowedOrigin) { stats.denied++; res.writeHead(403).end(); return; }
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin); res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      stats.preflights++;
      if (req.headers['access-control-request-method'] !== 'GET' || req.headers['access-control-request-headers']?.toLowerCase() !== 'x-lab-token') { res.writeHead(403).end(); return; }
      res.setHeader('Access-Control-Allow-Methods', 'GET'); res.setHeader('Access-Control-Allow-Headers', 'X-Lab-Token'); res.writeHead(204).end(); return;
    }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET, OPTIONS' }).end(); return; }
    stats.accepted++; res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'cors_lab=1; HttpOnly; SameSite=Lax; Path=/' }); res.end('{"data":{"ok":true}}');
  });
  return { server, stats };
}
if (require.main === module) createCorsLab('http://127.0.0.1:3033').server.listen(4033, '0.0.0.0');
