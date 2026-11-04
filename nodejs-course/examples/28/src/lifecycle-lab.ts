import 'reflect-metadata';
import {
  BadRequestException, Catch, Controller, Get, HttpException, Module, Param,
  UseGuards, UseInterceptors, type ArgumentsHost, type CallHandler,
  type CanActivate, type ExceptionFilter, type ExecutionContext,
  type NestInterceptor, type PipeTransform,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { tap } from 'rxjs';
import type { Response } from 'express';

// 獨立教學實驗：每個情境建立自己的 app，只送一個請求，不掛進文章 API。
// events 供單一情境斷言；文章 API 的正式 trace 仍使用各請求自己的 res.locals。
export async function createLifecycleLab(deny = false) {
  const events: string[] = [];
  const guard: CanActivate = {
    canActivate() { events.push('guard'); return !deny; },
  };
  const interceptor: NestInterceptor = {
    intercept(_context: ExecutionContext, next: CallHandler) {
      events.push('interceptor:before');
      return next.handle().pipe(tap({
        next: () => events.push('interceptor:after'),
        error: () => events.push('interceptor:error'),
      }));
    },
  };
  const pipe: PipeTransform<string, number> = {
    transform(value) {
      events.push('pipe');
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new BadRequestException('請輸入非負安全整數');
      }
      return Number(value);
    },
  };
  @Catch()
  class LabFilter implements ExceptionFilter {
    catch(error: unknown, host: ArgumentsHost) {
      events.push('filter');
      const status = error instanceof HttpException ? error.getStatus() : 500;
      host.switchToHttp().getResponse<Response>().status(status).json({ error: 'lab error' });
    }
  }
  @Controller('lab')
  class LabController {
    @Get(':value')
    @UseGuards(guard)
    @UseInterceptors(interceptor)
    value(@Param('value', pipe) value: number) {
      events.push('controller');
      if (value === 13) throw new Error('實驗用錯誤');
      return { data: { value, type: typeof value } };
    }
  }
  @Module({ controllers: [LabController] })
  class LabModule {}
  const app = await NestFactory.create(LabModule, { logger: false, abortOnError: false });
  try {
    app.use((_req: unknown, res: Response, next: () => void) => {
      events.push('middleware');
      res.once('finish', () => events.push('response:finish'));
      next();
    });
    app.useGlobalFilters(new LabFilter());
    await app.init();
    return { app, events, LabController };
  } catch (error) { await app.close(); throw error; }
}
