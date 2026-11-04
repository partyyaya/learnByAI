import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { HttpError } from './http.js';

// Pipe 與保留的 Express 教學實驗共用錯誤映射，不回傳原始 body 或未知欄位名稱。
export function parseInput<T extends z.ZodType>(schema: T, source: 'body' | 'query' | 'params', value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'VALIDATION_ERROR', '輸入驗證失敗', result.error.issues.map(issue => ({
    field: [source, ...issue.path].join('.'),
    code: issue.code === 'unrecognized_keys' ? 'UNKNOWN_FIELDS' : 'INVALID_VALUE',
    message: issue.code === 'unrecognized_keys' ? '包含不允許的欄位' : '欄位格式或內容不符合規則',
  })));
  return result.data;
}

// 此函式不改寫 req.body／req.query／req.params，保留原始輸入與驗證輸出的界線。
export function validate(schema: z.ZodType, source: 'body' | 'query' | 'params'): RequestHandler {
  return (req, res, next) => {
    res.locals.steps.push(`validate:${source}`);
    try { res.locals[source] = parseInput(schema, source, req[source] as unknown); next(); }
    catch (error) { next(error); }
  };
}
