import { Inject, Module, RequestMethod, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ArticlesController, ManagedArticlesController } from './articles.controller.js';
import { HTTP_OPTIONS } from './tokens.js';
import type { HttpOptions } from './runtime.module.js';
import { jsonBody } from './json-body.js';
import type { RequestHandler } from 'express';

@Module({ controllers: [ArticlesController, ManagedArticlesController] })
export class ArticlesModule implements NestModule {
  constructor(@Inject(HTTP_OPTIONS) private readonly options: Readonly<HttpOptions>) {}
  static register(core: DynamicModule, runtime: DynamicModule): DynamicModule {
    return { module: ArticlesModule, imports: [core, runtime] };
  }
  configure(consumer: MiddlewareConsumer) {
    // 保留原 strict JSON、UTF-8、byte 限制與讀取期限；17 章只處理欄位驗證的 Pipe。
    const parse = jsonBody(this.options.maxBodyBytes, this.options.bodyTimeoutMs);
    const body: RequestHandler = (req, res, next) => {
      // Nest middleware 的 :id 也會匹配保留名稱；固定路徑的 405 不應先讀 body。
      if (req.path.endsWith('/') || (req.method === 'PATCH' && /^\/api\/articles\/(export|preview)$/.test(req.path))) return next();
      res.locals.steps.push('json:start');
      return parse(req, res, error => {
        if (!error) res.locals.steps.push('json:parsed');
        next(error);
      });
    };
    consumer.apply(body).forRoutes(
      { path: 'api/articles', method: RequestMethod.POST },
      { path: 'api/articles/preview', method: RequestMethod.POST },
      { path: 'api/articles/:id', method: RequestMethod.PATCH },
      { path: 'api/articles/:id/publish', method: RequestMethod.POST },
      { path: 'api/articles/:id/archive', method: RequestMethod.POST },
    );
  }
}
