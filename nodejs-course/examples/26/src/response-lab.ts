import 'reflect-metadata';
import {
  Catch, Controller, Get, HttpCode, Module, Param, Res, UseFilters, UseGuards, UseInterceptors,
  type ArgumentsHost, type CallHandler, type ExceptionFilter, type ExecutionContext,
  type NestInterceptor, type PipeTransform,
} from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { catchError, finalize, of, tap, throwError } from 'rxjs';
import type { Request, Response } from 'express';
import { ResponseProjectionInterceptor, SerializeResponse } from './response-projection.js';

// 獨立教學 app，不匯入正式 AppModule、不讀資料庫。每個請求各有 events。
export interface ResponseLabTrace { path: string; events: string[]; outcome: 'finish' | 'close' }
class LabError extends Error {}
function event(context: ArgumentsHost, name: string) {
  context.switchToHttp().getResponse<Response>().locals.events.push(name);
}
function trace(name: string): NestInterceptor {
  return { intercept(context: ExecutionContext, next: CallHandler) {
    event(context, `${name}:before`);
    return next.handle().pipe(
      tap({ next: () => event(context, `${name}:next`) }),
      catchError((error: unknown) => { event(context, `${name}:error`); return throwError(() => error); }),
      finalize(() => event(context, `${name}:finalize`)),
    );
  } };
}
function filter(name: string, typed: boolean) {
  @Catch(...(typed ? [LabError] : []))
  class LabFilter implements ExceptionFilter {
    catch(_error: unknown, host: ArgumentsHost) {
      event(host, `filter:${name}`);
      const res = host.switchToHttp().getResponse<Response>();
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      // 不反射 LabError 的內部訊息。實驗刻意以 422 區別正式 API。
      res.status(422).json({ error: { code: 'LAB_REJECTED', handledBy: name } });
    }
  }
  return new LabFilter();
}
const valuePipe: PipeTransform<string, number> = {
  transform(value) {
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new LabError('SECRET invalid input');
    return Number(value);
  },
};
const recover: NestInterceptor = {
  intercept(context, next) {
    return next.handle().pipe(catchError(() => {
      event(context, 'recover'); return of({ data: { recovered: true } });
    }));
  },
};

export async function createResponseLab() {
  const traces: ResponseLabTrace[] = [];
  @Controller('responses')
  @UseInterceptors(trace('controller'))
  @UseFilters(filter('controller', true))
  class ResponseController {
    @Get('ok') @UseInterceptors(trace('route'))
    @SerializeResponse((value: { value: number }) => ({ data: { value: value.value } }))
    ok() { return { value: 7, internal: 'SECRET' }; }

    @Get('route-error') @UseInterceptors(trace('route')) @UseFilters(filter('route', true))
    async routeError() { throw new LabError('SECRET route failure'); }

    @Get('controller-error') @UseInterceptors(trace('route'))
    controllerError() { throw new LabError('SECRET controller failure'); }

    @Get('pipe/:value') @UseInterceptors(trace('route')) @UseFilters(filter('route', true))
    pipe(@Param('value', valuePipe) value: number) { return { data: { value } }; }

    @Get('denied') @UseInterceptors(trace('route')) @UseFilters(filter('route', true))
    @UseGuards({ canActivate(context) { event(context, 'guard:deny'); throw new LabError('SECRET denied'); } })
    denied() { throw new Error('handler should not run'); }

    @Get('recovered') @UseInterceptors(trace('route'), recover)
    recovered() { throw new LabError('SECRET recovered failure'); }

    @Get('raw') raw(@Res() res: Response) { res.type('text/plain').send('plain'); }
    @Get('empty') @HttpCode(204) empty() { return undefined; }

    @Get('partial') async partial(@Res() res: Response) {
      res.write('partial');
      await new Promise<void>(resolve => setImmediate(resolve));
      throw new LabError('SECRET late failure');
    }
  }
  @Controller('outside')
  class OutsideController {
    @Get('error') error() { throw new Error('SECRET unknown'); }
  }
  @Module({ controllers: [ResponseController, OutsideController], providers: [
    { provide: APP_INTERCEPTOR, useValue: trace('global') },
    { provide: APP_INTERCEPTOR, useClass: ResponseProjectionInterceptor },
  ] })
  class ResponseLabModule {}
  const app = await NestFactory.create(ResponseLabModule, { logger: false, abortOnError: false });
  try {
    app.use((req: Request, res: Response, next: () => void) => {
      res.locals.events = ['middleware'];
      let recorded = false;
      const record = (outcome: ResponseLabTrace['outcome']) => {
        if (recorded) return; recorded = true;
        traces.push({ path: req.path, outcome, events: [...res.locals.events, `response:${outcome}`] });
      };
      res.once('finish', () => record('finish')); res.once('close', () => record('close'));
      next();
    });
    app.useGlobalFilters(filter('global', false));
    await app.init();
    return { app, traces };
  } catch (error) { await app.close(); throw error; }
}
