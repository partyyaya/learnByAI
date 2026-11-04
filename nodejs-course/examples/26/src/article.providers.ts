import type { FactoryProvider } from '@nestjs/common';
import type { Database } from './database.js';
import type { ArticleRepository } from './article-repository.js';
import { createArticleService, type ArticleService } from './article-service.js';
import { createPrismaArticleRepository } from './prisma-article-repository.js';
import { ARTICLE_REPOSITORY, ARTICLE_SERVICE, DATABASE } from './tokens.js';

export const articleServiceProvider: FactoryProvider<ArticleService> = {
  provide: ARTICLE_SERVICE,
  inject: [ARTICLE_REPOSITORY],
  useFactory: (repository: ArticleRepository) => createArticleService(repository),
};

export const articleRepositoryProvider: FactoryProvider<ArticleRepository> = {
  provide: ARTICLE_REPOSITORY,
  inject: [DATABASE],
  useFactory: (db: Database) => createPrismaArticleRepository(db),
};
