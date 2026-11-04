import { Injectable, Inject, type CanActivate, type ExecutionContext, type NestInterceptor, type CallHandler } from '@nestjs/common';
import type { Request } from 'express';
import { finalize } from 'rxjs';
import type { createShutdown } from './shutdown.js';
import { REQUEST_LIFECYCLE } from './tokens.js';

const workDone = Symbol('request work complete');
type WorkRequest = Request & { [workDone]?: () => void };
export function finishRequestWork(req: WorkRequest) { req[workDone]?.(); delete req[workDone]; }

// Guard 現在會讀資料庫，必須把「Guard → Pipe → handler」視為同一段已登記工作。
// 不能只等 socket close，也不能在 Guard Promise 完成、handler 尚未開始時釋放資源。
@Injectable()
export class RequestWorkGuard implements CanActivate {
  constructor(@Inject(REQUEST_LIFECYCLE) private readonly lifecycle: ReturnType<typeof createShutdown>) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<WorkRequest>();
    if (!req[workDone]) {
      const done = new Promise<void>(resolve => { req[workDone] = resolve; });
      void this.lifecycle.track(done);
    }
    return true;
  }
}
@Injectable()
export class RequestWorkInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<WorkRequest>();
    return next.handle().pipe(finalize(() => finishRequestWork(req)));
  }
}
