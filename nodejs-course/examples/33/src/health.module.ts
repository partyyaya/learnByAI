import { responsePort, rawRequest, rawResponse } from './http-platform.js';
import type { Observability } from './observability.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import { emptyQuerySchema } from './schemas.js';
import { All, Controller, Get, Inject, Module, Query, Res, type DynamicModule } from '@nestjs/common';
import type { Response } from 'express';
import type { createShutdown } from './shutdown.js';
import { CHECK_READY, REQUEST_LIFECYCLE, OBSERVABILITY, type ReadinessCheck } from './tokens.js';
import { HttpError } from './http.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(CHECK_READY) private readonly checkReady: ReadinessCheck,
    @Inject(REQUEST_LIFECYCLE) private readonly lifecycle: ReturnType<typeof createShutdown>,
    @Inject(OBSERVABILITY) private readonly observation: Observability,
  ) {}
  @Get('live') live() { return { data: { status: 'ok' } }; }
  @Get('ready') ready() {
    if (this.lifecycle.isDraining) throw new HttpError(503, 'SHUTTING_DOWN', '服務正在關閉');
    return this.lifecycle.track((async () => {
      let available = true;
      try { await this.checkReady(); } catch { available = false; }
      // 關閉狀態優先於同時發生的 DB 故障，不能在 drain 中回報 ready。
      if (this.lifecycle.isDraining) throw new HttpError(503, 'SHUTTING_DOWN', '服務正在關閉');
      if (!available) throw new HttpError(503, 'NOT_READY', '資料庫尚未就緒');
      return { data: { status: 'ok' } };
    })());
  }
  @Get('metrics') metrics(@Query(new ZodValidationPipe(emptyQuerySchema)) _query: Record<string, never>, @Res() res: Response) {
    responsePort(res).setHeader('Cache-Control', 'no-store');
    responsePort(res).type('text/plain; version=0.0.4; charset=utf-8');
    responsePort(res).send(this.observation.metrics(this.lifecycle.pendingWork, this.lifecycle.isDraining));
  }
  @All(['live', 'ready', 'metrics']) method(@Res() res: Response) {
    responsePort(res).setHeader('Allow', 'GET, HEAD');
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此路由不支援該方法');
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {
  static register(readiness: DynamicModule, runtime: DynamicModule): DynamicModule {
    return { module: HealthModule, imports: [readiness, runtime] };
  }
}
