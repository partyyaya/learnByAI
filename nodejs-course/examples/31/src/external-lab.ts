import 'reflect-metadata';
import { All, Controller, Get, Inject, Module, Param, Query, Res, type INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import express, { type Response } from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { createExternalClient, ExternalError, type ExternalClient, type ExternalOptions } from './external-client.js';
import { ContractExpressAdapter } from './contract-express.adapter.js';
import { ContractExceptionFilter } from './contract-exception.filter.js';
import { requestContext } from './request-context.js';
import { createShutdown, type ShutdownOptions } from './shutdown.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import { emptyQuerySchema } from './schemas.js';
import { HttpError } from './http.js';

export const REFERENCE_CLIENT = Symbol('REFERENCE_CLIENT');
const LIFECYCLE = Symbol('EXTERNAL_LIFECYCLE');
const paramsSchema = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) });
@Controller('lab/topics')
export class ReferenceController {
  constructor(@Inject(REFERENCE_CLIENT) private readonly client: ExternalClient,
    @Inject(LIFECYCLE) private readonly lifecycle: ReturnType<typeof createShutdown>) {}
  @Get(':id')
  topic(@Param(new ZodValidationPipe(paramsSchema)) { id }: { id: string },
    @Query(new ZodValidationPipe(emptyQuerySchema)) _query: Record<string, never>, @Res({ passthrough: true }) res: Response) {
    const caller = new AbortController();
    const close = () => { if (!res.writableFinished) caller.abort(); };
    res.once('close', close);
    if (res.destroyed) caller.abort();
    return this.lifecycle.track((async () => {
      try { return { data: await this.client.getTopic(id, caller.signal) }; }
      catch (error) {
        if (!(error instanceof ExternalError)) throw error;
        const status = error.code === 'UPSTREAM_NOT_FOUND' ? 404 : error.code === 'UPSTREAM_TIMEOUT' ? 504
          : error.code === 'UPSTREAM_BAD_RESPONSE' || error.code === 'UPSTREAM_WRITE_UNCERTAIN' ? 502 : 503;
        throw new HttpError(status, error.code, error.message);
      } finally { res.off('close', close); }
    })());
  }
  @All(':id') method(@Res() res: Response) {
    res.setHeader('Allow', 'GET, HEAD'); throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此路由不支援該方法');
  }
}
@Module({})
class ExternalLabModule {}
export async function createExternalLab(options: ExternalOptions, shutdown: ShutdownOptions = {}) {
  const app = express(); app.disable('x-powered-by'); app.disable('etag');
  app.set('strict routing', true); app.set('case sensitive routing', true); app.set('query parser', 'simple');
  const server = createServer(app); let nest: INestApplication | undefined;
  const lifecycle = createShutdown(server, { ...shutdown, closeResources: async signal => {
    try { await nest?.close(); } finally { await shutdown.closeResources?.(signal); }
  } });
  const client = createExternalClient(options);
  try {
    nest = await NestFactory.create({ module: ExternalLabModule, controllers: [ReferenceController], providers: [
      { provide: REFERENCE_CLIENT, useValue: client }, { provide: LIFECYCLE, useValue: lifecycle },
      { provide: APP_FILTER, useClass: ContractExceptionFilter },
    ] }, new ContractExpressAdapter(app), { bodyParser: false, logger: false, abortOnError: false });
    app.use(requestContext());
    app.use((req, res, next) => { req.on('error', () => res.destroy()); res.on('error', () => res.destroy()); if (lifecycle.isDraining) throw new HttpError(503, 'SHUTTING_DOWN', '服務正在關閉'); next(); });
    await nest.init();
    return { server, client, lifecycle };
  } catch (error) { await nest?.close(); throw error; }
}
if (require.main === module) {
  void (async () => {
    const origin = process.env.REFERENCE_ORIGIN;
    const port = Number(process.env.PORT ?? '3131'); const host = process.env.HOST ?? '127.0.0.1';
    if (!origin || !Number.isInteger(port) || port < 0 || port > 65535 || !['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('設定不合法');
    const lab = await createExternalLab({ origin }, { onEvent: event => console.log(`EXTERNAL_SHUTDOWN ${event}`) });
    lab.server.listen(port, host); await once(lab.server, 'listening');
    console.log('EXTERNAL_LAB_READY');
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
      if (stopping) return; stopping = true;
      void lab.lifecycle.shutdown().then(() => { process.exitCode = 0; }, () => { console.error('EXTERNAL_SHUTDOWN_FAILED'); process.exit(1); });
    });
  })().catch(() => { console.error('EXTERNAL_LAB_FAILED'); process.exitCode = 1; });
}
