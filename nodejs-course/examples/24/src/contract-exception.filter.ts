import { ERROR_REPORTER } from './tokens.js';
import { Catch, Inject, Optional, NotFoundException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sendHttpError, type ErrorReport } from './errors.js';
import { HttpError } from './http.js';
import { finishRequestWork } from './request-work.js';

// Nest 邊界轉換框架的未知路由；HTTP 錯誤契約與 Express 傳輸策略分開。
@Catch()
export class ContractExceptionFilter implements ExceptionFilter {
  constructor(@Optional() @Inject(ERROR_REPORTER) private readonly onError?: (report: ErrorReport) => void) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    res.locals.steps?.push('nest:filter');
    // Nest 的未知路由格式不同；保留第 13 章的 NOT_FOUND envelope。
    const error = exception instanceof NotFoundException
      ? new HttpError(404, 'NOT_FOUND', '找不到路由')
      : exception;
    try { sendHttpError(error, req, res, this.onError); }
    finally { finishRequestWork(req); } // Guard 失敗時尚未進入 Interceptor。
  }
}
