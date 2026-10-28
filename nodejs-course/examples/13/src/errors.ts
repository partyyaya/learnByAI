import type { ErrorRequestHandler } from 'express';
import { HttpError } from './http.js';
import { ArticleError } from './article-model.js';

export interface ErrorReport {
  requestId?: string;
  status: number;
  code: string;
  phase: 'before-response' | 'streaming' | 'ended' | 'disconnected';
}
export function normalizeError(error: unknown): HttpError {
  if (error instanceof ArticleError) return new HttpError(error.code === 'NOT_FOUND' ? 404 : 409, error.code, error.message);
  if (error instanceof HttpError && error.code === 'INVALID_ENCODING') return new HttpError(400, error.code, error.message);
  if (error instanceof HttpError) return error;
  const type = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
  if (type === 'entity.too.large') return new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request body 超過大小限制');
  if (type === 'entity.parse.failed') return new HttpError(400, 'INVALID_JSON', 'body 必須是有效 JSON 物件');
  if (type === 'request.aborted' || type === 'request.size.invalid') return new HttpError(400, 'REQUEST_INTERRUPTED', '讀取請求失敗');
  if (error instanceof URIError) return new HttpError(400, 'INVALID_URL', '路徑編碼不合法');
  // 不能直接採用任意 error.status、message、stack 作公開回應。
  return new HttpError(500, 'INTERNAL_ERROR', '內部錯誤');
}
export function errorHandler(onError?: (report: ErrorReport) => void): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    const failure = normalizeError(error);
    const phase = res.destroyed ? 'disconnected' : res.writableEnded ? 'ended' : res.headersSent ? 'streaming' : 'before-response';
    onError?.({ requestId: res.locals.requestId, status: failure.status, code: failure.code, phase });
    if (phase === 'disconnected' || phase === 'ended') return;
    if (phase === 'streaming') { res.destroy(); return; }
    res.locals.steps?.push(`error:${failure.code}`);
    res.shouldKeepAlive = false; res.setHeader('Connection', 'close'); req.resume();
    res.status(failure.status).json({ error: { code: failure.code, message: failure.message, details: failure.details }, requestId: res.locals.requestId });
  };
}
