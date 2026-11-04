import { Module, type DynamicModule } from '@nestjs/common';
import { articleServiceProvider, articleRepositoryProvider } from './article.providers.js';
import { ARTICLE_SERVICE } from './tokens.js';

@Module({ providers: [articleRepositoryProvider, articleServiceProvider], exports: [ARTICLE_SERVICE] })
export class ArticleCoreModule {
  static register(databaseModule: DynamicModule): DynamicModule {
    return { module: ArticleCoreModule, imports: [databaseModule] };
  }
}
