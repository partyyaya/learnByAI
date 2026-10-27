import express, { type RequestHandler } from 'express';
import { HttpError } from './http.js';

// 先保留上一階段的大小、編碼與等待上限；09 章再逐步拆解 middleware。
export function jsonBody(maxBytes: number, timeoutMs: number): RequestHandler {
  const parse = express.json({
    limit: maxBytes, inflate: false,
    verify(_req, _res, buffer) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { throw new HttpError(400, 'INVALID_ENCODING', 'body 必須是有效 UTF-8'); }
    },
  });
  return (req, res, next) => {
    const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
    const charset = req.headers['content-type']?.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1];
    if (type !== 'application/json' || (charset && charset.toLowerCase() !== 'utf-8')) {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '請使用 application/json 與 UTF-8');
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      throw new HttpError(415, 'UNSUPPORTED_ENCODING', '本章不接受壓縮的 request body');
    }
    let finished = false;
    const timer = setTimeout(() => finish(new HttpError(408, 'REQUEST_TIMEOUT', '讀取 body 逾時')), timeoutMs);
    const onClose = () => { finished = true; cleanup(); };
    function cleanup() { clearTimeout(timer); res.off('close', onClose); }
    function finish(error?: unknown) {
      if (finished) return;
      finished = true; cleanup(); next(error);
    }
    res.once('close', onClose);
    parse(req, res, finish);
  };
}
