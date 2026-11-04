import { ExpressAdapter } from '@nestjs/platform-express';
import type { ErrorRequestHandler } from 'express';
import { normalizeError } from './errors.js';

// Nest 11 的外部錯誤入口會先把 SyntaxError／URIError 包成 BadRequestException，
// 使 Filter 無法區分 INVALID_JSON 與 INVALID_URL；在轉換前保留本課分類。
export class ContractExpressAdapter extends ExpressAdapter {
  override setErrorHandler(handler: ErrorRequestHandler, prefix?: string) {
    const bridge: ErrorRequestHandler = (error: unknown, req, res, next) => {
      handler(normalizeError(error), req, res, next);
    };
    return super.setErrorHandler(bridge, prefix);
  }
}
