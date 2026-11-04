import { Module, type DynamicModule } from '@nestjs/common';
import { ArticlesModule } from './articles.module.js';
import { HealthModule } from './health.module.js';

export interface FeatureDependencies {
  articles: DynamicModule;
  readiness: DynamicModule;
}

@Module({})
export class AppModule {
  static register(dependencies: FeatureDependencies, runtime: DynamicModule): DynamicModule {
    return { module: AppModule, imports: [
      ArticlesModule.register(dependencies.articles, runtime),
      HealthModule.register(dependencies.readiness, runtime),
    ] };
  }
}
