import express, { Router, type RequestHandler, type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';
import { errorHandler, type ErrorReport } from './errors.js';
import { validate } from './validation.js';
import { requestContext, step, type RequestTrace } from './request-context.js';
import { draftSchema, patchSchema, versionSchema, paginationSchema, idSchema, emptyQuerySchema, type DraftInput } from './schemas.js';
import { defaultExportFile, streamExport, type ExportResult } from './export.js';
import { createShutdown, type ShutdownOptions } from './shutdown.js';
import { createArticleController } from './article-controller.js';
import type { ArticleService } from './article-service.js';
import { jsonBody } from './json-body.js';

export interface ServerOptions extends ShutdownOptions {
  articles: ArticleService;
  checkReady: () => Promise<void>;
  maxBodyBytes?: number;
  bodyTimeoutMs?: number;
  exportFile?: string;
  onError?: (report: ErrorReport) => void;
  onTrace?: (trace: RequestTrace) => void;
  onExportFinished?: (result: ExportResult) => void;
}

export function createArticleServer(options: ServerOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag'); // 本章先固定 200／HEAD 契約，快取驗證留待後續。
  app.set('query parser', 'simple');
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    // 無法解析的 request-target 可能連 Express 的 middleware 都匹配不到。
    // 在交給框架前檢查，保留 05 章的 INVALID_URL 契約。
    try { new URL(req.url ?? '/', 'http://course.local'); }
    catch {
      const requestId = randomUUID();
      const text = JSON.stringify({ error: { code: 'INVALID_URL', message: '請求 URL 不合法', details: [] }, requestId });
      req.on('error', () => res.destroy()); res.on('error', () => res.destroy()); req.resume();
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'X-Request-ID': requestId, Connection: 'close' });
      res.end(req.method === 'HEAD' ? undefined : text); return;
    }
    app(req, res);
  });
  const lifecycle = createShutdown(server, options);
  const controller = createArticleController(options.articles);
  // 每次非同步資料操作登記到 07 章的協調器，包含用戶端離線後仍在收尾的查詢。
  const tracked = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res) => lifecycle.track(handler(req, res));
  const body = [step('json:start'), jsonBody(options.maxBodyBytes ?? 16 * 1024, options.bodyTimeoutMs ?? 2000), step('json:parsed')];
  const methodNotAllowed = (allow: string): RequestHandler => (_req: Request, res: Response) => {
    res.setHeader('Allow', allow);
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此路由不支援該方法');
  };
  app.use(requestContext(options.onTrace));
  app.use((req, res, next) => {
    req.on('error', () => res.destroy()); res.on('error', () => res.destroy());
    if (lifecycle.isDraining) throw new HttpError(503, 'SHUTTING_DOWN', '服務正在關閉');
    res.locals.steps.push('accept');
    next();
  });
  app.route('/health/live').get((_req, res) => { res.json({ data: { status: 'ok' } }); }).all(methodNotAllowed('GET, HEAD'));
  app.route('/health/ready').get(tracked(async (_req, res) => {
    try { await options.checkReady(); }
    catch { throw new HttpError(503, 'NOT_READY', '資料庫尚未就緒'); }
    res.json({ data: { status: 'ok' } });
  })).all(methodNotAllowed('GET, HEAD'));

  const router = Router({ caseSensitive: true, strict: true });
  router.use(step('router:articles'));
  // 固定名稱先於 /:id，否則 export／preview 可能被當成文章 ID。
  router.route('/export').get(validate(emptyQuerySchema, 'query'), step('handler:export'), async (req, res) => {
    await lifecycle.track((async () => {
      const result = await streamExport(res, options.exportFile ?? defaultExportFile, req.method === 'HEAD');
      options.onExportFinished?.(result);
    })());
  }).all(methodNotAllowed('GET, HEAD'));
  router.route('/preview').post(body, validate(draftSchema, 'body'), step('handler:preview'), (_req: Request, res: Response) => {
    res.json({ data: { ...(res.locals.body as DraftInput), status: 'draft', preview: true } });
  }).all(methodNotAllowed('POST'));
  router.route('/').get(validate(paginationSchema, 'query'), step('handler:list'), tracked(controller.list(true)))
    .post(body, validate(draftSchema, 'body'), step('handler:create'), tracked(controller.create)).all(methodNotAllowed('GET, HEAD, POST'));
  router.route('/:id').get(validate(idSchema, 'params'), step('handler:detail'), tracked(controller.detail(true)))
    .patch(body, validate(idSchema, 'params'), validate(patchSchema, 'body'), step('handler:edit'), tracked(controller.change('edit')))
    .all(methodNotAllowed('GET, HEAD, PATCH'));
  for (const action of ['publish', 'archive'] as const) {
    router.route(`/:id/${action}`).post(body, validate(idSchema, 'params'), validate(versionSchema, 'body'), step(`handler:${action}`), tracked(controller.change(action))).all(methodNotAllowed('POST'));
  }
  app.use('/api/articles', router);
  // /me 僅代表本機固定示範作者；18 章會加上真正的登入與授權。
  app.route('/api/me/articles').get(validate(paginationSchema, 'query'), step('handler:manage-list'), tracked(controller.list(false))).all(methodNotAllowed('GET, HEAD'));
  app.route('/api/me/articles/:id').get(validate(idSchema, 'params'), step('handler:manage-detail'), tracked(controller.detail(false))).all(methodNotAllowed('GET, HEAD'));
  app.use((_req, _res) => { throw new HttpError(404, 'NOT_FOUND', '找不到路由'); });

  app.use(errorHandler(options.onError));
  return Object.assign(server, { lifecycle });
}
