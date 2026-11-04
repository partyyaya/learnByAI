import 'reflect-metadata';
import { Controller, Get, Module, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ArticleService } from './article-service.js';
import type { createShutdown } from './shutdown.js';
import type { ArticleParams } from './schemas.js';
import { present } from './article-controller.js';

// 14 章先沿用手動組裝；每次呼叫建立自己的類別與 closure，沒有全域 Service。
// 15 章再將這兩個依賴改成 Provider／DI token，不在本章重寫資料存取。
export function createArticleQueryModule(articles: ArticleService, lifecycle: ReturnType<typeof createShutdown>) {
  @Controller('api/articles')
  class ArticleQueryController {
    @Get(':id')
    async detail(@Res({ passthrough: true }) res: Response) {
      res.locals.steps.push('nest:controller');
      // 沿用已驗證輸出；passthrough 只取平台資訊，由 Nest 負責送回 return 值。
      const { id } = res.locals.params as ArticleParams;
      return lifecycle.track((async () => {
        const article = await articles.detail(id, true);
        res.locals.steps.push('nest:return');
        return { data: present(article) };
      })());
    }
  }

  @Module({ controllers: [ArticleQueryController] })
  class AppModule {}

  return AppModule;
}
