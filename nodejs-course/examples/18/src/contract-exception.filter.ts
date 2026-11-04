import { Catch, NotFoundException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { errorHandler, type ErrorReport } from './errors.js';
import { HttpError } from './http.js';
import { finishRequestWork } from './request-work.js';

// 最小相容橋接；19 章才深入 Filter 的作用範圍與平台抽象。
@Catch()
export class ContractExceptionFilter implements ExceptionFilter {
  constructor(private readonly onError?: (report: ErrorReport) => void) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    res.locals.steps?.push('nest:filter');
    // Nest 的未知路由格式不同；保留第 13 章的 NOT_FOUND envelope。
    const error = exception instanceof NotFoundException
      ? new HttpError(404, 'NOT_FOUND', '找不到路由')
      : exception;
    try { errorHandler(this.onError)(error, req, res, () => {}); }
    finally { finishRequestWork(req); } // Guard 失敗時尚未進入 Interceptor。
  }
}
