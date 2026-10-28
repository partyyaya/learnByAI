import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { HttpError } from './http.js';

// 此函式不改寫 req.body／req.query／req.params，保留原始輸入與驗證輸出的界線。
export function validate(schema: z.ZodType, source: 'body' | 'query' | 'params'): RequestHandler {
  return (req, res, next) => {
    res.locals.steps.push(`validate:${source}`);
    const result = schema.safeParse(req[source] as unknown);
    if (!result.success) {
      const details = result.error.issues.map(issue => ({
        field: [source, ...issue.path].join('.'),
        code: issue.code === 'unrecognized_keys' ? 'UNKNOWN_FIELDS' : 'INVALID_VALUE',
        // 不回傳原始 body、ZodError 或未知欄位清單。
        message: issue.code === 'unrecognized_keys' ? '包含不允許的欄位' : '欄位格式或內容不符合規則',
      }));
      return next(new HttpError(400, 'VALIDATION_ERROR', '輸入驗證失敗', details));
    }
    res.locals[source] = result.data;
    next();
  };
}
