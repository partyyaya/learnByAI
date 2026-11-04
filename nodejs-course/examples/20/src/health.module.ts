import { All, Controller, Get, Inject, Module, Res, type DynamicModule } from '@nestjs/common';
import type { Response } from 'express';
import type { createShutdown } from './shutdown.js';
import { CHECK_READY, REQUEST_LIFECYCLE, type ReadinessCheck } from './tokens.js';
import { HttpError } from './http.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(CHECK_READY) private readonly checkReady: ReadinessCheck,
    @Inject(REQUEST_LIFECYCLE) private readonly lifecycle: ReturnType<typeof createShutdown>,
  ) {}
  @Get('live') live() { return { data: { status: 'ok' } }; }
  @Get('ready') ready() {
    return this.lifecycle.track((async () => {
      try { await this.checkReady(); }
      catch { throw new HttpError(503, 'NOT_READY', '資料庫尚未就緒'); }
      return { data: { status: 'ok' } };
    })());
  }
  @All(['live', 'ready']) method(@Res() res: Response) {
    res.setHeader('Allow', 'GET, HEAD');
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此路由不支援該方法');
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {
  static register(readiness: DynamicModule, runtime: DynamicModule): DynamicModule {
    return { module: HealthModule, imports: [readiness, runtime] };
  }
}
