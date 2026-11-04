import 'reflect-metadata';
import { Controller, Get, Inject, Module, Res, type DynamicModule, type Provider } from '@nestjs/common';
import type { Response } from 'express';
import type { ArticleService } from './article-service.js';
import type { createShutdown } from './shutdown.js';
import type { ArticleParams } from './schemas.js';
import { present } from './article-controller.js';
import { ARTICLE_SERVICE, REQUEST_LIFECYCLE } from './tokens.js';

@Controller('api/articles')
export class ArticleQueryController {
  constructor(
    @Inject(ARTICLE_SERVICE) private readonly articles: ArticleService,
    @Inject(REQUEST_LIFECYCLE) private readonly lifecycle: ReturnType<typeof createShutdown>,
  ) {}

  @Get(':id')
  async detail(@Res({ passthrough: true }) res: Response) {
    res.locals.steps.push('nest:controller');
    const { id } = res.locals.params as ArticleParams;
    return this.lifecycle.track((async () => {
      const article = await this.articles.detail(id, true);
      res.locals.steps.push('nest:return');
      return { data: present(article) };
    })());
  }
}

@Module({ controllers: [ArticleQueryController] })
export class ArticleQueryModule {
  // 本章只用來傳入根模組的 Provider 清單；功能模組的 imports／exports 留到 16 章。
  static register(providers: Provider[], lifecycle: ReturnType<typeof createShutdown>): DynamicModule {
    return {
      module: ArticleQueryModule,
      providers: [...providers, { provide: REQUEST_LIFECYCLE, useValue: lifecycle }],
    };
  }
}
