import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function readJson(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<unknown> {
  const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  const charset = req.headers['content-type']?.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1];
  if (type !== 'application/json' || (charset && charset.toLowerCase() !== 'utf-8')) {
    return Promise.reject(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '請使用 application/json 與 UTF-8'));
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    return Promise.reject(new HttpError(415, 'UNSUPPORTED_ENCODING', '本章不接受壓縮的 request body'));
  }
  if (Number(req.headers['content-length']) > maxBytes) {
    return Promise.reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request body 超過大小限制'));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => fail(new HttpError(408, 'REQUEST_TIMEOUT', '讀取 body 逾時')), timeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    }
    function fail(error: Error): void {
      cleanup();
      req.pause();
      reject(error);
    }
    function onData(chunk: Buffer): void {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request body 超過大小限制'));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd(): void {
      cleanup();
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
      } catch {
        reject(new HttpError(400, 'INVALID_ENCODING', 'body 必須是有效 UTF-8'));
        return;
      }
      try { resolve(JSON.parse(text)); }
      catch { reject(new HttpError(400, 'INVALID_JSON', 'body 必須是有效 JSON')); }
    }
    function onError(): void { fail(new HttpError(400, 'REQUEST_INTERRUPTED', '讀取請求失敗')); }
    function onAborted(): void { fail(new HttpError(400, 'REQUEST_INTERRUPTED', '用戶端已中斷')); }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

export function validateDraft(value: unknown): { title: string; content: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'body 必須是物件');
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => key !== 'title' && key !== 'content')) {
    throw new HttpError(400, 'VALIDATION_ERROR', '只接受 title 與 content');
  }
  if (typeof object.title !== 'string' || typeof object.content !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'title 與 content 必須是字串');
  }
  const title = object.title.trim();
  const content = object.content.trim();
  if (!title || !content || [...title].length > 120 || [...content].length > 4000) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'title 為 1–120、content 為 1–4000 個 Unicode code point');
  }
  return { title, content };
}
