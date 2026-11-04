import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RequestHandler } from 'express';
import { HttpError } from './http.js';
const files: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/api-client.js': 'api-client.js', '/style.css': 'style.css', '/cors.html': 'cors.html', '/cors-demo.js': 'cors-demo.js' };
export function frontend(): RequestHandler {
  const compiledRoot = resolve(__dirname, '..', 'web');
  const directory = existsSync(compiledRoot) ? compiledRoot : resolve(__dirname, '..', '..', 'web');
  return (req, res, next) => {
    const file = files[req.path]; if (!file) { next(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); next(new HttpError(405, 'METHOD_NOT_ALLOWED', '此路由不支援該方法')); return; }
    const corsDemo = req.path === '/cors.html';
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'${corsDemo ? ' http://127.0.0.1:4028' : ''}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(resolve(directory, file), error => { if (error && !res.destroyed) next(new HttpError(500, 'INTERNAL_ERROR', '無法載入頁面')); });
  };
}
