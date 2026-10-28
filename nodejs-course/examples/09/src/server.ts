import express, { Router, type ErrorRequestHandler, type RequestHandler, type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';
import { validate } from './validation.js';
import { requestContext, step, type RequestTrace } from './request-context.js';
import { draftSchema, patchSchema, versionSchema, paginationSchema, idSchema, emptyQuerySchema, type DraftInput, type PatchInput, type VersionInput, type Pagination, type ArticleParams } from './schemas.js';
import { defaultExportFile, streamExport, type ExportResult } from './export.js';
import { createShutdown, type ShutdownOptions } from './shutdown.js';
import { createArticles } from './articles.js';
import { jsonBody } from './json-body.js';

export interface ServerOptions extends ShutdownOptions {
  maxBodyBytes?: number;
  bodyTimeoutMs?: number;
  exportFile?: string;
  onTrace?: (trace: RequestTrace) => void;
  onExportFinished?: (result: ExportResult) => void;
}

export function createArticleServer(options: ServerOptions = {}) {
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
  const articles = createArticles(); // 每個服務實例有自己的 Map，重啟即恢復教學種子。
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
  for (const path of ['/health/live', '/health/ready']) {
    app.route(path).get((_req: Request, res: Response) => { res.json({ data: { status: 'ok' } }); }).all(methodNotAllowed('GET, HEAD'));
  }

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
  router.route('/').get(validate(paginationSchema, 'query'), step('handler:list'), (_req: Request, res: Response) => { res.json(articles.list(res.locals.query as Pagination, true)); })
    .post(body, validate(draftSchema, 'body'), step('handler:create'), (_req: Request, res: Response) => {
      const article = articles.create(res.locals.body as DraftInput);
      res.location(`/api/me/articles/${article.id}`).status(201).json({ data: article });
    }).all(methodNotAllowed('GET, HEAD, POST'));
  router.route('/:id').get(validate(idSchema, 'params'), step('handler:detail'), (_req: Request, res: Response) => { res.json({ data: articles.detail((res.locals.params as ArticleParams).id, true) }); })
    .patch(body, validate(idSchema, 'params'), validate(patchSchema, 'body'), step('handler:edit'), (_req: Request, res: Response) => { res.json({ data: articles.change((res.locals.params as ArticleParams).id, res.locals.body as PatchInput, 'edit') }); })
    .all(methodNotAllowed('GET, HEAD, PATCH'));
  for (const action of ['publish', 'archive'] as const) {
    router.route(`/:id/${action}`).post(body, validate(idSchema, 'params'), validate(versionSchema, 'body'), step(`handler:${action}`), (_req: Request, res: Response) => {
      res.json({ data: articles.change((res.locals.params as ArticleParams).id, res.locals.body as VersionInput, action) });
    }).all(methodNotAllowed('POST'));
  }
  app.use('/api/articles', router);
  // /me 僅代表本機固定示範作者；18 章會加上真正的登入與授權。
  app.route('/api/me/articles').get(validate(paginationSchema, 'query'), step('handler:manage-list'), (_req: Request, res: Response) => { res.json(articles.list(res.locals.query as Pagination, false)); }).all(methodNotAllowed('GET, HEAD'));
  app.route('/api/me/articles/:id').get(validate(idSchema, 'params'), step('handler:manage-detail'), (_req: Request, res: Response) => { res.json({ data: articles.detail((res.locals.params as ArticleParams).id, false) }); }).all(methodNotAllowed('GET, HEAD'));
  app.use((_req, _res) => { throw new HttpError(404, 'NOT_FOUND', '找不到路由'); });

  const errors: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    const failure = normalizeError(error);
    res.locals.steps.push(`error:${failure.code}`);
    res.shouldKeepAlive = false; res.setHeader('Connection', 'close'); req.resume();
    res.status(failure.status).json({ error: { code: failure.code, message: failure.message, details: failure.details }, requestId: res.locals.requestId });
  };
  app.use(errors);
  return Object.assign(server, { lifecycle });
}

function normalizeError(error: unknown): HttpError {
  // body-parser 可能包裝 verify 的錯誤；保留本課的編碼錯誤契約。
  if (error instanceof HttpError && error.code === 'INVALID_ENCODING') return new HttpError(400, error.code, error.message);
  if (error instanceof HttpError) return error;
  const type = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
  if (type === 'entity.too.large') return new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request body 超過大小限制');
  if (type === 'entity.parse.failed') return new HttpError(400, 'INVALID_JSON', 'body 必須是有效 JSON 物件');
  if (error instanceof URIError) return new HttpError(400, 'INVALID_URL', '路徑編碼不合法');
  return new HttpError(500, 'INTERNAL_ERROR', '內部錯誤');
}
