import type { FactoryProvider, Provider } from '@nestjs/common';
import type { Database } from './database.js';
import type { ArticleRepository } from './article-repository.js';
import { createArticleService, type ArticleService } from './article-service.js';
import { createPrismaArticleRepository } from './prisma-article-repository.js';
import { ARTICLE_REPOSITORY, ARTICLE_SERVICE, CHECK_READY, DATABASE, DATABASE_INPUT, type ReadinessCheck } from './tokens.js';

export const articleServiceProvider: FactoryProvider<ArticleService> = {
  provide: ARTICLE_SERVICE,
  inject: [ARTICLE_REPOSITORY],
  useFactory: (repository: ArticleRepository) => createArticleService(repository),
};

// 只描述建立規則；呼叫本函式時尚未執行 $connect 或建立 Service。
export function createArticleProviders(database: Database): Provider[] {
  return [
    { provide: DATABASE_INPUT, useValue: database },
    {
      provide: DATABASE,
      inject: [DATABASE_INPUT],
      useFactory: async (input: Database): Promise<Database> => {
        await input.$connect();
        return input;
      },
    } satisfies FactoryProvider<Database>,
    {
      provide: ARTICLE_REPOSITORY,
      inject: [DATABASE],
      useFactory: (db: Database): ArticleRepository => createPrismaArticleRepository(db),
    } satisfies FactoryProvider<ArticleRepository>,
    articleServiceProvider,
    {
      provide: CHECK_READY,
      inject: [DATABASE],
      useFactory: (db: Database): ReadinessCheck => async () => { await db.article.count(); },
    } satisfies FactoryProvider<ReadinessCheck>,
  ];
}
