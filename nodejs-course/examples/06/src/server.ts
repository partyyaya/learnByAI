import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson, validateDraft } from './http.js';
import { defaultExportFile, streamExport, type ExportResult } from './export.js';

const articles = [
  { id: 'a_1', title: '認識 Node HTTP', content: '第一篇公開文章', status: 'published' },
  { id: 'a_2', title: '請求與回應', content: '第二篇公開文章', status: 'published' },
  { id: 'a_draft', title: '未公開草稿', content: '不能由公開端點讀取', status: 'draft' },
];

export interface ServerOptions {
  maxBodyBytes?: number;
  bodyTimeoutMs?: number;
  exportFile?: string;
  onExportFinished?: (result: ExportResult) => void;
}

export function createArticleServer(options: ServerOptions = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? 16 * 1024;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? 2000;
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 固定 base 只用於解析相對 URL；不把用戶提供的 Host 當成可信設定。
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://course.local'); }
    catch { throw new HttpError(400, 'INVALID_URL', '請求 URL 不合法'); }
    const path = url.pathname;
    if (path === '/api/articles/export') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', '匯出只接受 GET 或 HEAD');
      }
      if (url.search) throw new HttpError(400, 'VALIDATION_ERROR', '匯出端點不接受查詢參數');
      const result = await streamExport(res, options.exportFile ?? defaultExportFile, req.method === 'HEAD');
      options.onExportFinished?.(result);
      return;
    }
    const knownGet = path === '/health/live' || path === '/api/articles' || (/^\/api\/articles\/[^/]+$/.test(path) && path !== '/api/articles/preview');
    const preview = path === '/api/articles/preview';
    if (!knownGet && !preview) throw new HttpError(404, 'NOT_FOUND', '找不到路由');
    const allowed = preview ? ['POST'] : ['GET', 'HEAD'];
    if (!allowed.includes(req.method ?? '')) {
      res.setHeader('Allow', allowed.join(', '));
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此路由不支援該方法');
    }
    if (path === '/health/live') {
      sendJson(req, res, 200, { data: { status: 'ok' } });
      return;
    }
    if (preview) {
      const draft = validateDraft(await readJson(req, maxBodyBytes, bodyTimeoutMs));
      sendJson(req, res, 200, { data: { ...draft, status: 'draft', preview: true } });
      return;
    }
    const visible = articles.filter(article => article.status === 'published');
    if (path === '/api/articles') {
      if ([...url.searchParams.keys()].some(key => key !== 'page' && key !== 'pageSize')) {
        throw new HttpError(400, 'VALIDATION_ERROR', '只接受 page 與 pageSize');
      }
      function integer(name: string, fallback: number, max: number): number {
        const values = url.searchParams.getAll(name);
        if (values.length === 0) return fallback;
        const value = Number(values[0]);
        if (values.length !== 1 || !/^[0-9]+$/.test(values[0]) || !Number.isSafeInteger(value) || value < 1 || value > max) {
          throw new HttpError(400, 'VALIDATION_ERROR', `${name} 不合法`);
        }
        return value;
      }
      const page = integer('page', 1, 1000000);
      const pageSize = integer('pageSize', 20, 100);
      sendJson(req, res, 200, { data: visible.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, total: visible.length } });
      return;
    }
    const article = visible.find(item => path === `/api/articles/${item.id}`);
    if (!article) throw new HttpError(404, 'NOT_FOUND', '找不到公開文章');
    sendJson(req, res, 200, { data: article });
  }

  return createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-ID', requestId);
    // 來源擁有者仍處理連線錯誤；body reader 只移除自己註冊的 listener。
    req.on('error', () => res.destroy());
    res.on('error', () => res.destroy());
    void route(req, res).catch((error: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const failure = error instanceof HttpError ? error : new HttpError(500, 'INTERNAL_ERROR', '內部錯誤');
      // 提早拒絕時不用未讀完的連線處理下一個請求；先送錯誤，再關閉連線。
      res.shouldKeepAlive = false;
      res.setHeader('Connection', 'close');
      req.resume();
      sendJson(req, res, failure.status, { error: { code: failure.code, message: failure.message, details: [] }, requestId });
    });
  });
}
