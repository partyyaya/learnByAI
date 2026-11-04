import type { ErrorRequestHandler, Request, Response } from 'express';
import { HttpError } from './http.js';
import { ArticleError } from './article-model.js';
import { AuthError } from './auth-model.js';

export interface ErrorReport {
  requestId?: string;
  status: number;
  httpStatus?: number;
  code: string;
  phase: 'before-response' | 'streaming' | 'ended' | 'disconnected';
}
export function normalizeError(error: unknown): HttpError {
  if (error instanceof ArticleError) return new HttpError(error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : error.code === 'UNAUTHENTICATED' ? 401 : 409, error.code, error.message);
  if (error instanceof AuthError) return new HttpError(error.code === 'USER_ALREADY_EXISTS' ? 409 : error.code === 'AUTH_BUSY' ? 503 : error.code === 'RATE_LIMITED' ? 429 : 401, error.code, error.message);
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
// 純資料轉換，不寫入 socket；Filter 與 Express laboratory 共用同一份契約。
export function errorResponse(error: unknown, requestId?: string) {
  const failure = normalizeError(error);
  return { status: failure.status, body: {
    error: { code: failure.code, message: failure.message, details: failure.details.map(({ field, code, message }) => ({ field, code, message })) },
    requestId,
  } };
}
// Express 傳輸邊界：已送 header 或離線時不能再補一份 JSON。
export function sendHttpError(error: unknown, req: Request, res: Response, onError?: (report: ErrorReport) => void) {
  const { status, body } = errorResponse(error, res.locals.requestId);
  const phase = res.destroyed ? 'disconnected' : res.writableEnded ? 'ended' : res.headersSent ? 'streaming' : 'before-response';
  onError?.({ requestId: res.locals.requestId, status, code: body.error.code, phase, ...(res.headersSent ? { httpStatus: res.statusCode } : {}) });
  if (phase === 'disconnected' || phase === 'ended') return;
  if (phase === 'streaming') { res.destroy(); return; }
  res.locals.steps?.push(`error:${body.error.code}`);
  res.shouldKeepAlive = false; res.setHeader('Connection', 'close'); req.resume();
  res.status(status).json(body);
}
export function errorHandler(onError?: (report: ErrorReport) => void): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => sendHttpError(error, req, res, onError);
}
